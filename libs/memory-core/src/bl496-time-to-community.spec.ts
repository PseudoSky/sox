/**
 * bl496-time-to-community.spec.ts — BL-496.
 *
 * The defect: there was no measurement of how long an episode takes to join a
 * community, and — the part that mattered more — no way at all to tell an
 * episode that was CONSIDERED AND REJECTED (below τ, will never cluster) from
 * one that simply had not been considered yet (will cluster on the next tick).
 * Both present identically in the database: a live episode with no MEMBER_OF
 * edge. `incrementalJoin` computed the deciding similarity on every tick and
 * discarded it at a bare `continue`.
 *
 * Each test below fails against the pre-fix code for a stated reason.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { memoryWrite } from './write.js';
import { runBatchEnrich } from './enrich-batch.js';
import {
  getClusterPipelineMetrics,
  recordClusterPassAdmission,
  _resetClusterMetricsForTest,
} from './cluster-metrics.js';

let priorAdapterEnv: string | undefined;
beforeEach(() => {
  priorAdapterEnv = process.env['STORE_ADAPTER'];
  process.env['STORE_ADAPTER'] = 'sqlite';
  _resetClusterMetricsForTest();
});
afterEach(() => {
  if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
  else process.env['STORE_ADAPTER'] = priorAdapterEnv;
  _resetClusterMetricsForTest();
});

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl496-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

// Same deterministic feature-hash vocabulary trick as
// cluster-incremental-join.spec.ts: shared words ⇒ high mutual cosine.
const GROUP_A = [
  'Alpha widget factory pipeline module orchestration handoff review notes one.',
  'Alpha widget factory pipeline module orchestration handoff review notes two.',
  'Alpha widget factory pipeline module orchestration handoff review notes three.',
];
const GROUP_A_JOINER = 'Alpha widget factory pipeline module orchestration handoff review notes four.';
const DISTRACTORS = [
  'Zephyr quokka bagpipe lighthouse tundra marmalade unrelated topic entirely apples.',
  'Xylophone crimson velvet asteroid marmot glacier ukulele unrelated content bananas.',
  'Trombone violet asteroid canyon marimba penguin unrelated subject matter cherries.',
  'Yonder crimson bramble otter waffle iguana completely different subject dates.',
];
/**
 * PARTIAL vocabulary overlap with GROUP_A — deliberately, not zero overlap.
 * Zero-overlap content produces an exactly-0.0 cosine under the deterministic
 * feature-hash provider, which would let a stubbed `max: 0` pass the
 * assertions below. A partial overlap forces a similarity strictly inside
 * (0, τ), so the test can only pass if the REAL computed value is recorded.
 */
const FOREIGN =
  'Alpha widget nebula harpsichord sediment ferrous quaternion obelisk saffron vellum thicket.';

/** Must exceed BULK_PASS_EDGE_THRESHOLD (100) in cluster-metrics.ts. */
const BULK_FIXTURE_COUNT = 120;

async function writeAll(adapter: StoreAdapter, contents: string[]): Promise<void> {
  for (const content of contents) {
    const r = await memoryWrite(adapter, { content, project_path: '/test/bl496' });
    if ('code' in r) throw new Error(`memoryWrite failed: ${JSON.stringify(r)}`);
  }
}

/** Seed a store that already has real communities (the live store's shape). */
async function seededStore(dir: string): Promise<StoreAdapter> {
  const adapter = await openDb(path.join(dir, 't.db'));
  await writeAll(adapter, GROUP_A);
  await writeAll(adapter, DISTRACTORS);
  await runBatchEnrich(adapter, { incrementalCluster: false });
  return adapter;
}

