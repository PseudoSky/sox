/**
 * embed-pipeline.ts — Phase-B of the two-phase write path (2026-07-04 incident fix).
 *
 * THE CORE PROBLEM: memory_write used to run its ENTIRE body — including ONNX
 * bge embedding inference (~50–100ms warm, ~0.75s+ under CPU contention) — as
 * one task holding the serial WriteQueue slot. Under contention per-item latency
 * stretched, the queue backed up, and MCP clients timed out (2026-07-04: 6-item
 * batch timeout at queue depth 29). Expensive compute must not block writes.
 *
 * THE FIX — two-phase write:
 *   Phase A (holds the queue slot, NO embed, NO ONNX — fully synchronous):
 *     dedup, node insert, FTS (trigger-driven), tags/entities, sync non-embed
 *     enrichment, transactional outbox row, commit. See write.ts
 *     memoryWritePhaseA(). The fresh episode is BM25/temporal-recallable
 *     immediately.
 *   Phase B (this module, OFF the slot):
 *     compute the embedding via the worker-thread provider WITHOUT holding the
 *     WriteQueue slot, then insert vec_node (+ the deferred E8 near-dup pass)
 *     in a SHORT follow-up queue task. The episode becomes vec-recallable
 *     ~seconds later.
 *
 * BL-154 INVARIANT (chunk-write deadlock class): never enqueue onto a serial
 * WriteQueue from inside a task already running on that queue. Every scheduling
 * entry point in this module (`schedulePendingEmbeds`, `healMissingVectors`)
 * MUST be called from OUTSIDE any queue task — the memory-server handler awaits
 * the Phase-A enqueue first, and only then schedules Phase B; the periodic tick
 * is a plain interval callback. The apply tasks themselves are synchronous and
 * never enqueue.
 *
 * CLARIFICATION (2026-07-30 — three agents independently misread the
 * paragraph above as "Phase-B work must be serialized for correctness";
 * it does not say that and never did): BL-154 is about QUEUE RE-ENTRANCY
 * ONLY — calling `wq.enqueue()` from inside a callback already running on
 * that same serial queue deadlocks the queue itself, full stop, regardless
 * of backend. It says nothing about whether concurrent Phase-B PASSES
 * (e.g. two overlapping `schedulePendingEmbeds` calls, or a heal tick
 * overlapping an in-flight one) are safe to run at the same time against
 * the store — that is a SEPARATE question, answered by the adapter's own
 * concurrency contract (`AdapterCapabilities.needsWriteSerialization` /
 * `concurrentTransactions`), not by this invariant. Do NOT read this
 * comment as license to add serialization/locking around Phase-B calls to
 * "fix" a concurrency bug — Turso's concurrent-transaction behavior is
 * proven safe (owner directive, stated twice: do not change
 * `needsWriteSerialization`, `concurrentTransactions`, or
 * `multiprocessWrite`) and is a wholly separate mechanism from the
 * single-caller queue re-entrancy this paragraph actually protects against.
 *
 * FAILURE/RETRY: if Phase B fails (embed error, E_BUSY rejection of the apply
 * task, process death between phases) the node exists without a vector. That is
 * a DETECTED state, not a silent one:
 *   - `embedBacklogStats()` is the cheap SQL scan exposed via memory_ping's
 *     store block (`embed_backlog`) and folded into the enrichment health
 *     verdict (a dead Phase-B pipeline reads `stalled`, never silent).
 *   - `healMissingVectors()` runs on the periodic enrich tick and re-embeds
 *     every live episode missing its vec row (same recovery shape as
 *     reembedStore/BL-160, scoped to missing vectors only).
 *
 * KILL-SWITCH: SOX_SYNC_EMBED=1 restores the old synchronous behaviour (embed
 * inside the queue slot, near_dup in the response) for rollback without revert.
 * Read per-call so it can be flipped live. Default = async (owner decision:
 * fresh writes are BM25/temporal-recallable immediately, vec-recallable
 * ~seconds later).
 */

import { canonicalStorePath } from './store-path.js';
import { performance } from 'node:perf_hooks';
import { embed, vecToJson, vecToBuffer, getActiveEmbedModel, getConfiguredSyncEmbed } from './embed.js';
import { detectNearDup } from './neardup.js';
import { vectorDialectFor } from './dialect.js';
import type { NearDupResult } from './neardup.js';
import { applyNearDupResult, NEARDUP_THRESHOLD } from './enrich.js';
import type { StoreAdapter, AdapterTransaction, VectorDialect } from '@adhd/sox-store-adapter';
import { LatencyRing, summarizeLatencies } from './latency-stats.js';
import type { WriteQueue } from './write-queue.js';
import { log as tlog, newTraceId, traceIdOrNew, withTrace } from './telemetry.js';

/** Stderr log prefix — matches the writeq convention ([inv:no-stdout-diagnostics]). */
const LOG_PREFIX = '[memory-core embed-pipeline]';

// ── Kill-switch ───────────────────────────────────────────────────────────────

/**
 * The synchronous write-embed mode (`config embed.sync` — see EmbedConfig's
 * `sync` field for the documented purpose; SOX_SYNC_EMBED is its env input,
 * converted to typed config per ADR-0013). Read per-call so it can be
 * flipped without a restart.
 */
export function syncEmbedEnabled(): boolean {
  return getConfiguredSyncEmbed();
}

// ── Types ─────────────────────────────────────────────────────────────────────

