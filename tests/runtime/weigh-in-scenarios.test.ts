import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Mock } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppConfig, MqttProxyConfig, UserConfig } from '../../src/config/schema.js';
import type { BodyComposition, UserProfile } from '../../src/interfaces/scale-adapter.js';
import type { Exporter, ExportContext } from '../../src/interfaces/exporter.js';
import type { AppContext } from '../../src/runtime/context.js';
import { adapters as realAdapters } from '../../src/scales/index.js';
import { applyForcedAdapter } from '../../src/scales/force.js';
import { xorChecksum } from '../../src/scales/body-comp-helpers.js';
import { restoreReplayAnchors } from '../../src/runtime/replay-anchors.js';

/**
 * Weigh-in scenarios end to end: a simulated Eufy T9146 behind a simulated
 * ESP32 bridge, driving the real mqtt-proxy ReadingWatcher and the real reading
 * processor. The ESP32 model follows the firmware: it gates its start beep on
 * each scan batch before publishing it, stops scanning while a GATT connection
 * is being made or held, and plays its problem sound when no server cue
 * arrives within 15 s of the start beep.
 */

vi.spyOn(console, 'log').mockImplementation(() => {});
vi.spyOn(console, 'warn').mockImplementation(() => {});
vi.spyOn(console, 'error').mockImplementation(() => {});
vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

// ─── MQTT client ─────────────────────────────────────────────────────────────

type Listener = (topic: string, payload: Buffer) => void;

interface FakeClient {
  connected: boolean;
  on: Mock;
  removeListener: Mock;
  subscribeAsync: Mock;
  unsubscribeAsync: Mock;
  publishAsync: Mock;
  endAsync: Mock;
  deliver: (topic: string, payload: string | Buffer) => void;
}

function createClient(onPublish: (topic: string, payload: Buffer) => void): FakeClient {
  const listeners = new Map<string, Listener[]>();
  const client: FakeClient = {
    connected: true,
    on: vi.fn((event: string, handler: Listener) => {
      listeners.set(event, [...(listeners.get(event) ?? []), handler]);
      return client;
    }),
    removeListener: vi.fn((event: string, handler: Listener) => {
      listeners.set(
        event,
        (listeners.get(event) ?? []).filter((h) => h !== handler),
      );
      return client;
    }),
    subscribeAsync: vi.fn(async () => []),
    unsubscribeAsync: vi.fn(async () => undefined),
    publishAsync: vi.fn(async (topic: string, payload?: string | Buffer) => {
      onPublish(topic, Buffer.isBuffer(payload) ? payload : Buffer.from(payload ?? ''));
    }),
    endAsync: vi.fn(async () => undefined),
    deliver(topic, payload) {
      const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
      for (const handler of [...(listeners.get('message') ?? [])]) handler(topic, buf);
    },
  };
  return client;
}

let client: FakeClient;

vi.mock('mqtt', () => ({
  connectAsync: vi.fn(async () => client),
}));

const { ReadingWatcher, _resetProxyState, createMqttProxyDisplayNotifier } =
  await import('../../src/ble/handler-mqtt-proxy/index.js');
const { processReading } = await import('../../src/runtime/processor.js');

// ─── Setup ───────────────────────────────────────────────────────────────────

const MAC = 'AA:BB:CC:DD:EE:FF';
const PREFIX = 'ble-proxy/esp32-test';
const NOTIFY = '0000fff400001000800000805f9b34fb';
const WRITE = '0000fff100001000800000805f9b34fb';
const START = new Date(2026, 2, 10, 7, 30, 0);
const TICK_MS = 500;
const RESULT_TIMEOUT_MS = 15_000;
const SCALE_REARM_MS = 30_000;
/** How long the scale stays awake advertising weight 0 after a step-off. */
const AWAKE_AFTER_MS = 20_000;
/** The scale ends a session with nothing left to stream this long after its history dump. */
const IDLE_DISCONNECT_MS = 3_000;
/** From the end of a GATT session to the next scan batch; the server reconnects ~1.5 s after a save. */
const RESUME_SCAN_MS = 1_000;

