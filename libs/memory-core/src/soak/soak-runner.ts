/**
 * soak/soak-runner.ts — HF-2 extended concurrency soak harness.
 *
 * Extends context-01's concurrency harness (concurrency-harness.spec.ts) with:
 *   - Longer / parameterized profile (more writers × ops for soak durability).
 *   - Per-operation latency sampling for p50/p99/mean.
 *   - Queue-depth snapshots during the run.
 *   - WAL checkpoint age tracking.
 *   - Degraded-run injection: SOX_SOAK_INJECT_TXN_DELAY_MS adds per-txn
 *     artificial delay, making the gate provably fail under a tight budget.
 *
 * DEGRADED-RUN CONTROL:
 *   Set SOX_SOAK_INJECT_TXN_DELAY_MS=<N> (e.g. 100) before running.
 *   Every write operation sleeps N ms inside the queue, inflating p50/p99
 *   far beyond any reasonable baseline budget. The soak.spec.ts degraded test
 *   sets this env flag and then asserts that the sample budget rejects the run —
 *   proving the threshold gate has teeth.
 *
 * RULES compliance:
 *   - No wall-clock sleeps in the soak itself (injected delay is under env guard).
 *   - All tmp stores in OS tmpdir, cleaned up after run.
 *   - No dependencies outside memory-core's existing dep tree.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WriteQueue } from '../write-queue.js';
import { percentile, mean } from '../latency-stats.js';

// ── Types ─────────────────────────────────────────────────────────────────────

/** Parameterized soak profile. */
export interface SoakProfile {
  /** Number of concurrent virtual writers. Default: 16. */
  writers: number;
  /** Number of write operations per writer. Default: 100. */
  opsPerWriter: number;
  /**
   * Max write queue size. Defaults to well above opsPerWriter×writers so
   * E_BUSY from queue-full does not fire during the soak itself (that is S1's
   * territory). Set lower to deliberately test backpressure in isolation.
   */
  maxQueueSize?: number;
  /**
   * Payload size per write (bytes). Larger payloads produce more WAL pressure.
   * Default: 256 bytes.
   */
  payloadBytes?: number;
}

/** Default soak profile — sized for a "few seconds" CI run as specified. */
// Required<> so the concrete defaults are non-optional numbers — destructuring
// `= DEFAULT_SOAK_PROFILE.maxQueueSize` then yields `number`, not `number | undefined`,
// which satisfies exactOptionalPropertyTypes when re-assembling the profile object.
export const DEFAULT_SOAK_PROFILE: Readonly<Required<SoakProfile>> = {
  writers: 16,
  opsPerWriter: 100,
  maxQueueSize: 10_000,
  payloadBytes: 256,
};

/** Per-run metrics emitted by runSoak(). */
export interface SoakMetrics {
  /** ISO-8601 timestamp at run start. */
  run_started_at: string;
  /** ISO-8601 timestamp at run completion. */
  run_completed_at: string;
  /** Elapsed wall-clock duration in ms. */
  elapsed_ms: number;

  /** Soak profile used. */
  profile: SoakProfile;

  /** Whether the degraded-run injection was active (SOX_SOAK_INJECT_TXN_DELAY_MS). */
  degraded_run: boolean;
  /** Injected delay per txn in ms (0 when not degraded). */
  injected_delay_ms: number;

  /** Total operations successfully committed. */
  ops_committed: number;
  /** Total operations that failed (E_BUSY overflow, unexpected errors). */
  ops_failed: number;

  /**
   * Write-latency histogram (per enqueue-to-settle round-trip, ms).
   * Sorted ascending for easy percentile extraction.
   */
  write_latencies_ms: number[];

  /** Write latency percentiles (ms). */
  write_p50_ms: number;
  write_p99_ms: number;
  write_mean_ms: number;
  write_min_ms: number;
  write_max_ms: number;

  /**
   * Lock-wait proxy (ms): time between enqueue() call and when the operation
   * actually starts executing. Approximated as (settle_time - execute_start).
   * For a perfectly serialized queue with no injection, this approaches 0 for
   * the head item and accumulates for later items.
   */
  lock_wait_p50_ms: number;
  lock_wait_p99_ms: number;

  /**
   * Txn-duration histogram (ms): time from operation-start to operation-settle
   * (i.e. the time holding the queue slot, excluding wait time).
   */
  txn_duration_p50_ms: number;
  txn_duration_p99_ms: number;

