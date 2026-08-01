/**
 * recall-parity-arm-attribution.test.ts — BL-367 per-arm attribution.
 *
 * Runs each of the three recall arms (vec KNN, FTS/BM25, temporal) in
 * ISOLATION against sqlite and turso, on the identical corpus/queries used
 * by recall-parity.test.ts, and reports a per-arm content-overlap table.
 * This exists so a real backend divergence gets attributed to the specific
 * arm responsible instead of guessed at (BL-367 explicitly forbids guessing).
 *
 * ── Findings (2026-08-01), with the FTS fix reverted for measurement ──────
 *
 *   arm       | avg overlap | root cause
 *   ----------|-------------|---------------------------------------------
 *   vec       | 0.52        | NOT a metric bug — sqlite (vec0, undeclared
 *             |             | distance_metric ⇒ L2 default) and turso
 *             |             | (explicit vector_distance_cos) compute
 *             |             | mathematically CONSISTENT, monotonically-
 *             |             | related distances for unit-normalised vectors
 *             |             | (verified: the one non-degenerate pair in the
 *             |             | corpus agrees exactly, d_L2²=2-2·cos_sim on
 *             |             | both sides). The divergence is dominated by
 *             |             | ARBITRARY TIE-BREAK ORDER among candidates
 *             |             | that are genuinely tied (cosine≈0, exactly
 *             |             | orthogonal) — a byproduct of the tiny 10-doc,
 *             |             | 5-unrelated-topic corpus and the coarse
 *             |             | feature-hash test embedding producing exact
 *             |             | zero-similarity ties that real dense (BGE)
 *             |             | embeddings essentially never produce. Neither
 *             |             | `topKQuery` implementation declares a
 *             |             | secondary tie-break key, so ties resolve to
 *             |             | each engine's internal row-iteration order —
 *             |             | a real latent fragility, but not the
 *             |             | contract-breaking defect (see BL-367 follow-up
 *             |             | note below).
 *   fts       | 0.10        | REAL, FIXED (BL-367): SQLite FTS5 bareword
 *             |             | queries default to AND between tokens; Turso's
 *             |             | Tantivy `fts_match` matches on ANY token
 *             |             | (effectively OR). recall.ts's naive
 *             |             | space-joined query text meant SQLite returned
 *             |             | ZERO FTS matches for 4/5 test queries while
 *             |             | Turso returned real hits for the identical
 *             |             | corpus/query. Fixed by `FTSDialect.
 *             |             | buildMatchQuery()`, which both dialects now
 *             |             | implement as an explicit `"tok1" OR "tok2"`
 *             |             | join — verified to produce IDENTICAL result
 *             |             | sets on both backends for every test query.
 *   temporal  | 1.00        | No divergence — backend-agnostic SQL query.
 *
 * The FTS fix alone was sufficient to bring the composite recall-parity
 * test from 0.52 to ≥0.80 (see recall-parity.test.ts) — the vec-arm tie
 * noise, while real, does not dominate the composite average once FTS
 * stops contributing near-zero overlap.
 *
 * Follow-up filed for the vec-arm tie-break fragility (real, but out of
 * scope for the 0.80 bar): BL-392.
 */
import {
  _resetEmbedSingleton,
  _setEmbedProviderForTest,
  DeterministicTestProvider,
  memoryWrite,
  openDb,
} from '@adhd/sox-memory-core';
import type { WriteResult } from '@adhd/sox-memory-core';
import { createFTSDialect, createVectorDialect } from '@adhd/sox-store-adapter';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

function makeTempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-recall-arm-'));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } } };
}

const TURSO_DRIVER_PATH = path.resolve(
  __dirname,
  '../../../../../node_modules/@tursodatabase/database/dist/promise.js',
);
function tursoAvailable(): boolean {
  try { return fs.existsSync(TURSO_DRIVER_PATH); } catch { return false; }
}
const HAS_TURSO = tursoAvailable();

