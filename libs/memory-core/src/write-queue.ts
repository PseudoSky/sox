/**
 * In-process write queue — single FIFO queue per store path.
 *
 * CONTRACTS §C:
 *   - Every mutation routes through ONE in-process write queue (single connection,
 *     FIFO, group commit permitted).
 *   - Queue overflow → E_BUSY {retryable:true, retry_after_ms:250}.
 *   - The single write connection uses PRAGMA busy_timeout=3000, journal_mode=WAL,
 *     synchronous=NORMAL.
 *   - Read-only connections additionally set query_only=ON.
 *
 * The queue guarantees write serialization within a single process. Cross-process
 * serialization is the writer lease's responsibility (§J, context 03).
 *
 * ── Write-path observability + time-based backpressure (2026-07-04 incident) ──
 *
 * The size bound alone is not enough: under CPU contention per-task latency
 * (dominated by sync ONNX embedding) stretches to seconds, the queue stays
 * below `_maxSize`, and callers hang past their MCP client timeout instead of
 * failing fast. This module now also provides:
 *
 *   1. TIME-BASED ADMISSION CONTROL — on enqueue, `estimated_wait ≈
 *      (pending + in-flight + 1) × recent_avg_task_latency`. If the estimate
 *      exceeds the deadline budget, the enqueue is rejected IMMEDIATELY with
 *      the CONTRACTS §B E_BUSY shape and a `retry_after_ms` DERIVED from the
 *      estimate (time for the excess to drain, plus one task of slack).
 *      Cold-start safe: with zero completed samples there is no estimate and
 *      admission control never rejects (the size cap still protects).
 *
 *      Env surface:
 *        SOX_WRITEQ_DEADLINE_MS   — deadline budget in ms (default 20000,
 *                                   chosen safely under typical 30–60s MCP
 *                                   client timeouts). Read at queue creation.
 *        SOX_WRITEQ_NO_DEADLINE=1 — kill-switch: disables TIME-based rejection
 *                                   only (size cap unaffected). Read per-enqueue
 *                                   so it can be flipped for live debugging.
 *
 *   2. STRUCTURED STDERR LOGS ([inv:no-stdout-diagnostics] — they surface in
 *      `soxe logs memory-server`, which captures the backend's stderr):
 *        - every size/deadline rejection (depth, estimate, budget);
 *        - slow tasks (> SLOW_TASK_MIN_MS AND > SLOW_TASK_FACTOR × rolling avg);
 *        - queue-depth saturation crossings with HYSTERESIS (warn at 75% of
 *          the size cap, clear at 40% — one line per transition, never per-task).
 *
 *   3. METRICS SNAPSHOT — `getMetrics()` / `WriteQueue.metricsForPath()`:
 *      rolling write-latency percentiles (shared latency-stats helpers, HF-2),
 *      queue depth + high watermark, monotonic per-process counters. Pure and
 *      read-only — callable from a ping handler with zero side effects.
 *
 * BL-154 SAFETY: every addition here is synchronous bookkeeping on the enqueue
 * and completion paths. No code path enqueues onto the queue from inside a
 * running task, and no async hops were added inside task execution.
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import { openDb } from './db.js';
import { wrapDbError } from './errors.js';
import { LatencyRing, summarizeLatencies } from './latency-stats.js';

// ── Error types (partial; full taxonomy is WP-2 / CONTRACTS §B) ───────────────

export interface QueueBusyError {
  code: 'E_BUSY';
  message: string;
  retryable: true;
  retry_after_ms: number;
  /** Optional, code-specific (CONTRACTS §B). Deadline rejections carry
   *  {reason:'deadline', queue_depth, estimated_wait_ms, deadline_budget_ms}. */
  details?: Record<string, unknown>;
}

export type QueueError = QueueBusyError;

// ── Metrics snapshot shape ─────────────────────────────────────────────────────

/**
 * Cheap, in-process, read-only snapshot of a WriteQueue's health.
 * Designed for exposure via memory_ping / memory_stats. Counters are monotonic
 * per-process; the snapshot itself has zero side effects.
 */
