import type { SessionFixture } from '../../helpers/replay/session.js';
import type { Trace } from '../../helpers/replay/trace.js';

/**
 * 1byone (Eufy C1/P1/A1, "Health Scale"): the F1 clock (local time) and the
 * F2 00 record request at connect, both with response, then 0xCF frames on
 * FFF4. A settled frame completes the reading and holds the link up to 12 s
 * for the frame carrying the impedance.
 *
 * Every trace is derived from the frames of the T9146 capture
 * (tests/fixtures/onebyone/t9146.ts), rearranged to pin one behaviour each.
 */

const MEASURING = 'cf00002a210000000001c5'; // 84.90 kg, status measuring
const SETTLED = 'cf000052210000000101bc'; // 85.30 kg, [8] settled, no impedance
const FINAL = 'cfa410522170751b010017'; // 85.30 kg, 426.0 ohm, status final

const traces: Record<string, Trace> = {
  // No impedance frame (socks): the hold resolves the settled weight.
  'eufy-stable-weight': {
    provenance: 'derived',
    source: 't9146.ts: one measuring and three settled frames, the impedance frame left out',
    steps: [
      { atMs: 500, dir: 'rx', hex: MEASURING },
      { atMs: 800, dir: 'rx', hex: SETTLED },
      { atMs: 1100, dir: 'rx', hex: SETTLED },
      { atMs: 1400, dir: 'rx', hex: SETTLED },
    ],
  },
  'eufy-impedance': {
    provenance: 'derived',
    source: 't9146.ts: a settled frame, then the impedance frame 5 s later',
    steps: [
      { atMs: 800, dir: 'rx', hex: SETTLED },
      { atMs: 5800, dir: 'rx', hex: FINAL },
    ],
  },
  // Nothing after the settled frame is usable, so the hold resolves it.
  'eufy-hold-expiry': {
    provenance: 'derived',
    source:
      't9146.ts: a settled frame, then the impedance frame with a bad checksum, with status ' +
      '0x02 (over the limit), cut short and with a wrong header',
    steps: [
      { atMs: 800, dir: 'rx', hex: SETTLED },
      { atMs: 2000, dir: 'rx', hex: 'cfa410522170751b0100e8' },
      { atMs: 2300, dir: 'rx', hex: 'cfa410522170751b010215' },
      { atMs: 2600, dir: 'rx', hex: 'cfa410522170' },
      { atMs: 2900, dir: 'rx', hex: 'cea410522170751b010017' },
    ],
  },
};

export const session: SessionFixture = {
  adapter: '1byone (Eufy)',
  traces,
};
