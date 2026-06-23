/**
 * Database connection factory for sox-memory.
 * Opens a SQLite database with WAL mode, loads sqlite-vec extension,
 * applies schema DDL (idempotent), and returns a ready-to-use Database.
 */

import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { PRAGMAS, DDL, FTS_TRIGGERS } from './schema.js';
import { EMBED_DIM, getActiveEmbedModel } from './embed.js';

export type ScopeKind = 'project' | 'user' | 'org' | 'local';

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

  return db;
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

/**
 * Open a read-only WAL connection (for federated recall from non-primary stores).
 */
export function openDbReadOnly(dbPath: string): Database.Database {
  const db = new Database(dbPath, { readonly: true });
  sqliteVec.load(db);
  // Only WAL pragma needed for read-only connections
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  return db;
}
