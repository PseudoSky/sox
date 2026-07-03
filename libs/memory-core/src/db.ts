/**
 * Database connection factory for sox-memory.
 * Opens a SQLite database with WAL mode, loads sqlite-vec extension,
 * applies schema DDL (idempotent), and returns a ready-to-use Database.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { PRAGMAS, DDL, FTS_TRIGGERS } from './schema.js';
import { EMBED_DIM, getActiveEmbedModel } from './embed.js';

export type ScopeKind = 'project' | 'user' | 'org' | 'local';

/**
 * Expand a leading `~`/`~/` in a db_path to the user's home directory (BL-41).
 *
 * This is THE single canonical db_path expander for sox-memory. It is applied at
 * every file-create sink (openDb, openDbReadOnly, the daemon constructor) so the
 * literal string the skill docs show — `db_path: "~/.memory/memory.db"` — resolves
 * to `$HOME/.memory/memory.db` and NEVER creates a literal `~` directory relative
 * to cwd. Idempotent: a path without a leading `~` is returned unchanged.
 *
 * It must stay byte-for-byte consistent with the memory-server permission guard's
 * `expandTilde` (members/memory-server/src/index.ts) so the allowlist check and the
 * actual open agree on the resolved path ([ref:guard-before-sink]).
 */
export function expandDbPath(dbPath: string): string {
  if (dbPath === '~') return os.homedir();
  if (dbPath.startsWith('~/')) return path.join(os.homedir(), dbPath.slice(2));
  return dbPath;
}

export interface MemoryScope {
  scope: ScopeKind;
  scope_id: string;
  embed_model: string;
  embed_dim: number;
  schema_ver: number;
  created_at: string;
}

/**
 * Open (or create) a memory database at the given path.
 * Applies pragmas, loads sqlite-vec, creates schema if missing.
 * Returns a connected Database instance.
 */
export function openDb(dbPath: string): Database.Database {
  // BL-41: expand a leading ~ to $HOME at the file-create sink so every caller —
  // regardless of whether it expanded — opens the real path, never a literal `~` dir.
  dbPath = expandDbPath(dbPath);

  // Ensure parent directory exists
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  const db = new Database(dbPath);

  // Load sqlite-vec extension
  sqliteVec.load(db);

  // Apply pragmas
  for (const pragma of PRAGMAS.trim().split('\n').filter(Boolean)) {
    const line = pragma.trim();
    if (line) db.exec(line);
  }

  // Apply DDL (idempotent — uses CREATE IF NOT EXISTS)
  db.exec(DDL);
  db.exec(FTS_TRIGGERS);

  // Idempotent column migrations for pre-existing stores (CREATE IF NOT EXISTS won't
  // add columns to a table that already exists). Add new columns when missing.
  migrateAddColumn(db, 'node', 'meta', 'TEXT');
  // P1 enrichment columns (D3.1) — all NULL-defaulting, idempotent.
  migrateAddColumn(db, 'node', 'tags', 'TEXT');
  migrateAddColumn(db, 'node', 'topic', 'TEXT');
  migrateAddColumn(db, 'node', 'project_path', 'TEXT');
  migrateAddColumn(db, 'node', 'enrich_ver', 'TEXT');
  // memory_update timestamp (set on every in-place edit; immutable t_created is the audit anchor).
  migrateAddColumn(db, 'node', 't_updated', 'TEXT');
  // D3.4 partial indices for enrichment columns
  db.exec(`CREATE INDEX IF NOT EXISTS ix_node_topic      ON node(topic)        WHERE topic IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS ix_node_project    ON node(project_path) WHERE project_path IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS ix_node_enrich_ver ON node(enrich_ver)   WHERE enrich_ver IS NOT NULL`);

  // Idempotent migration: add 'enrich' to the organizer_queue CHECK constraint if
  // the existing table was created before the 'enrich' op was added (BL-27 LOW-4).
  // SQLite does not support ALTER TABLE ... MODIFY CONSTRAINT, so we must:
  //   1. Detect whether the current CHECK is stale (does NOT include 'enrich').
  //   2. If stale, do the safe rebuild dance inside a transaction:
  //      rename → create-new → copy → drop-old → recreate index.
  // This is a no-op on fresh stores (the DDL already contains 'enrich').
  migrateOrganizerQueueCheckConstraint(db);

  return db;
}

