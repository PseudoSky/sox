/**
 * recluster-job-background.90ba140a.spec.ts
 *
 * Failure mode: a filtered (or whole-store) `memory_curate recluster` ran
 * synchronously inside the tool call and out-waited the MCP client timeout
 * (-32001); and with many servers on one store a second request / second
 * server's tick could start a second O(n^2) pass.
 * Tier: S. Real temp sqlite stores (two independent connections where
 * cross-process behaviour matters). The isolated child boundary is an injected
 * `runIsolated` mock — nothing is forked.
 * Items: 90ba140a / 2f998081 AC-B1 .. AC-B4 (+ AC-B6 citation rule).
 *
 * Recorded red runs (2026-10-19, worktree recluster-bg-c1; each fault seeded in
 * the named source file, spec run via `npx nx test memory-core -- <this file>`,
 * file restored byte-identical (cmp) afterwards):
 *   AC-B1  curate.ts curateRecluster: add `await clusterSubset(adapter, {filter,
 *          persist})` before enqueueing (the old inline pass).
 *          Exit 1, 3 failed / 16 passed. `a FILTERED recluster returns a queued
 *          job handle and never calls clusterSubset in the tool call`:
 *          AssertionError: expected 'TIMED_OUT' not to be 'TIMED_OUT';
 *          `filtered dry_run is deferred too`: AssertionError: expected
 *          "vi.fn()" to not be called at all, but actually been called 1 times.
 *   AC-B3  recluster-job.ts enqueue INSERT: `WHERE NOT EXISTS (...)` -> `WHERE 1`.
 *          Exit 1, 5 failed / 14 passed. `a second request returns the open job
 *          handle and adds no row` and `concurrent requests from two independent
 *          connections yield exactly one job`: AssertionError: expected 4 to be 1.
 *   AC-B3  recluster-job.ts claim UPDATE owner guard: `owner = ?` -> `owner IS
 *          NOT ?`. Exit 1, 2 failed / 17 passed. `the owner re-claims its own
 *          running job`: AssertionError: expected { proceed: false, ... } to
 *          deeply equal { proceed: true, claimed: 1 }.
 *   Restored: 19 passed (19), exit 0.
 * The claim's foreign-lease NOT EXISTS guard has its own red run in
 * recluster-job-corrections.90ba140a.spec.ts (AC-B3).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';

const { subsetSpy } = vi.hoisted(() => ({ subsetSpy: vi.fn() }));
vi.mock('./cluster.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cluster.js')>();
  return { ...actual, clusterSubset: subsetSpy };
});

import { openDb } from './db.js';
import { memoryCurate } from './curate.js';
import { runBatchEnrich } from './enrich-batch.js';
import { runPendingSubsetReclusterJob } from './recluster-job-runner.js';
import {
  claimGlobalReclusterJobs,
  enqueueReclusterJob,
  hasPendingReclusterRequest,
  readLatestReclusterJob,
  readReclusterJob,
  releaseGlobalReclusterJobs,
  reapStaleReclusterJobs,
  settleReclusterJobs,
  reclusterJobState,
} from './recluster-job.js';

let dir: string;
let dbPath: string;
let db: StoreAdapter;
const extra: StoreAdapter[] = [];

beforeEach(async () => {
  subsetSpy.mockReset();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recluster-bg-'));
  dbPath = path.join(dir, 'store.db');
  db = await openDb(dbPath);
});
afterEach(async () => {
  for (const a of extra.splice(0)) await a.close();
  await db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function second(): Promise<StoreAdapter> {
  const a = await openDb(dbPath);
  extra.push(a);
  return a;
}
const rowCount = async (a: StoreAdapter): Promise<number> =>
  (await a.executeGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM organizer_queue WHERE json_extract(payload,'$.job.job_id') IS NOT NULL`,
  ))!.c;

describe('90ba140a AC-B1 requests return a handle without running the pass', () => {
  it('90ba140a AC-B1: a FILTERED recluster returns a queued job handle and never calls clusterSubset in the tool call', async () => {
    subsetSpy.mockImplementation(() => new Promise(() => undefined)); // would hang forever if called inline
    const res = (await Promise.race([
      memoryCurate(db, { op: 'recluster', filters: { project_path: '/p' } }),
      new Promise((r) => setTimeout(() => r('TIMED_OUT'), 2000)),
    ])) as Record<string, unknown>;
    expect(res).not.toBe('TIMED_OUT');
    expect(res['scope']).toBe('subset');
    expect(res['enqueued']).toBe(true);
    expect(res['state']).toBe('queued');
    expect(typeof res['job_id']).toBe('string');
    expect(subsetSpy).not.toHaveBeenCalled();
  });

  it('90ba140a AC-B1: filtered dry_run is deferred too and records persist:false', async () => {
    const res = (await memoryCurate(db, { op: 'recluster', filters: { topic: 't' }, dry_run: true })) as Record<string, unknown>;
    expect(res['state']).toBe('queued');
    const job = await readReclusterJob(db, res['job_id'] as string);
    expect(job!.request).toEqual({ filters: { topic: 't' }, persist: false });
    expect(subsetSpy).not.toHaveBeenCalled();
  });

  it('90ba140a AC-B1: whole-store recluster returns a queued handle; whole-store dry_run enqueues nothing', async () => {
    const res = (await memoryCurate(db, { op: 'recluster' })) as Record<string, unknown>;
    expect(res['scope']).toBe('global');
    expect(res['state']).toBe('queued');
    const dry = (await memoryCurate(db, { op: 'recluster', dry_run: true })) as Record<string, unknown>;
    expect(dry['enqueued']).toBe(false);
    expect(await rowCount(db)).toBe(1);
  });

  it('90ba140a AC-B1: unset subsetRecluster leaves runBatchEnrich unchanged; set runs only the subset pass', async () => {
    const plain = await runBatchEnrich(db, { incrementalCluster: true });
    expect(plain.subset).toBeUndefined();
    expect(subsetSpy).not.toHaveBeenCalled();

    subsetSpy.mockResolvedValueOnce({
      clusters: [], full_pass: true, unclustered_count: 0, persisted: false, provenance_hash: 'abc', candidate_count: 3,
    });
    const sub = await runBatchEnrich(db, { subsetRecluster: { filter: { topic: 't' }, persist: false } });
    expect(subsetSpy).toHaveBeenCalledTimes(1);
    expect(sub.subset).toMatchObject({ candidate_count: 3, cluster_count: 0, persisted: false });
    expect(sub.legacy_nodes_stamped).toBe(0);
  });
});

describe('90ba140a AC-B2 job state survives the request and is observable', () => {
  it('90ba140a AC-B2: queued -> running -> completed with timestamps, readable from a second connection and as latest', async () => {
    const job = await enqueueReclusterJob(db, { reason: 't', nowMs: Date.parse('2026-10-15T10:00:00Z') });
    const observer = await second();
    expect((await readReclusterJob(observer, job.job_id))!.state).toBe('queued');
    expect(await hasPendingReclusterRequest(observer, Date.parse('2026-10-15T10:00:01Z'))).toBe(true);

    const claim = await claimGlobalReclusterJobs(db, {
      maxSeq: job.seq, owner: 'o1', leaseMs: 60_000, nowMs: Date.parse('2026-10-15T10:00:05Z'),
    });
    expect(claim).toEqual({ proceed: true, claimed: 1 });
    // Reads take the same clock as the claim: the lease is live at 10:00:06 (AC-C5 maps an expired lease to failed).
    const running = await readReclusterJob(observer, job.job_id, Date.parse('2026-10-15T10:00:06Z'));
    expect(running!.state).toBe('running');
    expect(running!.started_at).toBe('2026-10-15T10:00:05.000Z');
    expect(running!.owner).toBe('o1');
    expect(running!.finished_at).toBeNull();
    expect(await hasPendingReclusterRequest(observer)).toBe(false);

    await settleReclusterJobs(db, job.seq, { ok: true }, Date.parse('2026-10-15T10:09:00Z'));
    const done = await readReclusterJob(observer, job.job_id);
    expect(done!.state).toBe('completed');
    expect(done!.finished_at).toBe('2026-10-15T10:09:00.000Z');
    expect((await readLatestReclusterJob(observer))!.job_id).toBe(job.job_id);
  });

  it('90ba140a AC-B2: stored statuses map to the caller-facing states', () => {
    expect(reclusterJobState('pending')).toBe('queued');
    expect(reclusterJobState('running')).toBe('running');
    expect(reclusterJobState('completed')).toBe('completed');
    expect(reclusterJobState('skipped')).toBe('degraded');
    expect(reclusterJobState('failed')).toBe('failed');
  });

  it('90ba140a AC-B2: recluster_status latest:true returns the store latest job; with no job it is E_NOT_FOUND', async () => {
    expect(await memoryCurate(db, { op: 'recluster_status', latest: true })).toMatchObject({ code: 'E_NOT_FOUND' });
    const j = await enqueueReclusterJob(db, {});
    expect(await memoryCurate(db, { op: 'recluster_status', latest: true })).toMatchObject({
      op: 'recluster_status', job_id: j.job_id, state: 'queued',
    });
  });
});

describe('90ba140a AC-B3 single-flight is store-level', () => {
  it('90ba140a AC-B3: a second request returns the open job handle and adds no row', async () => {
    const a = await enqueueReclusterJob(db, {});
    const b = await enqueueReclusterJob(db, {});
    expect(b).toMatchObject({ job_id: a.job_id, seq: a.seq, joined: true });
    expect(a.joined).toBe(false);
    expect(await rowCount(db)).toBe(1);
  });

  it('90ba140a AC-B3: concurrent requests from two independent connections yield exactly one job', async () => {
    const other = await second();
    const results = await Promise.all([
      enqueueReclusterJob(db, {}),
      enqueueReclusterJob(other, {}),
      enqueueReclusterJob(db, { scope: 'subset', subset: { filters: { topic: 'x' }, persist: true } }),
      enqueueReclusterJob(other, {}),
    ]);
    expect(new Set(results.map((r) => r.job_id)).size).toBe(1);
    expect(results.filter((r) => !r.joined)).toHaveLength(1);
    expect(await rowCount(db)).toBe(1);
  });

  it('90ba140a AC-B3: a filtered request while a global job is open joins it (any scope)', async () => {
    const g = await enqueueReclusterJob(db, {});
    const s = await memoryCurate(db, { op: 'recluster', filters: { topic: 't' } });
    expect(s).toMatchObject({ job_id: g.job_id, joined: true, job_scope: 'global' });
  });

  it('90ba140a AC-B3: two servers (owners) racing for the same job — exactly one claims, the loser is told held', async () => {
    const job = await enqueueReclusterJob(db, {});
    const other = await second();
    const opts = (owner: string) => ({ maxSeq: job.seq, owner, leaseMs: 60_000 });
    const [r1, r2] = await Promise.all([
      claimGlobalReclusterJobs(db, opts('server-a')),
      claimGlobalReclusterJobs(other, opts('server-b')),
    ]);
    const winners = [r1, r2].filter((r) => r.proceed);
    expect(winners).toHaveLength(1);
    const loser = [r1, r2].find((r) => !r.proceed)!;
    expect(loser).toMatchObject({ proceed: false, blocked: 'held', lowestOpenFullSeq: job.seq });
    // and the loser cannot settle it: its window is below the full row
    expect(await settleReclusterJobs(other, job.seq - 1, { ok: true })).toBe(0);
    expect((await readReclusterJob(db, job.job_id))!.state).toBe('running');
  });

  it('90ba140a AC-B3: the owner re-claims its own running job (a tick that died between claim and settle)', async () => {
    const job = await enqueueReclusterJob(db, {});
    await claimGlobalReclusterJobs(db, { maxSeq: job.seq, owner: 'a', leaseMs: 60_000 });
    expect(await claimGlobalReclusterJobs(db, { maxSeq: job.seq, owner: 'a', leaseMs: 60_000 })).toEqual({ proceed: true, claimed: 1 });
  });

  it('90ba140a AC-B3: a dead owner (lease expired) is reaped to failed/owner_lost and a new request may start', async () => {
    const t0 = Date.parse('2026-10-15T10:00:00Z');
    const job = await enqueueReclusterJob(db, { nowMs: t0 });
    await claimGlobalReclusterJobs(db, { maxSeq: job.seq, owner: 'dead', leaseMs: 1000, nowMs: t0 });
    expect(await reapStaleReclusterJobs(db, t0 + 500)).toBe(0);
    expect(await reapStaleReclusterJobs(db, t0 + 2000)).toBe(1);
    const reaped = await readReclusterJob(db, job.job_id);
    expect(reaped).toMatchObject({ state: 'failed', reason: 'owner_lost' });
    const next = await enqueueReclusterJob(db, { nowMs: t0 + 3000 });
    expect(next.joined).toBe(false);
    expect(next.job_id).not.toBe(job.job_id);
  });

  it('90ba140a AC-B3: a retry backoff recorded on the row binds every server', async () => {
    const t0 = Date.parse('2026-10-15T10:00:00Z');
    const job = await enqueueReclusterJob(db, { nowMs: t0 });
    await claimGlobalReclusterJobs(db, { maxSeq: job.seq, owner: 'a', leaseMs: 60_000, nowMs: t0 });
    await releaseGlobalReclusterJobs(db, job.seq, {
      owner: 'a', attempts: 1, nextRetryAt: new Date(t0 + 900_000).toISOString(), error: 'timeout', nowMs: t0,
    });
    const other = await second();
    expect(await hasPendingReclusterRequest(other, t0 + 1000)).toBe(false);
    expect(await claimGlobalReclusterJobs(other, { maxSeq: job.seq, owner: 'b', leaseMs: 60_000, nowMs: t0 + 1000 }))
      .toMatchObject({ proceed: false, blocked: 'backoff' });
    expect(await claimGlobalReclusterJobs(other, { maxSeq: job.seq, owner: 'b', leaseMs: 60_000, nowMs: t0 + 900_001 }))
      .toEqual({ proceed: true, claimed: 1 });
    expect((await readReclusterJob(db, job.job_id))!.attempts).toBe(1);
  });
});

describe('90ba140a AC-B4 outcomes settle and are never silent', () => {
  it('90ba140a AC-B4: degraded (nodeCap/budget) settles skipped -> state degraded with reason kind; failed settles failed/child_failed', async () => {
    const a = await enqueueReclusterJob(db, {});
    await settleReclusterJobs(db, a.seq, { ok: false, skipped: true, reason: 'nodeCap: 20000 > 16000', kind: 'nodeCap' });
    expect(await readReclusterJob(db, a.job_id)).toMatchObject({ state: 'degraded', status: 'skipped', reason: 'nodeCap', skip_reason: 'nodeCap: 20000 > 16000' });

    const b = await enqueueReclusterJob(db, {});
    await settleReclusterJobs(db, b.seq, { ok: false, error: 'timeout', kind: 'child_failed' });
    expect(await readReclusterJob(db, b.job_id)).toMatchObject({ state: 'failed', reason: 'child_failed', error: 'timeout' });
  });

  it('90ba140a AC-B4: the subset runner settles completed with a bounded result', async () => {
    const j = await enqueueReclusterJob(db, { scope: 'subset', subset: { filters: { topic: 't' }, persist: true } });
    const runIsolated = vi.fn().mockResolvedValue({
      ok: true,
      result: { subset: { persisted: true, candidate_count: 9, cluster_count: 2, unclustered_count: 1, full_pass: true, clusters: [], truncated: false } },
    });
    const out = await runPendingSubsetReclusterJob(db, { runIsolated, describeDegradation: () => 'x', owner: 'o', leaseMs: 60_000 });
    expect(out).toEqual({ ran: true, job_id: j.job_id, state: 'completed' });
    expect(runIsolated).toHaveBeenCalledWith({ subsetRecluster: { filter: { topic: 't' }, persist: true } });
    const done = await readReclusterJob(db, j.job_id);
    expect(done).toMatchObject({ state: 'completed', result: { candidate_count: 9 } });
    expect(done!.finished_at).not.toBeNull();
    // a settled subset job closes its trigger row so queue_depth does not lie
    const q = await db.executeGet<{ done_at: string | null }>(`SELECT done_at FROM organizer_queue WHERE seq = ?`, [j.seq]);
    expect(q!.done_at).not.toBeNull();
  });

  it('90ba140a AC-B4: subset degraded -> degraded/budget; child failure and thrown error -> failed; no job -> ran:false', async () => {
    expect(await runPendingSubsetReclusterJob(db, { runIsolated: vi.fn(), describeDegradation: () => '', owner: 'o', leaseMs: 1 })).toEqual({ ran: false });

    const j1 = await enqueueReclusterJob(db, { scope: 'subset', subset: { filters: { topic: 't' }, persist: true } });
    const deg = { reason: 'budget', episodeCount: 5, budgetMs: 10, elapsedMs: 20 };
    await runPendingSubsetReclusterJob(db, {
      runIsolated: vi.fn().mockResolvedValue({ ok: true, result: { subset: { persisted: false, candidate_count: 5, cluster_count: 0, unclustered_count: 5, full_pass: false, clusters: [], truncated: false }, cluster_degraded: deg } }),
      describeDegradation: (d) => `budget ${d.reason}`, owner: 'o', leaseMs: 60_000,
    });
    expect(await readReclusterJob(db, j1.job_id)).toMatchObject({ state: 'degraded', reason: 'budget', skip_reason: 'budget budget' });

    const j2 = await enqueueReclusterJob(db, { scope: 'subset', subset: { filters: { topic: 't' }, persist: true } });
    await runPendingSubsetReclusterJob(db, { runIsolated: vi.fn().mockResolvedValue({ ok: false, error: 'timeout' }), describeDegradation: () => '', owner: 'o', leaseMs: 60_000 });
    expect(await readReclusterJob(db, j2.job_id)).toMatchObject({ state: 'failed', reason: 'child_failed', error: 'timeout' });

    const j3 = await enqueueReclusterJob(db, { scope: 'subset', subset: { filters: { topic: 't' }, persist: true } });
    await runPendingSubsetReclusterJob(db, { runIsolated: vi.fn().mockRejectedValue(new Error('boom')), describeDegradation: () => '', owner: 'o', leaseMs: 60_000 });
    expect(await readReclusterJob(db, j3.job_id)).toMatchObject({ state: 'failed', error: 'boom' });
  });

  it('90ba140a AC-B4: a refused fork (one-holder child still busy) hands the subset job back to pending instead of failing it', async () => {
    const j = await enqueueReclusterJob(db, { scope: 'subset', subset: { filters: { topic: 't' }, persist: true } });
    const out = await runPendingSubsetReclusterJob(db, {
      runIsolated: vi.fn().mockResolvedValue({ ok: false, code: 'holder_busy', error: 'previous enrich child still running (pid 1); not forking a second holder for this store' }),
      describeDegradation: () => '', owner: 'o', leaseMs: 60_000,
    });
    expect(out).toEqual({ ran: false });
    expect(await readReclusterJob(db, j.job_id)).toMatchObject({ state: 'queued', status: 'pending', owner: null });
    const again = await runPendingSubsetReclusterJob(db, {
      runIsolated: vi.fn().mockResolvedValue({ ok: true, result: { subset: { persisted: true, candidate_count: 1, cluster_count: 1, unclustered_count: 0, full_pass: false, clusters: [], truncated: false } } }),
      describeDegradation: () => '', owner: 'o', leaseMs: 60_000,
    });
    expect(again).toMatchObject({ ran: true, job_id: j.job_id, state: 'completed' });
  });

  it('90ba140a AC-B2 AC-B3: while the isolated child runs the job is observably running and a second request joins it', async () => {
    const j = await enqueueReclusterJob(db, { scope: 'subset', subset: { filters: { topic: 't' }, persist: true } });
    let release!: (v: unknown) => void;
    const gate = new Promise((r) => (release = r));
    const running = runPendingSubsetReclusterJob(db, {
      runIsolated: () => gate as never, describeDegradation: () => '', owner: 'o', leaseMs: 60_000,
    });
    await vi.waitFor(async () => expect((await readReclusterJob(db, j.job_id))!.state).toBe('running'));
    expect(await enqueueReclusterJob(db, {})).toMatchObject({ job_id: j.job_id, joined: true, state: 'running' });
    release({ ok: false, error: 'stop' });
    await running;
    expect((await readReclusterJob(db, j.job_id))!.state).toBe('failed');
  });
});
