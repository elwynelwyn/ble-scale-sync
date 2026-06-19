import { describe, it, expect } from 'vitest';
import { createCipheriv } from 'node:crypto';
import {
  XiaomiS800Adapter,
  decryptMiBeaconV5,
  macFrameOrderFromFrame,
  parseS800Object,
  S800_PID,
} from '../../src/scales/xiaomi-s800.js';

// SYNTHETIC test data only. No real bind key, no real weigh-in bytes.
const DUMMY_KEY = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
const MAC_FRAME = Buffer.from('aba18f47ae04', 'hex'); // arbitrary reversed MAC

// Build the 12-byte decrypted 0x4e16 object for a given weight (kg).
function weightObject(kg: number): Buffer {
  const raw = Math.round(kg * 100);
  const value = Buffer.from([0x90, 0, 0, 0x05, 0x2b, 0, 0, raw & 0xff, (raw >> 8) & 0xff]); // 9 bytes
  return Buffer.concat([Buffer.from([0x16, 0x4e, 0x09]), value]);
}

// Encrypt an object into a full FE95 frame (MAC-included variant, FC 0x5958).
function buildFrame(obj: Buffer, key: Buffer, macFrame: Buffer, cnt = 0x5b): Buffer {
  const fc = Buffer.from([0x58, 0x59]);
  const pid = Buffer.from([0xe2, 0x51]);
  const ext = Buffer.from([0x01, 0x00, 0x00]);
  const nonce = Buffer.concat([macFrame, Buffer.from([pid[0], pid[1], cnt]), ext]);
  const cipher = createCipheriv('aes-128-ccm', key, nonce, { authTagLength: 4 });
  cipher.setAAD(Buffer.from([0x11]), { plaintextLength: obj.length });
  const enc = Buffer.concat([cipher.update(obj), cipher.final()]);
  const mic = cipher.getAuthTag();
  return Buffer.concat([fc, pid, Buffer.from([cnt]), macFrame, enc, ext, mic]);
}

describe('parseS800Object', () => {
  it('reads weight from a 0x4e16 object', () => {
    expect(parseS800Object(weightObject(75))).toEqual({ weight: 75, impedance: 0 });
  });

  it('rejects an out-of-range trailing value', () => {
    // trailing uint16 = 0x0048 = 72 -> 0.72 kg, out of [10,250]
    const obj = Buffer.from([0x16, 0x4e, 0x09, 0x90, 0, 0, 0x05, 0x2b, 0, 0, 0x48, 0x00]);
    expect(parseS800Object(obj)).toBeNull();
  });

  it('ignores the idle 0x5201 object', () => {
    expect(parseS800Object(Buffer.from([0x01, 0x52, 0x01, 0x00]))).toBeNull();
  });
});

describe('decryptMiBeaconV5', () => {
  it('round-trips a synthetic encrypted frame', () => {
    const frame = buildFrame(weightObject(75), DUMMY_KEY, MAC_FRAME);
    const dec = decryptMiBeaconV5(frame, DUMMY_KEY, macFrameOrderFromFrame(frame)!);
    expect(dec).not.toBeNull();
    expect(parseS800Object(dec!)).toEqual({ weight: 75, impedance: 0 });
  });

  it('returns null on a wrong key (tag mismatch)', () => {
    const frame = buildFrame(weightObject(75), DUMMY_KEY, MAC_FRAME);
    const wrong = Buffer.alloc(16, 0xff);
    expect(decryptMiBeaconV5(frame, wrong, macFrameOrderFromFrame(frame)!)).toBeNull();
  });

  it('extracts the frame MAC only when FC marks it present', () => {
    const withMac = buildFrame(weightObject(75), DUMMY_KEY, MAC_FRAME);
    expect(macFrameOrderFromFrame(withMac)?.toString('hex')).toBe(MAC_FRAME.toString('hex'));
  });
});

describe('XiaomiS800Adapter', () => {
  const adapter = new XiaomiS800Adapter();

  it('matches an FE95 advertisement carrying the S800 product id', () => {
    const sd = Buffer.from([0x58, 0x59, 0xe2, 0x51, 0x5b, 0, 0, 0, 0, 0, 0]);
    expect(
      adapter.matches({
        localName: '',
        serviceUuids: [],
        serviceData: [{ uuid: 'fe95', data: sd }],
      }),
    ).toBe(true);
  });

  it('matches by the S800 advertised name', () => {
    expect(
      adapter.matches({ localName: 'Mijia Scale S800 A1AB', serviceUuids: [], serviceData: [] }),
    ).toBe(true);
  });

  it('does not match an unrelated device', () => {
    expect(
      adapter.matches({ localName: 'QN-Scale', serviceUuids: ['fff0'], serviceData: [] }),
    ).toBe(false);
  });

  it('decrypts a configured weigh-in advert into a weight reading', () => {
    const a = new XiaomiS800Adapter();
    a.configure({ bindKey: DUMMY_KEY.toString('hex') });
    const frame = buildFrame(weightObject(82.4), DUMMY_KEY, MAC_FRAME);
    expect(a.parseServiceData('fe95', frame)).toEqual({ weight: 82.4, impedance: 0 });
  });

  it('returns null when no bind key is configured', () => {
    const a = new XiaomiS800Adapter();
    const frame = buildFrame(weightObject(82.4), DUMMY_KEY, MAC_FRAME);
    expect(a.parseServiceData('fe95', frame)).toBeNull();
  });

  it('caches the MAC from a MAC-included frame to decrypt a MAC-omitted rich frame', () => {
    const a = new XiaomiS800Adapter();
    a.configure({ bindKey: DUMMY_KEY.toString('hex') });
    // Prime the cache with a MAC-included frame (idle object).
    const idle = buildFrame(Buffer.from([0x01, 0x52, 0x01, 0x00]), DUMMY_KEY, MAC_FRAME);
    expect(a.parseServiceData('fe95', idle)).toBeNull();
    // MAC-omitted rich frame (FC 0x5948): same key + nonce uses the cached MAC.
    const obj = weightObject(82.4);
    const ext = Buffer.from([0x01, 0x00, 0x00]);
    const cnt = 0x5c;
    const nonce = Buffer.concat([MAC_FRAME, Buffer.from([0xe2, 0x51, cnt]), ext]);
    const c = createCipheriv('aes-128-ccm', DUMMY_KEY, nonce, { authTagLength: 4 });
    c.setAAD(Buffer.from([0x11]), { plaintextLength: obj.length });
    const enc = Buffer.concat([c.update(obj), c.final()]);
    const rich = Buffer.concat([
      Buffer.from([0x48, 0x59, 0xe2, 0x51, cnt]),
      enc,
      ext,
      c.getAuthTag(),
    ]);
    expect(a.parseServiceData('fe95', rich)).toEqual({ weight: 82.4, impedance: 0 });
  });

  it('computes body composition from weight when impedance is 0', () => {
    const profile = { height: 174, age: 38, gender: 'male' as const, isAthlete: false };
    const comp = adapter.computeMetrics({ weight: 75, impedance: 0 }, profile);
    expect(comp.weight).toBe(75);
    expect(comp.bmi).toBeGreaterThan(20);
    expect(comp.bodyFatPercent).toBeGreaterThan(0);
  });

  it('exposes the S800 product id constant', () => {
    expect(S800_PID).toBe(0x51e2);
  });
});
