/**
 * cluster-incremental-join.spec.ts — BL-326 / BL-349 (PKT-29).
 *
 * BL-326: `computeClusters`'s `incrementalOnly` branch was a dead stub that
 * ALWAYS returned `{ clusters: [], full_pass: false, unclustered_count:
 * episodes.length }` with no side effects — so no ordinary write could ever
 * result in a cluster assignment (live symptom: cluster_count=139,
 * total_clustered=0 against 4947 episodes).
 *
 * BL-349 (PKT-29): the fix is a write-triggered incremental local-neighborhood
 * JOIN against existing communities, consumed by the already-live periodic
 * enrich tick (`runEnrichPassOnDb` → `runEnrichIsolated` → `runBatchEnrich`
 * with `incrementalCluster: true`) — never inline in the write path, never
 * blocking or dropping an embedding.
 *
 * This test proves the ordinary write path — real `memoryWrite`, no manually
 * invoked full pass for the episode under test — results in a live cluster
 * assignment: `total_clustered` goes from NOT counting the new episode to
 * counting it, purely via `runBatchEnrich(adapter, { incrementalCluster: true
 * })`, exactly what the periodic tick calls.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { memoryWrite } from './write.js';
import { runBatchEnrich } from './enrich-batch.js';
import { clusterStats } from './cluster.js';

let priorAdapterEnv: string | undefined;
beforeEach(() => {
  priorAdapterEnv = process.env['STORE_ADAPTER'];
  process.env['STORE_ADAPTER'] = 'sqlite';
});
afterEach(() => {
  if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
  else process.env['STORE_ADAPTER'] = priorAdapterEnv;
});

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-inc-join-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Shared vocabulary so the deterministic feature-hash provider (vitest.setup.ts)
 *  gives these episodes high mutual cosine sim — same mechanism cluster.ts's
 *  own analysisCluster pass relies on in production. */
const GROUP_A_CONTENT = [
  'Alpha widget factory pipeline module orchestration handoff review notes one.',
  'Alpha widget factory pipeline module orchestration handoff review notes two.',
  'Alpha widget factory pipeline module orchestration handoff review notes three.',
];
const GROUP_A_NEW_EPISODE = 'Alpha widget factory pipeline module orchestration handoff review notes four.';
// Mutually dissimilar distractors — keep group A's largest-cluster ratio at
// 3/7 (<=0.5) so the D5.5 degenerate-cluster guard accepts the full pass at
// the base threshold on the first attempt, without a retry bump pushing past
// group A's own ~0.9 mutual cosine (measured against the feature-hash
// provider; a 3-vs-1 corpus would trigger a threshold+0.05 retry and lose
// the cluster entirely — verified against dbg1-4 probes during development).
const DISTRACTOR_CONTENT = [
  'Zephyr quokka bagpipe lighthouse tundra marmalade unrelated topic entirely apples.',
  'Xylophone crimson velvet asteroid marmot glacier ukulele unrelated content bananas.',
  'Trombone violet asteroid canyon marimba penguin unrelated subject matter cherries.',
  'Yonder crimson bramble otter waffle iguana completely different subject dates.',
];

async function writeAll(adapter: StoreAdapter, contents: string[]): Promise<void> {
  for (const content of contents) {
    const r = await memoryWrite(adapter, { content, project_path: '/test/inc-join' });
    if ('code' in r) throw new Error(`memoryWrite failed: ${JSON.stringify(r)}`);
  }
}

