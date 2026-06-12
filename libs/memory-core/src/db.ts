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
import { EMBED_MODEL, EMBED_DIM } from './embed.js';

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

  return db;
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
  ).run(scope, scopeId, EMBED_MODEL, EMBED_DIM, now);

  return {
    scope,
    scope_id: scopeId,
    embed_model: EMBED_MODEL,
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
