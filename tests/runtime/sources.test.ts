import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Direct coverage for buildReadingSource() dispatch (#186). loop backoff and
// orchestrator export dispatch are already covered (tests/runtime/loop.test.ts
// :62/:194, tests/orchestrator.test.ts :121/:226/:246); buildReadingSource()
// was the only untested runtime resilience path.

const h = vi.hoisted(() => {
  class FakeMqttWatcher {
    args: unknown[];
    updateConfig = vi.fn();
    constructor(...a: unknown[]) {
      this.args = a;
    }
  }
  class FakeEsphomeWatcher {
    args: unknown[];
    updateConfig = vi.fn();
    constructor(...a: unknown[]) {
      this.args = a;
    }
  }
  class FakePollSource {
    nextReading = vi.fn();
    constructor(
      public ctx: unknown,
      public adapters: unknown,
    ) {}
  }
  const watchdogInstances: Array<{
    maxFailures: number;
    onTrip: (c: { consecutiveFailures: number }) => void;
    recordSuccess: ReturnType<typeof vi.fn>;
    recordFailure: ReturnType<typeof vi.fn>;
  }> = [];
  class FakeWatchdog {
    recordSuccess = vi.fn();
    recordFailure = vi.fn();
    constructor(
      public maxFailures: number,
      public onTrip: (c: { consecutiveFailures: number }) => void,
    ) {
      watchdogInstances.push(this);
    }
  }
  return {
    FakeMqttWatcher,
    FakeEsphomeWatcher,
    FakePollSource,
    FakeWatchdog,
    watchdogInstances,
    resolveHandlerKey: vi.fn<(h?: string) => string>(() => 'noble'),
    resolveUserProfile: vi.fn(() => ({ __profile: 'sentinel' })),
    abortableSleep: vi.fn(async () => undefined),
  };
});

vi.mock('../../src/ble/index.js', () => ({
  ReadingWatcher: h.FakeMqttWatcher,
  resolveHandlerKey: h.resolveHandlerKey,
}));
vi.mock('../../src/ble/handler-esphome-proxy/index.js', () => ({
  ReadingWatcher: h.FakeEsphomeWatcher,
}));
vi.mock('../../src/runtime/poll-source.js', () => ({ PollReadingSource: h.FakePollSource }));
vi.mock('../../src/ble/watchdog.js', () => ({ ConsecutiveFailureWatchdog: h.FakeWatchdog }));
vi.mock('../../src/config/resolve.js', () => ({ resolveUserProfile: h.resolveUserProfile }));
vi.mock('../../src/ble/types.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/ble/types.js')>();
  return { ...actual, abortableSleep: h.abortableSleep };
});

const { buildReadingSource } = await import('../../src/runtime/sources.js');
const { POST_DISCONNECT_GRACE_MS } = await import('../../src/ble/types.js');
import type { AppContext } from '../../src/runtime/context.js';
import type { ScaleAdapter } from '../../src/interfaces/scale-adapter.js';

const ADAPTERS = [{ name: 'A' }] as unknown as ScaleAdapter[];

function makeCtx(overrides: Partial<AppContext> = {}): AppContext {
  return {
    bleHandler: 'auto',
    mqttProxy: undefined,
    esphomeProxy: undefined,
    scaleMac: 'AA:BB:CC:DD:EE:FF',
    signal: new AbortController().signal,
    abortApp: vi.fn(),
    config: {
      users: [{ beurer_pin: 1234, beurer_user_index: 2 }],
      scale: {},
      runtime: { scan_cooldown: 5 },
    },
    ...overrides,
  } as unknown as AppContext;
}

