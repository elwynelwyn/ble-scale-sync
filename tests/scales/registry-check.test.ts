import { describe, it, expect } from 'vitest';
import { adapters } from '../../src/scales/index.js';
import {
  checkRegistryIntegrity,
  assertRegistryIntegrity,
} from '../../src/scales/registry-check.js';
import { StandardGattScaleAdapter } from '../../src/scales/standard-gatt.js';
import { QnScaleAdapter } from '../../src/scales/qn-scale.js';
import type { ScaleAdapter } from '../../src/interfaces/scale-adapter.js';

describe('registry-check structural guard (#182)', () => {
  it('the live registry passes with no errors', () => {
    const { errors, warnings } = checkRegistryIntegrity(adapters);
    expect(errors).toEqual([]);
    expect(warnings).toEqual([]);
    expect(assertRegistryIntegrity(adapters)).toEqual([]);
  });

  it('flags duplicate adapter names', () => {
    const dup: ScaleAdapter[] = [
      new QnScaleAdapter(),
      new QnScaleAdapter(),
      new StandardGattScaleAdapter(),
    ];
    const { errors } = checkRegistryIntegrity(dup);
    expect(errors.some((e) => e.includes('Duplicate adapter name') && e.includes('QN Scale'))).toBe(
      true,
    );
    expect(() => assertRegistryIntegrity(dup)).toThrow(/Duplicate adapter name/);
  });

  it('flags the generic StandardGatt adapter not being last', () => {
    const misordered: ScaleAdapter[] = [new StandardGattScaleAdapter(), new QnScaleAdapter()];
    const { errors } = checkRegistryIntegrity(misordered);
    expect(errors.some((e) => e.includes('must be the last registry entry'))).toBe(true);
    expect(() => assertRegistryIntegrity(misordered)).toThrow(/last registry entry/);
  });

  it('warns (does not throw) when no generic adapter is present', () => {
    const noGeneric: ScaleAdapter[] = [new QnScaleAdapter()];
    const { errors, warnings } = checkRegistryIntegrity(noGeneric);
    expect(errors).toEqual([]);
    expect(warnings.some((w) => w.includes('No StandardGattScaleAdapter'))).toBe(true);
    expect(assertRegistryIntegrity(noGeneric)).toHaveLength(1);
  });
});
