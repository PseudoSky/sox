/**
 * recluster-job-runner.ts — consumes FILTERED (subset) recluster jobs.
 *
 * A filtered `memory_curate recluster` no longer runs `clusterSubset` inside the
 * tool call (90ba140a AC-B1: that out-waited the MCP client timeout, -32001).
 * The request mints a job (recluster-job.ts); this runner — driven by the enrich
 * tick in memory-server — claims it store-side (AC-B3: the claim is a CAS, so
 * only one process ever runs a job), runs the pass in the ISOLATED enrich child
 * (`BatchEnrichOptions.subsetRecluster`, off the server's event loop — the same
 * BL-348 boundary the full pass uses), and settles the job (AC-B4: a degraded or
 * failed pass is reported, never silent).
 *
 * The child runner and the degradation describer are injected, so this module
 * spawns nothing itself and unit tests mock the process boundary.
 *
 * [inv:no-mcp] — plain result objects.
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';
import type { BatchEnrichOptions, BatchEnrichResult } from './enrich-batch.js';
import type { ClusterDegradation } from './cluster.js';
import {
  claimSubsetReclusterJob,
  releaseSubsetReclusterJob,
  reclusterJobState,
  settleSubsetReclusterJob,
  type ReclusterJobState,
  type SubsetSettleOutcome,
} from './recluster-job.js';
import { ENRICH_ERR_HOLDER_BUSY } from './enrich-isolation.js';
import { log } from './telemetry.js';

export type SubsetIsolatedOutcome =
  | { ok: true; result: BatchEnrichResult }
  /** `code` is the isolation layer's structured signal (90ba140a AC-D1); `error` is for humans only. */
  | { ok: false; error: string; code?: string };

export interface SubsetRunDeps {
  /** Runs one isolated enrich pass with `opts` (the real one forks a child). */
  runIsolated(opts: BatchEnrichOptions): Promise<SubsetIsolatedOutcome>;
  describeDegradation(d: ClusterDegradation): string;
  /** Identity of this process — the lease holder. */
  owner: string;
  /** Claim lease; must exceed the child's wall-clock timeout. */
  leaseMs: number;
  nowMs?: () => number;
}

export type SubsetRunOutcome =
  | { ran: false }
  | { ran: true; job_id: string; state: ReclusterJobState };

/**
 * Claim and run at most one pending subset job. Never throws: every failure
 * settles the job `failed` (or, if even settling fails, is logged and the lease
 * expiry reaps it as `owner_lost`).
 */
export async function runPendingSubsetReclusterJob(
  adapter: StoreAdapter,
  deps: SubsetRunDeps,
): Promise<SubsetRunOutcome> {
  const now = deps.nowMs ?? Date.now;
  const job = await claimSubsetReclusterJob(adapter, {
    owner: deps.owner,
    leaseMs: deps.leaseMs,
    nowMs: now(),
  });
  if (!job || !job.request) return { ran: false };

  let outcome: SubsetSettleOutcome;
  try {
    const isolated = await deps.runIsolated({
      subsetRecluster: {
        filter: job.request.filters,
        persist: job.request.persist,
        ...(typeof job.request.threshold === 'number' ? { threshold: job.request.threshold } : {}),
      },
    });
    if (!isolated.ok && isolated.code === ENRICH_ERR_HOLDER_BUSY) {
      // This process's one-holder child is still busy: the pass never started.
      // Not a failure of the job — hand it back so a later tick runs it.
      await releaseSubsetReclusterJob(adapter, job.job_id, deps.owner, now());
      log.info('recluster_job.subset_deferred_holder_busy', { job_id: job.job_id });
      return { ran: false };
    }
    if (!isolated.ok) {
      outcome = { ok: false, error: isolated.error, kind: 'child_failed' };
    } else if (!isolated.result.subset) {
      outcome = {
        ok: false,
        error: 'isolated child returned no subset result',
        kind: 'child_failed',
      };
    } else if (isolated.result.cluster_degraded) {
      outcome = {
        ok: false,
        skipped: true,
        reason: deps.describeDegradation(isolated.result.cluster_degraded),
        kind: isolated.result.cluster_degraded.reason,
        result: isolated.result.subset,
      };
    } else {
      outcome = { ok: true, result: isolated.result.subset };
    }
  } catch (err) {
    outcome = { ok: false, error: err instanceof Error ? err.message : String(err), kind: 'child_failed' };
  }

  try {
    await settleSubsetReclusterJob(adapter, job.job_id, outcome, now());
  } catch (err) {
    log.error('recluster_job.subset_settle_failed', {
      job_id: job.job_id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return {
    ran: true,
    job_id: job.job_id,
    state: reclusterJobState(
      outcome.ok ? 'completed' : outcome.skipped === true ? 'skipped' : 'failed',
    ),
  };
}
