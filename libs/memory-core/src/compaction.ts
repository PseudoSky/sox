/**
 * compaction.ts — Scheduled ANALYZE/optimize tick (HF-4, BL-133).
 *
 * Runs `PRAGMA optimize` and `ANALYZE` on an idle cadence (default 5 min) to
 * keep the query planner fresh.
 *
 * WAL checkpoint ownership (DEBT-004, 2026-08-17): this module used
 * to ALSO run its own `wal_checkpoint(TRUNCATE)` here, with logic to skip it
 * when `WriteQueue`'s private idle-checkpoint timer (WP-5) had fired
 * recently — i.e. TWO independent, uncoordinated checkpoint mechanisms
 * defending against double-firing each other. Per owner directive
 * ("leaving backlog and memory on common underlying infra... because there
 * can only be 1 running debounced vacuum"), both private mechanisms were
 * eliminated: `WriteQueue`'s idle timer is gone (see write-queue.ts's class
 * doc comment) and so is this tick's own raw PRAGMA. WAL checkpointing is
 * now owned exclusively by the store-adapter's own idle flush
 * (`TursoAdapterImpl._armIdleFlush()`/`_checkWalCapAndFlush()`), which every
 * store this tick's adapter opens against inherits automatically. This tick
 * now does ONLY the maintenance no adapter mechanism performs: `PRAGMA
 * optimize` + `ANALYZE`. `CompactionResult.checkpointed`/`framesCheckpointed`
 * are kept for API stability with existing callers (memory-server's
 * maintenance tool, memory-cli's compact command) but now always report
 * `false`/`-1` — checkpointing happens transparently elsewhere, not as an
 * action this pass takes or can observe.
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';

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
  /**
   * (DEBT-004) Always `false` — this pass no longer runs its own
   * `wal_checkpoint`; checkpointing is owned exclusively by the store
   * adapter's idle flush. Kept for API stability with existing callers.
   */
  checkpointed: boolean;
  /**
   * (DEBT-004) Always `-1` — see `checkpointed`. Kept for API
   * stability with existing callers.
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
 *
 * (DEBT-004) No longer runs a WAL checkpoint — see the module doc
 * comment. `result.checkpointed`/`result.framesCheckpointed` are always
 * `false`/`-1`.
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
  // (DEBT-004) Always false/-1 — checkpointing moved to the store
  // adapter's idle flush; this pass no longer performs or observes one.
  const checkpointed = false;
  const framesCheckpointed = -1;
  let error: string | null = null;

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
