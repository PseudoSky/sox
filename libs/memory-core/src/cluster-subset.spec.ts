/**
 * cluster-subset.spec.ts — filtered clustering for synthesis (clusterSubset) +
 * the shared scoped materializer (materializeClusters).
 *
 * Core guarantees under test:
 *  - A filtered cluster only sees episodes matching the restrict predicate.
 *  - Read mode (persist:false) writes nothing.
 *  - Persisting a subset does NOT clobber the global community partition (scoped
 *    invalidation), and global ↔ subset communities coexist.
 *  - Subset community UIDs are salted → never collide with a global community of
 *    identical membership.
 *  - Re-persisting the same filter is idempotent (replaces only its own slice).
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { clusterStats, clusterStore, clusterSubset, dropSubsetLens, listSubsetLenses, wrapRawDbAsAdapter } from './index.js';
import type { StoreAdapter } from '@adhd/sox-store-adapter';

/**
 * Minimal DDL matching the canonical graph-store schema columns that indexes
 * reference (namespace, t_expires, etc.), plus memory-specific tables.
 * Needed so createGraphBackend → applySchema → ix_node_namespace etc. do not
 * fail with "no such column" on pre-existing tables.
 */
const MINIMAL_DDL = `
CREATE TABLE IF NOT EXISTS node (
  rowid INTEGER PRIMARY KEY,
  uid TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  content TEXT, name TEXT, summary TEXT,
  meta TEXT, agent_id TEXT, session_id TEXT, source TEXT,
  importance REAL DEFAULT 1.0, content_hash TEXT, level INTEGER,
  resume_state TEXT, confidence REAL,
  namespace TEXT DEFAULT 'global',
  t_created TEXT NOT NULL, t_occurred TEXT, t_expires TEXT,
  t_valid TEXT, t_invalid TEXT, last_access TEXT,
  access_count INTEGER DEFAULT 0,
  tags TEXT, topic TEXT, project_path TEXT, enrich_ver TEXT,
  is_superseded INTEGER DEFAULT 0,
  t_updated TEXT
);
CREATE TABLE IF NOT EXISTS edge (
  rowid INTEGER PRIMARY KEY,
  src INTEGER NOT NULL REFERENCES node(rowid),
  dst INTEGER NOT NULL REFERENCES node(rowid),
  rel TEXT NOT NULL,
  weight REAL DEFAULT 1.0, origin TEXT, confidence REAL,
  t_created TEXT NOT NULL, t_expired TEXT, t_valid TEXT, t_invalid TEXT, meta TEXT
);
-- The canonical graph-store schema declares this (graph-store/src/index.ts:76),
-- and materializeClusters' MEMBER_OF upsert depends on it:
--   ON CONFLICT(src, dst, rel) DO UPDATE ...
-- Without it every persist path in this file dies with
--   "ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint".
-- A hand-built fixture schema has to carry the constraints the code relies on.
CREATE UNIQUE INDEX IF NOT EXISTS ix_edge_unique ON edge(src, dst, rel);
CREATE VIRTUAL TABLE IF NOT EXISTS vec_node USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[768]);
`;

let db: Database.Database;
/**
 * BL-325: the cluster API takes a StoreAdapter, not a raw better-sqlite3 handle.
 * This spec builds its own minimal schema on a raw handle (it is testing the
 * clustering algorithm, not openDb), so it wraps that handle through the
 * sanctioned seam rather than going via openDb.
 */
let adapter: StoreAdapter;
let cleanup: () => void;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-subset-test-'));
  const dbPath = path.join(dir, 'test.db');
  db = new Database(dbPath);
  sqliteVec.load(db);
  db.exec(MINIMAL_DDL);
  adapter = wrapRawDbAsAdapter(db);
  cleanup = () => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  };
});

afterEach(() => cleanup());

/**
 * Deterministic embedding with a strong signal confined to a group-specific
 * 100-dim block → intra-group cosine ≈ 1, inter-group cosine ≈ 0.
 */
function groupVec(group: number, jitter: number): Float32Array {
  const v = new Float32Array(768);
  const base = group * 100;
  for (let i = 0; i < 100; i++) v[base + i] = 1 + jitter * Math.sin(i + 1);
  let norm = 0;
  for (let i = 0; i < 768; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 768; i++) v[i] = v[i]! / norm;
  return v;
}

