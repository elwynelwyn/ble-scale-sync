/**
 * End-to-end session replay: OneByoneAdapter (Eufy C1/T9146) driven through
 * the framework's real GATT reading flow (`waitForRawReading` in
 * src/ble/shared.ts) — history routing, the HoldForComposition hold timer,
 * and resolution on the final impedance frame.
 *
 * Fixtures are the COMPLETE notification sequence from the 2026-07-04 btsnoop
 * capture of the official EufyLife Android app talking to a real T9146: every
 * frame the scale sent on the notify char (0xFFF4) after CCCD subscription,
 * in capture order, with capture-relative pacing (the ~5 s gap before the
 * final impedance frame is preserved; the 12 s completion hold must NOT be
 * what resolves the session).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { waitForRawReading } from '../../src/ble/shared.js';
import type { BleChar, BleDevice, RawReading } from '../../src/ble/shared.js';
import { normalizeUuid } from '../../src/ble/types.js';
import { OneByoneAdapter } from '../../src/scales/one-byone.js';
import { defaultProfile } from '../helpers/scale-test-utils.js';

// Suppress log output during tests (same convention as tests/ble/shared.test.ts)
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.useFakeTimers();
  // Frozen "now" for the adapter's clock-sync write (exact bytes not asserted).
  vi.setSystemTime(new Date(2026, 6, 4, 17, 16, 0));
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── Fake BLE plumbing (mirrors tests/ble/shared.test.ts) ────────────────────

interface MockBleChar extends BleChar {
  triggerData(data: Buffer): void;
  subscribeCalled: boolean;
  writtenData: Buffer[];
}

function createMockChar(): MockBleChar {
  let onDataCallback: ((data: Buffer) => void) | null = null;
  const char: MockBleChar = {
    subscribeCalled: false,
    writtenData: [],
    subscribe: vi.fn(async (onData) => {
      char.subscribeCalled = true;
      onDataCallback = onData;
      return () => {
        onDataCallback = null;
      };
    }),
    write: vi.fn(async (data) => {
      char.writtenData.push(data);
    }),
    read: vi.fn(async () => Buffer.alloc(0)),
    triggerData: (data: Buffer) => {
      if (onDataCallback) onDataCallback(data);
    },
  };
  return char;
}

function createMockDevice(): BleDevice & { triggerDisconnect: () => void } {
  let disconnectCallback: (() => void) | null = null;
  return {
    onDisconnect: (callback) => {
      disconnectCallback = callback;
    },
    triggerDisconnect: () => {
      if (disconnectCallback) disconnectCallback();
    },
  };
}

// ─── Captured session (verbatim hex; delayMs = gap since the previous frame) ─

interface CaptureFrame {
  delayMs: number;
  hex: string;
  note: string;
}

// Notify-char (0xFFF4) frames, capture times 244.013 s → 251.726 s.
const SESSION: CaptureFrame[] = [
  { delayMs: 0, hex: 'cf00002a210000000001c5', note: 'live unstable 84.90' },
  { delayMs: 251, hex: 'cf000034210000000001db', note: 'live unstable 85.00' },
  { delayMs: 451, hex: 'f100', note: 'clock ack' },
  { delayMs: 89, hex: 'cf000052210000000101bc', note: 'live stable 85.30 — arms the 12s hold' },
  { delayMs: 210, hex: 'cf000052210000000101bc', note: 'live stable repeat' },
  { delayMs: 240, hex: 'cf000052210000000101bc', note: 'live stable repeat' },
  { delayMs: 150, hex: 'cfb81052211d13cd0000d707ea0704100726', note: 'history 85.30/428.0Ω' },
  { delayMs: 1, hex: 'cfa4105c215a54c10000c907ea0704100905', note: 'history 85.40/426.0Ω' },
  { delayMs: 28, hex: 'cfd6105221dad6d30000a507ea0704100938', note: 'history 85.30/431.0Ω' },
  { delayMs: 1, hex: 'cfd6105c21e5e70000007607ea0704100b3a', note: 'history 85.40/431.0Ω' },
  { delayMs: 30, hex: 'cf30115c21aca62a0000b307ea0704102e22', note: 'history 85.40/440.0Ω' },
  { delayMs: 0, hex: 'cfcc103e211b13c90000cd07ea0704110020', note: 'history 85.10/430.0Ω' },
  { delayMs: 30, hex: 'cf72103e211e13c300007c07ea070411003a', note: 'history 85.10/421.0Ω' },
  { delayMs: 1, hex: 'cfa4103e215f54d50000ba07ea070411010a', note: 'history 85.10/426.0Ω' },
  { delayMs: 29, hex: 'cfa41052211313a10000a907ea0704110f2d', note: 'history 85.30/426.0Ω' },
  { delayMs: 0, hex: 'f200', note: 'end-of-history marker → adapter must write f2 01' },
  { delayMs: 151, hex: 'f201', note: 'ack of our f2 01' },
  { delayMs: 89, hex: 'cf000052210000000101bc', note: 'live stable repeat' },
  { delayMs: 240, hex: 'cf000052210000000101bc', note: 'live stable repeat' },
  { delayMs: 240, hex: 'cf000052210000000101bc', note: 'live stable repeat' },
  { delayMs: 271, hex: 'cf000052210000000101bc', note: 'live stable repeat' },
  { delayMs: 210, hex: 'cf000052210000000101bc', note: 'live stable repeat' },
  { delayMs: 5001, hex: 'cfa410522170751b010017', note: 'FINAL: 85.30 kg + 426.0Ω → resolves' },
];

/** Expected `RawReading.history` after the replay: the 9 history frames in
 *  arrival order (HistoryBuffer.push preserves it; the dump is oldest first). */
