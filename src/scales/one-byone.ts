import type {
  BleDeviceInfo,
  ConnectionContext,
  ScaleAdapterCore,
  GattWiring,
  HoldForComposition,
  Unlockable,
  ScaleReading,
  UserProfile,
  BodyComposition,
} from '../interfaces/scale-adapter.js';
import { uuid16, xorChecksum, WEIGHT_ONLY_HOLD_MS, biaPayload } from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';
import { bleLog } from '../ble/types.js';

/** Gap before each init write, as the EufyLife app paces its writes. */
const WRITE_PACING_MS = 500;

/**
 * Hold window (ms) for the impedance frame. The scale computes BIA once the
 * person steps off and sends it 5-7 s after the stable weight, then keeps the
 * link about 20 s in all. If it never comes (socks), the stable weight
 * resolves when the window elapses.
 */
const IMPEDANCE_HOLD_MS = 12_000;

const STATUS_FINAL = 0x00;
const STATUS_MEASURING = 0x01;
const STATUS_OVERWEIGHT = 0x02;

// ─── OneByoneAdapter (Eufy C1/P1, Health Scale) ─────────────────────────────

/**
 * One weigh-in's state, replaced in onConnected rather than onSessionStart.
 * Safe only for a legacy single-char adapter: shared.ts runs its subscribe and
 * onConnected under one Promise.all, so the synchronous prefix wins the race.
 */
class OneByoneSession {
  /** True when the last parsed frame was a settled live frame or a stored record. */
  frameSettled = false;
}

/**
 * The time a stored record was measured: bytes [11..17] yearBE(2) month day
 * hour minute second, on the scale's clock (local time, set by the clock
 * sync). Undefined when the date is not plausible.
 */
function recordTime(data: Buffer): Date | undefined {
  const year = data.readUInt16BE(11);
  const month = data[13];
  const day = data[14];
  if (year < 2000 || year > 2099 || month < 1 || month > 12 || day < 1 || day > 31) {
    return undefined;
  }
  return new Date(year, month - 1, day, data[15], data[16], data[17]);
}

/**
 * Adapter for Eufy C1/P1/A1 (T9146/T9147/T9120) and "Health Scale" branded
 * 1byone devices.
 *
 * Protocol from a btsnoop capture of the EufyLife Android app with a T9146
 * (tests/fixtures/onebyone/t9146.ts), cross-checked against the
 * bdr99/eufylife-ble-client implementation. Service 0xFFF0, notify 0xFFF4,
 * write 0xFFF1, every write with response. The scale streams as soon as the
 * CCCD is on; no command starts it.
 *
 * Commands (0xFFF1):
 *   f1 yearBE month day hour min sec  clock sync, local time  -> f1 00
 *   f2 00                             send stored records     -> 18-byte
 *                                     records, then f2 00
 *   f2 01                             ack of the f2 00 end marker, which
 *                                     clears the scale's memory -> f2 01
 * The app also writes `fd 00 01 00 00 00 00 00 00 00 fc`, which sets the
 * scale's display unit (it switched a kg display to lb), so it is not sent.
 * `f3 00` is the scale's own notice that it is about to sleep.
 *
 * 0xCF data frames, 11 bytes live and 18 bytes stored:
 *   [0]      0xCF
 *   [1..2]   impedance LE, x0.1 ohm, 0 when not measured
 *   [3..4]   weight LE, /100 kg
 *   [8]      1 once the live weight has settled (0 on stored records)
 *   [9]      status: 0x00 final, 0x01 measuring, 0x02 over the weight limit
 *   [10]     XOR of [0..9]
 *   [11..17] stored records only: when it was measured (recordTime)
 */
export class OneByoneAdapter implements ScaleAdapterCore, GattWiring, HoldForComposition {
  readonly name = '1byone (Eufy)';
  readonly match: MatchDescriptor = {
    priority: 91,
    custom: true,
    names: { includes: ['t9146', 't9147', 't9120', 'health scale'] },
    charUuids: ['fff4'],
  };
  readonly charNotifyUuid = uuid16(0xfff4);
  readonly charWriteUuid = uuid16(0xfff1);