describe('BL-326/BL-349 — incremental join makes the incremental path reachable', () => {
  it('an ordinary write, clustered only via runBatchEnrich({incrementalCluster:true}), lands a live MEMBER_OF assignment (total_clustered 0 -> nonzero)', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await openDb(path.join(dir, 't.db'));

      // Setup: seed group A + a distractor group B, then run ONE full pass —
      // this mirrors the live store's existing 139 communities from a
      // historical full pass. This full pass is SETUP, not the thing under
      // test: the acceptance bar is what happens to the NEXT ordinary write.
      await writeAll(adapter, GROUP_A_CONTENT);
      await writeAll(adapter, DISTRACTOR_CONTENT);
      const fullPassResult = await runBatchEnrich(adapter, { incrementalCluster: false });
      expect(fullPassResult.communities_upserted).toBeGreaterThanOrEqual(1);

      const statsAfterFullPass = await clusterStats(adapter);
      const clusteredBeforeNewWrite = statsAfterFullPass.total_clustered;
      expect(clusteredBeforeNewWrite).toBeGreaterThanOrEqual(3); // group A's 3 members

      // The write under test: an ordinary memoryWrite, near-duplicate to
      // group A. No full pass is invoked for it.
      const writeResult = await memoryWrite(adapter, {
        content: GROUP_A_NEW_EPISODE,
        project_path: '/test/inc-join',
      });
      if ('code' in writeResult) throw new Error(`memoryWrite failed: ${JSON.stringify(writeResult)}`);
      const newUid = writeResult.episode_uid;

      // Before the incremental pass: the new episode has no MEMBER_OF edge —
      // this is what BL-326 left permanently true (the dead stub).
      const rowBefore = (await adapter.executeGet<{ rowid: number }>(
        'SELECT rowid FROM node WHERE uid = ?',
        [newUid],
      ))!;
      const memberBefore = await adapter.executeGet<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM edge WHERE src = ? AND rel = 'MEMBER_OF' AND t_invalid IS NULL`,
        [rowBefore.rowid],
      );
      expect(memberBefore?.cnt ?? 0).toBe(0);

      // THE FIX UNDER TEST: exactly what the periodic enrich tick runs
      // (runEnrichPassOnDb -> runEnrichIsolated -> runBatchEnrich with
      // incrementalCluster: !fullPass, i.e. true in steady state). NOT a
      // manually invoked full pass.
      const incResult = await runBatchEnrich(adapter, { incrementalCluster: true });

      // BL-349: independent traceability — the incremental join count is
      // reported distinctly from the full-pass community/edge counts.
      expect(incResult.incremental_joined).toBeGreaterThanOrEqual(1);
      expect(incResult.communities_upserted).toBe(0); // incremental mode creates no NEW communities
      expect(incResult.cluster_pass_skipped).toBe(false);

      const memberAfter = await adapter.executeGet<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM edge WHERE src = ? AND rel = 'MEMBER_OF' AND t_invalid IS NULL`,
        [rowBefore.rowid],
      );
      expect(memberAfter?.cnt ?? 0).toBeGreaterThanOrEqual(1);

      // BL-349's headline acceptance bar: total_clustered went from NOT
      // counting the new write to counting it — through the ordinary write
      // path, not a manually invoked full pass.
      const statsAfter = await clusterStats(adapter);
      expect(statsAfter.total_clustered).toBeGreaterThan(clusteredBeforeNewWrite);

      await adapter.close();
    } finally {
      cleanup();
    }
  });

  it('BL-326 regression guard: incrementalOnly with NO existing communities still defers safely (no crash, no false join)', async () => {
    // This is exactly enrich.spec.ts's pre-existing BL-45 case (kept green by
    // this fix): a fresh corpus with zero prior communities has nothing to
    // join against, so the incremental pass must cleanly report 0 joins
    // rather than throwing or fabricating an assignment.
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await openDb(path.join(dir, 't.db'));
      await writeAll(adapter, GROUP_A_CONTENT);

      const incResult = await runBatchEnrich(adapter, { incrementalCluster: true });
      expect(incResult.incremental_joined).toBe(0);
      expect(incResult.communities_upserted).toBe(0);
      expect(incResult.cluster_pass_skipped).toBe(true);

      const stats = await clusterStats(adapter);
      expect(stats.total_clustered).toBe(0);

      await adapter.close();
    } finally {
      cleanup();
    }
  });

  // BL-326/BL-349, coordinator-mandated companion assertion: "clustering works
  // now" and "clustering built one giant blob" must NOT pass the same test.
  // This proves the incremental join's degenerate-ratio guard (cluster.ts
  // incrementalJoin, mirroring D5.5's 0.5 largest-cluster/total bound) actually
  // caps a single community's growth within one incremental pass, rather than
  // admitting every matching candidate unconditionally.
  it('degenerate-ratio guard caps a single community at <=50% of total live episodes within one incremental pass', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await openDb(path.join(dir, 't.db'));

      // A tiny 2-member seed community, plus distractors so the SETUP full
      // pass itself stays comfortably non-degenerate (2/6 = 0.333 <= 0.5).
      // Same "Alpha widget factory..." vocabulary + trailing number-word as
      // GROUP_A_CONTENT/GROUP_A_NEW_EPISODE above — proven (by the first two
      // tests in this file) to hash to mutually-high cosine sim under the
      // deterministic feature-hash provider (vitest.setup.ts). A differently-
      // worded suffix (e.g. "seed-one"/"flood-3") does NOT reliably clear
      // threshold under that provider — verified empirically.
      const SEED_CONTENT = [
        'Alpha widget factory pipeline module orchestration handoff review notes one.',
        'Alpha widget factory pipeline module orchestration handoff review notes two.',
      ];
      await writeAll(adapter, SEED_CONTENT);
      await writeAll(adapter, DISTRACTOR_CONTENT);
      const fullPassResult = await runBatchEnrich(adapter, { incrementalCluster: false });
      expect(fullPassResult.communities_upserted).toBeGreaterThanOrEqual(1);

      const statsBefore = await clusterStats(adapter);
      const priorCommunitySize = statsBefore.total_clustered; // the seed pair (>=2)
      expect(priorCommunitySize).toBeGreaterThanOrEqual(2);

      // 10 ordinary writes, ALL near-duplicate to the seed community — enough
      // candidates that, absent a guard, every one of them would join and the
      // community would become a 12/14 = ~86% majority blob.
      const NUMBER_WORDS = ['three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
      const FLOOD_CONTENT = NUMBER_WORDS.map(
        (w) => `Alpha widget factory pipeline module orchestration handoff review notes ${w}.`,
      );
      await writeAll(adapter, FLOOD_CONTENT);

      const totalLiveRow = await adapter.executeGet<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL`,
      );
      const totalLiveEpisodes = totalLiveRow?.cnt ?? 0;

      const incResult = await runBatchEnrich(adapter, { incrementalCluster: true });

      // The guard must have let SOME candidates in (the join mechanism works)
      // but refused enough that the community never crosses 50% of the corpus.
      expect(incResult.incremental_joined).toBeGreaterThanOrEqual(1);
      expect(incResult.incremental_joined).toBeLessThan(FLOOD_CONTENT.length);

      const statsAfter = await clusterStats(adapter);
      // Headline assertion: no degenerate blob. The single largest community
      // never exceeds half the live corpus, exactly the D5.5 bound the full
      // pass itself enforces — proving "clustering works" did not silently
      // become "clustering built one giant blob."
      expect(statsAfter.largest_cluster_size / totalLiveEpisodes).toBeLessThanOrEqual(0.5);
      // And it is not a no-op either — real growth happened, capped, not zero.
      expect(statsAfter.largest_cluster_size).toBeGreaterThan(priorCommunitySize);
      // At least one flood candidate must have been REFUSED by the guard —
      // otherwise this test would not actually be exercising the cap at all.
      expect(statsAfter.total_unclustered).toBeGreaterThanOrEqual(1);

      await adapter.close();
    } finally {
      cleanup();
    }
  });
});
