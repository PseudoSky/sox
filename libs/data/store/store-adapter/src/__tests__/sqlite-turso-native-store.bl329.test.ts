/**
 * BL-329 — a Turso FTS index permanently blocks EVERY better-sqlite3
 * fallback path, with an opaque failure.
 *
 * Opening a Turso-native store (one that carries a Tantivy-backed FTS
 * index, `CREATE INDEX ... USING fts (...)`) with better-sqlite3 fails —
 * NOT at `new Database(path)` (that always succeeds; better-sqlite3 doesn't
 * parse the schema at connect time), but on the first statement that
 * touches `sqlite_master` (which is effectively any statement, since
 * SQLite parses every CREATE statement's SQL text to build the in-memory
 * schema before running anything):
 *
 *   SqliteError: malformed database schema (__turso_internal_fts_dir_idx_fts_node_key)
 *     - near "USING": syntax error
 *
 * This is not corruption — it's the wrong driver for the store's content —
 * but the message names an internal Tantivy directory object as if it were
 * generic schema damage, which has already cost real debugging time (a
 * `tools/baseline-capture` WAL-checkpoint helper hit exactly this against
 * the live store, hardcoded to `createSqliteAdapter`).
 *
 * `SqliteAdapterImpl`'s constructor now probes for this at OPEN time (one
 * cheap `sqlite_master` read) and converts it into `ETursoNativeStore` — a
 * typed, store-path-carrying error whose `.message` deliberately does NOT
 * contain the opaque `__turso_internal_...` text.
 */
import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { TursoAdapterImpl } from '../turso-adapter.js';
import { SqliteAdapterImpl } from '../sqlite-adapter.js';
import { ETursoNativeStore, isTursoNativeStoreSchemaError } from '../errors.js';
import { createSqliteAdapter } from '../factory.js';

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();

const tursoDescribe = hasTurso ? describe : describe.skip;

let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'store-adapter-bl329-'));
});

function tempPath(label: string): string {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return join(tmpDir, `${label}-${suffix}.db`);
}

const openAdapters: Array<{ close: () => Promise<void> | void }> = [];

afterEach(async () => {
  while (openAdapters.length > 0) {
    const a = openAdapters.pop()!;
    try {
      await a.close();
    } catch {
      // already closed
    }
  }
});

async function seedTursoNativeStore(dbPath: string): Promise<void> {
  const w = await TursoAdapterImpl.connect({ dbPath });
  await w.exec('CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT)');
  await w.executeRun('INSERT INTO node (id, content) VALUES (?, ?)', [1, 'hello world']);
  // The Tantivy-backed FTS index — this is what better-sqlite3 cannot parse.
  await w.exec('CREATE INDEX IF NOT EXISTS idx_fts_node ON "node" USING fts ("content")');
  await w.close();
}

/**
 * (BL-508) Strip the engine marker (application_id + `_sox_engine` row) so a
 * seeded store exercises the BL-329 SCHEMA-PROBE refusal path (which carries
 * the raw driver `cause`) rather than the marker refusal (which fires before
 * any driver error exists). The marker refusal path is covered separately by
 * the BL-508 suite (engine-guard.bl508.test.ts).
 */
async function wipeEngineMarker(dbPath: string): Promise<void> {
  const Database = (await import('better-sqlite3')).default;
  const db = new Database(dbPath);
  try {
    db.pragma('application_id = 0'); // reset the fast-path marker (BL-508)
    db.unsafeMode(true);
    db.pragma('writable_schema = ON');
    db.prepare('DELETE FROM _sox_engine').run();
    db.pragma('writable_schema = RESET');
  } finally {
    db.close();
  }
}

tursoDescribe('BL-329 — SqliteAdapterImpl vs a Turso-native store', () => {
  it('RAW repro (proves the underlying claim): better-sqlite3 opens the file fine, but the first schema-touching query throws the opaque message', async () => {
    const dbPath = tempPath('raw-repro');
    await seedTursoNativeStore(dbPath);

    const Database = (await import('better-sqlite3')).default;
    // Bypass SqliteAdapterImpl entirely — this is the pre-fix, unguarded path.
    const raw = new Database(dbPath);
    try {
      expect(() => raw.prepare('SELECT name FROM sqlite_master LIMIT 1').get()).toThrow(
        /malformed database schema \(__turso_internal_/,
      );
    } finally {
      raw.close();
    }
  });

  it('GREEN: SqliteAdapterImpl(dbPath) throws a typed ETursoNativeStore instead of letting the open silently "succeed" and fail later', async () => {
    const dbPath = tempPath('typed-error');
    await seedTursoNativeStore(dbPath);
    await wipeEngineMarker(dbPath); // BL-508: unmarked → BL-329 schema-probe path

    let caught: unknown;
    try {
      new SqliteAdapterImpl(dbPath);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(ETursoNativeStore);
    const typed = caught as ETursoNativeStore;
    expect(typed.code).toBe('E_TURSO_NATIVE_STORE');
    expect(typed.dbPath).toBe(dbPath);
    // The store path IS carried on the error.
    expect(typed.message).toContain(dbPath);
    // Explains what's actually wrong, in plain terms.
    expect(typed.message).toMatch(/Turso-native store/i);
    expect(typed.message).toMatch(/better-sqlite3 cannot open it/i);

    // The opaque driver phrasing must NOT reach the caller via .message —
    // specifically the "malformed database schema" framing (which wrongly
    // implies corruption) and the exact generated internal object name the
    // raw driver error named (e.g. "idx_fts_node_key"), which is meaningless
    // to a caller who doesn't already know Turso's internal naming scheme.
    expect(typed.message).not.toContain('malformed database schema');
    expect(typed.message).not.toMatch(/__turso_internal_fts_dir_idx_fts_node_key/);

    // The raw driver error is still available for a caller that wants it —
    // just not surfaced by default.
    expect(typed.cause).toBeDefined();
    expect(isTursoNativeStoreSchemaError(typed.cause)).toBe(true);
  });

  it('createSqliteAdapter({dbPath}) — the actual fallback-path entrypoint — surfaces the same typed error', async () => {
    const dbPath = tempPath('factory-entrypoint');
    await seedTursoNativeStore(dbPath);

    expect(() => createSqliteAdapter({ dbPath })).toThrow(ETursoNativeStore);
  });

  it('a normal, non-Turso-native SQLite store is unaffected — no false positive', async () => {
    const dbPath = tempPath('plain-sqlite');
    const adapter = createSqliteAdapter({ dbPath });
    openAdapters.push({ close: () => adapter.close() });

    await adapter.exec('CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT)');
    await adapter.executeRun('INSERT INTO node (id, content) VALUES (?, ?)', [1, 'hello world']);
    const rows = await adapter.executeAll<{ id: number }>('SELECT id FROM node');
    expect(rows.rows).toEqual([{ id: 1 }]);
  });
});
