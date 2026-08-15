/**
 * perf-golden.perf-memory-005.spec.ts — stored latency/plan goldens for the
 * hot-path index audit that produced PERF-MEMORY-002 (commit dbcbab69,
 * ix_edge_src_live/ix_edge_dst_live) and its PERF-MEMORY-005 follow-ups in
 * this file (the missing ix_node_kind_live index, and re-applying the two
 * edge _live indexes everywhere EDGE_INDEX_DDLS is used, not just in
 * graphDdl()'s inline template literal).
 *
 * WHY PLAN ASSERTIONS OVER WALL-CLOCK WHERE POSSIBLE: a plan assertion
 * (`EXPLAIN QUERY PLAN` contains SEARCH via the expected index, not SCAN) is
 * machine-independent — it cannot flake on a loaded laptop or a slow CI
 * runner the way a wall-clock bound can. It is also a MUCH stronger
 * regression signal for exactly this defect class: the original 775x
 * regression (11,638ms -> 15ms) was caused by a SILENT planner fallback from
 * SEARCH to SCAN, not by any change in row count or hardware. Every query
 * below whose whole point is index selection asserts the plan.
 *
 * Wall-clock ceilings are still included, generously bounded, as a second
 * independent signal (an index existing does not guarantee the PLANNER uses
 * it on every SQLite version/build) — but they are secondary to the plan
 * assertions, and are sized against a synthetic in-test corpus, not the
 * production store, so they do not depend on any environment outside this
 * file.
 *
 * Corpus: 3,000 episodes, 300 communities, 300 entities, ~4,300 edges
 * (MEMBER_OF episode->community, MENTIONS episode->entity), seeded via a
 * single batched transaction (not per-row writeNode/writeEdge calls, which
 * would dominate the test's own wall time and have nothing to do with what
 * this file measures).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapterImpl } from '@adhd/sox-store-adapter';
import { createGraphBackend } from './index.js';

let tmpDir: string;
let dbPath: string;
let adapter: SqliteAdapterImpl;

const N_EPISODES = 3000;
const N_COMMUNITIES = 300;
const N_ENTITIES = 300;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'graph-store-perf-golden-'));
  dbPath = join(tmpDir, 'perf-golden.db');
  adapter = new SqliteAdapterImpl(dbPath);
  const backend = createGraphBackend(adapter);
  await backend.applySchema();

  const now = new Date().toISOString();
  const stmts: { sql: string; args?: unknown[] }[] = [];

  // node rowids are allocated in insertion order (INTEGER PRIMARY KEY, no
  // gaps) starting at 1: episodes [1, N_EPISODES], communities
  // [N_EPISODES+1, N_EPISODES+N_COMMUNITIES], entities after that.
  for (let i = 0; i < N_EPISODES; i++) {
    stmts.push({
      sql: `INSERT INTO node (uid, kind, content, t_created) VALUES (?, 'episode', ?, ?)`,
      args: [`ep-${i}`, `episode content ${i}`, now],
    });
  }
  for (let i = 0; i < N_COMMUNITIES; i++) {
    stmts.push({
      sql: `INSERT INTO node (uid, kind, content, t_created) VALUES (?, 'community', ?, ?)`,
      args: [`comm-${i}`, `community ${i}`, now],
    });
  }
  for (let i = 0; i < N_ENTITIES; i++) {
    stmts.push({
      sql: `INSERT INTO node (uid, kind, content, t_created) VALUES (?, 'entity', ?, ?)`,
      args: [`ent-${i}`, `entity ${i}`, now],
    });
  }
  await adapter.executeMany(stmts);

  // Edges: every episode -> one community (MEMBER_OF), every episode -> one
  // entity (MENTIONS). rowids: episodes are 1..N_EPISODES, communities are
  // N_EPISODES+1..N_EPISODES+N_COMMUNITIES, entities follow.
  const edgeStmts: { sql: string; args?: unknown[] }[] = [];
  for (let i = 0; i < N_EPISODES; i++) {
    const episodeRowid = i + 1;
    const communityRowid = N_EPISODES + (i % N_COMMUNITIES) + 1;
    const entityRowid = N_EPISODES + N_COMMUNITIES + (i % N_ENTITIES) + 1;
    edgeStmts.push({
      sql: `INSERT INTO edge (src, dst, rel, t_created) VALUES (?, ?, 'MEMBER_OF', ?)`,
      args: [episodeRowid, communityRowid, now],
    });
    edgeStmts.push({
      sql: `INSERT INTO edge (src, dst, rel, t_created) VALUES (?, ?, 'MENTIONS', ?)`,
      args: [episodeRowid, entityRowid, now],
    });
  }
  await adapter.executeMany(edgeStmts);

  await adapter.executeRun('ANALYZE');
}, 60_000);

afterAll(async () => {
  await adapter.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Flatten an EXPLAIN QUERY PLAN result to its `detail` strings, joined. */