describe('buildReadingSource() dispatch (#186)', () => {
  let origExitCode: typeof process.exitCode;

  beforeEach(() => {
    origExitCode = process.exitCode;
    vi.clearAllMocks();
    h.watchdogInstances.length = 0;
    h.resolveHandlerKey.mockReturnValue('noble');
    h.resolveUserProfile.mockReturnValue({ __profile: 'sentinel' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    process.exitCode = origExitCode;
    vi.restoreAllMocks();
  });

  it('mqtt-proxy: returns ReadingWatcher with re-resolving onSourceReload', async () => {
    const ctx = makeCtx({ bleHandler: 'mqtt-proxy', mqttProxy: { broker_url: 'x' } as never });
    const bundle = await buildReadingSource(ctx, ADAPTERS, 10, 30);

    expect(bundle.source).toBeInstanceOf(h.FakeMqttWatcher);
    expect((bundle.source as unknown as { args: unknown[] }).args).toEqual([
      ctx.mqttProxy,
      ADAPTERS,
      ctx.scaleMac,
      { __profile: 'sentinel' },
    ]);
    expect(bundle.failureLogPrefix).toBe('Error processing reading');

    bundle.onSourceReload?.();
    const watcher = bundle.source as unknown as { updateConfig: ReturnType<typeof vi.fn> };
    expect(watcher.updateConfig).toHaveBeenCalledWith(ADAPTERS, ctx.scaleMac, {
      __profile: 'sentinel',
    });
  });

  it('esphome-proxy: returns Esphome watcher and forwards derived scaleAuth', async () => {
    const ctx = makeCtx({ bleHandler: 'esphome-proxy', esphomeProxy: { host: 'h' } as never });
    const bundle = await buildReadingSource(ctx, ADAPTERS, 10, 30);

    expect(bundle.source).toBeInstanceOf(h.FakeEsphomeWatcher);
    expect(bundle.failureLogPrefix).toBe('Error processing ESPHome reading');
    const args = (bundle.source as unknown as { args: unknown[] }).args;
    expect(args[0]).toBe(ctx.esphomeProxy);
    expect(args[4]).toEqual({ pin: 1234, userIndex: 2 });

    bundle.onSourceReload?.();
    const watcher = bundle.source as unknown as { updateConfig: ReturnType<typeof vi.fn> };
    expect(watcher.updateConfig).toHaveBeenCalledWith(
      ADAPTERS,
      ctx.scaleMac,
      { __profile: 'sentinel' },
      { pin: 1234, userIndex: 2 },
    );
  });

  it('falls back to poll source when mqtt-proxy selected but mqttProxy is undefined', async () => {
    const ctx = makeCtx({ bleHandler: 'mqtt-proxy', mqttProxy: undefined });
    const bundle = await buildReadingSource(ctx, ADAPTERS, 10, 30);
    expect(bundle.source).toBeInstanceOf(h.FakePollSource);
  });

  it('poll path: PollReadingSource + watchdog-wired hooks', async () => {
    const ctx = makeCtx({ bleHandler: 'auto' });
    const bundle = await buildReadingSource(ctx, ADAPTERS, 7, 30);

    expect(bundle.source).toBeInstanceOf(h.FakePollSource);
    expect((bundle.source as unknown as { ctx: unknown; adapters: unknown }).ctx).toBe(ctx);
    expect((bundle.source as unknown as { adapters: unknown }).adapters).toBe(ADAPTERS);
    expect(bundle.failureLogPrefix).toBe('No scale found');

    const wd = h.watchdogInstances[0];
    expect(wd.maxFailures).toBe(7);

    bundle.onFailure?.(new Error('boom'));
    expect(wd.recordFailure).toHaveBeenCalledOnce();

    await bundle.onSuccess?.();
    expect(wd.recordSuccess).toHaveBeenCalledOnce();
    // noble (not node-ble) → no grace floor, sleeps exactly cooldown*1000.
    expect(h.abortableSleep).toHaveBeenCalledWith(5000, ctx.signal);
  });

  it('poll path: uses fallback cooldown when runtime.scan_cooldown is unset', async () => {
    const ctx = makeCtx({
      bleHandler: 'auto',
      config: { users: [{}], scale: {}, runtime: {} } as never,
    });
    const bundle = await buildReadingSource(ctx, ADAPTERS, 7, 30);
    await bundle.onSuccess?.();
    expect(h.abortableSleep).toHaveBeenCalledWith(30_000, ctx.signal);
  });

  it('poll path: node-ble applies the post-disconnect grace floor', async () => {
    h.resolveHandlerKey.mockReturnValue('node-ble');
    const ctx = makeCtx({ bleHandler: 'auto' }); // cooldown 5s = 5000ms < 25000ms floor
    const bundle = await buildReadingSource(ctx, ADAPTERS, 7, 30);
    await bundle.onSuccess?.();
    expect(POST_DISCONNECT_GRACE_MS).toBe(25_000);
    expect(h.abortableSleep).toHaveBeenCalledWith(POST_DISCONNECT_GRACE_MS, ctx.signal);
  });

  it('watchdog trip: sets exit code 1 and aborts the app', async () => {
    const ctx = makeCtx({ bleHandler: 'auto' });
    await buildReadingSource(ctx, ADAPTERS, 3, 30);

    const wd = h.watchdogInstances[0];
    wd.onTrip({ consecutiveFailures: 3 });

    expect(process.exitCode).toBe(1);
    expect(ctx.abortApp).toHaveBeenCalledOnce();
  });
});
