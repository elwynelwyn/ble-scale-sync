# Sanitas SBF70 / BF710 Body Composition (#211) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decode impedance + fat/water/muscle/bone for Beurer BF710 / Sanitas SBF70/SBF75 by acknowledging each notify frame (so the scale streams its multipart `0x59` composition) and holding the GATT link open until that composition arrives.

**Architecture:** Two small generic capabilities on the `ScaleAdapter` seam, consumed in `waitForRawReading()`: (1) `buildAck(data)` lets an adapter emit a per-frame write-back; (2) `completionHoldMs` + `isFinal()` let an adapter say "weight is enough to resolve, but keep the link open a bit longer for a richer reading". The Beurer adapter then reassembles the `0x59` parts into the existing 16-byte big-endian composition layout.

**Tech Stack:** TypeScript (ES modules, strict), Vitest, node-ble / noble BLE handlers funnelling through `src/ble/shared.ts`.

**Protocol facts (verified from the issue-211 HCI snoop of the official app, cross-checked vs openScale `BeurerSanitasHandler.kt` and danielfaust `bt-scale/scale.py`):**

- Every notify (`0x1b`) is answered by a write (`0x12`) echoing bytes `[1..3]`:
  `ack = [0xE7, 0xF1, data[1], data[2], data[3]]` (write WITH response).
  Confirmed: `e7 58 01 06 86` -> `e7 f1 58 01 06`; `e7 59 03 01 ..` -> `e7 f1 59 03 01`.
- Composition arrives as `e7 59 <count> <part> <payload..>`. Part 1 = user-id (skip).
  Concatenating the payloads (offset 4) of parts `2..count` yields a buffer whose
  layout matches the existing BF700/800 frame: weight@4, impedance@6, fat@8,
  water@10, muscle@12, bone@14 (all uint16 BE; weight/bone x50/1000, the rest /10).
- Snoop bytes `...0687 01b5 00df 0209 018d 00e9...` decode to 83.55 kg / 437 / 22.3% /
  52.1% / 39.7% / 11.65 kg, all plausible and matching the reporter's ~83.5 kg.
- Without the per-frame ACK the scale halts after sending part 1 (all-zero), which is
  exactly the reporter's Pi capture. The ACK, not user registration, is the gate.

---

## File Structure

- `src/interfaces/scale-adapter.ts` (modify) — add `buildAck?`, `completionHoldMs?`, `isFinal?` to `ScaleAdapter`.
- `src/ble/shared.ts` (modify) — per-frame ACK write + completion-hold lifecycle in `waitForRawReading()`.
- `src/scales/beurer-sanitas.ts` (modify) — `0x59` reassembly, `buildAck`, `isFinal`, `completionHoldMs`, all-zero guard.
- `tests/scales/beurer-sanitas.test.ts` (modify) — adapter-level tests.
- `tests/ble/shared.test.ts` (modify) — handler-level ACK + hold tests.
- `README.md` + `docs/guide/supported-scales.md` (modify) — note SBF70/BF710 now report full composition.

---

## Task 1: Adapter interface additions

**Files:**

- Modify: `src/interfaces/scale-adapter.ts` (inside `interface ScaleAdapter`, after `parseServiceData?`)

- [ ] **Step 1: Add the three optional members to `ScaleAdapter`**

Insert immediately before the `matches(device: BleDeviceInfo): boolean;` line:

```ts
  /**
   * Build an immediate per-frame acknowledgement to write back to the write
   * characteristic after each notification. Some protocols gate multipart
   * streaming behind a per-frame echo (e.g. Beurer/Sanitas 0x59 composition).
   * The handler resolves the write char once and fires this write-and-forget
   * for every notify frame, including frames that `parseNotification` drops.
   * Return null to write nothing.
   */
  buildAck?(data: Buffer): Buffer | number[] | null;

  /**
   * When set, after `isComplete()` first returns true for a non-final reading
   * the handler keeps the GATT link open for up to this many milliseconds,
   * still feeding frames to the adapter, so a richer reading (e.g. bioimpedance
   * composition that the scale only sends a few seconds after the weight
   * settles) can arrive. On timeout the last complete reading resolves. Leave
   * unset for adapters that resolve immediately on a complete reading.
   */
  readonly completionHoldMs?: number;

  /**
   * Only consulted while `completionHoldMs` is set. Return true when the reading
   * is the rich/final one (e.g. carries composition) so the handler resolves
   * immediately instead of waiting out the hold window.
   */
  isFinal?(reading: ScaleReading): boolean;
```

