/**
 * BL-392: vec_node never declared an explicit distance_metric, so sqlite-vec's
 * vec0 module defaulted to L2 (Euclidean) distance while every call site in the
 * codebase claimed 'cosine'. This suite proves the fix against the REAL
 * sqlite-vec extension (not a string-matched SQL template) — see SPEC-PKT-22.md
 * §4 AC-2 for why a string-only assertion cannot distinguish a real fix from a
 * no-op: topKQuery's emitted SQL never literally contains the metric; the
 * metric lives entirely in the table's own DDL (vec0 has no per-query
 * override).
 *
 * Uses NON-normalised vectors so L2 and cosine distances provably diverge in
 * VALUE, not just rank order (the BL-392 finding notes the parity corpus's
 * normalised vectors keep L2 and cosine rank-order-equivalent, which is
 * exactly the trap this suite is designed to close).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SqliteAdapterImpl } from '../sqlite-adapter.js';
import { SqliteVecDialect } from '../vector-dialect.js';

// ── sqlite-vec availability ───────────────────────────────────────────────────

const hasVec = (() => {
  try {
    require.resolve('sqlite-vec');
    return true;
  } catch {
    return false;
  }
})();

const vecDescribe = hasVec ? describe : describe.skip;

// ── Temp directory setup ────────────────────────────────────────────────────

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-distance-metric-'));
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function tempPath(name: string): string {
  return join(tmpDir, name);
}

// Non-normalised vectors — a is unit, b is not, and they are not collinear.
const A = [1, 0, 0, 0];
const B = [2, 2, 0, 0];

// Expected Euclidean (L2) distance: sqrt((1-2)^2 + (0-2)^2) = sqrt(5)
const EXPECTED_L2 = Math.sqrt(5);
// Expected cosine distance (1 - cos_sim): cos_sim = 2 / (1 * sqrt(8))
const EXPECTED_COSINE = 1 - 2 / Math.sqrt(8);

// ============================================================================
// AC-2: topKQuery with metric='cosine' actually changes the computed
// distance, not just sort order.
// ============================================================================

vecDescribe('SqliteVecDialect — BL-392 distance_metric wiring (real sqlite-vec)', () => {
  it('a table created via the fixed createTableDDL computes cosine distance; a table shaped like the pre-fix DDL (no distance_metric) computes L2 — the two values diverge by more than 1.0', async () => {
    const dbPath = tempPath('distance-metric.db');
    const adapter = new SqliteAdapterImpl(dbPath);

    try {
      const raw = adapter.unwrap() as import('better-sqlite3').Database;
      const sqliteVec = require('sqlite-vec');
      sqliteVec.load(raw);

      const dialect = new SqliteVecDialect();

      // Table A: built via the FIXED createTableDDL — should emit
      // distance_metric=cosine once 2a-A lands.
      const ddlA = dialect.createTableDDL('vec_a', 'embedding', 4);
      raw.exec(ddlA);

      // Table B: the PRE-FIX DDL shape, spelled out literally — after the fix
      // there is no code path left in this codebase that ever emits this
      // string, so it must be hand-written to serve as the control.
      raw.exec(
        'CREATE VIRTUAL TABLE IF NOT EXISTS "vec_b" USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[4])',
      );

      // Matching stub `node` tables to satisfy topKQuery's JOIN.
      raw.exec('CREATE TABLE node (rowid INTEGER PRIMARY KEY, uid TEXT)');
      raw.prepare('INSERT INTO node (rowid, uid) VALUES (?, ?)').run(1, 'uid-1');

      // Insert `a` as row 1 into both tables.
      raw
        .prepare('INSERT INTO vec_a(embedding) VALUES (?)')
        .run(`[${A.join(',')}]`);
      raw
        .prepare('INSERT INTO vec_b(embedding) VALUES (?)')
        .run(`[${A.join(',')}]`);

      // Run topKQuery through the dialect (same call, same metric argument,
      // different table), stripping the __PLACEHOLDER__ join condition the
      // same way neardup.ts does.
      const queryA = dialect.topKQuery('vec_a', 'embedding', B, 1, 'cosine');
      const sqlA = queryA.sql.replace('__PLACEHOLDER__', '1=1');
      const rowA = raw.prepare(sqlA).get(...queryA.args) as {
        node_id: number;
        distance: number;
      };

      const queryB = dialect.topKQuery('vec_b', 'embedding', B, 1, 'cosine');
      const sqlB = queryB.sql.replace('__PLACEHOLDER__', '1=1');
      const rowB = raw.prepare(sqlB).get(...queryB.args) as {
        node_id: number;
        distance: number;
      };

      // Table A (fixed DDL, distance_metric=cosine) computes cosine distance.
      expect(rowA.distance).toBeCloseTo(EXPECTED_COSINE, 4);

      // Table B (pre-fix-shaped DDL, today's committed default) computes L2.
      expect(rowB.distance).toBeCloseTo(EXPECTED_L2, 4);

      // The two returned distances differ by more than 1.0 — a pure value
      // assertion (only one row, so "ordering" isn't even in play) proving
      // the metric genuinely changed what got computed, not merely how
      // results were sorted.
      expect(Math.abs(rowA.distance - rowB.distance)).toBeGreaterThan(1.0);
    } finally {
      await adapter.close();
    }
  });
});

// ============================================================================
// AC-2 (guard half): topKQuery rejects a non-cosine metric instead of
// silently ignoring it.
// ============================================================================

describe('SqliteVecDialect.topKQuery — BL-392 metric guard', () => {
  it('rejects a non-cosine metric instead of silently ignoring it', () => {
    const dialect = new SqliteVecDialect();
    expect(() =>
      dialect.topKQuery('vec_node', 'embedding', [1, 0, 0, 0], 5, 'l2'),
    ).toThrow();
    expect(() =>
      dialect.topKQuery('vec_node', 'embedding', [1, 0, 0, 0], 5, 'dot'),
    ).toThrow();
  });
});
