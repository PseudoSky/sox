/**
 * bl497-min-content-length.spec.ts — BL-497.
 *
 * The defect: `CLUSTER_MIN_CONTENT_LENGTH` was a hardcoded 50 with no
 * rationale on record, so every episode whose content fell in [20, 50) chars —
 * tag-like notes, command output, terse prose — was SILENTLY excluded from
 * clustering. `selectEpisodes` never returned them, so no pass ever considered
 * them and the metrics census (`cluster-metrics.ts`) reported them as
 * structurally ineligible: a permanent, by-design exclusion that the operator
 * could not even see, let alone tune.
 *
 * BL-497 makes the floor configurable (`SOX_CLUSTER_MIN_CONTENT_LENGTH`,
 * default 20, floor >= 1) and the regression below proves a ~47-char episode
 * sharing vocabulary with a seeded community now joins it on the ordinary
 * incremental pass (pre-fix: silently excluded at the 50-char floor).
 *
 * The env override test re-imports the module fresh with the floor raised to
 * 40, because the constant is read once at module config time and baked into
 * `CLUSTER_ELIGIBLE_SQL` — the same reason the D5.1 comment must not drift
 * from the code (one change point, lockstep).
 *
 * Review caveat 1: an ambient `SOX_CLUSTER_MIN_CONTENT_LENGTH` exported in the
 * shell/CI would corrupt that default-floor import the same way, so
 * `bl497-env.setup.ts` (imported FIRST below, before any module that
 * transitively loads cluster.js) captures and strips it before the clusterer's
 * config-time read; the afterAll at module scope restores the captured value so
 * no other spec file ever observes the strip.
 */
// FIRST import — must precede every module that (transitively) loads cluster.js,
// so the ambient floor is captured and stripped BEFORE cluster.ts's config-time
// read (BL-497 review caveat 1: exported SOX_CLUSTER_MIN_CONTENT_LENGTH would
// otherwise bake a non-20 floor into the static CLUSTER_ELIGIBLE_SQL import
// below and break the default-floor assertions).
import { AMBIENT_SOX_CLUSTER_MIN_CONTENT_LENGTH } from './bl497-env.setup.js';
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { memoryWrite } from './write.js';
import { runBatchEnrich } from './enrich-batch.js';
import { clusterStats, CLUSTER_ELIGIBLE_SQL as DEFAULT_FLOOR_ELIGIBLE_SQL } from './cluster.js';

let priorAdapterEnv: string | undefined;
let priorFloorEnv: string | undefined;
beforeEach(() => {
  priorAdapterEnv = process.env['STORE_ADAPTER'];
  process.env['STORE_ADAPTER'] = 'sqlite';
  priorFloorEnv = process.env['SOX_CLUSTER_MIN_CONTENT_LENGTH'];
  delete process.env['SOX_CLUSTER_MIN_CONTENT_LENGTH']; // default floor for the regression
});
afterEach(() => {
  if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
  else process.env['STORE_ADAPTER'] = priorAdapterEnv;
  if (priorFloorEnv === undefined) delete process.env['SOX_CLUSTER_MIN_CONTENT_LENGTH'];
  else process.env['SOX_CLUSTER_MIN_CONTENT_LENGTH'] = priorFloorEnv;
});
// Restore the ambient floor stripped by bl497-env.setup.ts at collection time,
// so a shell/CI-exported SOX_CLUSTER_MIN_CONTENT_LENGTH is visible again to any
// spec file that runs after this one in the same worker.
afterAll(() => {
  if (AMBIENT_SOX_CLUSTER_MIN_CONTENT_LENGTH === undefined)
    delete process.env['SOX_CLUSTER_MIN_CONTENT_LENGTH'];
  else process.env['SOX_CLUSTER_MIN_CONTENT_LENGTH'] = AMBIENT_SOX_CLUSTER_MIN_CONTENT_LENGTH;
});

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl497-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Seed vocabulary — deliberately SHORT tokens so a joiner of < 50 chars can
 * still share nearly all of them. Under the deterministic feature-hash provider
 * (vitest.setup.ts), shared tokens drive cosine up; a subset joiner at 47 chars
 * measures 0.8944 against these seeds (see the assertion-independent probes in
 * the BL-497 notes) — above the τ=0.87 incremental-join floor. The seeds
 * themselves are 55–57 chars, so the seed community forms under BOTH the old
 * 50-char floor and the new 20-char default: the red run fails because of the
 * JOINER's floor, not because the seed community never existed.
 */
const SEED_WORDS = 'zinc iron alpha velvet notes review canyon oak fir';
const SEEDS = [
  `${SEED_WORDS} one.`,
  `${SEED_WORDS} two.`,
  `${SEED_WORDS} three.`,
];
// 47 chars, token subset of the seeds (drops only `fir`/ordinal suffix).
const JOINER_47 = 'zinc iron alpha velvet notes review canyon oak.';

// Mutually dissimilar distractors — keep the seed community's largest-cluster
// ratio at 3/7 (<= 0.5) so the D5.5 degenerate-cluster guard accepts the full
// pass at the base threshold on the first attempt (same mechanism as
// cluster-incremental-join.spec.ts).
const DISTRACTOR_CONTENT = [
  'Zephyr quokka bagpipe lighthouse tundra marmalade unrelated topic entirely apples.',
  'Xylophone crimson velvet asteroid marmot glacier ukulele unrelated content bananas.',
  'Trombone violet asteroid canyon marimba penguin unrelated subject matter cherries.',
  'Yonder crimson bramble otter waffle iguana completely different subject dates.',
];

