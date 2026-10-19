/**
 * recluster-job.ts — SR-9: an OBSERVABLE global `recluster`.
 *
 * ## The defect this module removes
 *
 * Before this, `memory_curate {op:'recluster'}` with no filters enqueued a
 * full-pass `enrich` trigger row and returned `{enqueued:true, seq}` — a claim
 * with no check. A caller could not tell whether the reorganisation had
 * completed, failed, or was still pending; "enqueued" was the final answer.
 * D-C's knowledge layer must know when a reorganisation has actually finished.
 *
 * ## The mechanism (and why it adds NO table)
 *
 * The job state lives ON the trigger row it describes, under
 * `organizer_queue.payload.job` — not in a new table. The trigger row already
 * exists, is never pruned, and its `seq` is the handle a caller correlates
 * with. This choice is deliberate engineering, not laziness:
 *
 *   - **No schema growth.** `DDL_BASE` is applied to every store on every open,
 *     and the store's post-open WAL baseline is load-bearing for calibrated
 *     tests (BL-586/BL-572 measure the adapter's idle-flush threshold against
 *     it; BL-625 already had to recalibrate when *other* schema additions grew
 *     it). A new table enlarges that baseline on every store that will never
 *     use the feature. Putting the state on the row leaves the baseline of a
 *     non-recluster store EXACTLY as it was.
 *   - **No drift.** Job state and its trigger row are the same row, written
 *     together; they cannot diverge.
 *
 * The enrich tick runs the pass and settles the job in place:
 *
 *   pending ──(full pass ok)────▶ completed  (+ the resulting partition)
 *      ├──────(pass FAILED)─────▶ failed     (+ the error)
 *      └──────(pass SKIPPED)────▶ skipped    (+ the skip reason)
 *
 * `skipped` is distinct from `completed` on purpose. The enrich child can run to
 * completion (`ok:true`) while its cluster STEP is skipped — the mixed-model
 * guard (null `enrich_ver`) or the incremental-no-neighbour guard sets
 * `cluster_pass_skipped` — leaving the partition byte-for-byte unchanged. Reporting
 * that `completed` told a caller a reorganisation had happened when none had; the
 * caller now reads `skipped` + `skip_reason` and re-requests once the store is
 * reindexed. `skipped` is terminal, exactly like `failed`.
 *
 * A caller polls `recluster_status {job_id}` to a terminal state. The state is
 * persisted, so it is readable after a store reopen and across processes.
 *
 * ## Why the tick settles it (not this module inline)
 *
 * The full pass on a large store blocks the serial WriteQueue slot for its
 * whole duration and can out-wait the MCP client timeout (BL-186). The request
 * stays deferred to the tick; this module makes that deferral OBSERVABLE.
 *
 * ## Failure vs pending
 *
 * A failed pass leaves the trigger row open (retryable) but marks the JOB
 * `failed` — terminal, so the caller is never left polling a request whose
 * pass errored. Re-requesting mints a new job. A job only ever transitions
 * `pending → {completed|failed|skipped}`; a terminal job is never resurrected.
 *
 * [inv:no-mcp] — returns plain result objects, never MCP ToolResults.
 */

import * as crypto from 'node:crypto';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import type { ClusterSubsetResult } from './cluster.js';
import type { MemoryFilter } from './memory-filters.js';
import { log } from './telemetry.js';

/**
 * Stored job status. `pending` (queued) → `running` (claimed by one process) →
 * `completed | failed | skipped`. The caller-facing {@link ReclusterJobState}
 * vocabulary is derived from this, never stored, so every stored row written
 * before `running` existed stays valid.
 */
export type ReclusterJobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped';

/**
 * Caller-facing state (0f6ebefa AC-B2): queued | running | completed | degraded
 * | failed. `degraded` is a pass that ran but could not produce a partition
 * (nodeCap refusal, budget abort, cluster step skipped) — stored as `skipped`.
 */
export type ReclusterJobState = 'queued' | 'running' | 'completed' | 'degraded' | 'failed';

/** `global` = whole-store full pass; `subset` = filtered (lens) pass. */
export type ReclusterJobScope = 'global' | 'subset';

/** Machine-readable why a job is `degraded` / `failed`. */
export type ReclusterJobReason =
  | 'nodeCap'
  | 'budget'
  | 'child_failed'
  | 'cluster_skipped'
  | 'owner_lost'
  | (string & {});

/** Maps the stored status to the caller-facing state. */
export function reclusterJobState(status: ReclusterJobStatus): ReclusterJobState {
  switch (status) {
    case 'pending':
      return 'queued';
    case 'running':
      return 'running';
    case 'completed':
      return 'completed';
    case 'skipped':
      return 'degraded';
    case 'failed':
      return 'failed';
    default:
      return unknownReclusterStatus(status);
  }
}

/**
 * Explicit runtime fallback for a stored status outside {@link ReclusterJobStatus}
 * (a corrupt or newer-writer envelope; `parseJobEnvelope` casts the stored string).
 * The `never` parameter makes `reclusterJobState`'s switch exhaustive at compile
 * time: adding a status member without a case is a type error here (90ba140a
 * AC-D2). At runtime the value reads as `failed` — terminal, so pollers stop —
 * and is traced so it never passes silently.
 */
function unknownReclusterStatus(status: never): ReclusterJobState {
  log.warn('recluster_job.unknown_status', { status: String(status) });
  return 'failed';
}

