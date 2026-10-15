/**
 * bl-0c9c76b4-recluster-settle.spec.ts
 *
 * Failure mode: a requested full recluster that memory-core refused (nodeCap)
 * or aborted (budget) is settled `completed`, or settles `skipped` with no
 * visible numbers, and memory_ping stays silent so a store that has not
 * reorganised looks healthy.
 * Tier: S. The isolated enrich child boundary (`runEnrichIsolatedGated`) is
 * mocked: no process is forked. Real temp sqlite store for jobs and ping.
 * Gap: the real child -> parent JSON hop of `cluster_degraded` is not run here.
 * Item: 0c9c76b4 AC7, AC8, AC12, AC13, AC14. Risk map: settle branch +
 * recordFullPassOutcome + fullPassRetryGate + clusterBudgetMs plumbing in
 * runEnrichPassOnDb. The retry clock is the `nowMs` seam; the child is mocked.
 *
 * Recorded red runs (2026-10-15, worktree recluster-fix-c2). Each seeded fault
 * was applied to src/index.ts alone, the spec run with
 *   npx nx test memory-server -- src/bl-0c9c76b4-recluster-settle.spec.ts
 * (exit 1 each time), then index.ts restored byte-identical (git diff clean
 * for the fault line); the unmutated tree exits 0 with 16 tests passing.
 *   AC7  drop the `degraded` settle branch      -> 2 red: AC7 nodeCap settles skipped; AC7 budget settles skipped
 *   AC8  recordFullPassOutcome called with false -> 6 red: AC8 raised/cleared; AC12 x2; AC13 give-up; AC8 skipped-keeps-alarm; AC8 incremental-failure-keeps-alarm
 *   AC8  `if (!requestedFull) return` removed   -> 3 red: AC8 raised/cleared; AC13 give-up; AC8 ok:false unit
 *   AC8  `if (!outcome.skipped)` made always-delete -> 1 red: AC8 non-degraded skipped pass does NOT clear the alarm
 *   AC12 backoff gate disabled                  -> 2 red: AC12 no re-fork inside the window; AC13 retries/give-up
 *   AC12 child-failure record not passed        -> 3 red: AC12 timed-out raises child_failed; AC12 non-timeout; AC13
 *   AC13 give-up never reached                  -> 1 red: AC13 retries then gives up
 *   AC14 clusterBudgetMs not passed to the child -> 2 red: AC14 default 540000; AC14 env-tuned 90%
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

import { closeCachedAdapter, getDb } from '@adhd/sox-memory-core';
import {
  handleToolCall,
  runEnrichPassOnDb,
  recordFullPassOutcome,
  snapshotFullPassDegraded,
  fullPassRetryDelayMs,
  fullPassClusterBudgetMs,
  FULL_PASS_MAX_ATTEMPTS,
  _resetFullPassDegradedForTest,
} from './index.js';

type Resp = { content: Array<{ text?: string }> };
const parse = (r: unknown): Record<string, unknown> =>
  JSON.parse((r as Resp).content[0]?.text ?? '{}') as Record<string, unknown>;

const cleanups: Array<() => void> = [];
function tmpStore(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'bl0c9c76b4-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'store.db');
}

const BASE = {
  communities_upserted: 0, member_of_edges: 0, importance_updated: 0,
  relates_to_edges: 0, topics_backfilled: 0, legacy_nodes_stamped: 0,
  embed_model_backfilled: 0, incremental_joined: 0,
};
const NODECAP = { reason: 'nodeCap', episodeCount: 20000, nodeCap: 16000 } as const;
const BUDGET = { reason: 'budget', episodeCount: 9000, budgetMs: 1000, elapsedMs: 1500 } as const;

function childReturns(result: Record<string, unknown>): void {
  gatedMock.mockResolvedValueOnce({ ok: true, result: { ...BASE, ...result } });
}
const degradedResult = (d: Record<string, unknown>, reason: string) => ({
  cluster_pass_skipped: true, cluster_skip_reason: reason, cluster_degraded: d,
});
const cleanResult = { cluster_pass_skipped: false };

async function requestRecluster(dbPath: string): Promise<string> {
  const out = parse(await handleToolCall('memory_curate', { db_path: dbPath, op: 'recluster' }));
  return out['job_id'] as string;
}
async function status(dbPath: string, jobId: string): Promise<Record<string, unknown>> {
  return parse(await handleToolCall('memory_curate', { db_path: dbPath, op: 'recluster_status', job_id: jobId }));
}
async function ping(dbPath: string): Promise<{ cluster?: { full_pass_degraded: Record<string, unknown> | null } }> {
  return parse(await handleToolCall('memory_ping', { db_path: dbPath })) as never;
}

beforeEach(() => {
  gatedMock.mockReset();
  _resetFullPassDegradedForTest();
});
afterEach(() => {
  for (const c of cleanups.splice(0)) c();
});

describe('0c9c76b4 AC7 degraded full pass settles skipped', () => {
  it('0c9c76b4 AC7: nodeCap degradation settles `skipped` with reason, episodeCount and nodeCap', async () => {
    const dbPath = tmpStore();
    const adapter = await getDb(dbPath);
    const jobId = await requestRecluster(dbPath);
    childReturns(degradedResult(NODECAP, 'child text that must not be needed'));
    await runEnrichPassOnDb(adapter, dbPath, { acquireHealSlot: false });

    const st = await status(dbPath, jobId);
    expect(st['status']).toBe('skipped');
    expect(st['status']).not.toBe('completed');
    const reason = String(st['skip_reason']);
    expect(reason).toContain('nodeCap');
    expect(reason).toContain('20000');
    expect(reason).toContain('16000');
    await closeCachedAdapter(dbPath);
  });

  it('0c9c76b4 AC7: budget degradation settles `skipped` with reason and episodeCount', async () => {
    const dbPath = tmpStore();
    const adapter = await getDb(dbPath);
    const jobId = await requestRecluster(dbPath);
    childReturns(degradedResult(BUDGET, 'x'));
    await runEnrichPassOnDb(adapter, dbPath, { acquireHealSlot: false });

    const st = await status(dbPath, jobId);
    expect(st['status']).toBe('skipped');
    const reason = String(st['skip_reason']);
    expect(reason).toContain('budget');
    expect(reason).toContain('9000');
    await closeCachedAdapter(dbPath);
  });

  it('0c9c76b4 AC7: control — an un-degraded full pass still settles `completed`', async () => {
    const dbPath = tmpStore();
    const adapter = await getDb(dbPath);
    const jobId = await requestRecluster(dbPath);
    childReturns(cleanResult);
    await runEnrichPassOnDb(adapter, dbPath, { acquireHealSlot: false });
    expect((await status(dbPath, jobId))['status']).toBe('completed');
    await closeCachedAdapter(dbPath);
  });
});

describe('0c9c76b4 AC8 memory_ping cluster.full_pass_degraded alarm', () => {
  it('0c9c76b4 AC8: absent alarm reads null (additive field is present and typed)', async () => {
    const dbPath = tmpStore();
    await getDb(dbPath);
    const p = await ping(dbPath);
    expect(p.cluster).toBeDefined();
    expect(p.cluster?.full_pass_degraded).toBeNull();
    await closeCachedAdapter(dbPath);
  });

  it('0c9c76b4 AC8: raised by a degraded requested full pass, since is stable, cleared by a later clean full pass', async () => {
    const dbPath = tmpStore();
    const adapter = await getDb(dbPath);

    await requestRecluster(dbPath);
    childReturns(degradedResult(NODECAP, 'r'));
    await runEnrichPassOnDb(adapter, dbPath, { acquireHealSlot: false });
    const first = (await ping(dbPath)).cluster?.full_pass_degraded;
    expect(first).toMatchObject({ reason: 'nodeCap', episodeCount: 20000, nodeCap: 16000 });
    expect(typeof first?.['since']).toBe('string');

    // A second degraded request keeps the original `since` and updates the numbers.
    await requestRecluster(dbPath);
    childReturns(degradedResult({ ...NODECAP, episodeCount: 21000 }, 'r'));
    await runEnrichPassOnDb(adapter, dbPath, { acquireHealSlot: false });
    const second = (await ping(dbPath)).cluster?.full_pass_degraded;
    expect(second?.['episodeCount']).toBe(21000);
    expect(second?.['since']).toBe(first?.['since']);

    // An incremental tick (no requested full pass) says nothing: alarm stays.
    childReturns(cleanResult);
    await runEnrichPassOnDb(adapter, dbPath, { acquireHealSlot: false });
    expect((await ping(dbPath)).cluster?.full_pass_degraded).not.toBeNull();

    // A later requested full pass that ran un-degraded clears it.
    await requestRecluster(dbPath);
    childReturns(cleanResult);
    await runEnrichPassOnDb(adapter, dbPath, { acquireHealSlot: false });
    expect((await ping(dbPath)).cluster?.full_pass_degraded).toBeNull();
    await closeCachedAdapter(dbPath);
  });
});

// ── C2 correction (AC12-AC14, C2-3) ──────────────────────────────────────────

const T0 = Date.parse('2026-10-15T00:00:00.000Z');
const MIN = 60_000;
const clock = { t: T0 };
const nowMs = (): number => clock.t;
const fullForks = (): number =>
  gatedMock.mock.calls.filter((c) => (c[1] as { incrementalCluster?: boolean }).incrementalCluster === false).length;

/** Run one tick at `T0 + atMin`. Default child answer is a clean un-degraded pass. */
async function tickAt(adapter: Awaited<ReturnType<typeof getDb>>, dbPath: string, atMin: number): Promise<void> {
  clock.t = T0 + atMin * MIN;
  await runEnrichPassOnDb(adapter, dbPath, { acquireHealSlot: false, nowMs });
}
const childFails = (error = 'timeout'): void => {
  gatedMock.mockResolvedValueOnce({ ok: false, error });
};
type Alarm = Record<string, unknown> | null | undefined;
const alarmOf = async (dbPath: string): Promise<Alarm> => (await ping(dbPath)).cluster?.full_pass_degraded;