const MQTT_PROXY: MqttProxyConfig = {
  broker_url: 'mqtt://localhost:1883',
  device_id: 'esp32-test',
  topic_prefix: 'ble-proxy',
  username: null,
  password: null,
  embedded_broker_port: 1883,
  embedded_broker_bind: '0.0.0.0',
  auto_connect: false,
};

const PROFILE: UserProfile = { height: 180, age: 35, gender: 'male', isAthlete: false };

const ALEX: UserConfig = {
  name: 'Alex',
  slug: 'alex',
  height: 183,
  birth_date: '1990-06-15',
  gender: 'male',
  is_athlete: false,
  weight_range: { min: 75, max: 95 },
  last_known_weight: 82,
};

const SAM: UserConfig = {
  name: 'Sam',
  slug: 'sam',
  height: 165,
  birth_date: '1992-03-20',
  gender: 'female',
  is_athlete: false,
  weight_range: { min: 50, max: 70 },
  last_known_weight: 58,
};

// ─── The scale ───────────────────────────────────────────────────────────────

/** One person on the scale, times in ms from the scenario start. */
interface WeighIn {
  kg: number;
  ohm: number;
  on: number;
  settle: number;
  off: number;
  /** The impedance frame, after which the weigh-in is in the scale's memory. */
  final: number;
}

interface StoredRecord {
  kg: number;
  ohm: number;
  at: Date;
}

function frame(kg: number, ohm: number, stable: number, status: number): Buffer {
  const buf = Buffer.alloc(11);
  buf[0] = 0xcf;
  buf.writeUInt16LE(Math.round(ohm * 10), 1);
  buf.writeUInt16LE(Math.round(kg * 100), 3);
  buf[8] = stable;
  buf[9] = status;
  buf[10] = xorChecksum(buf, 0, 10);
  return buf;
}

function recordFrame(r: StoredRecord): Buffer {
  const f = frame(r.kg, r.ohm, 0, 0x00);
  const t = Buffer.alloc(7);
  t.writeUInt16BE(r.at.getFullYear(), 0);
  t[2] = r.at.getMonth() + 1;
  t[3] = r.at.getDate();
  t[4] = r.at.getHours();
  t[5] = r.at.getMinutes();
  t[6] = r.at.getSeconds();
  return Buffer.concat([f, t]);
}

const ALL_ZERO = Buffer.alloc(11);
const at = (ms: number): Date => new Date(START.getTime() + ms);

