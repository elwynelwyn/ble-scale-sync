import { describe, it, expect, vi } from 'vitest';
import { OneByoneAdapter, OneByoneNewAdapter } from '../../src/scales/one-byone.js';
import {
  mockPeripheral,
  defaultProfile,
  makeConnectionContext,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';
import { uuid16, xorChecksum, WEIGHT_ONLY_HOLD_MS } from '../../src/scales/body-comp-helpers.js';
import { hex, type Trace } from '../helpers/replay/trace.js';
import { replaySession } from '../helpers/replay/session.js';
import { session as t9146 } from '../fixtures/onebyone/t9146.js';
import { bleLog } from '../../src/ble/types.js';

// ─── OneByoneAdapter ─────────────────────────────────────────────────────────

describe('OneByoneAdapter', () => {
  function makeAdapter() {
    return new OneByoneAdapter();
  }

  describe('matches()', () => {
    it.each(['t9146', 't9147', 't9120', 'health scale'])('matches "%s"', (name) => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral(name))).toBe(true);
    });

    it('matches name containing known substring', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('My T9146 Scale'))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('T9146'))).toBe(true);
      expect(adapter.matches(mockPeripheral('Health Scale'))).toBe(true);
    });

    it('does not match Eufy T9148/T9149 (different protocol)', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('eufy T9149'))).toBe(false);
      expect(adapter.matches(mockPeripheral('eufy T9148'))).toBe(false);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });

    it('matches post-discovery by 0xFFF4 characteristic when name absent (#177)', () => {
      const adapter = makeAdapter();
      const info = mockPeripheral('', [uuid16(0xfff0)], undefined, [
        uuid16(0xfff1),
        uuid16(0xfff4),
      ]);
      expect(adapter.matches(info)).toBe(true);
    });

    it('does not match nameless device with only 0xFFF0 service and no chars (#177)', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('', [uuid16(0xfff0)]))).toBe(false);
    });

    it('rejects a nameless device exposing 0xFFF4 alongside 0xFFF2 (Eufy P2, review of #251/#258)', () => {
      const adapter = makeAdapter();
      // Eufy P2 exposes fff1 + fff2 + fff4; a real 1byone never has fff2, so the
      // nameless P2 must fall through to its own adapter, not be grabbed here.
      const info = mockPeripheral('', [uuid16(0xfff0)], undefined, [
        uuid16(0xfff1),
        uuid16(0xfff2),
        uuid16(0xfff4),
      ]);
      expect(adapter.matches(info)).toBe(false);
    });
  });

  // Frames from the T9146 capture (tests/fixtures/onebyone/t9146.ts).
  const MEASURING = hex('cf00002a210000000001c5'); // 84.90 kg, status measuring
  const SETTLED = hex('cf000052210000000101bc'); // 85.30 kg, [8] settled, no impedance
  const FINAL = hex('cfa410522170751b010017'); // 85.30 kg, 426.0 ohm, status final
  const RECORD = hex('cfb81052211d13cd0000d707ea0704100726'); // 85.30 kg, 428.0 ohm, 2026-07-04 16:07:38

  /** A copy of `base` with `mutate` applied and the XOR at [10] recomputed. */
  function withChecksum(base: Buffer, mutate: (buf: Buffer) => void): Buffer {
    const buf = Buffer.from(base);
    mutate(buf);
    buf[10] = xorChecksum(buf, 0, 10);
    return buf;
  }

  /** Run onConnected under fake timers; returns its write mock, cleared. */
  async function connect(adapter: OneByoneAdapter) {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.useFakeTimers();
    try {
      const done = adapter.onConnected(makeConnectionContext({ write }));
      await vi.advanceTimersByTimeAsync(1000);
      await done;
    } finally {
      vi.useRealTimers();
    }
    write.mockClear();
    return write;
  }

  describe('onConnected()', () => {
    it('sends the clock sync, then the f2 00 record request, both with response', async () => {
      vi.useFakeTimers({ now: new Date(2026, 6, 4, 17, 16, 11, 500) });
      try {
        const adapter = makeAdapter();
        const write = vi.fn().mockResolvedValue(undefined);
        const done = adapter.onConnected(makeConnectionContext({ write }));
        await vi.advanceTimersByTimeAsync(1000);
        await done;

        // Not the app's fd 00 01 config command: it sets the display unit.
        expect(write.mock.calls).toEqual([
          [adapter.charWriteUuid, [0xf1, 0x07, 0xea, 0x07, 0x04, 0x11, 0x10, 0x0c], true],
          [adapter.charWriteUuid, [0xf2, 0x00], true],
        ]);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('parseNotification()', () => {
    it('reads a live frame that is still measuring, without completing', () => {
      const adapter = makeAdapter();
      const reading = adapter.parseNotification(MEASURING)!;
      expect(reading).toEqual({ weight: 84.9, impedance: 0 });
      expect(adapter.isComplete(reading)).toBe(false);
    });

    it('completes on a settled frame without impedance, but holds for the impedance', () => {
      const adapter = makeAdapter();
      const reading = adapter.parseNotification(SETTLED)!;
      expect(reading).toEqual({ weight: 85.3, impedance: 0 });
      expect(adapter.isComplete(reading)).toBe(true);
      expect(adapter.isFinal(reading)).toBe(false);
      expect(adapter.completionHoldMs).toBe(12_000);
    });

    it('resolves on the final frame carrying the impedance', () => {
      const adapter = makeAdapter();
      const reading = adapter.parseNotification(FINAL)!;
      expect(reading.weight).toBe(85.3);
      expect(reading.impedance).toBeCloseTo(426.0, 1);
      expect(adapter.isComplete(reading)).toBe(true);
      expect(adapter.isFinal(reading)).toBe(true);
    });

    it('completes on status final even without the settled flag at [8]', () => {
      const adapter = makeAdapter();
      const reading = adapter.parseNotification(withChecksum(FINAL, (b) => (b[8] = 0)))!;
      expect(adapter.isComplete(reading)).toBe(true);
    });

    it('decides completion per frame: a measuring frame after a settled one does not complete', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete(adapter.parseNotification(SETTLED)!)).toBe(true);
      expect(adapter.isComplete(adapter.parseNotification(MEASURING)!)).toBe(false);
    });

    it('reads a stored record with its time, flagged as from memory', () => {
      const adapter = makeAdapter();
      const reading = adapter.parseNotification(RECORD)!;
      expect(reading.weight).toBe(85.3);
      expect(reading.impedance).toBeCloseTo(428.0, 1);
      expect(reading.timestamp).toEqual(new Date(2026, 6, 4, 16, 7, 38));
      expect(reading.fromMemory).toBe(true);
      expect(adapter.isComplete(reading)).toBe(true);
    });

    it('drops a stored record whose date is not plausible', () => {
      const adapter = makeAdapter();
      const month13 = Buffer.from(RECORD);
      month13[13] = 13;
      const debug = vi.spyOn(bleLog, 'debug').mockImplementation(() => {});
      expect(adapter.parseNotification(month13)).toBeNull();
      expect(debug).toHaveBeenCalledWith(
        '1byone: dropping a stored record with an implausible date [07ea0d04100726]',
      );
      debug.mockRestore();
    });

    it('drops a frame with a bad checksum', () => {
      const adapter = makeAdapter();
      const buf = Buffer.from(FINAL);
      buf[10] ^= 0xff;
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('drops a frame with status 0x02, over the weight limit', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(withChecksum(FINAL, (b) => (b[9] = 0x02)))).toBeNull();
    });

    it.each(['f100', 'f200', 'f201', 'f300'])('returns null for the 2-byte frame %s', (h) => {
      expect(makeAdapter().parseNotification(hex(h))).toBeNull();
    });

    it('acks the f2 00 end-of-history marker with one f2 01, with response', async () => {
      const adapter = makeAdapter();
      const write = await connect(adapter);
      adapter.parseNotification(hex('f200'));
      expect(write.mock.calls).toEqual([[adapter.charWriteUuid, [0xf2, 0x01], true]]);
    });

    it('writes nothing for f2 00 once the session has ended', async () => {
      const adapter = makeAdapter();
      const write = await connect(adapter);
      adapter.onSessionEnd();
      adapter.parseNotification(hex('f200'));
      expect(write).not.toHaveBeenCalled();
    });

    it('returns null for a wrong header or a short frame', () => {
      const adapter = makeAdapter();
      const wrongHeader = Buffer.from(FINAL);
      wrongHeader[0] = 0xce;
      expect(adapter.parseNotification(wrongHeader)).toBeNull();
      expect(adapter.parseNotification(Buffer.alloc(0))).toBeNull();
      expect(adapter.parseNotification(hex('cf'))).toBeNull();
      expect(adapter.parseNotification(FINAL.subarray(0, 10))).toBeNull();
    });
  });

  describe('readyToConnect()', () => {
    const WEIGHING = withChecksum(MEASURING, (b) => b.writeUInt16LE(7240, 3)); // 72.40 kg

    /** Manufacturer data as a T9146 advertises it: MAC tail, 0xCF frame region, battery, model. */
    function advert(frame: Buffer) {
      return mockPeripheral('', [], {
        id: 0xbbaa,
        data: Buffer.concat([hex('ccddeeff'), frame, hex('649146')]),
      });
    }

    it('connects once the advertised frame shows a weight', () => {
      expect(makeAdapter().readyToConnect(advert(WEIGHING))).toBe(true);
    });

    it('waits on the all-zero frame region the scale wakes with', () => {
      expect(makeAdapter().readyToConnect(advert(Buffer.alloc(11)))).toBe(false);
    });

    it('waits on a valid frame with weight 0', () => {
      const empty = withChecksum(MEASURING, (b) => b.writeUInt16LE(0, 3));
      expect(makeAdapter().readyToConnect(advert(empty))).toBe(false);
    });

    it('waits on a frame with a bad checksum', () => {
      const bad = Buffer.from(WEIGHING);
      bad[10] ^= 0xff;
      expect(makeAdapter().readyToConnect(advert(bad))).toBe(false);
    });

    it('waits on a frame over the weight limit (status 0x02)', () => {
      const over = withChecksum(WEIGHING, (b) => (b[9] = 0x02));
      expect(makeAdapter().readyToConnect(advert(over))).toBe(false);
    });

    it('connects on an advertisement without manufacturer data', () => {
      expect(makeAdapter().readyToConnect(mockPeripheral('eufy T9146', [uuid16(0xfff0)]))).toBe(
        true,
      );
    });

    describe('advertisesNoWeight()', () => {
      const noWeight = (frame: Buffer) => makeAdapter().advertisesNoWeight(advert(frame));

      it('is true for a valid frame with weight 0', () => {
        expect(noWeight(withChecksum(MEASURING, (b) => b.writeUInt16LE(0, 3)))).toBe(true);
      });

      it('is true for the all-zero frame region the scale wakes with', () => {
        expect(noWeight(Buffer.alloc(11))).toBe(true);
      });

      it('is false for a frame showing a weight', () => {
        expect(noWeight(WEIGHING)).toBe(false);
      });

      it('is false for a corrupt frame', () => {
        const bad = Buffer.from(WEIGHING);
        bad[10] ^= 0xff;
        expect(noWeight(bad)).toBe(false);
      });

      it('is false for a frame over the weight limit (status 0x02): somebody is on it', () => {
        expect(noWeight(withChecksum(MEASURING, (b) => (b[9] = 0x02)))).toBe(false);
        expect(
          noWeight(withChecksum(MEASURING, (b) => (b.writeUInt16LE(0, 3), (b[9] = 0x02)))),
        ).toBe(false);
      });

      it('is false for truncated or missing manufacturer data', () => {
        expect(noWeight(Buffer.alloc(5))).toBe(false);
        expect(makeAdapter().advertisesNoWeight(mockPeripheral('eufy T9146'))).toBe(false);
      });
    });
  });

  describe('sessionDoneAfterMs()', () => {
    // RECORD is stamped 2026-07-04 16:07:38 on the scale's clock.
    const STAMP = new Date(2026, 6, 4, 16, 7, 38).getTime();
    async function connectAt(adapter: OneByoneAdapter, decidedAt: number) {
      vi.useFakeTimers();
      try {
        const done = adapter.onConnected(
          makeConnectionContext({ connectDecidedAt: new Date(decidedAt) }),
        );
        await vi.advanceTimersByTimeAsync(1000);
        await done;
      } finally {
        vi.useRealTimers();
      }
    }

    it('is 2 s after the marker when the weigh-in this connect was made for is stored', async () => {
      const adapter = makeAdapter();
      await connectAt(adapter, STAMP - 2_000);
      adapter.parseNotification(RECORD);
      expect(adapter.sessionDoneAfterMs()).toBeUndefined();
      adapter.parseNotification(hex('f200'));
      expect(adapter.sessionDoneAfterMs()).toBe(2_000);
    });

    it('is undefined for an empty memory: the weigh-in comes later as the final frame', async () => {
      const adapter = makeAdapter();
      await connectAt(adapter, STAMP);
      adapter.parseNotification(hex('f200'));
      expect(adapter.sessionDoneAfterMs()).toBeUndefined();
    });

    it('counts a record stamped in the same second as the connect decision', async () => {
      const adapter = makeAdapter();
      await connectAt(adapter, STAMP);
      adapter.parseNotification(RECORD);
      adapter.parseNotification(hex('f200'));
      expect(adapter.sessionDoneAfterMs()).toBe(2_000);
    });

    it('is undefined for a record stamped before the connect decision (a quick swap)', async () => {
      const adapter = makeAdapter();
      await connectAt(adapter, STAMP + 1_000);
      adapter.parseNotification(RECORD);
      adapter.parseNotification(hex('f200'));
      expect(adapter.sessionDoneAfterMs()).toBeUndefined();
    });

    it('is undefined without a connect decision time', async () => {
      const adapter = makeAdapter();
      await connect(adapter);
      adapter.parseNotification(RECORD);
      adapter.parseNotification(hex('f200'));
      expect(adapter.sessionDoneAfterMs()).toBeUndefined();
    });

    it('is undefined once a live frame showed a weight', async () => {
      const adapter = makeAdapter();
      await connectAt(adapter, STAMP);
      adapter.parseNotification(RECORD);
      adapter.parseNotification(MEASURING);
      adapter.parseNotification(hex('f200'));
      expect(adapter.sessionDoneAfterMs()).toBeUndefined();
    });

    it('starts over on the next connect', async () => {
      const adapter = makeAdapter();
      await connectAt(adapter, STAMP);
      adapter.parseNotification(RECORD);
      adapter.parseNotification(hex('f200'));
      await connect(adapter);
      expect(adapter.sessionDoneAfterMs()).toBeUndefined();
    });
  });

  describe('stored-only sessions through waitForRawReading', () => {
    /** A live 0xCF frame as hex. */
    function live(kg: number, ohm = 0, status = 0x01): string {
      const buf = Buffer.alloc(11);
      buf[0] = 0xcf;
      buf.writeUInt16LE(Math.round(ohm * 10), 1);
      buf.writeUInt16LE(Math.round(kg * 100), 3);
      buf[8] = status === 0x00 ? 1 : 0;
      buf[9] = status;
      buf[10] = xorChecksum(buf, 0, 10);
      return buf.toString('hex');
    }
    /** Session start; the suite runs in UTC, so the scale's local clock reads the same. */
    const NOW = Date.UTC(2026, 2, 10, 7, 0, 0);
    /** A stored record of 71.30 kg / 455.5 ohm measured `offsetMs` from the session start. */
    function rec(offsetMs: number): string {
      const at = new Date(NOW + offsetMs);
      const buf = Buffer.concat([hex(live(71.3, 455.5, 0x00)), Buffer.alloc(7)]);
      buf[8] = 0;
      buf.writeUInt16BE(at.getUTCFullYear(), 11);
      buf[13] = at.getUTCMonth() + 1;
      buf[14] = at.getUTCDate();
      buf[15] = at.getUTCHours();
      buf[16] = at.getUTCMinutes();
      buf[17] = at.getUTCSeconds();
      buf[10] = xorChecksum(buf, 0, 10);
      return buf.toString('hex');
    }
    /** The scale drops the link up to ~30 s after the history dump; `f3 00` alone does not end it. */
    const trace = (steps: [number, string][]): Trace => ({
      provenance: 'derived',
      source: 'shaped on production T9146 session logs',
      disconnectAtMs: 30_000,
      steps: steps.map(([atMs, h]) => ({ atMs, dir: 'rx', hex: h })),
    });
    /** Connect decided 5 s before the session start, as the advert came in. */
    const opts = { now: NOW, connectDecidedAtMs: -5_000 };

    it('hands the just-stored weigh-in over 2 s after the marker', async () => {
      const r = await replaySession(
        makeAdapter(),
        trace([
          [400, rec(-3_000)],
          [500, 'f200'],
        ]),
        opts,
      );
      expect(r.settled).toEqual({ by: 'reading', atMs: 2_500 });
      expect(r.reading!.fromMemory).toBe(true);
      expect(r.writes.map((w) => w.hex)).toContain('f201');
    });

    it('waits through f3 00 for the final frame after an empty dump (production, mid-measurement connect)', async () => {
      const r = await replaySession(
        makeAdapter(),
        trace([
          [300, 'f200'],
          [2_250, 'f300'],
          [4_500, live(71.3, 455.5, 0x00)],
        ]),
        opts,
      );
      expect(r.settled).toEqual({ by: 'reading', atMs: 4_500 });
      expect(r.reading!.weight).toBe(71.3);
      expect(r.reading!.fromMemory).toBeUndefined();
    });

    it('waits for the final frame when the only stored record is an older weigh-in', async () => {
      const r = await replaySession(
        makeAdapter(),
        trace([
          [300, rec(-15_000)],
          [400, 'f200'],
          [2_800, live(71.3, 455.5, 0x00)],
        ]),
        opts,
      );
      expect(r.settled).toEqual({ by: 'reading', atMs: 2_800 });
      expect(r.history).toHaveLength(1);
    });

    it('keeps an empty-memory session open until the scale drops the link', async () => {
      const r = await replaySession(makeAdapter(), trace([[300, 'f200']]), opts);
      expect(r.settled).toEqual({
        by: 'error',
        atMs: 30_000,
        error: 'Scale disconnected before reading completed',
      });
    });

    it('waits for the live weigh-in when somebody steps on during the session', async () => {
      const r = await replaySession(
        makeAdapter(),
        trace([
          [0, live(20.8)],
          [100, rec(-3_000)],
          [400, live(20.8)],
          [450, 'f200'],
          [4_000, live(71.3)],
          [10_000, live(71.3, 455.5, 0x00)],
        ]),
        opts,
      );
      expect(r.settled).toEqual({ by: 'reading', atMs: 10_000 });
      expect(r.history).toHaveLength(1);
    });
  });

  describe('captured T9146 weigh-in through waitForRawReading', () => {
    const trace = t9146.traces['t9146-weigh-in'];
    const FINAL_AT_MS = trace.steps.at(-1)!.atMs;

    it('resolves on the impedance frame, before the hold runs out', async () => {
      const r = await replaySession(makeAdapter(), trace, t9146);
      expect(r.settled).toEqual({ by: 'reading', atMs: FINAL_AT_MS });
      expect(r.reading!.weight).toBe(85.3);
      expect(r.reading!.impedance).toBeCloseTo(426.0, 1);
      expect(r.reading!.timestamp).toBeUndefined();
    });

    it('hands over the nine stored records as history, oldest first', async () => {
      const r = await replaySession(makeAdapter(), trace, t9146);
      expect(r.history).toHaveLength(9);
      expect(r.history.every((h) => h.fromMemory === true)).toBe(true);
      expect(r.history[0].timestamp).toEqual(new Date(2026, 6, 4, 16, 7, 38));
      expect(r.history[8].timestamp).toEqual(new Date(2026, 6, 4, 17, 15, 45));
    });

    it('writes the clock sync, f2 00, then f2 01 after the end-of-history marker', async () => {
      const r = await replaySession(makeAdapter(), trace, t9146);
      const endOfHistoryAt = trace.steps.find((s) => s.hex === 'f200')!.atMs;
      expect(r.writes.map((w) => [w.hex, w.withResponse])).toEqual([
        ['f107ea0704111000', true],
        ['f200', true],
        ['f201', true],
      ]);
      expect(r.writes[2].atMs).toBe(endOfHistoryAt);
    });
  });

  describe('computeMetrics()', () => {
    it('runs BIA on the impedance of the captured final frame', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics(adapter.parseNotification(FINAL)!, profile);
      expect(payload.weight).toBe(85.3);
      assertPayloadRanges(payload);
      const bmiOnly = adapter.computeMetrics({ weight: 85.3, impedance: 0 }, profile);
      expect(payload.bodyFatPercent).not.toBe(bmiOnly.bodyFatPercent);
    });

    it('returns zero weight in payload for zero weight input', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 0, impedance: 0 }, profile);
      expect(payload.weight).toBe(0);
    });
  });
});