describe('0c9c76b4 AC12 child failure of a requested full pass raises the alarm and is not re-forked every tick', () => {
  it('0c9c76b4 AC12: a timed-out full-pass child raises child_failed (timedOut, attempts, since) and the job stays pending', async () => {
    const dbPath = tmpStore();
    const adapter = await getDb(dbPath);
    const jobId = await requestRecluster(dbPath);
    gatedMock.mockResolvedValue({ ok: true, result: { ...BASE, ...cleanResult } });
    childFails('timeout');
    await tickAt(adapter, dbPath, 0);

    const a = await alarmOf(dbPath);
    expect(a).toMatchObject({
      reason: 'child_failed', timedOut: true, attempts: 1, error: 'timeout', episodeCount: null,
      since: new Date(T0).toISOString(),
      nextRetryAt: new Date(T0 + 15 * MIN).toISOString(),
    });
    expect((await status(dbPath, jobId))['status']).toBe('pending');
    await closeCachedAdapter(dbPath);
  });

  it('0c9c76b4 AC12: ticks inside the backoff window do not re-fork the full pass and leave the job pending', async () => {
    const dbPath = tmpStore();
    const adapter = await getDb(dbPath);
    const jobId = await requestRecluster(dbPath);
    gatedMock.mockResolvedValue({ ok: true, result: { ...BASE, ...cleanResult } });
    childFails('timeout');
    await tickAt(adapter, dbPath, 0);
    expect(fullForks()).toBe(1);

    for (const m of [5, 10, 14]) await tickAt(adapter, dbPath, m); // the 5-min cadence
    expect(fullForks()).toBe(1); // BEFORE the fix: 4 (one full fork per tick)
    expect((await status(dbPath, jobId))['status']).toBe('pending');
    // The deferred ticks still ran as incremental passes.
    expect(gatedMock.mock.calls.length).toBe(4);
    await closeCachedAdapter(dbPath);
  });

  it('0c9c76b4 AC12: a non-timeout child failure raises the alarm with timedOut=false and its error', async () => {
    const dbPath = tmpStore();
    const adapter = await getDb(dbPath);
    await requestRecluster(dbPath);
    childFails('signal:SIGKILL');
    await tickAt(adapter, dbPath, 0);
    expect(await alarmOf(dbPath)).toMatchObject({ reason: 'child_failed', timedOut: false, error: 'signal:SIGKILL' });
    await closeCachedAdapter(dbPath);
  });
});

