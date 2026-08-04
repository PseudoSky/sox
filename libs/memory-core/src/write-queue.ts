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
 * ── Task-kind separation (two-phase write follow-on, 2026-07-04) ──────────────
 *
 * Phase-B `applyEmbedding` tasks ride the SAME serial queue as writes but have a
 * very different latency shape (short vec insert vs full Phase-A write body).
 * `enqueue` therefore accepts an optional `kind` ('write' default | 'apply'):
 *
 *   - REPORTING is segregated: `write_latency_ms` summarizes ONLY write-kind
 *     tasks (more honest than the pre-split blend — see CHANGELOG), and a new
 *     additive `apply_latency_ms` block summarizes apply-kind tasks.
 *   - THE ADMISSION-CONTROL ESTIMATOR IS DELIBERATELY UNCHANGED: it keeps
 *     consuming the blended ALL-KIND ring (`_latencies`) and the raw pending
 *     depth (`queue.length` counts apply tasks too). Rationale: the estimator
 *     approximates the total service time of everything occupying the slot
 *     ahead of the caller — an apply task occupies the slot exactly like a
 *     write does, so removing apply samples (or apply occupancy) from its
 *     input would make it systematically UNDER-estimate wait under Phase-B
 *     load and re-open the 2026-07-04 hang class. A per-kind estimator
 *     (Σ pending_kind × avg_kind) would be marginally more precise but changes
 *     pinned E_BUSY math for zero incident-relevant gain; the blended mean is
 *     honest as long as the recent completion mix resembles the queued mix,
 *     which the FIFO discipline guarantees over the 32-sample window.
 *     `recent_avg_task_latency_ms` remains the all-kind estimator input.
 *   - The slow-task baseline also stays on the all-kind ring (same argument).
 *   - E_BUSY contract unchanged: both kinds face the same size cap and
 *     deadline guard (a rejected apply is repaired by the periodic heal).
 *
 * BL-154 SAFETY: every addition here is synchronous bookkeeping on the enqueue
 * and completion paths. No code path enqueues onto the queue from inside a
 * running task, and no async hops were added inside task execution.
 */

import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { wrapDbError } from './errors.js';
import { LatencyRing, summarizeLatencies } from './latency-stats.js';
import { log, traceIdOrNew, withTrace } from './telemetry.js';

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

// ── Task kinds ─────────────────────────────────────────────────────────────────

/**
 * Latency-shape label for a queue task (two-phase write follow-on):
 *   'write' — default; Phase-A write bodies and every other mutation
 *             (invalidate, curate, update, …).
 *   'apply' — short Phase-B `applyEmbedding` tasks (vec insert + near-dup).
 * Affects METRIC SEGREGATION ONLY — admission control, ordering, and the
 * E_BUSY contract are identical for both kinds (see module header).
 */
export type TaskKind = 'write' | 'apply';

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
  /** Rolling latency distribution of WRITE-KIND tasks only (last ≤LATENCY_WINDOW
   *  write samples). Pre-kind-split this blended Phase-B apply tasks in; it is
   *  now write-only (more honest — noted in the CHANGELOG). */
  write_latency_ms: { p50: number; p99: number; mean: number; max: number };
  /** Additive: rolling latency distribution of APPLY-KIND (Phase-B
   *  applyEmbedding) tasks over the last ≤LATENCY_WINDOW apply samples. */
  apply_latency_ms: { p50: number; p99: number; mean: number; max: number };
  /** Mean execution latency of the last ≤RECENT_AVG_WINDOW tasks of ALL kinds —
   *  the admission-estimator input (apply tasks occupy the slot too; see module
   *  header for why this stays blended). */
  recent_avg_task_latency_ms: number;
  /** Current deadline budget (SOX_WRITEQ_DEADLINE_MS or default). */
  deadline_budget_ms: number;
  /** False when SOX_WRITEQ_NO_DEADLINE=1 (kill-switch active). */
  deadline_guard_enabled: boolean;
  /** Throughput: number of write tasks completed in the last 60s rolling window. */
  throughput_writes_per_sec: number;
  counters: {
    /** All completed tasks regardless of kind (pre-split semantics preserved). */
    tasks_completed: number;
    /** Additive: completed write-kind tasks. */
    write_tasks_completed: number;
    /** Additive: completed apply-kind (Phase-B applyEmbedding) tasks. */
    apply_tasks_completed: number;
    rejections_busy_size: number;
    rejections_busy_deadline: number;
    slow_tasks: number;
  };
}

