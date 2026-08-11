/**
 * BL-507 — `ensureFtsIndex`'s Turso branch must never report `ensured: true`
 * while the Tantivy backing is incompletely materialised.
 *
 * ## Background (root-caused in .worktrees/c-fix-fts, 2026-08-11)
 *
 * A healthy Tantivy FTS index is THREE `sqlite_master` rows: the index row
 * (`idx_fts_node`), Turso's internal directory table
 * (`__turso_internal_fts_dir_idx_fts_node`) and the `_key` backing_btree
 * index (`__turso_internal_fts_dir_idx_fts_node_key`) that holds the actual
 * segments. The `_key` row is the object the sqlite3 CLI reports as
 * `malformed database schema (...) - near "USING": syntax error` — that is
 * healthy Tantivy backing, unparseable by stock SQLite (BL-329 documents the
 * same; the object must exist or the index is broken).
 *
 * The defect: `ensureFtsIndex` ran `CREATE INDEX … USING fts` and returned
 * `ensured: true` without verifying the three rows landed. Turso can report a
 * DDL success it did not perform (the orphan guard's own doc comment,
 * fts-orphan-guard.ts:264-284, says so). A half-materialised index is the
 * exact state that PANICS the process on the next `fts_match` (BL-361) —
 * before any open-time guard can run. The fix verifies the materialisation
 * after create and repairs it in-session (DROP + CREATE removes and rebuilds
 * all three rows — measured), throwing a typed error if the retry still
 * lands incomplete.
 *
 * ## RED→GREEN (BL-225)
 *
 * The red arm needs a store whose index row exists but whose backing is
 * missing, reaching `ensureFtsIndex` in a session where the connect-time
 * orphan guard (BL-461) has already run. Real turso cannot produce that state
 * deterministically (sqlite_master is write-protected through the adapter,
 * and schema edits from other connections are invisible to an open
 * connection), so the test damages the store out-of-band (better-sqlite3 +
 * writable_schema, the documented escape hatch) and reopens it with a
 * **read-only connect** — under which the orphan guard detects but does NOT
 * repair. The underlying driver handle is then re-wrapped in a writable
 * `TursoAdapterImpl` (private constructor; the read-only open's driver
 * connection is already writable — `allowFtsInReadonly`) so `ensureFtsIndex`
 * can run against the damaged state without the guard re-running.
 *
 * - RED: against the pre-fix code, `ensureFtsIndex` returns `ensured: true`
 *   with the backing still missing — the test's "backing complete" assertion
 *   fails.
 * - GREEN: the fix detects the missing `_key` row, DROP+CREATEs the index,
 *   and leaves a complete materialisation.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { TursoAdapterImpl } from './turso-adapter.js';
import { ensureFtsIndex } from './fts-ops.js';

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

const FTS_COLUMNS = ['content', 'name', 'summary'];

/** Delete sqlite_master rows out-of-band (better-sqlite3 + writable_schema —
 *  the documented escape hatch from preflight.ts:189-200). */
function deleteMasterRowsOutOfBand(dbPath: string, names: string[]): void {
  const Database = require('better-sqlite3') as new (p: string) => {
    unsafeMode(v: boolean): void;
    pragma(v: string): void;
    prepare(sql: string): { run(...args: unknown[]): { changes: number } };
    close(): void;
  };
  const db = new Database(dbPath);
  db.unsafeMode(true);
  db.pragma('writable_schema = ON');
  const del = db.prepare('DELETE FROM sqlite_master WHERE name = ?');
  for (const n of names) del.run(n);
  db.pragma('writable_schema = RESET');
  db.close();
}

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-bl507-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

