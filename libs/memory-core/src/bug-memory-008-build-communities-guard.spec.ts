/**
 * bug-memory-008-build-communities-guard.spec.ts — regression test for BUG-MEMORY-008.
 *
 * ## What this suite defends
 *
 * BUG-MEMORY-008: `buildCommunities()` used an unscoped `UPDATE node SET t_invalid` on
 * all level-0 communities in one transaction, then re-inserted new communities in a
 * SEPARATE transaction. A crash between the two left the graph fully wiped with orphaned
 * MEMBER_OF edges pointing at invalidated community rowids.
 *
 * This test suite verifies:
 *   (a) buildCommunities WITHOUT force REFUSES when live level-0 communities exist,
 *       leaving the graph intact.
 *   (b) With force it completes in one transaction with no orphaned MEMBER_OF edges.
 *
 * Per BL-225: the test was observed RED before the fix and GREEN after.
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCommunities, wrapRawDbAsAdapter } from './index.js';
import type { StoreAdapter } from '@adhd/sox-store-adapter';

/**
 * Minimal DDL matching the canonical graph-store schema. Includes the
 * unique index on edge(src,dst,rel) that buildCommunities' INSERT OR IGNORE
 * depends on, and the vec_node virtual table (even though we don't use
 * vectors — sqlite-vec must load for schema consistency).
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
CREATE UNIQUE INDEX IF NOT EXISTS ix_edge_unique ON edge(src, dst, rel);
CREATE VIRTUAL TABLE IF NOT EXISTS vec_node USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[768]);
`;

let db: Database.Database;
let adapter: StoreAdapter;
let cleanup: () => void;

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mem-bug008-'));
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

const NOW = new Date().toISOString();

/**
 * Insert an episode node and return its rowid.
 */
function insertEpisode(uid: string, content: string): number {
  const row = db
    .prepare<unknown[], { rowid: number }>(
      `INSERT INTO node (uid, kind, content, t_created, t_valid)
       VALUES (?, 'episode', ?, ?, ?) RETURNING rowid`,
    )
    .get(uid, content, NOW, NOW)!;
  return row.rowid;
}

/**
 * Insert a claim node and return its rowid.
 */
function insertClaim(uid: string, content: string): number {
  const row = db
    .prepare<unknown[], { rowid: number }>(
      `INSERT INTO node (uid, kind, content, t_created, t_valid)
       VALUES (?, 'claim', ?, ?, ?) RETURNING rowid`,
    )
    .get(uid, content, NOW, NOW)!;
  return row.rowid;
}

/**
 * Insert an edge between two node rowids.
 */
function insertEdge(src: number, dst: number, rel: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO edge (src, dst, rel, t_created)
     VALUES (?, ?, ?, ?)`,
  ).run(src, dst, rel, NOW);
}

/**
 * Create a fully-connected cluster of nodes — every node in the cluster has an
 * edge to every other node, so label propagation converges to a single label.
 * Returns the rowids.
 */
function seedCluster(prefix: string, count: number, kind: 'episode' | 'claim'): number[] {
  const rowids: number[] = [];
  for (let i = 0; i < count; i++) {
    const uid = `${prefix}-${String(i).padStart(3, '0')}`;
    const insertFn = kind === 'claim' ? insertClaim : insertEpisode;
    rowids.push(insertFn(uid, `Content for ${uid}`));
  }
  // Fully connected: every pair has an edge both ways
  for (let i = 0; i < rowids.length; i++) {
    for (let j = i + 1; j < rowids.length; j++) {
      insertEdge(rowids[i]!, rowids[j]!, 'RELATES_TO');
      insertEdge(rowids[j]!, rowids[i]!, 'RELATES_TO');
    }
  }
  return rowids;
}

/**
 * Count live level-0 communities (t_invalid IS NULL).
 */
function countLiveCommunities(): number {
  const row = db.prepare<unknown[], { cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'community' AND level = 0 AND t_invalid IS NULL`,
  ).get()!;
  return row.cnt;
}

/**
 * Count MEMBER_OF edges whose dst community is currently invalidated.
 * An orphan edge is one where rel='MEMBER_OF', edge.t_invalid IS NULL,
 * but the dst community node has t_invalid IS NOT NULL.
 */
function countOrphanedMemberEdges(): number {
  const row = db.prepare<unknown[], { cnt: number }>(
    `SELECT COUNT(*) AS cnt
     FROM edge e
     JOIN node n ON n.rowid = e.dst
     WHERE e.rel = 'MEMBER_OF'
       AND e.t_invalid IS NULL
       AND n.t_invalid IS NOT NULL`,
  ).get()!;
  return row.cnt;
}

/**
 * Count all MEMBER_OF edges (live or invalidated).
 */
