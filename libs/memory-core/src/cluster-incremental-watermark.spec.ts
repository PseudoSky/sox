/**
 * cluster-incremental-watermark.spec.ts — backlog 2e10fbe4.
 *
 * Root cause (measured 2026-10-14): `incrementalJoin` re-evaluated EVERY
 * unassigned candidate against EVERY community member on every enrich tick.
 * Live store: 5,506 unclustered candidates; 543 of 549 incremental passes joined
 * zero; one pass on a WAL-complete copy took 45 s, 95% of it in the candidate
 * loop. That cost pushed the enrich child past its timeout on ticks with no
 * backlog at all.
 *
 * Fix under test: a persisted rejection watermark in `sox_store_meta`
 * (`cluster_incremental_watermark:<storeKey>:<salt>`). These tests observe the
 * watermark's own transitions, which are the externally visible contract:
 *  - it is written by an incremental pass;
 *  - `fullScanAt` moves ONLY on a full re-check (threshold change, membership
 *    change, un-invalidation of an old row, or the 6 h backstop);
 *  - an undecided candidate (missing vector) holds the watermark below it.
 *
 * Time is faked for `Date` only, so `fullScanAt` is deterministic.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { memoryWrite } from './write.js';
import { runBatchEnrich } from './enrich-batch.js';
import { clusterStore, INCREMENTAL_WATERMARK_BACKSTOP_MS } from './cluster.js';

const T0 = Date.parse('2026-10-14T12:00:00.000Z');
const MIN = 60_000;

let priorAdapterEnv: string | undefined;
beforeEach(() => {
  priorAdapterEnv = process.env['STORE_ADAPTER'];
  process.env['STORE_ADAPTER'] = 'sqlite';
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
  if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
  else process.env['STORE_ADAPTER'] = priorAdapterEnv;
});

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-inc-wm-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

const GROUP_A_CONTENT = [
  'Alpha widget factory pipeline module orchestration handoff review notes one.',
  'Alpha widget factory pipeline module orchestration handoff review notes two.',
  'Alpha widget factory pipeline module orchestration handoff review notes three.',
];
const DISTRACTOR_CONTENT = [
  'Zephyr quokka bagpipe lighthouse tundra marmalade unrelated topic entirely apples.',
  'Xylophone crimson velvet asteroid marmot glacier ukulele unrelated content bananas.',
  'Trombone violet asteroid canyon marimba penguin unrelated subject matter cherries.',
  'Yonder crimson bramble otter waffle iguana completely different subject dates.',
];
const NEW_NEAR_A = 'Alpha widget factory pipeline module orchestration handoff review notes four.';

async function writeOne(adapter: StoreAdapter, content: string): Promise<string> {
  const r = await memoryWrite(adapter, { content, project_path: '/test/inc-watermark' });
  if ('code' in r) throw new Error(`memoryWrite failed: ${JSON.stringify(r)}`);
  return r.episode_uid;
}

async function rowidOf(adapter: StoreAdapter, uid: string): Promise<number> {
  const row = await adapter.executeGet<{ rowid: number }>('SELECT rowid FROM node WHERE uid = ?', [uid]);
  if (!row) throw new Error(`no node for uid ${uid}`);
  return row.rowid;
}

async function memberCount(adapter: StoreAdapter, uid: string): Promise<number> {
  const row = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM edge e JOIN node n ON n.rowid = e.src
     WHERE n.uid = ? AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL`,
    [uid],
  );
  return row?.cnt ?? 0;
}

interface Watermark {
  threshold: number;
  membership: string;
  rowid: number;
  belowCount: number;
  fullScanAt: string;
}

async function readWatermark(adapter: StoreAdapter): Promise<Watermark | null> {
  const row = await adapter.executeGet<{ value: string }>(
    `SELECT value FROM sox_store_meta WHERE key LIKE 'cluster_incremental_watermark:%'`,
  );
  return row ? (JSON.parse(row.value) as Watermark) : null;
}

/** Seed group A + distractors, build the communities with one FULL pass, then
 *  return the adapter. Every later assertion starts from this state. */
async function seededStore(dir: string): Promise<StoreAdapter> {
  const adapter = await openDb(path.join(dir, 't.db'));
  for (const c of [...GROUP_A_CONTENT, ...DISTRACTOR_CONTENT]) await writeOne(adapter, c);
  const full = await runBatchEnrich(adapter, { incrementalCluster: false });
  expect(full.communities_upserted).toBeGreaterThanOrEqual(1);
  return adapter;
}

