import { describe, it, expect } from 'vitest';
import { adapters } from '../../src/scales/index.js';
import { resolveAdapter } from '../../src/scales/resolve.js';
import { uuid16 } from '../../src/scales/body-comp-helpers.js';
import type { BleDeviceInfo } from '../../src/interfaces/scale-adapter.js';

describe('resolveAdapter', () => {
  // A spread of fixtures from registry-collision.test.ts; resolveAdapter MUST
  // agree with adapters.find((a) => a.matches(info)) for each.
  const fixtures: BleDeviceInfo[] = [
    { localName: 'eufy T9149', serviceUuids: [] },
    { localName: 'QN-Scale', serviceUuids: ['fff0'] },
    { localName: 'Fit Plus', serviceUuids: [uuid16(0xfff0), uuid16(0xae00)] },
    {
      localName: 'eufy T9146',
      serviceUuids: [uuid16(0xfff0)],
      characteristicUuids: [uuid16(0xfff1), uuid16(0xfff4)],
    },
    {
      localName: '000fatscale01',
      serviceUuids: [uuid16(0xfff0)],
      characteristicUuids: [uuid16(0xfff1), uuid16(0xfff2)],
    },
    { localName: 'BF720', serviceUuids: [uuid16(0x181b)] },
    { localName: 'MIBFS', serviceUuids: [] },
    { localName: 'GenericScale', serviceUuids: ['181d'] },
    { localName: 'icomon', serviceUuids: [] },
    { localName: 'Robi S9', serviceUuids: [] },
  ];

  it('agrees with adapters.find(matches) on every fixture', () => {
    for (const info of fixtures) {
      const viaFind = adapters.find((a) => a.matches(info));
      const viaResolve = resolveAdapter(info);
      expect(viaResolve?.name, `mismatch for ${info.localName}`).toBe(viaFind?.name);
    }
  });

  it('returns undefined when nothing matches', () => {
    expect(resolveAdapter({ localName: 'totally-unknown', serviceUuids: [] })).toBeUndefined();
  });

  it('selects strictly by priority, independent of registry array order', () => {
    const shuffled = [...adapters].reverse();
    const info: BleDeviceInfo = { localName: 'QN-Scale', serviceUuids: ['fff0'] };
    expect(resolveAdapter(info, shuffled)?.name).toBe(resolveAdapter(info, adapters)?.name);
  });
});