describe('0c9c76b4 AC13 retry of a failed full pass is bounded with backoff', () => {
  it('0c9c76b4 AC13: delays are 15, 30, 60 min and cap at 60 min', () => {
    expect([1, 2, 3, 4, 9].map(fullPassRetryDelayMs)).toEqual([15 * MIN, 30 * MIN, 60 * MIN, 60 * MIN, 60 * MIN]);
  });

  it('0c9c76b4 AC13: retries at 15/45/105 min, then gives up: job failed, row completed, never re-forks', async () => {
    const dbPath = tmpStore();
    const adapter = await getDb(dbPath);
    const jobId = await requestRecluster(dbPath);
    gatedMock.mockResolvedValue({ ok: true, result: { ...BASE, ...cleanResult } });

    childFails(); await tickAt(adapter, dbPath, 0);    // attempt 1, next +15
    await tickAt(adapter, dbPath, 14);
    expect(fullForks()).toBe(1);
    childFails(); await tickAt(adapter, dbPath, 15);   // attempt 2, next +30 => 45
    expect((await alarmOf(dbPath))?.['attempts']).toBe(2);
    await tickAt(adapter, dbPath, 44);
    expect(fullForks()).toBe(2);
    childFails(); await tickAt(adapter, dbPath, 45);   // attempt 3, next +60 => 105
    expect((await alarmOf(dbPath))?.['attempts']).toBe(3);
    await tickAt(adapter, dbPath, 104);
    expect(fullForks()).toBe(3);
    expect((await status(dbPath, jobId))['status']).toBe('pending');

    childFails(); await tickAt(adapter, dbPath, 105);  // attempt 4 == FULL_PASS_MAX_ATTEMPTS
    expect(FULL_PASS_MAX_ATTEMPTS).toBe(4);
    expect(fullForks()).toBe(4);
    const st = await status(dbPath, jobId);
    expect(st['status']).toBe('failed');
    expect(String(st['error'])).toContain('gave up');
    expect(await alarmOf(dbPath)).toMatchObject({ reason: 'child_failed', attempts: 4, nextRetryAt: null });

    for (const m of [110, 600, 6000]) await tickAt(adapter, dbPath, m);
    expect(fullForks()).toBe(4); // the row is completed: nothing re-forks, however long we wait
    expect(await alarmOf(dbPath)).toMatchObject({ reason: 'child_failed' }); // alarm persists
    await closeCachedAdapter(dbPath);
  });

  it('0c9c76b4 AC13: a new explicit recluster request resets the budget; a clean pass then clears the alarm', async () => {
    const dbPath = tmpStore();
    const adapter = await getDb(dbPath);
    await requestRecluster(dbPath);
    gatedMock.mockResolvedValue({ ok: true, result: { ...BASE, ...cleanResult } });
    childFails(); await tickAt(adapter, dbPath, 0);
    expect(fullForks()).toBe(1);

    const second = await requestRecluster(dbPath); // inside the backoff window
    await tickAt(adapter, dbPath, 1);
    expect(fullForks()).toBe(2); // not deferred: a fresh request
    expect((await status(dbPath, second))['status']).toBe('completed');
    expect(await alarmOf(dbPath)).toBeNull();
    await closeCachedAdapter(dbPath);
  });
});