/** A terminal state is final: nothing transitions out of it. */
export function isTerminalReclusterState(state: ReclusterJobState): boolean {
  return state === 'completed' || state === 'degraded' || state === 'failed';
}

/** What a filtered (subset) job retains of its `clusterSubset` result. */
export interface ReclusterSubsetSummary {
  persisted: boolean;
  provenance_hash?: string;
  candidate_count: number;
  cluster_count: number;
  unclustered_count: number;
  full_pass: boolean;
  clusters: Array<{
    community_uid: string;
    label: string;
    size: number;
    mean_intra_sim: number;
    /** Capped at {@link SUBSET_SUMMARY_MEMBER_CAP} per cluster. */
    members: string[];
  }>;
  /** True when clusters or members were capped (the persisted lens is complete). */
  truncated: boolean;
}

/** Job-row size bound: a store-size subset must not mint a megabyte payload. */
export const SUBSET_SUMMARY_CLUSTER_CAP = 100;
export const SUBSET_SUMMARY_MEMBER_CAP = 25;

/** Reduce a `clusterSubset` result to the bounded summary a job row can carry. */
export function summarizeSubsetResult(res: ClusterSubsetResult): ReclusterSubsetSummary {
  let truncated = res.clusters.length > SUBSET_SUMMARY_CLUSTER_CAP;
  const clusters = res.clusters.slice(0, SUBSET_SUMMARY_CLUSTER_CAP).map((c) => {
    if (c.member_rowids.length > SUBSET_SUMMARY_MEMBER_CAP) truncated = true;
    return {
      community_uid: c.community_uid,
      label: c.label,
      size: c.member_rowids.length,
      mean_intra_sim: c.mean_intra_sim,
      members: c.member_rowids.slice(0, SUBSET_SUMMARY_MEMBER_CAP).map(String),
    };
  });
  return {
    persisted: res.persisted,
    provenance_hash: res.provenance_hash,
    candidate_count: res.candidate_count,
    cluster_count: res.clusters.length,
    unclustered_count: res.unclustered_count,
    full_pass: res.full_pass,
    clusters,
    truncated,
  };
}

/** The partition a completed full pass produced, read from the store. */
export interface ReclusterPartition {
  community_count: number;
  clustered_episodes: number;
  live_episodes: number;
  coverage: number;
}

export interface ReclusterJob {
  job_id: string;
  /** The organizer_queue seq of the trigger row this job requested. */
  seq: number;
  status: ReclusterJobStatus;
  /** Caller-facing state derived from `status` (queued|running|completed|degraded|failed). */
  state: ReclusterJobState;
  scope: ReclusterJobScope;
  partition: ReclusterPartition | null;
  error: string | null;
  /** Why the pass was `skipped` (cluster step did not run); null otherwise. */
  skip_reason: string | null;
  /** Machine-readable cause of a `degraded` / `failed` job; null otherwise. */
  reason: ReclusterJobReason | null;
  requested_by: string | null;
  /** The process holding (or that last held) the job. */
  owner: string | null;
  created_at: string;
  /** When a process claimed the job; null while still queued. */
  started_at: string | null;
  /** When the job reached a terminal state; null until then. */
  finished_at: string | null;
  updated_at: string;
  /** Failed attempts so far and the earliest next attempt (full-pass retry). */
  attempts: number;
  next_retry_at: string | null;
  /** Subset jobs only: the request, and (once completed) the bounded result. */
  request: ReclusterSubsetRequest | null;
  result: ReclusterSubsetSummary | null;
}

/** The request a filtered job carries. */
export interface ReclusterSubsetRequest {
  filters: MemoryFilter;
  threshold?: number;
  /** false = read-only (`dry_run`): communities are computed, nothing persisted. */
  persist: boolean;
}

export interface EnqueueReclusterJobOptions {
  reason?: string;
  requestedBy?: string;
  /** Default `global`. `subset` requires `subset`. */
  scope?: ReclusterJobScope;
  subset?: ReclusterSubsetRequest;
  /** Clock seam (ms since epoch). */
  nowMs?: number;
}

export interface EnqueueReclusterJobResult {
  job_id: string;
  seq: number;
  /** `pending` for a fresh enqueue; the live status when `joined`. */
  status: ReclusterJobStatus;
  state: ReclusterJobState;
  scope: ReclusterJobScope;
  /**
   * AC-B3: true when a job was already open on this store — no row was added,
   * no second pass will run, and this is that job's handle.
   */
  joined: boolean;
  /**
   * 90ba140a AC-C6: false when this request JOINED an open job that does not
   * carry it — a filtered request that joined a global job (or a subset job with
   * different filters / persist), or a global request that joined a subset job.
   * The caller's filters were then NOT applied; it received the open job's
   * handle. Always true for a fresh enqueue.
   */
  request_honored: boolean;
}

/** The `payload.job` envelope stored on the organizer_queue trigger row. */
interface JobEnvelope {
  job_id: string;
  status: ReclusterJobStatus;
  scope: ReclusterJobScope;
  /** The partition as a JSON TEXT string (portable across json_set backends). */
  partition: string | null;
  error: string | null;
  /** Why a `skipped` pass did not cluster; null until/unless skipped. */
  skip_reason: string | null;
  reason: string | null;
  requested_by: string | null;
  owner: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  updated_at: string;
  lease_expires_at: string | null;
  attempts: number;
  next_retry_at: string | null;
  /** Subset request as JSON TEXT (portable across json_set backends). */
  request: string | null;
  /** Subset result summary as JSON TEXT. */
  result: string | null;
}