const EXPECTED_HISTORY = [
  { weight: 85.3, impedance: 428.0, timestamp: new Date(2026, 6, 4, 16, 7, 38) },
  { weight: 85.4, impedance: 426.0, timestamp: new Date(2026, 6, 4, 16, 9, 5) },
  { weight: 85.3, impedance: 431.0, timestamp: new Date(2026, 6, 4, 16, 9, 56) },
  { weight: 85.4, impedance: 431.0, timestamp: new Date(2026, 6, 4, 16, 11, 58) },
  { weight: 85.4, impedance: 440.0, timestamp: new Date(2026, 6, 4, 16, 46, 34) },
  { weight: 85.1, impedance: 430.0, timestamp: new Date(2026, 6, 4, 17, 0, 32) },
  { weight: 85.1, impedance: 421.0, timestamp: new Date(2026, 6, 4, 17, 0, 58) },
  { weight: 85.1, impedance: 426.0, timestamp: new Date(2026, 6, 4, 17, 1, 10) },
  { weight: 85.3, impedance: 426.0, timestamp: new Date(2026, 6, 4, 17, 15, 45) },
];

// ─── Replay harness ──────────────────────────────────────────────────────────

interface ReplayResult {
  result: RawReading;
  notifyChar: MockBleChar;
  writeChar: MockBleChar;
}

/**
 * Run one full captured session through waitForRawReading with fresh fake BLE
 * plumbing. Asserts the structural completion property inline: the promise is
 * still pending after all pre-final frames (hold in effect) and resolves as
 * soon as the final impedance frame lands — total advanced time between the
 * hold arming and the final frame is ~6.9 s, well inside the 12 s hold, so a
 * hold-expiry resolution would fail the pre-final pending check's counterpart.
 */