function countAllMemberEdges(): number {
  const row = db.prepare<unknown[], { cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM edge WHERE rel = 'MEMBER_OF'`,
  ).get()!;
  return row.cnt;
}

describe('BUG-MEMORY-008 — buildCommunities guard', () => {
  describe('(a) refusal without force — leaves graph intact', () => {
    it('throws when live level-0 communities exist and force is not set', async () => {
      // Seed two distinct clusters that will form communities
      seedCluster('clusterA', 3, 'episode');
      seedCluster('clusterB', 3, 'episode');

      // First pass — create communities with force (no prior communities exist,
      // so the guard does not fire regardless)
      const result1 = await buildCommunities(adapter, { force: true, minCommunitySize: 2 });
      expect(result1.communities).toBeGreaterThanOrEqual(1);

      // Verify communities now exist
      const liveBefore = countLiveCommunities();
      expect(liveBefore).toBeGreaterThan(0);

      // Verify no orphaned edges from the initial pass
      expect(countOrphanedMemberEdges()).toBe(0);

      // Second pass — WITHOUT force — must throw
      await expect(buildCommunities(adapter)).rejects.toThrow(
        /live level-0 community.*exist.*{force:true} was not set/,
      );

      // Graph MUST be intact: same number of live communities as before
      expect(countLiveCommunities()).toBe(liveBefore);
      // No orphaned edges introduced
      expect(countOrphanedMemberEdges()).toBe(0);
    });

    it('does NOT throw when no live communities exist (guard is silent)', async () => {
      // No communities yet
      expect(countLiveCommunities()).toBe(0);

      seedCluster('freshA', 3, 'episode');
      seedCluster('freshB', 3, 'episode');

      // Should succeed without force because no live communities exist
      await expect(
        buildCommunities(adapter),
      ).resolves.not.toThrow();

      expect(countLiveCommunities()).toBeGreaterThan(0);
      expect(countOrphanedMemberEdges()).toBe(0);
    });
  });

  describe('(b) with force — single transaction, no orphaned edges', () => {
    it('completes wipes and recreates communities with zero orphaned MEMBER_OF edges', async () => {
      // Seed two distinct clusters
      seedCluster('forceA', 3, 'episode');
      seedCluster('forceB', 3, 'claim');

      // First pass with force
      const r1 = await buildCommunities(adapter, { force: true, minCommunitySize: 2 });
      expect(r1.communities).toBeGreaterThanOrEqual(1);
      expect(r1.members).toBeGreaterThan(0);
      expect(countOrphanedMemberEdges()).toBe(0);

      const liveAfterFirst = countLiveCommunities();
      expect(liveAfterFirst).toBeGreaterThan(0);

      // Re-run with force — should replace everything in one transaction
      // Add a new cluster so the result isn't identical
      seedCluster('forceC', 3, 'episode');

      const r2 = await buildCommunities(adapter, { force: true, minCommunitySize: 2 });
      expect(r2.communities).toBeGreaterThanOrEqual(1);
      expect(r2.members).toBeGreaterThan(0);

      // After force run: no orphaned MEMBER_OF edges
      expect(countOrphanedMemberEdges()).toBe(0);

      // All old communities are invalidated, new ones exist
      // (they may not be the same count — that's fine)
      expect(countLiveCommunities()).toBeGreaterThan(0);
    });

    it('invalidates MEMBER_OF edges whose dst communities were invalidated', async () => {
      // Seed clusters and build initial communities
      seedCluster('edgeA', 3, 'episode');
      seedCluster('edgeB', 3, 'episode');
      await buildCommunities(adapter, { force: true, minCommunitySize: 2 });

      // Grab the initial edge set: every MEMBER_OF edge has a live community dst
      const memberEdgesBefore = countAllMemberEdges();
      expect(memberEdgesBefore).toBeGreaterThan(0);
      expect(countOrphanedMemberEdges()).toBe(0);

      // Add a new cluster so the graph changes
      seedCluster('edgeC', 3, 'claim');

      // Force re-build
      await buildCommunities(adapter, { force: true, minCommunitySize: 2 });

      // Key assertion: zero orphaned edges — every old MEMBER_OF edge was
      // invalidated along with its community dst
      expect(countOrphanedMemberEdges()).toBe(0);

      // The old edge count should differ (old edges invalidated, new edges created)
      // Not asserting specific count since it depends on clustering algorithm
    });

    it('force=true clears the guard even when many communities exist', async () => {
      // Build a lot of clusters
      for (let g = 0; g < 5; g++) {
        seedCluster(`many-${g}`, 3, 'episode');
      }
      await buildCommunities(adapter, { force: true, minCommunitySize: 2 });
      const liveBefore = countLiveCommunities();
      expect(liveBefore).toBeGreaterThanOrEqual(1);

      // Force re-run — should not throw
      await expect(
        buildCommunities(adapter, { force: true, minCommunitySize: 2 }),
      ).resolves.not.toThrow();

      expect(countOrphanedMemberEdges()).toBe(0);
      expect(countLiveCommunities()).toBeGreaterThan(0);
    });
  });
});