describe('0c9c76b4 AC14 cluster budget is derived from the actual child timeout', () => {
  const saved = process.env['SOX_ENRICH_FULL_TIMEOUT_MS'];
  afterEach(() => {
    if (saved === undefined) delete process.env['SOX_ENRICH_FULL_TIMEOUT_MS'];
    else process.env['SOX_ENRICH_FULL_TIMEOUT_MS'] = saved;
  });

  it('0c9c76b4 AC14: default 600 s timeout passes clusterBudgetMs 540000 to the child; incremental ticks pass none', async () => {
    delete process.env['SOX_ENRICH_FULL_TIMEOUT_MS'];
    const dbPath = tmpStore();
    const adapter = await getDb(dbPath);
    gatedMock.mockResolvedValue({ ok: true, result: { ...BASE, ...cleanResult } });
    await tickAt(adapter, dbPath, 0); // incremental
    await requestRecluster(dbPath);
    await tickAt(adapter, dbPath, 5); // full
    const [incr, full] = gatedMock.mock.calls as Array<[string, Record<string, unknown>, unknown, number]>;
    expect(incr?.[1]).toEqual({ incrementalCluster: true });
    expect(full?.[1]).toEqual({ incrementalCluster: false, clusterBudgetMs: 540_000 });
    expect(full?.[3]).toBe(600_000);
    await closeCachedAdapter(dbPath);
  });

  it('0c9c76b4 AC14: an env-tuned SOX_ENRICH_FULL_TIMEOUT_MS moves the budget to 90% of it', async () => {
    process.env['SOX_ENRICH_FULL_TIMEOUT_MS'] = '100000';
    expect(fullPassClusterBudgetMs()).toBe(90_000);
    const dbPath = tmpStore();
    const adapter = await getDb(dbPath);
    gatedMock.mockResolvedValue({ ok: true, result: { ...BASE, ...cleanResult } });
    await requestRecluster(dbPath);
    await tickAt(adapter, dbPath, 0);
    const call = gatedMock.mock.calls[0] as [string, Record<string, unknown>, unknown, number];
    expect(call[1]['clusterBudgetMs']).toBe(90_000);
    expect(call[3]).toBe(100_000);
    await closeCachedAdapter(dbPath);
  });
});