/** A committed Phase-A episode awaiting its Phase-B embedding. */
export interface PendingEmbed {
  /** Episode uid — re-verified against the rowid before the vec insert. */
  uid: string;
  /** Committed node rowid the vec_node row must reference. */
  rowid: number;
  /** Text to embed (the episode content). */
  text: string;
  /**
   * `performance.now()` captured at Phase-A completion (memoryWritePhaseA) —
   * the time-to-vector start stamp. Monotonic and same-process, so no clock
   * skew (deliberately NOT derived from node.t_created wall time). ABSENT on
   * heal-path pendings: a crash/restart lost the in-process stamp, so heal
   * applies never pollute the time_to_vector distribution (they are counted
   * separately and aged via wall-clock heal_lag_ms instead).
   */
  startedAtMs?: number;
  /** BL-320: correlation id captured at Phase-A completion (the write-queue's
   *  task trace id) so Phase-B's embed + apply logs — which run OFF the queue
   *  slot, in a different task/tick — still carry the SAME trace_id as the
   *  originating write, end to end. Absent on heal-path pendings (no live
   *  request to correlate with); those get a fresh id per item instead. */
  traceId?: string;
}

export interface EmbedApplyResult {
  /**
   * applied — vec row inserted (near-dup ran if the node is still live).
   * exists  — a vec row already existed (heal/pipeline race; benign no-op).
   * gone    — rowid no longer resolves to this uid (node superseded by a
   *           different row or store rolled back); nothing written.
   */
  status: 'applied' | 'exists' | 'gone';
  /** Deferred E8 near-dup outcome (null unless status === 'applied' on a live node). */
  near_dup: NearDupResult | null;
}

export interface SchedulePendingResult {
  applied: number;
  exists: number;
  gone: number;
  failed: number;
}

export interface HealResult {
  scanned: number;
  healed: number;
  exists: number;
  gone: number;
  failed: number;
  /**
   * True when the heal pass hit its per-tick time budget and stopped early
   * before processing all SELECTed rows. The next tick picks up the remainder.
   */
  time_budget_exceeded: boolean;
  /** (BL-474) True when the caller could not acquire `_bgSlot` and skipped the
   *  scan entirely rather than waiting for it — see index.ts's
   *  withBackgroundSlotOrSkip. Always false/absent for a result that actually
   *  ran a scan (including scanned:0 — "ran and found nothing" is distinct
   *  from "did not run"). */
  skipped?: boolean;
}

/**
 * BL-88: Result of a stale-vector heal pass (healStaleVectors).
 * The pass runs whenever invoked (SOX_HEAL_STALE_VECTORS was an anti-feature
 * and is gone, ADR-0013) — a model-swap re-embed is driven by the operator
 * surface (`memory_curate reheal_stale`), never gated by an env var.
 */
export interface StaleHealResult {
  scanned: number;
  healed: number;
  gone: number;
  failed: number;
}

export interface EmbedBacklogStats {
  /** Live episodes (t_invalid IS NULL, non-empty content) with NO vec_node row. */
  count: number;
  /** t_created of the oldest such episode — the stall-age signal. */
  oldest_created_at: string | null;
}

/**
 * Default timeout for a SINGLE heal-path embed call (IPC to child process).
 * When an embed call exceeds this threshold, it is treated as a failure and
 * the item is left for a future heal pass. Set via SOX_EMBED_HEAL_TIMEOUT_MS.
 * Default: 120_000ms (2 minutes) — actual CoreML inference is ~335ms; the
 * headroom covers child-process serial queue wait when concurrent loops pile up.
 */
const DEFAULT_EMBED_HEAL_TIMEOUT_MS = 120_000;