- [ ] **Step 2: Type-check (no behavior yet, just confirm the interface compiles)**

Run: `npx tsc --noEmit`
Expected: PASS (no errors). Optional members do not break existing adapters.

- [ ] **Step 3: Commit**

```bash
git add src/interfaces/scale-adapter.ts
git commit -m "feat(ble): add buildAck/completionHoldMs/isFinal to ScaleAdapter (#211)"
```

---

## Task 2: BF710 / SBF70 multipart 0x59 decode + ACK in the adapter

**Files:**

- Modify: `src/scales/beurer-sanitas.ts`
- Test: `tests/scales/beurer-sanitas.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to `tests/scales/beurer-sanitas.test.ts` (after the existing `SBF70 / BF710 variant (issue #112)` block):

```ts
describe('SBF70 / BF710 0x59 composition stream (issue #211)', () => {
  function sbf70Adapter() {
    const adapter = makeAdapter();
    adapter.matches(mockPeripheral('SANITAS SBF70'));
    return adapter;
  }

  // Real frames captured from the official-app HCI snoop in issue #211.
  const PART1 = Buffer.from([
    0xe7, 0x59, 0x03, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x65,
  ]);
  const PART2 = Buffer.from([
    0xe7, 0x59, 0x03, 0x02, 0x6a, 0x21, 0xf4, 0xc6, 0x06, 0x87, 0x01, 0xb5, 0x00, 0xdf, 0x02,
  ]);
  const PART3 = Buffer.from([
    0xe7, 0x59, 0x03, 0x03, 0x09, 0x01, 0x8d, 0x00, 0xe9, 0x07, 0x17, 0x0a, 0xa2, 0x01, 0x08,
  ]);

  it('builds the per-frame ACK echoing bytes [1..3]', () => {
    const adapter = sbf70Adapter();
    expect(adapter.buildAck!(Buffer.from([0xe7, 0x58, 0x01, 0x06, 0x86]))).toEqual([
      0xe7, 0xf1, 0x58, 0x01, 0x06,
    ]);
    expect(adapter.buildAck!(PART3)).toEqual([0xe7, 0xf1, 0x59, 0x03, 0x03]);
  });

  it('does not ACK non-0xE7 frames', () => {
    const adapter = sbf70Adapter();
    expect(adapter.buildAck!(Buffer.from([0xf7, 0x58, 0x01, 0x08, 0x5e]))).toBeNull();
    expect(adapter.buildAck!(Buffer.from([0xe7]))).toBeNull();
  });

  it('returns null for part 1 and intermediate parts, reading on the last part', () => {
    const adapter = sbf70Adapter();
    expect(adapter.parseNotification(PART1)).toBeNull();
    expect(adapter.parseNotification(PART2)).toBeNull();
    const reading = adapter.parseNotification(PART3);
    expect(reading).not.toBeNull();
    expect(reading!.weight).toBeCloseTo(83.55, 2);
    expect(reading!.impedance).toBe(437);
  });

  it('exposes the decoded composition through computeMetrics', () => {
    const adapter = sbf70Adapter();
    adapter.parseNotification(PART1);
    adapter.parseNotification(PART2);
    const reading = adapter.parseNotification(PART3)!;
    const payload = adapter.computeMetrics(reading, defaultProfile());
    expect(payload.bodyFatPercent).toBeCloseTo(22.3, 1);
    expect(payload.waterPercent).toBeCloseTo(52.1, 1);
    assertPayloadRanges(payload);
  });

  it('isFinal is true for a composition reading, false for weight-only', () => {
    const adapter = sbf70Adapter();
    expect(adapter.isFinal!({ weight: 83.55, impedance: 437 })).toBe(true);
    expect(adapter.isFinal!({ weight: 83.45, impedance: 0 })).toBe(false);
  });

  it('completionHoldMs is set for BF710 type and unset for BF700/800', () => {
    const sbf70 = sbf70Adapter();
    expect(sbf70.completionHoldMs).toBeGreaterThan(0);
    const bf700 = makeAdapter();
    bf700.matches(mockPeripheral('bf-700'));
    expect(bf700.completionHoldMs).toBeUndefined();
  });

  it('treats an all-zero composition (unregistered) as weight-only', () => {
    const adapter = sbf70Adapter();
    const z2 = Buffer.from([
      0xe7, 0x59, 0x03, 0x02, 0x6a, 0x21, 0xf4, 0xc6, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    const z3 = Buffer.from([
      0xe7, 0x59, 0x03, 0x03, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(adapter.parseNotification(PART1)).toBeNull();
    expect(adapter.parseNotification(z2)).toBeNull();
    expect(adapter.parseNotification(z3)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/scales/beurer-sanitas.test.ts`
Expected: FAIL — `adapter.buildAck` / `adapter.isFinal` / `adapter.completionHoldMs` undefined, `parseNotification(PART3)` returns null.

- [ ] **Step 3: Implement the adapter changes**

In `src/scales/beurer-sanitas.ts`:

(a) After the existing `const BF710_STABILITY_TOLERANCE_KG = 0.3;` add:

```ts
// Snoop shows composition lands ~10-12 s after the weight first stabilizes;
// 15 s leaves margin without holding an unregistered scale's link too long.
const BF710_COMPOSITION_HOLD_MS = 15000;
```

(b) Add a parts buffer field next to `private cachedComp: CachedComp | null = null;`:

```ts
  /** Accumulated 0x59 composition parts (part number -> payload after byte 4). */
  private compParts = new Map<number, Buffer>();
```

(c) Add `buildAck`, `completionHoldMs`, `isFinal` members (place after the `unlockCommand` getter):

```ts
  /** Per-frame ACK echoing bytes [1..3]; BF710/SBF70 gate the 0x59 stream on it. */
  buildAck(data: Buffer): number[] | null {
    if (data.length >= 4 && data[0] === 0xe7) {
      return [0xe7, 0xf1, data[1], data[2], data[3]];
    }
    return null;
  }

  /** Hold the link for the bioimpedance step only on the BF710/SBF70 variant. */
  get completionHoldMs(): number | undefined {
    return this.isBf710Type ? BF710_COMPOSITION_HOLD_MS : undefined;
  }

  /** A reading carrying impedance is the final composition reading. */
  isFinal(reading: ScaleReading): boolean {
    return reading.impedance > 0;
  }
```

(d) Replace `parseBf710Notification` with the version that handles `0x59`:

```ts
  private parseBf710Notification(data: Buffer): ScaleReading | null {
    if (data.length < 2 || data[0] !== 0xe7) return null;

    const cmd = data[1];

    if (cmd === 0x58 && data.length >= 5) {
      const weight = (data.readUInt16BE(3) * 50) / 1000;
      if (weight <= 0 || weight > 300 || !Number.isFinite(weight)) return null;

      this.readingBuffer.push(weight);
      if (this.readingBuffer.length > BF710_STABILITY_COUNT) {
        this.readingBuffer.shift();
      }
      this.cachedComp = null;
      return { weight, impedance: 0 };
    }

    if (cmd === 0x59 && data.length >= 4) {
      return this.parseBf710Composition(data);
    }

    return null;
  }

  /**
   * Reassemble the multipart 0x59 composition stream.
   *
   * Frame: [0]=0xE7 [1]=0x59 [2]=count [3]=part [4..]=payload. Part 1 is the
   * user-identification frame (no measurement) so it is skipped. Parts 2..count
   * carry the payload; concatenated they form the same 16-byte big-endian
   * layout as the BF700/800 composition frame (weight@4, impedance@6, fat@8,
   * water@10, muscle@12, bone@14). The scale only advances this stream when each
   * frame is acknowledged (see buildAck); otherwise it stops after part 1. An
   * all-zero composition means an unregistered user, so it is treated as
   * weight-only.
   */
  private parseBf710Composition(data: Buffer): ScaleReading | null {
    const count = data[2];
    const part = data[3];

    if (part <= 1) {
      this.compParts.clear();
      return null;
    }

    this.compParts.set(part, Buffer.from(data.subarray(4)));
    if (part < count) return null;

    const ordered: Buffer[] = [];
    for (let p = 2; p <= count; p++) {
      const chunk = this.compParts.get(p);
      if (!chunk) {
        this.compParts.clear();
        return null;
      }
      ordered.push(chunk);
    }
    this.compParts.clear();

    const merged = Buffer.concat(ordered);
    if (merged.length < 16) return null;

    const weight = (merged.readUInt16BE(4) * 50) / 1000;
    const impedance = merged.readUInt16BE(6);
    const fat = merged.readUInt16BE(8) / 10;
    const water = merged.readUInt16BE(10) / 10;
    const muscle = merged.readUInt16BE(12) / 10;
    const bone = (merged.readUInt16BE(14) * 50) / 1000;

    if (impedance === 0 && fat === 0 && water === 0 && muscle === 0) {
      this.cachedComp = null;
      return null;
    }
    if (weight <= 0 || weight > 300 || !Number.isFinite(weight)) return null;

    this.cachedComp = { fat, water, muscle, bone };
    return { weight, impedance };
  }
```

(e) Update `isComplete` so a BF710 composition reading completes immediately:

```ts
  isComplete(reading: ScaleReading): boolean {
    if (this.isBf710Type) {
      if (reading.impedance > 0) return true;
      if (this.readingBuffer.length < BF710_STABILITY_COUNT) return false;
      const min = Math.min(...this.readingBuffer);
      const max = Math.max(...this.readingBuffer);
      return max - min <= BF710_STABILITY_TOLERANCE_KG && reading.weight > 0;
    }
    return reading.weight > 0;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/scales/beurer-sanitas.test.ts`
Expected: PASS (new block + all pre-existing tests, including the unregistered part-1 test).

- [ ] **Step 5: Commit**

```bash
git add src/scales/beurer-sanitas.ts tests/scales/beurer-sanitas.test.ts
git commit -m "feat(ble): decode BF710/SBF70 0x59 composition stream (#211)"
```

---

## Task 3: Per-frame ACK + completion hold in waitForRawReading()

**Files:**

- Modify: `src/ble/shared.ts` (inside `waitForRawReading`, lines ~314-408)
- Test: `tests/ble/shared.test.ts`

- [ ] **Step 1: Write the failing tests**

Add this `describe` block to `tests/ble/shared.test.ts` (after the `waitForRawReading() history collection` block). It reuses the existing `createMockChar`/`createMockDevice`/`createCharMap`/`createLegacyAdapter`/`PROFILE` helpers:

```ts
describe('waitForRawReading() — per-frame ACK + completion hold', () => {
  it('writes the buildAck result back for every notify frame', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      buildAck: vi.fn((data: Buffer) => [0xe7, 0xf1, data[1]]),
      parseNotification: vi.fn((data: Buffer) =>
        data[0] === 0x99 ? { weight: 75, impedance: 500 } : null,
      ),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    // A frame that parseNotification drops must still be ACKed.
    notifyChar.triggerData(Buffer.from([0xe7, 0x59, 0x03]));
    await vi.waitFor(() =>
      expect(writeChar.writtenData.some((b) => b.equals(Buffer.from([0xe7, 0xf1, 0x59])))).toBe(
        true,
      ),
    );

    notifyChar.triggerData(Buffer.from([0x99]));
    await promise;
  });

  it('holds the link open on a non-final complete reading, resolves on the later final one', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      completionHoldMs: 15000,
      isComplete: vi.fn((r: ScaleReading) => r.weight > 0),
      isFinal: vi.fn((r: ScaleReading) => r.impedance > 0),
      parseNotification: vi.fn((data: Buffer) =>
        data[0] === 0x02 ? { weight: 83.55, impedance: 437 } : { weight: 83.4, impedance: 0 },
      ),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    // Weight-only complete reading: must NOT resolve yet (link held).
    notifyChar.triggerData(Buffer.from([0x01]));
    const pending = await Promise.race([
      promise.then(() => 'resolved'),
      new Promise((r) => setTimeout(() => r('pending'), 50)),
    ]);
    expect(pending).toBe('pending');

    // Composition (final) reading: resolves immediately with impedance.
    notifyChar.triggerData(Buffer.from([0x02]));
    const result = await promise;
    expect(result.reading).toEqual({ weight: 83.55, impedance: 437 });
  });

  it('resolves with the last weight-only reading when the hold window elapses', async () => {
    vi.useFakeTimers();
    try {
      const notifyChar = createMockChar();
      const writeChar = createMockChar();
      const device = createMockDevice();
      const { charMap } = createCharMap([
        [NOTIFY_UUID, notifyChar],
        [WRITE_UUID, writeChar],
      ]);

      const adapter = createLegacyAdapter({
        completionHoldMs: 15000,
        isComplete: vi.fn((r: ScaleReading) => r.weight > 0),
        isFinal: vi.fn((r: ScaleReading) => r.impedance > 0),
        parseNotification: vi.fn(() => ({ weight: 83.4, impedance: 0 })),
      });

      const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
      // Flush the fire-and-forget subscribe microtask under fake timers
      // (vi.waitFor would not advance the faked clock — known footgun; the
      // documented fix is advanceTimersByTimeAsync, which flushes async timers).
      await vi.advanceTimersByTimeAsync(1);
      expect(notifyChar.subscribeCalled).toBe(true);

      notifyChar.triggerData(Buffer.from([0x01]));
      await vi.advanceTimersByTimeAsync(15000);

      const result = await promise;
      expect(result.reading).toEqual({ weight: 83.4, impedance: 0 });
    } finally {
      vi.useRealTimers();
    }
  });

  it('resolves with the held reading (not reject) on disconnect during the hold', async () => {
    const notifyChar = createMockChar();
    const writeChar = createMockChar();
    const device = createMockDevice();
    const { charMap } = createCharMap([
      [NOTIFY_UUID, notifyChar],
      [WRITE_UUID, writeChar],
    ]);

    const adapter = createLegacyAdapter({
      completionHoldMs: 15000,
      isComplete: vi.fn((r: ScaleReading) => r.weight > 0),
      isFinal: vi.fn((r: ScaleReading) => r.impedance > 0),
      parseNotification: vi.fn(() => ({ weight: 83.4, impedance: 0 })),
    });

    const promise = waitForRawReading(charMap, device, adapter, PROFILE, '');
    await vi.waitFor(() => expect(notifyChar.subscribeCalled).toBe(true));

    notifyChar.triggerData(Buffer.from([0x01]));
    device.triggerDisconnect();

    const result = await promise;
    expect(result.reading).toEqual({ weight: 83.4, impedance: 0 });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/ble/shared.test.ts`
Expected: FAIL — no ACK is written; the hold tests resolve/reject differently than asserted (resolves immediately on the weight-only frame; rejects on disconnect).

- [ ] **Step 3: Implement the handler changes in `src/ble/shared.ts`**

Inside `waitForRawReading`, after the line `let historyCapWarned = false;` add the hold/ACK state and helpers:

```ts
let holdTimer: ReturnType<typeof setTimeout> | null = null;
let heldReading: ScaleReading | null = null;
const clearHold = (): void => {
  if (holdTimer) {
    clearTimeout(holdTimer);
    holdTimer = null;
  }
};

const ackWriteChar =
  resolveChar(charMap, adapter.charWriteUuid) ??
  (adapter.altCharWriteUuid ? resolveChar(charMap, adapter.altCharWriteUuid) : undefined);

const finishWith = (r: ScaleReading): void => {
  resolved = true;
  clearHold();
  init.cleanup();
  process.stdout.write('\r' + ' '.repeat(80) + '\r');
  bleLog.info(`Reading complete: ${r.weight.toFixed(2)} kg / ${r.impedance} Ohm`);
  resolve({ reading: r, adapter, history: history.length > 0 ? history.slice() : undefined });
};
```

In `handleNotification`, right after the opening `if (resolved) return;`, add the ACK write:

```ts
if (adapter.buildAck && ackWriteChar) {
  const ack = adapter.buildAck(data);
  if (ack) {
    const ackBuf = Buffer.isBuffer(ack) ? ack : Buffer.from(ack);
    void ackWriteChar.write(ackBuf, true).catch((e: unknown) => {
      if (!resolved) bleLog.debug(`ACK write error: ${errMsg(e)}`);
    });
  }
}
```

Replace the existing live-frame completion block:

```ts
if (adapter.isComplete(reading)) {
  resolved = true;
  init.cleanup();
  process.stdout.write('\r' + ' '.repeat(80) + '\r');
  bleLog.info(`Reading complete: ${reading.weight.toFixed(2)} kg / ${reading.impedance} Ohm`);
  resolve({
    reading,
    adapter,
    history: history.length > 0 ? history.slice() : undefined,
  });
}
```

with:

```ts
if (adapter.isComplete(reading)) {
  const final = adapter.isFinal ? adapter.isFinal(reading) : true;
  if (adapter.completionHoldMs && !final) {
    heldReading = reading;
    if (!holdTimer) {
      bleLog.info(
        `Weight stable; holding connection up to ` +
          `${Math.round(adapter.completionHoldMs / 1000)}s for body composition...`,
      );
      holdTimer = setTimeout(() => {
        if (resolved) return;
        const r = heldReading;
        if (!r) return;
        finishWith(r);
      }, adapter.completionHoldMs);
    }
    return;
  }
  finishWith(reading);
}
```

In the `bleDevice.onDisconnect(...)` callback, add `clearHold()` and a held-reading graceful resolve. The callback becomes:

```ts
bleDevice.onDisconnect(() => {
  if (resolved) return;
  clearHold();
  if (history.length > 0) {
    resolved = true;
    init.cleanup();
    const latest = history.pop()!;
    process.stdout.write('\r' + ' '.repeat(80) + '\r');
    bleLog.info(
      `Disconnected after cache replay (${history.length + 1} historical reading(s)); ` +
        `no live frame.`,
    );
    resolve({
      reading: latest,
      adapter,
      history: history.length > 0 ? history.slice() : undefined,
    });
    return;
  }
  if (heldReading) {
    finishWith(heldReading);
    return;
  }
  init.cleanup();
  reject(new Error('Scale disconnected before reading completed'));
});
```

Note: `errMsg` and `bleLog` are already imported at the top of `shared.ts`; `resolveChar` is the module-private helper already defined in this file. No new imports needed.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/ble/shared.test.ts`
Expected: PASS (new block + all pre-existing shared tests unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/ble/shared.ts tests/ble/shared.test.ts
git commit -m "feat(ble): per-frame ACK and completion hold in waitForRawReading (#211)"
```

---

## Task 4: Docs

**Files:**

- Modify: `README.md`
- Modify: `docs/guide/supported-scales.md`

- [ ] **Step 1: Update the supported-scales doc**

Find the Beurer / Sanitas SBF70 row/entry in `docs/guide/supported-scales.md`. If it carries a "weight only" caveat for SBF70 / BF710, change it to indicate full body composition (impedance + fat / water / muscle / bone) is now read, with the note that the user must have stepped on long enough for the bioimpedance step to finish. (Exact wording follows the surrounding table/list style; do not invent a new format.)

- [ ] **Step 2: Update README.md**

Add a one-line note in the README's supported-scales / changelog-style section that Beurer BF710 and Sanitas SBF70/SBF75 now read full body composition (was weight only). Match the existing README phrasing; keep it to one line. (CLAUDE.md requires a README touch in every commit.)

- [ ] **Step 3: Commit**

```bash
git add README.md docs/guide/supported-scales.md
git commit -m "docs: BF710/SBF70 now read full body composition (#211)"
```

---

## Task 5: Full verification

- [ ] **Step 1: Kill node processes (Windows)**

Run (bash): `taskkill //F //IM node.exe`
Expected: success or "not found" — either is fine.

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: PASS, no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: PASS, no errors.

- [ ] **Step 4: Prettier**

Run: `npx prettier --check .`
Expected: PASS (all matched files use Prettier code style). If it fails, run `npx prettier --write .` on the touched files and re-check.

- [ ] **Step 5: Full test suite**

Run: `npm test`
Expected: PASS, all tests green (previous count + the new beurer-sanitas and shared cases).

---

## Out of scope

- BF700/800 (`0xF7`) ACK or hold: that family already decodes its 16-byte
  composition in a single frame and resolves fine; `buildAck` is gated to `0xE7`
  and `completionHoldMs` to the BF710 type, so BF700/800 is untouched.
- Replacing the periodic `e7 01` unlock with the official app's richer handshake.
  The Pi capture proved `e7 01` + per-frame ACK reaches the composition stream;
  the richer handshake is unnecessary for this fix.

## Verification note (no hardware)

No BLE scale is available in this environment. Correctness rests on: (1) the
decoded snoop values matching the reporter's real weigh-in (83.55 kg etc.), (2)
two independent field-tested references agreeing on the ACK rule and byte layout,
and (3) unit tests over both the adapter decode and the handler ACK/hold
lifecycle. The reporter (@snicket2100) confirms the final behavior on hardware
after the dev release.

## Self-Review

Folded in before implementation:

- **A. `init` referenced inside `finishWith` before its `const`.** Legal: `finishWith`
  is only ever _called_ from `handleNotification` / the hold timer / the disconnect
  handler, all of which run after `init` is assigned. The file already references
  `init.cleanup()` inside `handleNotification` the same way, so the pattern is proven.
- **B. Double-resolve guard.** Both the hold timer and the disconnect handler can
  fire. `finishWith` sets `resolved = true` first; the timer callback opens with
  `if (resolved) return;` and the disconnect handler opens with `if (resolved) return;`.
  No double resolve, no double cleanup.
- **C. `completionHoldMs` must be per-variant.** Implemented as a getter returning a
  value only when `isBf710Type`, so BF700/800 keeps resolving immediately. A plain
  readonly field would have held BF700/800 weight-only frames for 15 s — a regression.
- **D. ACK must fire for dropped frames.** The ACK block sits before the
  `if (!reading) return;` early-out, so part-1/part-2 `0x59` frames (which parse to
  null) are still acknowledged, which is what advances the stream.
- **E. `isFinal` consulted only under `completionHoldMs`.** The handler reads
  `adapter.isFinal` only inside `if (adapter.completionHoldMs && !final)`, so adapters
  without a hold never change behavior even if they happen to define `isFinal`.
- **F. All-zero composition guard returns null, not a zero reading.** Keeps the
  existing "unregistered user" contract (`tests/.../beurer-sanitas.test.ts` issue-112
  part-1 test still passes) and lets the hold window fall back to weight-only.
- **G. ACK write uses `withResponse = true`** to match the official app's ATT Write
  Request (`0x12`) seen in the snoop; the periodic unlock keeps its `withResponse = false`.

```

```
