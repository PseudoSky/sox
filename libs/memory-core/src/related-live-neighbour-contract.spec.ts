/**
 * related-live-neighbour-contract.spec.ts — the `memoryGetRelated` analogue of
 * the `memoryGetEntityEpisodes` count/pagination defect fixed in 568d31cd.
 *
 * Confirmed defect (`related.ts:107-108`, pre-fix): out-edges and in-edges were
 * each `.slice(0, limit)`-ed from the raw `getEdges()` result, and only THEN
 * were the neighbour nodes filtered with `t_invalid IS NULL` (:122). Edge-level
 * validity was applied (getEdges prepends it); node-level validity was applied
 * too late. An invalidated neighbour inside the limit window consumed a slot
 * and was then dropped, so callers silently got a SHORT list while live
 * neighbours that would have filled those slots sat just past the cut.
 *
 * DETECTOR DISCIPLINE. A fixture whose invalid neighbour lands OUTSIDE the
 * first `limit` edges passes with or without the fix and proves nothing (this
 * is exactly how the sibling packet's "Case D" shipped green against a deleted
 * ORDER BY). Case A therefore invalidates the FIRST-created neighbour, and
 * neighbours are created in the same order as their edges so that `e.rowid`
 * order and `e.dst` order AGREE — the invalid row is first under either
 * ordering the planner might pick (`ix_edge_unique ON edge(src,dst,rel)` makes
 * a `src = ?` scan plausibly dst-ordered), making RED deterministic rather than
 * accidental. Verified by reverting related.ts and re-running: Case A, B, C, E
 * and G fail; they pass with the fix restored.
 *
 * BACKEND COVERAGE. `openDb` picks its backend from `STORE_ADAPTER`
 * (libs/data/store/store-adapter/src/factory.ts, default `turso`). Verified
 * green under BOTH the default turso backend and `STORE_ADAPTER=sqlite`.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { memoryGetRelated } from './related.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'related-live-neighbour-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

let seq = 0;

async function seedEpisode(db: StoreAdapter, label: string): Promise<string> {
  const uid = `ep-${label}-${seq++}-${Math.random().toString(36).slice(2)}`;
  const now = new Date().toISOString();
  await db.executeRun(
    `INSERT INTO node (uid, kind, content, topic, project_path, tags, importance, t_created, t_valid)
     VALUES (?, 'episode', ?, 'test-topic', '/test/project', '[]', 5, ?, ?)`,
    [uid, `Episode ${label} content.`, now, now],
  );
  return uid;
}

async function rowidForUid(db: StoreAdapter, uid: string): Promise<number> {
  return (await db.executeGet<{ rowid: number }>(`SELECT rowid FROM node WHERE uid = ?`, [uid]))!
    .rowid;
}

async function seedEdge(
  db: StoreAdapter,
  srcRowid: number,
  dstRowid: number,
  rel = 'RELATES_TO',
): Promise<void> {
  await db.executeRun(
    `INSERT INTO edge (src, dst, rel, origin, weight, t_created) VALUES (?, ?, ?, 'user_asserted', 1.0, ?)`,
    [srcRowid, dstRowid, rel, new Date().toISOString()],
  );
}

async function invalidateNode(db: StoreAdapter, uid: string): Promise<void> {
  await db.executeRun(`UPDATE node SET t_invalid = ? WHERE uid = ?`, [
    new Date().toISOString(),
    uid,
  ]);
}

async function invalidateEdge(db: StoreAdapter, srcRowid: number, dstRowid: number): Promise<void> {
  await db.executeRun(`UPDATE edge SET t_invalid = ? WHERE src = ? AND dst = ?`, [
    new Date().toISOString(),
    srcRowid,
    dstRowid,
  ]);
}

async function withDb<T>(fn: (db: StoreAdapter) => Promise<T>): Promise<T> {
  const { dir, cleanup } = tmpDir();
  try {
    const db = await openDb(path.join(dir, 't.db'));
    try {
      return await fn(db);
    } finally {
      await db.close();
    }
  } finally {
    cleanup();
  }
}

describe('memoryGetRelated — live-neighbour filtering precedes LIMIT', () => {
  it('Case A (PRIMARY DETECTOR): an invalidated neighbour inside the limit window does not shorten the page', async () => {
    await withDb(async (db) => {
      const src = await seedEpisode(db, 'src');
      const srcRow = await rowidForUid(db, src);

      // Five out-neighbours, created in order, with edges created in that same
      // order — so e.rowid order and e.dst order agree and n0 is unambiguously
      // first for any plan the engine picks.
      const neighbours: string[] = [];
      for (let i = 0; i < 5; i++) {
        const uid = await seedEpisode(db, `n${i}`);
        neighbours.push(uid);
        await seedEdge(db, srcRow, await rowidForUid(db, uid));
      }
      // The FIRST neighbour — squarely inside a limit=3 window.
      await invalidateNode(db, neighbours[0]!);

      const result = await memoryGetRelated(db, { uid: src, limit: 3 });

      // Pre-fix this returns 2: n0 consumed a slot and was then filtered out,
      // while n3 sat just past the cut.
      expect(result.edges).toHaveLength(3);
      expect(result.edges.map((e) => e.episode.uid)).toEqual([
        neighbours[1]!,
        neighbours[2]!,
        neighbours[3]!,
      ]);
      expect(result.edges.every((e) => e.direction === 'outbound')).toBe(true);
    });
  });

  it('Case B: the same defect on the INBOUND side', async () => {
    await withDb(async (db) => {
      const dstUid = await seedEpisode(db, 'dst');
      const dstRow = await rowidForUid(db, dstUid);

      const neighbours: string[] = [];
      for (let i = 0; i < 5; i++) {
        const uid = await seedEpisode(db, `in${i}`);
        neighbours.push(uid);
        await seedEdge(db, await rowidForUid(db, uid), dstRow);
      }
      await invalidateNode(db, neighbours[0]!);

      const result = await memoryGetRelated(db, { uid: dstUid, limit: 3 });

      expect(result.edges).toHaveLength(3);
      expect(result.edges.every((e) => e.direction === 'inbound')).toBe(true);
      expect(result.edges.map((e) => e.episode.uid)).toEqual([
        neighbours[1]!,
        neighbours[2]!,
        neighbours[3]!,
      ]);
    });
  });

  it('Case C: invalidated neighbours behind a `rel` filter still do not consume slots', async () => {
    await withDb(async (db) => {
      const src = await seedEpisode(db, 'relsrc');
      const srcRow = await rowidForUid(db, src);

      const wanted: string[] = [];
      for (let i = 0; i < 4; i++) {
        const uid = await seedEpisode(db, `sup${i}`);
        wanted.push(uid);
        await seedEdge(db, srcRow, await rowidForUid(db, uid), 'SUPPORTS');
        // Interleave a RELATES_TO neighbour that must never appear.
        const noise = await seedEpisode(db, `noise${i}`);
        await seedEdge(db, srcRow, await rowidForUid(db, noise), 'RELATES_TO');
      }
      await invalidateNode(db, wanted[0]!);

      const result = await memoryGetRelated(db, { uid: src, rel: ['SUPPORTS'], limit: 3 });

      expect(result.edges).toHaveLength(3);
      expect(result.edges.every((e) => e.rel === 'SUPPORTS')).toBe(true);
      expect(result.edges.map((e) => e.episode.uid)).toEqual([wanted[1]!, wanted[2]!, wanted[3]!]);
    });
  });

  it('Case D: an invalidated EDGE to a live neighbour is still excluded (no regression in edge-level validity)', async () => {
    await withDb(async (db) => {
      const src = await seedEpisode(db, 'edgesrc');
      const srcRow = await rowidForUid(db, src);
      const dead = await seedEpisode(db, 'deadedge');
      const live = await seedEpisode(db, 'liveedge');
      await seedEdge(db, srcRow, await rowidForUid(db, dead));
      await seedEdge(db, srcRow, await rowidForUid(db, live));
      await invalidateEdge(db, srcRow, await rowidForUid(db, dead));

      const result = await memoryGetRelated(db, { uid: src });

      expect(result.edges.map((e) => e.episode.uid)).toEqual([live]);
      // An invalidated EDGE is not an invalidated NEIGHBOUR.
      expect(result.invalidated_count).toBe(0);
    });
  });

  it('Case E: outbound entries precede inbound entries, and both are live-filtered', async () => {
    await withDb(async (db) => {
      const hub = await seedEpisode(db, 'hub');
      const hubRow = await rowidForUid(db, hub);

      const outs: string[] = [];
      for (let i = 0; i < 3; i++) {
        const uid = await seedEpisode(db, `o${i}`);
        outs.push(uid);
        await seedEdge(db, hubRow, await rowidForUid(db, uid));
      }
      const ins: string[] = [];
      for (let i = 0; i < 3; i++) {
        const uid = await seedEpisode(db, `i${i}`);
        ins.push(uid);
        await seedEdge(db, await rowidForUid(db, uid), hubRow);
      }
      await invalidateNode(db, outs[0]!);
      await invalidateNode(db, ins[0]!);

      const result = await memoryGetRelated(db, { uid: hub, limit: 4 });

      expect(result.edges).toHaveLength(4);
      expect(result.edges.map((e) => e.direction)).toEqual([
        'outbound',
        'outbound',
        'inbound',
        'inbound',
      ]);
      expect(result.edges.map((e) => e.episode.uid)).toEqual([
        outs[1]!,
        outs[2]!,
        ins[1]!,
        ins[2]!,
      ]);
      expect(result.invalidated_count).toBe(2);
    });
  });

  it('Case F: a reciprocal A→B / B→A pair yields two entries, one per direction (UNION ALL, not UNION)', async () => {
    await withDb(async (db) => {
      const a = await seedEpisode(db, 'recipA');
      const b = await seedEpisode(db, 'recipB');
      const aRow = await rowidForUid(db, a);
      const bRow = await rowidForUid(db, b);
      await seedEdge(db, aRow, bRow, 'RELATES_TO');
      await seedEdge(db, bRow, aRow, 'SUPPORTS');

      const result = await memoryGetRelated(db, { uid: a });

      expect(result.edges).toHaveLength(2);
      expect(result.edges.map((e) => [e.direction, e.rel])).toEqual([
        ['outbound', 'RELATES_TO'],
        ['inbound', 'SUPPORTS'],
      ]);
    });
  });

  it('Case G: invalidated_count counts the whole neighbourhood, unbounded by limit', async () => {
    await withDb(async (db) => {
      const src = await seedEpisode(db, 'countsrc');
      const srcRow = await rowidForUid(db, src);
      for (let i = 0; i < 6; i++) {
        const uid = await seedEpisode(db, `d${i}`);
        await seedEdge(db, srcRow, await rowidForUid(db, uid));
        await invalidateNode(db, uid);
      }
      const liveUid = await seedEpisode(db, 'aliveone');
      await seedEdge(db, srcRow, await rowidForUid(db, liveUid));

      const result = await memoryGetRelated(db, { uid: src, limit: 1 });

      expect(result.edges.map((e) => e.episode.uid)).toEqual([liveUid]);
      // 6, not clamped to the limit of 1 — this is a neighbourhood diagnostic.
      expect(result.invalidated_count).toBe(6);
    });
  });

  it('Case H: a negative limit returns zero rows — it must never reach SQL as "no limit"', async () => {
    await withDb(async (db) => {
      const src = await seedEpisode(db, 'neglimit');
      const srcRow = await rowidForUid(db, src);
      for (let i = 0; i < 3; i++) {
        await seedEdge(db, srcRow, await rowidForUid(db, await seedEpisode(db, `neg${i}`)));
      }

      const result = await memoryGetRelated(db, { uid: src, limit: -1 });

      // SQLite reads a literal `LIMIT -1` as unbounded; clamping to 0 is the
      // only reading that cannot return MORE than the caller asked for.
      expect(result.edges).toHaveLength(0);
      expect(result.invalidated_count).toBe(0);
    });
  });

  it('Case I: a non-integer limit truncates instead of throwing a SQLite datatype mismatch', async () => {
    await withDb(async (db) => {
      const src = await seedEpisode(db, 'fraclimit');
      const srcRow = await rowidForUid(db, src);
      for (let i = 0; i < 4; i++) {
        await seedEdge(db, srcRow, await rowidForUid(db, await seedEpisode(db, `frac${i}`)));
      }

      const result = await memoryGetRelated(db, { uid: src, limit: 2.7 });

      expect(result.edges).toHaveLength(2);
    });
  });

  it('Case J: an unknown uid returns E_NOT_FOUND with a zeroed invalidated_count', async () => {
    await withDb(async (db) => {
      const result = await memoryGetRelated(db, { uid: 'no-such-uid' });
      expect(result.code).toBe('E_NOT_FOUND');
      expect(result.edges).toEqual([]);
      expect(result.invalidated_count).toBe(0);
    });
  });
});