// ── Queue internals ───────────────────────────────────────────────────────────

interface QueueItem<T = unknown> {
  label: string;
  /** Latency-shape label (metrics segregation only — see module header). */
  kind: TaskKind;
  /** The operation to execute. Can be sync or async; receives the StoreAdapter directly.
   *  Tasks that need transaction isolation should call adapter.transaction() themselves. */
  operation: (adapter: StoreAdapter) => T | Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason: unknown) => void;
  /** BL-320: correlation id threaded through log.* calls made by `operation` (and
   *  anything it awaits transitively) via AsyncLocalStorage — see telemetry.ts. */
  traceId: string;
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
  /** BL-402: in-flight `_create()` promises keyed by dbPath, so concurrent
   *  first-callers for the SAME never-before-seen path all await the same
   *  `openDb()` call instead of each independently paying the full open
   *  sequence. Cleared once the promise settles (success or failure) so a
   *  failed open doesn't permanently wedge the path. */
  private static pending = new Map<string, Promise<WriteQueue>>();
  /** WP-1 negative control: when true, enqueue runs operations immediately (serialisation broken). */
  private static _bypass = !!process.env['SOX_DISABLE_WRITE_QUEUE'];
  /**
   * (BL-405) Last-successful-checkpoint time PER STORE PATH, surviving the
   * owning `WriteQueue` instance's own removal from `instances`.
   *
   * Before this existed, `lastCheckpointAtForPath()` read `_lastCheckpointAt`
   * straight off the live instance in `instances` — so the moment an
   * instance was removed (`clearInstances()` in tests, or
   * `closeAllForShutdown()` in production), the metric silently reset to 0,
   * even for an instance whose LAST ACT was a successful checkpoint. That is
   * exactly backwards for a durability signal: `memory_ping.store.
   * last_checkpoint_at` must answer "when was this store last checkpointed",
   * not "does a live in-memory WriteQueue object happen to still exist".
   */
  private static _lastCheckpointByPath = new Map<string, number>();

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
  /** Rolling window (ms) for throughput_writes_per_sec computation. */
  static readonly THROUGHPUT_WINDOW_MS = 60_000;
  /** Saturation hysteresis: warn when depth ≥ ceil(75% of maxSize)… */
  static readonly SATURATION_ENTER_RATIO = 0.75;
  /** …clear when depth ≤ floor(40% of maxSize). One log line per transition. */
  static readonly SATURATION_CLEAR_RATIO = 0.4;

  private adapter: StoreAdapter;
  /** When true, enqueue() executes operations immediately without serialization.
   *  Set automatically when the adapter reports needsWriteSerialization: false
   *  (e.g. TursoAdapter — async, concurrent I/O). Distinguished from the static
   *  _bypass flag: _bypass is a global kill-switch (SOX_DISABLE_WRITE_QUEUE=1),
   *  _noop is per-instance based on adapter capabilities. */
  private _noop = false;
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
  /** Rolling execution-latency samples (ms) of completed tasks of ALL kinds —
   *  the admission-estimator + slow-task-baseline input (see module header). */
  private _latencies = new LatencyRing(WriteQueue.LATENCY_WINDOW);
  /** Per-kind rolling latency rings — REPORTING ONLY (write_latency_ms /
   *  apply_latency_ms). Never consumed by the estimator. */
  private _kindLatencies: Record<TaskKind, LatencyRing> = {
    write: new LatencyRing(WriteQueue.LATENCY_WINDOW),
    apply: new LatencyRing(WriteQueue.LATENCY_WINDOW),
  };
  /** Highest pending-queue depth observed since process start. */
  private _highWatermark = 0;
  /** Saturation warning latch (hysteresis — one log line per transition). */
  private _saturated = false;
  /** Deadline budget (ms), resolved from SOX_WRITEQ_DEADLINE_MS at creation. */
  private _deadlineBudgetMs = resolveDeadlineBudgetMs();
  /** Monotonic per-process counters (never reset). */
  private _counters = {
    tasks_completed: 0,
    write_tasks_completed: 0,
    apply_tasks_completed: 0,
    rejections_busy_size: 0,
    rejections_busy_deadline: 0,
    slow_tasks: 0,
  };
  /** Timestamps (ms epoch) of completed write tasks within the rolling throughput window. */
  private _completionTimes: number[] = [];
  /** Stderr log sink — injectable for tests. NEVER stdout ([inv:no-stdout-diagnostics]). */
  private _logSink: (line: string) => void = (line) => console.error(line);
  /** Slow-task floor (ms) — test-overridable to avoid real 1s sleeps in specs. */
  private _slowTaskMinMs = WriteQueue.SLOW_TASK_MIN_MS;
  /** The exact store key this queue was created with (the `forPath` argument —
   *  same key as the `instances` map / `metricsForPath`). */
  private readonly _storePath: string;
  /** (BL-252) Track the async pragmaSet promise so rapid open/close doesn't
   *  let it outlive the adapter. */
  private _pragmaSetPromise: Promise<void> = Promise.resolve();

  private constructor(adapter: StoreAdapter, dbPath: string, maxSize = DEFAULT_MAX_QUEUE_SIZE) {
    this.adapter = adapter;
    this._pragmaSetPromise = adapter.pragmaSet('busy_timeout', 3000).catch(() => {
      // Non-fatal — busy_timeout is a quality-of-life setting, not correctness.
    });
    this._maxSize = maxSize;
    this._storePath = dbPath;
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
  static async clearInstances(): Promise<void> {
    for (const [, q] of WriteQueue.instances) {
      q._cancelCheckpoint();
      await q._pragmaSetPromise;  // ensure async init completes before close
      try { await q.adapter.close(); } catch { /* already closed */ }
    }
    WriteQueue.instances.clear();
    WriteQueue.pending.clear();
  }

  /**
   * (BL-405) Checkpoint + close every WriteQueue's dedicated write connection,
   * for PRODUCTION shutdown. `coordinatedShutdown()` in backend.ts must call
   * this IN ADDITION to `closeAllAdapters()` — they close two DIFFERENT sets
   * of connections.
   *
   * Root cause this exists to fix: `WriteQueue._create()` opens its dedicated
   * write connection via the bare `openDb()` (see above), never via `getDb()`
   * — deliberately, so a queue's write connection is never shared with ad-hoc
   * `getDb()` callers. But `closeAllAdapters()` (db.ts) iterates ONLY
   * `getDb()`'s `adapterCache`, which a `WriteQueue` connection was NEVER
   * inserted into. Before this method existed, NOTHING in the shutdown path
   * ever closed or checkpointed the write queue's connection — reproduced
   * directly: 2000 real writes via the real `WriteQueue.forPath()` +
   * `getDb()` + `closeAllAdapters()` sequence (the exact calls
   * `handleToolCall`/`coordinatedShutdown` make) left the WAL at 4152 bytes
   * (down from 1,763,392 — `closeAllAdapters()`'s checkpoint on the OTHER,
   * `getDb`-cached connection still flushes most frames because WAL
   * checkpointing is a file-level operation, but cannot fully TRUNCATE while
   * the write queue's connection remains open) and left the write-queue
   * connection fully open and accepting further writes AFTER
   * `closeAllAdapters()` had already "finished". This also explains why
   * `memory_ping.store.last_checkpoint_at` stayed `null` even when a
   * checkpoint partially ran: `_lastCheckpointAt` is an instance field set
   * ONLY by `WriteQueue.walCheckpoint()` (below) — `closeDbWithLease`'s
   * checkpoint on the unrelated `getDb`-cached connection never touches it.
   *
   * Unlike `clearInstances()` (test-only; no checkpoint, no error surfacing —
   * a fresh-queue reset, not a durability guarantee), this method: (1) cancels
   * any pending WP-5 idle-checkpoint timer FIRST (otherwise that timer can
   * fire mid-shutdown or just after, throwing "database connection is not
   * open" against a connection this same method is about to close — observed
   * live in production telemetry, 11 occurrences across distinct pids on
   * 2026-08-03); (2) runs `PRAGMA wal_checkpoint(TRUNCATE)` explicitly and
   * records success via the same `_lastCheckpointAt` field `memory_ping`
   * reports; (3) LOGS a checkpoint failure instead of silently swallowing it
   * (BL-399 pattern — a failure this consequential must not vanish); (4)
   * closes the connection and clears the instance so a later `getDb`/
   * `WriteQueue.forPath` call for the same path opens fresh rather than
   * reusing a handle this method just tore down.
   */
  static async closeAllForShutdown(): Promise<void> {
    for (const [dbPath, q] of WriteQueue.instances) {
      q._cancelCheckpoint();
      try {
        await q._pragmaSetPromise;
      } catch {
        /* best effort — adapter may already be failing */
      }
      try {
        const row = await q.adapter.executeGet<{ frames_checkpointed?: number }>(
          'PRAGMA wal_checkpoint(TRUNCATE)',
        );
        const now = Date.now();
        q._lastCheckpointAt = now;
        WriteQueue._lastCheckpointByPath.set(dbPath, now);
        log.info('writequeue.shutdown.checkpoint', {
          store: dbPath,
          frames_checkpointed: row?.frames_checkpointed ?? null,
        });
      } catch (err) {
        // BL-405 / BL-399 pattern: a checkpoint failure here means the WAL
        // will NOT be truncated by this shutdown — that must be visible, not
        // a silent no-op indistinguishable from success.
        log.error('writequeue.shutdown.checkpoint_failed', {
          store: dbPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      try {
        await q.adapter.close();
      } catch (err) {
        log.error('writequeue.shutdown.close_failed', {
          store: dbPath,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    WriteQueue.instances.clear();
  }

  /**
   * Obtain (or create) the WriteQueue for a resolved store path.
   * The returned queue is a singleton — repeated calls return the same instance.
   * When `_bypass` is true, creates a new queue each time (no serialisation) so
   * the ordering negative control works.
   *
   * BL-402: the check (`instances.get`) and the set (`instances.set`) used to
   * be separated by an `await` on `_create()` → `openDb()`, so two callers
   * racing on the SAME never-before-seen `dbPath` both observed `undefined`
   * before either had populated the map, and both independently paid the full
   * `openDb()` sequence. Fixed by making the check-then-set atomic at the
   * SYNCHRONOUS start of the call: the first caller stores the in-flight
   * `_create()` PROMISE (not the resolved instance) in `pending` before any
   * `await` happens, so every concurrent caller for that path — including the
   * first one itself — awaits the exact same promise.
   */
  static forPath(dbPath: string, maxSize?: number): Promise<WriteQueue> {
    if (WriteQueue._bypass) {
      return WriteQueue._create(dbPath, maxSize);
    }
    const instance = WriteQueue.instances.get(dbPath);
    if (instance) return Promise.resolve(instance);

    let p = WriteQueue.pending.get(dbPath);
    if (!p) {
      p = WriteQueue._create(dbPath, maxSize).then((created) => {
        WriteQueue.instances.set(dbPath, created);
        WriteQueue.pending.delete(dbPath);
        return created;
      });
      p.catch(() => {
        // A failed open must not permanently wedge this path — the next
        // forPath() call gets a fresh attempt instead of a rejected promise
        // cached forever.
        WriteQueue.pending.delete(dbPath);
      });
      WriteQueue.pending.set(dbPath, p);
    }
    return p;
  }

  private static async _create(dbPath: string, maxSize?: number): Promise<WriteQueue> {
    const adapter = await openDb(dbPath);
    const queue = new WriteQueue(adapter, dbPath, maxSize);
    // Bypass serialization when the adapter handles concurrent writes natively
    // (e.g. Turso — async Rust with concurrent I/O). Sync adapters (better-sqlite3)
    // need serialization.
    if (!adapter.capabilities.needsWriteSerialization) {
      queue._noop = true;
    }
    return queue;
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

  /**
   * The store key this queue was created for — the exact string passed to
   * `forPath()` (the `instances` / `metricsForPath` key). Lets off-queue
   * subsystems (embed-pipeline metrics) key their per-store state identically.
   */
  get storePath(): string {
    return this._storePath;
  }

  /** (WP-5) Wall-clock epoch ms of the last successful WAL checkpoint. 0 = never. */
  get lastCheckpointAt(): number {
    return this._lastCheckpointAt;
  }

  /**
   * (WP-5) Static accessor: last checkpoint time for a given store path.
   * Returns 0 if never checkpointed for this path in this process.
   *
   * BL-405: reads the persistent `_lastCheckpointByPath` map, NOT the live
   * instance's own field — a live `WriteQueue` instance for `dbPath` may no
   * longer exist (its LAST act, moments ago, may have been exactly the
   * checkpoint this call is asking about — see `closeAllForShutdown()`), and
   * "no instance" must never be conflated with "never checkpointed".
   */
  static lastCheckpointAtForPath(dbPath: string): number {
    return WriteQueue._lastCheckpointByPath.get(dbPath) ?? 0;
  }

  /** (WP-5) Read the WAL file size in bytes from the filesystem. Returns 0 if unavailable. */
  walBytes(): number {
    if (this.adapter.config.type === 'turso') return 0; // remote — no local WAL file
    const dbPath = this.adapter.config.dbPath;
    if (!dbPath) return 0;
    try {
      return fs.statSync(dbPath + '-wal').size;
    } catch {
      return 0;
    }
  }

  /**
   * (WP-5) Run PRAGMA wal_checkpoint(TRUNCATE) to flush WAL to the main DB file
   * and truncate the WAL. Idempotent — safe to call repeatedly.
   * Returns the number of checkpointed frames, or -1 on error.
   */
  async walCheckpoint(): Promise<number> {
    try {
      const row = await this.adapter.executeGet<{ frames_checkpointed: number }>(
        'PRAGMA wal_checkpoint(TRUNCATE)',
      );
      const now = Date.now();
      this._lastCheckpointAt = now;
      WriteQueue._lastCheckpointByPath.set(this._storePath, now);
      return row?.frames_checkpointed ?? -1;
    } catch (err) {
      // BL-405 / BL-399 pattern: this used to be a bare `catch { return -1; }`
      // — the WP-5 idle-checkpoint timer's own failure (e.g. "database
      // connection is not open" when this fires against an already-closed
      // adapter, observed live in production: 11 occurrences across distinct
      // pids on 2026-08-03) vanished with zero trace. Still returns -1 (the
      // documented error sentinel), but now leaves a record.
      log.error('writequeue.checkpoint_failed', {
        store: this._storePath,
        error: err instanceof Error ? err.message : String(err),
      });
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
      this.walCheckpoint().catch(() => {}); // fire-and-forget
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
   *
   * `kind` (default 'write') labels the task's latency shape for METRIC
   * segregation only — ordering, admission control, and the E_BUSY contract
   * are identical for both kinds (see module header). Phase-B applyEmbedding
   * tasks pass 'apply'.
   *
   * `traceId` (BL-320, optional): correlation id for end-to-end tracing. When
   * omitted, reuses the currently-active trace context (set by an enclosing
   * `withTrace`/enqueue call — e.g. the Phase-A task's trace flows onto its
   * Phase-B `embed_apply` follow-up task automatically via `PendingEmbed.traceId`)
   * or mints a fresh one. `operation` runs INSIDE `withTrace(traceId, …)` so
   * every `log.*` call made anywhere inside it — including nested awaits —
   * carries this same id with no signature changes required downstream.
   */
  enqueue<T>(
    label: string,
    operation: (adapter: StoreAdapter) => T | Promise<T>,
    kind: TaskKind = 'write',
    traceId?: string,
  ): Promise<T> {
    const resolvedTraceId = traceId ?? traceIdOrNew();
    const storeKey = this.adapter.config.dbPath ?? this._storePath;

    // Bypass queue → execute immediately (no serialisation)
    // Two paths:
    //   1. _bypass (static) — global kill-switch (SOX_DISABLE_WRITE_QUEUE=1)
    //   2. _noop (instance) — per-adapter: Turso et al. handle concurrent I/O natively.
    if (WriteQueue._bypass || this._noop) {
      // (WP-5 / BL-405) New work arrived — cancel any pending idle checkpoint;
      // it is re-scheduled once this operation settles (below). The FIFO path
      // does this via _processNext's completion; the bypass/_noop path returns
      // EARLY above the shared scheduling code (line ~686), so without this the
      // 2s idle checkpoint never fires on the Turso adapter — memory_ping's
      // last_checkpoint_at stayed null forever in production and the WAL grew
      // until restart (BL-405). Scheduling after the settle reproduces the
      // WP-5 contract: checkpoint ~2s after the last write.
      this._cancelCheckpoint();
      const scheduleIdleCheckpoint = (): void => { this._scheduleIdleCheckpoint(); };
      const t0 = performance.now();
      log.info('writequeue.task.start', { trace_id: resolvedTraceId, store: storeKey, label, kind, mode: 'bypass' });
      try {
        const result = withTrace(resolvedTraceId, () => operation(this.adapter));
        if (result instanceof Promise) {
          return result.then(
            (v) => {
              this._trackCompletion();
              scheduleIdleCheckpoint();
              log.info('writequeue.task.finish', {
                trace_id: resolvedTraceId, store: storeKey, label, kind, mode: 'bypass',
                duration_ms: Math.round(performance.now() - t0),
              });
              return v;
            },
            (err) => {
              scheduleIdleCheckpoint();
              log.error('writequeue.task.error', {
                trace_id: resolvedTraceId, store: storeKey, label, kind, mode: 'bypass',
                duration_ms: Math.round(performance.now() - t0),
                error: err instanceof Error ? err.message : String(err),
              });
              throw err;
            },
          );
        }
        this._trackCompletion();
        scheduleIdleCheckpoint();
        log.info('writequeue.task.finish', {
          trace_id: resolvedTraceId, store: storeKey, label, kind, mode: 'bypass',
          duration_ms: Math.round(performance.now() - t0),
        });
        return Promise.resolve(result);
      } catch (err) {
        scheduleIdleCheckpoint();
        log.error('writequeue.task.error', {
          trace_id: resolvedTraceId, store: storeKey, label, kind, mode: 'bypass',
          duration_ms: Math.round(performance.now() - t0),
          error: err instanceof Error ? err.message : String(err),
        });
        return Promise.reject(err);
      }
    }

    // (WP-5) Cancel pending idle checkpoint — new work arrived
    this._cancelCheckpoint();

    this._enqueueCount++;
    log.info('writequeue.enqueue', {
      trace_id: resolvedTraceId,
      store: storeKey,
      label,
      kind,
      queue_depth: this.queue.length,
    });

    // Overflow guard (hard SIZE cap — CONTRACTS §C, pinned by the
    // queue-overflow chaos spec: retry_after_ms stays the constant 250 here)
    if (this.queue.length >= this._maxSize) {
      this._counters.rejections_busy_size++;
      this._logSink(
        `${LOG_PREFIX} REJECT E_BUSY(size) store=${this.adapter.config.dbPath ?? this._storePath} label=${label} ` +
        `depth=${this.queue.length} max=${this._maxSize}`,
      );
      log.warn('writequeue.reject.busy_size', {
        trace_id: resolvedTraceId, store: storeKey, label, depth: this.queue.length, max: this._maxSize,
      });
      return Promise.reject({
        code: 'E_BUSY',
        message: `Write queue for ${this.adapter.config.dbPath ?? this._storePath} is full (${this._maxSize} pending)`,
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
            `${LOG_PREFIX} REJECT E_BUSY(deadline) store=${this.adapter.config.dbPath ?? this._storePath} label=${label} ` +
            `depth=${this.queue.length} est_wait_ms=${Math.round(estimatedWaitMs)} ` +
            `budget_ms=${this._deadlineBudgetMs} recent_avg_ms=${Math.round(avgMs)} ` +
            `retry_after_ms=${retryAfterMs}`,
          );
          log.warn('writequeue.reject.busy_deadline', {
            trace_id: resolvedTraceId, store: storeKey, label,
            depth: this.queue.length, estimated_wait_ms: Math.round(estimatedWaitMs),
            budget_ms: this._deadlineBudgetMs, recent_avg_ms: Math.round(avgMs), retry_after_ms: retryAfterMs,
          });
          return Promise.reject({
            code: 'E_BUSY',
            message:
              `Write queue for ${this.adapter.config.dbPath ?? this._storePath} would exceed the deadline budget ` +
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
      this.queue.push({ label, kind, operation, resolve, reject, traceId: resolvedTraceId });
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
    await this.adapter.close();
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
   *
   * Every sample lands in the ALL-KIND ring (the estimator input — apply tasks
   * occupy the slot too) AND in the per-kind reporting ring.
   */
  _recordLatencySample(latencyMs: number, kind: TaskKind = 'write'): void {
    this._latencies.push(latencyMs);
    this._kindLatencies[kind].push(latencyMs);
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
    const writeSummary = summarizeLatencies(this._kindLatencies.write.values());
    const applySummary = summarizeLatencies(this._kindLatencies.apply.values());
    // Prune stale completion timestamps so the throughput reflects only the
    // last THROUGHPUT_WINDOW_MS of activity (defensive — _trackCompletion
    // already prunes on each write; this catches idle periods too).
    const cutoff = performance.now() - WriteQueue.THROUGHPUT_WINDOW_MS;
    while (this._completionTimes.length > 0 && this._completionTimes[0]! < cutoff) {
      this._completionTimes.shift();
    }
    return {
      queue_depth: this.queue.length,
      in_flight: this._processing ? 1 : 0,
      queue_max_size: this._maxSize,
      queue_high_watermark: this._highWatermark,
      saturated: this._saturated,
      // write_latency_ms is WRITE-KIND ONLY since the task-kind split (more
      // honest — Phase-B apply tasks no longer dilute the write distribution).
      write_latency_ms: {
        p50: writeSummary.p50,
        p99: writeSummary.p99,
        mean: writeSummary.mean,
        max: writeSummary.max,
      },
      apply_latency_ms: {
        p50: applySummary.p50,
        p99: applySummary.p99,
        mean: applySummary.mean,
        max: applySummary.max,
      },
      // Estimator input stays ALL-KIND (blended) — see module header.
      recent_avg_task_latency_ms: this._latencies.recentMean(WriteQueue.RECENT_AVG_WINDOW),
      deadline_budget_ms: this._deadlineBudgetMs,
      deadline_guard_enabled: !deadlineGuardDisabled(),
      throughput_writes_per_sec:
        this._completionTimes.length / (WriteQueue.THROUGHPUT_WINDOW_MS / 1000),
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
   * Record a completion timestamp and prune entries outside the rolling
   * throughput window. Called from _processNext (queue path) and from the
   * noop/bypass path in enqueue().
   */
  private _trackCompletion(): void {
    this._completionTimes.push(performance.now());
    const cutoff = performance.now() - WriteQueue.THROUGHPUT_WINDOW_MS;
    while (this._completionTimes.length > 0 && this._completionTimes[0]! < cutoff) {
      this._completionTimes.shift();
    }
  }

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
        `${LOG_PREFIX} SATURATION store=${this.adapter.config.dbPath ?? this._storePath} depth=${depth} ` +
        `enter_threshold=${enterAt} max=${this._maxSize}`,
      );
    } else if (this._saturated && depth <= clearAt) {
      this._saturated = false;
      this._logSink(
        `${LOG_PREFIX} SATURATION CLEARED store=${this.adapter.config.dbPath ?? this._storePath} depth=${depth} ` +
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
      const storeKey = this.adapter.config.dbPath ?? this._storePath;
      // BL-320: log the START of the dequeued task BEFORE awaiting it — this is
      // the line that makes a hung task (never resolves) visible in the log at
      // all, instead of leaving zero trace (the exact incident that motivated
      // this module: a recall hang left nothing behind).
      log.info('writequeue.task.start', {
        trace_id: item.traceId, store: storeKey, label: item.label, kind: item.kind,
        queue_depth: this.queue.length,
      });
      try {
        // Pass StoreAdapter directly — callers manage their own transaction scope
        // via adapter.transaction() when needed. Simple INSERT/UPDATE operations
        // should call adapter.transaction() themselves for consistency.
        const result = await withTrace(item.traceId, () => item.operation(this.adapter));
        item.resolve(result);
        log.info('writequeue.task.finish', {
          trace_id: item.traceId, store: storeKey, label: item.label, kind: item.kind,
          duration_ms: Math.round(performance.now() - startedAt),
        });
      } catch (err) {
        // WP-2: wrap raw SqliteError into CONTRACTS §B shape before surfacing.
        const wrapped = wrapDbError(err);
        log.error('writequeue.task.error', {
          trace_id: item.traceId, store: storeKey, label: item.label, kind: item.kind,
          duration_ms: Math.round(performance.now() - startedAt),
          error_code: wrapped.code,
          error: wrapped.message,
        });
        item.reject(wrapped);
      }
      // Post-completion bookkeeping — all synchronous, no async hops (BL-154).
      // Failed tasks count too: they occupied the slot, so their duration is
      // service time for the wait estimator either way.
      const latencyMs = performance.now() - startedAt;
      this._recordLatencySample(latencyMs, item.kind);
      this._counters.tasks_completed++;
      this._trackCompletion();
      if (item.kind === 'apply') this._counters.apply_tasks_completed++;
      else this._counters.write_tasks_completed++;
      if (
        latencyMs > this._slowTaskMinMs &&
        (avgAtStartMs === 0 || latencyMs > WriteQueue.SLOW_TASK_FACTOR * avgAtStartMs)
      ) {
        this._counters.slow_tasks++;
        this._logSink(
          `${LOG_PREFIX} SLOW task store=${this.adapter.config.dbPath ?? this._storePath} label=${item.label} ` +
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
