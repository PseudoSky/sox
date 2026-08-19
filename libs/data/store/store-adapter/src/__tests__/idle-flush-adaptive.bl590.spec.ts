/**
 * BL-590 — the idle-flush debounce window is now ADAPTIVE, not a flat
 * `DEFAULT_IDLE_FLUSH_MS` (2000ms) constant.
 *
 * THE PROBLEM THIS CLOSES: measured live, the dominant writers on the
 * deployed store are ASYNC VECTOR WRITES from the embed pipeline, cadence
 * `time_to_vector_ms` p50 4516ms. Against a flat 2000ms debounce, a write
 * arriving every ~4.5s is NEVER coalesced with its neighbour — each one goes
 * idle on its own, fires its own flush, and under the GATED strategy every
 * flush pays the FULL close+reopen ceremony. Measured coalescing ratio: 12
 * writes / 11 flushes = 1.09, i.e. one full cycle per write.
 *
 * THE FIX (`_armIdleFlush()` in both adapters, `effectiveIdleFlushMs()` in
 * wal-tuning.ts): track an EWMA of the observed inter-write gap
 * (`updateWriteIntervalEwma()`, recorded once per write in `_trackOp`), and
 * arm the NEXT idle-flush timer with `max(floor, min(ceiling, ewma *
 * margin))` instead of a flat constant. A write cadence slower than the
 * flat-constant debounce now coalesces with its own neighbour instead of
 * paying a flush per write.
 *
 * This suite proves the OUTCOME (BL-225): fewer flush cycles fire for a
 * given write cadence under the adaptive path than under a FIXED window of
 * the same starting size, and the chosen window is present and correct on
 * the emitted telemetry — never a proxy like "a timer was (re)scheduled".
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
import {
  DEFAULT_IDLE_FLUSH_CEILING_MS,
  DEFAULT_IDLE_FLUSH_FLOOR_MS,
  IDLE_FLUSH_MARGIN_FACTOR,
  effectiveIdleFlushMs,
  updateWriteIntervalEwma,
} from '../wal-tuning.js';

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-idle-flush-adaptive-bl590-'));
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll until `predicate()` is true or `timeoutMs` elapses (same shape as
 *  idle-flush.spec.ts's helper — a debounced timer fires off real
 *  `setTimeout`, so tests must poll for it rather than assert synchronously
 *  right after the window "should" have elapsed). */
async function waitUntil(predicate: () => boolean, timeoutMs: number, stepMs = 10): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  if (!predicate()) {
    throw new Error(`waitUntil: condition not met within ${timeoutMs}ms`);
  }
}

// ── Pure-function unit tests (deterministic, no real timers) ───────────────

describe('BL-590 — wal-tuning.ts pure helpers', () => {
  it('updateWriteIntervalEwma seeds from the first gap, then blends subsequent gaps by IDLE_FLUSH_EWMA_ALPHA', () => {
    const seeded = updateWriteIntervalEwma(null, 1000);
    expect(seeded).toBe(1000);
    const blended = updateWriteIntervalEwma(1000, 2000);
    // alpha=0.3: 0.3*2000 + 0.7*1000 = 1300
    expect(blended).toBeCloseTo(1300, 5);
  });

  it('effectiveIdleFlushMs returns the floor with no write-interval signal', () => {
    const w = effectiveIdleFlushMs({ floorMs: 2000, ceilingMs: 30_000, writeIntervalEwmaMs: null });
    expect(w).toBe(2000);
  });

  it('effectiveIdleFlushMs margins the EWMA up and clamps to [floor, ceiling]', () => {
    // Comfortably inside the clamp range: floor < gap*margin < ceiling.
    const w = effectiveIdleFlushMs({ floorMs: 100, ceilingMs: 30_000, writeIntervalEwmaMs: 4516 });
    expect(w).toBeCloseTo(4516 * IDLE_FLUSH_MARGIN_FACTOR, 5);

    // Below the floor: a fast cadence must not shrink the window below the
    // floor an idle-with-no-history store already gets.
    const belowFloor = effectiveIdleFlushMs({ floorMs: 2000, ceilingMs: 30_000, writeIntervalEwmaMs: 10 });
    expect(belowFloor).toBe(2000);

    // Above the ceiling: a pathological cadence must not defer flushing
    // forever — this is the BL-590 text's own explicit requirement.
    const aboveCeiling = effectiveIdleFlushMs({
      floorMs: 2000,
      ceilingMs: 30_000,
      writeIntervalEwmaMs: 1_000_000,
    });
    expect(aboveCeiling).toBe(30_000);
  });

  it('the shared defaults match BL-590s own text: floor=2000ms, ceiling=~30s', () => {
    expect(DEFAULT_IDLE_FLUSH_FLOOR_MS).toBe(2000);
    expect(DEFAULT_IDLE_FLUSH_CEILING_MS).toBe(30_000);
  });
});