// ── Partition read ────────────────────────────────────────────────────────────

/**
 * Read the store's CURRENT cluster partition. Pure SELECTs — safe against a
 * live store, and the honest source of the `partition` a completed job reports
 * (rather than trusting a child process's summary).
 */
export async function readPartition(adapter: StoreAdapter): Promise<ReclusterPartition> {
  const communityCount =
    (await adapter.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM node WHERE kind = 'community' AND t_invalid IS NULL`,
    ))?.c ?? 0;
  const liveEpisodes =
    (await adapter.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM node WHERE kind = 'episode' AND t_invalid IS NULL`,
    ))?.c ?? 0;
  const clustered =
    (await adapter.executeGet<{ c: number }>(
      `SELECT COUNT(DISTINCT e.src) AS c
         FROM edge e JOIN node n ON n.rowid = e.src
        WHERE e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
          AND n.kind = 'episode' AND n.t_invalid IS NULL`,
    ))?.c ?? 0;
  return {
    community_count: communityCount,
    clustered_episodes: clustered,
    live_episodes: liveEpisodes,
    coverage: liveEpisodes > 0 ? clustered / liveEpisodes : 0,
  };
}


// ── Single-flight (store-level) ───────────────────────────────────────────────
//
// "At most one recluster job per STORE" is decided by the store, not by a
// process: the owner runs many memory servers against one store, and the
// per-process `liveChildrenByDb` map in enrich-isolation.ts cannot see a child
// forked by another process. The primitive this codebase already uses for
// cross-process exclusion is a conditional write inside the store (the SR-7
// claim CAS in claim.ts; ADR-0012 — never an advisory lock file, which has no
// production caller). Two writes carry the guarantee:
//
//   ENQUEUE  one `INSERT … SELECT … WHERE NOT EXISTS (open job)` statement. A
//            second request — from this process or any other — inserts zero
//            rows and is handed the open job's handle. Statements serialise on
//            the store's writer slot, so exactly one insert wins.
//   CONSUME  one `UPDATE … pending→running WHERE NOT EXISTS (live running job
//            owned by someone else)`. Every server's tick races for the same
//            row; one UPDATE affects it, the rest are told `blocked` and must
//            not fork a pass.
//
// A `running` job carries `lease_expires_at`. A process killed mid-pass can
// never settle its job, so an expired lease is reaped to `failed`
// (`owner_lost`) by the next enqueue/claim — the feature cannot wedge.

/**
 * An open (not yet terminal) job row: pending or running.
 *
 * 90ba140a AC-C4: `done_at IS NULL` is part of the predicate so SQLite can
 * answer it from the partial index `ix_q_open` (schema.ts, `WHERE done_at IS
 * NULL`). Without it every enqueue / reap / claim scanned the whole
 * organizer_queue with json_extract, and done rows are never deleted. A row
 * whose trigger was already closed (`done_at` set) can no longer run, so it is
 * not "open" even if a failed settle left its status pending/running — the tick
 * closes the trigger row just before settling the job. Reads of such a zombie
 * by handle still report it (an expired lease reads `failed`/`owner_lost`).
 */
export const OPEN_JOB_SQL = `done_at IS NULL
   AND json_extract(payload, '$.job.job_id') IS NOT NULL
   AND json_extract(payload, '$.job.status') IN ('pending', 'running')`;

/** Error text of a job whose owner died before settling it. */
const OWNER_LOST_ERROR =
  'owner lost: the lease expired before the job settled; request recluster again';

const iso = (ms: number): string => new Date(ms).toISOString();

/**
 * 90ba140a AC-C5: the EFFECTIVE view of a stored envelope. A `running` job whose
 * lease has lapsed has no live owner — it can never settle itself — yet its
 * stored status stays `running` until some server's next claim/enqueue reaps it
 * ({@link reapStaleReclusterJobs}). A reader (recluster_status, `latest`, the
 * ping block) must not wait for that tick to be told the truth, so every read
 * maps such a job to `failed`/`owner_lost` exactly as the reap will write it.
 * Pure: it never writes (a read stays a read); the reap persists it later.
 */
function effectiveEnvelope(env: JobEnvelope, nowMs: number): JobEnvelope {
  if (env.status !== 'running' || env.lease_expires_at === null) return env;
  const leaseMs = Date.parse(env.lease_expires_at);
  if (!Number.isFinite(leaseMs) || leaseMs > nowMs) return env;
  return {
    ...env,
    status: 'failed',
    reason: 'owner_lost',
    error: OWNER_LOST_ERROR,
    finished_at: env.lease_expires_at,
    updated_at: env.lease_expires_at,
    lease_expires_at: null,
  };
}