class FakeScale {
  memory: StoredRecord[] = [];
  private dumped: StoredRecord[] = [];
  private finalSent = new Set<WeighIn>();
  private stream: ReturnType<typeof setInterval> | null = null;
  private idle: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly weighIns: WeighIn[],
    /** Extra wake-ups with nobody on the scale: [from, to). */
    readonly idleWakes: Array<[number, number]> = [],
    readonly elapsed: () => number,
    readonly notify: (data: Buffer) => void,
    readonly disconnect: () => void,
  ) {
    for (const w of weighIns) {
      setTimeout(() => this.memory.push({ kg: w.kg, ohm: w.ohm, at: at(w.final) }), w.final);
    }
  }

  /** The 0xCF frame region the scale advertises now, or undefined while asleep. */
  advert(t: number): Buffer | undefined {
    for (const w of this.weighIns) {
      if (t >= w.on && t < w.off) {
        return t < w.settle ? frame(w.kg, 0, 0, 0x01) : frame(w.kg, 0, 1, 0x00);
      }
      if (t >= w.on - 1000 && t < w.on) return t < w.on - 500 ? ALL_ZERO : frame(0, 0, 0, 0x01);
    }
    for (const [from, to] of this.idleWakes) {
      if (t >= from && t < to) return t < from + 500 ? ALL_ZERO : frame(0, 0, 0, 0x01);
    }
    for (const w of this.weighIns) {
      if (t >= w.off && t < w.off + AWAKE_AFTER_MS) return frame(0, 0, 0, 0x01);
    }
    return undefined;
  }

  private inProgress(t: number): WeighIn | undefined {
    return this.weighIns.find((w) => t >= w.on && !this.finalSent.has(w) && t < w.final + TICK_MS);
  }

  onSubscribe(): void {
    this.stream = setInterval(() => {
      const t = this.elapsed();
      const w = this.inProgress(t);
      if (!w) return;
      if (t >= w.final) {
        this.finalSent.add(w);
        this.notify(frame(w.kg, w.ohm, 1, 0x00));
      } else if (t >= w.settle) {
        this.notify(frame(w.kg, 0, 1, 0x01));
      } else {
        this.notify(frame(w.kg, 0, 0, 0x01));
      }
    }, TICK_MS);
  }

  onWrite(data: Buffer): void {
    if (data[0] === 0xf2 && data[1] === 0x00) {
      this.dumped = [...this.memory];
      for (const r of this.dumped) this.notify(recordFrame(r));
      this.notify(Buffer.from([0xf2, 0x00]));
      if (!this.inProgress(this.elapsed())) {
        this.idle = setTimeout(() => {
          this.notify(Buffer.from([0xf3, 0x00]));
          this.disconnect();
        }, IDLE_DISCONNECT_MS);
      }
    }
    if (data[0] === 0xf2 && data[1] === 0x01) {
      this.memory = this.memory.filter((r) => !this.dumped.includes(r));
    }
  }

  endSession(): void {
    if (this.stream) clearInterval(this.stream);
    if (this.idle) clearTimeout(this.idle);
    this.stream = null;
    this.idle = null;
  }
}

// ─── The ESP32 ───────────────────────────────────────────────────────────────

/** firmware advert_weight: the weight of the first checksum-valid 0xCF frame. */
function advertWeight(data: Buffer): number | undefined {
  for (let i = 0; i + 11 <= data.length; i++) {
    if (data[i] !== 0xcf || xorChecksum(data, i, i + 10) !== data[i + 10]) continue;
    if (data[i + 9] === 0x02) return undefined;
    return data.readUInt16LE(i + 3) / 100;
  }
  return undefined;
}

/** firmware ScaleBeepGate. */
class BeepGate {
  armed = true;
  lastSeen: number | null = null;

  update(data: Buffer, now: number): boolean {
    if (this.lastSeen !== null && now - this.lastSeen >= SCALE_REARM_MS) {
      this.armed = true;
      this.lastSeen = null;
    }
    this.lastSeen = now;
    const weight = advertWeight(data);
    if (weight === undefined) return false;
    if (weight === 0) {
      this.armed = true;
      return false;
    }
    if (!this.armed) return false;
    this.armed = false;
    return true;
  }

  finish(now: number): void {
    this.armed = false;
    this.lastSeen = now;
  }
}

interface Cue {
  at: number;
  repeat: number;
}

class FakeEsp32 {
  readonly startBeeps: number[] = [];
  readonly problemBeeps: number[] = [];
  readonly serverCues: Cue[] = [];
  readonly connects: number[] = [];
  readonly gate = new BeepGate();
  scale!: FakeScale;
  private scanning = true;
  private session = false;
  private resultStarted: number | null = null;
  private readonly t0 = Date.now();
  /** Delay before each connect command is answered; `fail` publishes an error instead. */
  connectPlan: Array<{ delayMs: number; fail?: boolean }> = [];

  constructor() {
    setInterval(() => this.tick(), TICK_MS);
  }

  elapsed = (): number => Date.now() - this.t0;