export interface WriteQueueMetrics {
  /** Items waiting in the queue right now (excludes the in-flight task). */
  queue_depth: number;
  /** 1 when a task is currently executing, else 0. */
  in_flight: number;
  /** Configured hard size cap. */
  queue_max_size: number;
  /** Highest queue depth observed since process start. */
  queue_high_watermark: number;
  /** True while the saturation warning is latched (hysteresis). */
  saturated: boolean;
  /** Rolling task-latency distribution over the last ≤LATENCY_WINDOW samples. */
  write_latency_ms: { p50: number; p99: number; mean: number; max: number };
  /** Mean execution latency of the last ≤RECENT_AVG_WINDOW tasks (admission estimator input). */
  recent_avg_task_latency_ms: number;
  /** Current deadline budget (SOX_WRITEQ_DEADLINE_MS or default). */
  deadline_budget_ms: number;
  /** False when SOX_WRITEQ_NO_DEADLINE=1 (kill-switch active). */
  deadline_guard_enabled: boolean;
  counters: {
    tasks_completed: number;
    rejections_busy_size: number;
    rejections_busy_deadline: number;
    slow_tasks: number;
  };
}

// ── Queue internals ───────────────────────────────────────────────────────────

interface QueueItem<T = unknown> {
  label: string;
  /** The operation to execute. Can be sync or async; runs under the queue's write connection. */
  operation: (db: Database.Database) => T | Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason: unknown) => void;
}

const DEFAULT_MAX_QUEUE_SIZE = 100;

/**
 * Default deadline budget (ms) for time-based admission control.
 * Chosen safely under typical MCP client timeouts (30–60s) so callers get a
 * retryable E_BUSY instead of a client-side timeout with an ambiguous outcome.
 * Override: SOX_WRITEQ_DEADLINE_MS.
 */
const DEFAULT_DEADLINE_BUDGET_MS = 20_000;

