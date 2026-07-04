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
import {
  uuid16,
  buildPayload,
  computeBiaFat,
  xorChecksum,
  type ScaleBodyComp,
} from './body-comp-helpers.js';
import { matchesDescriptor, type MatchDescriptor } from './match-descriptor.js';
import { bleLog } from '../ble/types.js';

// ─── OneByoneAdapter (Eufy C1/P1, Health Scale) ─────────────────────────────

/** Resolve after `ms` milliseconds (no shared helper exists; qn-scale precedent). */
function delay(ms: number): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

/**
 * Adapter for Eufy C1/P1/A1 (T9146/T9147/T9120) and "Health Scale" branded
 * 1byone devices.
 *
 * Protocol reverse-engineered 2026-07-04 from a btsnoop capture of the
 * official EufyLife Android app talking to a real T9146. It DEVIATES from the
 * openScale OneByoneHandler port this adapter previously used: the 12-byte
 * `fd 37 ...` init command does not exist in this firmware's protocol, and the
 * real app issues every command as an ATT Write Request (with response).
 *
 * GATT: service 0xFFF0, notify 0xFFF4, write 0xFFF1. The scale streams live
 * weight immediately upon CCCD subscription — commands are not a streaming
 * trigger.
 *
 * Command set (write char 0xFFF1):
 *   The official app also sends a `fd 00 01 00 00 00 00 00 00 00 fc` config
 *       command on connect which we deliberately do NOT send: it sets the
 *       scale's display unit (verified live — it flips the display to lbs;
 *       the capture came from a fresh app install defaulting to lbs), and the
 *       HA eufylife-ble-client confirms no commands are required at all.
 *       Omitting it preserves the user's chosen display unit.
 *   `f1 yyyy(BE) MM dd HH mm ss`       — clock sync (local time) → `f1 00` ack.
 *   `f2 00`                            — request history dump → N 18-byte
 *       history frames, then a `f2 00` end-of-history marker, which we ack
 *       with `f2 01` (→ `f2 01` ack), mirroring the real app.
 *   `f3 00` is scale-initiated (session end / about-to-sleep notice ~12 s
 *       after the last data frame) — never written by the client.
 *
 * 0xCF data frames (11 B live, 18 B history):
 *   [0]      0xCF magic
 *   [1..2]   impedance raw LE; ohms = raw * 0.1; 0x0000 when not measured
 *   [3..4]   weight LE, kg = raw / 100
 *   [5..7]   unknown (nonzero only when impedance present)
 *   [8]      stable flag on live frames (1 = weight settled); 0 on history
 *   [9]      status byte: 0x00 = final/impedance-valid, 0x01 = measuring
 *            (no impedance), 0x02 = max weight exceeded
 *   [10]     XOR checksum of bytes [0..9]
 *   [11..17] history frames only: yearBE(2) month day hour minute second
 *
 * The impedance-bearing live frame arrives ~5-7 s AFTER the stable weight
 * frames (the scale computes BIA once the user steps off), so the link is
 * held open via completionHoldMs until it lands or the hold expires.
 *
 * Note: the scale also embeds the same 11-byte 0xCF frame in its
 * advertisement manufacturer data (MAC(6) + cfFrame(11) + battery(1) +
 * modelId(2)) — passive broadcast support is deliberately NOT implemented
 * here because defining parseBroadcast would make evaluateAdvertisement
 * gate an advertising T9146 to 'wait' instead of 'gatt', and the GATT path
 * (impedance + history) is the verified primary flow.
 */
export class OneByoneAdapter implements ScaleAdapterCore, GattWiring, HoldForComposition {
  readonly name = '1byone (Eufy)';
  readonly match: MatchDescriptor = {
    priority: 95,
    names: { includes: ['t9146', 't9147', 't9120', 'health scale'] },
    charUuids: ['fff4'],
  };
  readonly charNotifyUuid = uuid16(0xfff4);
  readonly charWriteUuid = uuid16(0xfff1);
  readonly normalizesWeight = true;

  /**
   * Final impedance frame arrives ~5-7 s after stable weight (scale computes
   * BIA after the user steps off); the capture shows the session stays open
   * ~20 s, so 12 s is comfortable headroom without overstaying.
   */
  readonly completionHoldMs = 12000;