// ─── OneByoneNewAdapter ──────────────────────────────────────────────────────

describe('OneByoneNewAdapter', () => {
  function makeAdapter() {
    return new OneByoneNewAdapter();
  }

  describe('matches()', () => {
    it('matches "1byone scale" exact', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('1byone scale'))).toBe(true);
    });

    it('matches case-insensitive', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('1BYONE SCALE'))).toBe(true);
    });

    it('does not match "1byone" without " scale"', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('1byone'))).toBe(false);
    });

    it('does not match unrelated name', () => {
      const adapter = makeAdapter();
      expect(adapter.matches(mockPeripheral('Random Scale'))).toBe(false);
    });
  });

  describe('parseNotification()', () => {
    it('parses type 0x80 weight frame', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(6);
      buf[0] = 0xab;
      buf[1] = 0x2a;
      buf[2] = 0x80; // weight type
      // 24-bit BE at [3-5], mask 0x03FFFF / 1000
      // 80000 & 0x03FFFF = 80000, / 1000 = 80.0 kg
      const raw = 80000;
      buf[3] = (raw >> 16) & 0xff;
      buf[4] = (raw >> 8) & 0xff;
      buf[5] = raw & 0xff;

      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(80, 1);
    });

    it('parses type 0x01 impedance frame after weight', () => {
      const adapter = makeAdapter();

      // Weight first
      const wBuf = Buffer.alloc(6);
      wBuf[0] = 0xab;
      wBuf[1] = 0x2a;
      wBuf[2] = 0x80;
      const raw = 80000;
      wBuf[3] = (raw >> 16) & 0xff;
      wBuf[4] = (raw >> 8) & 0xff;
      wBuf[5] = raw & 0xff;
      adapter.parseNotification(wBuf);

      // Then impedance
      const iBuf = Buffer.alloc(6);
      iBuf[0] = 0xab;
      iBuf[1] = 0x2a;
      iBuf[2] = 0x01;
      iBuf.writeUInt16BE(500, 4); // impedance = 500

      const reading = adapter.parseNotification(iBuf);
      expect(reading).not.toBeNull();
      expect(reading!.impedance).toBe(500);
    });

    it('returns null for type 0x00 history frame', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(8);
      buf[0] = 0xab;
      buf[1] = 0x2a;
      buf[2] = 0x00;
      buf[7] = 0x80; // history marker
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for wrong header', () => {
      const adapter = makeAdapter();
      const buf = Buffer.alloc(6);
      buf[0] = 0xab;
      buf[1] = 0x2b; // wrong
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('returns null for too-short buffer', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(2))).toBeNull();
    });
  });

  describe('isComplete()', () => {
    it('returns true when weight > 0 and impedance > 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 80, impedance: 500 })).toBe(true);
    });

    it('returns false when weight is 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 0, impedance: 500 })).toBe(false);
    });

    it('completes a final weight without impedance after a short hold (D-07, D028)', () => {
      // The 0x80 final weight of a weigh-in the scale could not analyse (socks,
      // a child) is never followed by a 0x01 impedance frame. It used to be
      // refused for good, so the session timed out and the weight was lost.
      const adapter = makeAdapter();
      const wBuf = Buffer.alloc(6);
      wBuf[0] = 0xab;
      wBuf[1] = 0x2a;
      wBuf[2] = 0x80;
      const raw = 80000;
      wBuf[3] = (raw >> 16) & 0xff;
      wBuf[4] = (raw >> 8) & 0xff;
      wBuf[5] = raw & 0xff;
      const reading = adapter.parseNotification(wBuf)!;

      expect(adapter.isComplete(reading)).toBe(true);
      expect(adapter.isFinal!(reading)).toBe(false);
      expect(adapter.completionHoldMs).toBe(WEIGHT_ONLY_HOLD_MS);
    });

    it('resolves at once when the impedance frame arrives', () => {
      const adapter = makeAdapter();
      expect(adapter.isFinal!({ weight: 80, impedance: 500 })).toBe(true);
      expect(adapter.isComplete({ weight: 80, impedance: 500 })).toBe(true);
    });
  });

  describe('computeMetrics()', () => {
    it('returns valid BodyComposition', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 80, impedance: 500 }, profile);
      expect(payload.weight).toBe(80);
      assertPayloadRanges(payload);
    });

    it('returns zero weight in payload for zero weight input', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const payload = adapter.computeMetrics({ weight: 0, impedance: 0 }, profile);
      expect(payload.weight).toBe(0);
    });
  });
});