async function runReplay(adapter: OneByoneAdapter): Promise<ReplayResult> {
  const notifyChar = createMockChar();
  const writeChar = createMockChar();
  const device = createMockDevice();
  const charMap = new Map<string, BleChar>([
    [normalizeUuid(adapter.charNotifyUuid), notifyChar],
    [normalizeUuid(adapter.charWriteUuid), writeChar],
  ]);

  const promise = waitForRawReading(charMap, device, adapter, defaultProfile(), '');

  // subscribe and onConnected run in parallel (subscribeAndInit's Promise.all);
  // the adapter's init handshake has 2×500 ms paced delays, so advance 1000 ms
  // for the clock-sync and history-request writes to complete.
  await vi.advanceTimersByTimeAsync(1000);
  expect(notifyChar.subscribeCalled).toBe(true);
  expect(writeChar.writtenData).toHaveLength(2);

  let settled = false;
  void promise.then(() => {
    settled = true;
  });

  // Feed every frame except the final one, with capture pacing.
  for (const frame of SESSION.slice(0, -1)) {
    await vi.advanceTimersByTimeAsync(frame.delayMs);
    notifyChar.triggerData(Buffer.from(frame.hex, 'hex'));
  }
  await vi.advanceTimersByTimeAsync(0);
  // Stable weight frames are complete-but-not-final: the hold keeps the
  // session open, so the promise must still be pending here.
  expect(settled).toBe(false);

  // Final impedance frame (~5 s later). Only a microtask flush follows — if
  // resolution depended on the 12 s hold expiring, `settled` would stay false.
  const finalFrame = SESSION[SESSION.length - 1];
  await vi.advanceTimersByTimeAsync(finalFrame.delayMs);
  notifyChar.triggerData(Buffer.from(finalFrame.hex, 'hex'));
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(true);

  return { result: await promise, notifyChar, writeChar };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('OneByoneAdapter — captured T9146 session replay through waitForRawReading', () => {
  it('resolves on the final impedance frame with full history and the exact write sequence', async () => {
    const adapter = new OneByoneAdapter();
    const { result, notifyChar, writeChar } = await runReplay(adapter);

    // 1. Resolved reading: final live frame, no timestamp, same adapter instance.
    expect(result.adapter).toBe(adapter);
    expect(result.reading.weight).toBeCloseTo(85.3, 2);
    expect(result.reading.impedance).toBeCloseTo(426.0, 1);
    expect(result.reading.timestamp).toBeUndefined();

    // 3. History: exactly the 9 dumped frames, arrival order (oldest first),
    //    each with its capture timestamp (local time) and matching values.
    expect(result.history).toHaveLength(9);
    EXPECTED_HISTORY.forEach((expected, i) => {
      const entry = result.history![i];
      expect(entry.weight, `history[${i}].weight`).toBeCloseTo(expected.weight, 2);
      expect(entry.impedance, `history[${i}].impedance`).toBeCloseTo(expected.impedance, 1);
      expect(entry.timestamp, `history[${i}].timestamp`).toEqual(expected.timestamp);
    });

    // 4. Writes on 0xFFF1 across the whole replay: clock sync, history
    //    request, then the f2 01 end-of-history ack — nothing else (the
    //    official app's fd config command is deliberately not sent).
    expect(writeChar.writtenData).toHaveLength(3);
    expect(writeChar.writtenData[0]).toHaveLength(8);
    expect(writeChar.writtenData[0][0]).toBe(0xf1);
    expect(writeChar.writtenData[1]).toEqual(Buffer.from('f200', 'hex'));
    expect(writeChar.writtenData[2]).toEqual(Buffer.from('f201', 'hex'));

    // 5. Trailing session-end notice after resolution: no throw, no change.
    expect(() => notifyChar.triggerData(Buffer.from('f300', 'hex'))).not.toThrow();
    expect(result.reading.weight).toBeCloseTo(85.3, 2);
    expect(result.reading.impedance).toBeCloseTo(426.0, 1);
    expect(result.history).toHaveLength(9);
    expect(writeChar.writtenData).toHaveLength(3);
  });

  it('replays a fresh session on the same adapter instance (registry singletons must reset)', async () => {
    const adapter = new OneByoneAdapter();
    await runReplay(adapter);

    // Second connect+session on the SAME instance: onConnected must reset
    // per-session state so the replay resolves identically again.
    const { result, writeChar } = await runReplay(adapter);
    expect(result.adapter).toBe(adapter);
    expect(result.reading.weight).toBeCloseTo(85.3, 2);
    expect(result.reading.impedance).toBeCloseTo(426.0, 1);
    expect(result.reading.timestamp).toBeUndefined();
    expect(result.history).toHaveLength(9);
    expect(result.history![0].timestamp).toEqual(new Date(2026, 6, 4, 16, 7, 38));
    expect(result.history![8].timestamp).toEqual(new Date(2026, 6, 4, 17, 15, 45));
    expect(writeChar.writtenData).toHaveLength(3);
    expect(writeChar.writtenData[2]).toEqual(Buffer.from('f201', 'hex'));
  });
});