async function writeAll(adapter: StoreAdapter, contents: string[]): Promise<void> {
  for (const content of contents) {
    const r = await memoryWrite(adapter, { content, project_path: '/test/bl497' });
    if ('code' in r) throw new Error(`memoryWrite failed: ${JSON.stringify(r)}`);
  }
}

/** Seed a store that already has a live community (the live store's shape). */
async function seededStore(dir: string): Promise<StoreAdapter> {
  const adapter = await openDb(path.join(dir, 't.db'));
  await writeAll(adapter, SEEDS);
  await writeAll(adapter, DISTRACTOR_CONTENT);
  const full = await runBatchEnrich(adapter, { incrementalCluster: false });
  expect(full.communities_upserted).toBeGreaterThanOrEqual(1);
  return adapter;
}

async function liveMemberEdgeCount(adapter: StoreAdapter, uid: string): Promise<number> {
  const row = (await adapter.executeGet<{ rowid: number }>('SELECT rowid FROM node WHERE uid = ?', [uid]))!;
  const edge = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM edge WHERE src = ? AND rel = 'MEMBER_OF' AND t_invalid IS NULL`,
    [row.rowid],
  );
  return edge?.cnt ?? 0;
}

describe('BL-497 — the clustering content-length floor is configurable and defaults to 20', () => {
  it('BL-497: a 47-char episode (in [20, 50), sharing seed vocabulary) gains a live MEMBER_OF edge and total_clustered +1 on the incremental pass', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seededStore(dir);
      const statsBefore = await clusterStats(adapter);
      const clusteredBefore = statsBefore.total_clustered;
      expect(clusteredBefore).toBeGreaterThanOrEqual(3); // seed community's 3 members

      // The write under test: 47 chars, token-subset of the seed community.
      const writeResult = await memoryWrite(adapter, {
        content: JOINER_47,
        project_path: '/test/bl497',
      });
      if ('code' in writeResult) throw new Error(`memoryWrite failed: ${JSON.stringify(writeResult)}`);
      const uid = writeResult.episode_uid;

      // Before the incremental pass: no MEMBER_OF edge — the episode is only
      // awaiting, not assigned (same observable as the pre-fix silent exclusion,
      // which is exactly why the defect went unnoticed).
      expect(await liveMemberEdgeCount(adapter, uid)).toBe(0);

      // THE FIX UNDER TEST: the ordinary incremental pass — what the periodic
      // enrich tick runs in steady state. NOT a manually invoked full pass.
      const incResult = await runBatchEnrich(adapter, { incrementalCluster: true });

      // BL-497's headline acceptance bar: the 47-char episode JOINED.
      expect(incResult.incremental_joined).toBeGreaterThanOrEqual(1);
      expect(await liveMemberEdgeCount(adapter, uid)).toBeGreaterThanOrEqual(1);
      const statsAfter = await clusterStats(adapter);
      expect(statsAfter.total_clustered).toBe(clusteredBefore + 1);

      cleanup();
    } finally {
      /* disposable */
    }
  });

  it('BL-497: SOX_CLUSTER_MIN_CONTENT_LENGTH=40 raises the floor — a 30-char episode is excluded', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      // Read once at module config time → must re-import the module with the
      // env var set for the constant AND the baked SQL predicate to change.
      vi.resetModules();
      process.env['SOX_CLUSTER_MIN_CONTENT_LENGTH'] = '40';
      const fresh = await import('./cluster.js');
      const freshEnrich = await import('./enrich-batch.js');

      expect(fresh.CLUSTER_MIN_CONTENT_LENGTH).toBe(40);
      expect(fresh.CLUSTER_ELIGIBLE_SQL).toContain('LENGTH(n.content) >= 40');
      // The module this file imported at load time (default floor) still holds
      // the 20-char predicate — the two floors differ, which is the point.
      expect(DEFAULT_FLOOR_ELIGIBLE_SQL).toContain('LENGTH(n.content) >= 20');

      const adapter = await openDb(path.join(dir, 't.db'));
      await writeAll(adapter, SEEDS);
      await writeAll(adapter, DISTRACTOR_CONTENT);
      await freshEnrich.runBatchEnrich(adapter, { incrementalCluster: false });

      // 30 chars — a candidate under the 20 default, excluded under the raised 40.
      const writeResult = await memoryWrite(adapter, {
        content: 'zinc iron alpha velvet review.',
        project_path: '/test/bl497',
      });
      if ('code' in writeResult) throw new Error(`memoryWrite failed: ${JSON.stringify(writeResult)}`);
      const uid = writeResult.episode_uid;

      // The fresh module's own predicate, against a real store: the 30-char
      // episode is NOT a clustering candidate (selectEpisodes + every metrics
      // census site share exactly this string).
      const probe = await adapter.executeAll<{ uid: string }>(
        `SELECT n.uid FROM node n WHERE ${fresh.CLUSTER_ELIGIBLE_SQL}`,
      );
      const candidateUids = new Set(probe.rows.map((r) => r.uid));
      expect(candidateUids.has(uid)).toBe(false);

      // And the pipeline agrees — the incremental pass runs through the FRESH
      // module graph (fresh enrich-batch → fresh clusterStore → fresh
      // CLUSTER_ELIGIBLE_SQL), so it never even considers the episode.
      await freshEnrich.runBatchEnrich(adapter, { incrementalCluster: true });
      expect(await liveMemberEdgeCount(adapter, uid)).toBe(0);

      cleanup();
    } finally {
      /* disposable */
    }
  });
});
