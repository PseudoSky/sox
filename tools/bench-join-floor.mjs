#!/usr/bin/env node
/**
 * bench-join-floor.mjs — measure the cost of the incremental community JOIN
 * step against a realistic corpus, isolated from embedding.
 *
 * The join in `cluster.ts` incrementalJoin() (libs/memory-core/src/cluster.ts
 * ~:520-625) does, per pass:
 *   1. load EVERY live community member's 768-d embedding blob,
 *   2. for each candidate, cosine against EVERY member vector (single-link),
 *   3. INSERT the MEMBER_OF edge for the best community above tau.
 *
 * This measures steps 1+2 for ONE candidate — the marginal cost a single
 * write would pay if the join ran inline instead of on the 5-minute tick.
 *
 * READ-ONLY on a COPY. Refuses to run against ~/.memory (BL-330).
 */
import { performance } from 'node:perf_hooks';
// The store is Turso-format: its FTS index (__turso_internal_fts_dir_*) is not
// parseable by better-sqlite3 ("malformed database schema ... near USING"),
// so the bench must use the same client the adapter uses.
import { connect } from '@tursodatabase/database';

const DB = process.env.BENCH_DB ?? '/tmp/sub600/bench.db';
if (DB.includes('/.memory/')) {
  console.error('REFUSING: benchmark must not touch the live store (~/.memory). Use a copy.');
  process.exit(2);
}

const db = await connect(DB);

function pct(sorted, p) {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[i];
}
function summarize(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return {
    n: s.length,
    p50: +pct(s, 50).toFixed(2),
    p90: +pct(s, 90).toFixed(2),
    p99: +pct(s, 99).toFixed(2),
    min: +s[0].toFixed(2),
    max: +s[s.length - 1].toFixed(2),
    mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(2),
  };
}

function blobToF32(buf) {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}
function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ── Step 1: load all live community member vectors (what each pass re-does) ──
const memberSql = `
  SELECT v.node_id AS node_id, v.embedding AS embedding, e.dst AS community_rowid
  FROM edge e
  JOIN node c ON c.rowid = e.dst AND c.kind = 'community' AND c.t_invalid IS NULL
  JOIN vec_node v ON v.node_id = e.src
  WHERE e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL`;

const loadSamples = [];
let memberRows = [];
for (let i = 0; i < Number(process.env.BENCH_LOADS ?? 5); i++) {
  const t = performance.now();
  memberRows = await (await db.prepare(memberSql)).all();
  loadSamples.push(performance.now() - t);
}

const memberVecs = memberRows.map((r) => blobToF32(r.embedding));
const communities = new Set(memberRows.map((r) => r.community_rowid));
const dim = memberVecs[0]?.length ?? 0;

// ── Step 2: marginal cosine scan for ONE candidate against all members ──────
const scanSamples = [];
const N = Number(process.env.BENCH_N ?? 50);
for (let i = 0; i < N; i++) {
  const candidate = memberVecs[i % memberVecs.length];
  const t = performance.now();
  let best = -1;
  for (const mv of memberVecs) {
    const s = cosine(candidate, mv);
    if (s > best) best = s;
  }
  scanSamples.push(performance.now() - t);
}

const load = summarize(loadSamples);
const scan = summarize(scanSamples);

console.log(
  JSON.stringify(
    {
      bench: 'join-floor',
      db: DB,
      member_vector_count: memberRows.length,
      community_count: communities.size,
      dimensions: dim,
      member_bytes: memberRows.length * dim * 4,
      full_member_load_ms: load,
      single_candidate_cosine_scan_ms: scan,
      note:
        'full_member_load is paid ONCE PER PASS; single_candidate_cosine_scan is ' +
        'the marginal per-episode cost. An inline join pays load+scan unless the ' +
        'member set is cached across writes.',
    },
    null,
    2,
  ),
);
await db.close();