  private tick(): void {
    const now = this.elapsed();
    if (this.resultStarted !== null && now - this.resultStarted >= RESULT_TIMEOUT_MS) {
      this.resultStarted = null;
      this.problemBeeps.push(now);
    }
    if (!this.scanning) return;
    const region = this.scale.advert(now);
    if (!region) return;
    const data = Buffer.concat([
      Buffer.from('ccddeeff', 'hex'),
      region,
      Buffer.from('649146', 'hex'),
    ]);
    if (this.gate.update(data, now)) {
      this.startBeeps.push(now);
      this.resultStarted = now;
    }
    const entry = {
      address: MAC,
      name: (now / TICK_MS) % 2 === 0 ? 'eufy T9146' : '',
      rssi: -60,
      services: [],
      addr_type: 0,
      manufacturer_id: 0xbbaa,
      manufacturer_data: data.toString('hex'),
    };
    client.deliver(`${PREFIX}/scan/results`, JSON.stringify([entry]));
  }

  onPublish = (topic: string, payload: Buffer): void => {
    const now = this.elapsed();
    if (topic === `${PREFIX}/beep`) {
      const { repeat } = JSON.parse(payload.toString()) as { repeat: number };
      this.serverCues.push({ at: now, repeat });
      this.resultStarted = null;
      this.gate.finish(now);
    } else if (topic === `${PREFIX}/connect`) {
      this.connects.push(now);
      this.scanning = false;
      const plan = this.connectPlan.shift() ?? { delayMs: 2_500 };
      setTimeout(() => {
        if (plan.fail) {
          client.deliver(
            `${PREFIX}/error`,
            JSON.stringify({ op: 'connect', message: 'connect timed out', address: MAC }),
          );
          this.resume();
          return;
        }
        this.session = true;
        client.deliver(
          `${PREFIX}/connected`,
          JSON.stringify({
            address: MAC,
            chars: [
              { uuid: WRITE, properties: ['write'] },
              { uuid: NOTIFY, properties: ['notify'] },
            ],
          }),
        );
      }, plan.delayMs);
    } else if (topic === `${PREFIX}/subscribe/${NOTIFY}`) {
      if (this.session) this.scale.onSubscribe();
    } else if (topic === `${PREFIX}/write/${WRITE}`) {
      if (this.session) this.scale.onWrite(payload);
    } else if (topic === `${PREFIX}/disconnect`) {
      this.endSession();
    }
  };

  /** The scale dropped the link. */
  scaleDisconnected = (): void => {
    if (!this.session) return;
    this.endSession();
    client.deliver(`${PREFIX}/disconnected`, '');
  };

  private endSession(): void {
    if (!this.session) return;
    this.session = false;
    this.scale.endSession();
    this.resume();
  }

  private resume(): void {
    this.gate.lastSeen = this.elapsed();
    setTimeout(() => (this.scanning = true), RESUME_SCAN_MS);
  }
}

// ─── The server ──────────────────────────────────────────────────────────────

interface Exported {
  slug: string;
  kg: number;
  historical: boolean;
}

function makeConfig(outOfRange: AppConfig['out_of_range']): AppConfig {
  return {
    version: 1,
    scale: { weight_unit: 'kg', height_unit: 'cm', display_unit: 'weight_unit' },
    unknown_user: 'log',
    out_of_range: outOfRange,
    users: [{ ...ALEX }, { ...SAM }],
    update_check: false,
  };
}

interface ServerOptions {
  anchorsPath?: string;
  outOfRange?: AppConfig['out_of_range'];
}

function makeCtx({ anchorsPath, outOfRange = 'warn' }: ServerOptions): AppContext {
  const config = makeConfig(outOfRange);
  const weights = new Map<string, number>();
  const times = new Map<string, Date>();
  if (anchorsPath) restoreReplayAnchors(anchorsPath, config.users, weights, times);
  return {
    config,
    scaleMac: MAC,
    weightUnit: 'kg',
    dryRun: false,
    mqttProxy: MQTT_PROXY,
    configSource: 'env',
    configPath: undefined,
    bleHandler: 'mqtt-proxy',
    bleAdapter: undefined,
    adapterPrivacy: false,
    esphomeProxy: undefined,
    haBluetooth: undefined,
    signal: new AbortController().signal,
    exporterCache: new Map(),
    lastExportedWeights: weights,
    lastExportedAt: times,
    replayAnchorsPath: anchorsPath,
    embeddedBroker: null,
    display: createMqttProxyDisplayNotifier(() => MQTT_PROXY),
    retryFailedExports: false,
    exportQueuePath: undefined,
    abortApp: vi.fn(),
    setConfig: vi.fn(),
  } as AppContext;
}