const EPISODES = [
  'The quick brown fox jumps over the lazy dog near the riverbank.',
  'Machine learning models require careful feature engineering and validation.',
  'The quarterly financial report shows a 15% increase in revenue across all sectors.',
  'Neural networks can approximate any continuous function given enough parameters.',
  'The team completed the sprint with all user stories delivered on time.',
  'Deep reinforcement learning has achieved superhuman performance in many games.',
  'Project Alpha is entering phase three of development with expanded scope.',
  'Natural language processing has seen remarkable advances with transformer architectures.',
  'The server infrastructure needs to be upgraded to handle increased traffic loads.',
  'Database indexing strategies can dramatically improve query performance for large datasets.',
];

const QUERIES = [
  'fox riverbank wildlife outdoors',
  'machine learning neural deep',
  'financial revenue quarterly growth',
  'transformer NLP language processing',
  'database indexing performance query',
];

async function writeEpisodes(adapter: StoreAdapter): Promise<Map<string, number>> {
  // content -> rowid
  const map = new Map<string, number>();
  for (const content of EPISODES) {
    const result = await memoryWrite(adapter, { content, project_path: '/test/parity-project' });
    const uid = (result as WriteResult).episode_uid;
    const row = await adapter.executeGet<{ rowid: number }>(
      'SELECT rowid FROM node WHERE uid = ?',
      [uid],
    );
    if (row) map.set(content, row.rowid);
  }
  return map;
}

async function embedText(text: string): Promise<number[]> {
  const provider = new DeterministicTestProvider();
  const vec = await provider.embedSingle(text);
  return Array.from(vec);
}

/** Isolated vec-KNN arm — mirrors recall.ts §2a exactly, including the
 *  BL-367 stable node_id tiebreak applied in JS after the SQL fetch. */
async function vecArmRowids(adapter: StoreAdapter, query: string, limit: number): Promise<number[]> {
  const vectorDialect = createVectorDialect(adapter.config.type);
  const queryVec = await embedText(query);
  const { sql, args } = vectorDialect.topKQuery('vec_node', 'embedding', queryVec, limit, 'cosine');
  const filled = sql.replace('__PLACEHOLDER__', "n.t_invalid IS NULL");
  const finalSql = filled + ' LIMIT ?';
  const result = await adapter.executeAll<{ node_id: number; distance: number }>(finalSql, [...args, limit]);
  const rows = [...result.rows].sort((a, b) => a.distance - b.distance || a.node_id - b.node_id);
  return rows.map((r) => r.node_id);
}