  private s = new OneByoneSession();
  private ctx: ConnectionContext | null = null;

  matches(device: BleDeviceInfo): boolean {
    // Name match is unambiguous (T914x / Health Scale); keep it.
    const name = (device.localName || '').toLowerCase();
    if (this.match.names?.includes?.some((n) => name.includes(n))) return true;

    const chars = (device.characteristicUuids ?? []).map((u) => u.toLowerCase());
    if (chars.length === 0) return false;
    // Post-discovery: 0xFFF4 identifies the 1byone family, but the Eufy P2 also
    // exposes 0xFFF4 alongside 0xFFF2 + its auth char. A real 1byone C1/P1 uses
    // fff1 + fff4 and never fff2, so require fff4 WITHOUT fff2. This stops a
    // nameless Eufy P2 reaching an mqtt-proxy autonomous connect from being
    // driven with the wrong 1byone protocol (it falls through to its own
    // adapter via the notify-char fallback instead).
    return chars.includes(uuid16(0xfff4)) && !chars.includes(uuid16(0xfff2));
  }

  /** Clock sync, then the request for stored records, paced like the app. */
  async onConnected(ctx: ConnectionContext): Promise<void> {
    this.s = new OneByoneSession();
    this.ctx = ctx;

    await new Promise<void>((r) => setTimeout(r, WRITE_PACING_MS));
    const now = new Date();
    const clockCmd = [
      0xf1,
      (now.getFullYear() >> 8) & 0xff,
      now.getFullYear() & 0xff,
      now.getMonth() + 1,
      now.getDate(),
      now.getHours(),
      now.getMinutes(),
      now.getSeconds(),
    ];
    await ctx.write(this.charWriteUuid, clockCmd, true);

    await new Promise<void>((r) => setTimeout(r, WRITE_PACING_MS));
    await ctx.write(this.charWriteUuid, [0xf2, 0x00], true);
  }

  onSessionEnd(): void {
    this.ctx = null;
  }

  parseNotification(data: Buffer): ScaleReading | null {
    this.s.frameSettled = false;

    if (data.length === 2) {
      if (data[0] === 0xf2 && data[1] === 0x00) this.ackEndOfHistory();
      if (data[0] === 0xf3 && data[1] === 0x00) {
        bleLog.debug('1byone: the scale announced the end of the session (f3 00)');
      }
      return null;
    }

    if (data.length < 11 || data[0] !== 0xcf) return null;
    if (xorChecksum(data, 0, 10) !== data[10]) {
      bleLog.debug('1byone: dropping a 0xCF frame with a bad checksum');
      return null;
    }
    const status = data[9];
    if (status === STATUS_OVERWEIGHT) return null;

    const weight = data.readUInt16LE(3) / 100;
    const impedance = status === STATUS_MEASURING ? 0 : ((data[2] << 8) | data[1]) * 0.1;

    if (data.length >= 18) {
      const timestamp = recordTime(data);
      if (!timestamp) return null;
      this.s.frameSettled = true;
      return { weight, impedance, timestamp, fromMemory: true };
    }

    // The HA client takes status 0x00 alone as final; the capture also sets
    // [8] on every settled frame. Either one is enough.
    this.s.frameSettled = data[8] === 1 || status === STATUS_FINAL;
    return { weight, impedance };
  }