let uidCounter = 0;
function insertEpisode(content: string, embedding: Float32Array, tags: string[]): number {
  const now = new Date().toISOString();
  const uid = `ep-${String(uidCounter++).padStart(4, '0')}`;
  const row = db
    .prepare<unknown[], { rowid: number }>(
      `INSERT INTO node (uid, kind, content, t_created, t_valid, tags)
       VALUES (?, 'episode', ?, ?, ?, ?) RETURNING rowid`,
    )
    .get(uid, content, now, now, JSON.stringify(tags))!;
  db.prepare('INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)').run(
    row.rowid,
    '[' + Array.from(embedding).map((x) => x.toFixed(8)).join(',') + ']',
  );
  return row.rowid;
}

/** Low-level raw restrict clause (kept for backward-compat test coverage). */
function tagRestrict(tag: string): { sql: string; params: unknown[] } {
  return { sql: ` AND EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ?)`, params: [tag] };
}

/** Seed two disjoint 2-episode tag groups (skill:A and skill:B). */
function seedTwoGroups(): void {
  insertEpisode('lesson a-one about guard ordering and tool resolution', groupVec(0, 0.01), ['kind:lesson', 'skill:A']);
  insertEpisode('lesson a-two about guard ordering and tool resolution', groupVec(0, 0.02), ['kind:lesson', 'skill:A']);
  insertEpisode('lesson b-one about embedding model drift on reindex', groupVec(1, 0.01), ['kind:lesson', 'skill:B']);
  insertEpisode('lesson b-two about embedding model drift on reindex', groupVec(1, 0.02), ['kind:lesson', 'skill:B']);
}

function liveCommunities(): { uid: string; meta: string | null }[] {
  return db
    .prepare<[], { uid: string; meta: string | null }>(
      `SELECT uid, meta FROM node WHERE kind = 'community' AND t_invalid IS NULL`,
    )
    .all();
}

function liveMemberOfCount(): number {
  return (
    db.prepare<[], { c: number }>(
      `SELECT COUNT(*) AS c FROM edge WHERE rel = 'MEMBER_OF' AND t_invalid IS NULL`,
    ).get()!.c
  );
}

describe('clusterSubset — filtered selection', () => {
  it('clusters only the episodes matching the restrict predicate', async () => {
    seedTwoGroups();
    const res = await clusterSubset(adapter, { restrict: tagRestrict('skill:A'), filter: { tags: ['skill:A'] } });
    expect(res.candidate_count).toBe(2);
    expect(res.clusters).toHaveLength(1);
    expect(res.clusters[0]!.member_rowids).toHaveLength(2);
  });

  it('read mode (persist:false, the default) writes nothing', async () => {
    seedTwoGroups();
    const res = await clusterSubset(adapter, { restrict: tagRestrict('skill:A'), filter: { tags: ['skill:A'] } });
    expect(res.persisted).toBe(false);
    expect(liveCommunities()).toHaveLength(0);
    expect(liveMemberOfCount()).toBe(0);
  });

  it('is deterministic on the same DB state (stable provenance hash + uids)', async () => {
    seedTwoGroups();
    const a = await clusterSubset(adapter, { restrict: tagRestrict('skill:A'), filter: { tags: ['skill:A'] } });
    const b = await clusterSubset(adapter, { restrict: tagRestrict('skill:A'), filter: { tags: ['skill:A'] } });
    expect(a.provenance_hash).toBe(b.provenance_hash);
    expect(a.clusters[0]!.community_uid).toBe(b.clusters[0]!.community_uid);
  });
});

