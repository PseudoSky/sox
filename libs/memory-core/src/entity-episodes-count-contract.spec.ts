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
 *
 * BACKEND COVERAGE. `openDb` selects its backend from `STORE_ADAPTER` via
 * `libs/data/store/store-adapter/src/factory.ts` (default: `turso`, :26).
 * nx's default `nx test memory-core` runs this file against turso only.
 * Run with `STORE_ADAPTER=sqlite npx nx test memory-core -- entity-
 * episodes-count-contract.spec.ts` to exercise the sqlite backend — VERIFIED
 * 2026-09-22: all 9 cases (A-I) also pass under `STORE_ADAPTER=sqlite`. This
 * file no longer makes any transaction-semantics claim — `memoryGetEntity
 * Episodes` reads sequentially, not inside a transaction (see the top-of-
 * file docblock in entity-episodes.ts for the narrow straddling race that
 * leaves open and why), so there is no cross-backend transaction-contention
 * behavior left for this file to under- or over-claim.
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

  // ── limit/offset coercion (blind-review finding, BL: Q4 follow-up) ────────
  //
  // Moving limit/offset from Array.slice into a bound `LIMIT ? OFFSET ?`
  // dropped slice()'s implicit coercion/clamping. The MCP schema declares
  // both as plain `number` (no multipleOf/minimum), so these are all
  // schema-valid inputs a client can send.

  it('Case E: limit:2.5 (non-integer) truncates instead of throwing a SQLite datatype-mismatch error', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await openDb(path.join(dir, 't.db'));
      const { entityUid, liveUids } = await seedFixture(db);

      // Pre-fix: adapter.executeAll(...[entityRow.rowid, 2.5, offset]) throws
      // "step failed: Runtime error: datatype mismatch" — the call rejects
      // instead of returning a result at all.
      const result = await memoryGetEntityEpisodes(db, { entity_uid: entityUid, limit: 2.5 });

      expect(result.code).toBeUndefined();
      expect(result.episodes?.length).toBe(2);
      expect(result.episodes?.map((e) => e.uid)).toEqual(liveUids.slice(0, 2));

      await db.close();
    } finally {
      cleanup();
    }
  });

  it('Case F: limit:-1 (negative) is clamped, not passed through as SQLite "no limit"', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await openDb(path.join(dir, 't.db'));
      const { entityUid } = await seedFixture(db);

      // Pre-fix: Math.min(-1, 200) === -1 reaches SQL as `LIMIT -1`, which
      // SQLite treats as "no limit" — all 3 live episodes come back despite
      // limit:-1, silently defeating the caller's bound (and, at scale,
      // amplifying the per-row enrichment N+1 into hundreds of round trips).
      const result = await memoryGetEntityEpisodes(db, { entity_uid: entityUid, limit: -1 });

      expect(result.total).toBe(3); // total is unaffected by limit
      expect(result.episodes?.length).toBeLessThan(3);

      await db.close();
    } finally {
      cleanup();
    }
  });

  it('Case G (CHARACTERIZATION, NOT A RED-DETECTOR): offset:-3 is clamped to 0, matching the engine\'s own negative-OFFSET behavior', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await openDb(path.join(dir, 't.db'));
      const { entityUid, liveUids } = await seedFixture(db);

      // This test previously stated it was DELETED after a review pass
      // reasoned "no failing branch => no verified outcome under BL-225, so
      // delete it." A later review pushed back, correctly: BL-225 governs
      // marking backlog items RESOLVED without red->green evidence — it
      // does not license deleting a green CHARACTERIZATION test. Without
      // this case, `Math.max(..., 0)` at entity-episodes.ts (the offset
      // floor) has zero coverage and `offset:-3` is untested. The fact
      // that SQLite/Turso already treats negative OFFSET as zero is an
      // argument FOR pinning the combined (engine + explicit clamp)
      // behavior, not against having a test — a future change to either
      // layer should have to break this assertion to change the observed
      // result. Restored, explicitly labelled so nobody mistakes it for
      // evidence of a defect the way Cases E/F/H/I are.
      const result = await memoryGetEntityEpisodes(db, { entity_uid: entityUid, offset: -3 });

      expect(result.code).toBeUndefined();
      expect(result.episodes?.length).toBe(3);
      expect(result.episodes?.map((e) => e.uid)).toEqual(liveUids);

      await db.close();
    } finally {
      cleanup();
    }
  });

  it('Case H (GENUINE RED-DETECTOR, THIS BRANCH ONLY): limit:0 returns an empty page, not a full default page', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await openDb(path.join(dir, 't.db'));
      const { entityUid } = await seedFixture(db);

      // Scoped claim: limit:0 was correct at base 2eb54f3f (`(limit as
      // number|undefined) ?? 20` — nullish coalescing does not treat 0 as
      // absent). The `|| 20` regression was introduced by c5ca545e (this
      // branch, coercion-v1) and fixed by ca2d8e94 (this branch,
      // coercion-v2): `Math.trunc(0)` is `0`, and `0 || 20` evaluates the
      // right-hand side because 0 is falsy — an explicit limit:0 silently
      // fell through to the default of 20, returning every live episode
      // instead of zero, while limit:-1 (Case F) took the opposite branch
      // of the same `||` and clamped to zero rows. This test is a forward
      // guard against that regression recurring, not evidence of a defect
      // that predates c5ca545e.
      const result = await memoryGetEntityEpisodes(db, { entity_uid: entityUid, limit: 0 });

      expect(result.total).toBe(3); // total must still report the true live count
      expect(result.episodes).toEqual([]);

      await db.close();
    } finally {
      cleanup();
    }
  });

  it('Case I (GENUINE RED-DETECTOR): offset:1e20 is bounded instead of reaching SQL as an out-of-int64-range bind', async () => {
    const { dir, cleanup } = tmpDir();
    try {
      const db = await openDb(path.join(dir, 't.db'));
      const { entityUid } = await seedFixture(db);

      // Pre-fix (offset had a floor via Math.max(...,0) but no ceiling):
      // Number.isFinite(1e20) is true and Math.trunc(1e20) === 1e20, so the
      // value reached `OFFSET ?` unmodified and the Turso/SQLite driver
      // threw "step failed: Runtime error: datatype mismatch" — the call
      // rejected instead of returning a result, the same uncaught-rethrow
      // failure mode as Case E's limit:2.5 (handleToolCall only catches
      // StoreOperationTimeoutError, index.ts:989-1010).
      const result = await memoryGetEntityEpisodes(db, { entity_uid: entityUid, offset: 1e20 });

      expect(result.code).toBeUndefined();
      expect(result.total).toBe(3); // total is unaffected by offset
      expect(result.episodes).toEqual([]); // offset is clamped but still far past 3 live rows

      await db.close();
    } finally {
      cleanup();
    }
  });

  // Case J ("TRANSACTION SNAPSHOT") and Case K ("SAME-ADAPTER") are
  // deliberately NOT present. Both pinned behavior of the `adapter.
  // transaction()` wrap that was removed from `memoryGetEntityEpisodes`
  // after architecture review rejected it (the wrap could not deliver a
  // real consistency guarantee under ANY topology — per-episode enrichment
  // already runs outside it, once per row, so the result was a
  // multi-snapshot composite by construction even with the count/page
  // reads wrapped — while costing a demonstrated regression on the SQLite
  // backend: a concurrent write shaped like `memory_invalidate`, fired
  // while the wrapping read transaction was open, hard-threw instead of
  // succeeding). Case J in particular invalidated via a SEPARATE
  // connection to the same file — genuine cross-connection isolation, but
  // not the topology production runs (one cached adapter shared
  // in-process by every caller), so it was green for a real reason that
  // was not the reason production needed: the exact BL-167 shape this
  // file already removed Case G for once. With the wrap gone, there is
  // nothing left for either case to pin — the function's current sequential-
  // reads shape and the narrow straddling race it accepts are documented
  // in the top-of-file docblock of entity-episodes.ts instead of in a test
  // named for a guarantee that no longer exists.
});
