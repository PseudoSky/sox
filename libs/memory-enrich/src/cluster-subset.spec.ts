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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';

import { clusterStore, clusterSubset } from './index.js';

const MINIMAL_DDL = `
CREATE TABLE IF NOT EXISTS node (
  rowid INTEGER PRIMARY KEY,
  uid TEXT UNIQUE NOT NULL,
  kind TEXT NOT NULL,
  content TEXT, name TEXT, summary TEXT,
  meta TEXT, agent_id TEXT, session_id TEXT, source TEXT,
  importance REAL DEFAULT 1.0, content_hash TEXT, level INTEGER,
  resume_state TEXT, t_created TEXT NOT NULL, t_occurred TEXT,
  t_valid TEXT, t_invalid TEXT, last_access TEXT,
  access_count INTEGER DEFAULT 0,
  tags TEXT, topic TEXT, project_path TEXT, enrich_ver TEXT
);
CREATE TABLE IF NOT EXISTS edge (
  rowid INTEGER PRIMARY KEY,
  src INTEGER NOT NULL REFERENCES node(rowid),
  dst INTEGER NOT NULL REFERENCES node(rowid),
  rel TEXT NOT NULL,
  weight REAL DEFAULT 1.0, origin TEXT,
  t_created TEXT NOT NULL, t_expired TEXT, t_invalid TEXT, meta TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS vec_node USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[768]);
`;

let db: Database.Database;
let cleanup: () => void;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-subset-test-'));
  const dbPath = path.join(dir, 'test.db');
  db = new Database(dbPath);
  sqliteVec.load(db);
  db.exec(MINIMAL_DDL);
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

/** Mirrors buildFiltersClause's any-match tag predicate (alias `n`). */
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
  it('clusters only the episodes matching the restrict predicate', () => {
    seedTwoGroups();
    const res = clusterSubset(db, { restrict: tagRestrict('skill:A'), filter: { tags: ['skill:A'] } });
    expect(res.candidate_count).toBe(2);
    expect(res.clusters).toHaveLength(1);
    expect(res.clusters[0]!.member_rowids).toHaveLength(2);
  });

  it('read mode (persist:false, the default) writes nothing', () => {
    seedTwoGroups();
    const res = clusterSubset(db, { restrict: tagRestrict('skill:A'), filter: { tags: ['skill:A'] } });
    expect(res.persisted).toBe(false);
    expect(liveCommunities()).toHaveLength(0);
    expect(liveMemberOfCount()).toBe(0);
  });

  it('is deterministic on the same DB state (stable provenance hash + uids)', () => {
    seedTwoGroups();
    const a = clusterSubset(db, { restrict: tagRestrict('skill:A'), filter: { tags: ['skill:A'] } });
    const b = clusterSubset(db, { restrict: tagRestrict('skill:A'), filter: { tags: ['skill:A'] } });
    expect(a.provenance_hash).toBe(b.provenance_hash);
    expect(a.clusters[0]!.community_uid).toBe(b.clusters[0]!.community_uid);
  });
});

describe('clusterSubset — scoped persist coexists with the global partition', () => {
  it('persisting a subset does NOT invalidate global communities', () => {
    seedTwoGroups();
    // Global pass: two communities (A-group, B-group).
    const global = clusterStore(db);
    expect(global.clusters.length).toBe(2);
    const globalUids = new Set(liveCommunities().map((c) => c.uid));
    expect(globalUids.size).toBe(2);

    // Subset pass over skill:A, persisted.
    const sub = clusterSubset(db, {
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

  it('subset community UID is salted → never collides with a same-membership global community', () => {
    seedTwoGroups();
    const global = clusterStore(db);
    const sub = clusterSubset(db, {
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

  it('re-persisting the same filter is idempotent (replaces only its own slice)', () => {
    seedTwoGroups();
    clusterStore(db); // 2 global communities
    clusterSubset(db, { restrict: tagRestrict('skill:A'), filter: { tags: ['skill:A'] }, persist: true });
    const afterFirst = liveCommunities().length;
    clusterSubset(db, { restrict: tagRestrict('skill:A'), filter: { tags: ['skill:A'] }, persist: true });
    const afterSecond = liveCommunities().length;
    // Same count: the second run invalidated the first subset community and rewrote it.
    expect(afterSecond).toBe(afterFirst);
    // Exactly one live subset community for this filter hash.
    const subsetForHash = liveCommunities().filter(
      (c) => c.meta && JSON.parse(c.meta).cluster_scope?.kind === 'subset',
    );
    expect(subsetForHash).toHaveLength(1);
  });

  it('a later global re-cluster leaves subset communities intact', () => {
    seedTwoGroups();
    clusterStore(db);
    clusterSubset(db, { restrict: tagRestrict('skill:A'), filter: { tags: ['skill:A'] }, persist: true });
    // Re-run the global pass; subset community must survive.
    clusterStore(db);
    const subsetCommunities = liveCommunities().filter(
      (c) => c.meta && JSON.parse(c.meta).cluster_scope?.kind === 'subset',
    );
    expect(subsetCommunities).toHaveLength(1);
  });
});
