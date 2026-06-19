import type { ScaleAdapter } from '../interfaces/scale-adapter.js';

/**
 * Broad legacy substrings the generic adapter excluded that have no shorter or
 * equal equivalent in any specific adapter's claims (the claims are precise:
 * e.g. Beurer claims 'beurer bf710', not the bare 'bf710'; Renpho ES-26BB
 * claims 'es-26bb-b', not 'es-26bb'; Hoffen claims 'hoffen bs-8107', not the
 * bare 'hoffen'). Applied as substring excludes, mirroring the pre-#245
 * `EXCLUDED` list, so a bare-branded device never falls to the generic parser.
 */
export const LEGACY_BROAD_EXCLUDES = [
  'es-26bb',
  '000fatscale',
  '042fatscale',
  'rt-libra',
  'bf710',
  'sbf70',
  'aicdscale',
  'hoffen',
];

/**
 * Names the generic StandardGattScaleAdapter must NOT match, derived from the
 * registry's claims with their ORIGINAL semantics preserved. Flattening every
 * claim into a substring check would over-exclude: e.g. MGB's `exact: ['yg']`
 * as a substring would wrongly reject a generic device named "MyGym". So an
 * `exact` claim excludes only a full-name match, `startsWith` only a prefix,
 * and `includes` (plus the legacy broad substrings) a substring.
 */
export interface GenericExcludes {
  exact: Set<string>;
  includes: string[];
  startsWith: string[];
}

/**
 * Build the exclusion set from the registry. Adapters with `priority === 0`
 * (the generic adapter itself) and any adapter lacking a `match` are skipped.
 * Adding an adapter automatically extends the exclusion set; no hand-maintained
 * exclusion list.
 */
export function genericExcludes(registry: readonly ScaleAdapter[]): GenericExcludes {
  const exact = new Set<string>();
  const includes: string[] = [...LEGACY_BROAD_EXCLUDES];
  const startsWith: string[] = [];
  for (const a of registry) {
    if (!a.match || a.match.priority === 0) continue; // skip generic / matchless
    const n = a.match.names;
    if (!n) continue;
    for (const t of n.exact ?? []) exact.add(t);
    for (const t of n.includes ?? []) includes.push(t);
    for (const t of n.startsWith ?? []) startsWith.push(t);
  }
  return { exact, includes, startsWith };
}

/** True if `name` (already lowercased) is excluded from the generic adapter. */
export function isExcludedName(name: string, ex: GenericExcludes): boolean {
  if (ex.exact.has(name)) return true;
  if (ex.includes.some((t) => name.includes(t))) return true;
  if (ex.startsWith.some((t) => name.startsWith(t))) return true;
  return false;
}

// The active registry, registered by index.ts once the adapter array is built.
// Using a provider (rather than importing `adapters` directly into
// standard-gatt.ts) keeps standard-gatt.ts out of an import cycle with index.ts.
let registryRef: readonly ScaleAdapter[] = [];
let cached: GenericExcludes | null = null;

/** Called by index.ts after the registry is assembled. */
export function registerExclusionRegistry(registry: readonly ScaleAdapter[]): void {
  registryRef = registry;
  cached = null;
}

/** Memoized exclusion set for the registered registry (empty until registered). */
export function getGenericExcludes(): GenericExcludes {
  if (cached === null) cached = genericExcludes(registryRef);
  return cached;
}

/** Convenience: true if the lowercased `name` is excluded from the generic adapter. */
export function isGenericExcludedName(name: string): boolean {
  return isExcludedName(name, getGenericExcludes());
}
