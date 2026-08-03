/**
 * bl420-cluster-threshold-dead-fallback.spec.ts — BL-420.
 *
 * `enrich-batch.ts`'s `resolveClusterThreshold()` used to hardcode its own
 * `0.82` completely independent of `cluster.ts`'s `resolveDefaultThreshold()`.
 * Every real `runBatchEnrich()` call passes `resolveClusterThreshold(...)`'s
 * result as an EXPLICIT `threshold` into `clusterStore()` — so
 * `computeClusters`'s own `opts.threshold ?? resolveDefaultThreshold()`
 * fallback (cluster.ts) was unreachable dead code in production: the "default"
 * that ships is not the default that runs. This is the same shape as BL-326
 * (a stub/fallback that looks live in the source but is provably never
 * reached by the real call path) and PKT-28's research explicitly names 0.82
 * as degenerate at the live corpus's current size (largest-cluster ratio
 * 0.759 at N=4867) — so the unreachable fallback being *more correct* than
 * the value actually in effect made the defect strictly worse, not inert.
 *
 * Fix: `enrich-batch.ts`'s `resolveClusterThreshold()` now delegates to
 * `cluster.ts`'s exported `resolveDefaultThreshold()` instead of carrying its
 * own constant — one source of truth, so a future PKT-30 calibration change
 * only has to land in one place.
 *
 * This test proves the fix with a controlled, exact cosine similarity: two
 * episodes constructed so their embeddings have cosine similarity EXACTLY
 * 0.845 (strictly between the old hardcoded 0.82 and the correct 0.87). Under
 * the pre-fix hardcoded-0.82 behaviour these two would cluster (0.845 > 0.82);
 * under the fixed delegation they must NOT (0.845 < 0.87). No override is
 * passed to `runBatchEnrich`, so this exercises exactly the code path real
 * production traffic uses.
 */
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { runBatchEnrich, wrapRawDbAsAdapter } from './index.js';

// Mirrors enrich.spec.ts's MINIMAL_DDL — kept local per that file's own
// documented convention (each spec owns its lightweight fixture schema).
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

function makeTmpDb(): { db: Database.Database; adapter: StoreAdapter; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl420-'));
  const dbPath = path.join(dir, 'test.db');
  const db = new Database(dbPath);
  sqliteVec.load(db);
  db.exec(MINIMAL_DDL);
  const adapter = wrapRawDbAsAdapter(db);
  return {
    db,
    adapter,
    cleanup: () => {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function insertEpisode(db: Database.Database, uid: string, content: string, embedding: Float32Array): number {
  const now = new Date().toISOString();
  const result = db
    .prepare<unknown[], { rowid: number }>(
      `INSERT INTO node (uid, kind, content, t_created, t_valid) VALUES (?, 'episode', ?, ?, ?) RETURNING rowid`,
    )
    .get(uid, content, now, now)!;
  db.prepare('INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)').run(
    result.rowid,
    '[' + Array.from(embedding).map((v) => v.toFixed(8)).join(',') + ']',
  );
  return result.rowid;
}

/** Deterministic unit vector from a seed (matches enrich.spec.ts's seedEmbedding shape). */
function seedUnitVector(seed: number): Float32Array {
  const vec = new Float32Array(768);
  for (let i = 0; i < 768; i++) {
    vec[i] = Math.sin(seed * (i + 1)) * 0.1 + Math.cos(seed * i) * 0.1;
  }
  let norm = 0;
  for (let i = 0; i < 768; i++) norm += (vec[i] as number) * (vec[i] as number);
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < 768; i++) vec[i] = (vec[i] as number) / norm;
  return vec;
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] as number) * (b[i] as number);
  return s;
}

/**
 * Build two unit vectors [v1, v3] with cosine similarity EXACTLY
 * `targetCos` — construction: v2 = Gram-Schmidt-orthogonalize an independent
 * seed vector against v1, then v3 = cos(θ)·v1 + sin(θ)·v2 (θ = acos(targetCos)).
 * Since v1 ⟂ v2 and both are unit vectors, cosineSim(v1, v3) = cos(θ) exactly.
 */