  /** A settled weight completes the reading; frames still measuring only feed the live display. */
  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && this.s.frameSettled;
  }

  readonly completionHoldMs = IMPEDANCE_HOLD_MS;

  /** The impedance comes in the last live frame, so it ends the hold at once. */
  isFinal(reading: ScaleReading): boolean {
    return reading.impedance > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // buildPayload does NOT run the BIA estimator: without a fat percentage it
    // falls back to the Deurenberg BMI estimate, so an adapter that parses an
    // impedance and then passes an empty comp publishes the impedance and
    // ignores it (#386). biaFatIfPlausible bounds the value first.
    return biaPayload(reading, profile);
  }

  /** Ack the end of the stored records like the app; the scale then clears them. */
  private ackEndOfHistory(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    void ctx.write(this.charWriteUuid, [0xf2, 0x01], true).catch((e: unknown) => {
      bleLog.warn(
        `1byone: the end-of-history ack failed, so the scale keeps its stored records ` +
          `and sends them again next time: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }
}

// ─── OneByoneNewAdapter (1byone scale — newer protocol) ─────────────────────

/** One weigh-in's state, replaced whole in onSessionStart (#394, SCALES.md). */
class OneByoneNewSession {
  cachedWeight = 0;
  cachedImpedance = 0;
}

/**
 * Adapter for the newer "1byone scale" branded device.
 *
 * Protocol: service 0xFFB0, notify 0xFFB2, write 0xFFB1.
 * All frames begin with [0xAB, 0x2A].
 *   Type at byte[2]:
 *     0x80 = final weight: bytes [3-5] 24-bit big-endian, mask 0x03FFFF, /1000 (kg).
 *     0x01 = impedance: bytes [4-5] big-endian uint16.
 *     0x00 with byte[7]=0x80 = history (ignored).
 */
export class OneByoneNewAdapter
  implements ScaleAdapterCore, GattWiring, Unlockable, HoldForComposition
{
  readonly name = '1byone Scale (new)';
  readonly match: MatchDescriptor = {
    priority: 60,
    names: { exact: ['1byone scale'] },
  };
  readonly charNotifyUuid = uuid16(0xffb2);
  readonly charWriteUuid = uuid16(0xffb1);
  readonly unlockCommand = [
    0xab, 0x2a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0xd7,
  ];
  readonly unlockIntervalMs = 0;

  private s = new OneByoneNewSession();

  onSessionStart(): void {
    this.s = new OneByoneNewSession();
  }

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
  }

  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 3 || data[0] !== 0xab || data[1] !== 0x2a) return null;

    const type = data[2];

    if (type === 0x80 && data.length >= 6) {
      // Final weight frame: 24-bit BE at [3-5], mask lower 18 bits
      const raw24 = (data[3] << 16) | (data[4] << 8) | data[5];
      this.s.cachedWeight = (raw24 & 0x03ffff) / 1000;
    } else if (type === 0x01 && data.length >= 6) {
      // Impedance frame: BE uint16 at [4-5]
      this.s.cachedImpedance = (data[4] << 8) | data[5];
    } else if (type === 0x00 && data.length >= 8 && data[7] === 0x80) {
      // History frame — ignored
      return null;
    }

    if (this.s.cachedWeight <= 0) return null;

    return { weight: this.s.cachedWeight, impedance: this.s.cachedImpedance };
  }

  /**
   * The 0x80 final weight completes the reading; the 0x01 impedance makes it
   * final (ADR D028, review D-07).
   *
   * Requiring the impedance here meant a weigh-in the scale could not analyse
   * (socks, a child), whose final weight is never followed by a 0x01 frame,
   * produced no reading at all: the session timed out and the weight was lost.
   * Now it holds the link for `WEIGHT_ONLY_HOLD_MS`, resolves at once when the
   * impedance arrives, and otherwise completes with the weight alone.
   */
  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0;
  }

  readonly completionHoldMs = WEIGHT_ONLY_HOLD_MS;

  isFinal(reading: ScaleReading): boolean {
    return reading.impedance > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    // buildPayload does NOT run the BIA estimator: without a fat percentage it
    // falls back to the Deurenberg BMI estimate, so an adapter that parses an
    // impedance and then passes an empty comp publishes the impedance and
    // ignores it (#386). biaFatIfPlausible bounds the value first, because the
    // scaling of this field has never been checked against a capture.
    return biaPayload(reading, profile);
  }
}
