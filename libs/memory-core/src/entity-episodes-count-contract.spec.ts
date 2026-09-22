/**
 * entity-episodes-count-contract.spec.ts — Q4 of the near-dup invalidation
 * fix plan (docs/plan-drafts/neardup-invalidation-fix-plan.md §5).
 *
 * Confirmed defect: `memoryGetEntityEpisodes` computed `total = edges.length`
 * from RAW MENTIONS edges with no validity predicate, then paginated by
 * slicing that same raw array BEFORE applying `t_invalid IS NULL` to the
 * episode nodes. Two live-store instances (documented in the plan) showed
 * `total` overcounting AND short pages: `total: 118, episodes.length: 99`
 * even with an explicit high limit, so pagination cannot explain the gap.
 *
 * Case B is the HALF-FIX DETECTOR named in the plan: a patch that only
 * filters `total` (leaving pagination slicing the raw array) still returns
 * short pages when an invalid edge falls inside the requested slice. This
 * test must go RED against that half-fix and GREEN only once the edge set
 * itself is filtered BEFORE slicing.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { memoryGetEntityEpisodes } from './entity-episodes.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entity-episodes-count-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function seedEpisode(
  db: StoreAdapter,
  importance: number,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const uid = `ep-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  const content = (overrides['content'] as string) ?? `Episode ${uid} content.`;
  await db.executeRun(
    `INSERT INTO node (uid, kind, content, topic, project_path, tags, importance, t_created, t_valid)
     VALUES (?, 'episode', ?, 'test-topic', '/test/project', '[]', ?, ?, ?)`,
    [uid, content, importance, now, now],
  );
  return uid;
}

async function seedEntity(db: StoreAdapter, name: string): Promise<string> {
  const uid = `entity-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  await db.executeRun(
    `INSERT INTO node (uid, kind, name, t_created, t_valid) VALUES (?, 'entity', ?, ?, ?)`,
    [uid, name, new Date().toISOString(), new Date().toISOString()],
  );
  return uid;
}

async function seedEdge(db: StoreAdapter, srcRowid: number, dstRowid: number): Promise<void> {
  await db.executeRun(
    `INSERT INTO edge (src, dst, rel, origin, t_created) VALUES (?, ?, 'MENTIONS', 'user_asserted', ?)`,
    [srcRowid, dstRowid, new Date().toISOString()],
  );
}

async function rowidForUid(db: StoreAdapter, uid: string): Promise<number> {
  return (await db.executeGet<{ rowid: number }>(`SELECT rowid FROM node WHERE uid = ?`, [uid]))!.rowid;
}

async function invalidateNode(db: StoreAdapter, uid: string): Promise<void> {
  await db.executeRun(`UPDATE node SET t_invalid = ? WHERE uid = ?`, [new Date().toISOString(), uid]);
}

/**
 * Seeds one entity with 5 MENTIONS edges from 5 episodes at descending
 * importance (5,4,3,2,1), then invalidates the two MIDDLE-importance
 * episodes (importance 4 and 2). This deliberately places invalid rows
 * INSIDE the offset window a naive page-1/page-2 split would hit, so a
 * half-fix (filtered total, unfiltered slice) produces a short first page.
 */
async function seedFixture(db: StoreAdapter): Promise<{
  entityUid: string;
  liveUids: string[]; // in importance DESC order
  invalidUids: string[];
}> {
  const entityUid = await seedEntity(db, 'q4-fixture-entity');
  const entityRowid = await rowidForUid(db, entityUid);

  const episodes: { uid: string; importance: number }[] = [];
  for (const importance of [5, 4, 3, 2, 1]) {
    const uid = await seedEpisode(db, importance);
    episodes.push({ uid, importance });
    await seedEdge(db, await rowidForUid(db, uid), entityRowid);
  }

  // Invalidate importance 4 and importance 2 — one in each of a naive
  // limit:2 page split (page1 = idx[0,1], page2 = idx[2,3], tail = idx[4]).
  const toInvalidate = episodes.filter((e) => e.importance === 4 || e.importance === 2);
  for (const e of toInvalidate) {
    await invalidateNode(db, e.uid);
  }

  const liveUids = episodes
    .filter((e) => e.importance !== 4 && e.importance !== 2)
    .sort((a, b) => b.importance - a.importance)
    .map((e) => e.uid);

  return { entityUid, liveUids, invalidUids: toInvalidate.map((e) => e.uid) };
}

describe('memoryGetEntityEpisodes count/pagination contract (Q4)', () => {
  it('Case A: total counts only live episodes, matching episodes.length on a default call', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await openDb(path.join(dir, 't.db'));
      const { entityUid } = await seedFixture(db);

      const result = await memoryGetEntityEpisodes(db, { entity_uid: entityUid });

      expect(result.total).toBe(3);
      expect(result.episodes?.length).toBe(3);
      await db.close();
    } finally {
      cleanup();
    }
  });

  it('Case B (HALF-FIX DETECTOR): pages of limit:2 cover all 3 live uids with no gaps or duplicates', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await openDb(path.join(dir, 't.db'));
      const { entityUid, liveUids } = await seedFixture(db);

      const page1 = await memoryGetEntityEpisodes(db, { entity_uid: entityUid, limit: 2, offset: 0 });
      const page2 = await memoryGetEntityEpisodes(db, { entity_uid: entityUid, limit: 2, offset: 2 });

      // A half-fix (total filtered, raw edge array still sliced) returns a
      // SHORT first page here: the raw edge order includes the invalidated
      // importance-4 episode inside offset [0,2), so after the node-level
      // `t_invalid IS NULL` filter is applied post-slice, page1 comes back
      // with fewer than 2 episodes. This assertion is what must go RED
      // against that half-fix and GREEN only against the pre-slice filter.
      expect(page1.episodes?.length).toBe(2);
      expect(page2.episodes?.length).toBe(1);

      const combined = [...(page1.episodes ?? []), ...(page2.episodes ?? [])].map((e) => e.uid);
      expect(combined).toEqual(liveUids); // no gaps, no duplicates, correct order
      expect(new Set(combined).size).toBe(3);

      await db.close();
    } finally {
      cleanup();
    }
  });

  it('Case C: invalidated_count reflects the number of live MENTIONS edges pointing at invalid episodes', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await openDb(path.join(dir, 't.db'));
      const { entityUid } = await seedFixture(db);

      const result = await memoryGetEntityEpisodes(db, { entity_uid: entityUid });

      expect(result.invalidated_count).toBe(2);
      await db.close();
    } finally {
      cleanup();
    }
  });

  it('Case D: ordering is importance DESC and stable across repeated calls', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await openDb(path.join(dir, 't.db'));
      const { entityUid, liveUids } = await seedFixture(db);

      const call1 = await memoryGetEntityEpisodes(db, { entity_uid: entityUid, limit: 200 });
      const call2 = await memoryGetEntityEpisodes(db, { entity_uid: entityUid, limit: 200 });

      const uids1 = call1.episodes?.map((e) => e.uid) ?? [];
      const uids2 = call2.episodes?.map((e) => e.uid) ?? [];

      expect(uids1).toEqual(liveUids);
      expect(uids2).toEqual(liveUids);

      const importances = call1.episodes?.map((e) => e.importance) ?? [];
      const sorted = [...importances].sort((a, b) => b - a);
      expect(importances).toEqual(sorted);

      await db.close();
    } finally {
      cleanup();
    }
  });
});
