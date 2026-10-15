/**
 * bl-0c9c76b4-curate-degraded.spec.ts
 *
 * Failure mode: a filtered `memory_curate recluster` pass that was refused
 * (nodeCap) or aborted (budget) reads as an ordinary empty result, so the
 * caller cannot tell "no clusters" from "the pass did not run".
 * Tier: S (real temp sqlite store; the isolated child boundary is an injected
 * `runIsolated` mock, nothing is forked).
 * Gap: does not exercise a real over-cap corpus. What a degraded subset pass
 * persists is owned by bl-0c9c76b4-nodecap.spec.ts, AC11, at the clusterSubset
 * layer.
 * Items: 0c9c76b4 AC9 (degradation is surfaced, never silent), carried through
 * the background job contract of 90ba140a AC-B4: the request returns a job
 * handle, the isolated pass settles the job, and `recluster_status` reports
 * `state: degraded` with the degradation reason.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { memoryCurate } from './curate.js';
import { runPendingSubsetReclusterJob } from './recluster-job-runner.js';

let dir: string;
let db: StoreAdapter;
beforeEach(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'curate-degraded-'));
  db = await openDb(path.join(dir, 'store.db'));
});
afterEach(async () => {
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const ARGS = { op: 'recluster', filters: { topic: 'x' } };
const SUBSET = (extra: Record<string, unknown> = {}) => ({
  persisted: false, candidate_count: 20000, cluster_count: 0, unclustered_count: 20000,
  full_pass: false, clusters: [], truncated: false, ...extra,
});

async function runWith(degraded: unknown, subset: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handle = (await memoryCurate(db, ARGS)) as Record<string, unknown>;
  await runPendingSubsetReclusterJob(db, {
    runIsolated: vi.fn().mockResolvedValue({
      ok: true,
      result: { subset, ...(degraded ? { cluster_degraded: degraded } : {}) },
    }),
    describeDegradation: (d) => `${d.reason} degradation`,
    owner: 'test', leaseMs: 60_000,
  });
  return (await memoryCurate(db, { op: 'recluster_status', job_id: handle['job_id'] })) as Record<string, unknown>;
}

describe('0c9c76b4 AC9 a degraded subset pass is surfaced through the job', () => {
  it('0c9c76b4 AC9: a nodeCap-degraded subset pass settles `degraded` with reason nodeCap', async () => {
    const res = await runWith({ reason: 'nodeCap', episodeCount: 20000, nodeCap: 16000 }, SUBSET());
    expect(res['state']).toBe('degraded');
    expect(res['reason']).toBe('nodeCap');
  });

  it('0c9c76b4 AC9: a budget-degraded subset pass settles `degraded` with reason budget', async () => {
    const res = await runWith({ reason: 'budget', episodeCount: 9000, budgetMs: 1000, elapsedMs: 1500 }, SUBSET({ candidate_count: 9000 }));
    expect(res['state']).toBe('degraded');
    expect(res['reason']).toBe('budget');
  });

  it('0c9c76b4 AC9: an un-degraded pass settles `completed` with no degradation reason', async () => {
    const res = await runWith(null, SUBSET({ candidate_count: 0, unclustered_count: 0, full_pass: true }));
    expect(res['state']).toBe('completed');
    expect(res['reason'] ?? null).toBeNull();
  });
});
