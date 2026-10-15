/**
 * cluster-incremental-membercount.spec.ts — 050ba52f (K1 of plan ee6640de).
 *
 * Failure mode: `incrementalJoin` inserts the MEMBER_OF edge but never touches
 * the community node's `meta`, so `meta.member_count` (which
 * `memory_get_community` reports verbatim) under-reports every community that
 * grew by incremental join — unbounded drift until a manual full pass.
 *
 * Tier: S (real sqlite store via openDb, deterministic feature-hash embeddings
 * from vitest.setup.ts; no process-spawn or network is involved, so nothing is
 * mocked). Gap statement: the memory-server handler that reads meta
 * (memory-server/src/index.ts) is out of this bucket's scope and is not
 * exercised; these specs assert the stored `meta.member_count` it reads.
 *
 * Owner ruling K0 (32a2a24e): the first-minted community uid stays stable and a
 * join must not mint, re-derive or supersede a uid; singletons stay suppressed.
 *
 * Light risk map:
 *  - join updates member_count ............ AC-050.1 tests 1, 2
 *  - repeated joins accumulate ............ AC-050.1 test 2
 *  - uid stays first-minted ............... AC-050.2 test 3
 *  - no store-wide drift .................. AC-050.3 test 4
 *  - join rate counter keeps firing ....... note 37d0a0df test 5
 *  - join never creates a community ....... K0 singleton ruling test 6
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { memoryWrite } from './write.js';
import { runBatchEnrich } from './enrich-batch.js';
import { getClusterMetrics, _resetClusterMetricsForTest } from './cluster-metrics.js';

let priorAdapterEnv: string | undefined;
beforeEach(() => {
  priorAdapterEnv = process.env['STORE_ADAPTER'];
  process.env['STORE_ADAPTER'] = 'sqlite';
  _resetClusterMetricsForTest();
});
afterEach(() => {
  if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
  else process.env['STORE_ADAPTER'] = priorAdapterEnv;
});

const STORE_KEY = '050ba52f-store';
const alpha = (w: string): string =>
  `Alpha widget factory pipeline module orchestration handoff review notes ${w}.`;
// Seed community of 3 + 4 mutually-dissimilar distractors keeps the seed at
// 3/7 <= 0.5 so the setup full pass and the degenerate-ratio guard accept it
// (same shape as cluster-incremental-join.spec.ts).
const SEED = ['one', 'two', 'three'].map(alpha);
const DISTRACTORS = [
  'Zephyr quokka bagpipe lighthouse tundra marmalade unrelated topic entirely apples.',
  'Xylophone crimson velvet asteroid marmot glacier ukulele unrelated content bananas.',
  'Trombone violet asteroid canyon marimba penguin unrelated subject matter cherries.',
  'Yonder crimson bramble otter waffle iguana completely different subject dates.',
];

const EXTRA_DISTRACTORS = [
  'Quartz lagoon sextant ferrous pomegranate unrelated gardening anecdote tulips.',
  'Nebula cobbler fresco thimble hemlock irrelevant maritime chatter walnuts.',
];

async function writeAll(adapter: StoreAdapter, contents: string[]): Promise<void> {
  for (const content of contents) {
    const r = await memoryWrite(adapter, { content, project_path: '/test/050ba52f' });
    if ('code' in r) throw new Error(`memoryWrite failed: ${JSON.stringify(r)}`);
  }
}

interface CommunityRow {
  rowid: number;
  uid: string;
  member_count: number | null;
  live: number;
}

async function communities(adapter: StoreAdapter): Promise<CommunityRow[]> {
  const rows = await adapter.executeAll<CommunityRow>(
    `SELECT n.rowid AS rowid, n.uid AS uid,
            json_extract(n.meta, '$.member_count') AS member_count,
            (SELECT COUNT(*) FROM edge e
              WHERE e.dst = n.rowid AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL) AS live
       FROM node n WHERE n.kind = 'community' AND n.t_invalid IS NULL
       ORDER BY n.rowid`,
  );
  return rows.rows;
}

async function setup(adapter: StoreAdapter): Promise<CommunityRow> {
  await writeAll(adapter, SEED);
  await writeAll(adapter, DISTRACTORS);
  const full = await runBatchEnrich(adapter, { incrementalCluster: false, storeKey: STORE_KEY });
  expect(full.communities_upserted).toBeGreaterThanOrEqual(1);
  const seedCommunity = (await communities(adapter)).find((c) => c.live === SEED.length);
  if (!seedCommunity) throw new Error('setup: seed community not materialized');
  expect(seedCommunity.member_count).toBe(SEED.length);
  return seedCommunity;
}

async function withStore(fn: (adapter: StoreAdapter) => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-050ba52f-'));
  try {
    const adapter = await openDb(path.join(dir, 't.db'));
    try {
      await fn(adapter);
    } finally {
      await adapter.close();
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('050ba52f — incremental join keeps meta.member_count equal to live MEMBER_OF count', () => {
  it('050ba52f AC-050.1: a join into an existing community updates member_count to the live count', async () => {
    await withStore(async (adapter) => {
      const seed = await setup(adapter);
      await writeAll(adapter, [alpha('four')]);
      const inc = await runBatchEnrich(adapter, { incrementalCluster: true, storeKey: STORE_KEY });
      expect(inc.incremental_joined).toBe(1);

      const after = (await communities(adapter)).find((c) => c.rowid === seed.rowid)!;
      expect(after.live).toBe(SEED.length + 1);
      // RED arm before the fix: stays at SEED.length (stale).
      expect(after.member_count).toBe(after.live);
    });
  });

  it('050ba52f AC-050.1: repeated joins across ticks keep member_count equal to the live count', async () => {
    await withStore(async (adapter) => {
      const seed = await setup(adapter);
      // Extra unrelated episodes keep the grown community under the
      // degenerate-ratio guard's 0.5 bound across both ticks (5 of 11 live).
      await writeAll(adapter, EXTRA_DISTRACTORS);
      await writeAll(adapter, [alpha('four')]);
      await runBatchEnrich(adapter, { incrementalCluster: true, storeKey: STORE_KEY });
      await writeAll(adapter, [alpha('five')]);
      const second = await runBatchEnrich(adapter, { incrementalCluster: true, storeKey: STORE_KEY });
      expect(second.incremental_joined).toBe(1);

      const after = (await communities(adapter)).find((c) => c.rowid === seed.rowid)!;
      expect(after.live).toBe(SEED.length + 2);
      expect(after.member_count).toBe(SEED.length + 2);
    });
  });

  it('050ba52f AC-050.2 (K0 32a2a24e): a join keeps the first-minted uid; it neither mints nor re-derives one', async () => {
    await withStore(async (adapter) => {
      const seed = await setup(adapter);
      const before = await communities(adapter);
      await writeAll(adapter, [alpha('four')]);
      await runBatchEnrich(adapter, { incrementalCluster: true, storeKey: STORE_KEY });
      await writeAll(adapter, [alpha('five')]);
      await runBatchEnrich(adapter, { incrementalCluster: true, storeKey: STORE_KEY });

      const after = await communities(adapter);
      // Same node, same uid, still live (not superseded): the held uid resolves.
      expect(after.map((c) => c.uid)).toEqual(before.map((c) => c.uid));
      const resolved = await adapter.executeGet<{ uid: string; t_invalid: string | null }>(
        `SELECT uid, t_invalid FROM node WHERE uid = ?`,
        [seed.uid],
      );
      expect(resolved?.uid).toBe(seed.uid);
      expect(resolved?.t_invalid).toBeNull();
    });
  });

  it('050ba52f AC-050.3: after joins no live community drifts (stored member_count == live MEMBER_OF count)', async () => {
    await withStore(async (adapter) => {
      await setup(adapter);
      await writeAll(adapter, [alpha('four'), alpha('five')]);
      await runBatchEnrich(adapter, { incrementalCluster: true, storeKey: STORE_KEY });

      const all = await communities(adapter);
      expect(all.length).toBeGreaterThanOrEqual(1);
      const drifted = all.filter((c) => c.member_count !== c.live);
      expect(drifted).toEqual([]);
    });
  });

  it('050ba52f note 37d0a0df: the joins_joined counter still advances once per join (join rate stays observable)', async () => {
    await withStore(async (adapter) => {
      await setup(adapter);
      const base = getClusterMetrics(STORE_KEY)?.counters.joins_joined ?? 0;
      await writeAll(adapter, [alpha('four'), alpha('five')]);
      const inc = await runBatchEnrich(adapter, { incrementalCluster: true, storeKey: STORE_KEY });
      expect(inc.incremental_joined).toBeGreaterThanOrEqual(1);
      expect(getClusterMetrics(STORE_KEY)?.counters.joins_joined).toBe(base + inc.incremental_joined);
    });
  });

  it('050ba52f K0 singleton ruling: a join pass never creates a community; an unmatched episode stays unclustered', async () => {
    await withStore(async (adapter) => {
      await setup(adapter);
      const before = await communities(adapter);
      await writeAll(adapter, [
        'Quasar nimbus harpsichord tessellate fjord obsidian wholly orthogonal subject kumquats.',
        alpha('four'),
      ]);
      const inc = await runBatchEnrich(adapter, { incrementalCluster: true, storeKey: STORE_KEY });
      expect(inc.communities_upserted).toBe(0);

      const after = await communities(adapter);
      expect(after.map((c) => c.uid)).toEqual(before.map((c) => c.uid));
      // The orphan episode has no MEMBER_OF edge: singletons stay suppressed.
      const orphan = await adapter.executeGet<{ cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM node n
          WHERE n.kind = 'episode' AND n.t_invalid IS NULL
            AND n.content LIKE 'Quasar nimbus%'
            AND EXISTS (SELECT 1 FROM edge e WHERE e.src = n.rowid AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL)`,
      );
      expect(orphan?.cnt ?? 0).toBe(0);
    });
  });
});
