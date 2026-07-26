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
import { rebuildTable } from '@adhd/sox-graph-store';
import { PRAGMAS, DDL, FTS_TRIGGERS } from './schema.js';
import { EMBED_DIM, getActiveEmbedModel } from './embed.js';
import { closeDbWithLease } from './lease.js';

// ── Store identity stamp keys (SA-5 / BL-121) ────────────────────────────────
export const STORE_META_KEYS = {
  SCHEMA_VERSION: 'schema_version',
  WRITER_ARTIFACT: 'writer_artifact',
  EMBED_MODEL: 'embed_model',
  EMBED_DIMENSIONS: 'embed_dimensions',
} as const;

/**
 * Error raised when a store's identity meta does not match the current runtime.
 * Carries both sides so a human (or orchestrator) can diagnose drift.
 *
 * [inv:store-mismatch-diagnostic] — every mismatch message names both sides
 * (expected vs actual) and suggests remediation.
 */
export class EStoreMismatch extends Error {
  public readonly code = 'E_STORE_MISMATCH';
  constructor(
    message: string,
    public readonly key: string,
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`${message} (key=${key}, expected=${expected}, actual=${actual})`);
    this.name = 'EStoreMismatch';
  }
}

/**
 * Current store schema version.
 * Increment when a non-backward-compatible DDL change is made.
 */
export const STORE_SCHEMA_VERSION = 1;

let _writerArtifact: string | undefined;

/**
 * Override the writer-artifact string. Called at server startup with the running
 * package name + version (e.g. "memory-server@1.1.0").
 */
export function setWriterArtifact(artifact: string): void {
  _writerArtifact = artifact;
}

/** Return the current writer-artifact (or a fallback). */
export function getWriterArtifact(): string {
  return _writerArtifact ?? '@adhd/sox-memory-core';
}

/**
 * Stamp the store identity meta into the database.
 *
 * Only writes rows that are ABSENT — never overwrites an existing value.
 * This means the FIRST open-for-write of a fresh store sets the stamp;
 * a reopened store simply reads back its own stamp.
 *
 * After stamping, calls verifyStoreMeta() to detect mismatches.
 *
 * NOTE on embed_model: we write getActiveEmbedModel() at open-for-write time,
 * not at first embed.
 *
 * ⚠️ [BL-252] This stamp is currently UNFALSIFIABLE. `_activeModel`
 * (`embed.ts:26`) is *initialised* to `'bge-base-en-v1.5'` — the same value it
 * is assigned after a real provider loads (`embed.ts:114`). So a fresh server
 * that has never warmed up an embedding provider still stamps
 * `bge-base-en-v1.5`, asserting which model wrote the vectors when no model has
 * run at all. The STAMP-vs-RESOLVED comparison below can therefore never detect
 * the un-warmed case, and the "warning on mismatch" never fires for it.
 *
 * (The old comment here claimed the default stamp was `nomic-embed-text-v1.5-hash`.
 * That was true when a hash backend existed. It was removed —
 * `EmbedBackend = 'auto' | 'real'`, `embed.ts:43` — and the comment was never updated.)
 *
 * The intent stands: the stamp should capture what wrote the vectors, and the
 * comparison is STAMP vs RESOLVED runtime model, warning (not fatal) on mismatch.
 * To make it honest, `_activeModel` must start as `null` until a provider loads.
 */
export function stampStoreMeta(db: Database.Database): void {
  const upsert = db.prepare(
    `INSERT OR IGNORE INTO sox_store_meta(key, value) VALUES (?, ?)`,
  );

  upsert.run(STORE_META_KEYS.SCHEMA_VERSION, String(STORE_SCHEMA_VERSION));
  upsert.run(STORE_META_KEYS.WRITER_ARTIFACT, getWriterArtifact());
  // BL-252: stamp "unknown" when no embed provider has been initialised
  upsert.run(STORE_META_KEYS.EMBED_MODEL, getActiveEmbedModel() ?? 'unknown');
  upsert.run(STORE_META_KEYS.EMBED_DIMENSIONS, String(EMBED_DIM));

  verifyStoreMeta(db);
}

/**
 * Read each identity key from the store and compare against current runtime.
 * Throws EStoreMismatch when any key has a different value.
 *
 * Warns (console.error, non-fatal) when embed_model differs — vectors may be
 * in a different space but reads still work.
 */