describe('clusterSubset — scoped persist coexists with the global partition', () => {
  it('persisting a subset does NOT invalidate global communities', async () => {
    seedTwoGroups();
    // Global pass: two communities (A-group, B-group).
    const global = await clusterStore(adapter);
    expect(global.clusters.length).toBe(2);
    const globalUids = new Set(liveCommunities().map((c) => c.uid));
    expect(globalUids.size).toBe(2);

    // Subset pass over skill:A, persisted.
    const sub = await clusterSubset(adapter, {
      restrict: tagRestrict('skill:A'),
      filter: { tags: ['skill:A'] },
      persist: true,
    });
    expect(sub.persisted).toBe(true);
    expect(sub.clusters).toHaveLength(1);

    const after = liveCommunities();
    // Both global communities still live + one subset community = 3.
    expect(after).toHaveLength(3);
    for (const u of globalUids) expect(after.some((c) => c.uid === u)).toBe(true);

    const subsetCommunities = after.filter(
      (c) => c.meta && JSON.parse(c.meta).cluster_scope?.kind === 'subset',
    );
    expect(subsetCommunities).toHaveLength(1);
    expect(JSON.parse(subsetCommunities[0]!.meta!).cluster_scope.hash).toBe(sub.provenance_hash);
  });

  it('subset community UID is salted → never collides with a same-membership global community', async () => {
    seedTwoGroups();
    const global = await clusterStore(adapter);
    const sub = await clusterSubset(adapter, {
      restrict: tagRestrict('skill:A'),
      filter: { tags: ['skill:A'] },
      persist: true,
    });
    // The A-group global community and the A-subset community share identical
    // membership but must have distinct UIDs.
    const globalAUid = global.clusters
      .map((c) => c.community_uid)
      .find((uid) => liveCommunities().some((lc) => lc.uid === uid));
    expect(sub.clusters[0]!.community_uid).not.toBe(globalAUid);
  });

  it('re-persisting the same filter is idempotent (replaces only its own slice)', async () => {
    seedTwoGroups();
    await clusterStore(adapter); // 2 global communities
    await clusterSubset(adapter, { restrict: tagRestrict('skill:A'), filter: { tags: ['skill:A'] }, persist: true });
    const afterFirst = liveCommunities().length;
    await clusterSubset(adapter, { restrict: tagRestrict('skill:A'), filter: { tags: ['skill:A'] }, persist: true });
    const afterSecond = liveCommunities().length;
    // Same count: the second run invalidated the first subset community and rewrote it.
    expect(afterSecond).toBe(afterFirst);
    // Exactly one live subset community for this filter hash.
    const subsetForHash = liveCommunities().filter(
      (c) => c.meta && JSON.parse(c.meta).cluster_scope?.kind === 'subset',
    );
    expect(subsetForHash).toHaveLength(1);
  });

  it('a later global re-cluster leaves subset communities intact', async () => {
    seedTwoGroups();
    await clusterStore(adapter);
    await clusterSubset(adapter, { restrict: tagRestrict('skill:A'), filter: { tags: ['skill:A'] }, persist: true });
    // Re-run the global pass; subset community must survive.
    await clusterStore(adapter);
    const subsetCommunities = liveCommunities().filter(
      (c) => c.meta && JSON.parse(c.meta).cluster_scope?.kind === 'subset',
    );
    expect(subsetCommunities).toHaveLength(1);
  });
});

// ── Fix ①: persisted subset lens does NOT leak into global read paths ───────────
// These tests prove the read-side isolation contract: clusterStats and
// communityUidForRowid must report the GLOBAL partition only after a subset
// lens is persisted.  A separate throwaway DB is built, a subset persisted,
// and then global-scoped stats are asserted unchanged.

describe('read-path scope isolation (fix ①)', () => {
  it('clusterStats cluster_count reflects only global communities after subset persist', async () => {
    seedTwoGroups();
    // One global pass → 2 global communities.
    await clusterStore(adapter);
    const beforeStats = await clusterStats(adapter);
    expect(beforeStats.cluster_count).toBe(2);

    // Persist a subset lens for skill:A → now 3 total communities in DB.
    await clusterSubset(adapter, { filter: { tags: ['skill:A'] }, persist: true });
    const allLive = liveCommunities();
    expect(allLive).toHaveLength(3); // 2 global + 1 subset

    // clusterStats must still report 2 — only the global partition.
    const afterStats = await clusterStats(adapter);
    expect(afterStats.cluster_count).toBe(2);
  });

  it('clusterStats coverage is scoped to global partition only', async () => {
    seedTwoGroups();
    await clusterStore(adapter);
    const beforeCoverage = (await clusterStats(adapter)).coverage;

    // Persist a subset over skill:A — the 2 skill:A episodes now have an
    // additional MEMBER_OF edge to the subset community.  Global coverage must
    // remain unchanged (skill:B episodes unclustered = same ratio as before).
    await clusterSubset(adapter, { filter: { tags: ['skill:A'] }, persist: true });
    const afterCoverage = (await clusterStats(adapter)).coverage;

    // Coverage is a fraction of episodes in GLOBAL communities — must not change.
    expect(afterCoverage).toBeCloseTo(beforeCoverage, 6);
  });

  it('clusterStats largest_cluster_size ignores subset communities', async () => {
    // Seed 3 groups: 3 eps in group-0 (largest global), 2 in group-1, 2 in group-2.
    insertEpisode('extra c-one for size test', groupVec(0, 0.03), ['skill:C']);
    insertEpisode('lesson c-two text', groupVec(0, 0.04), ['skill:C']);
    insertEpisode('lesson c-three text', groupVec(0, 0.05), ['skill:C']);
    insertEpisode('lesson d-one about something', groupVec(1, 0.01), ['skill:D']);
    insertEpisode('lesson d-two about something', groupVec(1, 0.02), ['skill:D']);

    await clusterStore(adapter);
    const globalLargest = (await clusterStats(adapter)).largest_cluster_size;

    // Persist a subset that merges C+D into one "community" — but that's a subset
    // community and must NOT inflate largest_cluster_size in global stats.
    await clusterSubset(adapter, { filter: { tags: ['skill:C', 'skill:D'] }, persist: true });
    const afterLargest = (await clusterStats(adapter)).largest_cluster_size;
    expect(afterLargest).toBe(globalLargest);
  });
});