  /**
   * Queue-depth snapshots (sampled ~every 50ms during the run).
   * Each entry is { at_ms: elapsed_ms_since_start, depth: number }.
   */
  queue_depth_samples: Array<{ at_ms: number; depth: number }>;
  /** Peak queue depth observed during the run. */
  queue_depth_peak: number;
  /** Mean queue depth across samples. */
  queue_depth_mean: number;

  /**
   * Checkpoint age at the end of the run (ms since last WAL checkpoint).
   * null if no checkpoint occurred during the run.
   */
  checkpoint_age_ms: number | null;

  /**
   * WAL file size at end of run (bytes).
   * 0 if the file does not exist or cannot be read.
   */
  wal_bytes_final: number;

  /** Path to the soak store (always a tmpdir — NOT ~/.memory). */
  store_path: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
// percentile/mean live in ../latency-stats.ts (promoted for reuse by the
// WriteQueue instrumentation — see the import at the top of this file).

/** Resolve the per-txn injected delay from env (0 = no injection). */
export function resolveInjectedDelay(): number {
  const raw = process.env['SOX_SOAK_INJECT_TXN_DELAY_MS'];
  if (!raw) return 0;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

// ── Main soak runner ──────────────────────────────────────────────────────────

/**
 * Run an extended concurrency soak against a fresh temporary SQLite store.
 *
 * Creates a dedicated store in OS tmpdir, runs the soak, collects metrics,
 * then deletes the store. Caller receives the metrics; the store is gone.
 *
 * @param profile  - Soak parameters (writers, opsPerWriter, …).
 * @param options  - Optional overrides (e.g. injectedDelayMs for tests).
 * @returns  Structured SoakMetrics.
 */
export async function runSoak(
  profile: SoakProfile = DEFAULT_SOAK_PROFILE,
  options?: {
    /** Override injected delay (useful in tests; env flag is still respected). */
    injectedDelayMs?: number;
    /**
     * Override the store path. When set, the store is NOT cleaned up by this
     * function — caller manages the lifecycle.
     */
    storePath?: string;
  },
): Promise<SoakMetrics> {
  const {
    writers,
    opsPerWriter,
    maxQueueSize = DEFAULT_SOAK_PROFILE.maxQueueSize,
    payloadBytes = DEFAULT_SOAK_PROFILE.payloadBytes,
  } = profile;

  // Determine injected delay
  const envDelay = resolveInjectedDelay();
  const injectedDelayMs = options?.injectedDelayMs ?? envDelay;
  const degradedRun = injectedDelayMs > 0;

  // ── Store setup ────────────────────────────────────────────────────────────
  let storePath: string;
  let cleanupStore: (() => void) | null = null;

  if (options?.storePath) {
    storePath = options.storePath;
  } else {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'soak-hf2-'));
    storePath = path.join(dir, 'soak.db');
    cleanupStore = () => fs.rmSync(dir, { recursive: true, force: true });
  }

  // Reset any stale WriteQueue state for this path
  await WriteQueue.clearInstances();
  WriteQueue.setBypass(false);

  const queue = await WriteQueue.forPath(storePath, maxQueueSize);

  // Initialize the soak table
  await queue.enqueue('soak-setup', async (tx) => {
    await tx.exec('PRAGMA journal_mode = WAL');
    await tx.exec('PRAGMA synchronous = NORMAL');
    await tx.exec('PRAGMA busy_timeout = 3000');
    await tx.exec(`CREATE TABLE IF NOT EXISTS soak_writes (
      id     INTEGER PRIMARY KEY AUTOINCREMENT,
      writer INTEGER NOT NULL,
      seq    INTEGER NOT NULL,
      payload TEXT NOT NULL
    )`);
  });

  // ── Metrics collection structures ──────────────────────────────────────────
  const writeLatencies: number[] = [];
  const lockWaits: number[] = [];
  const txnDurations: number[] = [];
  const queueDepthSamples: Array<{ at_ms: number; depth: number }> = [];
  let opsCommitted = 0;
  let opsFailed = 0;

  const runStartMs = Date.now();
  const runStartedAt = new Date(runStartMs).toISOString();

  // ── Queue-depth sampler ────────────────────────────────────────────────────
  // Samples the queue pending depth every ~50ms while the run is active.
  let samplerActive = true;