export function verifyStoreMeta(db: Database.Database): void {
  const rows = db
    .prepare<[], { key: string; value: string }>('SELECT key, value FROM sox_store_meta')
    .all();

  const meta = new Map(rows.map((r) => [r.key, r.value] as const));

  // schema_version — hard mismatch
  const storedSchemaVer = meta.get(STORE_META_KEYS.SCHEMA_VERSION);
  if (storedSchemaVer !== undefined && storedSchemaVer !== String(STORE_SCHEMA_VERSION)) {
    throw new EStoreMismatch(
      'Store schema version mismatch — the store was created by a different version of the schema',
      STORE_META_KEYS.SCHEMA_VERSION,
      String(STORE_SCHEMA_VERSION),
      storedSchemaVer,
    );
  }

  // embed_dimensions — hard mismatch (sqlite-vec dimension is part of table DDL)
  const storedEmbedDim = meta.get(STORE_META_KEYS.EMBED_DIMENSIONS);
  if (storedEmbedDim !== undefined && Number(storedEmbedDim) !== EMBED_DIM) {
    throw new EStoreMismatch(
      'Store embed dimension mismatch — the store uses a different vector dimension than the current runtime',
      STORE_META_KEYS.EMBED_DIMENSIONS,
      String(EMBED_DIM),
      storedEmbedDim,
    );
  }

  // embed_model — soft mismatch (warn, don't abort)
  const storedModel = meta.get(STORE_META_KEYS.EMBED_MODEL);
  const runtimeModel = getActiveEmbedModel();
  if (storedModel !== undefined && storedModel !== 'unknown' && runtimeModel !== null && storedModel !== runtimeModel) {
    console.error(
      `[sox-memory] WARNING: store was stamped with embed_model "${storedModel}" ` +
        `but the current runtime has "${runtimeModel}". ` +
        `Vectors may be in a different embedding space. ` +
        `Run "memory reembed --force" to re-embed in the current model.`,
    );
  }
}

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

  // Pre-DDL defensive column migrations for PRE-EXISTING stores. MUST run before
  // db.exec(DDL) below, not after: the unconditional DDL includes bare
  // `CREATE INDEX ... ON node(namespace)` / `ON node(t_expires)` statements (added
  // by the graph-store unification, BL-302) that reference these columns directly.
  // `CREATE TABLE IF NOT EXISTS` is a no-op on a table that already exists, so a
  // pre-unification store missing a column the DDL's own CREATE INDEX statements
  // reference makes db.exec(DDL) throw "no such column" on EVERY open — before
  // ever reaching the migrateAddColumn calls that used to live after it. That
  // silent trap is exactly what took this class of column-migration out of
  // service: `level`/`resume_state`/`t_expired` "worked" only because they had
  // already been migrated under an older DDL ordering before namespace/t_expires
  // were added to the unconditional index list; a store never touched since is
  // permanently stuck failing every real query (found live 2026-07-18 — every
  // memory_* tool needing a DB handle failed with "no such column: namespace";
  // memory_ping alone survived because it needs no DB handle at all).
  // No-op on a fresh store: `PRAGMA table_info` on a not-yet-created table
  // returns an empty row set, so the `tableExists` guard below skips cleanly —
  // the CREATE TABLE statement in DDL defines every column natively instead.
  const nodeTableExists = db
    .prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name='node'`)
    .get();
  if (nodeTableExists) {
    migrateAddColumn(db, 'node', 'namespace', `TEXT DEFAULT 'global'`);
    migrateAddColumn(db, 'node', 't_expires', 'TEXT');
    migrateAddColumn(db, 'node', 'level', 'INTEGER');
    migrateAddColumn(db, 'node', 'resume_state', 'TEXT');
  }
  const edgeTableExists = db
    .prepare<[], { name: string }>(`SELECT name FROM sqlite_master WHERE type='table' AND name='edge'`)
    .get();
  if (edgeTableExists) {
    migrateAddColumn(db, 'edge', 't_expired', 'TEXT');

    // BL-302's `ix_edge_unique` (src, dst, rel) — added unconditionally to the
    // DDL to support ON CONFLICT edge upserts (commit 64a2056) — fails outright
    // if the live table already has duplicate (src, dst, rel) rows predating the
    // constraint, hitting the exact same "db.exec(DDL) throws before reaching
    // anything downstream" trap as the column migrations above. Found live
    // 2026-07-18: 146,006 duplicate edge rows (mostly repeated MEMBER_OF cluster
    // edges from 2026-06-23 through 2026-07-03 — a since-dormant re-clustering
    // bug that kept re-inserting the same membership edge without checking for
    // an existing one first) blocking the index from ever being created.
    // Dedup BEFORE the DDL runs, keeping the earliest (lowest rowid) row per
    // (src, dst, rel) — the same deterministic tie-break an ON CONFLICT upsert
    // would produce. Gated on the index not already existing so this full-table
    // scan runs once per store, not on every open.
    const uniqueIndexExists = db
      .prepare<[], { name: string }>(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='ix_edge_unique'`,
      )
      .get();
    if (!uniqueIndexExists) {
      const dupeGroups = db
        .prepare<[], { c: number }>(
          `SELECT COUNT(*) AS c FROM (
             SELECT 1 FROM edge GROUP BY src, dst, rel HAVING COUNT(*) > 1
           )`,
        )
        .get();
      if ((dupeGroups?.c ?? 0) > 0) {
        db.exec(`
          DELETE FROM edge
          WHERE rowid NOT IN (
            SELECT MIN(rowid) FROM edge GROUP BY src, dst, rel
          )
        `);
      }
    }
  }

  // Apply DDL (idempotent — uses CREATE IF NOT EXISTS)
  db.exec(DDL);
  db.exec(FTS_TRIGGERS);

  // SA-5 / BL-121: stamp store identity meta on every open-for-write.
  // INSERT OR IGNORE ensures first-write wins; subsequent opens verify.
  // A mismatch (schema_version, embed_dimensions) throws EStoreMismatch.
  stampStoreMeta(db);

  // Idempotent column migrations for pre-existing stores (CREATE IF NOT EXISTS won't
  // add columns to a table that already exists). Add new columns when missing.
  // These columns are memory-specific — graph primitives (topic, tags, project_path, meta, t_updated)
  // are now in the canonical graph-store DDL and don't need migration.
  migrateAddColumn(db, 'node', 'enrich_ver', 'TEXT');
  // BL-88: per-record embedding provenance. NULL = embedded before provenance existed
  // (or not yet embedded). Do NOT backfill existing rows — NULL is honest (provenance unknown).
  // Stamped by applyEmbedding() at vec insert time (the single choke-point for all write/update/heal paths).
  migrateAddColumn(db, 'node', 'embed_model', 'TEXT');
  // D3.4 partial indices for enrichment columns
  db.exec(`CREATE INDEX IF NOT EXISTS ix_node_topic      ON node(topic)        WHERE topic IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS ix_node_project    ON node(project_path) WHERE project_path IS NOT NULL`);
  db.exec(`CREATE INDEX IF NOT EXISTS ix_node_enrich_ver ON node(enrich_ver)   WHERE enrich_ver IS NOT NULL`);

  // WP-4: request_ledger table migration — ensures the table exists on upgraded stores
  // that were created before the request_ledger DDL was added to schema.ts.
  // Idempotent: CREATE TABLE IF NOT EXISTS, so re-opening does not error.
  const rlExists = db
    .prepare<[], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='request_ledger'`,
    )
    .get();
  if (!rlExists) {
    db.exec(`CREATE TABLE IF NOT EXISTS request_ledger (
      request_id TEXT PRIMARY KEY,
      episode_uid TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    db.exec(`CREATE INDEX IF NOT EXISTS ix_request_ledger_created_at ON request_ledger(created_at)`);
  }

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

  // Rebuild dance using the general-purpose helper.
  rebuildTable(db, 'organizer_queue', `
    CREATE TABLE organizer_queue (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      op         TEXT NOT NULL CHECK (op IN ('ingest','enrich','extract','link','consolidate','decay','reindex')),
      payload    TEXT NOT NULL,
      priority   INTEGER NOT NULL DEFAULT 100,
      enqueued   TEXT NOT NULL, claimed_at TEXT, done_at TEXT,
      attempts   INTEGER DEFAULT 0
    )
  `, ['seq', 'op', 'payload', 'priority', 'enqueued', 'claimed_at', 'done_at', 'attempts']);

  // Recreate the open-queue index (idempotent via IF NOT EXISTS).
  db.exec(`CREATE INDEX IF NOT EXISTS ix_q_open ON organizer_queue(done_at, priority, seq) WHERE done_at IS NULL`);
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
  const embedModel = getActiveEmbedModel() ?? 'unknown';
  db.prepare(
    `INSERT INTO memory_scope(scope, scope_id, embed_model, embed_dim, schema_ver, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
  ).run(scope, scopeId, embedModel, EMBED_DIM, now);

  return {
    scope,
    scope_id: scopeId,
    embed_model: embedModel,
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

/**
 * Close all cached DB connections with lease release.
 *
 * Iterates the dbCache, calls closeDbWithLease on each entry, then clears
 * the cache. Used by the memory-server backend shutdown handler to ensure
 * all write leases are released before process exit.
 */
export function closeAllDbs(): void {
  for (const [dbPath, db] of dbCache) {
    closeDbWithLease(db, dbPath);
  }
  dbCache.clear();
}