function buildPairAtExactCosine(targetCos: number): [Float32Array, Float32Array] {
  const v1 = seedUnitVector(1);
  const w = seedUnitVector(777); // independent direction
  const wDotV1 = dot(w, v1);
  const v2Raw = new Float32Array(768);
  for (let i = 0; i < 768; i++) v2Raw[i] = (w[i] as number) - wDotV1 * (v1[i] as number);
  let v2Norm = 0;
  for (let i = 0; i < 768; i++) v2Norm += (v2Raw[i] as number) * (v2Raw[i] as number);
  v2Norm = Math.sqrt(v2Norm);
  const v2 = new Float32Array(768);
  for (let i = 0; i < 768; i++) v2[i] = (v2Raw[i] as number) / v2Norm;

  const theta = Math.acos(targetCos);
  const cosT = Math.cos(theta);
  const sinT = Math.sin(theta);
  const v3 = new Float32Array(768);
  for (let i = 0; i < 768; i++) v3[i] = cosT * (v1[i] as number) + sinT * (v2[i] as number);

  return [v1, v3];
}

describe('BL-420 — enrich-batch.ts resolveClusterThreshold no longer hardcodes an independent constant', () => {
  it('two episodes at cosine sim 0.845 (between the stale 0.82 and correct 0.87) do NOT cluster via a bare runBatchEnrich() call', async () => {
    const { db, adapter, cleanup } = await makeTmpDb();
    try {
      const [v1, v3] = buildPairAtExactCosine(0.845);
      // Sanity: the construction actually hits the target cosine sim (within FP tolerance).
      expect(dot(v1, v3)).toBeCloseTo(0.845, 5);

      insertEpisode(db, 'bl420-ep1', 'A'.repeat(60), v1);
      insertEpisode(db, 'bl420-ep2', 'B'.repeat(60), v3);
      // Distractor singletons so the pair is a MINORITY of the corpus
      // (2/5 = 0.4 <= 0.5): without these, a successful 2-of-2 join is
      // itself degenerate (ratio 1.0) and cluster.ts's OWN D5.5 guard
      // retries at threshold+0.05 regardless of the starting threshold,
      // converging to the same outcome whether the default started at 0.82
      // or 0.87 — masking exactly the distinction this test exists to prove
      // (verified: without distractors this test does not go red against
      // the pre-fix hardcoded 0.82, for that reason).
      insertEpisode(db, 'bl420-distractor1', 'C'.repeat(60), seedUnitVector(101));
      insertEpisode(db, 'bl420-distractor2', 'D'.repeat(60), seedUnitVector(202));
      insertEpisode(db, 'bl420-distractor3', 'E'.repeat(60), seedUnitVector(303));

      // No clusterThreshold override — exactly what every real production
      // caller of runBatchEnrich does (memory-server's periodic tick never
      // passes one either). This is the code path BL-420 was hiding in.
      const result = await runBatchEnrich(adapter, {});

      // Under the pre-fix hardcoded 0.82, 0.845 > 0.82 → these WOULD have
      // clustered. Under the fixed delegation to resolveDefaultThreshold()
      // (0.87), 0.845 < 0.87 → they must NOT.
      expect(result.communities_upserted).toBe(0);
      expect(result.member_of_edges).toBe(0);
    } finally {
      cleanup();
    }
  });

  it('control: the SAME two episodes DO cluster once similarity clears 0.87', async () => {
    // Proves the test isn't just "clustering is broken" — raise the pair's
    // similarity above the real (fixed) threshold and confirm it fires.
    // Distractor singletons are required: with ONLY the 2-episode pair, a
    // successful join makes largest_cluster/total = 2/2 = 1.0, which trips
    // the D5.5 degenerate-cluster guard (cluster.ts) and the guard's
    // threshold+0.05 retries then push past 0.92 and destroy the very
    // cluster under test — a corpus-shape trap, not a threshold bug (see
    // cluster-incremental-join.spec.ts's own comment on the same trap).
    const { db, adapter, cleanup } = await makeTmpDb();
    try {
      const [v1, v3] = buildPairAtExactCosine(0.92);
      insertEpisode(db, 'bl420-ctrl1', 'A'.repeat(60), v1);
      insertEpisode(db, 'bl420-ctrl2', 'B'.repeat(60), v3);
      // Mutually near-orthogonal distractor singletons (low similarity to
      // v1/v3 and each other) so the pair is a minority (2/5 = 0.4 <= 0.5).
      insertEpisode(db, 'bl420-distractor1', 'C'.repeat(60), seedUnitVector(101));
      insertEpisode(db, 'bl420-distractor2', 'D'.repeat(60), seedUnitVector(202));
      insertEpisode(db, 'bl420-distractor3', 'E'.repeat(60), seedUnitVector(303));

      const result = await runBatchEnrich(adapter, {});
      expect(result.communities_upserted).toBeGreaterThanOrEqual(1);
      expect(result.member_of_edges).toBeGreaterThanOrEqual(2);
    } finally {
      cleanup();
    }
  });
});
