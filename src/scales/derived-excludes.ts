import type { ScaleAdapter } from '../interfaces/scale-adapter.js';
import { descriptorNameTokens } from './match-descriptor.js';

/**
 * Broad legacy substrings the generic adapter excluded that have no shorter or
 * equal equivalent in any specific adapter's claims (the claims are precise:
 * e.g. Beurer claims 'beurer bf710', not the bare 'bf710'; Renpho ES-26BB
 * claims 'es-26bb-b', not 'es-26bb'; Hoffen claims 'hoffen bs-8107', not the
 * bare 'hoffen'). Keeping these few tokens preserves the pre-#245 guarantee
 * that a bare-branded device never falls to the generic parser.
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
 * Name tokens the generic StandardGattScaleAdapter must NOT match: every name
 * token claimed by any other (non-generic) adapter that declares a `match`,
 * plus the legacy broad substrings above. Derived from the registry so adding
 * an adapter automatically extends the exclusion set; no hand-maintained
 * exclusion list. Adapters with `priority === 0` (the generic adapter) and any
 * adapter lacking a `match` are skipped.
 */
export function genericExcludedNameTokens(registry: readonly ScaleAdapter[]): string[] {
  const tokens = new Set<string>(LEGACY_BROAD_EXCLUDES);
  for (const a of registry) {
    if (!a.match || a.match.priority === 0) continue; // skip generic / matchless
    for (const t of descriptorNameTokens(a.match)) tokens.add(t);
  }
  return [...tokens];
}

// The active registry, registered by index.ts once the adapter array is built.
// Using a provider (rather than importing `adapters` directly into
// standard-gatt.ts) keeps standard-gatt.ts out of an import cycle with index.ts.
let registryRef: readonly ScaleAdapter[] = [];
let cachedTokens: string[] | null = null;

/** Called by index.ts after the registry is assembled. */
export function registerExclusionRegistry(registry: readonly ScaleAdapter[]): void {
  registryRef = registry;
  cachedTokens = null;
}

/** Memoized exclusion tokens for the registered registry (empty until registered). */
export function getGenericExcludedTokens(): string[] {
  if (cachedTokens === null) cachedTokens = genericExcludedNameTokens(registryRef);
  return cachedTokens;
}
