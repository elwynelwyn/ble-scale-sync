import type { SessionFixture } from '../../helpers/replay/session.js';
import type { Trace, TraceStep } from '../../helpers/replay/trace.js';

/**
 * Eufy Smart Scale C1 (T9146) weigh-in: every frame the scale notified on FFF4
 * in a btsnoop capture of the EufyLife Android app (2026-07-04), in order,
 * with the capture's spacing. Timed from the first notification, which the
 * scale sends as soon as the CCCD is on.
 *
 * Unstable then stable live weights, the `f1 00` ack of the app's clock sync,
 * nine 18-byte history records (the scale's memory, dumped on `f2 00`), the
 * `f2 00` end-of-history marker, the `f2 01` ack of the app's `f2 01`, more
 * stable frames, and about 5 s later the frame carrying the impedance.
 *
 * The scale stamps its records in local time; the session runs in UTC at the
 * capture's local time, which reads them the same.
 */

/** [gap since the previous frame in ms, hex]. */
const CAPTURED: readonly (readonly [number, string])[] = [
  [0, 'cf00002a210000000001c5'], // live 84.90 kg, measuring
  [251, 'cf000034210000000001db'], // live 85.00 kg, measuring
  [451, 'f100'], // clock sync ack
  [89, 'cf000052210000000101bc'], // live 85.30 kg, stable
  [210, 'cf000052210000000101bc'],
  [240, 'cf000052210000000101bc'],
  [150, 'cfb81052211d13cd0000d707ea0704100726'], // record 85.30 kg / 428.0 ohm, 16:07:38
  [1, 'cfa4105c215a54c10000c907ea0704100905'],
  [28, 'cfd6105221dad6d30000a507ea0704100938'],
  [1, 'cfd6105c21e5e70000007607ea0704100b3a'],
  [30, 'cf30115c21aca62a0000b307ea0704102e22'],
  [0, 'cfcc103e211b13c90000cd07ea0704110020'],
  [30, 'cf72103e211e13c300007c07ea070411003a'],
  [1, 'cfa4103e215f54d50000ba07ea070411010a'],
  [29, 'cfa41052211313a10000a907ea0704110f2d'], // record 85.30 kg / 426.0 ohm, 17:15:45
  [0, 'f200'], // end of history
  [151, 'f201'], // ack of the app's f2 01
  [89, 'cf000052210000000101bc'],
  [240, 'cf000052210000000101bc'],
  [240, 'cf000052210000000101bc'],
  [271, 'cf000052210000000101bc'],
  [210, 'cf000052210000000101bc'],
  [5001, 'cfa410522170751b010017'], // live 85.30 kg / 426.0 ohm, final
];

function steps(): TraceStep[] {
  let atMs = 0;
  return CAPTURED.map(([gap, hex]) => {
    atMs += gap;
    return { atMs, dir: 'rx', hex };
  });
}

const traces: Record<string, Trace> = {
  't9146-weigh-in': {
    provenance: 'captured',
    source: 'btsnoop capture of the EufyLife Android app with a T9146, 2026-07-04, FFF4 frames',
    steps: steps(),
  },
};

export const session: SessionFixture = {
  adapter: '1byone (Eufy)',
  now: Date.UTC(2026, 6, 4, 17, 16, 0),
  traces,
};