/** Resolve the deadline budget from env (SOX_WRITEQ_DEADLINE_MS), else default. */
function resolveDeadlineBudgetMs(): number {
  const raw = process.env['SOX_WRITEQ_DEADLINE_MS'];
  if (!raw) return DEFAULT_DEADLINE_BUDGET_MS;
  const v = parseInt(raw, 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_DEADLINE_BUDGET_MS;
}

/** True when the deadline kill-switch (SOX_WRITEQ_NO_DEADLINE=1) is active.
 *  Read per-enqueue so it can be flipped without recreating queues. */
function deadlineGuardDisabled(): boolean {
  return process.env['SOX_WRITEQ_NO_DEADLINE'] === '1';
}

/** Stderr log prefix — matches the `[memoryd]`-style convention in memory-core. */
const LOG_PREFIX = '[memory-core writeq]';

/**
 * Single-writer queue for a given store path.
 * Only one WriteQueue exists per resolved dbPath — call `forPath()` to obtain it.
 *
 * Operations execute sequentially (FIFO). Async operations are serialised:
 * the next item does not start until the previous item's promise settles.
 * For embedding-heavy writes, perform the embedding BEFORE enqueuing and pass a
 * synchronous operation — this keeps the queue slot short and throughput high.
 *
 * WP-1 negative control: set `SOX_DISABLE_WRITE_QUEUE=1` to bypass queue
 * serialisation (operations execute immediately, unordered). The queue ordering
 * test goes red under this flag.
 *
 * WP-5 (BL-123): WAL checkpoint on idle — after the queue has been idle for
 * CHECKPOINT_IDLE_MS, a PRAGMA wal_checkpoint(TRUNCATE) runs automatically to
 * keep the WAL file bounded. The checkpoint timer is cancelled when new items
 * arrive, preventing intra-burst checkpoint overhead.
 */
export class WriteQueue {
  /** Singleton instances keyed by resolved (tilde-expanded) dbPath. */
  private static instances = new Map<string, WriteQueue>();
  /** WP-1 negative control: when true, enqueue runs operations immediately (serialisation broken). */
  private static _bypass = !!process.env['SOX_DISABLE_WRITE_QUEUE'];

  /** (WP-5) Milliseconds of idle time after which a WAL checkpoint fires. */
  static readonly CHECKPOINT_IDLE_MS = 2000;

  /** Rolling window size for the latency metrics distribution (p50/p99/mean/max). */
  static readonly LATENCY_WINDOW = 256;
  /** Number of most-recent samples averaged for the admission-control estimator. */
  static readonly RECENT_AVG_WINDOW = 32;
  /** A task is "slow" when its latency exceeds BOTH this floor AND
   *  SLOW_TASK_FACTOR × the rolling average at task start. */
  static readonly SLOW_TASK_MIN_MS = 1000;
  static readonly SLOW_TASK_FACTOR = 3;
  /** Saturation hysteresis: warn when depth ≥ ceil(75% of maxSize)… */
  static readonly SATURATION_ENTER_RATIO = 0.75;
  /** …clear when depth ≤ floor(40% of maxSize). One log line per transition. */
  static readonly SATURATION_CLEAR_RATIO = 0.4;

  private db: Database.Database;
  private queue: Array<QueueItem<any>> = [];
  private _processing = false;
  private _maxSize: number;
  private _runningPromise: Promise<void> = Promise.resolve();
  /** (WP-3) Instrumentation: number of items enqueued since last reset. Used in tests
   *  to assert that a batch write creates exactly one queue entry. */
  _enqueueCount = 0;
  /** (WP-5) Timer handle for the deferred WAL checkpoint. */
  private _checkpointTimer: ReturnType<typeof setTimeout> | null = null;
  /** (WP-5) Wall-clock time (ms) of the last successful WAL checkpoint. 0 = never. */
  private _lastCheckpointAt = 0;

  // ── Observability + backpressure state ──────────────────────────────────────
  /** Rolling execution-latency samples (ms) of completed tasks. */
  private _latencies = new LatencyRing(WriteQueue.LATENCY_WINDOW);
  /** Highest pending-queue depth observed since process start. */
  private _highWatermark = 0;
  /** Saturation warning latch (hysteresis — one log line per transition). */
  private _saturated = false;
  /** Deadline budget (ms), resolved from SOX_WRITEQ_DEADLINE_MS at creation. */
  private _deadlineBudgetMs = resolveDeadlineBudgetMs();
  /** Monotonic per-process counters (never reset). */
  private _counters = {
    tasks_completed: 0,
    rejections_busy_size: 0,
    rejections_busy_deadline: 0,
    slow_tasks: 0,
  };
  /** Stderr log sink — injectable for tests. NEVER stdout ([inv:no-stdout-diagnostics]). */
  private _logSink: (line: string) => void = (line) => console.error(line);
  /** Slow-task floor (ms) — test-overridable to avoid real 1s sleeps in specs. */
  private _slowTaskMinMs = WriteQueue.SLOW_TASK_MIN_MS;

  private constructor(dbPath: string, maxSize = DEFAULT_MAX_QUEUE_SIZE) {
    // Open a dedicated write connection with the mandated pragmas.
    this.db = openDb(dbPath);
    // Override busy_timeout per CONTRACTS §C (openDb currently uses 5000, but
    // schema.ts PRAGMAS have been updated to 3000 — this is a belt-and-suspenders).
    this.db.exec('PRAGMA busy_timeout = 3000;');
    this._maxSize = maxSize;
  }

  /**
   * Enable or disable queue bypass (WP-1 negative control).
   * In tests, set bypass=true and verify the ordering test fails.
   */
  static setBypass(enabled: boolean): void {
    WriteQueue._bypass = enabled;
  }

  /** True when the queue bypass is active (no serialisation). */
  static get bypass(): boolean {
    return WriteQueue._bypass;
  }

  /** (WP-3) Reset enqueueCount for all known queue instances. Used in test setup. */
  static resetAllEnqueueCounts(): void {
    for (const [, q] of WriteQueue.instances) {
      q._enqueueCount = 0;
    }
  }

  /**
   * Clear all singleton instances (test teardown).
   * Ensures each test gets a fresh queue.
   */
  static clearInstances(): void {
    for (const [, q] of WriteQueue.instances) {
      q._cancelCheckpoint();
      try { q.db.close(); } catch { /* already closed */ }
    }
    WriteQueue.instances.clear();
  }

  /**
   * Obtain (or create) the WriteQueue for a resolved store path.
   * The returned queue is a singleton — repeated calls return the same instance.
   * When `_bypass` is true, creates a new queue each time (no serialisation) so
   * the ordering negative control works.
   */
  static forPath(dbPath: string, maxSize?: number): WriteQueue {
    if (WriteQueue._bypass) {
      return new WriteQueue(dbPath, maxSize);
    }
    let instance = WriteQueue.instances.get(dbPath);
    if (!instance) {
      instance = new WriteQueue(dbPath, maxSize);
      WriteQueue.instances.set(dbPath, instance);
    }
    return instance;
  }

  /** Number of pending items (0 when idle). */
  get pending(): number {
    return this.queue.length;
  }

  /** True when the queue is actively processing an item. */
  get processing(): boolean {
    return this._processing;
  }

  /** Configured max queue depth. */
  get maxSize(): number {
    return this._maxSize;
  }

  /** (WP-5) Wall-clock epoch ms of the last successful WAL checkpoint. 0 = never. */
  get lastCheckpointAt(): number {
    return this._lastCheckpointAt;
  }

  /**
   * (WP-5) Static accessor: last checkpoint time for a given store path.
   * Returns 0 if the queue has no record (never checkpointed or no queue instance).
   */
  static lastCheckpointAtForPath(dbPath: string): number {
    const q = WriteQueue.instances.get(dbPath);
    return q ? q._lastCheckpointAt : 0;
  }

  /** (WP-5) Read the WAL file size in bytes from the filesystem. Returns 0 if unavailable. */
  walBytes(): number {
    try {
      const walPath = this.db.name + '-wal';
      const st = fs.statSync(walPath, { throwIfNoEntry: false });
      return st?.size ?? 0;
    } catch {
      return 0;
    }
  }

  /**
   * (WP-5) Run PRAGMA wal_checkpoint(TRUNCATE) to flush WAL to the main DB file
   * and truncate the WAL. Idempotent — safe to call repeatedly.
   * Returns the number of checkpointed frames, or -1 on error.
   */
  walCheckpoint(): number {
    try {
      const row = this.db.prepare<[], { frames_checkpointed: number }>(
        `PRAGMA wal_checkpoint(TRUNCATE)`,
      ).get() as { frames_checkpointed?: number; wal_size_bytes?: number } | undefined;
      this._lastCheckpointAt = Date.now();
      const frames = (row && typeof row === 'object' && 'frames_checkpointed' in row)
        ? (row as { frames_checkpointed: number }).frames_checkpointed
        : -1;
      return frames;
    } catch {
      return -1;
    }
  }

  /** True when the checkpoint timer is pending (queue idle but not yet checkpointed). */
  get _checkpointPending(): boolean {
    return this._checkpointTimer !== null;
  }

  /** Cancel a pending checkpoint (new work arrived). */
  private _cancelCheckpoint(): void {
    if (this._checkpointTimer !== null) {
      clearTimeout(this._checkpointTimer);
      this._checkpointTimer = null;
    }
  }

  /** Schedule a deferred WAL checkpoint if the queue is idle. */
  private _scheduleIdleCheckpoint(): void {
    if (this._processing || this.queue.length > 0) return;
    if (this._checkpointTimer !== null) return; // already scheduled
    this._checkpointTimer = setTimeout(() => {
      this._checkpointTimer = null;
      this.walCheckpoint();
    }, WriteQueue.CHECKPOINT_IDLE_MS);
  }

  /**
   * Enqueue a write operation.
   * The operation receives the queue's dedicated write connection.
   * Operations run sequentially (FIFO). Sync operations are preferred for
   * throughput; async operations are supported but hold the queue slot open
   * until their promise settles.
   *
   * When the queue is full, returns a rejected promise with E_BUSY.
   */
  enqueue<T>(
    label: string,
    operation: (db: Database.Database) => T | Promise<T>,
  ): Promise<T> {
    // WP-1 negative control: bypass queue → execute immediately (no serialisation)
    if (WriteQueue._bypass) {
      try {
        const result = operation(this.db);
        return Promise.resolve(result instanceof Promise ? result : Promise.resolve(result)).then(
          (v) => Promise.resolve(v),
        );
      } catch (err) {
        return Promise.reject(err);
      }
    }

    // (WP-5) Cancel pending idle checkpoint — new work arrived
    this._cancelCheckpoint();

    this._enqueueCount++;

    // Overflow guard (hard SIZE cap — CONTRACTS §C, pinned by the
    // queue-overflow chaos spec: retry_after_ms stays the constant 250 here)
    if (this.queue.length >= this._maxSize) {
      this._counters.rejections_busy_size++;
      this._logSink(
        `${LOG_PREFIX} REJECT E_BUSY(size) store=${this.db.name} label=${label} ` +
        `depth=${this.queue.length} max=${this._maxSize}`,
      );
      return Promise.reject({
        code: 'E_BUSY',
        message: `Write queue for ${this.db.name} is full (${this._maxSize} pending)`,
        retryable: true,
        retry_after_ms: 250,
      } satisfies QueueBusyError);
    }

    // Time-based admission control (incident 2026-07-04): below the size cap,
    // fail fast when the caller would predictably out-wait its client timeout.
    //   estimated_wait ≈ (pending + in-flight + 1) × recent avg task latency
    // (+1 = the caller's own task; the MCP contract awaits COMPLETION, not
    // enqueue). Cold-start: no samples → no estimate → always admit.
    if (!deadlineGuardDisabled()) {
      const avgMs = this._latencies.recentMean(WriteQueue.RECENT_AVG_WINDOW);
      if (avgMs > 0) {
        const slots = this.queue.length + (this._processing ? 1 : 0) + 1;
        const estimatedWaitMs = slots * avgMs;
        if (estimatedWaitMs > this._deadlineBudgetMs) {
          // Derived retry hint: time for the excess backlog to drain, plus one
          // task of slack — NOT a constant. Clamped to [250ms, 60s].
          const excessMs = estimatedWaitMs - this._deadlineBudgetMs;
          const retryAfterMs = Math.min(Math.max(Math.ceil(excessMs + avgMs), 250), 60_000);
          this._counters.rejections_busy_deadline++;
          this._logSink(
            `${LOG_PREFIX} REJECT E_BUSY(deadline) store=${this.db.name} label=${label} ` +
            `depth=${this.queue.length} est_wait_ms=${Math.round(estimatedWaitMs)} ` +
            `budget_ms=${this._deadlineBudgetMs} recent_avg_ms=${Math.round(avgMs)} ` +
            `retry_after_ms=${retryAfterMs}`,
          );
          return Promise.reject({
            code: 'E_BUSY',
            message:
              `Write queue for ${this.db.name} would exceed the deadline budget ` +
              `(estimated wait ${Math.round(estimatedWaitMs)}ms > ${this._deadlineBudgetMs}ms ` +
              `at depth ${this.queue.length})`,
            retryable: true,
            retry_after_ms: retryAfterMs,
            details: {
              reason: 'deadline',
              queue_depth: this.queue.length,
              estimated_wait_ms: Math.round(estimatedWaitMs),
              deadline_budget_ms: this._deadlineBudgetMs,
            },
          } satisfies QueueBusyError);
        }
      }
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({ label, operation, resolve, reject });
      if (this.queue.length > this._highWatermark) {
        this._highWatermark = this.queue.length;
      }
      this._checkSaturation(); // rising edge
      if (!this._processing) {
        this._processing = true;
        // Chain onto the running promise to serialise async operations.
        this._runningPromise = this._runningPromise.then(() => this._processNext());
      }
    });
  }

  /**
   * Drain all pending items and close the database connection.
   * Resolves when the queue is empty and the connection is closed.
   */
  async drainAndClose(): Promise<void> {
    // Wait for the processing chain to finish
    while (this._processing || this.queue.length > 0) {
      await new Promise<void>((r) => setImmediate(r));
    }
    this._cancelCheckpoint();
    this.db.close();
    // Remove from the singleton map
    for (const [key, val] of WriteQueue.instances) {
      if (val === this) {
        WriteQueue.instances.delete(key);
        break;
      }
    }
  }

  // ── Observability accessors ─────────────────────────────────────────────────

  /**
   * Record a completed-task execution latency (ms). Called by _processNext;
   * also the DETERMINISTIC TEST SEAM for the admission-control estimator
   * (BL-161 pattern: seed samples directly instead of real sleeps/ONNX).
   */
  _recordLatencySample(latencyMs: number): void {
    this._latencies.push(latencyMs);
  }

  /** Mean execution latency (ms) of the most recent completed tasks — the
   *  admission-control estimator input. 0 when no samples exist (cold start). */
  recentAvgLatencyMs(): number {
    return this._latencies.recentMean(WriteQueue.RECENT_AVG_WINDOW);
  }

  /** Current deadline budget (ms). */
  get deadlineBudgetMs(): number {
    return this._deadlineBudgetMs;
  }

  /** Test seam: override the deadline budget without touching process env. */
  _setDeadlineBudgetForTest(ms: number): void {
    this._deadlineBudgetMs = ms;
  }

  /** Test seam: capture stderr log lines. Production default is console.error. */
  _setLogSinkForTest(sink: (line: string) => void): void {
    this._logSink = sink;
  }

  /** Test seam: lower the slow-task floor so specs need no real 1s sleeps. */
  _setSlowTaskMinMsForTest(ms: number): void {
    this._slowTaskMinMs = ms;
  }

  /**
   * Pure, read-only metrics snapshot — zero side effects, callable from a
   * ping/stats handler. Latency percentiles reuse the shared HF-2 helpers.
   */
  getMetrics(): WriteQueueMetrics {
    const summary = summarizeLatencies(this._latencies.values());
    return {
      queue_depth: this.queue.length,
      in_flight: this._processing ? 1 : 0,
      queue_max_size: this._maxSize,
      queue_high_watermark: this._highWatermark,
      saturated: this._saturated,
      write_latency_ms: {
        p50: summary.p50,
        p99: summary.p99,
        mean: summary.mean,
        max: summary.max,
      },
      recent_avg_task_latency_ms: this._latencies.recentMean(WriteQueue.RECENT_AVG_WINDOW),
      deadline_budget_ms: this._deadlineBudgetMs,
      deadline_guard_enabled: !deadlineGuardDisabled(),
      counters: { ...this._counters },
    };
  }

  /**
   * Static accessor: metrics snapshot for a given store path, or null when no
   * queue instance exists for that path (nothing has written through it yet).
   * Intended integration point for memory_ping's store block.
   */
  static metricsForPath(dbPath: string): WriteQueueMetrics | null {
    const q = WriteQueue.instances.get(dbPath);
    return q ? q.getMetrics() : null;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  /**
   * Saturation hysteresis: warn once when pending depth rises to
   * ceil(SATURATION_ENTER_RATIO × maxSize); clear once when it falls to
   * floor(SATURATION_CLEAR_RATIO × maxSize). Called on enqueue (rising edge)
   * and after each completed task (falling edge) — never per-task spam.
   */
  private _checkSaturation(): void {
    const depth = this.queue.length;
    const enterAt = Math.ceil(this._maxSize * WriteQueue.SATURATION_ENTER_RATIO);
    const clearAt = Math.floor(this._maxSize * WriteQueue.SATURATION_CLEAR_RATIO);
    if (!this._saturated && depth >= enterAt) {
      this._saturated = true;
      this._logSink(
        `${LOG_PREFIX} SATURATION store=${this.db.name} depth=${depth} ` +
        `enter_threshold=${enterAt} max=${this._maxSize}`,
      );
    } else if (this._saturated && depth <= clearAt) {
      this._saturated = false;
      this._logSink(
        `${LOG_PREFIX} SATURATION CLEARED store=${this.db.name} depth=${depth} ` +
        `clear_threshold=${clearAt} max=${this._maxSize}`,
      );
    }
  }

  private async _processNext(): Promise<void> {
    while (this.queue.length > 0) {
      const item = this.queue.shift()!;
      // Rolling average BEFORE this task — the slow-task baseline.
      const avgAtStartMs = this._latencies.recentMean(WriteQueue.RECENT_AVG_WINDOW);
      const startedAt = performance.now();
      try {
        const result = item.operation(this.db);
        // Await in case it's a promise (async operation). For sync operations,
        // this resolves immediately on the same microtask tick.
        const resolved = await result;
        item.resolve(resolved);
      } catch (err) {
        // WP-2: wrap raw SqliteError into CONTRACTS §B shape before surfacing.
        item.reject(wrapDbError(err));
      }
      // Post-completion bookkeeping — all synchronous, no async hops (BL-154).
      // Failed tasks count too: they occupied the slot, so their duration is
      // service time for the wait estimator either way.
      const latencyMs = performance.now() - startedAt;
      this._recordLatencySample(latencyMs);
      this._counters.tasks_completed++;
      if (
        latencyMs > this._slowTaskMinMs &&
        (avgAtStartMs === 0 || latencyMs > WriteQueue.SLOW_TASK_FACTOR * avgAtStartMs)
      ) {
        this._counters.slow_tasks++;
        this._logSink(
          `${LOG_PREFIX} SLOW task store=${this.db.name} label=${item.label} ` +
          `latency_ms=${Math.round(latencyMs)} recent_avg_ms=${Math.round(avgAtStartMs)} ` +
          `depth=${this.queue.length}`,
        );
      }
      this._checkSaturation(); // falling edge
    }
    // (WP-5) Queue is now idle — schedule a deferred WAL checkpoint.
    // New items enqueued before the timer fires will cancel it.
    // IMPORTANT: set _processing=false BEFORE scheduling the checkpoint,
    // because _scheduleIdleCheckpoint guards on `if (this._processing) return;`.
    this._processing = false;
    this._scheduleIdleCheckpoint();
  }
}