describe('backlog 2e10fbe4 — incremental join rejection watermark', () => {
  it('an incremental pass persists the watermark (absent before the fix)', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seededStore(dir);
      await clusterStore(adapter, { incrementalOnly: true });
      const wm = await readWatermark(adapter);
      expect(wm).not.toBeNull();
      expect(wm!.fullScanAt).toBe(new Date(T0).toISOString());
      await adapter.close();
    } finally {
      cleanup();
    }
  });

  it('an unchanged tick resumes: fullScanAt and rowid stay put, nothing is re-decided', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seededStore(dir);
      await clusterStore(adapter, { incrementalOnly: true });
      const first = (await readWatermark(adapter))!;

      vi.setSystemTime(T0 + 5 * MIN);
      await clusterStore(adapter, { incrementalOnly: true });
      const second = (await readWatermark(adapter))!;

      expect(second.fullScanAt).toBe(first.fullScanAt);
      expect(second.rowid).toBe(first.rowid);
      await adapter.close();
    } finally {
      cleanup();
    }
  });

  it('a new episode above the watermark is evaluated and joins; the join alone does not force a full re-check', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seededStore(dir);
      await clusterStore(adapter, { incrementalOnly: true });
      const fullAt = (await readWatermark(adapter))!.fullScanAt;

      vi.setSystemTime(T0 + MIN);
      const uid = await writeOne(adapter, NEW_NEAR_A);
      await clusterStore(adapter, { incrementalOnly: true });

      expect(await memberCount(adapter, uid)).toBe(1);
      const wm = (await readWatermark(adapter))!;
      expect(wm.rowid).toBeGreaterThanOrEqual(await rowidOf(adapter, uid));
      expect(wm.fullScanAt).toBe(fullAt);
      await adapter.close();
    } finally {
      cleanup();
    }
  });

  it('a membership change (the join above) forces a full re-check on the following tick', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seededStore(dir);
      await clusterStore(adapter, { incrementalOnly: true });
      vi.setSystemTime(T0 + MIN);
      await writeOne(adapter, NEW_NEAR_A);
      await clusterStore(adapter, { incrementalOnly: true }); // joins

      vi.setSystemTime(T0 + 2 * MIN);
      await clusterStore(adapter, { incrementalOnly: true }); // membership now differs
      expect((await readWatermark(adapter))!.fullScanAt).toBe(new Date(T0 + 2 * MIN).toISOString());
      await adapter.close();
    } finally {
      cleanup();
    }
  });

  it('a threshold change forces a full re-check', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seededStore(dir);
      await clusterStore(adapter, { incrementalOnly: true, threshold: 0.87 });
      vi.setSystemTime(T0 + MIN);
      await clusterStore(adapter, { incrementalOnly: true, threshold: 0.9 });
      expect((await readWatermark(adapter))!.fullScanAt).toBe(new Date(T0 + MIN).toISOString());
      await adapter.close();
    } finally {
      cleanup();
    }
  });

  it('un-invalidating an old unassigned row forces a full re-check (restore / un-invalidate path)', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seededStore(dir);
      await clusterStore(adapter, { incrementalOnly: true });
      const victimRowid = (await adapter.executeGet<{ rowid: number }>(
        `SELECT n.rowid AS rowid FROM node n
         WHERE n.kind = 'episode' AND n.t_invalid IS NULL
           AND NOT EXISTS (SELECT 1 FROM edge e WHERE e.src = n.rowid AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL)
         ORDER BY n.rowid ASC LIMIT 1`,
      ))!.rowid;
      const victimUid = (await adapter.executeGet<{ uid: string }>('SELECT uid FROM node WHERE rowid = ?', [victimRowid]))!.uid;

      // Invalidating shrinks the below-watermark count: no rescan required.
      vi.setSystemTime(T0 + MIN);
      await adapter.executeRun(`UPDATE node SET t_invalid = ? WHERE uid = ?`, [new Date().toISOString(), victimUid]);
      await clusterStore(adapter, { incrementalOnly: true });
      expect((await readWatermark(adapter))!.fullScanAt).toBe(new Date(T0).toISOString());

      // Reviving it grows the below-watermark count: the old row must be re-decided.
      vi.setSystemTime(T0 + 2 * MIN);
      await adapter.executeRun(`UPDATE node SET t_invalid = NULL WHERE uid = ?`, [victimUid]);
      await clusterStore(adapter, { incrementalOnly: true });
      expect((await readWatermark(adapter))!.fullScanAt).toBe(new Date(T0 + 2 * MIN).toISOString());
      await adapter.close();
    } finally {
      cleanup();
    }
  });

  it('an undecided candidate (no vector yet) holds the watermark below its rowid', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seededStore(dir);
      vi.setSystemTime(T0 + MIN);
      const uid = await writeOne(adapter, NEW_NEAR_A);
      const rowid = await rowidOf(adapter, uid);
      await adapter.executeRun('DELETE FROM vec_node WHERE node_id = ?', [rowid]);

      await clusterStore(adapter, { incrementalOnly: true });
      const wm = (await readWatermark(adapter))!;
      expect(wm.rowid).toBeLessThan(rowid);
      expect(await memberCount(adapter, uid)).toBe(0);
      await adapter.close();
    } finally {
      cleanup();
    }
  });

  it('the 6 h backstop forces a full re-check even when nothing else changed', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const adapter = await seededStore(dir);
      await clusterStore(adapter, { incrementalOnly: true });
      vi.setSystemTime(T0 + INCREMENTAL_WATERMARK_BACKSTOP_MS + 1);
      await clusterStore(adapter, { incrementalOnly: true });
      expect((await readWatermark(adapter))!.fullScanAt).toBe(
        new Date(T0 + INCREMENTAL_WATERMARK_BACKSTOP_MS + 1).toISOString(),
      );
      await adapter.close();
    } finally {
      cleanup();
    }
  });
});