// ── Fix ④: clusterSubset callable with only memory-core imported ────────
// Proves the headline library feature is self-contained: no server-private code.

describe('clusterSubset callable via structured filter alone (fix ④)', () => {
  it('accepts MemoryFilter without a raw restrict clause', async () => {
    seedTwoGroups();
    // Pass filter only — no restrict. Engine builds the SQL clause internally.
    const res = await clusterSubset(adapter, { filter: { tags: ['skill:A'] } });
    expect(res.candidate_count).toBe(2);
    expect(res.clusters).toHaveLength(1);
    expect(res.persisted).toBe(false);
  });

  it('filter + persist writes a scoped community without restrict', async () => {
    seedTwoGroups();
    await clusterStore(adapter); // 2 global
    const res = await clusterSubset(adapter, { filter: { tags: ['skill:A'] }, persist: true });
    expect(res.persisted).toBe(true);
    // Global partition still has 2; 1 subset added.
    expect(liveCommunities()).toHaveLength(3);
  });

  it('MemoryFilter tags_match_all selects the intersection', async () => {
    seedTwoGroups();
    // Episodes tagged with BOTH 'kind:lesson' AND 'skill:A' = 2.
    const res = await clusterSubset(adapter, {
      filter: { tags: ['kind:lesson', 'skill:A'], tags_match_all: true },
    });
    expect(res.candidate_count).toBe(2);
  });

  it('MemoryFilter with no matching episodes returns empty clusters', async () => {
    seedTwoGroups();
    const res = await clusterSubset(adapter, { filter: { tags: ['no-such-tag'] } });
    expect(res.candidate_count).toBe(0);
    expect(res.clusters).toHaveLength(0);
  });

  it('provenance hash is stable for the same MemoryFilter', async () => {
    seedTwoGroups();
    const a = await clusterSubset(adapter, { filter: { tags: ['skill:A'] } });
    const b = await clusterSubset(adapter, { filter: { tags: ['skill:A'] } });
    expect(a.provenance_hash).toBe(b.provenance_hash);
  });
});

// ── BL-26: drop_lens / list_lenses ───────────────────────────────────────────