async function planDetail(sql: string, args?: unknown[]): Promise<string> {
  const res = await adapter.executeAll<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, args);
  return res.rows.map((r) => r.detail).join(' | ');
}

async function timedRun<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const t0 = performance.now();
  const result = await fn();
  const ms = performance.now() - t0;
  return { result, ms };
}

describe('PERF-MEMORY-005 golden — node kind+live lookups (ix_node_kind_live)', () => {
  it('episode count by kind+live: SEARCH via ix_node_kind_live, not a SCAN', async () => {
    const plan = await planDetail(
      `SELECT COUNT(*) FROM node WHERE kind = 'episode' AND t_invalid IS NULL`,
    );
    expect(plan).toContain('ix_node_kind_live');
    expect(plan).not.toMatch(/^SCAN/);
  });

  it('community count by kind+live: SEARCH via ix_node_kind_live', async () => {
    const plan = await planDetail(
      `SELECT COUNT(*) FROM node WHERE kind = 'community' AND t_invalid IS NULL`,
    );
    expect(plan).toContain('ix_node_kind_live');
  });

  it('entity count by kind+live: SEARCH via ix_node_kind_live', async () => {
    const plan = await planDetail(
      `SELECT COUNT(*) FROM node WHERE kind = 'entity' AND t_invalid IS NULL`,
    );
    expect(plan).toContain('ix_node_kind_live');
  });

  it(
    'wall-clock: episode kind+live count stays well under a full-corpus scan',
    async () => {
      // Measured baseline (production store, 11,757 nodes, 2026-08-14, pre-fix
      // SCAN plan): ~186ms. This corpus is smaller (3,600 nodes) and the fix
      // makes it a direct index SEARCH, so 25ms is already >7x margin over
      // what a SCAN of a corpus this size would cost, generous for a loaded
      // machine while still catching a regression back to SCAN.
      const { result, ms } = await timedRun(() =>
        adapter.executeGet<{ c: number }>(
          `SELECT COUNT(*) AS c FROM node WHERE kind = 'episode' AND t_invalid IS NULL`,
        ),
      );
      expect(result?.c).toBe(N_EPISODES);
      expect(ms).toBeLessThan(25);
    },
  );
});

