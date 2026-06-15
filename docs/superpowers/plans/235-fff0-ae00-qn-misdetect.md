# Plan: #235 fff0+ae00 scale misidentified as Inlife instead of QN

## Problem

GE CS 10 G "Fit Plus" (MAC FF:07:00:0E:C7:4E) advertises both the fff0 cluster
(fff0/fff1/fff2) and the QN-specific AE00 cluster (ae00/ae01/ae02). It is a QN
protocol scale but resolves to the Inlife adapter, gets fff1/fff2, never receives
valid user data, and disconnects.

## Root cause (3 layers)

1. `QnScaleAdapter.matches()` (src/scales/qn-scale.ts:303) does not recognize the
   AE00 service. A named device whose name is not a QN brand fails `nameMatch`, and
   the UUID fallback is gated on `!name`, so a named device carrying ae00/fff0
   returns false.
2. `InlifeScaleAdapter.matches()` (src/scales/inlife.ts:41) greedily returns true
   for any device advertising fff0 when no characteristic list is supplied.
3. The noble post-connect matcher (src/ble/handler-noble.ts:497 and the identical
   src/ble/handler-noble-legacy.ts:497) builds `BleDeviceInfo` with only
   `localName` + `serviceUuids`, omitting `characteristicUuids` even though the
   characteristics are already discovered. So the #177 char-aware path is bypassed
   in MAC-target mode on noble. node-ble (scan.ts:214) already passes them.

Because QN is registry-ordered before Inlife, fixing layer 1 alone makes QN win.
`ae00`/`ae01`/`ae02` occur only in qn-scale.ts across all adapters, so they are an
unambiguous QN signal.

## Changes

### 1. src/scales/qn-scale.ts - recognize AE00 (fix A + char-aware C2)

Add module constant near the other SVC constants:
```js
const SVC_AE00 = 'ae00';
```

In `matches()`, after computing `uuids` (line 313, already lowercased) and after
the manufacturerData block, add a positive AE00 check that fires regardless of
name, BEFORE the name logic:
```js
// AE00 is a QN-only service (Renpho ES-CS20M / newer firmware), never shared
// with the fff0 Inlife/1byone/Eufy cluster. It positively identifies a QN
// scale even when the device also carries a non-QN name and advertises fff0
// (e.g. GE CS 10 G "Fit Plus", #235). Compare both the short 16-bit and the
// full 128-bit forms, mirroring the hasQnVendor check below: serviceUuids and
// characteristicUuids reach us as full normalizeUuid/uuid16 strings from real
// handlers, but short forms appear in some scan paths and tests.
const chars = (device.characteristicUuids || []).map((u) => u.toLowerCase());
const hasAe00 =
  uuids.some((u) => u === SVC_AE00 || u === uuid16(0xae00)) ||
  chars.some((u) => u === 'ae01' || u === 'ae02' || u === CHR_AE01 || u === CHR_AE02);
if (hasAe00) return true;
```
Note on UUID forms (verified): `uuid16(code)` returns the FULL 128-bit string
(`0000ae00...805f9b34fb`), and `normalizeUuid` produces the same full form for
16-bit UUIDs. `CHR_AE01`/`CHR_AE02` are already `uuid16(0xae01)`/`uuid16(0xae02)`,
so they cover the full form; the literal `'ae01'`/`'ae02'` cover the short form.

### 2. src/ble/handler-noble.ts - pass characteristicUuids post-connect (C1)

At the target-MAC match (line ~497), build the characteristic UUID list from the
already-discovered `services` and include it:
```js
const characteristicUuids = services.flatMap((s) =>
  (s.characteristics ?? []).map((c) => normalizeUuid(c.uuid)),
);
const info: BleDeviceInfo = { localName: name, serviceUuids, characteristicUuids };
```

### 3. src/ble/handler-noble-legacy.ts - same change (C1 parity)

Identical edit at the matching site (line ~497).

### 4. tests/scales/adapter-resolution.test.ts - regression tests (#235)

Add a `describe('adapter resolution (#235 fff0+ae00 QN/Inlife collision)')` block:
- "Fit Plus" with name + serviceUuids [1800,180f,180a,fff0,ae00] resolves to "QN Scale".
- Same device with serviceUuids [...,fff0] but ae01/ae02 only in characteristicUuids
  (no top-level ae00 service) still resolves to "QN Scale" (char-aware path).
- Negative guard: a plain Inlife (name 000fatscale01, fff0 + fff1/fff2, NO ae00)
  still resolves to "Inlife".
- Negative guard: a real QN device unaffected, e.g. unnamed fff0-only still QN
  (existing behavior) - optional, keep if cheap.

### 5. README.md - per project rule, update every commit

Add a one-line note under the supported-scales / changelog-ish area that the QN
adapter now also recognizes the AE00 service cluster (covers GE CS 10 G / Fit
Plus style dual-service scales). Keep minimal, no version bump (release-please
owns versions).

## Out of scope

- Inlife ae00 exclusion (layer 2 defensive): not needed since QN wins by registry
  order once it matches. Skip to keep change minimal.
- `force_adapter` config: separate enhancement, not a #235 fix.
- node-ble / proxy handlers: already char-aware (scan.ts:214). No change.

## Verification

- `npx vitest run tests/scales/adapter-resolution.test.ts` green (new + existing).
- Full `npm test`, `npm run lint`, `npx tsc --noEmit`, `npx prettier --check` clean.
- Kill node processes before npm: `taskkill //F //IM node.exe`.

## Commit

Conventional: `fix(ble): match QN scales advertising AE00 alongside fff0 (#235)`.
Push to dev.