describe('dropSubsetLens + listSubsetLenses (BL-26)', () => {
  it('dropSubsetLens removes the target lens while leaving global + other lenses intact', async () => {
    seedTwoGroups();

    // 1. Persist global partition (2 communities: A-group, B-group).
    const global = await clusterStore(adapter);
    expect(global.clusters).toHaveLength(2);
    const globalUids = new Set(
      liveCommunities()
        .filter((c) => !c.meta || !JSON.parse(c.meta).cluster_scope || JSON.parse(c.meta).cluster_scope.kind !== 'subset')
        .map((c) => c.uid),
    );
    expect(globalUids.size).toBe(2);

    // 2. Persist subset lens for skill:A.
    const subA = await clusterSubset(adapter, { filter: { tags: ['skill:A'] }, persist: true });
    expect(subA.persisted).toBe(true);
    const hashA = subA.provenance_hash;

    // 3. Persist a second subset lens for skill:B.
    const subB = await clusterSubset(adapter, { filter: { tags: ['skill:B'] }, persist: true });
    expect(subB.persisted).toBe(true);
    const hashB = subB.provenance_hash;
    expect(hashA).not.toBe(hashB); // distinct lenses

    // 4. DB now has 2 global + 2 subset = 4 live communities.
    const before = liveCommunities();
    expect(before).toHaveLength(4);

    // 5. list_lenses sees exactly 2 subset lenses.
    const lenses = await listSubsetLenses(adapter);
    expect(lenses).toHaveLength(2);
    expect(lenses.map((l) => l.provenance_hash).sort()).toEqual([hashA, hashB].sort());

    // 6. Drop lens A.
    const result = await dropSubsetLens(adapter, hashA);
    expect(result.communities_dropped).toBe(1);
    expect(result.edges_dropped).toBeGreaterThanOrEqual(2); // 2 skill:A episodes

    // 7. Lens A's community is gone; global + lens B still live.
    const after = liveCommunities();
    expect(after).toHaveLength(3); // 2 global + 1 (B-lens)

    // Global UIDs are untouched.
    for (const uid of globalUids) {
      expect(after.some((c) => c.uid === uid)).toBe(true);
    }

    // Lens B is still present.
    const subsetAfter = after.filter(
      (c) => c.meta && JSON.parse(c.meta).cluster_scope?.kind === 'subset',
    );
    expect(subsetAfter).toHaveLength(1);
    expect(JSON.parse(subsetAfter[0]!.meta!).cluster_scope.hash).toBe(hashB);

    // list_lenses now shows only B.
    const lensesAfter = await listSubsetLenses(adapter);
    expect(lensesAfter).toHaveLength(1);
    expect(lensesAfter[0]!.provenance_hash).toBe(hashB);
  });

  it('dropSubsetLens is a no-op on a non-existent hash (idempotent)', async () => {
    seedTwoGroups();
    await clusterStore(adapter);
    const result = await dropSubsetLens(adapter, 'deadbeef00000000');
    expect(result.communities_dropped).toBe(0);
    expect(result.edges_dropped).toBe(0);
    // Global communities untouched.
    expect(liveCommunities()).toHaveLength(2);
  });

  it('dropSubsetLens is idempotent when called twice with the same hash', async () => {
    seedTwoGroups();
    await clusterStore(adapter);
    const sub = await clusterSubset(adapter, { filter: { tags: ['skill:A'] }, persist: true });
    const hash = sub.provenance_hash;

    const first = await dropSubsetLens(adapter, hash);
    expect(first.communities_dropped).toBe(1);

    const second = await dropSubsetLens(adapter, hash);
    expect(second.communities_dropped).toBe(0); // already gone
  });

  it('listSubsetLenses returns empty when no subset lenses are persisted', async () => {
    seedTwoGroups();
    await clusterStore(adapter);
    const lenses = await listSubsetLenses(adapter);
    expect(lenses).toHaveLength(0);
  });

  it('listSubsetLenses returns one entry per distinct hash even with multiple communities per lens', async () => {
    // Seed 2 groups all tagged skill:X so the subset lens yields 2 communities.
    // Content must be >= CLUSTER_MIN_CONTENT_LENGTH to pass the clustering
    // pre-filter (D5.1; default floor 20).
    insertEpisode('lesson x-one about guard ordering and tool resolution chain', groupVec(2, 0.01), ['skill:X']);
    insertEpisode('lesson x-two about guard ordering and tool resolution chain', groupVec(2, 0.02), ['skill:X']);
    insertEpisode('lesson x-three about guard ordering and tool resolution', groupVec(2, 0.03), ['skill:X']);
    insertEpisode('lesson y-one about embedding model drift on reindex operation', groupVec(3, 0.01), ['skill:X']);
    insertEpisode('lesson y-two about embedding model drift on reindex operation', groupVec(3, 0.02), ['skill:X']);

    await clusterStore(adapter);
    // Persist a lens over skill:X — 5 episodes in 2 groups → 2 communities.
    const sub = await clusterSubset(adapter, { filter: { tags: ['skill:X'] }, persist: true });
    expect(sub.clusters.length).toBeGreaterThan(0);

    const lenses = await listSubsetLenses(adapter);
    // Exactly one lens entry regardless of how many communities it contains.
    expect(lenses).toHaveLength(1);
    expect(lenses[0]!.provenance_hash).toBe(sub.provenance_hash);
    expect(lenses[0]!.community_count).toBe(sub.clusters.length);
  });
});