  private ctx: ConnectionContext | null = null;
  /** True when the most recently parsed frame was a stable live frame or a history frame. */
  private lastFrameEligible = false;

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
  }

  /**
   * Init sequence based on the real EufyLife app (which enables CCCD, waits
   * ~320 ms, then paces its writes ~400-600 ms apart), minus the app's `fd`
   * config command (see class doc — it would overwrite the scale's display
   * unit). In this framework subscribe runs in parallel with onConnected, so
   * each step gets headroom.
   */
  async onConnected(ctx: ConnectionContext): Promise<void> {
    this.ctx = ctx;
    this.lastFrameEligible = false;

    await delay(500);
    // Clock sync (local time): f1 yearBE month day hour min sec.
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

    await delay(500);
    // Request history dump.
    await ctx.write(this.charWriteUuid, [0xf2, 0x00], true);
  }

  parseNotification(data: Buffer): ScaleReading | null {
    this.lastFrameEligible = false;

    if (data.length === 2) {
      if (data[0] === 0xf2 && data[1] === 0x00) {
        // End-of-history marker: ack with f2 01 like the real app (fire-and-forget).
        if (this.ctx) {
          void this.ctx.write(this.charWriteUuid, [0xf2, 0x01], true).catch((error: unknown) => {
            bleLog.debug(
              `1byone: failed to ack end-of-history (${error instanceof Error ? error.message : String(error)})`,
            );
          });
        }
        return null;
      }
      if (data[0] === 0xf3 && data[1] === 0x00) {
        bleLog.debug('1byone: scale announced session end (f3 00)');
      }
      // f1 00 (clock ack), f2 01 (history ack), f3 00 and anything else 2-byte.
      return null;
    }

    if (data.length < 11 || data[0] !== 0xcf) return null;

    if (xorChecksum(data, 0, 10) !== data[10]) {
      bleLog.debug('1byone: dropping 0xCF frame with bad XOR checksum');
      return null;
    }

    const fields = this.decodeCfFrame(data, 0);
    if (!fields) return null; // status 0x02: max weight exceeded

    const { weight, impedance } = fields;

    if (data.length >= 18) {
      // History frame: timestamp tail yearBE(2) month day hour minute second (local).
      const year = data.readUInt16BE(11);
      const month = data[13];
      const day = data[14];
      const valid =
        month >= 1 && month <= 12 && day >= 1 && day <= 31 && year >= 2000 && year <= 2099;
      if (!valid) return { weight, impedance };
      this.lastFrameEligible = true;
      const timestamp = new Date(year, month - 1, day, data[15], data[16], data[17]);
      return { weight, impedance, timestamp };
    }

    // Live 11-byte frame. Unstable frames are still returned for the live
    // console readout; completion is gated via isComplete on the frame being
    // trustworthy (see decodeCfFrame's `eligible`).
    this.lastFrameEligible = fields.eligible;
    return { weight, impedance };
  }

  /**
   * Decode the shared fields of a checksum-validated 0xCF frame starting at
   * `offset`. Returns null for the weight-limit-exceeded condition. Pure:
   * does not touch adapter state.
   */
  private decodeCfFrame(
    data: Buffer,
    offset: number,
  ): { weight: number; impedance: number; eligible: boolean } | null {
    // Status byte 0x02 = max weight exceeded (eufylife-ble-client semantics:
    // data[9]==0x02 → "max weight exceeded") — do not report a reading.
    if (data[offset + 9] === 0x02) return null;

    const weight = data.readUInt16LE(offset + 3) / 100;
    const rawImp = ((data[offset + 2] << 8) | data[offset + 1]) * 0.1;
    const impedance = data[offset + 9] === 1 || rawImp === 0 ? 0 : rawImp;

    // Belt-and-braces trustworthiness: byte [8] is the stable flag we observed
    // in the capture; byte [9]===0x00 is the finality signal the HA
    // eufylife-ble-client relies on. Either marks the frame trustworthy.
    const eligible = data[offset + 8] === 1 || data[offset + 9] === 0x00;
    return { weight, impedance, eligible };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && this.lastFrameEligible;
  }

  isFinal(reading: ScaleReading): boolean {
    // The impedance-bearing frame is the last live data frame; resolve the
    // completion hold immediately instead of waiting it out.
    return reading.impedance > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const fat =
      reading.impedance > 0 ? computeBiaFat(reading.weight, reading.impedance, profile) : undefined;
    return buildPayload(reading.weight, reading.impedance, { fat }, profile);
  }
}

// ─── OneByoneNewAdapter (1byone scale — newer protocol) ─────────────────────

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
export class OneByoneNewAdapter implements ScaleAdapterCore, GattWiring, Unlockable {
  readonly name = '1byone Scale (new)';
  readonly match: MatchDescriptor = {
    priority: 60,
    names: { exact: ['1byone scale'] },
  };
  readonly charNotifyUuid = uuid16(0xffb2);
  readonly charWriteUuid = uuid16(0xffb1);
  readonly normalizesWeight = true;
  readonly unlockCommand = [
    0xab, 0x2a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0xd7,
  ];
  readonly unlockIntervalMs = 0;

  private cachedWeight = 0;
  private cachedImpedance = 0;

  matches(device: BleDeviceInfo): boolean {
    return matchesDescriptor(device, this.match);
  }

  parseNotification(data: Buffer): ScaleReading | null {
    if (data.length < 3 || data[0] !== 0xab || data[1] !== 0x2a) return null;

    const type = data[2];

    if (type === 0x80 && data.length >= 6) {
      // Final weight frame: 24-bit BE at [3-5], mask lower 18 bits
      const raw24 = (data[3] << 16) | (data[4] << 8) | data[5];
      this.cachedWeight = (raw24 & 0x03ffff) / 1000;
    } else if (type === 0x01 && data.length >= 6) {
      // Impedance frame: BE uint16 at [4-5]
      this.cachedImpedance = (data[4] << 8) | data[5];
    } else if (type === 0x00 && data.length >= 8 && data[7] === 0x80) {
      // History frame — ignored
      return null;
    }

    if (this.cachedWeight <= 0) return null;

    return { weight: this.cachedWeight, impedance: this.cachedImpedance };
  }

  isComplete(reading: ScaleReading): boolean {
    return reading.weight > 0 && reading.impedance > 0;
  }

  computeMetrics(reading: ScaleReading, profile: UserProfile): BodyComposition {
    const comp: ScaleBodyComp = {};
    return buildPayload(reading.weight, reading.impedance, comp, profile);
  }
}