function embedHealTimeoutMs(): number {
  const raw = Number(process.env['SOX_EMBED_HEAL_TIMEOUT_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EMBED_HEAL_TIMEOUT_MS;
}

/**
 * Per-tick time budget for healMissingVectors. When the cumulative embed duration
 * (including child-process queue wait) exceeds this threshold, the heal loop
 * stops early so the tick does not overlap with the next periodic enrich pass.
 * Set via SOX_EMBED_HEAL_TIME_BUDGET_MS. Default: 240_000ms (4 minutes),
 * leaving 1 minute of the 5-minute tick interval for the rest of the enrich pass
 * (batch enrich, queue completion).
 */
const DEFAULT_EMBED_HEAL_TIME_BUDGET_MS = 240_000;

function embedHealTimeBudgetMs(): number {
  const raw = Number(process.env['SOX_EMBED_HEAL_TIME_BUDGET_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_EMBED_HEAL_TIME_BUDGET_MS;
}

/** Rolling window (ms) for embed_throughput_per_sec computation. */
const EMBED_THROUGHPUT_WINDOW_MS = 60_000;

// ── Phase-B pipeline metrics (per-store, in-process) ──────────────────────────
//
// KEYING DECISION — PER-STORE, keyed by `WriteQueue.storePath` (the exact
// string passed to `WriteQueue.forPath`, i.e. the same key as
// `WriteQueue.metricsForPath`). The pipeline serves multiple stores from one
// process; a process-global aggregate would make memory_ping's per-store block
// unattributable (store X's ping showing store Y's backlog drain). Both
// scheduling entry points receive the store's WriteQueue, so the key is always
// available and matches the ping handler's `resolvedPath` by construction
// (same argument as WRITEQ_METRICS_INTEGRATION.md's key-matching note).
//
// CLOCK DECISION — time_to_vector uses `performance.now()` stamps captured at
// Phase-A completion (PendingEmbed.startedAtMs): monotonic, same-process, no
// clock skew. HEAL-PATH applies have no in-process Phase-A stamp (the crash
// lost it — and the live June backlog predates the pipeline entirely), so they
// are EXCLUDED from time_to_vector and tracked in a separate `heal_lag_ms`
// distribution derived from node.t_created — explicitly WALL-CLOCK and only an
// age indicator (subject to clock adjustments; a week-old crash orphan
// legitimately records a week). Mixing the two would destroy the headline
// metric: heal lags are 4–6 orders of magnitude larger than pipeline lags.

/** Rolling-window capacity — mirrors WriteQueue.LATENCY_WINDOW. */
const PIPELINE_LATENCY_WINDOW = 256;

interface EmbedPipelineCounters {
  /** Successful embedding computations in this module (pipeline + heal paths). */
  embeds_completed: number;
  /** schedulePendingEmbeds per-item failures — the stderr "Phase-B FAILURE"
   *  path (embed error OR E_BUSY rejection of the apply task). */
  embeds_failed: number;
  /** applyEmbedding outcomes across BOTH paths (pipeline + heal). */
  applies_applied: number;
  applies_exists: number;
  applies_gone: number;
  /** Heal-path subset: healMissingVectors applies that landed a vector
   *  (each also increments applies_applied). */
  heals_applied: number;
  /** healMissingVectors per-item failures — the stderr "heal FAILURE" path. */
  heals_failed: number;
}

interface EmbedPipelineState {
  /** Phase-A completion → vec_node applied (monotonic stamps; pipeline path only). */
  timeToVector: LatencyRing;
  /** Duration of the `embed()` call itself (worker-side computation; both paths).
   *  Distinct from any queue wait — measured around the embed call only. */
  embedDuration: LatencyRing;
  /** WALL-CLOCK age (now − node.t_created) of heal-path applied vectors. */
  healLag: LatencyRing;
  /** Rolling completion timestamps for throughput_writes_per_sec computation.
   *  Mirrors WriteQueue._completionTimes. */
  completionTimes: number[];
  /** True when the MOST RECENT healMissingVectors pass hit its per-tick time
   *  budget and stopped early. Reset at the start of each new heal pass. */
  healTimeBudgetExceeded: boolean;
  counters: EmbedPipelineCounters;
}

/** Pure snapshot shape — safe to expose from a ping handler. */
export interface EmbedPipelineMetrics {
  /** Phase-A commit → vec_node application, ms (monotonic, pipeline path only).
   *  The user-facing eventual-consistency window: how long a fresh write is
   *  BM25-only before it becomes vec-recallable. */
  time_to_vector_ms: { p50: number; p99: number; mean: number; max: number };
  time_to_vector_samples: number;
  /** Duration of the `embed()` call (both paths), ms. Includes the forked
   *  child process's serial-queue wait time — NOT just the ~335ms ONNX
   *  inference. The child serializes all IPC requests through a promise chain,
   *  so when multiple concurrent loops (heal + fresh-write pipelines) compete,
   *  the measured duration includes queue wait. See embed_throughput_per_sec
   *  for actual effective throughput. */
  embed_duration_ms: { p50: number; p99: number; mean: number; max: number };
  embed_duration_samples: number;
  /** WALL-CLOCK (t_created-based) age of heal-path applied vectors, ms. */
  heal_lag_ms: { p50: number; p99: number; mean: number; max: number };
  heal_lag_samples: number;
  /** Rolling effective embed throughput (completions per second), computed
   *  over the last EMBED_THROUGHPUT_WINDOW_MS (60s). Mirrors the
   *  WriteQueue.throughput_writes_per_sec pattern — a pragmatic real-world
   *  throughput signal that accounts for ALL time: child queue wait, IPC,
   *  actual ONNX inference, and parent-side concurrency overhead.
   *  Expected: ~3/sec (335ms × 3 concurrent loops) under CoreML with the
   *  single child process. Below ~0.5/sec suggests a stuck child or stalled
   *  pipeline. */
  embed_throughput_per_sec: number;
  /** True when the MOST RECENT healMissingVectors pass hit its time budget
   *  and stopped early. When true for consecutive ping samples, reduce
   *  healMissingVectors' per-tick limit or increase the 5-min tick interval. */
  heal_time_budget_exceeded: boolean;
  counters: EmbedPipelineCounters;
}

/** Per-store metrics registry — same keying as WriteQueue.instances. */
const pipelineStates = new Map<string, EmbedPipelineState>();

function stateFor(storeKey: string): EmbedPipelineState {
  let s = pipelineStates.get(canonicalStorePath(storeKey));
  if (!s) {
    s = {
      timeToVector: new LatencyRing(PIPELINE_LATENCY_WINDOW),
      embedDuration: new LatencyRing(PIPELINE_LATENCY_WINDOW),
      healLag: new LatencyRing(PIPELINE_LATENCY_WINDOW),
      completionTimes: [],
      healTimeBudgetExceeded: false,
      counters: {
        embeds_completed: 0,
        embeds_failed: 0,
        applies_applied: 0,
        applies_exists: 0,
        applies_gone: 0,
        heals_applied: 0,
        heals_failed: 0,
      },
    };
    pipelineStates.set(canonicalStorePath(storeKey), s);
  }
  return s;
}

/** Shared apply-outcome bookkeeping (both paths). */
function recordApplyOutcome(state: EmbedPipelineState, status: EmbedApplyResult['status']): void {
  if (status === 'applied') state.counters.applies_applied++;
  else if (status === 'exists') state.counters.applies_exists++;
  else state.counters.applies_gone++;
}

/**
 * Log a discarded apply outcome (`exists` or `gone`) — logging.SKILL follow-on:
 * thousands of these previously happened with zero log lines, which is part
 * of why a frozen backlog + climbing embeds_completed took six agents to
 * diagnose. No-op for 'applied' (that path already logs via
 * `embed_pipeline.apply.finish` / `heal.finish`). Never throws (telemetry.ts's
 * `emit` swallows internally).
 */
function logApplyDiscarded(status: EmbedApplyResult['status'], uid: string, rowid: number): void {
  if (status === 'applied') return;
  tlog.info('embed_pipeline.apply.discarded', { uid, rowid, reason: status });
}

/**
 * Record an embed completion timestamp for the throughput-per-sec rolling
 * window. Prunes entries outside the window. Called after each successful
 * embed() call (both pipeline and heal paths).
 */
function trackEmbedCompletion(state: EmbedPipelineState): void {
  state.completionTimes.push(performance.now());
  const cutoff = performance.now() - EMBED_THROUGHPUT_WINDOW_MS;
  while (state.completionTimes.length > 0 && state.completionTimes[0]! < cutoff) {
    state.completionTimes.shift();
  }
}

/** Compute embed throughput (completions/sec) from the rolling window. */
function embedThroughput(state: EmbedPipelineState): number {
  return state.completionTimes.length / (EMBED_THROUGHPUT_WINDOW_MS / 1000);
}

function summaryOf(ring: LatencyRing): { p50: number; p99: number; mean: number; max: number } {
  const s = summarizeLatencies(ring.values());
  return { p50: s.p50, p99: s.p99, mean: s.mean, max: s.max };
}

/**
 * Pure, read-only snapshot of the Phase-B pipeline metrics for a store — zero
 * side effects, callable from memory_ping. Returns null when no Phase-B
 * activity has touched this store in this process (mirrors
 * WriteQueue.metricsForPath's null-until-first-activity honesty).
 *
 * `storeKey` must be the SAME string used for `WriteQueue.forPath` (the ping
 * handler's `resolvedPath`).
 */
export function getEmbedPipelineMetrics(storeKey: string): EmbedPipelineMetrics | null {
  const s = pipelineStates.get(canonicalStorePath(storeKey));
  if (!s) return null;
  return {
    time_to_vector_ms: summaryOf(s.timeToVector),
    time_to_vector_samples: s.timeToVector.count,
    embed_duration_ms: summaryOf(s.embedDuration),
    embed_duration_samples: s.embedDuration.count,
    heal_lag_ms: summaryOf(s.healLag),
    heal_lag_samples: s.healLag.count,
    embed_throughput_per_sec: embedThroughput(s),
    heal_time_budget_exceeded: s.healTimeBudgetExceeded,
    counters: { ...s.counters },
  };
}

/** Test seam: drop all per-store pipeline metrics state (fresh-process shape). */
export function _resetEmbedPipelineMetricsForTest(): void {
  pipelineStates.clear();
}

// ── Phase-B apply (SHORT queue task body — synchronous) ───────────────────────

/**
 * Insert the computed embedding for a Phase-A-committed episode and run the
 * deferred E8 near-dup pass. Synchronous and short — designed to be the body of
 * a WriteQueue task (or to run inline in the SOX_SYNC_EMBED composition).
 *
 * Write→vec ordering per node: the vec insert references the committed rowid
 * and is guarded by a uid match, so a rowid that no longer belongs to this
 * episode is never written. A node invalidated between phases still receives
 * its vector (bi-temporal: the row is kept and point-in-time recall may use
 * it) but the near-dup pass — which can invalidate OTHER nodes — is skipped.
 */
export async function applyEmbedding(
  tx: AdapterTransaction,
  pending: PendingEmbed,
  vec: Float32Array,
  useBinaryFormat: boolean,
  vectorDialect: VectorDialect,
): Promise<EmbedApplyResult> {
  const row = await tx.executeGet<{ uid: string; t_invalid: string | null }>(
    'SELECT uid, t_invalid FROM node WHERE rowid = ?',
    [pending.rowid],
  );
  if (!row || row.uid !== pending.uid) {
    return { status: 'gone', near_dup: null };
  }

  const existing = await tx.executeGet<{ node_id: number }>(
    'SELECT node_id FROM vec_node WHERE node_id = ?',
    [pending.rowid],
  );
  if (existing) {
    return { status: 'exists', near_dup: null };
  }

  const serialized = useBinaryFormat ? vecToBuffer(vec) : vecToJson(vec);
  await tx.executeRun(
    'INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)',
    [pending.rowid, serialized],
  );

  // BL-88: stamp the embed_model on the node row in the same transaction as
  // the vec insert. This is the SINGLE choke-point for all write/update/heal
  // paths — every vector that lands on any node goes through applyEmbedding.
  // NULL rows are honest: provenance unknown (pre-BL-88 or not yet embedded).
  await tx.executeRun(
    'UPDATE node SET embed_model = ? WHERE rowid = ?',
    [getActiveEmbedModel() ?? 'unknown', pending.rowid],
  );

  // Deferred E8 near-dup: only for still-live nodes (near-dup may invalidate
  // the OLDER neighbour — never run it on behalf of an already-dead node).
  let nearDup: NearDupResult | null = null;
  if (row.t_invalid === null) {
    try {
      nearDup = await detectNearDup(tx, pending.rowid, vec, NEARDUP_THRESHOLD, vectorDialect);
    } catch (err) {
      // NOT a silent swallow (fixed 2026-07-30 — this bare `catch {}` was the
      // mechanism that hid the embed-backfill stampede for five weeks): this
      // runs AFTER the vec_node INSERT above has already committed, so
      // applyEmbedding still returns status:'applied' and every caller-side
      // counter (applies_applied, embeds_completed) reports success — a
      // failure here was invisible in every metric memory_ping exposes. It
      // is also NOT purely the historical "KNN may fail on empty stores"
      // case anymore: concurrent Turso transactions on one shared connection
      // can throw "Transaction error: cannot start a transaction within a
      // transaction" here (index.ts's fire-and-forget
      // `void schedulePendingEmbeds(...)` call sites let two Phase-B passes
      // genuinely overlap). `warn`, not `debug`: silently degrading near-dup
      // detection is a real quality loss on its own, not just a missing log
      // line, and this catch can no longer assume the failure is benign.
      tlog.warn('embed_pipeline.neardup.error', {
        uid: pending.uid,
        rowid: pending.rowid,
        error: err instanceof Error ? err.message : String(err),
      });
      nearDup = null;
    }
    if (nearDup !== null) {
      await applyNearDupResult(tx, pending.rowid, nearDup);
    }
  }

  return { status: 'applied', near_dup: nearDup };
}

// ── In-flight tracking (test/drain seam) ──────────────────────────────────────

const inFlight = new Set<Promise<unknown>>();

function track<T>(p: Promise<T>): Promise<T> {
  inFlight.add(p);
  void p.finally(() => inFlight.delete(p));
  return p;
}

/**
 * Resolve when every currently-scheduled Phase-B pipeline has settled.
 * Used by tests (deterministic drain) and available to shutdown paths.
 */
export async function flushPendingEmbeds(): Promise<void> {
  while (inFlight.size > 0) {
    await Promise.allSettled([...inFlight]);
  }
}

// ── Phase-B scheduling (call from OUTSIDE any queue task — BL-154) ────────────

/**
 * Run Phase B for a batch of Phase-A-committed episodes: embed each text OFF
 * the queue slot (worker-thread provider), then apply each vector in a SHORT
 * follow-up queue task.
 *
 * NEVER call this from inside a WriteQueue task (BL-154). The memory-server
 * handlers await the Phase-A enqueue, then call this with the returned
 * pendings — the Phase-A task has fully released its slot by then.
 *
 * Never throws: per-item failures are counted, logged to stderr, and left for
 * the periodic heal (`healMissingVectors`) to repair.
 */
export async function schedulePendingEmbeds(
  wq: WriteQueue,
  pendings: PendingEmbed[],
  opts: {
    logSink?: (line: string) => void;
    useBinaryFormat?: boolean;
    /**
     * BL-381: REQUIRED, not optional. Three memory-server call sites supplied
     * `useBinaryFormat` and silently dropped the old optional backend flag,
     * which sent the vec0 KNN statement at Turso on every `memory_write`.
     * Keeping this mandatory makes an omission a compile error.
     */
    vectorDialect: VectorDialect;
  },
): Promise<SchedulePendingResult> {
  const log = opts.logSink ?? ((line: string) => tlog.debug('embed_pipeline.schedule_pending', { message: line }));
  const useBinaryFormat = opts.useBinaryFormat ?? false;
  const vectorDialect = opts.vectorDialect;
  const out: SchedulePendingResult = { applied: 0, exists: 0, gone: 0, failed: 0 };
  if (pendings.length === 0) return out;
  const metrics = stateFor(wq.storePath);

  const run = (async () => {
    for (const p of pendings) {
      // BL-320: reuse the originating write's trace id (threaded via
      // PendingEmbed.traceId from Phase A) so embed + apply logs correlate
      // with the write that produced them, even though Phase B runs OFF the
      // queue slot in a separate tick.
      const traceId = p.traceId ?? traceIdOrNew();
      await withTrace(traceId, async () => {
        try {
          // embed() itself logs embed.start/finish/error/timeout (telemetry.ts +
          // embed.ts) — this call site adds the uid/rowid it doesn't know about
          // via the pipeline-specific event below, and keeps its own duration
          // measurement for the embed-pipeline metrics ring.
          const embedStartMs = performance.now();
          // BL-401: 'write' is passed explicitly, not left to the default —
          // this is the pipeline sibling of the heal/reembed paths below, and
          // the three of them are the exact set BL-319 was filed about.
          const vec = await embed(p.text, 'write'); // off-slot: worker-thread ONNX
          const embedDurationMs = performance.now() - embedStartMs;
          tlog.debug('embed_pipeline.embed.finish', { uid: p.uid, rowid: p.rowid, duration_ms: Math.round(embedDurationMs) });
          metrics.embedDuration.push(embedDurationMs);
          metrics.counters.embeds_completed++;
          trackEmbedCompletion(metrics);
          const r = await wq.enqueue(
            `embed_apply:${p.uid}`,
            async (qdb) => {
              return qdb.transaction(async (tx) => {
                return applyEmbedding(tx, p, vec, useBinaryFormat, vectorDialect);
              }, { mode: 'immediate' });
            },
            'apply',
            traceId,
          );
          out[r.status === 'applied' ? 'applied' : r.status === 'exists' ? 'exists' : 'gone']++;
          recordApplyOutcome(metrics, r.status);
          tlog.info('embed_pipeline.apply.finish', { uid: p.uid, rowid: p.rowid, status: r.status });
          logApplyDiscarded(r.status, p.uid, p.rowid);
          // time_to_vector: Phase-A completion stamp → apply-task settled (the
          // vec row is durably visible). Only genuine pipeline applies with an
          // in-process monotonic stamp are recorded — see the clock decision.
          if (r.status === 'applied' && p.startedAtMs !== undefined) {
            metrics.timeToVector.push(performance.now() - p.startedAtMs);
          }
        } catch (err) {
          out.failed++;
          metrics.counters.embeds_failed++;
          const msg = err instanceof Error ? err.message : JSON.stringify(err);
          log(
            `${LOG_PREFIX} Phase-B FAILURE uid=${p.uid} rowid=${p.rowid}: ${msg} — ` +
              `vector deferred to the periodic heal pass`,
          );
          tlog.error('embed_pipeline.phaseB.error', { uid: p.uid, rowid: p.rowid, error: msg });
        }
      });
    }
    return out;
  })();

  return track(run);
}

// ── Backlog observability (cheap SQL — safe from a ping handler) ──────────────

/**
 * Count live episodes missing their vec_node row (Phase B not yet landed, or
 * lost to a crash). Cheap: one indexed scan over live episodes with a vec0
 * point-lookup per row. Exposed via memory_ping's store block.
 *
 * Invalidated nodes are deliberately EXCLUDED: a node invalidated between
 * phases may legitimately never receive a vector, and must not pin the backlog
 * above zero forever.
 */
export async function embedBacklogStats(adapter: StoreAdapter): Promise<EmbedBacklogStats> {
  const row = await adapter.executeGet<{ c: number; o: string | null }>(
    `SELECT COUNT(*) AS c, MIN(n.t_created) AS o
     FROM node n
     WHERE n.kind = 'episode'
       AND n.t_invalid IS NULL
       AND n.content IS NOT NULL AND n.content != ''
       AND NOT EXISTS (SELECT 1 FROM vec_node v WHERE v.node_id = n.rowid)`,
  );
  return { count: row?.c ?? 0, oldest_created_at: row?.o ?? null };
}

// ── Periodic heal (the Phase-B crash-recovery path) ───────────────────────────

/**
 * Re-embed every live episode missing its vec_node row. Runs on the periodic
 * enrich tick in memory-server, mirroring reembedStore's missing-vector
 * recovery (BL-160) but scoped to vec_node gaps only.
 *
 * `db` is used for the read scan; each apply routes through `wq` as a short
 * task so the single-writer contract holds. Called from the interval callback
 * — OUTSIDE any queue task (BL-154).
 *
 * Bounded: at most `opts.limit` nodes per pass; the next tick picks up the
 * remainder. DEBT-EMBED-HEAL-DEAD-DEFAULT-LIMIT-001: `limit` is REQUIRED,
 * deliberately — every production caller passes an explicit value (the
 * periodic-tick and drain-pass call sites in
 * `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`
 * all pass `{ limit: drainBatchLimit() }`, which resolves to
 * `DEFAULT_DRAIN_BATCH = 64` — see index.ts's `drainBatchLimit()` for the
 * real production batch size). A `?? 500` fallback here previously read as
 * the operating value when it was actually unreachable dead code, which
 * shaped a mis-framed CRITICAL bug report before anyone traced the callers.
 */
export async function healMissingVectors(
  adapter: StoreAdapter,
  wq: WriteQueue,
  opts: { limit: number; logSink?: (line: string) => void },
): Promise<HealResult> {
  const out: HealResult = { scanned: 0, healed: 0, exists: 0, gone: 0, failed: 0, time_budget_exceeded: false };
  // BL-434: the heal tick establishes its OWN ambient trace context.
  //
  // Trace ids propagate ambiently through `AsyncLocalStorage`, and
  // `withContendedStage` only PROPAGATES an ambient context — it never creates
  // one. The heal tick runs outside any WriteQueue task (BL-154), so nothing
  // upstream had established a context and every `embed.start`/`embed.finish`
  // emitted from this path carried `trace_id: null`: heal embeds were the one
  // embed population that could not be joined to the work that requested them.
  //
  // Two levels, deliberately: one id per TICK (so tick-level records and any
  // future `tlog` call added here are correlated by construction, not by a
  // remembered convention), and one id per ROW unit of work (so a given
  // `embed.*` line identifies the single row it re-embedded rather than the
  // whole 500-row pass). `embed_pipeline.heal.row.start` is the join record
  // carrying `tick_trace_id`, which is what makes the two levels reconcilable
  // from the JSONL alone.
  const tickTraceId = newTraceId();
  return withTrace(tickTraceId, () => _healMissingVectorsPass(adapter, wq, opts, out, tickTraceId));
}

async function _healMissingVectorsPass(
  adapter: StoreAdapter,
  wq: WriteQueue,
  opts: { limit: number; logSink?: (line: string) => void },
  out: HealResult,
  tickTraceId: string,
): Promise<HealResult> {
  const limit = opts.limit;
  const log = opts?.logSink ?? ((line: string) => tlog.debug('embed_pipeline.heal', { message: line }));
  const metrics = stateFor(wq.storePath);

  // Reset the time-budget flag at the start of each heal pass.
  metrics.healTimeBudgetExceeded = false;

  const useBinaryFormat = adapter.capabilities.nativeVectors;
  const vectorDialect = await vectorDialectFor(adapter);
  const result = await adapter.executeAll<{ rowid: number; uid: string; content: string; t_created: string | null }>(
    `SELECT n.rowid, n.uid, n.content, n.t_created
     FROM node n
     WHERE n.kind = 'episode'
       AND n.t_invalid IS NULL
       AND n.content IS NOT NULL AND n.content != ''
       AND NOT EXISTS (SELECT 1 FROM vec_node v WHERE v.node_id = n.rowid)
     ORDER BY n.rowid ASC
     LIMIT ?`,
    [limit],
  );
  const rows = result.rows;

  const timeBudgetMs = embedHealTimeBudgetMs();
  const tickTimeoutMs = embedHealTimeoutMs();
  const tickStartedAt = performance.now();

  out.scanned = rows.length;
  for (const r of rows) {
    // Time-budget guard: stop early if the cumulative wall-clock duration of
    // this heal pass exceeds the per-tick budget. This prevents overlapping
    // ticks when the child-process serial queue is backed up and individual
    // embed calls take minutes instead of milliseconds.
    if (performance.now() - tickStartedAt > timeBudgetMs) {
      const remaining = out.scanned - (out.healed + out.exists + out.gone + out.failed);
      log(
        `${LOG_PREFIX} heal TIME BUDGET EXCEEDED after ${performance.now() - tickStartedAt}ms ` +
        `(${out.healed} healed, ${out.failed} failed, ${remaining} remaining of ${out.scanned})`,
      );
      metrics.healTimeBudgetExceeded = true;
      out.time_budget_exceeded = true;
      break;
    }

    // NO startedAtMs: the in-process Phase-A stamp is gone (crash/restart) —
    // heal applies must not pollute the time_to_vector distribution.
    const pending: PendingEmbed = { uid: r.uid, rowid: r.rowid, text: r.content };
    // BL-434: one trace id per row unit of work, joined to the tick by the
    // `heal.row.start` record below. Everything nested inside — `embed.start`,
    // `embed.finish`, the `sox.stage.embed.*` wait/work pair, the apply task's
    // queue records — inherits it ambiently with no signature changes.
    const rowTraceId = newTraceId();
    await withTrace(rowTraceId, async () => {
      tlog.info('embed_pipeline.heal.row.start', {
        uid: pending.uid,
        rowid: pending.rowid,
        tick_trace_id: tickTraceId,
      });
      try {
        const embedStartMs = performance.now();
        // Use a timeout on the embed IPC call so a stuck child process does not
        // hang the heal loop indefinitely. The timeout value is configurable via
        // SOX_EMBED_HEAL_TIMEOUT_MS (default 120s — far above the ~335ms actual
        // CoreML inference, but generous enough to not false-positive under
        // moderate concurrent-loop queue wait).
        const vec = await embedWithTimeout(pending.text, tickTimeoutMs);
        metrics.embedDuration.push(performance.now() - embedStartMs);
        metrics.counters.embeds_completed++;
        trackEmbedCompletion(metrics);
        const applied = await wq.enqueue(
          `embed_heal:${pending.uid}`,
          async (qdb) => {
            return qdb.transaction(async (tx) => {
              return applyEmbedding(tx, pending, vec, useBinaryFormat, vectorDialect);
            }, { mode: 'immediate' });
          },
          'apply',
        );
        recordApplyOutcome(metrics, applied.status);
        if (applied.status === 'applied') {
          out.healed++;
          metrics.counters.heals_applied++;
          // heal_lag: WALL-CLOCK age of the healed node (t_created-based —
          // labeled as such; the only signal that survives a process restart).
          const createdMs = r.t_created === null ? NaN : Date.parse(r.t_created);
          if (Number.isFinite(createdMs)) {
            metrics.healLag.push(Math.max(0, Date.now() - createdMs));
          }
        } else if (applied.status === 'exists') out.exists++;
        else out.gone++;
        logApplyDiscarded(applied.status, pending.uid, pending.rowid);
      } catch (err) {
        out.failed++;
        metrics.counters.heals_failed++;
        const msg = err instanceof Error ? err.message : JSON.stringify(err);
        log(`${LOG_PREFIX} heal FAILURE uid=${pending.uid} rowid=${pending.rowid}: ${msg}`);
        tlog.error('embed_pipeline.heal.row.error', {
          uid: pending.uid,
          rowid: pending.rowid,
          tick_trace_id: tickTraceId,
          error: msg,
        });
      }
    });
  }
  return out;
}

/**
 * Call embed() with a wall-clock timeout. If the underlying IPC to the
 * forked child process does not resolve within `timeoutMs`, rejects with a
 * TimeoutError. This prevents a stuck child process from hanging the heal
 * loop indefinitely (the child's serial queue can back up significantly when
 * multiple concurrent loops compete for the single process).
 */
async function embedWithTimeout(text: string, timeoutMs: number): Promise<Float32Array> {
  return new Promise<Float32Array>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`embed() timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    // BL-401/BL-319: the heal path, named. This is the path whose bypassing of
    // write-path instrumentation left `time_to_vector_ms` with zero samples.
    embed(text, 'heal').then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

// ── Stale-vector heal (BL-88) ────────────────────────────────────────────────

/**
 * Re-embed live episodes whose `embed_model` is non-null and != the active model.
 *
 * ALWAYS runs when invoked (SOX_HEAL_STALE_VECTORS was an anti-feature,
 * ADR-0013): the operator surface `memory_curate reheal_stale` is the
 * interface, not an env gate. The active model is resolved once at the start
 * of each pass via `getActiveEmbedModel()`.
 *
 * SAFE PATTERN (BL-154): never call this from inside a WriteQueue task. Call it
 * from an interval callback (like healMissingVectors) — OUTSIDE any queue task.
 * Each apply is enqueued as a SHORT 'apply'-kind task, same slot-safe pattern as
 * healMissingVectors.
 *
 * Bounded: at most `opts.limit` nodes per pass. The next tick picks up the
 * remainder. DEBT-EMBED-HEAL-DEAD-DEFAULT-LIMIT-001: `limit` is REQUIRED,
 * deliberately — the only reachable production caller is
 * `libs/memory-core/src/curate.ts`'s `reheal_stale` handler, which always
 * resolves and passes an explicit `limit` (clamped to `REHEAL_MAX_LIMIT`,
 * defaulting to `REHEAL_DEFAULT_LIMIT` when the operator omits it) — a
 * `?? 500` fallback here was unreachable dead code that misrepresented the
 * real batch-size story (see the sibling comment on `healMissingVectors`).
 *
 * NOTE: NULL-model rows (pre-BL-88) are deliberately EXCLUDED — NULL is honest
 * ("provenance unknown") and must not be treated as stale. Only rows with a
 * non-null embed_model that differs from the current active model are targets.
 *
 * Wired to the operator surface only (`memory_curate reheal_stale`), never to
 * an automatic tick: a model-swap re-embed of an entire store is an explicit
 * operator decision.
 */
export async function healStaleVectors(
  adapter: StoreAdapter,
  wq: WriteQueue,
  opts: { limit: number; logSink?: (line: string) => void },
): Promise<StaleHealResult> {
  const out: StaleHealResult = { scanned: 0, healed: 0, gone: 0, failed: 0 };

  // BL-434: same two-level trace context as healMissingVectors — the reembed
  // path is a third sibling of write/heal and had the identical `trace_id: null`
  // hole. See the comment there for why `withContendedStage` cannot supply this.
  const tickTraceId = newTraceId();
  return withTrace(tickTraceId, () => _healStaleVectorsPass(adapter, wq, opts, out, tickTraceId));
}

async function _healStaleVectorsPass(
  adapter: StoreAdapter,
  wq: WriteQueue,
  opts: { limit: number; logSink?: (line: string) => void },
  out: StaleHealResult,
  tickTraceId: string,
): Promise<StaleHealResult> {
  const activeModel = getActiveEmbedModel() ?? 'unknown';
  const limit = opts.limit;
  const log = opts?.logSink ?? ((line: string) => tlog.debug('embed_pipeline.heal_stale_vectors', { message: line }));
  const metrics = stateFor(wq.storePath);
  const useBinaryFormat = adapter.capabilities.nativeVectors;
  const vectorDialect = await vectorDialectFor(adapter);

  // BL-88: only target rows with a non-null embed_model that differs from the
  // currently active model. Rows with embed_model IS NULL are pre-provenance
  // and are left for the operator to handle via the full reembed path.
  const result = await adapter.executeAll<{ rowid: number; uid: string; content: string; t_created: string | null }>(
    `SELECT n.rowid, n.uid, n.content, n.t_created
     FROM node n
     WHERE n.kind = 'episode'
       AND n.t_invalid IS NULL
       AND n.content IS NOT NULL AND n.content != ''
       AND n.embed_model IS NOT NULL
       AND n.embed_model != ?
       AND EXISTS (SELECT 1 FROM vec_node v WHERE v.node_id = n.rowid)
     ORDER BY n.rowid ASC
     LIMIT ?`,
    [activeModel, limit],
  );
  const rows = result.rows;

  out.scanned = rows.length;
  for (const r of rows) {
    // NO startedAtMs: heal paths must not pollute the pipeline time_to_vector distribution.
    const pending: PendingEmbed = { uid: r.uid, rowid: r.rowid, text: r.content };
    const rowTraceId = newTraceId();
    await withTrace(rowTraceId, async () => {
      tlog.info('embed_pipeline.reembed.row.start', {
        uid: pending.uid,
        rowid: pending.rowid,
        tick_trace_id: tickTraceId,
      });
      try {
        // Delete the stale vec_node row first so applyEmbedding sees no existing row
        // and proceeds with the INSERT (vec0 tables have no UPDATE trigger — BL-91).
        await wq.enqueue(
          `embed_stale_del:${pending.uid}`,
          async (tx) => {
            await tx.executeRun('DELETE FROM vec_node WHERE node_id = CAST(? AS INTEGER)', [pending.rowid]);
            return { deleted: true };
          },
          'apply',
        );

        const embedStartMs = performance.now();
        // BL-401: the stale-vector model-migration path — a third sibling, not a
        // variant of 'heal'. Fusing them would hide a model migration inside the
        // repair pass's distribution.
        const vec = await embed(pending.text, 'reembed');
        metrics.embedDuration.push(performance.now() - embedStartMs);
        metrics.counters.embeds_completed++;

        const applied = await wq.enqueue(
          `embed_stale_apply:${pending.uid}`,
          async (qdb) => {
            return qdb.transaction(async (tx) => {
              return applyEmbedding(tx, pending, vec, useBinaryFormat, vectorDialect);
            }, { mode: 'immediate' });
          },
          'apply',
        );
        recordApplyOutcome(metrics, applied.status);
        if (applied.status === 'applied') {
          out.healed++;
          metrics.counters.heals_applied++;
          // heal_lag: WALL-CLOCK age of the stale node (same shape as healMissingVectors).
          const createdMs = r.t_created === null ? NaN : Date.parse(r.t_created);
          if (Number.isFinite(createdMs)) {
            metrics.healLag.push(Math.max(0, Date.now() - createdMs));
          }
        } else {
          out.gone++;
        }
        logApplyDiscarded(applied.status, pending.uid, pending.rowid);
      } catch (err) {
        out.failed++;
        metrics.counters.heals_failed++;
        const msg = err instanceof Error ? err.message : JSON.stringify(err);
        log(`${LOG_PREFIX} stale-heal FAILURE uid=${pending.uid} rowid=${pending.rowid}: ${msg}`);
        tlog.error('embed_pipeline.reembed.row.error', {
          uid: pending.uid,
          rowid: pending.rowid,
          tick_trace_id: tickTraceId,
          error: msg,
        });
      }
    });
  }
  return out;
}
