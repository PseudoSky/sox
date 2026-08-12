/**
 * debt-soxgraph-002.spec.ts — openDb's FTS setup routes through the
 * store-adapter A2 `ensureFtsIndex` API (DEBT-SOXGRAPH-002).
 *
 * The debt: libs/memory-core/src/db.ts:536-659 hand-rolled the FTS dialect
 * residue check + createIndexDDL via `createFTSDialect` /
 * `supportsShadowTable` (db.ts:332/:541/:564) — the last place in memory-core
 * that assembled FTS DDL/SQL above store-adapter. The fix replaces that block
 * with a single `adapter.ensureFtsIndex(...)` call. This spec pins the
 * post-fix invariants:
 *
 *   1. [red→green] The FTS5 shadow-table BACKFILL runs on reopen — the one
 *      observable ONLY the A2 path provides (the old block created the index
 *      but never backfilled pre-existing rows). A store whose FTS index was
 *      wiped (`delete-all` special command) must become searchable again
 *      after a plain reopen. Old code: reopen re-created an empty index →
 *      still not searchable → red. New code: ensureFtsIndex backfills the
 *      empty segment table → searchable → green.
 *   2. [turso] BL-461 adoption end-to-end through openDb: a store whose FTS
 *      index lives under a non-canonical name (orphan-guard repair shape,
 *      `idx_fts_node__r1`) is ADOPTED on reopen — exactly one FTS index
 *      remains, under the repaired name, never a duplicate under the
 *      canonical `idx_fts_node`.
 *   3. [source tripwire] db.ts itself no longer assembles FTS dialect
 *      machinery — the AC-6 tokens (`createFTSDialect`,
 *      `supportsShadowTable`, `fts_match(`, `fts_score(`) must not appear in
 *      db.ts source. (The DDL constant strings pass through as DATA via
 *      `opts.sqliteDDL` — they live in graph-store/schema.ts, not db.ts.)
 *
 * The sqlite tests run on real better-sqlite3; the turso tests on the real
 * @tursodatabase/database driver when present (resolved synchronously at
 * module load — see the turso-clean-room.test.ts pitfall note in
 * fts-query-parity.spec.ts).
 *
 * Gate: npx nx test memory-core --skip-nx-cache
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
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

/** The exact FTS query shape recall.ts's FTS channel delegates. */
async function searchUids(adapter: StoreAdapter, query: string): Promise<string[]> {
  const rows = await adapter.ftsSearch<{ uid: string }>(
    'node',
    ['content', 'name', 'summary'],
    query,
    { limit: 50 },
  );
  return rows.map((r) => r.uid);
}

describe('DEBT-SOXGRAPH-002 — openDb FTS setup delegates to adapter.ensureFtsIndex', () => {
  let dir: string | undefined;
  const priorAdapterEnv = process.env['STORE_ADAPTER'];

  afterEach(async () => {
    await closeAllAdapters();
    if (dir) fsSync.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
    else process.env['STORE_ADAPTER'] = priorAdapterEnv;
  });

  it('sqlite: a wiped FTS index is BACKFILLED on reopen — searchable again (only the A2 path backfills)', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'debt-002-backfill-'));
    const dbPath = path.join(dir, 'm.db');

    process.env['STORE_ADAPTER'] = 'sqlite';
    let adapter = await openDb(dbPath);
    expect(adapter.config.type).toBe('sqlite');

    // A populated row whose FTS entry we then wipe — the node row survives,
    // the FTS index content does not.
    await adapter.executeRun(
      `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
       VALUES ('n1', 'episode', 'the quick brown fox jumps over the lazy dog', 'hash-n1', datetime('now'), datetime('now'))`,
    );
    await adapter.exec(`INSERT INTO fts_node(fts_node) VALUES('delete-all')`);

    // Control: with the index wiped, the row is NOT searchable right now.
    expect(await searchUids(adapter, 'quick brown fox')).toEqual([]);

    await closeAllAdapters();

    // Reopen. The A2 ensureFtsIndex path detects the empty FTS5 segment table
    // and backfills it from `node`. The pre-delegation block (db.ts) only
    // re-created the index — no backfill — so this assertion is red on the
    // old code and green on the new: it proves the delegation.
    adapter = await openDb(dbPath);
    expect(await searchUids(adapter, 'quick brown fox')).toEqual(['n1']);
  }, 20_000);

  it('sqlite: reopen is idempotent — a healthy FTS index is not duplicated and rows stay searchable', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'debt-002-idem-'));
    const dbPath = path.join(dir, 'm.db');

    process.env['STORE_ADAPTER'] = 'sqlite';
    let adapter = await openDb(dbPath);
    await adapter.executeRun(
      `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
       VALUES ('n2', 'episode', 'distributed systems require careful tradeoffs', 'hash-n2', datetime('now'), datetime('now'))`,
    );
    expect(await searchUids(adapter, 'distributed systems')).toEqual(['n2']);

    // Close + reopen twice — every re-open must leave exactly one fts_node
    // virtual table and one set of triggers, with the row still searchable.
    await closeAllAdapters();
    adapter = await openDb(dbPath);
    await closeAllAdapters();
    adapter = await openDb(dbPath);

    const vts = await adapter.executeAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='fts_node'`,
    );
    expect(vts.rows).toHaveLength(1);
    const triggers = await adapter.executeAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'fts_node_%'`,
    );
    expect(triggers.rows).toHaveLength(3);
    expect(await searchUids(adapter, 'distributed systems')).toEqual(['n2']);
  }, 20_000);

  const tursoIt = HAS_TURSO ? it : it.skip;

  tursoIt('turso: BL-461 — a non-canonical FTS index name is adopted on reopen, never duplicated', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'debt-002-adopt-'));
    const dbPath = path.join(dir, 'm.db');

    process.env['STORE_ADAPTER'] = 'turso';
    let adapter = await openDb(dbPath); // fresh store → idx_fts_node
    expect(adapter.config.type).toBe('turso');

    // Simulate the orphan-guard repair shape (fts-orphan-guard.ts): the
    // healthy index was rebuilt under a NON-canonical name, the old one
    // dropped. Turso has no ALTER INDEX … RENAME, so this is what a repaired
    // store actually looks like.
    await adapter.exec(`DROP INDEX idx_fts_node`);
    await adapter.exec(
      `CREATE INDEX idx_fts_node__r1 ON "node" USING fts ("content", "name", "summary") WITH (weights = 'content=1.0,name=1.0,summary=1.0')`,
    );
    await closeAllAdapters();

    adapter = await openDb(dbPath);
    const idxs = await adapter.executeAll<{ name: string; sql: string }>(
      `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name='node' AND sql LIKE '%USING fts%'`,
    );
    // Adopted, not duplicated: exactly one FTS index, under the repaired name.
    expect(idxs.rows).toHaveLength(1);
    const [adoptedIdx] = idxs.rows;
    expect(adoptedIdx?.name).toBe('idx_fts_node__r1');
  }, 20_000);

  it('source: db.ts assembles no FTS dialect machinery — A2 delegation only', () => {
    const src = fsSync.readFileSync(path.join(__dirname, 'db.ts'), 'utf8');
    for (const token of ['createFTSDialect', 'supportsShadowTable', 'fts_match(', 'fts_score(']) {
      expect(src, `db.ts must not contain the hand-rolled FTS token ${token}`).not.toContain(token);
    }
  });
});
