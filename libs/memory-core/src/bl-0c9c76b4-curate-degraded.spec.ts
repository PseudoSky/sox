/**
 * bl-0c9c76b4-curate-degraded.spec.ts
 *
 * Failure mode: `memoryCurate {op:'recluster', filters}` drops the `degraded`
 * marker clusterSubset now returns, so a subset pass that was refused (nodeCap)
 * or aborted (budget) reads as an ordinary empty result.
 * Tier: S (clusterSubset mocked at the module boundary; no store opened).
 * Gap: does not exercise a real over-cap corpus; that is covered by
 * bl-0c9c76b4-nodecap.spec.ts at the clusterSubset layer.
 * Item: 0c9c76b4 AC9. Risk map: the only changed line is the spread in
 * curateRecluster; a seeded fault (delete it) must fail the first test.
 */
import { describe, it, expect, vi } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';

const { subsetMock } = vi.hoisted(() => ({ subsetMock: vi.fn() }));

vi.mock('./cluster.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./cluster.js')>();
  return { ...actual, clusterSubset: subsetMock };
});

import { memoryCurate } from './curate.js';

const ADAPTER = {} as StoreAdapter;
const ARGS = { op: 'recluster', filters: { topic: 'x' } };

describe('0c9c76b4 AC9 curateRecluster carries degraded through', () => {
  it('0c9c76b4 AC9: a nodeCap-degraded subset pass surfaces `degraded`', async () => {
    const degraded = { reason: 'nodeCap', episodeCount: 20000, nodeCap: 16000 } as const;
    subsetMock.mockResolvedValueOnce({
      clusters: [], persisted: false, candidate_count: 20000, unclustered_count: 20000,
      full_pass: false, degraded,
    });
    const res = (await memoryCurate(ADAPTER, ARGS)) as Record<string, unknown>;
    expect(res['degraded']).toEqual(degraded);
  });

  it('0c9c76b4 AC9: a budget-degraded subset pass surfaces `degraded`', async () => {
    const degraded = { reason: 'budget', episodeCount: 9000, budgetMs: 1000, elapsedMs: 1500 } as const;
    subsetMock.mockResolvedValueOnce({
      clusters: [], persisted: false, candidate_count: 9000, unclustered_count: 9000,
      full_pass: true, degraded,
    });
    const res = (await memoryCurate(ADAPTER, ARGS)) as Record<string, unknown>;
    expect(res['degraded']).toEqual(degraded);
  });

  it('0c9c76b4 AC9: an un-degraded pass has no `degraded` key', async () => {
    subsetMock.mockResolvedValueOnce({
      clusters: [], persisted: false, candidate_count: 0, unclustered_count: 0, full_pass: true,
    });
    const res = (await memoryCurate(ADAPTER, ARGS)) as Record<string, unknown>;
    expect('degraded' in res).toBe(false);
  });
});
