/**
 * fts-query-parity.spec.ts — end-to-end FTS correctness, both backends,
 * exercised through the exact query shape `recall.ts`'s FTS channel builds
 * (createFTSDialect + matchClause/scoreClause + supportsShadowTable branch).
 *
 * WHY THIS FILE EXISTS (FTS consolidation, 2026-07-30):
 * db-fts5-residue-turso.spec.ts already proves residue cleanup makes a
 * migrated store WRITABLE again, but nothing previously proved a fresh store
 * of either backend actually RETURNS CORRECT SEARCH RESULTS end-to-end —
 * `idx_fts_node` not existing (defect #1) or the match/score clauses being
 * wrong would both be invisible to a residue-only test. This file is the
 * red→green gate for that:
 *
 *   1. A fresh SQLite store gets `fts_node` (+ its 4 shadow tables + 3
 *      triggers) on open, and `fts_node MATCH ?` (as recall.ts builds it via
 *      the dialect) returns the right rows, ranked, and excludes non-matches.
 *   2. A fresh Turso store gets `idx_fts_node` on open (requires
 *      TursoAdapterImpl.connect() to pass `experimental: ['index_method']`
 *      — root-caused 2026-07-30, see fts-dialect.ts's module doc), and
 *      `fts_match(...)` — bound-parameter form, as recall.ts now builds it —
 *      returns the right rows via `fts_score` ranking.
 *   3. A store carrying SQLite FTS5 residue, opened on Turso, is cleaned by
 *      openDb() (db-fts5-residue-turso.spec.ts already covers this in
 *      detail; repeated here narrowly to prove the query ALSO works
 *      afterward, not just that residue is gone and writes succeed).
 *
 * Turso tests resolve availability SYNCHRONOUSLY at module load (matches the
 * documented pitfall in turso-clean-room.test.ts — an async `beforeAll` +
 * `{ skip }` option is evaluated before the flag is set and always skips).
 *
 * Gate: npx nx test memory-core --skip-nx-cache
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { PRAGMAS, DDL_BASE, FTS_DDL, FTS_TRIGGERS } from './schema.js';
import { openDb, closeAllAdapters } from './db.js';

// ── Turso availability — resolved SYNCHRONOUSLY at module load ─────────────
// (see turso-clean-room.test.ts's file header for why this must not be an
// async beforeAll + `{ skip }` pattern.)
const TURSO_DRIVER_PATH = path.resolve(
  __dirname,
  '../../../node_modules/@tursodatabase/database/dist/promise.js',
);
const HAS_TURSO = (() => {
  try {
    return fsSync.existsSync(TURSO_DRIVER_PATH);
  } catch {
    return false;
  }
})();

const NODES = [
  { uid: 'n1', content: 'The application server experienced high CPU load during peak hours.' },
  { uid: 'n2', content: 'Distributed systems require careful consideration of CAP theorem tradeoffs.' },
  { uid: 'n3', content: 'The new API gateway improved throughput by 40 percent across all services.' },
];

async function insertNodes(adapter: StoreAdapter): Promise<void> {
  for (const n of NODES) {
    await adapter.executeRun(
      `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
       VALUES (?, 'episode', ?, ?, datetime('now'), datetime('now'))`,
      [n.uid, n.content, `hash-${n.uid}`],
    );
  }
}

/** Run the exact FTS query shape recall.ts's federatedRecall builds. */
async function runFtsQuery(
  adapter: StoreAdapter,
  query: string,
): Promise<{ uid: string }[]> {
  const { createFTSDialect } = await import('@adhd/sox-store-adapter');
  const ftsDialect = createFTSDialect(adapter.config.type);
  const { sql: matchSql } = ftsDialect.matchClause(['content', 'name', 'summary'], '?');
  const scoreExpr = ftsDialect.scoreClause(['content', 'name', 'summary'], '?');

  if (ftsDialect.supportsShadowTable) {
    const result = await adapter.executeAll<{ uid: string }>(
      `SELECT n.uid
       FROM fts_node
       JOIN node n ON n.rowid = fts_node.rowid
       WHERE ${matchSql}
       ORDER BY ${scoreExpr}`,
      [query],
    );
    return result.rows;
  }
  const result = await adapter.executeAll<{ uid: string }>(
    `SELECT uid, ${scoreExpr} AS rank FROM node
     WHERE ${matchSql}
     ORDER BY rank`,
    [query, query],
  );
  return result.rows;
}