function recordingExporter(slug: string, exports: Exported[]): Exporter {
  return {
    name: 'file',
    supportsBackdate: true,
    async export(data: BodyComposition, context?: ExportContext) {
      exports.push({ slug, kg: data.weight, historical: context?.historical === true });
      return { success: true };
    },
  };
}

/** A running server: the watcher plus the loop that hands each reading to the processor. */
async function startServer(exports: Exported[], opts: ServerOptions = {}) {
  const ctx = makeCtx(opts);
  const watcher = new ReadingWatcher(
    MQTT_PROXY,
    applyForcedAdapter(realAdapters, '1byone (Eufy)'),
    MAC,
    PROFILE,
  );
  await watcher.start();
  const stop = new AbortController();
  const loop = (async () => {
    for (;;) {
      const raw = await watcher.nextReading(stop.signal).catch(() => null);
      if (!raw) return;
      await processReading(ctx, raw, {
        getExportersForUser: (slug) => [recordingExporter(slug, exports)],
      });
    }
  })();
  return {
    async stop() {
      stop.abort();
      await loop;
      await watcher.stop();
    },
  };
}

let esp: FakeEsp32;

function setUp(weighIns: WeighIn[], idleWakes: Array<[number, number]> = []): void {
  esp = new FakeEsp32();
  client = createClient(esp.onPublish);
  esp.scale = new FakeScale(
    weighIns,
    idleWakes,
    esp.elapsed,
    (data) => client.deliver(`${PREFIX}/notify/${NOTIFY}`, data),
    esp.scaleDisconnected,
  );
}

const run = (ms: number) => vi.advanceTimersByTimeAsync(ms);

/**
 * The invariant from the person's side: each weigh-in gets one start beep from
 * the ESP32 and then exactly one result cue from the server within 15 s of it,
 * before the next start beep; and the ESP32 never has to play its problem sound.
 */
function expectOneCuePerWeighIn(count: number): void {
  expect(esp.problemBeeps).toEqual([]);
  expect(esp.startBeeps).toHaveLength(count);
  expect(esp.serverCues).toHaveLength(count);
  esp.startBeeps.forEach((start, i) => {
    const cue = esp.serverCues[i].at;
    expect(cue).toBeGreaterThan(start);
    expect(cue - start).toBeLessThanOrEqual(RESULT_TIMEOUT_MS);
    if (i + 1 < esp.startBeeps.length) expect(cue).toBeLessThan(esp.startBeeps[i + 1]);
  });
}

/** Alex steps on at 1.5 s; the scale wakes 1 s earlier with an all-zero, then a weight-0 advert. */
const ALEX_WEIGH_IN: WeighIn = {
  kg: 82.4,
  ohm: 480,
  on: 1_500,
  settle: 4_500,
  off: 6_500,
  final: 10_500,
};

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  vi.setSystemTime(START);
  _resetProxyState();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

// ─── Scenarios ───────────────────────────────────────────────────────────────

