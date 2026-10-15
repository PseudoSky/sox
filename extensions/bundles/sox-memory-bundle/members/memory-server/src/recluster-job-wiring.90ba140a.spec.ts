/**
 * recluster-job-wiring.90ba140a.spec.ts
 *
 * Failure mode: `memory_curate recluster` ran synchronously (-32001), and with
 * many servers on one store each server's tick could fork its own full pass.
 * Tier: S. The isolated enrich child boundary (`runEnrichIsolatedGated`) is
 * mocked: nothing is forked. Real temp sqlite stores; a SECOND server is
 * modelled by a lease held under a different owner id (a store-level fact, which
 * is the point: the guard must not depend on in-process state).
 * Items: 90ba140a / 2f998081 AC-B1 .. AC-B4. Risk map: curate handler, the
 * claim/release/settle wiring in runEnrichPassOnDb, runReclusterSubsetJobOnDb,
 * the request watcher, memory_ping cluster.recluster_job.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { gatedMock } = vi.hoisted(() => ({ gatedMock: vi.fn() }));

vi.mock('@adhd/sox-memory-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@adhd/sox-memory-core')>();
  return { ...actual, runEnrichIsolatedGated: gatedMock };
});

import { claimGlobalReclusterJobs, closeCachedAdapter, getDb } from '@adhd/sox-memory-core';
import {
  handleToolCall,
  pollReclusterRequestsOnce,
  runEnrichPassOnDb,
  runReclusterSubsetJobOnDb,
  _resetFullPassDegradedForTest,
} from './index.js';

type Resp = { content: Array<{ text?: string }> };
const parse = (r: unknown): Record<string, unknown> =>
  JSON.parse((r as Resp).content[0]?.text ?? '{}') as Record<string, unknown>;

const cleanups: Array<() => void> = [];
function tmpStore(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bl90ba140a-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'store.db');
}
const BASE = {
  communities_upserted: 0, member_of_edges: 0, importance_updated: 0,
  relates_to_edges: 0, topics_backfilled: 0, legacy_nodes_stamped: 0,
  embed_model_backfilled: 0, incremental_joined: 0, cluster_pass_skipped: false,
};
const curate = async (dbPath: string, args: Record<string, unknown>) =>
  parse(await handleToolCall('memory_curate', { db_path: dbPath, ...args }));
const status = (dbPath: string, jobId: string) => curate(dbPath, { op: 'recluster_status', job_id: jobId });
const ping = async (dbPath: string) =>
  parse(await handleToolCall('memory_ping', { db_path: dbPath })) as {
    cluster?: { recluster_job: Record<string, unknown> | null; full_pass_degraded: Record<string, unknown> | null };
  };

beforeEach(() => {
  gatedMock.mockReset();
  _resetFullPassDegradedForTest();
});
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe('90ba140a AC-B1 the MCP call returns a handle promptly', () => {
  it('90ba140a AC-B1: filtered recluster resolves with a queued handle while the isolated child would never finish', async () => {
    gatedMock.mockImplementation(() => new Promise(() => undefined));
    const dbPath = tmpStore();
    const t0 = Date.now();
    const res = await Promise.race([
      curate(dbPath, { op: 'recluster', filters: { project_path: '/x' } }),
      new Promise<'TIMED_OUT'>((r) => setTimeout(() => r('TIMED_OUT'), 2000)),
    ]);
    expect(res).not.toBe('TIMED_OUT');
    const r = res as Record<string, unknown>;
    expect(r['state']).toBe('queued');
    expect(r['scope']).toBe('subset');
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(gatedMock).not.toHaveBeenCalled();
    await closeCachedAdapter(dbPath);
  });

  it('90ba140a AC-B1: whole-store recluster resolves with a queued handle without running the pass', async () => {
    gatedMock.mockImplementation(() => new Promise(() => undefined));
    const dbPath = tmpStore();
    const r = await curate(dbPath, { op: 'recluster' });
    expect(r).toMatchObject({ scope: 'global', enqueued: true, state: 'queued' });
    expect(gatedMock).not.toHaveBeenCalled();
    await closeCachedAdapter(dbPath);
  });
});

describe('90ba140a AC-B3 the full pass is single-flight across servers', () => {
  it('90ba140a AC-B3: the winning tick forks ONE full pass and settles the job completed with timestamps', async () => {
    const dbPath = tmpStore();
    const adapter = await getDb(dbPath);
    const { job_id } = await curate(dbPath, { op: 'recluster' }) as { job_id: string };
    gatedMock.mockResolvedValueOnce({ ok: true, result: { ...BASE } });
    await runEnrichPassOnDb(adapter, dbPath, { acquireHealSlot: false });
    expect(gatedMock).toHaveBeenCalledTimes(1);
    expect(gatedMock.mock.calls[0]![1]).toMatchObject({ incrementalCluster: false });
    const st = await status(dbPath, job_id);
    expect(st['state']).toBe('completed');
    expect(typeof st['started_at']).toBe('string');
    expect(typeof st['finished_at']).toBe('string');
    await closeCachedAdapter(dbPath);
  });

  it('90ba140a AC-B3: a tick on a server that does not hold the lease runs incremental and never settles the job', async () => {
    const dbPath = tmpStore();
    const adapter = await getDb(dbPath);
    const { job_id, seq } = await curate(dbPath, { op: 'recluster' }) as { job_id: string; seq: number };
    // Another server (different process) already holds the job.
    await claimGlobalReclusterJobs(adapter, { maxSeq: seq, owner: 'other-host:1:other-instance', leaseMs: 600_000 });
    gatedMock.mockResolvedValue({ ok: true, result: { ...BASE } });
    await runEnrichPassOnDb(adapter, dbPath, { acquireHealSlot: false });
    // no full pass was forked from this server
    for (const call of gatedMock.mock.calls) expect(call[1]).toMatchObject({ incrementalCluster: true });
    const st = await status(dbPath, job_id);
    expect(st['state']).toBe('running');
    expect(st['owner']).toBe('other-host:1:other-instance');
    await closeCachedAdapter(dbPath);
  });

  it('90ba140a AC-B3: a second request while the pass runs returns the running handle (joined)', async () => {
    const dbPath = tmpStore();
    const adapter = await getDb(dbPath);
    const first = await curate(dbPath, { op: 'recluster' }) as { job_id: string; seq: number };
    await claimGlobalReclusterJobs(adapter, { maxSeq: first.seq, owner: 'srv', leaseMs: 600_000 });
    const again = await curate(dbPath, { op: 'recluster' });
    expect(again).toMatchObject({ job_id: first.job_id, joined: true, state: 'running' });
    const filtered = await curate(dbPath, { op: 'recluster', filters: { topic: 't' } });
    expect(filtered).toMatchObject({ job_id: first.job_id, joined: true });
    await closeCachedAdapter(dbPath);
  });
});

describe('90ba140a AC-B4 degraded / failed outcomes surface through the settle path', () => {
  it('90ba140a AC-B4: a nodeCap-degraded full pass settles degraded with reason and raises the ping alarm; ping carries the job', async () => {
    const dbPath = tmpStore();
    const adapter = await getDb(dbPath);
    const { job_id } = await curate(dbPath, { op: 'recluster' }) as { job_id: string };
    gatedMock.mockResolvedValueOnce({
      ok: true,
      result: { ...BASE, cluster_pass_skipped: true, cluster_skip_reason: 'x',
        cluster_degraded: { reason: 'nodeCap', episodeCount: 20000, nodeCap: 16000 } },
    });
    await runEnrichPassOnDb(adapter, dbPath, { acquireHealSlot: false });
    const st = await status(dbPath, job_id);
    expect(st).toMatchObject({ state: 'degraded', reason: 'nodeCap' });
    expect(String(st['skip_reason'])).toContain('nodeCap');
    const p = await ping(dbPath);
    expect(p.cluster?.full_pass_degraded).toMatchObject({ reason: 'nodeCap' });
    expect(p.cluster?.recluster_job).toMatchObject({ job_id, state: 'degraded', reason: 'nodeCap' });
    await closeCachedAdapter(dbPath);
  });

  it('90ba140a AC-B4: a failed child with retries left hands the job back WITH attempts and next_retry_at on the row', async () => {
    const dbPath = tmpStore();
    const adapter = await getDb(dbPath);
    const { job_id } = await curate(dbPath, { op: 'recluster' }) as { job_id: string };
    gatedMock.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    await runEnrichPassOnDb(adapter, dbPath, { acquireHealSlot: false });
    const st = await status(dbPath, job_id);
    expect(st['state']).toBe('queued');
    expect(st['attempts']).toBe(1);
    expect(typeof st['next_retry_at']).toBe('string');
    expect(st['error']).toBe('timeout');
    expect((await ping(dbPath)).cluster?.full_pass_degraded).toMatchObject({ reason: 'child_failed' });
    await closeCachedAdapter(dbPath);
  });
});

describe('90ba140a AC-B1 AC-B2 AC-B4 filtered job runs through the isolated child', () => {
  it('90ba140a AC-B1: runReclusterSubsetJobOnDb claims, runs the child with subsetRecluster, settles completed with the result', async () => {
    const dbPath = tmpStore();
    const adapter = await getDb(dbPath);
    const { job_id } = await curate(dbPath, { op: 'recluster', filters: { project_path: '/p' }, threshold: 0.9 }) as { job_id: string };
    gatedMock.mockResolvedValueOnce({
      ok: true,
      result: { ...BASE, subset: { persisted: true, provenance_hash: 'h', candidate_count: 4, cluster_count: 1, unclustered_count: 0, full_pass: true, clusters: [], truncated: false } },
    });
    const out = await runReclusterSubsetJobOnDb(adapter, dbPath);
    expect(out).toMatchObject({ ran: true, job_id, state: 'completed' });
    expect(gatedMock.mock.calls[0]![1]).toMatchObject({
      subsetRecluster: { filter: { project_path: '/p' }, persist: true, threshold: 0.9 },
    });
    const st = await status(dbPath, job_id);
    expect(st).toMatchObject({ state: 'completed', result: { candidate_count: 4, provenance_hash: 'h' } });
    await closeCachedAdapter(dbPath);
  });

  it('90ba140a AC-B4: a failed filtered child settles failed — reported, not silent', async () => {
    const dbPath = tmpStore();
    const adapter = await getDb(dbPath);
    const { job_id } = await curate(dbPath, { op: 'recluster', filters: { topic: 't' } }) as { job_id: string };
    gatedMock.mockResolvedValueOnce({ ok: false, error: 'exit:1' });
    await runReclusterSubsetJobOnDb(adapter, dbPath);
    expect(await status(dbPath, job_id)).toMatchObject({ state: 'failed', reason: 'child_failed', error: 'exit:1' });
    await closeCachedAdapter(dbPath);
  });
});

describe('90ba140a AC-B1 the request watcher starts a waiting job without waiting for the 5-minute tick', () => {
  it('90ba140a AC-B1: pollReclusterRequestsOnce is a no-op with nothing waiting and starts a tick when a request waits', async () => {
    const dbPath = tmpStore();
    const adapter = await getDb(dbPath);
    expect(await pollReclusterRequestsOnce()).toBe(false);
    const { job_id } = await curate(dbPath, { op: 'recluster' }) as { job_id: string };
    gatedMock.mockResolvedValue({ ok: true, result: { ...BASE } });
    expect(await pollReclusterRequestsOnce()).toBe(true);
    await vi.waitFor(async () => expect((await status(dbPath, job_id))['state']).toBe('completed'), { timeout: 15_000 });
    void adapter;
    await closeCachedAdapter(dbPath);
  });
});
