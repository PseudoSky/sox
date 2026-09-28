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
 *      └──────(pass failed)─────▶ failed     (+ the error)
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
 * `pending → {completed|failed}`; a terminal job is never resurrected.
 *
 * [inv:no-mcp] — returns plain result objects, never MCP ToolResults.
 */

import * as crypto from 'node:crypto';
import type { StoreAdapter } from '@adhd/sox-store-adapter';

export type ReclusterJobStatus = 'pending' | 'completed' | 'failed';

/** The partition a completed full pass produced, read from the store. */
export interface ReclusterPartition {
  community_count: number;
  clustered_episodes: number;
  live_episodes: number;
  coverage: number;
}

export interface ReclusterJob {
  job_id: string;
  /** The organizer_queue seq of the full-pass enrich row this job requested. */
  seq: number;
  status: ReclusterJobStatus;
  partition: ReclusterPartition | null;
  error: string | null;
  requested_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface EnqueueReclusterJobOptions {
  reason?: string;
  requestedBy?: string;
}

export interface EnqueueReclusterJobResult {
  job_id: string;
  seq: number;
  status: 'pending';
}

/** The `payload.job` envelope stored on the organizer_queue trigger row. */
interface JobEnvelope {
  job_id: string;
  status: ReclusterJobStatus;
  /** The partition as a JSON TEXT string (portable across json_set backends). */
  partition: string | null;
  error: string | null;
  requested_by: string | null;
  created_at: string;
  updated_at: string;
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

// ── Producer ──────────────────────────────────────────────────────────────────

/**
 * Mint an observable recluster job AND enqueue its full-pass trigger row, as
 * ONE committed insert. Returns the handle a caller polls.
 *
 * `full:true` stays at the payload's top level so the tick's existing
 * `hasPendingFullEnrich` snapshot keeps working unchanged.
 */
export async function enqueueReclusterJob(
  adapter: StoreAdapter,
  opts: EnqueueReclusterJobOptions = {},
): Promise<EnqueueReclusterJobResult> {
  const jobId = crypto.randomUUID();
  const now = new Date().toISOString();
  const reason = opts.reason ?? 'memory_curate recluster';
  const job: JobEnvelope = {
    job_id: jobId,
    status: 'pending',
    partition: null,
    error: null,
    requested_by: opts.requestedBy ?? null,
    created_at: now,
    updated_at: now,
  };
  const payload = JSON.stringify({ full: true, reason, job });
  const info = await adapter.executeRun(
    `INSERT INTO organizer_queue (op, payload, priority, enqueued)
     VALUES ('enrich', ?, 1, ?)`,
    [payload, now],
  );
  return { job_id: jobId, seq: Number(info.lastInsertRowid), status: 'pending' };
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
    return {
      job_id: env['job_id'],
      status: env['status'] as ReclusterJobStatus,
      partition: typeof env['partition'] === 'string' ? env['partition'] : null,
      error: typeof env['error'] === 'string' ? env['error'] : null,
      requested_by: typeof env['requested_by'] === 'string' ? env['requested_by'] : null,
      created_at: typeof env['created_at'] === 'string' ? env['created_at'] : '',
      updated_at: typeof env['updated_at'] === 'string' ? env['updated_at'] : '',
    };
  } catch {
    return null;
  }
}

function parsePartition(raw: string | null): ReclusterPartition | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed !== null && typeof parsed === 'object') return parsed as ReclusterPartition;
  } catch {
    /* a malformed partition reports null — the status remains the honest,
       load-bearing signal. */
  }
  return null;
}

/** Read one job by handle. `null` when no such job exists. */
export async function readReclusterJob(
  adapter: StoreAdapter,
  jobId: string,
): Promise<ReclusterJob | null> {
  if (typeof jobId !== 'string' || jobId.length === 0) return null;
  const row = await adapter.executeGet<{ seq: number; payload: string | null }>(
    `SELECT seq, payload FROM organizer_queue
      WHERE json_extract(payload, '$.job.job_id') = ? LIMIT 1`,
    [jobId],
  );
  if (!row) return null;
  const env = parseJobEnvelope(row.payload);
  if (!env) return null;
  return {
    job_id: env.job_id,
    seq: row.seq,
    status: env.status,
    partition: parsePartition(env.partition),
    error: env.error,
    requested_by: env.requested_by,
    created_at: env.created_at,
    updated_at: env.updated_at,
  };
}

// ── Consumer (called by the enrich tick) ──────────────────────────────────────

export type ReclusterSettleOutcome = { ok: true } | { ok: false; error: string };

/**
 * Settle every OPEN job whose trigger row was inside the tick's pre-pass
 * snapshot (`seq <= maxSeq`). Called by `runEnrichPassOnDb` after it runs the
 * pass, mirroring `completeEnrichTriggerRows`'s snapshot discipline: only rows
 * the pass actually covered may be settled.
 *
 * `pending → completed` (with the store's resulting partition) on a successful
 * pass; `pending → failed` (with the error) otherwise. Terminal jobs are never
 * touched. Returns the number of jobs settled.
 */
export async function settleReclusterJobs(
  adapter: StoreAdapter,
  maxSeq: number,
  outcome: ReclusterSettleOutcome,
): Promise<number> {
  if (maxSeq <= 0) return 0;
  const now = new Date().toISOString();

  if (!outcome.ok) {
    const res = await adapter.executeRun(
      `UPDATE organizer_queue
          SET payload = json_set(payload,
                '$.job.status', 'failed',
                '$.job.error', ?,
                '$.job.updated_at', ?)
        WHERE seq <= ?
          AND json_extract(payload, '$.job.job_id') IS NOT NULL
          AND json_extract(payload, '$.job.status') = 'pending'`,
      [outcome.error, now, maxSeq],
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
              '$.job.updated_at', ?)
      WHERE seq <= ?
        AND json_extract(payload, '$.job.job_id') IS NOT NULL
        AND json_extract(payload, '$.job.status') = 'pending'`,
    [partitionJson, now, maxSeq],
  );
  return res.rowsAffected;
}