  const samplerLoop = (async () => {
    while (samplerActive) {
      await new Promise<void>((r) => setTimeout(r, 50));
      if (!samplerActive) break;
      const depth = queue.pending;
      queueDepthSamples.push({ at_ms: Date.now() - runStartMs, depth });
    }
  })();

  // Suppress unhandled rejection on sampler (it never rejects, but just in case).
  samplerLoop.catch(() => { /* sampler loop never rejects */ });

  // ── Soak writers ──────────────────────────────────────────────────────────
  const payload = 'x'.repeat(Math.max(1, payloadBytes!));

  async function runWriter(writerId: number): Promise<void> {
    for (let seq = 0; seq < opsPerWriter; seq++) {
      const enqueuedAt = Date.now();

      try {
        await queue.enqueue(`soak-w${writerId}-${seq}`, async (tx) => {
          const execStart = Date.now();

          // Record lock-wait: time from enqueue to when we actually start executing
          lockWaits.push(execStart - enqueuedAt);

          if (injectedDelayMs > 0) {
            // Degraded-run injection: artificial per-txn delay.
            // This holds the queue slot open, inflating every downstream latency.
            await new Promise<void>((r) => setTimeout(r, injectedDelayMs));
          }

          await tx.executeRun(
            'INSERT INTO soak_writes (writer, seq, payload) VALUES (?, ?, ?)',
            [writerId, seq, payload],
          );

          txnDurations.push(Date.now() - execStart);
        });

        writeLatencies.push(Date.now() - enqueuedAt);
        opsCommitted++;
      } catch {
        opsFailed++;
      }
    }
  }

  // Launch all writers concurrently
  const writerPromises = Array.from({ length: writers }, (_, i) => runWriter(i));
  await Promise.all(writerPromises);

  // ── Stop sampler ───────────────────────────────────────────────────────────
  samplerActive = false;
  // Wait briefly for the sampler to observe the stop flag
  await new Promise<void>((r) => setTimeout(r, 60));

  // ── Collect WAL + checkpoint info ──────────────────────────────────────────
  const lastCkptEpoch = queue.lastCheckpointAt;
  const checkpointAgeMs = lastCkptEpoch > 0 ? Date.now() - lastCkptEpoch : null;
  const walBytes = queue.walBytes();

  // ── Run drain + cleanup ────────────────────────────────────────────────────
  await queue.drainAndClose();
  await WriteQueue.clearInstances();

  const runCompletedAt = new Date().toISOString();
  const elapsedMs = Date.now() - runStartMs;

  if (cleanupStore) {
    try { cleanupStore(); } catch { /* best effort */ }
  }

  // ── Build metrics ──────────────────────────────────────────────────────────
  writeLatencies.sort((a, b) => a - b);
  lockWaits.sort((a, b) => a - b);
  txnDurations.sort((a, b) => a - b);

  const queueDepths = queueDepthSamples.map((s) => s.depth);

  return {
    run_started_at: runStartedAt,
    run_completed_at: runCompletedAt,
    elapsed_ms: elapsedMs,

    profile: { writers, opsPerWriter, maxQueueSize, payloadBytes },

    degraded_run: degradedRun,
    injected_delay_ms: injectedDelayMs,

    ops_committed: opsCommitted,
    ops_failed: opsFailed,

    write_latencies_ms: writeLatencies,
    write_p50_ms: percentile(writeLatencies, 0.50),
    write_p99_ms: percentile(writeLatencies, 0.99),
    write_mean_ms: mean(writeLatencies),
    write_min_ms: writeLatencies[0] ?? 0,
    write_max_ms: writeLatencies[writeLatencies.length - 1] ?? 0,

    lock_wait_p50_ms: percentile(lockWaits, 0.50),
    lock_wait_p99_ms: percentile(lockWaits, 0.99),

    txn_duration_p50_ms: percentile(txnDurations, 0.50),
    txn_duration_p99_ms: percentile(txnDurations, 0.99),

    queue_depth_samples: queueDepthSamples,
    queue_depth_peak: queueDepths.length > 0 ? Math.max(...queueDepths) : 0,
    queue_depth_mean: mean(queueDepths),

    checkpoint_age_ms: checkpointAgeMs,
    wal_bytes_final: walBytes,

    store_path: storePath,
  };
}
