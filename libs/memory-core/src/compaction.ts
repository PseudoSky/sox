/**
 * compaction.ts — Scheduled ANALYZE/optimize + WAL checkpoint tick (HF-4, BL-133).
 *
 * Runs `PRAGMA optimize`, `ANALYZE`, and `wal_checkpoint(TRUNCATE)` on an idle cadence.
 *
 * Coordination with WriteQueue idle checkpoint (WP-5):
 *   The WriteQueue already schedules a deferred `wal_checkpoint(TRUNCATE)` after
 *   CHECKPOINT_IDLE_MS (2 s) of queue idle. The compaction tick is a LONGER-cadence
 *   pass (default 5 min) that also runs `PRAGMA optimize` + `ANALYZE` to keep the
 *   query planner fresh. They are complementary, not competing:
 *     - WriteQueue fires quickly (2 s idle) to keep WAL bounded between writes.
 *     - CompactionTick fires on a longer cadence to do heavier maintenance.
 *   The tick skips its WAL checkpoint if the WriteQueue checkpointed within the
 *   last CHECKPOINT_IDLE_MS window (via WriteQueue.lastCheckpointAtForPath), so
 *   the two paths do not double-fire in the same heartbeat.
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { WriteQueue } from './write-queue.js';

// ── Public types ──────────────────────────────────────────────────────────────

export interface CompactionOptions {
  /**
   * Interval in milliseconds between compaction ticks.
   * Default: 5 * 60 * 1000 (5 minutes).
   */
  intervalMs?: number;
  /**
   * Whether to run PRAGMA optimize before ANALYZE.
   * Default: true.
   */
  runOptimize?: boolean;
  /**
   * Structured logger. Defaults to a no-op.
   */
  log?: (...args: unknown[]) => void;
}

export interface CompactionResult {
  /** ISO timestamp of the compaction run. */
  runAt: string;
  /** True when PRAGMA optimize was executed. */
  optimized: boolean;
  /** True when ANALYZE was executed. */
  analyzed: boolean;
  /** True when wal_checkpoint(TRUNCATE) was executed (not skipped). */
  checkpointed: boolean;
  /**
   * Number of frames checkpointed (PRAGMA wal_checkpoint `checkpointed` column).
   * -1 when skipped, in error, or when the WAL has no frames (mode mismatch).
   * 0 is a valid result (WAL was already empty).
   */
  framesCheckpointed: number;
  /** Error message if anything failed; null on clean run. */
  error: string | null;
}

// ── CompactionTick ────────────────────────────────────────────────────────────

/**
 * Default compaction interval — 5 minutes.
 */
export const DEFAULT_COMPACTION_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Run a single compaction pass on the given database connection.
 *
 * This performs, in order:
 *   1. `PRAGMA optimize` (optional, default true) — hints SQLite to build query stats.
 *   2. `ANALYZE`                                  — updates table statistics for query planner.
 *   3. `wal_checkpoint(TRUNCATE)`                 — flush + truncate WAL to main DB file,
 *        unless the WriteQueue already checkpointed within the last CHECKPOINT_IDLE_MS window.
 *
 * Safe to call from any context — uses the SAME db connection passed in
 * (the caller must ensure no concurrent transaction is open on that connection).
 */
export async function runCompactionPass(
  adapter: StoreAdapter,
  opts: CompactionOptions = {},
): Promise<CompactionResult> {
  const {
    runOptimize = true,
    log = () => undefined,
  } = opts;

  const runAt = new Date().toISOString();
  let optimized = false;
  let analyzed = false;
  let checkpointed = false;
  let framesCheckpointed = -1;
  let error: string | null = null;

  const dbPath = adapter.config.dbPath ?? '';

  try {
    // 1. PRAGMA optimize — SQLite auto-chooses which tables need stats refresh.
    if (runOptimize) {
      await adapter.exec('PRAGMA optimize;');
      optimized = true;
      log('[compaction] PRAGMA optimize done');
    }

    // 2. ANALYZE — rebuild query planner statistics for all tables.
    await adapter.exec('ANALYZE;');
    analyzed = true;
    log('[compaction] ANALYZE done');

    // 3. WAL checkpoint — skip if WriteQueue already ran one very recently to avoid
    //    double-fire in the same heartbeat.
    const lastWqCkpt = WriteQueue.lastCheckpointAtForPath(dbPath);
    const msSinceWqCkpt = Date.now() - lastWqCkpt;
    const skipCheckpoint =
      lastWqCkpt > 0 && msSinceWqCkpt < WriteQueue.CHECKPOINT_IDLE_MS;

    if (skipCheckpoint) {
      log(
        `[compaction] WAL checkpoint skipped (WriteQueue ran ${msSinceWqCkpt} ms ago, < ${WriteQueue.CHECKPOINT_IDLE_MS} ms threshold)`,
      );
      framesCheckpointed = -1;
    } else {
      const row = await adapter.executeGet<{ busy: number; log: number; checkpointed: number }>(
        'PRAGMA wal_checkpoint(TRUNCATE)',
      );
      framesCheckpointed =
        row && typeof row.checkpointed === 'number'
          ? row.checkpointed
          : -1;
      checkpointed = true;
      log(`[compaction] WAL checkpoint done (frames=${framesCheckpointed}, log=${row?.log ?? -1}, busy=${row?.busy ?? -1})`);
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err ?? 'unknown');
    log(`[compaction] ERROR: ${error}`);
  }

  return { runAt, optimized, analyzed, checkpointed, framesCheckpointed, error };
}

/**
 * Start a recurring compaction ticker that calls runCompactionPass periodically.
 *
 * Returns a stop function — call it to cancel the timer.
 * The timer is unref'd so it never prevents Node.js from exiting.
 *
 * @param db         A live write-connection to the store.
 * @param opts       Compaction options including intervalMs.
 * @returns          stop function.
 */
export function startCompactionTick(
  adapter: StoreAdapter,
  opts: CompactionOptions = {},
): () => void {
  const intervalMs = opts.intervalMs ?? DEFAULT_COMPACTION_INTERVAL_MS;
  const log = opts.log ?? (() => undefined);

  log(`[compaction] tick started (interval=${intervalMs} ms)`);

  const timer = setInterval(() => {
    runCompactionPass(adapter, opts);
  }, intervalMs);

  // Unref so the timer does not keep the process alive.
  if (typeof timer.unref === 'function') timer.unref();

  return () => {
    clearInterval(timer);
    log('[compaction] tick stopped');
  };
}