describe('BL-496 — a rejected episode is distinguishable from an unconsidered one', () => {
  it('reports rejected_below_threshold for an episode the join REFUSED (pre-fix: no such field — a rejection wrote nothing anywhere)', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seededStore(dir);

      // An episode with no vocabulary overlap with any seeded community. The
      // join will compare it against every live member and refuse it.
      const w = await memoryWrite(adapter, { content: FOREIGN, project_path: '/test/bl496' });
      if ('code' in w) throw new Error('write failed');

      const res = await runBatchEnrich(adapter, { incrementalCluster: true });

      // The pre-fix code returned no `cluster_admission` at all: this whole
      // assertion block is unrepresentable against it.
      expect(res.cluster_admission).toBeDefined();
      const adm = res.cluster_admission!;

      expect(adm.considered).toBeGreaterThanOrEqual(1);
      expect(adm.rejected_below_threshold).toBeGreaterThanOrEqual(1);
      expect(adm.joined).toBe(0);
      // The deciding similarity — computed pre-fix, then thrown away.
      expect(adm.rejected_best_sim.max).toBeGreaterThan(0);
      expect(adm.rejected_best_sim.max).toBeLessThan(adm.threshold);
      // There WERE targets; the refusal was a similarity decision, not an
      // absence of anything to join. Distinguishing these is the point.
      expect(adm.community_targets).toBeGreaterThan(0);

      cleanup();
    } finally {
      /* cleanup runs above on success; tmpdir is disposable regardless */
    }
  });

  it('reports joined (not rejected) for an episode the join ACCEPTED — the two outcomes are not conflated', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seededStore(dir);

      const w = await memoryWrite(adapter, { content: GROUP_A_JOINER, project_path: '/test/bl496' });
      if ('code' in w) throw new Error('write failed');

      const res = await runBatchEnrich(adapter, { incrementalCluster: true });
      const adm = res.cluster_admission!;

      expect(adm.joined).toBeGreaterThanOrEqual(1);
      expect(res.incremental_joined).toBe(adm.joined);
      cleanup();
    } finally {
      /* disposable */
    }
  });

  it('community_targets:0 distinguishes "nothing to join" from "nothing matched" (pre-fix both were joined:0)', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      // No full pass ever ran, so no community exists. The incremental path
      // cannot CREATE one — every episode is structurally unassignable here,
      // which is a completely different condition from "below threshold".
      const adapter = await openDb(path.join(dir, 't.db'));
      await writeAll(adapter, GROUP_A);

      const res = await runBatchEnrich(adapter, { incrementalCluster: true });
      const adm = res.cluster_admission!;

      expect(adm.community_targets).toBe(0);
      expect(adm.joined).toBe(0);
      // Critically NOT counted as rejected — nothing was compared.
      expect(adm.rejected_below_threshold).toBe(0);
      cleanup();
    } finally {
      /* disposable */
    }
  });
});