describe('FTS query parity — dialect-driven query returns correct results, both backends', () => {
  let dir: string | undefined;
  const priorAdapterEnv = process.env['STORE_ADAPTER'];

  afterEach(async () => {
    await closeAllAdapters();
    if (dir) fsSync.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
    else process.env['STORE_ADAPTER'] = priorAdapterEnv;
  });

  it('SQLite: fresh store gets fts_node + triggers, MATCH returns correct rows', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'fts-parity-sqlite-'));
    const dbPath = path.join(dir, 'm.db');

    process.env['STORE_ADAPTER'] = 'sqlite';
    const adapter = await openDb(dbPath);
    expect(adapter.config.type).toBe('sqlite');

    // Schema assertions — the actual fix, not an assumption.
    const schema = await adapter.executeAll<{ name: string; type: string }>(
      `SELECT name, type FROM sqlite_master WHERE name LIKE 'fts_node%'`,
    );
    const names = schema.rows.map((r) => r.name);
    expect(names).toEqual(
      expect.arrayContaining(['fts_node', 'fts_node_data', 'fts_node_idx', 'fts_node_docsize', 'fts_node_config']),
    );
    const triggers = await adapter.executeAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'fts_node_%'`,
    );
    expect(triggers.rows.map((r) => r.name).sort()).toEqual(['fts_node_ad', 'fts_node_ai', 'fts_node_au']);

    await insertNodes(adapter);
    // FTS5 is an external-content table — backfill via the 'rebuild' special
    // command (db.ts does not auto-backfill pre-existing rows on open; these
    // rows are inserted AFTER open, so the AFTER INSERT trigger syncs them
    // live — no rebuild needed here, this call would be redundant, kept out
    // deliberately to prove the trigger path itself, not a manual rebuild).

    const cpuResults = await runFtsQuery(adapter, 'CPU load');
    expect(cpuResults.map((r) => r.uid)).toEqual(['n1']);

    const distResults = await runFtsQuery(adapter, 'distributed systems');
    expect(distResults.map((r) => r.uid)).toEqual(['n2']);

    const noResults = await runFtsQuery(adapter, 'nonexistentxyzterm');
    expect(noResults).toEqual([]);
  }, 20_000);

  const tursoIt = HAS_TURSO ? it : it.skip;

  tursoIt('Turso: fresh store gets idx_fts_node, fts_match returns correct rows', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'fts-parity-turso-'));
    const dbPath = path.join(dir, 'm.db');

    process.env['STORE_ADAPTER'] = 'turso';
    const adapter = await openDb(dbPath);
    expect(adapter.config.type).toBe('turso');

    // Schema assertion — the actual fix for defect #1: idx_fts_node must
    // exist. This is the exact assertion that would have caught the live
    // bug (CREATE INDEX ... USING fts silently failing without
    // `experimental: ['index_method']` on the connection).
    const schema = await adapter.executeAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_fts_node'`,
    );
    expect(schema.rows.length, 'idx_fts_node must exist on a fresh Turso store').toBe(1);
    // No FTS5 residue on a store that never had SQLite history.
    const ftsNode = await adapter.executeAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE name = 'fts_node'`,
    );
    expect(ftsNode.rows).toEqual([]);

    await insertNodes(adapter);

    const cpuResults = await runFtsQuery(adapter, 'CPU load');
    expect(cpuResults.map((r) => r.uid)).toEqual(['n1']);

    const distResults = await runFtsQuery(adapter, 'distributed systems');
    expect(distResults.map((r) => r.uid)).toEqual(['n2']);

    const noResults = await runFtsQuery(adapter, 'nonexistentxyzterm');
    expect(noResults).toEqual([]);
  }, 20_000);

  tursoIt(
    'Turso: a store migrated from SQLite (FTS5 residue) is cleaned and fts_match still works',
    async () => {
      dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'fts-parity-migrated-'));
      const dbPath = path.join(dir, 'm.db');

      // Build a realistic pre-migration store: real DDL_BASE + FTS5 + triggers,
      // exactly what a store looked like before being pointed at Turso.
      // Lazy import: better-sqlite3 is a lazy-loaded library — a static import
      // is forbidden by lint (it must not be pulled into the module graph eagerly).
      const { default: Database } = await import('better-sqlite3');
      const legacy = new Database(dbPath);
      try {
        for (const line of PRAGMAS.trim().split('\n').filter(Boolean)) legacy.exec(line);
        legacy.exec(DDL_BASE);
        legacy.exec(FTS_DDL);
        legacy.exec(FTS_TRIGGERS);
        legacy.exec(
          `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
           VALUES ('legacy-1', 'episode', 'legacy pre-migration content about CPU load', 'hash-legacy-1', datetime('now'), datetime('now'))`,
        );
      } finally {
        legacy.close();
      }

      process.env['STORE_ADAPTER'] = 'turso';
      const adapter = await openDb(dbPath);
      expect(adapter.config.type).toBe('turso');

      // Residue is gone (db-fts5-residue-turso.spec.ts covers this in depth;
      // asserted narrowly here as a precondition for the query test below).
      const residue = await adapter.executeAll<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE name LIKE 'fts_node%'`,
      );
      expect(residue.rows).toEqual([]);

      // The real index exists and a NEW write is queryable end-to-end.
      const idx = await adapter.executeAll<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_fts_node'`,
      );
      expect(idx.rows.length).toBe(1);

      await insertNodes(adapter);
      const cpuResults = await runFtsQuery(adapter, 'CPU load');
      // Both the surviving legacy row and the new n1 row mention CPU load.
      expect(cpuResults.map((r) => r.uid).sort()).toEqual(['legacy-1', 'n1']);
    },
    20_000,
  );
});