// #386: this adapter parses an impedance out of the scale's frames and used to
// hand buildPayload an empty comp, so the exported body fat was the Deurenberg
// BMI estimate and the impedance was published but ignored.
//
// At 80 kg / 183 cm / 30 / male the two answers are far apart, which is the
// point: 19.37 % from BMI alone, 25.06 % from a 500 ohm BIA reading.
describe('1byone / Eufy BIA from the parsed impedance (#386)', () => {
  const BMI_ONLY_FAT = 19.37;
  const BIA_FAT_AT_500 = 25.06;

  it('computes body fat from a plausible impedance instead of from BMI', () => {
    const payload = new OneByoneAdapter().computeMetrics(
      { weight: 80, impedance: 500 },
      defaultProfile(),
    );
    expect(payload.bodyFatPercent).toBeCloseTo(BIA_FAT_AT_500, 1);
    expect(payload.impedance).toBe(500);
  });

  it('moves every derived field with it, not just the fat percentage', () => {
    const payload = new OneByoneAdapter().computeMetrics(
      { weight: 80, impedance: 500 },
      defaultProfile(),
    );
    expect(payload.physiqueRating).toBe(2);
    expect(payload.visceralFat).toBe(12);
    expect(payload.waterPercent).toBeCloseTo(54.7, 2);
  });

  it('falls back to the BMI estimate when the impedance is not a body', () => {
    for (const impedance of [1, 149, 1201, 65535]) {
      const payload = new OneByoneAdapter().computeMetrics(
        { weight: 80, impedance },
        defaultProfile(),
      );
      expect(payload.bodyFatPercent).toBeCloseTo(BMI_ONLY_FAT, 1);
    }
  });

  it('still falls back when no impedance was measured at all', () => {
    const payload = new OneByoneAdapter().computeMetrics(
      { weight: 80, impedance: 0 },
      defaultProfile(),
    );
    expect(payload.bodyFatPercent).toBeCloseTo(BMI_ONLY_FAT, 1);
  });
});