describe('BL-496 — time-to-community is measurable', () => {
  it('derives a time_to_community_ms distribution from MEMBER_OF edge timestamps (pre-fix: no such measurement existed anywhere)', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seededStore(dir);
      const storeKey = path.join(dir, 't.db');

      const m = await getClusterPipelineMetrics(adapter, storeKey);

      expect(m.time_to_community_samples).toBeGreaterThan(0);
      expect(m.time_to_community_ms.p50).toBeGreaterThanOrEqual(0);
      expect(m.community_count).toBeGreaterThan(0);
      expect(m.clustered_episodes).toBeGreaterThan(0);
      expect(m.coverage).toBeGreaterThan(0);
      expect(m.coverage).toBeLessThanOrEqual(1);
      cleanup();
    } finally {
      /* disposable */
    }
  });

  it('excludes bulk re-partition passes from the latency distribution (a 3,478-edge backfill made the live p50 read 43 days instead of 9 minutes)', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seededStore(dir);
      const storeKey = path.join(dir, 't.db');

      // Simulate the live store's shape: one historical full pass that
      // assigned a large number of old episodes at a single instant. Its edge
      // "lag" is each episode's age at sweep time, not any clustering latency.
      const backfillTs = new Date().toISOString();
      const community = (await adapter.executeGet<{ rowid: number }>(
        `SELECT rowid FROM node WHERE kind = 'community' AND t_invalid IS NULL LIMIT 1`,
      ))!;
      // Ancient episodes swept by that pass.
      for (let i = 0; i < BULK_FIXTURE_COUNT; i++) {
        await adapter.executeRun(
          `INSERT INTO node (uid, kind, content, project_path, t_created, t_valid)
           VALUES (?, 'episode', ?, '/test/bl496', '2020-01-01T00:00:00.000Z', '2020-01-01T00:00:00.000Z')`,
          [`bulk-${i}`, `Ancient backfilled episode number ${i} with sufficient content length here.`],
        );
        const row = (await adapter.executeGet<{ rowid: number }>(
          'SELECT rowid FROM node WHERE uid = ?',
          [`bulk-${i}`],
        ))!;
        await adapter.executeRun(
          `INSERT INTO edge (src, dst, rel, origin, weight, t_created)
           VALUES (?, ?, 'MEMBER_OF', 'inferred', 1.0, ?)`,
          [row.rowid, community.rowid, backfillTs],
        );
      }

      const m = await getClusterPipelineMetrics(adapter, storeKey);

      // The backfill is identified and quarantined, not averaged in.
      expect(m.bulk_pass_edges_excluded).toBeGreaterThanOrEqual(BULK_FIXTURE_COUNT);
      expect(m.last_bulk_pass_at).toBe(backfillTs);
      // A ~5-year-old lag must NOT appear in the distribution. Without the
      // exclusion, max would be >1e11 ms (the 2020→now span).
      const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000;
      expect(m.time_to_community_ms.max).toBeLessThan(FIVE_YEARS_MS);
      // And the real, small-pass samples survive the filter.
      expect(m.time_to_community_samples).toBeGreaterThan(0);
      cleanup();
    } finally {
      /* disposable */
    }
  });

  it('partitions the unclustered backlog by CAUSE — an ineligible short episode is never counted as awaiting', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seededStore(dir);
      const storeKey = path.join(dir, 't.db');

      // Below CLUSTER_MIN_CONTENT_LENGTH (50): selectEpisodes will never
      // return it, so no pass will ever consider it. Counting it as backlog
      // would make the awaiting number permanently non-draining.
      const short = await memoryWrite(adapter, { content: 'tiny note', project_path: '/test/bl496' });
      if ('code' in short) throw new Error('write failed');

      const m = await getClusterPipelineMetrics(adapter, storeKey);
      expect(m.backlog.ineligible).toBeGreaterThanOrEqual(1);
      cleanup();
    } finally {
      /* disposable */
    }
  });

  it('surfaces the last pass admission through the metrics snapshot (the child-process hand-off)', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seededStore(dir);
      const storeKey = path.join(dir, 't.db');

      // Fresh registry: honest null rather than a fabricated zero.
      expect((await getClusterPipelineMetrics(adapter, storeKey)).last_pass_admission).toBeNull();

      const w = await memoryWrite(adapter, { content: FOREIGN, project_path: '/test/bl496' });
      if ('code' in w) throw new Error('write failed');
      const res = await runBatchEnrich(adapter, { incrementalCluster: true });

      // What the memory-server parent does with the child's returned result.
      recordClusterPassAdmission(storeKey, res.cluster_admission!);

      const m = await getClusterPipelineMetrics(adapter, storeKey);
      expect(m.last_pass_admission).not.toBeNull();
      expect(m.last_pass_admission!.rejected_below_threshold).toBeGreaterThanOrEqual(1);
      expect(m.last_pass_admission!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

      // The headline pairing: episodes with no community, AND the positive
      // statement that they were refused rather than merely pending.
      expect(m.backlog.awaiting_or_rejected).toBeGreaterThanOrEqual(1);
      cleanup();
    } finally {
      /* disposable */
    }
  });
});
