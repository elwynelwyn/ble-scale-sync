import { describe, it, expect, vi } from 'vitest';
import { OneByoneAdapter, OneByoneNewAdapter } from '../../src/scales/one-byone.js';
import type { ConnectionContext } from '../../src/interfaces/scale-adapter.js';
import {
  mockPeripheral,
  defaultProfile,
  assertPayloadRanges,
} from '../helpers/scale-test-utils.js';
import { uuid16, xorChecksum } from '../../src/scales/body-comp-helpers.js';

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
  });

  function makeCtx(): { ctx: ConnectionContext; writeFn: ReturnType<typeof vi.fn> } {
    const writeFn = vi.fn().mockResolvedValue(undefined);
    const ctx: ConnectionContext = {
      write: writeFn,
      read: vi.fn(),
      subscribe: vi.fn(),
      profile: defaultProfile(),
      deviceAddress: '',
      availableChars: new Set<string>(),
    };
    return { ctx, writeFn };
  }

  /** Wire the adapter's stored ctx by running the full onConnected handshake under fake timers. */
  async function connect(adapter: OneByoneAdapter): Promise<ReturnType<typeof vi.fn>> {
    vi.useFakeTimers();
    const { ctx, writeFn } = makeCtx();
    const done = adapter.onConnected(ctx);
    await vi.advanceTimersByTimeAsync(1000);
    await done;
    vi.useRealTimers();
    writeFn.mockClear();
    return writeFn;
  }

  // Fixtures from the 2026-07-04 btsnoop capture of the official EufyLife
  // Android app with a real T9146 (see analysis/PROTOCOL-NOTES.md).
  const UNSTABLE_LIVE = Buffer.from('cf00002a210000000001c5', 'hex'); // 84.90 kg, imp invalid
  const STABLE_NO_IMP = Buffer.from('cf000052210000000101bc', 'hex'); // 85.30 kg stable, imp invalid
  const FINAL_WITH_IMP = Buffer.from('cfa410522170751b010017', 'hex'); // 85.30 kg stable + 426.0 Ω
  const HISTORY = Buffer.from('cfb81052211d13cd0000d707ea0704100726', 'hex'); // 85.30 kg, 428.0 Ω @ 2026-07-04 16:07:38

  /** Clone an 11-byte 0xCF frame, apply mutations, then recompute the XOR checksum. */
  function mutateFrame(base: Buffer, mutate: (buf: Buffer) => void): Buffer {
    const buf = Buffer.from(base);
    mutate(buf);
    buf[10] = xorChecksum(buf, 0, 10);
    return buf;
  }

  describe('onConnected()', () => {
    it('sends clock sync then history request — both with response, no config command', async () => {
      vi.useFakeTimers();
      // The clock-sync write fires after a single 500ms paced delay, and fake
      // timers advance the mocked clock, so start 500ms early to land the
      // write at exactly 2026-07-04 17:16:12.
      vi.setSystemTime(new Date(2026, 6, 4, 17, 16, 11, 500));
      try {
        const adapter = makeAdapter();
        const { ctx, writeFn } = makeCtx();

        const done = adapter.onConnected(ctx);
        await vi.advanceTimersByTimeAsync(1000);
        await done;

        expect(writeFn).toHaveBeenCalledTimes(2);

        // Call 1: clock sync (2026-07-04 17:16:12 → f1 07 ea 07 04 11 10 0c)
        const [charUuid1, data1, withResponse1] = writeFn.mock.calls[0];
        expect(charUuid1).toBe(adapter.charWriteUuid);
        expect(withResponse1).toBe(true);
        expect([...data1]).toEqual([0xf1, 0x07, 0xea, 0x07, 0x04, 0x11, 0x10, 0x0c]);

        // Call 2: history dump request
        const [charUuid2, data2, withResponse2] = writeFn.mock.calls[1];
        expect(charUuid2).toBe(adapter.charWriteUuid);
        expect(withResponse2).toBe(true);
        expect([...data2]).toEqual([0xf2, 0x00]);
      } finally {
        vi.useRealTimers();
      }
    });

    it('exposes a 12s completion hold for the late impedance frame', () => {
      expect(makeAdapter().completionHoldMs).toBe(12000);
    });
  });

  describe('parseNotification()', () => {
    it('parses an unstable live frame (weight only, not complete)', () => {
      const adapter = makeAdapter();
      const reading = adapter.parseNotification(UNSTABLE_LIVE);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(84.9, 2);
      expect(reading!.impedance).toBe(0);
      expect(reading!.timestamp).toBeUndefined();
      expect(adapter.isComplete(reading!)).toBe(false);
    });

    it('parses a stable no-impedance frame (complete but not final)', () => {
      const adapter = makeAdapter();
      const reading = adapter.parseNotification(STABLE_NO_IMP);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(85.3, 2);
      expect(reading!.impedance).toBe(0);
      expect(adapter.isComplete(reading!)).toBe(true);
      expect(adapter.isFinal(reading!)).toBe(false);
    });

    it('parses the final live frame with impedance (complete and final)', () => {
      const adapter = makeAdapter();
      const reading = adapter.parseNotification(FINAL_WITH_IMP);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(85.3, 2);
      expect(reading!.impedance).toBeCloseTo(426.0, 1);
      expect(adapter.isComplete(reading!)).toBe(true);
      expect(adapter.isFinal(reading!)).toBe(true);
    });

    it('parses an 18-byte history frame with local timestamp', () => {
      const adapter = makeAdapter();
      const reading = adapter.parseNotification(HISTORY);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(85.3, 2);
      expect(reading!.impedance).toBeCloseTo(428.0, 1);
      expect(reading!.timestamp).toEqual(new Date(2026, 6, 4, 16, 7, 38));
      expect(adapter.isComplete(reading!)).toBe(true);
    });

    it('drops the timestamp from a history frame with an implausible date', () => {
      const adapter = makeAdapter();
      const buf = Buffer.from(HISTORY);
      buf[13] = 0x0d; // month 13
      const reading = adapter.parseNotification(buf);
      expect(reading).not.toBeNull();
      expect(reading!.timestamp).toBeUndefined();
    });

    it('returns null for a 0xCF frame with a corrupted checksum', () => {
      const adapter = makeAdapter();
      const buf = Buffer.from(FINAL_WITH_IMP);
      buf[10] ^= 0xff; // flip checksum byte
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it.each(['f100', 'f201', 'f300'])('returns null for 2-byte protocol frame %s', (hex) => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.from(hex, 'hex'))).toBeNull();
    });

    it('acks the f2 00 end-of-history marker with exactly one f2 01 write', async () => {
      const adapter = makeAdapter();
      const writeFn = await connect(adapter);

      expect(adapter.parseNotification(Buffer.from('f200', 'hex'))).toBeNull();

      expect(writeFn).toHaveBeenCalledTimes(1);
      const [charUuid, data, withResponse] = writeFn.mock.calls[0];
      expect(charUuid).toBe(adapter.charWriteUuid);
      expect([...data]).toEqual([0xf2, 0x01]);
      expect(withResponse).toBe(true);
    });

    it('handles f2 00 without a connection context (no throw)', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.from('f200', 'hex'))).toBeNull();
    });

    it('returns null for short garbage', () => {
      const adapter = makeAdapter();
      expect(adapter.parseNotification(Buffer.alloc(0))).toBeNull();
      expect(adapter.parseNotification(Buffer.from([0xcf]))).toBeNull();
      expect(adapter.parseNotification(Buffer.alloc(4))).toBeNull();
    });

    it('returns null for wrong magic byte', () => {
      const adapter = makeAdapter();
      const buf = Buffer.from(FINAL_WITH_IMP);
      buf[0] = 0xce;
      expect(adapter.parseNotification(buf)).toBeNull();
    });

    it('re-evaluates completion eligibility per frame (stable then unstable)', () => {
      const adapter = makeAdapter();
      const stable = adapter.parseNotification(STABLE_NO_IMP)!;
      expect(adapter.isComplete(stable)).toBe(true);

      const unstable = adapter.parseNotification(UNSTABLE_LIVE)!;
      expect(adapter.isComplete(unstable)).toBe(false);
    });

    it('returns null for an overweight frame (status byte 0x02 = max weight exceeded)', () => {
      const adapter = makeAdapter();
      const overweight = mutateFrame(FINAL_WITH_IMP, (buf) => {
        buf[9] = 0x02;
      });
      expect(adapter.parseNotification(overweight)).toBeNull();
    });

    it('marks a live frame complete on status byte 0x00 even when the stable flag is unset', () => {
      const adapter = makeAdapter();
      // byte[8]=0 (stable flag off) but byte[9]=0x00 (finality signal the HA
      // eufylife-ble-client relies on) → still eligible for completion.
      const finalNoStableFlag = mutateFrame(FINAL_WITH_IMP, (buf) => {
        buf[8] = 0;
      });
      const reading = adapter.parseNotification(finalNoStableFlag);
      expect(reading).not.toBeNull();
      expect(reading!.weight).toBeCloseTo(85.3, 2);
      expect(adapter.isComplete(reading!)).toBe(true);
    });
  });

  describe('computeMetrics()', () => {
    it('uses the BIA impedance path for the final capture reading', () => {
      const adapter = makeAdapter();
      const profile = defaultProfile();
      const reading = adapter.parseNotification(FINAL_WITH_IMP)!;

      const payload = adapter.computeMetrics(reading, profile);
      expect(payload.weight).toBeCloseTo(85.3, 2);
      assertPayloadRanges(payload);

      // BIA path must differ from the BMI-only fallback (proves impedance is used).
      const fallback = adapter.computeMetrics({ weight: 85.3, impedance: 0 }, profile);
      expect(payload.bodyFatPercent).not.toBe(fallback.bodyFatPercent);
    });

    it('falls back to a valid BMI-based payload when impedance is 0', () => {
      const adapter = makeAdapter();
      const payload = adapter.computeMetrics({ weight: 85.3, impedance: 0 }, defaultProfile());
      expect(payload.weight).toBeCloseTo(85.3, 2);
      assertPayloadRanges(payload);
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

    it('returns false when impedance is 0', () => {
      const adapter = makeAdapter();
      expect(adapter.isComplete({ weight: 80, impedance: 0 })).toBe(false);
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