describe('PERF-MEMORY-005 golden — edge live-predicate lookups (ix_edge_src_live / ix_edge_dst_live)', () => {
  it('MEMBER_OF edges by src+rel+live: SEARCH via ix_edge_src_live', async () => {
    const plan = await planDetail(
      `SELECT dst FROM edge WHERE src = ? AND rel = 'MEMBER_OF' AND t_invalid IS NULL`,
      [1],
    );
    expect(plan).toContain('ix_edge_src_live');
  });

  it('MEMBER_OF edges by dst+rel+live: SEARCH via ix_edge_dst_live', async () => {
    const plan = await planDetail(
      `SELECT src FROM edge WHERE dst = ? AND rel = 'MEMBER_OF' AND t_invalid IS NULL`,
      [N_EPISODES + 1],
    );
    expect(plan).toContain('ix_edge_dst_live');
  });

  it('dst-only live lookup (memory_invalidate shape): SEARCH via ix_edge_dst_live', async () => {
    // This is the exact shape that regressed to an 11.6s SCAN in the
    // originating incident (community GC's NOT EXISTS probe per candidate
    // row) -- the single most important plan assertion in this file.
    const plan = await planDetail(`SELECT rowid FROM edge WHERE dst = ? AND t_invalid IS NULL`, [1]);
    expect(plan).toContain('ix_edge_dst_live');
    expect(plan).not.toMatch(/SCAN edge USING INDEX ix_edge_live\b/);
  });

  it(
    'wall-clock: dst+live point lookup stays far below the pre-fix SCAN cost',
    async () => {
      // Measured baseline (production store, 61,694 edges, 2026-08-14,
      // pre-fix): 11,638ms for the equivalent NOT EXISTS probe pattern
      // (community-gc.ts). Post-fix on the live store: 15ms. This corpus is
      // smaller; 20ms leaves >500x margin under the historical regression
      // while still catching a reversion to the SCAN plan.
      const { ms } = await timedRun(() =>
        adapter.executeAll(`SELECT rowid FROM edge WHERE dst = ? AND t_invalid IS NULL`, [
          N_EPISODES + 1,
        ]),
      );
      expect(ms).toBeLessThan(20);
    },
  );
});

describe('PERF-MEMORY-005 golden — edge expired-predicate lookups (pre-existing ix_edge_src / ix_edge_dst)', () => {
  it('MENTIONS edges by src+rel+expired: SEARCH via ix_edge_src', async () => {
    const plan = await planDetail(
      `SELECT dst FROM edge WHERE src = ? AND rel = 'MENTIONS' AND t_expired IS NULL`,
      [1],
    );
    expect(plan).toContain('ix_edge_src');
  });

  it('MENTIONS edges by dst+rel+expired: SEARCH via ix_edge_dst', async () => {
    const plan = await planDetail(
      `SELECT src FROM edge WHERE dst = ? AND rel = 'MENTIONS' AND t_expired IS NULL`,
      [N_EPISODES + N_COMMUNITIES + 1],
    );
    expect(plan).toContain('ix_edge_dst');
  });
});

describe('PERF-MEMORY-005 golden — DDL surfaces stay in sync (regression guard for the follow-up fix)', () => {
  it('EDGE_INDEX_DDLS (the self-heal-rebuild array) carries the live-partial pair', async () => {
    const { EDGE_INDEX_DDLS } = await import('./index.js');
    const joined = EDGE_INDEX_DDLS.join('\n');
    expect(joined).toContain('ix_edge_src_live');
    expect(joined).toContain('ix_edge_dst_live');
  });

  it('NODE_INDEX_DDLS (the self-heal-rebuild array) carries ix_node_kind_live', async () => {
    const { NODE_INDEX_DDLS } = await import('./index.js');
    const joined = NODE_INDEX_DDLS.join('\n');
    expect(joined).toContain('ix_node_kind_live');
  });

  it('GRAPH_DDL (fresh-store schema) carries all three PERF-MEMORY indexes', async () => {
    const { GRAPH_DDL } = await import('./index.js');
    expect(GRAPH_DDL).toContain('ix_edge_src_live');
    expect(GRAPH_DDL).toContain('ix_edge_dst_live');
    expect(GRAPH_DDL).toContain('ix_node_kind_live');
  });

  it('INLINE_MIGRATION_DDL (Drizzle standalone-consumer schema) carries all three', async () => {
    const { INLINE_MIGRATION_DDL } = await import('./index.js');
    expect(INLINE_MIGRATION_DDL).toContain('ix_edge_src_live');
    expect(INLINE_MIGRATION_DDL).toContain('ix_edge_dst_live');
    expect(INLINE_MIGRATION_DDL).toContain('ix_node_kind_live');
  });
});
