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
 *      (BL-445) The snapshot carries a `mode: 'fifo' | 'bypass'` discriminator
 *      and BOTH paths feed it. Until 2026-08-05 every one of these signals was
 *      recorded exclusively in `_processNext` — i.e. only on the FIFO path — so
 *      on the PRODUCTION backend (Turso sets `needsWriteSerialization: false`,
 *      which sets `_noop`, which routes every write through `_runBypass`) the
 *      block reported 8 structurally-unreachable zeros, 3 configuration echoes
 *      and exactly one live measurement. `_settleBypass` now records the same
 *      signals from the bypass path, and the four fields that describe a queue
 *      that does not exist there report `null` rather than a `0`/`false` no
 *      code could ever change.
 *
 *      This is not cosmetic: `recent_avg_task_latency_ms` is the deadline
 *      guard's ONLY input, so an unfed ring keeps that guard permanently
 *      disabled regardless of where the guard is placed (BL-394).
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

import { canonicalStorePath } from './store-path.js';
import * as fs from 'node:fs';
import { performance } from 'node:perf_hooks';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { wrapDbError } from './errors.js';
import { LatencyRing, summarizeLatencies } from './latency-stats.js';
import { MEMORY_CORE_STAGES } from './stages.js';
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
  /**
   * (BL-445) WHICH EXECUTION PATH PRODUCED THIS SNAPSHOT — read this field
   * before interpreting any other.
   *
   *   'fifo'   — the serialized queue path (`_enqueueQueued`/`_processNext`).
   *              Every field below is a real measurement of a real queue.
   *   'bypass' — the adapter reports `needsWriteSerialization: false` (Turso —
   *              async Rust with concurrent I/O), so `enqueue` runs the
   *              operation immediately and THERE IS NO QUEUE. The global
   *              kill-switch SOX_DISABLE_WRITE_QUEUE=1 lands here too.
   *
   * This discriminator exists because the queue-shaped fields previously
   * reported `0`/`false` on the bypass path — values indistinguishable from a
   * healthy idle queue, and unchangeable by any code path (BL-334's failure
   * mode). They now report `null` there instead, and this field says why.
   */
  mode: 'fifo' | 'bypass';
  /**
   * (BL-394) WHETHER THE SIZE CAP AND DEADLINE GUARD CAN FIRE AT ALL.
   *
   *   'active'   — `mode: 'fifo'`. Both guards are live: `queue_max_size` and
   *                `deadline_budget_ms` are the values actually consulted, and
   *                `counters.rejections_busy_*` can move.
   *   'inactive — adapter handles concurrency natively'
   *              — `mode: 'bypass'`. NEITHER guard is reachable. The size cap
   *                is expressed over a queue that is never pushed to
   *                (`0 >= 100` forever) and the deadline guard sits on the far
   *                side of the same early return. `rejections_busy_*` reading
   *                `0` here is not evidence of a healthy queue — it is
   *                evidence the code that increments them cannot run.
   *
   * OWNER RULING 2026-08-05: this is deliberate and no bound is being added.
   * Turso handles concurrent writes natively, the live store shows zero
   * rejections, and there is no evidence a bound is needed. If a stress harness
   * later shows a knee, a bound gets added then and sized from data. What was
   * defective — and is fixed — is that the surface CLAIMED these guards were
   * configured and active while they structurally could not fire.
   */
  admission_control: 'active' | 'inactive — adapter handles concurrency natively';
  /** Items waiting in the queue right now (excludes the in-flight task).
   *  `null` in `mode: 'bypass'` — nothing is ever queued on that path. */
  queue_depth: number | null;
  /** Concurrently-executing operations. `mode: 'fifo'` — 1 while a task runs,
   *  else 0 (the FIFO path admits exactly one at a time). `mode: 'bypass'` — a
   *  REAL count of operations between entry and settle, which on that path is
   *  genuinely unbounded and is the only meaningful occupancy measure. */
  in_flight: number;
  /** Configured hard size cap — the value the overflow guard actually compares
   *  against. (BL-394) `null` in `mode: 'bypass'`: there is no queue for a size
   *  cap to bound, so printing the configured `100` claimed a guard that cannot
   *  fire. See `admission_control`. */
  queue_max_size: number | null;
  /** Highest queue depth observed since process start.
   *  `null` in `mode: 'bypass'`. */
  queue_high_watermark: number | null;
  /** True while the saturation warning is latched (hysteresis).
   *  `null` in `mode: 'bypass'` — saturation is a property of queue depth. */
  saturated: boolean | null;
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
  /** Current deadline budget (SOX_WRITEQ_DEADLINE_MS or default).
   *  (BL-394) `null` in `mode: 'bypass'` — no budget is consulted there. */
  deadline_budget_ms: number | null;
  /** True only when the deadline guard can actually reject an enqueue.
   *  False when SOX_WRITEQ_NO_DEADLINE=1 (kill-switch active) — and (BL-394)
   *  false in `mode: 'bypass'`, where the guard sits on the far side of the
   *  early return and can never evaluate regardless of the kill-switch. Read
   *  `admission_control` to tell the two reasons apart. */
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
  /**
   * BL-401: called by `_processNext` at the instant this item reaches the head
   * of the queue and is about to run — i.e. the ADMISSION boundary. This is the
   * single point that turns queue wait from something reconstructed by joining
   * `writequeue.enqueue` to `writequeue.task.start` on `trace_id` + `label`
   * (`docs/observability/README.md` §5.3, never once actually computed) into a
   * directly measured `sox.stage.wait_ms`.
   *
   * Ordering, admission control and the E_BUSY contract are untouched: this is
   * one synchronous callback invoked from the existing dequeue point.
   */
  onAdmit: () => void;
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
 * WAL checkpointing (DEBT-004/DEBT-005, 2026-08-17): this class used to own a
 * private debounced idle-checkpoint timer (WP-5/BL-123) that fired an UNGATED
 * `PRAGMA wal_checkpoint(TRUNCATE)` — zero `storeQuiescence` coordination,
 * unsafe under concurrency > 1, and a second mechanism competing with the
 * store-adapter's own idle flush. Per owner directive, that private
 * implementation was DELETED, not coordinated with — WAL checkpointing is now
 * owned exclusively by `TursoAdapterImpl`'s `_armIdleFlush()`/
 * `_checkWalCapAndFlush()` (`libs/data/store/store-adapter/src/turso-adapter.ts`),
 * which every store this queue opens (via `openDb()` → `createStoreAdapter()`,
 * default `STORE_ADAPTER=turso`) inherits automatically and transparently —
 * no call from this class required. See that file's `_walFlushStrategy` doc
 * comment for the full gated-close-ceremony contract. `closeAllForShutdown()`
 * below now routes its explicit end-of-life flush through `adapter.close()`
 * (the adapter's own public surface) instead of a second raw PRAGMA.
 *
 * ⚠️ COVERAGE GAP (reported, not silently assumed away — see BL-591): the
 * legacy `STORE_ADAPTER=sqlite` opt-in path (`SqliteAdapterImpl`, never the
 * production default) has NO analogous idle-flush or wal-cap-flush mechanism
 * of any kind — `sqlite-adapter.ts` contains zero `wal_checkpoint` calls. A
 * long-lived process on that adapter now relies solely on SQLite's own
 * built-in ~1000-page PASSIVE auto-checkpoint (never TRUNCATE, so the -wal
 * file never shrinks back down) with nothing calling TRUNCATE, ever. This
 * queue cannot fix that without editing `store-adapter` (out of this task's
 * scope) — flagged here per the task's explicit "report, don't assume away"
 * requirement.
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
  /**
   * (DEBT-004/DEBT-005) Wall-clock time (ms) of the last time THIS process
   * asked the adapter to flush — i.e. `closeAllForShutdown()`'s `adapter.close()`
   * call. Never updated during normal operation any more: the adapter's own
   * idle flush (`_armIdleFlush()`) runs silently inside `TursoAdapterImpl`
   * with no callback surface back to this class, so `memory_ping.store.
   * last_checkpoint_at` no longer reflects periodic idle checkpoints, only
   * this process's own shutdown. See the class doc comment's DEBT-004/005
   * note and BL-591 (filed) for the observability gap this leaves.
   * 0 = never (this process has not yet shut down its queue for this store).
   */
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
  /**
   * (BL-445) Operations currently executing on the BYPASS path — incremented
   * on entry to `_runBypass` and decremented at every settle point (both
   * success branches and both error branches).
   *
   * `_processing` cannot serve this purpose: it is a boolean, set only in
   * `_enqueueQueued`, and the bypass path is precisely where an unbounded
   * number of operations can be in flight at once. This is the only occupancy
   * measure that means anything on the backend production actually runs, and
   * `getMetrics()` reports it as `in_flight` there.
   */
  private _bypassInFlight = 0;
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
  private _logSink: (line: string) => void = (line) => log.debug('write_queue.diagnostic', { message: line });
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
   * ONLY here — `closeDbWithLease`'s checkpoint on the unrelated
   * `getDb`-cached connection never touches it.
   *
   * (DEBT-004/DEBT-005, 2026-08-17) Previously this method issued its OWN raw
   * `PRAGMA wal_checkpoint(TRUNCATE)` directly against `q.adapter` — a second,
   * ungated checkpoint mechanism, run immediately BEFORE `adapter.close()`
   * itself also performs a full gated checkpoint ceremony on a writable Turso
   * adapter (PASSIVE always, then quiescence-gated TRUNCATE — see
   * `TursoAdapterImpl.close()`). That was a double-checkpoint on every
   * shutdown, the second one entirely unsafe (no `storeQuiescence` gate) and
   * exactly the private mechanism the owner directed be eliminated. Fixed:
   * this method now performs its flush ENTIRELY through `adapter.close()` —
   * the adapter's own public surface — and records `_lastCheckpointAt` as the
   * timestamp of that close call. Unlike a manually-run PRAGMA, `close()` on
   * a `SqliteAdapter` does not itself checkpoint (see the class doc comment's
   * coverage-gap note) — `_lastCheckpointAt` there records "shutdown ran",
   * not "a TRUNCATE definitely happened"; this was already an approximation
   * before (a `busy=1` PRAGMA result was previously still recorded as
   * success) and is not a new weakening of the contract.
   *
   * Unlike `clearInstances()` (test-only; no error surfacing — a fresh-queue
   * reset, not a durability guarantee), this method LOGS a close failure
   * instead of silently swallowing it (BL-399 pattern — a failure this
   * consequential must not vanish), then clears the instance so a later
   * `getDb`/`WriteQueue.forPath` call for the same path opens fresh rather
   * than reusing a handle this method just tore down.
   */
  static async closeAllForShutdown(): Promise<void> {
    for (const [dbPath, q] of WriteQueue.instances) {
      try {
        await q._pragmaSetPromise;
      } catch {
        /* best effort — adapter may already be failing */
      }
      try {
        // (DEBT-004/DEBT-005) adapter.close() IS the flush — see doc comment
        // above. No separate raw PRAGMA call.
        await q.adapter.close();
        const now = Date.now();
        q._lastCheckpointAt = now;
        // Canonical key — see lastCheckpointAtForPath for why this matters.
        WriteQueue._lastCheckpointByPath.set(canonicalStorePath(dbPath), now);
        log.info('writequeue.shutdown.checkpoint', { store: dbPath });
      } catch (err) {
        // BL-405 / BL-399 pattern: a close failure here means the WAL may
        // NOT have been truncated by this shutdown — that must be visible,
        // not a silent no-op indistinguishable from success.
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
  static forPath(rawDbPath: string, maxSize?: number): Promise<WriteQueue> {
    // Key on the CANONICAL identity, not the caller's spelling. A Map key gets
    // no symlink resolution from the OS, so `/var/folders/x` and
    // `/private/var/folders/x` were two different queues for one store — see
    // `lastCheckpointAtForPath` for what that cost.
    const dbPath = canonicalStorePath(rawDbPath);
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

  /**
   * (DEBT-004/DEBT-005) Wall-clock epoch ms of the last time THIS instance
   * asked the adapter to flush (i.e. went through `closeAllForShutdown()`).
   * 0 = never. See the class doc comment: this no longer tracks periodic
   * idle-checkpoint activity, only shutdown.
   */
  get lastCheckpointAt(): number {
    return this._lastCheckpointAt;
  }

  /**
   * (DEBT-004/DEBT-005) Static accessor: last time `closeAllForShutdown()`
   * flushed a given store path. Returns 0 if that has never happened for
   * this process (which, post-DEBT-004/005, is the common case for a
   * long-lived process — the store adapter's own idle flush now runs with
   * zero visibility back to this class; see the class doc comment).
   *
   * BL-405: reads the persistent `_lastCheckpointByPath` map, NOT the live
   * instance's own field — a live `WriteQueue` instance for `dbPath` may no
   * longer exist (its LAST act, moments ago, may have been exactly the
   * checkpoint this call is asking about — see `closeAllForShutdown()`), and
   * "no instance" must never be conflated with "never checkpointed".
   */
  static lastCheckpointAtForPath(rawDbPath: string): number {
    // MUST canonicalize: this ledger is written under `forPath`'s canonical
    // key, and callers reach it with whatever spelling they happen to hold —
    // on macOS that is `/private/var/...` vs `/var/...` for the exact same
    // path (see BL-405's original incident: a raw-vs-canonical spelling
    // mismatch here silently zeroed this ledger for every caller).
    return WriteQueue._lastCheckpointByPath.get(canonicalStorePath(rawDbPath)) ?? 0;
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
      // (DEBT-004/DEBT-005) WAL checkpointing is no longer this class's
      // concern on the bypass path (Turso, the production case): the adapter
      // itself arms an idle flush from INSIDE `_trackOp()` on every op this
      // bypass path drives — see the class doc comment. Nothing to
      // cancel/reschedule here any more.
      // BL-401: the bypass path is the one the LIVE service takes (the Turso
      // adapter sets `_noop`). Instrumenting only the FIFO path below would
      // have produced a stage that reads zero in production while passing every
      // test — BL-319's defect on the exact code path it was found in.
      // `admit` is already-resolved by construction here: there is no queue to
      // wait for, so `wait_ms ≈ 0` is a measured claim, not a missing one.
      return MEMORY_CORE_STAGES.withContendedStage(
        'write_queue',
        'bypass',
        () => Promise.resolve(),
        (): Promise<T> => this._runBypass(label, operation, kind, resolvedTraceId, storeKey),
      );
    }

    this._enqueueCount++;
    log.info('writequeue.enqueue', {
      trace_id: resolvedTraceId,
      store: storeKey,
      label,
      kind,
      queue_depth: this.queue.length,
    });

    return this._enqueueQueued(label, operation, kind, resolvedTraceId, storeKey);
  }

  /** (BUG-MEMORY-001 §2.3) Bounded attempts for a retryable-classified bypass
   *  failure: 1 initial attempt + 2 retries. Matches
   *  `TursoAdapterImpl._runTransaction`'s own `maxRetries=3` default
   *  (turso-adapter.ts) for consistency. Not configurable in this pass — see
   *  SPEC-BUG-MEMORY-001.md §5. */
  private static readonly BYPASS_MAX_ATTEMPTS = 3;

  /** The `_bypass`/`_noop` execution body, extracted verbatim from `enqueue` so
   *  it can be handed to `withContendedStage` as the `work` half of the pair.
   *
   * (BUG-MEMORY-001 §2.3) Previously called `operation(this.adapter)` exactly
   * once and rethrew any rejection VERBATIM — the raw driver exception, never
   * wrapped via `wrapDbError` (unlike `_processNext`, the FIFO/SQLite-only
   * path, which always wraps). This was defect (A) of BUG-MEMORY-001: the one
   * path production actually takes (Turso, `_noop=true`) was the one path
   * with zero error-wrapping or retry parity with the FIFO path.
   *
   * Now: the operation is retried up to `BYPASS_MAX_ATTEMPTS` times, but ONLY
   * when `wrapDbError(err).retryable` is true (i.e. a classified transient
   * contention condition — see errors.ts §2.2). A full replay of the ENTIRE
   * `operation` closure from scratch is safe by construction for every
   * memory-core write path (content-hash dedup runs BEFORE the transaction,
   * inserts happen INSIDE a transaction that rolls back on any thrown error —
   * see write.ts and SPEC-BUG-MEMORY-001.md §2.3's proof) — there is
   * deliberately no resumable/checkpointed retry.
   *
   * The final rejection is ALWAYS a `StorageError` (never a raw driver
   * exception) — this is a deliberate, documented behavior change; see
   * SPEC-BUG-MEMORY-001.md §2.3.1 for the two existing tests this changes.
   *
   * Telemetry contract (unchanged): `writequeue.task.start`/
   * `writequeue.task.finish`/`writequeue.task.error` each fire exactly ONCE
   * per logical `enqueue()` call (not once per attempt), and `_settleBypass`
   * (counters, latency ring) is touched exactly once. A NEW,
   * once-per-RETRY-attempt event, `writequeue.task.retry`, is emitted for
   * each attempt beyond the first that is about to be retried.
   */
  private async _runBypass<T>(
    label: string,
    operation: (adapter: StoreAdapter) => T | Promise<T>,
    kind: TaskKind,
    resolvedTraceId: string,
    storeKey: string,
  ): Promise<T> {
    const t0 = performance.now();
    // (BL-445) Rolling average BEFORE this task — the slow-task baseline,
    // captured at the same point `_processNext` captures it (:1029).
    const avgAtStartMs = this._latencies.recentMean(WriteQueue.RECENT_AVG_WINDOW);
    this._bypassInFlight++;
    log.info('writequeue.task.start', { trace_id: resolvedTraceId, store: storeKey, label, kind, mode: 'bypass' });

    let attempt = 0;
    for (;;) {
      try {
        const result = await withTrace(resolvedTraceId, () => operation(this.adapter));
        this._settleBypass(t0, avgAtStartMs, kind, label);
        log.info('writequeue.task.finish', {
          trace_id: resolvedTraceId, store: storeKey, label, kind, mode: 'bypass',
          duration_ms: Math.round(performance.now() - t0),
        });
        return result;
      } catch (err) {
        const wrapped = wrapDbError(err);
        attempt++;
        if (!wrapped.retryable || attempt >= WriteQueue.BYPASS_MAX_ATTEMPTS) {
          this._settleBypass(t0, avgAtStartMs, kind, label);
          log.error('writequeue.task.error', {
            trace_id: resolvedTraceId, store: storeKey, label, kind, mode: 'bypass',
            duration_ms: Math.round(performance.now() - t0),
            error: wrapped.message,
            error_code: wrapped.code,
            attempts: attempt,
          });
          // Final failure — always a StorageError, never a raw driver exception.
          throw wrapped;
        }
        const delayMs = (wrapped.retry_after_ms ?? 250) * attempt; // 250ms, then 500ms
        log.warn('writequeue.task.retry', {
          trace_id: resolvedTraceId, store: storeKey, label, kind, mode: 'bypass',
          attempt, max_attempts: WriteQueue.BYPASS_MAX_ATTEMPTS, delay_ms: delayMs, error_code: wrapped.code,
        });
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  /**
   * (BL-445) Post-completion bookkeeping for the BYPASS path — the exact set of
   * signals `_processNext` records at :1068-1084, minus the two that describe a
   * queue (`_checkSaturation`, which is a function of `queue.length`, and the
   * dequeue-time depth logging).
   *
   * Called from ALL FOUR settle points of `_runBypass`: async-resolve,
   * async-reject, sync-return and sync-throw. The two error branches are
   * deliberate and match `_processNext`'s own comment at :1066-1068 — a failed
   * task still occupied service time, so excluding it would make the wait
   * estimator systematically under-count exactly when the store is unhealthy.
   *
   * Before this existed, the bypass path called only `_trackCompletion()`, so
   * on the production backend `tasks_completed`, `write_/apply_tasks_completed`,
   * `slow_tasks`, the two latency distributions and `recent_avg_task_latency_ms`
   * were all permanently zero — and `recent_avg_task_latency_ms` is the
   * deadline guard's ONLY input (`_enqueueQueued`, gated by `if (avgMs > 0)`),
   * which is why BL-394's "hoist the guard above the early return" fix was a
   * no-op until this landed.
   *
   * All synchronous, no async hops (BL-154).
   */
  private _settleBypass(
    startedAt: number,
    avgAtStartMs: number,
    kind: TaskKind,
    label: string,
  ): void {
    const latencyMs = performance.now() - startedAt;
    if (this._bypassInFlight > 0) this._bypassInFlight--;
    this._recordLatencySample(latencyMs, kind);
    this._counters.tasks_completed++;
    if (kind === 'apply') this._counters.apply_tasks_completed++;
    else this._counters.write_tasks_completed++;
    this._trackCompletion();
    if (
      latencyMs > this._slowTaskMinMs &&
      (avgAtStartMs === 0 || latencyMs > WriteQueue.SLOW_TASK_FACTOR * avgAtStartMs)
    ) {
      this._counters.slow_tasks++;
      this._logSink(
        `${LOG_PREFIX} SLOW task store=${this.adapter.config.dbPath ?? this._storePath} label=${label} ` +
        `latency_ms=${Math.round(latencyMs)} recent_avg_ms=${Math.round(avgAtStartMs)} ` +
        `in_flight=${this._bypassInFlight}`,
      );
    }
  }

  /**
   * (BL-445) True when this queue's `enqueue` takes the bypass path — either
   * because the adapter handles concurrent writes natively (`_noop`, e.g.
   * Turso) or because the global kill-switch SOX_DISABLE_WRITE_QUEUE=1 is set.
   * The single source of truth for `getMetrics().mode`, and it mirrors the
   * branch condition in `enqueue` exactly.
   */
  private get _bypassActive(): boolean {
    return WriteQueue._bypass || this._noop;
  }

  /** The FIFO path, extracted verbatim from `enqueue`. Admission control, the
   *  E_BUSY contract, ordering and every log line are unchanged; the only
   *  addition is the `onAdmit` callback carried on the queue item, which
   *  closes the wait/work pair at the dequeue point in `_processNext`. */
  private _enqueueQueued<T>(
    label: string,
    operation: (adapter: StoreAdapter) => T | Promise<T>,
    kind: TaskKind,
    resolvedTraceId: string,
    storeKey: string,
  ): Promise<T> {
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

    // BL-401 §5.2/§3.6: the wait/work pair, at the site the research document
    // named as the flagship unmeasured contended resource. `admit` resolves the
    // instant `_processNext` dequeues this item, so `wait_ms` is queue time and
    // `work_ms` is execution time — measured, not predicted. (`estimated_wait_ms`
    // in the admission guard above remains a PREDICTION derived from work
    // latency; this is the observation it was standing in for. The two are
    // deliberately independent: `LatencyRing` stays the control input, because a
    // cumulative histogram cannot answer "mean of the most recent N".)
    let grantAdmission: () => void = () => {};
    const admitted = new Promise<void>((res) => {
      grantAdmission = res;
    });
    const settled = new Promise<T>((resolve, reject) => {
      this.queue.push({
        label,
        kind,
        operation,
        resolve,
        reject,
        traceId: resolvedTraceId,
        onAdmit: grantAdmission,
      });
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
    return MEMORY_CORE_STAGES.withContendedStage(
      'write_queue',
      'queued',
      () => admitted,
      () => settled,
    );
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
    // (BL-445) The queue-shaped fields describe a queue that does not exist on
    // the bypass path. Reporting `0`/`false` there is not a measurement — it is
    // BL-334's failure mode: a value no code can change, indistinguishable from
    // a healthy idle queue. They report `null` instead, and `mode` says why.
    const bypass = this._bypassActive;
    return {
      mode: bypass ? 'bypass' : 'fifo',
      // (BL-394) Neither admission guard is reachable on the bypass path: the
      // size cap compares a queue that is never pushed to, and the deadline
      // guard sits past the same early return. Say so, rather than printing
      // the configured values as though they were in force.
      admission_control: bypass
        ? 'inactive — adapter handles concurrency natively'
        : 'active',
      queue_depth: bypass ? null : this.queue.length,
      // in_flight is REAL on both paths — the FIFO path admits exactly one
      // operation at a time, the bypass path admits as many as arrive.
      in_flight: bypass ? this._bypassInFlight : (this._processing ? 1 : 0),
      queue_max_size: bypass ? null : this._maxSize,
      queue_high_watermark: bypass ? null : this._highWatermark,
      saturated: bypass ? null : this._saturated,
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
      deadline_budget_ms: bypass ? null : this._deadlineBudgetMs,
      // The literal field BL-394 quotes as the defect. It reported `true` on
      // the production backend for a guard that structurally cannot evaluate.
      deadline_guard_enabled: !bypass && !deadlineGuardDisabled(),
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
  static metricsForPath(rawDbPath: string): WriteQueueMetrics | null {
    // Canonical key: `instances` is keyed by canonical store identity (see
    // `forPath`). Looking up the caller's raw spelling returned null for a
    // store that very much exists.
    const dbPath = canonicalStorePath(rawDbPath);
    const q = WriteQueue.instances.get(dbPath);
    return q ? q.getMetrics() : null;
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  /**
   * Record a completion timestamp and prune entries outside the rolling
   * throughput window. Called from `_processNext` (FIFO path) and from
   * `_settleBypass` (bypass path) — this was, until BL-445, the ONLY signal
   * the bypass path recorded, which is why `throughput_writes_per_sec` was
   * live in production while every counter beside it read zero.
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
      // BL-401: the admission boundary. Must fire BEFORE the operation is
      // awaited — it is what separates `wait_ms` from `work_ms`, and a failed
      // task must still have been admitted, so it is not in the try block.
      item.onAdmit();
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
    // (DEBT-004/DEBT-005) No more private idle-checkpoint scheduling here —
    // the adapter arms its own idle flush from `_trackOp()` on every op this
    // FIFO path drives, on the SqliteAdapter this path serves too (though see
    // the class doc comment's coverage-gap note: SqliteAdapterImpl has no
    // such mechanism to arm).
    this._processing = false;
  }
}