function rowToJob(
  seq: number,
  rawPayload: string | null,
  nowMs: number = Date.now(),
): ReclusterJob | null {
  const stored = parseJobEnvelope(rawPayload);
  if (!stored) return null;
  const env = effectiveEnvelope(stored, nowMs);
  return {
    job_id: env.job_id,
    seq,
    status: env.status,
    state: reclusterJobState(env.status),
    scope: env.scope,
    partition: parsePartition(env.partition),
    error: env.error,
    skip_reason: env.skip_reason,
    reason: env.reason,
    requested_by: env.requested_by,
    owner: env.owner,
    created_at: env.created_at,
    started_at: env.started_at,
    finished_at: env.finished_at,
    updated_at: env.updated_at,
    attempts: env.attempts,
    next_retry_at: env.next_retry_at,
    request: parseJsonText<ReclusterSubsetRequest>(env.request),
    result: parseJsonText<ReclusterSubsetSummary>(env.result),
  };
}

/**
 * Reap running jobs whose lease expired: their owner can no longer settle them.
 * Marks the job `failed` (`owner_lost`) and closes its trigger row so a dead
 * owner's request is never silently re-run. Returns the number reaped.
 */
export async function reapStaleReclusterJobs(
  adapter: StoreAdapter,
  nowMs: number = Date.now(),
): Promise<number> {
  const now = iso(nowMs);
  const res = await adapter.executeRun(
    `UPDATE organizer_queue
        SET payload = json_set(payload,
              '$.job.status', 'failed',
              '$.job.reason', 'owner_lost',
              '$.job.error', '${OWNER_LOST_ERROR}',
              '$.job.finished_at', ?,
              '$.job.updated_at', ?),
            claimed_at = COALESCE(claimed_at, ?),
            done_at = COALESCE(done_at, ?)
      WHERE done_at IS NULL
        AND json_extract(payload, '$.job.job_id') IS NOT NULL
        AND json_extract(payload, '$.job.status') = 'running'
        AND json_extract(payload, '$.job.lease_expires_at') <= ?`,
    [now, now, now, now, now],
  );
  return res.rowsAffected;
}

/** The currently open job on this store (pending or running), or null. */
export async function readOpenReclusterJob(
  adapter: StoreAdapter,
  nowMs: number = Date.now(),
): Promise<ReclusterJob | null> {
  const row = await adapter.executeGet<{ seq: number; payload: string | null }>(
    `SELECT seq, payload FROM organizer_queue WHERE ${OPEN_JOB_SQL} ORDER BY seq LIMIT 1`,
  );
  const job = row ? rowToJob(row.seq, row.payload, nowMs) : null;
  // A job with a lapsed lease reads `failed` (AC-C5): it is not open.
  return job && (job.status === 'pending' || job.status === 'running') ? job : null;
}

/** sox_store_meta key of the latest-job pointer (O(1) read for ping / status). */
export const RECLUSTER_LATEST_KEY = 'recluster_job_latest';

/** The most recently requested job on this store, or null if none was recorded. */
export async function readLatestReclusterJob(
  adapter: StoreAdapter,
  nowMs: number = Date.now(),
): Promise<ReclusterJob | null> {
  const ptr = await adapter.executeGet<{ value: string }>(
    `SELECT value FROM sox_store_meta WHERE key = ?`,
    [RECLUSTER_LATEST_KEY],
  );
  if (!ptr) return null;
  let seq: unknown;
  try {
    seq = (JSON.parse(ptr.value) as { seq?: unknown }).seq;
  } catch {
    return null; // a malformed pointer reports "none recorded"; status verbs by job_id still work
  }
  if (typeof seq !== 'number') return null;
  const row = await adapter.executeGet<{ seq: number; payload: string | null }>(
    `SELECT seq, payload FROM organizer_queue WHERE seq = ?`,
    [seq],
  );
  return row ? rowToJob(row.seq, row.payload, nowMs) : null;
}

// ── Producer ──────────────────────────────────────────────────────────────────

/**
 * Mint an observable recluster job AND enqueue its trigger row, as ONE
 * committed, store-level-guarded insert — or, when a job is already open on
 * this store, join it (AC-B3: no second row, no second pass).
 *
 * `global` jobs are `op:'enrich'` rows whose `full:true` stays at the payload's
 * top level, so the tick's existing `hasPendingFullEnrich` snapshot keeps
 * working unchanged. `subset` (filtered) jobs are `op:'reindex'` rows with no
 * `full` key: the organizer_queue CHECK constraint admits no new op without a
 * schema change (and the post-open WAL baseline argument in this file's header
 * applies), and `reindex` is the one existing op nothing consumes, so the
 * enrich fallback — which completes every `enrich`/`ingest`/… row after an
 * incremental pass — can never close a subset job behind its back.
 */
