#!/usr/bin/env node
/**
 * bench-member-of-index.mjs — test graph-refactor-guard's hypothesis that the
 * hot MEMBER_OF community path cannot use its covering index.
 *
 * THE HYPOTHESIS: `ix_edge_src`/`ix_edge_dst` are PARTIAL indexes predicated on
 * `t_expired IS NULL` (graph-store/src/index.ts:115-116), but every community
 * traversal filters `t_invalid IS NULL` (community-gc.ts:33-36, cluster.ts:315,
 * memory-server/src/index.ts:1696). SQLite may only use a partial index when it
 * can prove the WHERE clause implies the index predicate — which it cannot here,
 * since t_invalid and t_expired are different columns.
 *
 * Method: EXPLAIN QUERY PLAN the real handler query on a COPY, then A/B against
 * a t_invalid-predicated index added to the copy.
 *
 * READ-ONLY w.r.t. production. Writes ONLY to the copy. Refuses ~/.memory.
 */
import { performance } from 'node:perf_hooks';
import { connect } from '@tursodatabase/database';

const DB = process.env.BENCH_DB ?? '/tmp/sub600b/bench.db';
if (DB.includes('/.memory/')) {
  console.error('REFUSING: must not touch the live store. Use a copy.');
  process.exit(2);
}
const N = Number(process.env.BENCH_N ?? 200);
const db = await connect(DB);

async function all(sql, args = []) {
  return await (await db.prepare(sql)).all(args);
}

// Does the edge table even have t_expired, and is it populated?
const cols = await all(`SELECT name FROM pragma_table_info('edge')`);
const colNames = cols.map((c) => c.name);
const counts = await all(
  `SELECT COUNT(*) AS total,
          SUM(CASE WHEN t_invalid IS NULL THEN 1 ELSE 0 END) AS live_by_invalid
     FROM edge WHERE rel = 'MEMBER_OF'`,
);

// The real per-episode community lookup (memory-server/src/index.ts:1696-1701).
const HOT = `
  SELECT c.uid
    FROM edge e
    JOIN node c ON c.rowid = e.dst
   WHERE e.src = ?
     AND e.rel = 'MEMBER_OF'
     AND e.t_invalid IS NULL
     AND c.kind = 'community'
     AND c.t_invalid IS NULL
   LIMIT 1`;

const planBefore = await all(`EXPLAIN QUERY PLAN ${HOT}`, [1]);

// Sample real clustered episode rowids to probe with.
const probes = (
  await all(
    `SELECT e.src AS rowid FROM edge e
      WHERE e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
      LIMIT ?`,
    [N],
  )
).map((r) => r.rowid);

async function timeHot(label) {
  // warm
  for (let i = 0; i < 20; i++) await all(HOT, [probes[i % probes.length]]);
  const samples = [];
  for (let i = 0; i < probes.length; i++) {
    const t = performance.now();
    await all(HOT, [probes[i]]);
    samples.push(performance.now() - t);
  }
  const s = samples.sort((a, b) => a - b);
  const pct = (p) => s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)];
  return {
    label,
    n: s.length,
    p50: +pct(50).toFixed(3),
    p90: +pct(90).toFixed(3),
    p99: +pct(99).toFixed(3),
    mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3),
    total_ms: +s.reduce((a, b) => a + b, 0).toFixed(1),
  };
}

const before = await timeHot('current_indexes');

// ── Add the index the hot path actually wants (ON THE COPY ONLY) ────────────
await (await db.prepare(
  `CREATE INDEX IF NOT EXISTS ix_edge_src_live_invalid
     ON edge(src, rel) WHERE t_invalid IS NULL`,
)).run();
await (await db.prepare(`ANALYZE`)).run();

const planAfter = await all(`EXPLAIN QUERY PLAN ${HOT}`, [1]);
const after = await timeHot('with_t_invalid_index');

console.log(
  JSON.stringify(
    {
      bench: 'member-of-index',
      db: DB,
      edge_columns: colNames,
      member_of_edges: counts[0],
      plan_before: planBefore.map((r) => r.detail ?? r),
      plan_after: planAfter.map((r) => r.detail ?? r),
      before,
      after,
      speedup: +(before.p50 / after.p50).toFixed(2),
      hypothesis:
        'graph-refactor-guard: ix_edge_src/dst are partial on t_expired IS NULL ' +
        'but the community path filters t_invalid IS NULL, so the covering index ' +
        'may not apply. Compare plan_before/plan_after for SCAN vs SEARCH.',
    },
    null,
    2,
  ),
);
await db.close();