// #386: this adapter parses an impedance out of the scale's frames and used to
// hand buildPayload an empty comp, so the exported body fat was the Deurenberg
// BMI estimate and the impedance was published but ignored.
//
// At 80 kg / 183 cm / 30 / male the two answers are far apart, which is the
// point: 19.37 % from BMI alone, 25.06 % from a 500 ohm BIA reading.
describe('1byone Scale (new protocol) BIA from the parsed impedance (#386)', () => {
  const BMI_ONLY_FAT = 19.37;
  const BIA_FAT_AT_500 = 25.06;

  it('computes body fat from a plausible impedance instead of from BMI', () => {
    const payload = new OneByoneNewAdapter().computeMetrics(
      { weight: 80, impedance: 500 },
      defaultProfile(),
    );
    expect(payload.bodyFatPercent).toBeCloseTo(BIA_FAT_AT_500, 1);
    expect(payload.impedance).toBe(500);
  });

  it('moves every derived field with it, not just the fat percentage', () => {
    const payload = new OneByoneNewAdapter().computeMetrics(
      { weight: 80, impedance: 500 },
      defaultProfile(),
    );
    expect(payload.physiqueRating).toBe(2);
    expect(payload.visceralFat).toBe(12);
    expect(payload.waterPercent).toBeCloseTo(54.7, 2);
  });

  it('falls back to the BMI estimate when the impedance is not a body', () => {
    for (const impedance of [1, 149, 1201, 65535]) {
      const payload = new OneByoneNewAdapter().computeMetrics(
        { weight: 80, impedance },
        defaultProfile(),
      );
      expect(payload.bodyFatPercent).toBeCloseTo(BMI_ONLY_FAT, 1);
    }
  });

  it('still falls back when no impedance was measured at all', () => {
    const payload = new OneByoneNewAdapter().computeMetrics(
      { weight: 80, impedance: 0 },
      defaultProfile(),
    );
    expect(payload.bodyFatPercent).toBeCloseTo(BMI_ONLY_FAT, 1);
  });
});

describe('1byone / Eufy: the 0.1 factor and the band (#386)', () => {
  it('refuses a 50 ohm reading, which is what raw 500 decodes to here', () => {
    // The capture's final frame carries raw 4260, 426.0 ohm, so the 0.1 holds
    // for a body. A raw 500 is not one and must not drive a body composition.
    const payload = new OneByoneAdapter().computeMetrics(
      { weight: 80, impedance: 50 },
      defaultProfile(),
    );
    expect(payload.bodyFatPercent).toBeCloseTo(19.37, 1);
    // The number is still published; it is only refused as a BIA input.
    expect(payload.impedance).toBe(50);
  });
});