export async function enqueueReclusterJob(
  adapter: StoreAdapter,
  opts: EnqueueReclusterJobOptions = {},
): Promise<EnqueueReclusterJobResult> {
  const scope: ReclusterJobScope = opts.scope ?? 'global';
  if (scope === 'subset' && !opts.subset) {
    throw new Error("enqueueReclusterJob: scope 'subset' requires a `subset` request");
  }
  const nowMs = opts.nowMs ?? Date.now();
  const now = iso(nowMs);
  const reason = opts.reason ?? 'memory_curate recluster';

  await reapStaleReclusterJobs(adapter, nowMs);

  for (let attempt = 0; attempt < 3; attempt++) {
    const jobId = crypto.randomUUID();
    const job: JobEnvelope = {
      job_id: jobId,
      status: 'pending',
      scope,
      partition: null,
      error: null,
      skip_reason: null,
      reason: null,
      requested_by: opts.requestedBy ?? null,
      owner: null,
      created_at: now,
      started_at: null,
      finished_at: null,
      updated_at: now,
      lease_expires_at: null,
      attempts: 0,
      next_retry_at: null,
      request: scope === 'subset' ? JSON.stringify(opts.subset) : null,
      result: null,
    };
    const op = scope === 'global' ? 'enrich' : 'reindex';
    const payload = JSON.stringify(
      scope === 'global' ? { full: true, reason, job } : { subset: true, reason, job },
    );
    // 90ba140a AC-C8: the guarded insert and the `latest` pointer commit in ONE
    // transaction. Two statements left a crash window in which the job existed
    // but `latest` (and so `recluster_status {latest:true}` / the ping block)
    // still named the previous job.
    const seq = await adapter.transaction(async (tx): Promise<number | null> => {
      const info = await tx.executeRun(
        `INSERT INTO organizer_queue (op, payload, priority, enqueued)
         SELECT ?, ?, 1, ?
          WHERE NOT EXISTS (SELECT 1 FROM organizer_queue WHERE ${OPEN_JOB_SQL})`,
        [op, payload, now],
      );
      if (info.rowsAffected === 0) return null;
      const insertedSeq = Number(info.lastInsertRowid);
      await tx.executeRun(
        `INSERT INTO sox_store_meta (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [RECLUSTER_LATEST_KEY, JSON.stringify({ job_id: jobId, seq: insertedSeq })],
      );
      return insertedSeq;
    }, { mode: 'immediate' });
    if (seq !== null) {
      return {
        job_id: jobId, seq, status: 'pending', state: 'queued', scope, joined: false,
        request_honored: true,
      };
    }
    const open = await readOpenReclusterJob(adapter);
    if (open) {
      // An explicit new request on a global job that is waiting out a retry
      // backoff resets its budget and makes it eligible now (0c9c76b4 AC13).
      // Only a `pending` job is touched; a running one is never disturbed.
      if (open.scope === 'global' && open.status === 'pending' && open.next_retry_at !== null) {
        await adapter.executeRun(
          `UPDATE organizer_queue
              SET payload = json_set(payload, '$.job.attempts', 0, '$.job.next_retry_at', NULL,
                                              '$.job.updated_at', ?)
            WHERE seq = ? AND json_extract(payload, '$.job.status') = 'pending'`,
          [now, open.seq],
        );
      }
      return {
        job_id: open.job_id,
        seq: open.seq,
        status: open.status,
        state: open.state,
        scope: open.scope,
        joined: true,
        request_honored: sameRequest(scope, opts.subset, open),
      };
    }
    // The open job settled between our insert and our read — go again.
  }
  throw new Error('enqueueReclusterJob: could not enqueue a job or join the open one');
}

/** Does the open job carry the request being made? (AC-C6) */
function sameRequest(
  scope: ReclusterJobScope,
  subset: ReclusterSubsetRequest | undefined,
  open: ReclusterJob,
): boolean {
  if (open.scope !== scope) return false;
  if (scope === 'global') return true;
  const canon = (r: ReclusterSubsetRequest | null | undefined): string =>
    JSON.stringify([
      r?.persist ?? null,
      r?.threshold ?? null,
      Object.entries(r?.filters ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    ]);
  return canon(subset) === canon(open.request);
}

// ── Read surface (the poll) ───────────────────────────────────────────────────

function parseJobEnvelope(rawPayload: string | null): JobEnvelope | null {
  if (!rawPayload) return null;
  try {
    const parsed = JSON.parse(rawPayload) as { job?: unknown };
    const j = parsed.job;
    if (j === null || typeof j !== 'object' || Array.isArray(j)) return null;
    const env = j as Record<string, unknown>;
    if (typeof env['job_id'] !== 'string') return null;
    const str = (k: string): string | null => (typeof env[k] === 'string' ? (env[k] as string) : null);
    return {
      job_id: env['job_id'],
      status: env['status'] as ReclusterJobStatus,
      scope: env['scope'] === 'subset' ? 'subset' : 'global',
      partition: str('partition'),
      error: str('error'),
      skip_reason: str('skip_reason'),
      reason: str('reason'),
      requested_by: str('requested_by'),
      owner: str('owner'),
      created_at: str('created_at') ?? '',
      started_at: str('started_at'),
      finished_at: str('finished_at'),
      updated_at: str('updated_at') ?? '',
      lease_expires_at: str('lease_expires_at'),
      attempts: typeof env['attempts'] === 'number' ? env['attempts'] : 0,
      next_retry_at: str('next_retry_at'),
      request: str('request'),
      result: str('result'),
    };
  } catch (err) {
    // A payload that does not parse is not a job: report "no such job" rather than
    // throwing from a poll. Traced, never swallowed silently.
    log.warn('recluster_job.envelope_unparseable', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function parseJsonText<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') return parsed as T;
  } catch (err) {
    // A malformed value reports null — the status remains the honest,
    // load-bearing signal. Traced, never swallowed silently.
    log.warn('recluster_job.json_text_unparseable', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return null;
}

function parsePartition(raw: string | null): ReclusterPartition | null {
  return parseJsonText<ReclusterPartition>(raw);
}

/** Read one job by handle. `null` when no such job exists. */
export async function readReclusterJob(
  adapter: StoreAdapter,
  jobId: string,
  nowMs: number = Date.now(),
): Promise<ReclusterJob | null> {
  if (typeof jobId !== 'string' || jobId.length === 0) return null;
  const row = await adapter.executeGet<{ seq: number; payload: string | null }>(
    `SELECT seq, payload FROM organizer_queue
      WHERE json_extract(payload, '$.job.job_id') = ? LIMIT 1`,
    [jobId],
  );
  if (!row) return null;
  return rowToJob(row.seq, row.payload, nowMs);
}

/**
 * True when a request is waiting for a consumer: an open `pending` job whose
 * retry backoff (if any) has elapsed. Reads through the partial open-row index,
 * so a poll from many servers stays cheap. A job held `running` by another
 * process, or parked in backoff, is NOT waiting — kicking a tick for it would
 * only burn a heal pass.
 */
export async function hasPendingReclusterRequest(
  adapter: StoreAdapter,
  nowMs: number = Date.now(),
): Promise<boolean> {
  const row = await adapter.executeGet<{ seq: number }>(
    `SELECT seq FROM organizer_queue
      WHERE done_at IS NULL AND op IN ('enrich', 'reindex')
        AND json_extract(payload, '$.job.status') = 'pending'
        AND (json_extract(payload, '$.job.next_retry_at') IS NULL
             OR json_extract(payload, '$.job.next_retry_at') <= ?)
      LIMIT 1`,
    [iso(nowMs)],
  );
  return row !== null;
}

// ── Consumer: claim (called by the enrich tick) ───────────────────────────────

export interface ClaimReclusterOptions {
  /** The tick's pre-pass snapshot boundary: only rows with `seq <= maxSeq`. */
  maxSeq: number;
  /** Identity of this process (host:pid:instance) — the lease holder. */
  owner: string;
  /** How long the claim stays live without a settle (ms). */
  leaseMs: number;
  nowMs?: number;
}

export type ClaimReclusterResult =
  | {
      proceed: true;
      /** Jobs this call moved `pending → running` (0 = a legacy job-less full row). */
      claimed: number;
    }
  | {
      proceed: false;
      /** `held`: another process owns the running job. `backoff`: parked until `next_retry_at`. */
      blocked: 'held' | 'backoff';
      /** Lowest open full-pass row inside the window — the caller runs incremental below it. */
      lowestOpenFullSeq: number;
    };

/**
 * Claim the open GLOBAL job(s) inside the tick's window for this process, or
 * report why the pass must not run here. Idempotent for the owner: a job it
 * already holds (a prior tick died between claim and settle) is re-claimed.
 */
export async function claimGlobalReclusterJobs(
  adapter: StoreAdapter,
  opts: ClaimReclusterOptions,
): Promise<ClaimReclusterResult> {
  const nowMs = opts.nowMs ?? Date.now();
  const now = iso(nowMs);
  await reapStaleReclusterJobs(adapter, nowMs);

  const res = await adapter.executeRun(
    `UPDATE organizer_queue
        SET payload = json_set(payload,
              '$.job.status', 'running',
              '$.job.owner', ?,
              '$.job.started_at', COALESCE(json_extract(payload, '$.job.started_at'), ?),
              '$.job.lease_expires_at', ?,
              '$.job.updated_at', ?),
            claimed_at = COALESCE(claimed_at, ?)
      WHERE done_at IS NULL AND seq <= ? AND op = 'enrich'
        AND json_extract(payload, '$.job.job_id') IS NOT NULL
        AND json_extract(payload, '$.job.scope') IS NOT 'subset'
        AND (json_extract(payload, '$.job.status') = 'pending'
             OR (json_extract(payload, '$.job.status') = 'running'
                 AND json_extract(payload, '$.job.owner') = ?))
        AND (json_extract(payload, '$.job.next_retry_at') IS NULL
             OR json_extract(payload, '$.job.next_retry_at') <= ?)
        AND NOT EXISTS (
          SELECT 1 FROM organizer_queue o2
           WHERE o2.done_at IS NULL
             AND json_extract(o2.payload, '$.job.status') = 'running'
             AND json_extract(o2.payload, '$.job.owner') IS NOT ?
             AND json_extract(o2.payload, '$.job.lease_expires_at') > ?)`,
    [opts.owner, now, iso(nowMs + opts.leaseMs), now, now, opts.maxSeq, opts.owner, now, opts.owner, now],
  );
  if (res.rowsAffected > 0) return { proceed: true, claimed: res.rowsAffected };

  const managed = await adapter.executeGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM organizer_queue
      WHERE done_at IS NULL AND seq <= ? AND op = 'enrich'
        AND json_extract(payload, '$.job.job_id') IS NOT NULL
        AND json_extract(payload, '$.job.scope') IS NOT 'subset'
        AND json_extract(payload, '$.job.status') IN ('pending', 'running')`,
    [opts.maxSeq],
  );
  if ((managed?.c ?? 0) === 0) return { proceed: true, claimed: 0 };

  const heldRow = await adapter.executeGet<{ seq: number }>(
    `SELECT seq FROM organizer_queue
      WHERE done_at IS NULL
        AND json_extract(payload, '$.job.status') = 'running'
        AND json_extract(payload, '$.job.owner') IS NOT ?
        AND json_extract(payload, '$.job.lease_expires_at') > ?
      LIMIT 1`,
    [opts.owner, now],
  );
  const lo = await adapter.executeGet<{ lo: number | null }>(
    `SELECT MIN(seq) AS lo FROM organizer_queue
      WHERE done_at IS NULL AND op = 'enrich'
        AND json_extract(payload, '$.full') = 1 AND seq <= ?`,
    [opts.maxSeq],
  );
  return {
    proceed: false,
    blocked: heldRow ? 'held' : 'backoff',
    lowestOpenFullSeq: lo?.lo ?? opts.maxSeq,
  };
}

export interface ReleaseReclusterOptions {
  owner: string;
  attempts: number;
  /** ISO time before which the job must not be re-claimed. */
  nextRetryAt: string | null;
  error: string;
  nowMs?: number;
}

/**
 * Give a failed-but-retryable full pass back: `running → pending`, recording
 * the attempt count and the earliest next attempt ON THE ROW, so the backoff
 * binds every server on the store and not only the one that failed. Returns the
 * number of jobs released.
 */
export async function releaseGlobalReclusterJobs(
  adapter: StoreAdapter,
  maxSeq: number,
  opts: ReleaseReclusterOptions,
): Promise<number> {
  if (maxSeq <= 0) return 0;
  const now = iso(opts.nowMs ?? Date.now());
  const res = await adapter.executeRun(
    `UPDATE organizer_queue
        SET payload = json_set(payload,
              '$.job.status', 'pending',
              '$.job.owner', NULL,
              '$.job.lease_expires_at', NULL,
              '$.job.attempts', ?,
              '$.job.next_retry_at', ?,
              '$.job.error', ?,
              '$.job.updated_at', ?)
      WHERE seq <= ? AND op = 'enrich'
        AND json_extract(payload, '$.job.scope') IS NOT 'subset'
        AND json_extract(payload, '$.job.status') = 'running'
        AND json_extract(payload, '$.job.owner') = ?`,
    [opts.attempts, opts.nextRetryAt, opts.error, now, maxSeq, opts.owner],
  );
  return res.rowsAffected;
}

/**
 * Hand a claimed SUBSET job back to `pending` (the pass could not start here —
 * e.g. this process's one-holder child is still busy — so a later tick retries
 * it). Only the owner's `running` job is touched.
 */
export async function releaseSubsetReclusterJob(
  adapter: StoreAdapter,
  jobId: string,
  owner: string,
  nowMs: number = Date.now(),
): Promise<number> {
  const res = await adapter.executeRun(
    `UPDATE organizer_queue
        SET payload = json_set(payload,
              '$.job.status', 'pending',
              '$.job.owner', NULL,
              '$.job.lease_expires_at', NULL,
              '$.job.updated_at', ?)
      WHERE op = 'reindex' AND done_at IS NULL
        AND json_extract(payload, '$.job.job_id') = ?
        AND json_extract(payload, '$.job.status') = 'running'
        AND json_extract(payload, '$.job.owner') = ?`,
    [iso(nowMs), jobId, owner],
  );
  return res.rowsAffected;
}

/**
 * Claim the next pending SUBSET job for this process. Returns the claimed job
 * (carrying its `request`), or null when none is waiting or a live job on the
 * store is held by another process.
 */
export async function claimSubsetReclusterJob(
  adapter: StoreAdapter,
  opts: Omit<ClaimReclusterOptions, 'maxSeq'>,
): Promise<ReclusterJob | null> {
  const nowMs = opts.nowMs ?? Date.now();
  const now = iso(nowMs);
  await reapStaleReclusterJobs(adapter, nowMs);
  const res = await adapter.executeRun(
    `UPDATE organizer_queue
        SET payload = json_set(payload,
              '$.job.status', 'running',
              '$.job.owner', ?,
              '$.job.started_at', COALESCE(json_extract(payload, '$.job.started_at'), ?),
              '$.job.lease_expires_at', ?,
              '$.job.updated_at', ?),
            claimed_at = COALESCE(claimed_at, ?)
      WHERE seq = (SELECT MIN(seq) FROM organizer_queue
                    WHERE op = 'reindex' AND done_at IS NULL
                      AND json_extract(payload, '$.job.scope') = 'subset'
                      AND json_extract(payload, '$.job.status') = 'pending')
        AND NOT EXISTS (
          SELECT 1 FROM organizer_queue o2
           WHERE o2.done_at IS NULL
             AND json_extract(o2.payload, '$.job.status') = 'running'
             AND json_extract(o2.payload, '$.job.owner') IS NOT ?
             AND json_extract(o2.payload, '$.job.lease_expires_at') > ?)`,
    [opts.owner, now, iso(nowMs + opts.leaseMs), now, now, opts.owner, now],
  );
  if (res.rowsAffected === 0) return null;
  const row = await adapter.executeGet<{ seq: number; payload: string | null }>(
    `SELECT seq, payload FROM organizer_queue
      WHERE op = 'reindex' AND done_at IS NULL
        AND json_extract(payload, '$.job.scope') = 'subset'
        AND json_extract(payload, '$.job.status') = 'running'
        AND json_extract(payload, '$.job.owner') = ?
      ORDER BY seq LIMIT 1`,
    [opts.owner],
  );
  return row ? rowToJob(row.seq, row.payload) : null;
}

// ── Consumer: settle ──────────────────────────────────────────────────────────

export type ReclusterSettleOutcome =
  | { ok: true }
  | { ok: false; error: string; skipped?: false; kind?: ReclusterJobReason }
  | { ok: false; skipped: true; reason: string; kind?: ReclusterJobReason };

/**
 * Settle every OPEN global job whose trigger row was inside the tick's pre-pass
 * snapshot (`seq <= maxSeq`). Called by `runEnrichPassOnDb` after it runs the
 * pass, mirroring `completeEnrichTriggerRows`'s snapshot discipline: only rows
 * the pass actually covered may be settled.
 *
 * `{pending|running} → completed` (with the store's resulting partition) on a
 * successful pass; `→ failed` (with the error) when the pass threw; `→ skipped`
 * (with the reason) when the pass ran but its cluster step was skipped
 * (`cluster_pass_skipped`) and the partition is therefore unchanged. `kind`
 * records the machine-readable cause (`nodeCap` | `budget` | `child_failed` |
 * `cluster_skipped`). Terminal jobs are never touched. Returns the number of
 * jobs settled.
 */
export async function settleReclusterJobs(
  adapter: StoreAdapter,
  maxSeq: number,
  outcome: ReclusterSettleOutcome,
  nowMs: number = Date.now(),
): Promise<number> {
  if (maxSeq <= 0) return 0;
  const now = iso(nowMs);
  const WHERE = `WHERE seq <= ?
            AND json_extract(payload, '$.job.job_id') IS NOT NULL
            AND json_extract(payload, '$.job.scope') IS NOT 'subset'
            AND json_extract(payload, '$.job.status') IN ('pending', 'running')`;

  if (!outcome.ok) {
    if (outcome.skipped === true) {
      const res = await adapter.executeRun(
        `UPDATE organizer_queue
            SET payload = json_set(payload,
                  '$.job.status', 'skipped',
                  '$.job.skip_reason', ?,
                  '$.job.reason', ?,
                  '$.job.error', NULL,
                  '$.job.finished_at', ?,
                  '$.job.lease_expires_at', NULL,
                  '$.job.updated_at', ?)
          ${WHERE}`,
        [outcome.reason, outcome.kind ?? 'cluster_skipped', now, now, maxSeq],
      );
      return res.rowsAffected;
    }
    const res = await adapter.executeRun(
      `UPDATE organizer_queue
          SET payload = json_set(payload,
                '$.job.status', 'failed',
                '$.job.error', ?,
                '$.job.reason', ?,
                '$.job.finished_at', ?,
                '$.job.lease_expires_at', NULL,
                '$.job.updated_at', ?)
        ${WHERE}`,
      [outcome.error, outcome.kind ?? 'child_failed', now, now, maxSeq],
    );
    return res.rowsAffected;
  }

  const partitionJson = JSON.stringify(await readPartition(adapter));
  const res = await adapter.executeRun(
    `UPDATE organizer_queue
        SET payload = json_set(payload,
              '$.job.status', 'completed',
              '$.job.partition', ?,
              '$.job.error', NULL,
              '$.job.skip_reason', NULL,
              '$.job.reason', NULL,
              '$.job.finished_at', ?,
              '$.job.lease_expires_at', NULL,
              '$.job.updated_at', ?)
      ${WHERE}`,
    [partitionJson, now, now, maxSeq],
  );
  return res.rowsAffected;
}

export type SubsetSettleOutcome =
  | { ok: true; result: ReclusterSubsetSummary }
  | { ok: false; error: string; skipped?: false; kind?: ReclusterJobReason }
  | { ok: false; skipped: true; reason: string; kind?: ReclusterJobReason; result?: ReclusterSubsetSummary };

/**
 * Settle one SUBSET job by handle and close its trigger row. Same vocabulary as
 * {@link settleReclusterJobs}; a completed job carries the bounded result
 * summary (a degraded subset keeps whatever summary the child produced).
 */
export async function settleSubsetReclusterJob(
  adapter: StoreAdapter,
  jobId: string,
  outcome: SubsetSettleOutcome,
  nowMs: number = Date.now(),
): Promise<number> {
  const now = iso(nowMs);
  let status: ReclusterJobStatus;
  let error: string | null = null;
  let skipReason: string | null = null;
  let reason: string | null = null;
  let result: string | null = null;
  if (outcome.ok) {
    status = 'completed';
    result = JSON.stringify(outcome.result);
  } else if (outcome.skipped === true) {
    status = 'skipped';
    skipReason = outcome.reason;
    reason = outcome.kind ?? 'cluster_skipped';
    result = outcome.result ? JSON.stringify(outcome.result) : null;
  } else {
    status = 'failed';
    error = outcome.error;
    reason = outcome.kind ?? 'child_failed';
  }
  const res = await adapter.executeRun(
    `UPDATE organizer_queue
        SET payload = json_set(payload,
              '$.job.status', ?,
              '$.job.error', ?,
              '$.job.skip_reason', ?,
              '$.job.reason', ?,
              '$.job.result', ?,
              '$.job.finished_at', ?,
              '$.job.lease_expires_at', NULL,
              '$.job.updated_at', ?),
            claimed_at = COALESCE(claimed_at, ?),
            done_at = COALESCE(done_at, ?)
      WHERE json_extract(payload, '$.job.job_id') = ?
        AND json_extract(payload, '$.job.scope') = 'subset'
        AND json_extract(payload, '$.job.status') IN ('pending', 'running')`,
    [status, error, skipReason, reason, result, now, now, now, now, jobId],
  );
  return res.rowsAffected;
}