/**
 * Idempotently add 'enrich' to the organizer_queue CHECK constraint.
 *
 * SQLite cannot ALTER TABLE to change a CHECK, so we rename + recreate.
 * Safe to call multiple times: exits immediately if the constraint already
 * includes 'enrich' or if the table doesn't exist.
 */
function migrateOrganizerQueueCheckConstraint(db: Database.Database): void {
  // Check if the table exists first.
  const tableExists = db
    .prepare<[], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='organizer_queue'`,
    )
    .get();
  if (!tableExists) return; // fresh DB — DDL will create it with the right constraint

  // Retrieve the current CREATE statement to inspect the CHECK constraint.
  const row = db
    .prepare<[], { sql: string }>(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='organizer_queue'`,
    )
    .get();
  if (!row) return;

  // If the current definition already includes 'enrich', nothing to do.
  if (row.sql.includes("'enrich'")) return;

  // Rebuild dance — wrapped in a transaction for atomicity.
  db.transaction(() => {
    db.exec(`ALTER TABLE organizer_queue RENAME TO organizer_queue_old`);
    db.exec(`
      CREATE TABLE organizer_queue (
        seq        INTEGER PRIMARY KEY AUTOINCREMENT,
        op         TEXT NOT NULL CHECK (op IN ('ingest','enrich','extract','link','consolidate','decay','reindex')),
        payload    TEXT NOT NULL,
        priority   INTEGER NOT NULL DEFAULT 100,
        enqueued   TEXT NOT NULL, claimed_at TEXT, done_at TEXT,
        attempts   INTEGER DEFAULT 0
      )
    `);
    db.exec(`
      INSERT INTO organizer_queue (seq, op, payload, priority, enqueued, claimed_at, done_at, attempts)
      SELECT seq, op, payload, priority, enqueued, claimed_at, done_at, attempts
      FROM organizer_queue_old
    `);
    db.exec(`DROP TABLE organizer_queue_old`);
    // Recreate the open-queue index (idempotent via IF NOT EXISTS).
    db.exec(`CREATE INDEX IF NOT EXISTS ix_q_open ON organizer_queue(done_at, priority, seq) WHERE done_at IS NULL`);
  })();
}

/** Add a column to a table if it does not already exist (idempotent migration). */
export function migrateAddColumn(
  db: Database.Database,
  table: string,
  column: string,
  type: string,
): void {
  const cols = db
    .prepare<[], { name: string }>(`PRAGMA table_info(${table})`)
    .all()
    .map((c) => c.name);
  if (!cols.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/**
 * Initialize a new scope database with metadata.
 * Idempotent: if the scope row already exists, returns existing metadata.
 */
export function initScope(
  db: Database.Database,
  scope: ScopeKind,
  scopeId: string,
): MemoryScope {
  const existing = db
    .prepare<[string], MemoryScope>('SELECT * FROM memory_scope WHERE scope = ?')
    .get(scope);
  if (existing) return existing;

  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO memory_scope(scope, scope_id, embed_model, embed_dim, schema_ver, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(scope, scopeId, getActiveEmbedModel(), EMBED_DIM, now);

  return {
    scope,
    scope_id: scopeId,
    embed_model: getActiveEmbedModel(),
    embed_dim: EMBED_DIM,
    schema_ver: 1,
    created_at: now,
  };
}

// ── DB connection cache (singleton map keyed by resolved path) ────────────────

const dbCache = new Map<string, Database.Database>();

/**
 * Return a cached Database handle for the given `dbPath`, or open a new
 * connection and cache it.
 *
 * The caller is responsible for resolving tilde/relative paths before
 * calling (e.g. via `expandTilde` + `path.resolve`).
 */
export function getDb(dbPath: string): Database.Database {
  const cached = dbCache.get(dbPath);
  if (cached) return cached;
  const db = openDb(dbPath);
  dbCache.set(dbPath, db);
  return db;
}

/**
 * Open a read-only WAL connection (for federated recall from non-primary stores).
 */
export function openDbReadOnly(dbPath: string): Database.Database {
  // BL-41: expand ~ at the sink (mirrors openDb).
  dbPath = expandDbPath(dbPath);
  const db = new Database(dbPath, { readonly: true });
  sqliteVec.load(db);
  // WAL pragma needed for read-only connections; query_only prevents accidental writes
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 3000;');
  db.exec('PRAGMA query_only = ON;');
  return db;
}
