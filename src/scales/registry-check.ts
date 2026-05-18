import type { ScaleAdapter } from '../interfaces/scale-adapter.js';
import { StandardGattScaleAdapter } from './standard-gatt.js';

/**
 * Structural integrity checks for the scale-adapter registry.
 *
 * These run at startup and do NOT need BLE fixtures — they assert the
 * invariants the registry array relies on for correct precedence:
 *
 *  - adapter names are unique (the name is used in logs and as the stable
 *    identifier in collision diagnostics);
 *  - the generic {@link StandardGattScaleAdapter} fallback is positioned last,
 *    so it never shadows a specific adapter via its broad BCS/WSS match.
 *
 * The fixture-based collision guard (one representative {@link
 * '../interfaces/scale-adapter.js'.BleDeviceInfo} per adapter, verifying
 * `adapters.find(matches)` resolves to the right adapter) lives in the test
 * suite — it needs a fixture corpus that is test data, not shipped code.
 */
export interface RegistryCheckResult {
  errors: string[];
  warnings: string[];
}

/** Run structural checks over an adapter registry. Pure — no throw, no log. */
export function checkRegistryIntegrity(adapters: readonly ScaleAdapter[]): RegistryCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Duplicate names: the name is the stable handle used everywhere a collision
  // or selection is reported, so duplicates make diagnostics ambiguous.
  const seen = new Map<string, number>();
  adapters.forEach((a, i) => {
    const prev = seen.get(a.name);
    if (prev !== undefined) {
      errors.push(`Duplicate adapter name "${a.name}" at registry indices ${prev} and ${i}.`);
    } else {
      seen.set(a.name, i);
    }
  });

  // The generic GATT adapter matches by bare Body Composition / Weight Scale
  // service UUID and brand-name substrings, so it overlaps many specific
  // adapters by design. Precedence (registry order) is the disambiguation
  // mechanism, which only holds if it stays last.
  const genericIdx = adapters.findIndex((a) => a instanceof StandardGattScaleAdapter);
  if (genericIdx === -1) {
    warnings.push(
      'No StandardGattScaleAdapter in registry — generic BCS/WSS scales will not be matched.',
    );
  } else if (genericIdx !== adapters.length - 1) {
    errors.push(
      `StandardGattScaleAdapter must be the last registry entry (it is a broad ` +
        `fallback); found at index ${genericIdx} of ${adapters.length - 1}. ` +
        `A specific adapter placed after it can be shadowed.`,
    );
  }

  return { errors, warnings };
}

/**
 * Assert the registry is structurally sound. Throws on `errors` so a bad
 * registry fails fast at process start (and in CI) rather than silently
 * mis-routing a scale in the field. `warnings` are returned for the caller
 * to log.
 */
export function assertRegistryIntegrity(adapters: readonly ScaleAdapter[]): string[] {
  const { errors, warnings } = checkRegistryIntegrity(adapters);
  if (errors.length > 0) {
    throw new Error(`Scale adapter registry integrity check failed:\n  - ${errors.join('\n  - ')}`);
  }
  return warnings;
}
