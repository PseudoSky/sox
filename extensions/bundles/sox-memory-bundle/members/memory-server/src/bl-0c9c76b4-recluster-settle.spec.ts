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
 * Item: 0c9c76b4 AC7, AC8. Risk map: settle branch + recordFullPassOutcome in
 * runEnrichPassOnDb; seeded faults: drop the `degraded` settle branch (AC7),
 * drop the recordFullPassOutcome call (AC8).
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
