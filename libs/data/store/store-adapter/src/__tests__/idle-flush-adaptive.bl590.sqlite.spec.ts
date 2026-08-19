/**
 * BL-590 — the idle-flush debounce window is now ADAPTIVE on `SqliteAdapterImpl`
 * too, not a flat `DEFAULT_IDLE_FLUSH_MS` (2000ms) constant. See
 * `idle-flush-adaptive.bl590.spec.ts` (the `TursoAdapterImpl` sibling of this
 * file) for the full BL-590 problem statement; this file pins the identical
 * fix ported to the sqlite adapter (`_armIdleFlush()`, same
 * `effectiveIdleFlushMs()` from wal-tuning.ts).
 *
 * SIMPLER than the Turso sibling: `SqliteAdapterImpl` has no gated
 * close/reopen ceremony at all (single-process, synchronous, no lease/
 * reconnect — see the design note above the class in sqlite-adapter.ts), so
 * there is no reconnect-bookkeeping noise to isolate from the write-cadence
 * measurement, and no ungated self-rearm risk (`_performIdleFlush()` here
 * calls `this.db.pragma(...)` DIRECTLY, never through the `_trackOp`-wrapped
 * public API — unlike `TursoAdapterImpl`'s ungated branch, see BUG-022 — the
 * graph item "idle-flush ungated strategy self-perpetuates", not a
 * bug014-plan-local number).
 *
 * BL-225: every assertion checks the OUTCOME (the real EWMA field tracked
 * from genuine writes, the real armed window computed from it, the real
 * timer firing at that window and not before) — never a proxy.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapterImpl } from '../sqlite-adapter.js';
import { effectiveIdleFlushMs } from '../wal-tuning.js';

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-idle-flush-adaptive-bl590-sqlite-'));
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

describe('BL-590 — SqliteAdapterImpl adaptive idle-flush debounce', () => {
  it(
    'a genuine write cadence is tracked into the real EWMA field via `_trackOp`, and the NEXT ' +
      'debounce window is armed from `effectiveIdleFlushMs()` using that observed cadence — not the ' +
      'flat floor — this is the assertion that FAILS against pre-BL-590 code, which always arms ' +
      '`_idleFlushMs` regardless of observed write cadence',
    async () => {
      const GAP_MS = 120;
      const WRITES = 5;
      const PHASE1_FLOOR_MS = GAP_MS * (WRITES + 5);

      const dbPath = tempPath('real-ewma-tracking');
      const a = new SqliteAdapterImpl(dbPath, { idleFlushFloorMs: PHASE1_FLOOR_MS });
      const priv = a as unknown as {
        _writeIntervalEwmaMs: number | null;
        _lastWriteAt: number | null;
        _lastArmedIdleFlushMs: number | null;
        _idleFlushMs: number;
        _idleFlushCeilingMs: number;
        _idleFlushTimer: unknown;
        _armIdleFlush: () => void;
        _cancelIdleFlush: () => void;
      };

      await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      // Reset the tracked history right before the timed burst — the DDL
      // above is itself a tracked write, and its near-zero gap to the first
      // real burst write is not the cadence under test.
      priv._writeIntervalEwmaMs = null;
      priv._lastWriteAt = null;

      // Phase 1 — GENUINE write cadence, real `_trackOp` code path.
      for (let i = 0; i < WRITES; i++) {
        await a.executeRun('INSERT INTO t (v) VALUES (?)', [`row-${i}`]);
        if (i < WRITES - 1) await sleep(GAP_MS);
      }

      const trackedEwma = priv._writeIntervalEwmaMs;
      expect(trackedEwma, 'the real write cadence must have been tracked into the EWMA field').not.toBeNull();
      expect(trackedEwma!).toBeGreaterThan(GAP_MS * 0.3);
      expect(trackedEwma!).toBeLessThan(GAP_MS * 2);
      expect(priv._idleFlushTimer, 'the debounce must still be pending — the floor was never reached').not.toBeNull();

      // Phase 2 — lower the floor and re-arm through the REAL private
      // `_armIdleFlush()` method. A pre-BL-590 flat-window implementation
      // would arm exactly the new floor; the fix must arm something larger,
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
      expect(armed).toBeGreaterThan(NEW_FLOOR_MS * 3);

      // Phase 3 — REAL timer behaviour. Not fired yet at the old flat floor.
      const midWaitMs = NEW_FLOOR_MS * 3;
      await sleep(midWaitMs);
      expect(
        priv._idleFlushTimer,
        'the debounce must still be pending well past the flat floor — the adaptive window governs',
      ).not.toBeNull();

      // Fires once the full armed window elapses.
      await waitUntil(() => priv._idleFlushTimer === null, Math.max(armed - midWaitMs, 0) + 500);

      const rows = await a.executeAll<{ c: number }>('SELECT count(*) AS c FROM t');
      expect(rows.rows[0]!.c).toBe(WRITES);

      await a.close();
    },
  );

  it('the ceiling actually bounds the armed window — a pathological cadence cannot defer flushing forever', async () => {
    const FLOOR_MS = 20;
    const CEILING_MS = 180;
    const dbPath = tempPath('ceiling-clamp');

    const a = new SqliteAdapterImpl(dbPath, { idleFlushFloorMs: FLOOR_MS, idleFlushCeilingMs: CEILING_MS });
    await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    await a.executeRun('INSERT INTO t (v) VALUES (?)', ['first']);

    (a as unknown as { _writeIntervalEwmaMs: number })._writeIntervalEwmaMs = 10_000_000;
    await a.executeRun('INSERT INTO t (v) VALUES (?)', ['second']);

    const armed = (a as unknown as { _lastArmedIdleFlushMs: number | null })._lastArmedIdleFlushMs;
    expect(armed, 'a window must have been armed after the write went idle').not.toBeNull();
    expect(armed, 'the armed window must be clamped to the ceiling, not the raw pathological EWMA*margin').toBe(
      CEILING_MS,
    );

    await a.close();
  });
});