describe('0c9c76b4 AC8 (C2-3) the alarm survives outcomes that say nothing about full-pass health', () => {
  async function raiseNodeCap(adapter: Awaited<ReturnType<typeof getDb>>, dbPath: string): Promise<Alarm> {
    await requestRecluster(dbPath);
    childReturns(degradedResult(NODECAP, 'r'));
    await tickAt(adapter, dbPath, 0);
    const a = await alarmOf(dbPath);
    expect(a).toMatchObject({ reason: 'nodeCap' });
    return a;
  }

  it('0c9c76b4 AC8: a non-degraded cluster_pass_skipped full pass (mixed-model guard) does NOT clear the alarm', async () => {
    const dbPath = tmpStore();
    const adapter = await getDb(dbPath);
    const before = await raiseNodeCap(adapter, dbPath);
    await requestRecluster(dbPath);
    childReturns({ cluster_pass_skipped: true, cluster_skip_reason: 'mixed-model guard' });
    await tickAt(adapter, dbPath, 5);
    expect(await alarmOf(dbPath)).toEqual(before);
    await closeCachedAdapter(dbPath);
  });

  it('0c9c76b4 AC8: a failed INCREMENTAL child (no requested full pass) leaves the alarm byte-identical', async () => {
    const dbPath = tmpStore();
    const adapter = await getDb(dbPath);
    const before = await raiseNodeCap(adapter, dbPath);
    gatedMock.mockResolvedValueOnce({ ok: false, error: 'timeout' });
    await tickAt(adapter, dbPath, 5);
    expect(fullForks()).toBe(1);
    expect(await alarmOf(dbPath)).toEqual(before);
    await closeCachedAdapter(dbPath);
  });

  it('0c9c76b4 AC8: recordFullPassOutcome ok:false without a child-failure record neither raises nor clears', () => {
    const p = path.join(os.tmpdir(), 'bl0c9c76b4-unit', 'store.db');
    recordFullPassOutcome(p, true, { ok: false });
    expect(snapshotFullPassDegraded(p)).toBeNull();
    recordFullPassOutcome(p, true, { ok: true, degraded: { ...NODECAP } });
    const raised = snapshotFullPassDegraded(p);
    expect(raised).not.toBeNull();
    recordFullPassOutcome(p, true, { ok: false });
    expect(snapshotFullPassDegraded(p)).toEqual(raised);
    recordFullPassOutcome(p, false, { ok: true });
    expect(snapshotFullPassDegraded(p)).toEqual(raised);
  });
});