describe('weigh-in scenarios: T9146 behind an ESP32 bridge', () => {
  it('1. normal weigh-in: connects on the first weight advert, one 2-beep, one export', async () => {
    setUp([ALEX_WEIGH_IN]);
    const exports: Exported[] = [];
    const server = await startServer(exports);

    await run(12_000);

    expect(esp.connects).toEqual([ALEX_WEIGH_IN.on]);
    expect(esp.startBeeps).toEqual([ALEX_WEIGH_IN.on]);
    expect(esp.serverCues.map((c) => c.repeat)).toEqual([2]);
    expect(exports).toEqual([{ slug: 'alex', kg: 82.4, historical: false }]);
    expectOneCuePerWeighIn(1);
    await server.stop();
  });

  it('2. after the weigh-in the scale advertises weight 0 for 20 s: no connect, no beeps', async () => {
    setUp([ALEX_WEIGH_IN]);
    const exports: Exported[] = [];
    const server = await startServer(exports);

    await run(12_000);
    const cues = esp.serverCues.length;
    await run(AWAKE_AFTER_MS + 5_000);

    expect(esp.connects).toHaveLength(1);
    expect(esp.serverCues).toHaveLength(cues);
    expect(exports).toHaveLength(1);
    expectOneCuePerWeighIn(1);
    await server.stop();
  });

  it('3. the person stays on after the save: reconnects, the replayed copy is skipped silently', async () => {
    setUp([{ ...ALEX_WEIGH_IN, off: 40_000 }]);
    const exports: Exported[] = [];
    const server = await startServer(exports);

    await run(60_000);

    expect(esp.connects.length).toBeGreaterThan(1);
    expect(esp.serverCues.map((c) => c.repeat)).toEqual([2]);
    expect(exports).toEqual([{ slug: 'alex', kg: 82.4, historical: false }]);
    expectOneCuePerWeighIn(1);
    await server.stop();
  });

  it('4. back-to-back: a second person after weight-0 adverts gets their own beeps and export', async () => {
    const sam: WeighIn = {
      kg: 58.2,
      ohm: 520,
      on: 20_000,
      settle: 23_000,
      off: 25_000,
      final: 29_000,
    };
    setUp([ALEX_WEIGH_IN, sam]);
    const exports: Exported[] = [];
    const server = await startServer(exports);

    await run(35_000);

    expect(esp.connects).toEqual([ALEX_WEIGH_IN.on, sam.on]);
    expect(esp.serverCues.map((c) => c.repeat)).toEqual([2, 2]);
    expect(exports).toEqual([
      { slug: 'alex', kg: 82.4, historical: false },
      { slug: 'sam', kg: 58.2, historical: false },
    ]);
    expectOneCuePerWeighIn(2);
    await server.stop();
  });

  it('5. idle wake: only all-zero and weight-0 adverts for 60 s, nothing happens', async () => {
    setUp([], [[500, 60_500]]);
    const exports: Exported[] = [];
    const server = await startServer(exports);

    await run(65_000);

    expect(esp.connects).toEqual([]);
    expect(esp.startBeeps).toEqual([]);
    expect(esp.serverCues).toEqual([]);
    expect(esp.problemBeeps).toEqual([]);
    expect(exports).toEqual([]);
    await server.stop();
  });

  it('6. hung first connect: the ESP32 retry connects after the weigh-in, cue from the stored record', async () => {
    const quick: WeighIn = { ...ALEX_WEIGH_IN, settle: 3_500, off: 5_000, final: 8_500 };
    setUp([quick]);
    // One 6 s attempt hangs, the retry connects 2.5 s later.
    esp.connectPlan = [{ delayMs: 8_500 }];
    const exports: Exported[] = [];
    const server = await startServer(exports);

    await run(20_000);

    expect(esp.connects).toEqual([quick.on]);
    expect(esp.serverCues.map((c) => c.repeat)).toEqual([2]);
    expect(exports).toEqual([{ slug: 'alex', kg: 82.4, historical: true }]);
    expectOneCuePerWeighIn(1);
    await server.stop();
  });

  it('6b. connect fails for good after the step-off: no reconnect on weight 0, the ESP32 flags it, the record follows the next weigh-in', async () => {
    const quick: WeighIn = { ...ALEX_WEIGH_IN, settle: 3_500, off: 5_000, final: 8_500 };
    const sam: WeighIn = {
      kg: 58.2,
      ohm: 520,
      on: 60_000,
      settle: 63_000,
      off: 65_000,
      final: 69_000,
    };
    setUp([quick, sam]);
    esp.connectPlan = [{ delayMs: 12_000, fail: true }];
    const exports: Exported[] = [];
    const server = await startServer(exports);

    await run(30_000);
    expect(esp.connects).toEqual([quick.on]);
    expect(esp.serverCues).toEqual([]);
    expect(esp.problemBeeps).toEqual([quick.on + RESULT_TIMEOUT_MS]);

    await run(45_000);
    expect(esp.connects).toEqual([quick.on, sam.on]);
    expect(esp.serverCues.map((c) => c.repeat)).toEqual([2]);
    expect(exports).toEqual([
      { slug: 'alex', kg: 82.4, historical: true },
      { slug: 'sam', kg: 58.2, historical: false },
    ]);
    await server.stop();
  });

  describe('7. container restart with the replay anchors restored', () => {
    let dir: string;

    beforeEach(() => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'weigh-in-scenarios-'));
    });

    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it('a: restarted while the person is still on, the replay just taken is skipped silently', async () => {
      const anchors = path.join(dir, '.last-live-weigh-ins.json');
      setUp([{ ...ALEX_WEIGH_IN, off: 30_000 }]);
      const exports: Exported[] = [];
      let server = await startServer(exports, { anchorsPath: anchors });
      await run(11_000);
      expect(exports).toHaveLength(1);
      expect(esp.connects).toHaveLength(1);

      await server.stop();
      _resetProxyState();
      server = await startServer(exports, { anchorsPath: anchors });
      await run(30_000);

      expect(esp.connects.length).toBeGreaterThan(1);
      expect(esp.serverCues.map((c) => c.repeat)).toEqual([2]);
      expect(exports).toEqual([{ slug: 'alex', kg: 82.4, historical: false }]);
      expectOneCuePerWeighIn(1);
      await server.stop();
    });

    it('b: a record stamped minutes before the restart rides along with the next weigh-in and is skipped', async () => {
      const anchors = path.join(dir, '.last-live-weigh-ins.json');
      const sam: WeighIn = {
        kg: 58.2,
        ohm: 520,
        on: 200_000,
        settle: 203_000,
        off: 205_000,
        final: 209_000,
      };
      setUp([ALEX_WEIGH_IN, sam]);
      const exports: Exported[] = [];
      let server = await startServer(exports, { anchorsPath: anchors });
      await run(60_000);

      await server.stop();
      _resetProxyState();
      server = await startServer(exports, { anchorsPath: anchors });
      await run(160_000);

      expect(esp.connects).toEqual([ALEX_WEIGH_IN.on, sam.on]);
      expect(esp.serverCues.map((c) => c.repeat)).toEqual([2, 2]);
      expect(exports).toEqual([
        { slug: 'alex', kg: 82.4, historical: false },
        { slug: 'sam', kg: 58.2, historical: false },
      ]);
      expectOneCuePerWeighIn(2);
      await server.stop();
    });
  });

  it('8. unknown person outside both ranges, out_of_range skip: one 3-beep, nothing exported', async () => {
    setUp([{ ...ALEX_WEIGH_IN, kg: 120.6 }]);
    const exports: Exported[] = [];
    const server = await startServer(exports, { outOfRange: 'skip' });

    await run(12_000);

    expect(esp.connects).toEqual([ALEX_WEIGH_IN.on]);
    expect(esp.serverCues.map((c) => c.repeat)).toEqual([3]);
    expect(exports).toEqual([]);
    expectOneCuePerWeighIn(1);
    await server.stop();
  });

  // unknown_user only applies when no user has a last_known_weight: with one,
  // the matcher picks the closest user, and out_of_range decides alone.
  it('8b. unknown person with out_of_range warn: matched to the closest last_known_weight and exported', async () => {
    setUp([{ ...ALEX_WEIGH_IN, kg: 120.6 }]);
    const exports: Exported[] = [];
    const server = await startServer(exports);

    await run(12_000);

    expect(esp.serverCues.map((c) => c.repeat)).toEqual([2]);
    expect(exports).toEqual([{ slug: 'alex', kg: 120.6, historical: false }]);
    expectOneCuePerWeighIn(1);
    await server.stop();
  });
});