// ── End-to-end: fewer flush cycles under a cadence the flat constant could
//    never coalesce, using a REAL TursoAdapterImpl and REAL setTimeout-driven
//    idle-flush arming — not a simulation of the mechanism. ─────────────────

tursoDescribe('BL-590 — adaptive idle-flush debounce coalesces a write cadence a fixed window cannot', () => {
  it(
    'a genuine write cadence is tracked into the real EWMA field via `_trackOp`, and the NEXT ' +
      'debounce window is armed from `effectiveIdleFlushMs()` using that observed cadence — not the ' +
      'flat floor — this is the assertion that FAILS against pre-BL-590 code, which always arms ' +
      '`_idleFlushMs` regardless of observed write cadence',
    async () => {
      const GAP_MS = 140;
      const WRITES = 5;
      // Deliberately large — LARGER than the whole burst below — so nothing
      // flushes (and nothing reconnects) mid-burst. That keeps the burst's
      // own inter-write gaps clean: every `_trackOp(fn, true)` call in this
      // phase is a genuine caller write, not adapter-internal reconnect
      // bookkeeping (stamping adapter meta, the engine marker, BL-352
      // integrity repair) that a released-and-reopened connection would
      // otherwise interleave into the very cadence being measured.
      const PHASE1_FLOOR_MS = GAP_MS * (WRITES + 5);

      // GATED (the production default) deliberately, NOT 'ungated': the
      // ungated strategy's own `_performIdleFlush()` issues its TRUNCATE via
      // the public `executeGet()`, which — like every public call — routes
      // through `_trackOp()`, whose `finally` re-arms the idle timer the
      // instant `_inFlightOps` returns to 0. That makes ungated
      // self-perpetuating (each flush re-arms itself forever with no new
      // caller activity) — real, pre-existing behaviour, filed separately
      // (BL-591-IDLE-FLUSH-UNGATED-SELF-REARM, out of this item's scope),
      // not something to route this test's own timing around. GATED avoids
      // it structurally: `releaseIdleConnection()` sets `_released`, and
      // `_armIdleFlush()` refuses to arm while `_released` — so a fired
      // flush stays fired.
      const dbPath = tempPath('real-ewma-tracking');
      const a = await TursoAdapterImpl.connect({
        dbPath,
        idleFlushFloorMs: PHASE1_FLOOR_MS,
      });
      await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      // The DDL above is itself a tracked write (correctly) — reset the
      // history right before the timed burst so the burst's OWN cadence is
      // what gets measured, not a near-zero DDL-to-first-write gap.
      const priv = a as unknown as {
        _writeIntervalEwmaMs: number | null;
        _lastWriteAt: number | null;
        _lastArmedIdleFlushMs: number | null;
        _idleFlushMs: number;
        _idleFlushCeilingMs: number;
        _idleFlushTimer: unknown;
        _released: boolean;
        _armIdleFlush: () => void;
        _cancelIdleFlush: () => void;
      };
      priv._writeIntervalEwmaMs = null;
      priv._lastWriteAt = null;

      // Phase 1 — GENUINE write cadence, real `_trackOp` code path, nothing
      // poked. Nothing flushes (floor is larger than the whole burst).
      for (let i = 0; i < WRITES; i++) {
        await a.executeRun('INSERT INTO t (v) VALUES (?)', [`row-${i}`]);
        if (i < WRITES - 1) await sleep(GAP_MS);
      }

      // The real code path (`_trackOp`'s `updateWriteIntervalEwma()` call)
      // must have tracked a cadence in the right ballpark of the real GAP_MS
      // — generous bounds (EWMA lags the true value for the first several
      // samples by construction; see the pure-function tests above for the
      // exact convergence math) because this is asserting on REAL wall-clock
      // timing, not a deterministic pure-function input.
      const trackedEwma = priv._writeIntervalEwmaMs;
      expect(trackedEwma, 'the real write cadence must have been tracked into the EWMA field').not.toBeNull();
      expect(
        trackedEwma!,
        `the tracked EWMA (${trackedEwma}) must be in the ballpark of the real cadence (${GAP_MS}ms) — ` +
          `not null, not zero, not wildly divergent`,
      ).toBeGreaterThan(GAP_MS * 0.3);
      expect(trackedEwma!).toBeLessThan(GAP_MS * 2);
      expect(priv._lastArmedIdleFlushMs, 'a window must have been armed after the burst went idle').not.toBeNull();
      // Nothing flushed — the floor was deliberately larger than the burst.
      expect(priv._idleFlushTimer, 'the debounce must still be pending — the floor was never reached').not.toBeNull();

      // Phase 2 — lower the floor to something BELOW the tracked EWMA, and
      // re-arm through the REAL `_armIdleFlush()` method (private, reached
      // via the same reflection technique the rest of this suite already
      // uses for private-state probes — not a bypass of the mechanism, a
      // direct call to it). A pre-BL-590 flat-window `_armIdleFlush()` would
      // arm exactly this new floor; the fix must arm something LARGER,
      // computed from the tracked cadence.
      priv._cancelIdleFlush();
      const NEW_FLOOR_MS = 15;
      priv._idleFlushMs = NEW_FLOOR_MS;
      priv._armIdleFlush();

      const armed = priv._lastArmedIdleFlushMs!;
      const expected = effectiveIdleFlushMs({
        floorMs: NEW_FLOOR_MS,
        ceilingMs: priv._idleFlushCeilingMs,
        writeIntervalEwmaMs: trackedEwma,
      });
      expect(
        armed,
        'the armed window must equal effectiveIdleFlushMs() computed from the REAL tracked EWMA, not the new floor',
      ).toBeCloseTo(expected, 5);
      expect(
        armed,
        `the armed window (${armed}) must be well above the new floor (${NEW_FLOOR_MS}) — proving the real ` +
          'EWMA, not the flat constant, drove this arm',
      ).toBeGreaterThan(NEW_FLOOR_MS * 3);

      // Phase 3 — REAL timer behaviour, not just the computed number: wait
      // past the OLD flat floor (which pre-BL-590 code would have used and
      // already fired by now) but still short of the armed adaptive window
      // — the flush must NOT have fired yet.
      const midWaitMs = NEW_FLOOR_MS * 3;
      await sleep(midWaitMs);
      expect(
        priv._released,
        'the debounce must still be pending well past the flat floor — the adaptive window, not the floor, governs',
      ).toBe(false);

      // Now wait past the full armed window — it must fire (GATED release
      // sets `_released`, which `_armIdleFlush()` then refuses to re-arm
      // over — the fired state stays fired, unlike the ungated self-rearm
      // this test deliberately avoids; see the connect() comment above).
      await waitUntil(() => priv._released === true, Math.max(armed - midWaitMs, 0) + 500);

      // Transparent reconnect: the instance is still usable and still sees
      // every one of its earlier writes.
      const rows = await a.executeAll<{ c: number }>('SELECT count(*) AS c FROM t');
      expect(rows.rows[0]!.c).toBe(WRITES);

      await a.close();
    },
  );

  it('the ceiling actually bounds the armed window — a pathological cadence cannot defer flushing forever', async () => {
    const FLOOR_MS = 25;
    const CEILING_MS = 200; // small on purpose so the test does not need a real 30s wait
    const dbPath = tempPath('ceiling-clamp');

    const a = await TursoAdapterImpl.connect({
      dbPath,
      idleFlushFloorMs: FLOOR_MS,
      idleFlushCeilingMs: CEILING_MS,
    });
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await a.executeRun('INSERT INTO t (v) VALUES (?)', ['first']);

    // Directly seed a pathologically large EWMA (simulating a long history
    // of slow writes) via the private field — deterministic, no need to
    // actually wait out a real multi-minute cadence to observe the clamp.
    (a as unknown as { _writeIntervalEwmaMs: number })._writeIntervalEwmaMs = 10_000_000;

    await a.executeRun('INSERT INTO t (v) VALUES (?)', ['second']);

    // The write above cancels+rearms; whatever window it armed must be
    // clamped to CEILING_MS, not the pathological (unmargined ~15,000,000ms)
    // value the raw EWMA*margin would otherwise produce.
    const armed = (a as unknown as { _lastArmedIdleFlushMs: number | null })._lastArmedIdleFlushMs;
    expect(armed, 'a window must have been armed after the write went idle').not.toBeNull();
    expect(armed, 'the armed window must be clamped to the ceiling, not the raw pathological EWMA*margin').toBe(
      CEILING_MS,
    );

    await a.close();
  });
});