tursoDescribe('BL-507 — Turso FTS backing verification in ensureFtsIndex', () => {
  it('reports ensured only with a complete Tantivy materialisation (3/3 rows)', async () => {
    const dbPath = join(tmpDir, `healthy-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
    const adapter = await TursoAdapterImpl.connect({ dbPath });
    try {
      await adapter.exec(
        'CREATE TABLE node (rowid INTEGER PRIMARY KEY, content TEXT, name TEXT, summary TEXT)',
      );
      const res = await ensureFtsIndex(adapter, 'node', FTS_COLUMNS, {
        weights: { content: 1.0, name: 1.0, summary: 1.0 },
      });
      expect(res.ensured).toBe(true);
      const { rows } = await adapter.executeAll<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE name IN (?, ?, ?)`,
        ['idx_fts_node', '__turso_internal_fts_dir_idx_fts_node', '__turso_internal_fts_dir_idx_fts_node_key'],
      );
      const got = rows.map((r) => r.name).sort();
      expect(got).toEqual(
        ['__turso_internal_fts_dir_idx_fts_node', '__turso_internal_fts_dir_idx_fts_node_key', 'idx_fts_node'].sort(),
      );
      // And the index actually searches (healthy, not a zombie).
      const hits = await adapter.ftsSearch('node', FTS_COLUMNS, 'probe');
      expect(hits).toEqual([]);
    } finally {
      await adapter.close();
    }
  }, 20000);

  it('RED→GREEN: re-ensure after in-session backing damage repairs the index (never ensured-with-missing-backing)', async () => {
    const dbPath = join(tmpDir, `damaged-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);

    // 1. Build a healthy index through a normal (guarded) connect.
    let adapter = await TursoAdapterImpl.connect({ dbPath });
    try {
      await adapter.exec(
        'CREATE TABLE node (rowid INTEGER PRIMARY KEY, content TEXT, name TEXT, summary TEXT)',
      );
      const res = await ensureFtsIndex(adapter, 'node', FTS_COLUMNS, {
        weights: { content: 1.0, name: 1.0, summary: 1.0 },
      });
      expect(res.ensured).toBe(true);
    } finally {
      await adapter.close();
    }

    // 2. Damage: delete the `_key` backing index out-of-band — the index row
    //    survives, the segments row does not. This is the BL-361 panic shape.
    deleteMasterRowsOutOfBand(dbPath, ['__turso_internal_fts_dir_idx_fts_node_key']);

    // 3. Reopen READ-ONLY so the connect-time orphan guard (BL-461) detects
    //    but does not repair, then re-wrap the (already-writable) driver
    //    handle in a writable adapter without re-running the guard. This is
    //    the only deterministic way to hand `ensureFtsIndex` the damaged
    //    state — real turso engine throughout, no mocks.
    const readOnly = await TursoAdapterImpl.connect({ dbPath, readonly: true, allowFtsInReadonly: true });
    try {
      const raw = readOnly.unwrap();
      const writable = new (TursoAdapterImpl as unknown as new (
        db: unknown,
        config: unknown,
        capabilities: unknown,
      ) => TursoAdapterImpl)(raw, { type: 'turso', dbPath, readonly: false }, readOnly.capabilities);

      const res = await ensureFtsIndex(writable, 'node', FTS_COLUMNS, {
        weights: { content: 1.0, name: 1.0, summary: 1.0 },
      });
      expect(res.ensured).toBe(true);

      // GREEN: the fix must leave a COMPLETE materialisation — the missing
      // `_key` row was rebuilt, so a search against it cannot panic.
      const { rows } = await writable.executeAll<{ name: string }>(
        `SELECT name FROM sqlite_master WHERE name IN (?, ?, ?)`,
        ['idx_fts_node', '__turso_internal_fts_dir_idx_fts_node', '__turso_internal_fts_dir_idx_fts_node_key'],
      );
      const got = rows.map((r) => r.name).sort();
      expect(got).toEqual(
        ['__turso_internal_fts_dir_idx_fts_node', '__turso_internal_fts_dir_idx_fts_node_key', 'idx_fts_node'].sort(),
      );
    } finally {
      await readOnly.close();
    }
  }, 30000);
});
