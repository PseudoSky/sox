/**
 * stats-bl572-checkpoint-honesty.spec.ts — BL-572 regression coverage.
 *
 * ROOT CAUSE: DEBT-004/DEBT-005 (commit e77fb615) deleted memory-core's
 * private WAL checkpointing and handed idle-flush ownership entirely to the
 * store adapter's own `_armIdleFlush()`/`_checkWalCapAndFlush()` — with ZERO
 * callback surface back to memory-core. Pre-fix, `stats.ts` sourced
 * `last_checkpoint_at` exclusively from `WriteQueue.lastCheckpointAtForPath()`,
 * which is written ONLY by `WriteQueue.closeAllForShutdown()`. A long-lived
 * process that never shuts down its WriteQueue — the entire production
 * steady state — therefore reported `last_checkpoint_at: null` FOREVER, even
 * while the adapter was quietly keeping the WAL bounded and healthy. That is
 * worse than not having the field: an operator reading `null` during an
 * incident concludes checkpointing is broken and chases a fault that does
 * not exist.
 *
 * FIX (direction (b), pull/derive — see stats.ts): `last_checkpoint_at` is
 * now derived from the OBSERVED mtime of the main database file. In WAL mode,
 * ordinary writes land in the `-wal` file only — the main db file's mtime
 * advances ONLY when frames are written back to it, which is exactly what a
 * checkpoint (PASSIVE or TRUNCATE) does. This is a plain `fs.stat`, requires
 * no edit to the contended `turso-adapter.ts`/`sqlite-adapter.ts` files, and
 * captures checkpoint activity that happens entirely inside the adapter's own
 * idle-flush / wal-cap-flush machinery with no callback of any kind.
 *
 * This suite proves BOTH halves BL-225 requires:
 *   1. [RED before fix / GREEN after] A store that has been flushing (here,
 *      simulated by issuing a real `PRAGMA wal_checkpoint` directly — the
 *      same effect the adapter's own idle-flush timer produces, exercised
 *      without editing or mocking the adapter) reports a FRESH, non-null
 *      `last_checkpoint_at` — not the "never checkpointed" `null` the old
 *      WriteQueue-shutdown-only source would report for a process that never
 *      shut down.
 *   2. [honest negative] A store that has genuinely NOT flushed since data
 *      was written must NOT be reported as if it had — `last_checkpoint_at`
 *      must reflect a timestamp strictly BEFORE the unflushed writes, never
 *      "just now".
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { memoryGetStats } from './stats.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl572-checkpoint-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function insertRows(db: StoreAdapter, dbPath: string, count: number): Promise<void> {
  void dbPath;
  await db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
  for (let i = 0; i < count; i++) {
    await db.executeRun('INSERT INTO t (v) VALUES (?)', [`row-${i}-${'x'.repeat(200)}`]);
  }
}

describe('memoryGetStats last_checkpoint_at (BL-572)', () => {
  it('[BL-572 RED→GREEN] reports a fresh timestamp for a store that has been flushing, even though its WriteQueue never went through closeAllForShutdown()', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const dbPath = path.join(dir, 't.db');
      const db = await openDb(dbPath);

      // Simulate the production steady state: a long-lived process that has
      // taken real writes and had them flushed via the adapter's own
      // checkpoint machinery — WITHOUT ever calling
      // `WriteQueue.closeAllForShutdown()` (this store was never opened via
      // WriteQueue.forPath() at all, so `WriteQueue.lastCheckpointAtForPath`
      // for this path is unconditionally 0 — reproducing exactly the
      // "process never shut down" gap BL-572 reports).
      await insertRows(db, dbPath, 500);
      const walBeforeCheckpoint = fs.statSync(dbPath + '-wal').size;
      expect(walBeforeCheckpoint).toBeGreaterThan(0);

      const beforeCheckpointCall = Date.now();
      // The real effect of the adapter's idle-flush / wal-cap-flush timer —
      // issued directly via the adapter's own public query surface, not by
      // editing turso-adapter.ts/sqlite-adapter.ts.
      await db.executeRun('PRAGMA wal_checkpoint(TRUNCATE)');

      const result = await memoryGetStats(db, {}, ['memory_stats']);
      await db.close();

      expect(result.last_checkpoint_at).not.toBeNull();
      const reportedMs = Date.parse(result.last_checkpoint_at as string);
      expect(reportedMs).toBeGreaterThanOrEqual(beforeCheckpointCall - 1000); // fs mtime resolution slack
      expect(reportedMs).toBeLessThanOrEqual(Date.now());
    } finally {
      cleanup();
    }
  });

  it('[BL-572 honest negative] does not report a fresh timestamp for a store that has NOT flushed since its last write', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const dbPath = path.join(dir, 't.db');
      const db = await openDb(dbPath);

      await db.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
      // Baseline: whatever last touched the main db file (schema creation).
      const baselineMs = fs.statSync(dbPath).mtimeMs;

      // Sleep past filesystem mtime resolution so a false "just flushed"
      // read would be distinguishable from the baseline.
      await new Promise((r) => setTimeout(r, 1100));

      // Real writes — WAL mode means these land in `-wal` ONLY. No
      // checkpoint of any kind is issued after them. Deliberately tiny (a
      // handful of short rows): the adapter's own `_checkWalCapAndFlush`
      // (turso-adapter.ts) runs a REAL, automatic PASSIVE checkpoint inline
      // whenever the `-wal` file crosses `DEFAULT_WAL_CAP_BYTES` (256 KiB) —
      // exactly the mechanism this fix is meant to make visible. Staying far
      // below that cap here is what isolates the "genuinely never flushed"
      // case this test needs; a larger/longer write burst would trip that
      // cap and legitimately checkpoint, which is the OTHER test's scenario.
      for (let i = 0; i < 3; i++) {
        await db.executeRun('INSERT INTO t (v) VALUES (?)', [`row-${i}`]);
      }
      const walBytes = fs.statSync(dbPath + '-wal').size;
      expect(walBytes).toBeGreaterThan(0);
      expect(walBytes).toBeLessThan(262_144); // stayed under the wal-cap-flush trigger

      const mainDbMtimeAfterWrites = fs.statSync(dbPath).mtimeMs;
      // The load-bearing WAL-mode assumption this fix depends on: plain
      // writes must NOT touch the main db file at all.
      expect(mainDbMtimeAfterWrites).toBe(baselineMs);

      const beforeStatsCall = Date.now();
      const result = await memoryGetStats(db, {}, ['memory_stats']);
      await db.close();

      // Must NOT report a value close to "now" — that would be the exact
      // dishonesty BL-572 is about, one level down: claiming a flush that
      // never happened.
      if (result.last_checkpoint_at !== null) {
        const reportedMs = Date.parse(result.last_checkpoint_at as string);
        expect(reportedMs).toBeLessThan(beforeStatsCall - 500);
      }
    } finally {
      cleanup();
    }
  });
});
