import type { BleDeviceInfo, ScaleAdapter } from '../interfaces/scale-adapter.js';
import { adapters as defaultRegistry } from './index.js';

/**
 * Select the adapter for a device. Candidates in the GIVEN registry are ordered
 * by descriptor `priority` (higher wins) rather than array position, then the
 * first whose `matches()` returns true is returned. A missing `match` defaults
 * to priority 0; `Array.prototype.sort` is STABLE in V8/Node, so adapters that
 * tie (e.g. mock lists in tests where none declare a `match`) keep their input
 * order, making this behaviorally identical to the old
 * `registry.find((a) => a.matches(info))`. This is the single precedence
 * authority that replaces the scattered `adapters.find(...)` calls.
 */
export function resolveAdapter(
  device: BleDeviceInfo,
  registry: readonly ScaleAdapter[] = defaultRegistry,
): ScaleAdapter | undefined {
  const prio = (a: ScaleAdapter): number => a.match?.priority ?? 0;
  const ordered = [...registry].sort((a, b) => prio(b) - prio(a));
  return ordered.find((a) => a.matches(device));
}