/** Isolated FTS/BM25 arm — mirrors recall.ts §2b exactly (post-BL-367 fix: dialect-built OR query). */
async function ftsArmRowids(adapter: StoreAdapter, query: string, limit: number): Promise<number[]> {
  const ftsDialect = createFTSDialect(adapter.config.type);
  const tokens = query.replace(/['"*\-+]/g, ' ').trim().split(/\s+/).filter((t) => t.length > 1);
  if (tokens.length === 0 || !ftsDialect.supported) return [];
  const ftsQuery = ftsDialect.buildMatchQuery(tokens);
  const { sql: matchSql } = ftsDialect.matchClause(['content', 'name', 'summary'], '?');
  const scoreExpr = ftsDialect.scoreClause(['content', 'name', 'summary'], '?');
  if (ftsDialect.supportsShadowTable) {
    const result = await adapter.executeAll<{ rowid: number; rank: number }>(
      `SELECT fts_node.rowid, ${scoreExpr} AS rank
       FROM fts_node JOIN node n ON n.rowid = fts_node.rowid
       WHERE ${matchSql} AND n.t_invalid IS NULL
       ORDER BY rank LIMIT ?`,
      [ftsQuery, limit],
    );
    return result.rows.map((r) => r.rowid);
  } else {
    const result = await adapter.executeAll<{ rowid: number; rank: number }>(
      `SELECT rowid, ${scoreExpr} AS rank FROM node
       WHERE ${matchSql} AND t_invalid IS NULL
       ORDER BY rank LIMIT ?`,
      [ftsQuery, ftsQuery, limit],
    );
    return result.rows.map((r) => r.rowid);
  }
}

/** Isolated temporal arm — mirrors recall.ts §2c exactly (backend-agnostic SQL, included for completeness). */
async function temporalArmRowids(adapter: StoreAdapter, limit: number): Promise<number[]> {
  const result = await adapter.executeAll<{ rowid: number; t_created: string }>(
    `SELECT n.rowid, n.t_created FROM node n WHERE n.t_invalid IS NULL ORDER BY n.t_created DESC LIMIT ?`,
    [limit],
  );
  return result.rows.map((r) => r.rowid);
}

function overlap(aRows: number[], aMap: Map<string, number>, bRows: number[], bMap: Map<string, number>): number {
  // Convert rowids back to content via reverse lookup, then compare by content
  // (the identity that crosses independent stores — see recall-parity.test.ts).
  const aRev = new Map<number, string>([...aMap].map(([c, r]) => [r, c]));
  const bRev = new Map<number, string>([...bMap].map(([c, r]) => [r, c]));
  const aContent = new Set(aRows.map((r) => aRev.get(r)).filter(Boolean) as string[]);
  const bContent = new Set(bRows.map((r) => bRev.get(r)).filter(Boolean) as string[]);
  const inter = new Set([...aContent].filter((x) => bContent.has(x)));
  const denom = Math.max(aContent.size, bContent.size);
  return denom === 0 ? 0 : inter.size / denom;
}

describe('BL-367 per-arm attribution (sqlite vs turso)', () => {
  it('measures vec/fts/temporal overlap in isolation — fts arm now ≥0.80 post-fix', { skip: !HAS_TURSO }, async () => {
    _resetEmbedSingleton();
    _setEmbedProviderForTest(new DeterministicTestProvider());

    const sqliteDir = makeTempDir();
    const tursoDir = makeTempDir();
    let sqliteAdapter: StoreAdapter | undefined;
    let tursoAdapter: StoreAdapter | undefined;

    try {
      const prevAdapter = process.env['STORE_ADAPTER'];
      process.env['STORE_ADAPTER'] = 'sqlite';
      sqliteAdapter = await openDb(path.join(sqliteDir.dir, 'memory.db'));
      process.env['STORE_ADAPTER'] = 'turso';
      tursoAdapter = await openDb(path.join(tursoDir.dir, 'memory.db'));
      if (prevAdapter === undefined) delete process.env['STORE_ADAPTER'];
      else process.env['STORE_ADAPTER'] = prevAdapter;

      const sqliteMap = await writeEpisodes(sqliteAdapter);
      const tursoMap = await writeEpisodes(tursoAdapter);
      expect(sqliteMap.size).toBe(10);
      expect(tursoMap.size).toBe(10);

      const limit = 5;
      const rows: { query: string; vec: number; fts: number; temporal: number }[] = [];

      for (const query of QUERIES) {
        const [sVec, tVec] = await Promise.all([
          vecArmRowids(sqliteAdapter, query, limit),
          vecArmRowids(tursoAdapter, query, limit),
        ]);
        const [sFts, tFts] = await Promise.all([
          ftsArmRowids(sqliteAdapter, query, limit),
          ftsArmRowids(tursoAdapter, query, limit),
        ]);
        const [sTemp, tTemp] = await Promise.all([
          temporalArmRowids(sqliteAdapter, limit),
          temporalArmRowids(tursoAdapter, limit),
        ]);

        rows.push({
          query,
          vec: overlap(sVec, sqliteMap, tVec, tursoMap),
          fts: overlap(sFts, sqliteMap, tFts, tursoMap),
          temporal: overlap(sTemp, sqliteMap, tTemp, tursoMap),
        });
      }

      console.log('\n=== BL-367 per-arm overlap (sqlite vs turso), content-based ===');
      console.table(rows);
      const avg = (key: 'vec' | 'fts' | 'temporal') => rows.reduce((s, r) => s + r[key], 0) / rows.length;
      const avgFts = avg('fts');
      console.log(`avg vec=${avg('vec').toFixed(2)} fts=${avgFts.toFixed(2)} temporal=${avg('temporal').toFixed(2)}`);

      expect(rows.length).toBe(QUERIES.length);
      // The BL-367 fix target: the FTS arm was the dominant divergence
      // (0.10 avg pre-fix). Post-fix it must be at parity with temporal.
      expect(avgFts).toBeGreaterThanOrEqual(0.80);
    } finally {
      await sqliteAdapter?.close();
      await tursoAdapter?.close();
      sqliteDir.cleanup();
      tursoDir.cleanup();
    }
  });
});
