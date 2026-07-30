/**
 * db-fts5-residue-turso.spec.ts — Turso FTS5-residue cleanup regression.
 *
 * A store migrated in place from better-sqlite3 (SQLite FTS5) to Turso keeps
 * the old `fts_node` virtual table, its four shadow tables
 * (`fts_node_data`/`_idx`/`_docsize`/`_config`), and the three content-sync
 * triggers (`fts_node_ai`/`_ad`/`_au`). Turso has no fts5 module
 * (`capabilities.fts5 === false`) — `fts_node` is permanently unreadable, and
 * the triggers fire on every INSERT/UPDATE/DELETE against `node`, referencing
 * a table Turso cannot resolve. `openDb()` on the turso branch must detect
 * this residue and remove it via better-sqlite3 (which has fts5 compiled in),
 * leaving only the Tantivy `idx_fts_node` index in its place.
 *
 * This spec builds a realistic pre-migration store (real DDL_BASE + FTS_DDL +
 * FTS_TRIGGERS, exactly what a store looked like before being pointed at
 * Turso), forces STORE_ADAPTER=turso, and asserts:
 *   1. fts_node + all four shadow tables are gone after openDb().
 *   2. The three content-sync triggers are gone after openDb().
 *   3. A plain INSERT INTO node succeeds afterward (the triggers no longer
 *      fire and reference a table that doesn't exist).
 *
 * Gate: npx nx test memory-core --skip-nx-cache
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { PRAGMAS, DDL_BASE, FTS_DDL, FTS_TRIGGERS } from './schema.js';
import { openDb, closeAllAdapters } from './db.js';

/** Build a pre-Turso-migration store: real DDL_BASE + FTS5 table + triggers. */
function buildLegacySqliteFts5Store(dbPath: string): void {
  const db = new Database(dbPath);
  try {
    for (const line of PRAGMAS.trim().split('\n').filter(Boolean)) {
      db.exec(line);
    }
    db.exec(DDL_BASE);
    db.exec(FTS_DDL);
    db.exec(FTS_TRIGGERS);
    db.exec(
      `INSERT INTO node (uid, kind, content, name, summary, content_hash, t_created, t_valid)
       VALUES ('legacy-1', 'episode', 'pre-migration content', 'n', 's', 'hash-legacy-1', datetime('now'), datetime('now'))`,
    );
  } finally {
    db.close();
  }
}

describe('BL — Turso FTS5 residue cleanup (openDb on a store migrated from sqlite)', () => {
  let dir: string | undefined;
  const priorAdapterEnv = process.env['STORE_ADAPTER'];

  afterEach(async () => {
    await closeAllAdapters();
    if (dir) fsSync.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
    else process.env['STORE_ADAPTER'] = priorAdapterEnv;
  });

  it('drops fts_node, its four shadow tables, and the three sync triggers; leaves writes working', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'bl-fts-residue-'));
    const dbPath = path.join(dir, 'm.db');
    buildLegacySqliteFts5Store(dbPath);

    // Sanity: the legacy artifacts really are present before openDb() touches them.
    const preCheck = new Database(dbPath, { readonly: true });
    const preRows = preCheck
      .prepare(
        `SELECT name, type FROM sqlite_master
         WHERE name LIKE 'fts_node%' OR name IN ('fts_node_ai','fts_node_ad','fts_node_au')`,
      )
      .all() as { name: string; type: string }[];
    preCheck.close();
    expect(preRows.length).toBeGreaterThanOrEqual(1 + 4 + 3); // fts_node + 4 shadow tables + 3 triggers

    process.env['STORE_ADAPTER'] = 'turso';
    const adapter = await openDb(dbPath);
    expect(adapter.config.type).toBe('turso');

    const residueAfter = await adapter.executeAll<{ name: string; type: string }>(
      `SELECT name, type FROM sqlite_master
       WHERE name LIKE 'fts_node%' OR name IN ('fts_node_ai','fts_node_ad','fts_node_au')`,
    );
    expect(residueAfter.rows).toEqual([]);

    // The legacy row survives the migration (DROP TABLE only removed fts_node,
    // never touched `node`).
    const legacyRow = await adapter.executeGet<{ uid: string }>(
      `SELECT uid FROM node WHERE uid = 'legacy-1'`,
    );
    expect(legacyRow?.uid).toBe('legacy-1');

    // A fresh INSERT must succeed — before the fix, the stale triggers fired
    // on every INSERT and referenced a table Turso cannot resolve.
    await expect(
      adapter.executeRun(
        `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
         VALUES ('post-migration-1', 'episode', 'post-migration content', 'hash-post-1', datetime('now'), datetime('now'))`,
      ),
    ).resolves.toBeDefined();
  }, 20_000);

  it('is idempotent — a store with no FTS5 residue is left untouched', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'bl-fts-residue-clean-'));
    const dbPath = path.join(dir, 'm.db');

    process.env['STORE_ADAPTER'] = 'turso';
    // A fresh Turso-native store never had FTS5 artifacts to begin with.
    const adapter = await openDb(dbPath);
    expect(adapter.config.type).toBe('turso');

    const residue = await adapter.executeAll<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE name LIKE 'fts_node%'`,
    );
    expect(residue.rows).toEqual([]);
  }, 20_000);
});
