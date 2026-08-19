/**
 * BUG-022 — the UNGATED idle-flush strategy's `_performIdleFlush()` issued
 * its TRUNCATE via the PUBLIC, `_trackOp`-wrapped `executeGet()`.
 * `_trackOp()`'s `finally` unconditionally calls `_armIdleFlush()` once
 * `_inFlightOps` returns to 0 — so every ungated flush re-armed its OWN idle
 * timer via its own checkpoint call. With zero new caller activity, the
 * connection re-flushed itself forever: a self-perpetuating loop that never
 * quiesces (measured pre-fix: 65 `idle_flush` events for a burst of only 8
 * real writes, and `_idleFlushTimer` never settled to `null` even after
 * 670ms of pure idle waiting).
 *
 * CONTRAST WITH GATED (the production default, unaffected —
 * `idle-flush-adaptive.bl590.spec.ts` covers it): `releaseIdleConnection()`
 * sets `_released = true`, and `_armIdleFlush()`'s own guard
 * (`if (this.closed || this._released) return;`) refuses to re-arm
 * afterward — a fired GATED flush stays fired until the next real caller op
 * reconnects. This suite exercises UNGATED only.
 *
 * THE FIX: `_performIdleFlush()`'s ungated branch now calls `this.db.get(...)`
 * directly instead of `this.executeGet(...)`, bypassing `_trackOp()` (and
 * therefore its unconditional re-arm) entirely. Checkpoint semantics are
 * otherwise unchanged.
 *
 * BL-225: this suite asserts the OUTCOME — the loop TERMINATES. Counting
 * events alone is weak (a merely slower loop would still pass a raw count
 * assertion); the load-bearing assertion is QUIESCENCE: after a bounded
 * burst of real writes, `_idleFlushTimer` settles to `null` and STAYS `null`
 * across a polling window with zero new flush events, proving nothing is
 * re-arming itself.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { log } from '@adhd/sox-telemetry';

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
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-idle-flush-ungated-bug022-'));
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Priv = {
  _idleFlushTimer: ReturnType<typeof setTimeout> | null;
};

tursoDescribe('BUG-022 — ungated idle-flush self-rearm loop terminates', () => {
  it(
    'a bounded burst of real writes against a fast-floor UNGATED connection fires a bounded number ' +
      'of idle_flush events and settles the timer to null during pure idle — it must NOT re-arm ' +
      'itself forever. This assertion FAILS against pre-fix code (the loop never quiesces) and ' +
      'PASSES against the fix (this.db.get bypasses _trackOp, so the flush never re-arms its own timer).',
    async () => {
      const FLOOR_MS = 25; // fast floor so the debounce fires quickly and repeatedly if it's going to loop
      const WRITES = 8;
      const dbPath = tempPath('ungated-self-rearm');

      const debugSpy = vi.spyOn(log, 'debug');
      debugSpy.mockClear();

      const a = await TursoAdapterImpl.connect({
        dbPath,
        idleFlushFloorMs: FLOOR_MS,
        idleFlushCeilingMs: FLOOR_MS, // pin the window flat — isolates the self-rearm loop from EWMA growth
        walFlushStrategy: 'ungated',
      });
      await a.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      debugSpy.mockClear(); // drop the DDL's own idle_flush noise — only the timed burst below counts

      // A real burst of caller writes — genuine `_trackOp(fn, true)` calls,
      // nothing poked. Fast enough that the debounce window (25ms) elapses
      // between most of them, so real idle_flush events fire mid-burst too
      // (this is what makes the pre-fix bug self-perpetuate: each one of
      // those flushes, on buggy code, re-arms itself independent of the
      // next real write).
      for (let i = 0; i < WRITES; i++) {
        await a.executeRun('INSERT INTO t (v) VALUES (?)', [`row-${i}`]);
        await sleep(FLOOR_MS * 2);
      }

      const countIdleFlushEvents = (): number =>
        debugSpy.mock.calls.filter((call) => call[0] === 'store_adapter.turso.idle_flush').length;

      // Let the connection go fully idle and watch what happens with ZERO
      // further caller activity. Poll repeatedly rather than a single fixed
      // wait — the load-bearing claim is that the event count STOPS
      // growing and the timer STOPS re-arming, not just that it's slow.
      const priv = a as unknown as Priv;
      const samples: Array<{ t: number; count: number; timerLive: boolean }> = [];
      const pollWindowMs = 800;
      const pollStepMs = 40;
      const deadline = Date.now() + pollWindowMs;
      while (Date.now() < deadline) {
        samples.push({
          t: Date.now(),
          count: countIdleFlushEvents(),
          timerLive: priv._idleFlushTimer !== null,
        });
        await sleep(pollStepMs);
      }

      // 1) Bounded event count. A self-perpetuating loop firing every
      // FLOOR_MS=25ms for pollWindowMs=800ms of pure idle alone would add
      // ~32 more events on top of whatever the burst itself produced. Allow
      // generous headroom for the burst's own legitimate flushes (at most
      // one per inter-write gap that exceeded the floor) plus scheduler
      // jitter, but a genuinely unbounded loop blows straight through it.
      const finalCount = countIdleFlushEvents();
      const maxLegitimateEvents = WRITES + 4; // burst-driven flushes + slack, never the self-rearm loop's growth
      expect(
        finalCount,
        `idle_flush fired ${finalCount} times for a burst of ${WRITES} writes plus ${pollWindowMs}ms of pure ` +
          `idle — a self-perpetuating loop would keep firing roughly once per ${FLOOR_MS}ms indefinitely ` +
          `(~${Math.floor(pollWindowMs / FLOOR_MS)} more events from idle alone)`,
      ).toBeLessThanOrEqual(maxLegitimateEvents);

      // 2) QUIESCENCE — the load-bearing assertion (BL-225: counting alone is
      // weak). Once the burst-driven flushes are done, both the event count
      // AND the timer state must go stable: no growth in count, and the
      // timer settles to (and stays) null across the back half of the poll
      // window. A merely-slower self-rearm loop would still show the timer
      // perpetually non-null (armed -> fires -> re-armed -> ...).
      const secondHalf = samples.filter((s) => s.t >= samples[0]!.t + pollWindowMs / 2);
      expect(secondHalf.length).toBeGreaterThan(0);
      const distinctCountsInSecondHalf = new Set(secondHalf.map((s) => s.count));
      expect(
        distinctCountsInSecondHalf.size,
        `idle_flush event count kept changing through the back half of a ${pollWindowMs}ms pure-idle window ` +
          `(samples: ${secondHalf.map((s) => s.count).join(',')}) — the loop never quiesced`,
      ).toBe(1);
      const timerEverLiveInSecondHalf = secondHalf.some((s) => s.timerLive);
      expect(
        timerEverLiveInSecondHalf,
        'the idle-flush timer must settle to (and stay) null once the burst is done and the store is ' +
          'genuinely idle — a live timer here means something is still re-arming itself with no new caller activity',
      ).toBe(false);

      // The connection must still be fully usable and durable after all
      // this — the fix must not have broken the actual checkpoint.
      const rows = await a.executeAll<{ c: number }>('SELECT count(*) AS c FROM t');
      expect(rows.rows[0]!.c).toBe(WRITES);

      await a.close();
    },
    5000,
  );
});
