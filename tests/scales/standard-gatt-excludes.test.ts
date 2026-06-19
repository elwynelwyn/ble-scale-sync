import { describe, it, expect } from 'vitest';
import { adapters } from '../../src/scales/index.js';
import { genericExcludedNameTokens } from '../../src/scales/derived-excludes.js';

// The exact legacy EXCLUDED list that standard-gatt.ts carried before #245.
// Every one of these names MUST remain excluded from the generic adapter.
const LEGACY_EXCLUDED = [
  'qn-scale',
  'renpho',
  'senssun',
  'sencor',
  'yunmai',
  'mibcs',
  'mibfs',
  'mi_scale',
  'mi scale',
  'es-26bb',
  'es-cs20m',
  'es-32md',
  '113360_',
  'mengii',
  'yunchen',
  'vscale',
  'electronic scale',
  '1byone scale',
  'health scale',
  't9120',
  't9146',
  't9147',
  'ae bs-06',
  'hoffen',
  'swan',
  'icomon',
  'shape200',
  'shape100',
  'shape50',
  'style100',
  '01257b',
  '11257b',
  '000fatscale',
  '042fatscale',
  'bf-700',
  'bf-800',
  'rt-libra',
  'libra-b',
  'libra-w',
  'bf700',
  'bf710',
  'sbf70',
  'sbf72',
  'sbf73',
  'sbf75',
  'bf915',
  'aicdscale',
  '013197',
  '013198',
  '0202b6',
  '0203b',
];

describe('genericExcludedNameTokens (#245 EXCLUDED derivation)', () => {
  const tokens = genericExcludedNameTokens(adapters);

  it('keeps every legacy-excluded name excluded (substring containment)', () => {
    // A legacy token L is still excluded if some derived token T satisfies
    // L.includes(T) (the generic check is name.includes(token), so a shorter or
    // equal derived token still rejects any name containing the legacy token).
    const missing = LEGACY_EXCLUDED.filter((l) => !tokens.some((t) => l.includes(t)));
    expect(missing, `Legacy excluded names no longer excluded: ${missing.join(', ')}`).toEqual([]);
  });

  it('does not exclude a plain generic name', () => {
    expect(tokens.some((t) => 'genericscale'.includes(t))).toBe(false);
  });
});
