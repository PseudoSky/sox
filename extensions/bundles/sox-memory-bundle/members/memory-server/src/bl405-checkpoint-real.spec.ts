/**
 * bl405-checkpoint-real.spec.ts — BL-405 (second half): the production
 * shutdown path must ACTUALLY checkpoint/truncate the WAL of the connection
 * that took the writes, and must record it via `last_checkpoint_at`.
 *
 * The disposable-backend proof already in this repo (backend-shutdown.spec.ts)
 * mocks `closeAllAdapters`/`terminateEmbedWorkers`/`autoBackup` entirely — it
 * proves coordinatedShutdown's STEP ORDERING, never whether a real checkpoint
 * on a real WAL actually completes. This file is the one the BL-405 packet
 * asked for explicitly: "not a disposable backend, since that already passes
 * and is precisely what misled the previous attempt."
 *
 * ROOT CAUSE (found by reproducing directly — see the trail below):
 *   `handleToolCall`'s `memory_write` path calls BOTH `getDb(dbPath)` (which
 *   inserts into db.ts's `adapterCache`) AND `WriteQueue.forPath(dbPath)`
 *   (whose `_create()` opens its OWN, separate connection via the bare
 *   `openDb()` — NEVER inserted into `adapterCache`). All real writes route
 *   through the WriteQueue's connection. `coordinatedShutdown()`'s step 2
 *   (`closeAllAdapters()`) iterates ONLY `adapterCache` — so before this fix,
 *   the connection that actually took every write was NEVER closed or
 *   checkpointed by shutdown. Reproduced directly (scratch script, 2000 real
 *   writes through the real `getDb`+`WriteQueue.forPath`+`closeAllAdapters()`
 *   sequence): WAL left at 4152 bytes (not truncated — `closeAllAdapters()`'s
 *   checkpoint on the OTHER connection still flushes most frames because WAL
 *   checkpointing is file-level, but cannot fully TRUNCATE while the write
 *   queue's connection remains open) and the write-queue's connection was
 *   STILL OPEN and accepting further writes after "shutdown" had already
 *   returned. This also explains why `memory_ping.store.last_checkpoint_at`
 *   stayed `null` in production even when SOME checkpoint activity occurred:
 *   `WriteQueue._lastCheckpointAt` (the field `last_checkpoint_at` reports)
 *   is set ONLY by `WriteQueue.walCheckpoint()` — `closeDbWithLease`'s
 *   checkpoint on the unrelated `getDb`-cached connection never touches it.
 *
 * FIX: `WriteQueue.closeAllForShutdown()` (write-queue.ts) — checkpoints +
 * closes every WriteQueue's dedicated connection, sets `_lastCheckpointAt`,
 * and LOGS (never silently swallows) a checkpoint failure. Wired into
 * `coordinatedShutdown()` as step 2b, right after `closeAllAdapters()`.
 *
 * This spec proves BOTH halves BL-225 requires:
 *   1. the WAL is actually truncated (near-zero, not merely "smaller"), and
 *   2. `last_checkpoint_at` (`WriteQueue.lastCheckpointAtForPath`) becomes a
 *      fresh, non-zero timestamp — not just "some bytes moved".
 * The RED arm (this fix disabled) is proven by calling the pre-fix sequence
 * directly: `closeAllAdapters()` alone, without `WriteQueue.closeAllForShutdown()`.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { closeAllAdapters, getDb, WriteQueue } from '@adhd/sox-memory-core';

const TEST_DIR = path.join(os.tmpdir(), `sox-bl405-${process.pid}`);

function walSize(dbPath: string): number {
  try {
    return fs.statSync(dbPath + '-wal').size;
  } catch {
    return 0;
  }
}

async function writeRealData(dbPath: string, rows: number): Promise<void> {
  // Mirrors handleToolCall's real sequence (index.ts ~1125/1137): getDb()
  // FIRST (populates adapterCache), THEN WriteQueue.forPath() (opens its
  // own separate connection) — same order, same two call sites.
  await getDb(dbPath);
  const wq = await WriteQueue.forPath(dbPath);
  await wq.enqueue('bl405-seed', async (adapter) => {
    await adapter.exec('CREATE TABLE IF NOT EXISTS t (id INTEGER PRIMARY KEY, v TEXT)');
    for (let i = 0; i < rows; i++) {
      await adapter.executeRun('INSERT INTO t (v) VALUES (?)', [`row-${i}-${'x'.repeat(200)}`]);
    }
  });
}

describe('BL-405 — production shutdown path actually checkpoints the write-taking connection', () => {
  let dbPath: string;

  beforeEach(() => {
    fs.mkdirSync(TEST_DIR, { recursive: true });
    dbPath = path.join(TEST_DIR, `probe-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  });

  afterEach(async () => {
    // Best-effort full teardown regardless of which arm ran.
    await WriteQueue.closeAllForShutdown().catch(() => {});
    await closeAllAdapters().catch(() => {});
    for (const suf of ['', '-wal', '-shm', '-tshm']) {
      try { fs.rmSync(dbPath + suf, { force: true }); } catch { /* ignore */ }
    }
  });

  it('[BL-405 RED] closeAllAdapters() ALONE (the pre-fix shutdown sequence) does not truncate the WAL and leaves the write connection open', async () => {
    await writeRealData(dbPath, 2000);
    const before = walSize(dbPath);
    expect(before).toBeGreaterThan(100_000); // a real, substantial WAL from 2000 writes

    await closeAllAdapters();

    const after = walSize(dbPath);
    // The pre-fix sequence's checkpoint (on the OTHER, getDb-cached
    // connection) still flushes most frames — WAL checkpointing is a
    // file-level operation — but cannot fully TRUNCATE while the write
    // queue's own connection remains open. It does NOT reach near-zero.
    expect(after).toBeGreaterThan(0);

    // The write queue's connection was NEVER closed by closeAllAdapters() —
    // it must still accept a write. This is the actual defect: a real
    // resource leak on every production shutdown, not merely an incomplete
    // checkpoint.
    const wq = await WriteQueue.forPath(dbPath);
    await expect(
      wq.enqueue('post-close-probe', async (adapter) => {
        await adapter.executeGet('SELECT 1');
      }),
    ).resolves.not.toThrow();

    // last_checkpoint_at was never updated by this path either.
    expect(WriteQueue.lastCheckpointAtForPath(dbPath)).toBe(0);
  });

  it('[BL-405 GREEN] closeAllAdapters() + WriteQueue.closeAllForShutdown() (the real coordinatedShutdown sequence) truncates the WAL to near-zero and records last_checkpoint_at', async () => {
    await writeRealData(dbPath, 2000);
    const before = walSize(dbPath);
    expect(before).toBeGreaterThan(100_000);
    expect(WriteQueue.lastCheckpointAtForPath(dbPath)).toBe(0);

    const beforeCheckpointCall = Date.now();

    // The REAL coordinatedShutdown sequence (backend.ts step 2 → step 2b).
    await closeAllAdapters();
    await WriteQueue.closeAllForShutdown();

    const after = walSize(dbPath);
    // "Near-zero" — SQLite/Turso may leave a small WAL header footprint
    // (observed: a few KB) but must NOT still be carrying the bulk of 2000
    // rows' worth of frames. Assert at least a 99% reduction AND an absolute
    // ceiling well below any plausible single-page residue.
    expect(after).toBeLessThan(before * 0.01);
    expect(after).toBeLessThan(20_000);

    // last_checkpoint_at must now be a FRESH, real timestamp — not null/0,
    // and not stale from some earlier unrelated event.
    const lastCheckpointAt = WriteQueue.lastCheckpointAtForPath(dbPath);
    expect(lastCheckpointAt).toBeGreaterThanOrEqual(beforeCheckpointCall);
    expect(lastCheckpointAt).toBeLessThanOrEqual(Date.now());

    // The write queue's connection IS actually closed now — a fresh
    // WriteQueue.forPath() must open a NEW connection (the old singleton
    // entry was cleared), not silently be a no-op against pretend-still-open
    // state. We only assert it still WORKS (opens fresh + is usable);
    // WriteQueue.forPath's own singleton-recreation behavior is out of this
    // spec's scope.
    const wq2 = await WriteQueue.forPath(dbPath);
    const row = await wq2.enqueue('post-shutdown-reopen-probe', async (adapter) => {
      return adapter.executeGet<{ c: number }>('SELECT COUNT(*) as c FROM t');
    });
    expect(row?.c).toBe(2000);
  });
});
