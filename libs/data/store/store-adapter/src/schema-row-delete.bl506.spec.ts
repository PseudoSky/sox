/**
 * BL-506 — the two escape-hatch primitives the FK-heal is built on:
 * `deleteSchemaRowsViaBetterSqlite3` (out-of-band `sqlite_master` row
 * deletion) and `withConnectionClosedForRepair` (same-instance close → fn →
 * full-ceremony reopen). Both are new in this packet; these tests pin their
 * contracts so graph-store's heal can rely on them.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { TursoAdapterImpl } from './turso-adapter.js';
import { deleteSchemaRowsViaBetterSqlite3 } from './preflight.js';

const require = createRequire(import.meta.url);

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();
const tursoDescribe = hasTurso ? describe : describe.skip;

const FTS5_RESIDUE = [
  'fts_node',
  'fts_node_data',
  'fts_node_idx',
  'fts_node_docsize',
  'fts_node_config',
  'fts_node_ai',
  'fts_node_ad',
  'fts_node_au',
];

/** Build a store carrying the SQLite-era fts5 residue (via better-sqlite3,
 *  which has FTS5 compiled in) plus a real user table. */
function buildResidueStore(dbPath: string): void {
  const Database = require('better-sqlite3') as new (p: string) => {
    exec(sql: string): void;
    prepare(sql: string): { run(...args: unknown[]): void };
    close(): void;
  };
  const db = new Database(dbPath);
  db.exec('CREATE TABLE node (rowid INTEGER PRIMARY KEY, uid TEXT, content TEXT)');
  db.exec(`CREATE VIRTUAL TABLE fts_node USING fts5(content,
    content='node', content_rowid='rowid', tokenize='unicode61')`);
  db.exec(`CREATE TRIGGER fts_node_ai AFTER INSERT ON node BEGIN
INSERT INTO fts_node (rowid, content) VALUES (new.rowid, new.content);
END`);
  db.exec(`CREATE TRIGGER fts_node_ad AFTER DELETE ON node BEGIN
INSERT INTO fts_node (fts_node, rowid, content) VALUES ('delete', old.rowid, old.content);
END`);
  db.exec(`CREATE TRIGGER fts_node_au AFTER UPDATE ON node BEGIN
INSERT INTO fts_node (fts_node, rowid, content) VALUES ('delete', old.rowid, old.content);
INSERT INTO fts_node (rowid, content) VALUES (new.rowid, new.content);
END`);
  db.prepare('INSERT INTO node (uid, content) VALUES (?, ?)').run('u1', 'hello world');
  db.close();
}

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-bl506-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('BL-506 — deleteSchemaRowsViaBetterSqlite3 (out-of-band sqlite_master deletion)', () => {
  it('deletes the named rows for real and reports exactly what it dropped', () => {
    const dbPath = join(tmpDir, `delete-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    buildResidueStore(dbPath);

    const result = deleteSchemaRowsViaBetterSqlite3(dbPath, FTS5_RESIDUE);
    expect(result.failed).toBeNull();
    expect([...result.dropped].sort()).toEqual([...FTS5_RESIDUE].sort());

    const Database = require('better-sqlite3') as new (p: string) => {
      prepare(sql: string): { all(): Array<{ name: string }> };
      close(): void;
    };
    const db = new Database(dbPath);
    const remaining = db.prepare('SELECT name FROM sqlite_master').all();
    expect(remaining.filter((r) => FTS5_RESIDUE.includes(r.name))).toEqual([]);
    db.close();
  });

  it('is best-effort: names that do not exist are skipped, never an error', () => {
    const dbPath = join(tmpDir, `partial-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    buildResidueStore(dbPath);

    const result = deleteSchemaRowsViaBetterSqlite3(dbPath, [...FTS5_RESIDUE, 'never_existed', 'also_not_there']);
    expect(result.failed).toBeNull();
    expect(result.dropped.length).toBe(FTS5_RESIDUE.length);
  });

  it('never throws: an unopenable file degrades to { failed }', () => {
    // better-sqlite3 auto-CREATES a missing file at a valid path, so the
    // unopenable case is a path in a directory that does not exist.
    const result = deleteSchemaRowsViaBetterSqlite3(
      join(tmpDir, 'no-such-dir', 'x.db'),
      FTS5_RESIDUE,
    );
    expect(result.dropped).toEqual([]);
    expect(result.failed).not.toBeNull();
  });
});

tursoDescribe('BL-506 — withConnectionClosedForRepair (same-instance reconnect)', () => {
  it('closes the connection around fn, reopens on the SAME instance, and the caller handle stays valid', async () => {
    const dbPath = join(tmpDir, `reopen-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    const adapter = await TursoAdapterImpl.connect({ dbPath });
    try {
      await adapter.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
      await adapter.executeRun('INSERT INTO t (v) VALUES (?)', ['a']);

      let fnRan = false;
      await adapter.withConnectionClosedForRepair(async () => {
        fnRan = true;
        // During fn the connection must be CLOSED — the whole point (a
        // better-sqlite3 write must never race an open turso connection).
        await expect(adapter.executeGet('SELECT 1 AS one')).rejects.toThrow();

        // Out-of-band repair while no turso connection holds the file:
        const Database = require('better-sqlite3') as new (p: string) => {
          exec(sql: string): void;
          close(): void;
        };
        const db = new Database(dbPath);
        db.exec('CREATE TABLE oob (x INTEGER)');
        db.exec('INSERT INTO oob VALUES (42)');
        db.close();
      });
      expect(fnRan).toBe(true);

      // The SAME instance is live again and sees the out-of-band change:
      const oob = await adapter.executeGet<{ x: number }>('SELECT x FROM oob');
      expect(oob?.x).toBe(42);
      const v = await adapter.executeGet<{ v: string }>('SELECT v FROM t');
      expect(v?.v).toBe('a');
    } finally {
      await adapter.close();
    }
  }, 30000);
});
