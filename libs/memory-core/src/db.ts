/**
 * Database connection factory for sox-memory.
 * Opens a SQLite database with WAL mode, loads sqlite-vec extension,
 * applies schema DDL (idempotent), and returns a ready-to-use StoreAdapter.
 *
 * MIGRATED (turso-adapter): returns Promise<StoreAdapter> instead of Database.Database.
 * Internally creates a StoreAdapter (sqlite or turso), loads sqlite-vec for sqlite,
 * applies pragmas via adapter.pragmaSet() and DDL via adapter.exec(). vec0 DDL is
 * produced by the VectorDialect. Callers that need raw better-sqlite3 access can
 * cast to SqliteAdapter and call unwrap().
 */

import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { rebuildTable } from '@adhd/sox-graph-store';
import { PRAGMAS, DDL_BASE, FTS_DDL, FTS_TRIGGERS } from './schema.js';
import { EMBED_DIM, getActiveEmbedModel } from './embed.js';
import { closeDbWithLease } from './lease.js';
import type Database from 'better-sqlite3';
import type { StoreAdapter, SqliteAdapter } from '@adhd/sox-store-adapter';
import { log, instrumentAdapter, truncateForLog } from './telemetry.js';
import { performance } from 'node:perf_hooks';

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
export async function stampStoreMeta(adapter: StoreAdapter): Promise<void> {
  const upsert = `INSERT OR IGNORE INTO sox_store_meta(key, value) VALUES (?, ?)`;

  await adapter.executeRun(upsert, [STORE_META_KEYS.SCHEMA_VERSION, String(STORE_SCHEMA_VERSION)]);
  await adapter.executeRun(upsert, [STORE_META_KEYS.WRITER_ARTIFACT, getWriterArtifact()]);
  // BL-252: stamp "unknown" when no embed provider has been initialised
  await adapter.executeRun(upsert, [STORE_META_KEYS.EMBED_MODEL, getActiveEmbedModel() ?? 'unknown']);
  await adapter.executeRun(upsert, [STORE_META_KEYS.EMBED_DIMENSIONS, String(EMBED_DIM)]);

  await verifyStoreMeta(adapter);
}

/**
 * Read each identity key from the store and compare against current runtime.
 * Throws EStoreMismatch when any key has a different value.
 *
 * Warns (console.error, non-fatal) when embed_model differs — vectors may be
 * in a different space but reads still work.
 */
export async function verifyStoreMeta(adapter: StoreAdapter): Promise<void> {
  const { rows } = await adapter.executeAll<{ key: string; value: string }>(
    'SELECT key, value FROM sox_store_meta',
  );

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
 * Open a database via better-sqlite3 + sqlite-vec to drop vec0 virtual tables
 * and optionally VACUUM. Turso/libSQL cannot drop vec0 VTs (no vec0 module),
 * so this fallback is required when migrating an existing store to Turso.
 */
async function dropVec0ViaBetterSqlite3(
  dbPath: string,
  options?: { runVacuum?: boolean },
): Promise<void> {
  // BL-323: sqlite-vec has NO default export (only named `load`/`getLoadablePath`,
  // verified against the installed 0.1.9 package — `m.default` is `undefined`).
  // Destructuring `{ default: sqliteVec }` silently binds `sqliteVec` to `undefined`,
  // which throws `TypeError: Cannot read properties of undefined (reading 'load')`
  // only once this path actually runs (VACUUM repair / vec0 migration) — every
  // other openDb() call site had the identical bug hiding the same way.
  const [{ default: Database }, { load: loadSqliteVec }] = await Promise.all([
    import('better-sqlite3'),
    import('sqlite-vec'),
  ]);
  const bsdb = new Database(dbPath);
  try {
    loadSqliteVec(bsdb);

    // Phase 1: Drop vec0 virtual tables (cascades to shadow tables)
    // Turso cannot drop these without the vec0 module loaded.
    const vec0Tables = bsdb.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE '%VIRTUAL%' AND sql LIKE '%vec0%'`,
    ).all() as { name: string }[];
    for (const t of vec0Tables) {
      bsdb.exec(`DROP TABLE IF EXISTS "${t.name}"`);
    }

    // Phase 2: Drop remaining vec-prefixed shadow tables
    const shadowTables = bsdb.prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'vec\\_%' ESCAPE '\\' OR name = '_vector_spaces')`,
    ).all() as { name: string }[];
    for (const t of shadowTables) {
      bsdb.exec(`DROP TABLE IF EXISTS "${t.name}"`);
    }

    if (options?.runVacuum) {
      bsdb.exec('VACUUM');
    }
  } finally {
    bsdb.close();
  }
}

/**
 * Execute FTS legacy-residue DROP statements — as produced by
 * `FTSDialect.dropLegacyDDL()` — through a fresh better-sqlite3 connection.
 *
 * Required whenever the residue was created by a DIFFERENT SQLite engine
 * module than the one about to reopen the store (typically: Turso opening a
 * store that still carries SQLite-era fts5 artifacts). `DROP TABLE`/`DROP
 * TRIGGER` issued directly through Turso against fts5 objects it doesn't
 * understand silently "succeeds" while leaving the object in `sqlite_master`
 * untouched (verified empirically — same silent-no-op behavior already
 * documented for vec0 DROPs via `dropVec0ViaBetterSqlite3` above).
 * better-sqlite3 has fts5 compiled in, so it executes these drops for real
 * regardless of which dialect produced the statement list — the caller
 * doesn't need to know or care which backend authored the residue.
 *
 * Each statement is executed independently and best-effort: a partial-residue
 * store (e.g. missing one shadow table) must not abort the whole cleanup.
 */
async function dropFtsResidueViaBetterSqlite3(dbPath: string, statements: readonly string[]): Promise<void> {
  const { default: Database } = await import('better-sqlite3');
  const bsdb = new Database(dbPath);
  try {
    for (const stmt of statements) {
      try {
        bsdb.exec(stmt);
      } catch (err) {
        log.debug('store.open.fts_legacy_residue_drop_skip', {
          sql: truncateForLog(stmt),
          error: truncateForLog(err instanceof Error ? err.message : String(err)),
        });
      }
    }
  } finally {
    bsdb.close();
  }
}

/**
 * Open (or create) a memory database at the given path.
 * Creates a StoreAdapter, loads sqlite-vec for sqlite type, applies pragmas +
 * schema, and returns a ready-to-use StoreAdapter.
 *
 * BL-320: every open is bracketed by structured start/finish/error telemetry
 * (see telemetry.ts) so a hang or a failure during open is durably visible
 * even if it never returns. The real work lives in `_openDbInner` — kept
 * separate so the telemetry wrapper stays a thin, easily-audited shell.
 */
export async function openDb(dbPath: string): Promise<StoreAdapter> {
  // BL-41: expand a leading ~ to $HOME at the file-create sink so every caller —
  // regardless of whether it expanded — opens the real path, never a literal `~` dir.
  dbPath = expandDbPath(dbPath);
  const openStartMs = performance.now();
  log.info('store.open.start', { db_path: dbPath });

  try {
    const adapter = await _openDbInner(dbPath);
    log.info('store.open.finish', {
      db_path: dbPath,
      adapter_type: adapter.config.type,
      duration_ms: Math.round(performance.now() - openStartMs),
    });
    // BL-320: wrap the adapter so every SQL error anywhere downstream (Phase-A
    // insert, recall query, curate op, …) is logged with the offending SQL
    // text — not just failures during this open sequence.
    return instrumentAdapter(adapter, adapter.config.type);
  } catch (err) {
    log.error('store.open.error', {
      db_path: dbPath,
      duration_ms: Math.round(performance.now() - openStartMs),
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function _openDbInner(dbPath: string): Promise<StoreAdapter> {
  // Ensure parent directory exists
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });

  // Create StoreAdapter (dynamically imported to bridge CJS→ESM).
  const {
    createStoreAdapter,
    createVectorDialect,
    createFTSDialect,
    resolveExistingFtsIndexName,
    canonicalFtsIndexName,
  } = await import('@adhd/sox-store-adapter');
  let adapter = await createStoreAdapter({ dbPath });
  const vectorDialect = createVectorDialect(adapter.config.type);

  // ═══════════════════════════════════════════════════════════════════════════
  // TursoAdapter compatibility repair for existing better-sqlite3 stores
  // ═══════════════════════════════════════════════════════════════════════════
  // better-sqlite3 embeds SQLite 3.53.1, while Turso/libSQL 0.7.1 is built on
  // SQLite 3.50.4. A database file created by the newer SQLite is readable by
  // Turso at the sqlite_master level but NOT at the data-table level ("no such
  // table" on any SELECT/INSERT/DELETE against a real table). The fix is a
  // VACUUM (via better-sqlite3) which re-serialises the file in the format of
  // whichever SQLite performed it — in this case the installed better-sqlite3
  // carries the newer SQLite, but the resulting file is backward-compatible
  // down to at least 3.50.4 (verified empirically 2026-07-28).
  //
  // Additionally, Turso/libSQL 0.7.1 cannot DROP vec0 virtual tables — the
  // command silently succeeds but the table remains in sqlite_master.
  // Therefore we also drop vec0-related tables through better-sqlite3 here
  // (before VACUUM, so the pages are reclaimed).
  //
  // Detect by trying to query a specific essential table (node). sqlite_master
  // is always accessible; if it lists node but a SELECT against it fails, the
  // file needs VACUUM. We use node rather than an arbitrary first table because
  // some tables (e.g. memory_scope) may be queryable while others are not; node
  // is the most reliable indicator — if it fails, VACUUM fixes everything.
  if (adapter.config.type === 'turso' && fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
    const nodeInSchema = await adapter.executeGet<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='node'`,
    );
    if (nodeInSchema) {
      try {
        await adapter.executeGet('SELECT 1 FROM node LIMIT 1');
      } catch {
        // Table exists in sqlite_master but cannot be queried — the database
        // was created by a newer SQLite version. VACUUM via better-sqlite3 to
        // re-serialise in a compatible format, also dropping vec0 VTs (which
        // Turso cannot drop) and their shadow tables, then re-create adapter.
        log.warn('store.open.turso_vacuum_repair', { db_path: dbPath });
        await adapter.close();
        await dropVec0ViaBetterSqlite3(dbPath, { runVacuum: true });
        adapter = await createStoreAdapter({ dbPath });
      }
    }
  }

  // Load sqlite-vec extension ONLY for adapters WITHOUT native vector support
  // (i.e. SqliteAdapter — TursoAdapter has native vectors and doesn't need it).
  if (!adapter.capabilities.nativeVectors) {
    // BL-323: named export only — see dropVec0ViaBetterSqlite3() above.
    const { load: loadSqliteVec } = await import('sqlite-vec');
    const rawDb = (adapter as SqliteAdapter).unwrap();
    loadSqliteVec(rawDb);
  }

  // Apply pragmas via adapter.pragmaSet()
  for (const line of PRAGMAS.trim().split('\n').filter(Boolean)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = parsePragma(trimmed);
    if (parsed) {
      await adapter.pragmaSet(parsed.key, parsed.value);
    }
  }

  // Pre-DDL defensive column migrations for PRE-EXISTING stores. MUST run before
  // adapter.exec(DDL) below, not after: the unconditional DDL includes bare
  // `CREATE INDEX ... ON node(namespace)` / `ON node(t_expires)` statements (added
  // by the graph-store unification, BL-302) that reference these columns directly.
  // `CREATE TABLE IF NOT EXISTS` is a no-op on a table that already exists, so a
  // pre-unification store missing a column the DDL's own CREATE INDEX statements
  // reference makes adapter.exec(DDL) throw "no such column" on EVERY open — before
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
  //
  // NOTE (Turso compatibility): Turso/libSQL's `PRAGMA table_info` returns 0 rows
  // for tables created by better-sqlite3 with complex schemas (FKs, CHECK, indexes).
  // If the ALTER TABLE calls below fail, the store is still usable — the missing
  // columns are quality-of-life additions. Catch and continue.
  try {
    const nodeTableExists = await adapter.executeGet<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='node'`,
    );
    if (nodeTableExists) {
      // Wrap each migration in try/catch — Turso may not support ALTER TABLE
      // on complex tables created by better-sqlite3.
      for (const [col, def] of [['namespace', `TEXT DEFAULT 'global'`], ['t_expires', 'TEXT'], ['level', 'INTEGER'], ['resume_state', 'TEXT']] as const) {
        try {
          await migrateAddColumn(adapter, 'node', col, def);
        } catch (err) {
          log.debug('store.open.migrate_column_skip', {
            table: 'node',
            column: col,
            adapter_type: adapter.config.type,
            error: truncateForLog(err instanceof Error ? err.message : String(err)),
          });
        }
      }
    }
    const edgeTableExists = await adapter.executeGet<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='edge'`,
    );
    if (edgeTableExists) {
      try {
        await migrateAddColumn(adapter, 'edge', 't_expired', 'TEXT');
      } catch (err) {
        log.debug('store.open.migrate_column_skip', {
          table: 'edge',
          column: 't_expired',
          adapter_type: adapter.config.type,
          error: truncateForLog(err instanceof Error ? err.message : String(err)),
        });
      }

      // BL-302's `ix_edge_unique` (src, dst, rel) — added unconditionally to the
      // DDL to support ON CONFLICT edge upserts (commit 64a2056) — fails outright
      // if the live table already has duplicate (src, dst, rel) rows predating the
      // constraint, hitting the exact same "adapter.exec(DDL) throws before reaching
      // anything downstream" trap as the column migrations above. Found live
      // 2026-07-18: 146,006 duplicate edge rows (mostly repeated MEMBER_OF cluster
      // edges from 2026-06-23 through 2026-07-03 — a since-dormant re-clustering
      // bug that kept re-inserting the same membership edge without checking for
      // an existing one first) blocking the index from ever being created.
      // Dedup BEFORE the DDL runs, keeping the earliest (lowest rowid) row per
      // (src, dst, rel) — the same deterministic tie-break an ON CONFLICT upsert
      // would produce. Gated on the index not already existing so this full-table
      // scan runs once per store, not on every open.
      try {
        const uniqueIndexExists = await adapter.executeGet<{ name: string }>(
          `SELECT name FROM sqlite_master WHERE type='index' AND name='ix_edge_unique'`,
        );
        if (!uniqueIndexExists) {
          const dupeGroups = await adapter.executeGet<{ c: number }>(
            `SELECT COUNT(*) AS c FROM (
               SELECT 1 FROM edge GROUP BY src, dst, rel HAVING COUNT(*) > 1
             )`,
          );
          if ((dupeGroups?.c ?? 0) > 0) {
            await adapter.exec(`
              DELETE FROM edge
              WHERE rowid NOT IN (
                SELECT MIN(rowid) FROM edge GROUP BY src, dst, rel
              )
            `);
          }
        }
      } catch (err) {
        // Non-fatal — edge dedup is a one-time optimization; Turso may not
        // support the GROUP BY / subquery pattern on complex tables.
        log.debug('store.open.edge_dedup_skip', {
          adapter_type: adapter.config.type,
          error: truncateForLog(err instanceof Error ? err.message : String(err)),
        });
      }
    }
  } catch (err) {
    // Non-fatal — the pre-DDL migrations are QoL improvements for existing
    // stores. If they fail (e.g. on Turso which doesn't support ALTER TABLE
    // on better-sqlite3-created complex schemas), the store is still usable.
    // The DDL block below handles CREATE TABLE IF NOT EXISTS correctly.
    log.debug('store.open.pre_ddl_migrations_skip', {
      adapter_type: adapter.config.type,
      error: truncateForLog(err instanceof Error ? err.message : String(err)),
    });
  }

  // Apply DDL — split into individual statements for Turso compatibility.
  // Turso/libSQL rejects multi-statement exec() on the first error even with
  // IF NOT EXISTS (it validates index definitions against existing indexes).
  // Execute each statement independently so a "already exists" on one doesn't
  // block the others.
  // SAFETY: DDL_BASE is hand-maintained and contains no semicolons inside string literals.
  // If this ever changes, replace with a proper SQL statement splitter.
  const ddlStatements = DDL_BASE
    .split(';')
    .map(s => s.trim())
    .filter(s => s.length > 0)
    .map(s => s + ';');
  for (const stmt of ddlStatements) {
    try {
      await adapter.exec(stmt);
    } catch (err) {
      // Non-fatal — table or index already exists. Turso rejects IF NOT EXISTS
      // when the object exists (unlike SQLite which treats it as a no-op).
      log.debug('store.open.ddl_statement_skip', {
        adapter_type: adapter.config.type,
        sql: truncateForLog(stmt),
        error: truncateForLog(err instanceof Error ? err.message : String(err)),
      });
    }
  }

  // FTS setup — fully dialect-driven. This is the ONLY FTS call site in
  // openDb(): no branching on `adapter.config.type` for what "create" or
  // "clean up residue" means — the FTSDialect (fts-dialect.ts, the single
  // place that knows how FTS works per backend) decides. Adding a third
  // backend means implementing FTSDialect once, not touching this function.
  const ftsDialect = createFTSDialect(adapter.config.type);
  if (ftsDialect.supported && adapter.capabilities.fts) {
    // 1. Legacy-residue cleanup: a store migrated from the OTHER backend may
    //    carry that backend's now-dead FTS artifacts (SQLite fts5 table +
    //    shadow tables + triggers on a Turso store; Turso's native index +
    //    internal directory objects on a SQLite store — asymmetric but both
    //    handled by the same dialect-driven path). Dead weight at best; on
    //    Turso, actively fragile — Turso silently never fires fts5 trigger
    //    bodies on INSERT/UPDATE/DELETE rather than erroring, which is an
    //    undocumented gap, not a guarantee (see fts-dialect.ts module doc).
    const residueNames = ftsDialect.legacyResidueNames('node');
    if (residueNames.length > 0) {
      const placeholders = residueNames.map(() => '?').join(',');
      const residue = await adapter.executeGet<{ c: number }>(
        `SELECT COUNT(*) as c FROM sqlite_master WHERE name IN (${placeholders})`,
        residueNames,
      );
      if (residue && residue.c > 0) {
        log.warn('store.open.fts_legacy_residue_drop', {
          db_path: dbPath,
          adapter_type: adapter.config.type,
          residue_count: residue.c,
        });
        if (ftsDialect.supportsShadowTable) {
          // Residue belongs to the OTHER (non-shadow-table) dialect — its
          // objects are opaque index/table rows to this engine and can be
          // dropped directly through the live adapter connection.
          for (const stmt of ftsDialect.dropLegacyDDL('node')) {
            try {
              await adapter.exec(stmt);
            } catch (err) {
              log.debug('store.open.fts_legacy_residue_drop_skip', {
                adapter_type: adapter.config.type,
                sql: truncateForLog(stmt),
                error: truncateForLog(err instanceof Error ? err.message : String(err)),
              });
            }
          }
        } else {
          // Residue belongs to a shadow-table dialect (SQLite fts5) this
          // engine (Turso) cannot reliably manipulate directly — verified
          // empirically: DROP TABLE/TRIGGER against it reports success but
          // leaves the object in sqlite_master untouched. Route through
          // better-sqlite3, then reopen (mirrors the vec0 compatibility
          // repair pattern above).
          await adapter.close();
          await dropFtsResidueViaBetterSqlite3(dbPath, ftsDialect.dropLegacyDDL('node'));
          adapter = await createStoreAdapter({ dbPath });
        }
      }
    }

    // 2. Create/ensure the FTS index for this backend. SQLite's real DDL is
    //    schema-owned upstream by graph-store (re-exported here as
    //    FTS_DDL/FTS_TRIGGERS via schema.ts) and passed through — the
    //    dialect can't own that SQL itself without a circular package
    //    dependency (graph-store already depends on store-adapter). Turso
    //    generates its own DDL from columns/weights and ignores the sqlite
    //    DDL argument entirely.
    // (BL-461) Ask whether the TABLE has an FTS index, not whether one
    // particular NAME is taken. Turso has no `ALTER INDEX … RENAME`, so the
    // orphan guard's rebuild (store-adapter's fts-orphan-guard.ts) necessarily
    // leaves the healthy index under a different name — `idx_fts_node__r1`.
    // `CREATE INDEX IF NOT EXISTS idx_fts_node` would then find its own name
    // free and build a SECOND full index over the same columns: measured to
    // coexist and to answer queries correctly, so the only symptom is
    // permanently doubled write and storage cost, forever, silently.
    // Returns null on SQLite (fts5's virtual-table name is load-bearing) and on
    // any unreadable schema, so the default is unchanged: create as usual.
    const existingFtsIndex = await resolveExistingFtsIndexName(adapter, 'node');
    const ddlStatements =
      existingFtsIndex !== null && existingFtsIndex !== canonicalFtsIndexName('node')
        ? []
        : ftsDialect.createIndexDDL(
            'node',
            ['content', 'name', 'summary'],
            { content: 1.0, name: 1.0, summary: 1.0 },
            [FTS_DDL, FTS_TRIGGERS],
          );
    if (ddlStatements.length === 0 && existingFtsIndex !== null) {
      log.info('store.open.fts_index_resolved_by_lookup', {
        adapter_type: adapter.config.type,
        index_name: existingFtsIndex,
        canonical_name: canonicalFtsIndexName('node'),
        detail:
          'the FTS index on "node" is present under a non-canonical name (BL-461 orphan rebuild); ' +
          'creation skipped so a duplicate index is not built',
      });
    }
    for (const stmt of ddlStatements) {
      try {
        await adapter.exec(stmt);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (/already exists/i.test(message)) {
          // Benign — e.g. Turso rejecting IF NOT EXISTS on an index that's
          // already there, or a re-applied CREATE TRIGGER IF NOT EXISTS.
          log.debug('store.open.fts_index_already_exists', {
            adapter_type: adapter.config.type,
            error: truncateForLog(message),
          });
        } else {
          // Any OTHER failure means full-text search is dead on this store
          // and MUST be loud (log.error), never silently downgraded — a
          // swallowed failure here is exactly how idx_fts_node went missing
          // in production before this was root-caused (Turso's `CREATE
          // INDEX ... USING fts` requires the connection to have been
          // opened with the `index_method` experimental feature — fixed in
          // TursoAdapterImpl.connect(), turso-adapter.ts).
          log.error('store.open.fts_index_create_failed', {
            adapter_type: adapter.config.type,
            db_path: dbPath,
            sql: truncateForLog(stmt),
            error: truncateForLog(message),
          });
        }
      }
    }
  }

  // ── Vector table setup ─────────────────────────────────────────────────
  // When opening an existing store created by better-sqlite3 + sqlite-vec,
  // Turso/libSQL cannot use vec0 virtual tables (no sqlite-vec module).
  // Check for existing vec0 VT and drop it before creating a native table.
  //
  // IMPORTANT: Turso/libSQL 0.7.1 silently fails to DROP vec0 virtual tables
  // created by a different SQLite library — the command returns OK but the
  // table remains in sqlite_master. Therefore all vec0 DROP operations for
  // Turso MUST go through better-sqlite3 with sqlite-vec loaded.
  //
  // Additionally, Turso/libSQL 0.7.1 does not detect schema changes made by
  // other connections (the schema cookie mechanism is not fully implemented).
  // After any external DROP, the adapter MUST be closed and re-opened to
  // refresh its schema cache — a simple sqlite_master query is insufficient.

  // Check for existing vec0 tables (vec0 virtual tables or their shadow tables).
  //
  // MUST NOT match the NATIVE Turso vector table, which is legitimately named
  // `vec_node` (`CREATE TABLE "vec_node" (node_id INTEGER PRIMARY KEY,
  // embedding F32_BLOB(768))`). Matching purely on the `vec\_%` name prefix —
  // as this predicate previously did — matched that native table on EVERY open
  // of a healthy Turso store, spuriously routing into
  // `dropVec0ViaBetterSqlite3()`. That was silently harmless until the Tantivy
  // FTS index landed: better-sqlite3 cannot parse `CREATE INDEX ... USING fts`,
  // so opening the store through it now fails outright with
  // `malformed database schema (__turso_internal_fts_dir_idx_fts_node_key)`,
  // taking down every tool call. (Diagnosed 2026-07-30 from the BL-320
  // telemetry: `store.open.turso_vec0_drop` immediately followed by
  // `store.open.error`.)
  //
  // Real vec0 artifacts are identified by their DDL (`USING vec0`) or by being
  // a vec0 SHADOW table (`vec_node_chunks`, `vec_node_rowids`, `vec_node_info`,
  // `vec_node_vector_chunks00`, …) — never by the bare `vec_node` name alone.
  const anyVecTables = await adapter.executeGet<{ c: number }>(
    `SELECT COUNT(*) as c FROM sqlite_master
      WHERE type='table'
        AND ( sql LIKE '%USING vec0%'
              OR name = '_vector_spaces'
              OR (name LIKE 'vec\\_%' ESCAPE '\\' AND name <> 'vec_node') )`,
  );
  if (anyVecTables && anyVecTables.c > 0 && adapter.config.type === 'turso') {
    log.warn('store.open.turso_vec0_drop', { db_path: dbPath });
    await adapter.close();
    await dropVec0ViaBetterSqlite3(dbPath);
    adapter = await createStoreAdapter({ dbPath });
  }

  // 3. Create native vector table and index via dialect
  try {
    await adapter.exec(vectorDialect.createTableDDL('vec_node', 'embedding', EMBED_DIM));
    const indexDDL = vectorDialect.createIndexDDL('vec_node', 'embedding', 'cosine');
    if (indexDDL) {
      await adapter.exec(indexDDL);
    }
  } catch (err) {
    // Log the error for diagnostics
    log.warn('store.open.vec_node_create_failed', {
      adapter_type: adapter.config.type,
      error: truncateForLog(err instanceof Error ? err.message : String(err)),
    });
    // Verify the table exists — if not, this is a genuine failure on adapters that need native vectors
    const vecExists = await adapter.executeGet<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='vec_node'`,
    );
    if (!vecExists && adapter.capabilities.nativeVectors) {
      throw new Error(
        `Failed to create vec_node table: ${err instanceof Error ? err.message : String(err)}. ` +
        `Vector search will be unavailable. Check disk space and permissions.`,
      );
    }
    // On SQLite (no nativeVectors), vec_node is created as a native table —
    // CREATE TABLE IF NOT EXISTS should always succeed there. This catch is a safety net.
  }

  // SA-5 / BL-121: stamp store identity meta on every open-for-write.
  // INSERT OR IGNORE ensures first-write wins; subsequent opens verify.
  // A mismatch (schema_version, embed_dimensions) throws EStoreMismatch.
  //
  // DDL_BASE above is applied per-statement with individual try/catch, but Turso
  // can still reject specific CREATE TABLE IF NOT EXISTS calls when the table exists
  // with a different schema. Guard ensures sox_store_meta exists before we stamp it
  // — follows the same pattern as the request_ledger migration below.
  const smExists = await adapter.executeGet<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='sox_store_meta'`,
  );
  if (!smExists) {
    await adapter.exec(`CREATE TABLE IF NOT EXISTS sox_store_meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )`);
  }
  await stampStoreMeta(adapter);

  // Idempotent column migrations for pre-existing stores (CREATE IF NOT EXISTS won't
  // add columns to a table that already exists). Add new columns when missing.
  // These columns are memory-specific — graph primitives (topic, tags, project_path, meta, t_updated)
  // are now in the canonical graph-store DDL and don't need migration.
  await migrateAddColumn(adapter, 'node', 'enrich_ver', 'TEXT');
  // BL-88: per-record embedding provenance. NULL = embedded before provenance existed
  // (or not yet embedded). Do NOT backfill existing rows — NULL is honest (provenance unknown).
  // Stamped by applyEmbedding() at vec insert time (the single choke-point for all write/update/heal paths).
  await migrateAddColumn(adapter, 'node', 'embed_model', 'TEXT');
  // D3.4 partial indices for enrichment columns
  // NOTE: Turso/libSQL's `CREATE INDEX IF NOT EXISTS` validates the index
  // definition and throws "index already exists" even when IF NOT EXISTS is
  // present. Wrap in try/catch — the index already exists, which is correct.
  try { await adapter.exec(`CREATE INDEX IF NOT EXISTS ix_node_topic      ON node(topic)        WHERE topic IS NOT NULL`); } catch { /* index already exists */ }
  try { await adapter.exec(`CREATE INDEX IF NOT EXISTS ix_node_project    ON node(project_path) WHERE project_path IS NOT NULL`); } catch { /* index already exists */ }
  try { await adapter.exec(`CREATE INDEX IF NOT EXISTS ix_node_enrich_ver ON node(enrich_ver)   WHERE enrich_ver IS NOT NULL`); } catch { /* index already exists */ }

  // WP-4: request_ledger table migration — ensures the table exists on upgraded stores
  // that were created before the request_ledger DDL was added to schema.ts.
  // Idempotent: CREATE TABLE IF NOT EXISTS, so re-opening does not error.
  const rlExists = await adapter.executeGet<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='request_ledger'`,
  );
  if (!rlExists) {
    await adapter.exec(`CREATE TABLE IF NOT EXISTS request_ledger (
      request_id TEXT PRIMARY KEY,
      episode_uid TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    await adapter.exec(`CREATE INDEX IF NOT EXISTS ix_request_ledger_created_at ON request_ledger(created_at)`);
  }

  // Idempotent migration: add 'enrich' to the organizer_queue CHECK constraint if
  // the existing table was created before the 'enrich' op was added (BL-27 LOW-4).
  // SQLite does not support ALTER TABLE ... MODIFY CONSTRAINT, so we must:
  //   1. Detect whether the current CHECK is stale (does NOT include 'enrich').
  //   2. If stale, do the safe rebuild dance inside a transaction:
  //      rename → create-new → copy → drop-old → recreate index.
  // This is a no-op on fresh stores (the DDL already contains 'enrich').
  await migrateOrganizerQueueCheckConstraint(adapter);

  return adapter;
}

/**
 * Parse a `PRAGMA key = value;` line into { key, value } suitable for
 * adapter.pragmaSet(). Numeric values are parsed to numbers; 'ON'/'OFF'
 * become boolean true/false; everything else stays a string.
 */
function parsePragma(sql: string): { key: string; value: string | number | boolean } | null {
  const m = sql.match(/^PRAGMA\s+(\w+)\s*=\s*([^;]+);?$/i);
  if (!m) return null;
  const key = m[1]!;
  const rawVal = m[2]!.trim();
  if (rawVal === 'ON') return { key, value: true };
  if (rawVal === 'OFF') return { key, value: false };
  const num = Number(rawVal);
  if (!isNaN(num) && String(num) === rawVal) return { key, value: num };
  return { key, value: rawVal };
}

/**
 * Idempotently add 'enrich' to the organizer_queue CHECK constraint.
 *
 * SQLite cannot ALTER TABLE to change a CHECK, so we rename + recreate.
 * Safe to call multiple times: exits immediately if the constraint already
 * includes 'enrich' or if the table doesn't exist.
 */
async function migrateOrganizerQueueCheckConstraint(adapter: StoreAdapter): Promise<void> {
  // Check if the table exists first.
  const tableExists = await adapter.executeGet<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='organizer_queue'`,
  );
  if (!tableExists) return; // fresh DB — DDL will create it with the right constraint

  // Retrieve the current CREATE statement to inspect the CHECK constraint.
  const row = await adapter.executeGet<{ sql: string }>(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='organizer_queue'`,
  );
  if (!row) return;

  // If the current definition already includes 'enrich', nothing to do.
  if (row.sql.includes("'enrich'")) return;

  // Rebuild dance using the general-purpose helper.
  await rebuildTable(adapter, 'organizer_queue', `
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
  await adapter.exec(`CREATE INDEX IF NOT EXISTS ix_q_open ON organizer_queue(done_at, priority, seq) WHERE done_at IS NULL`);
}

/** Add a column to a table if it does not already exist (idempotent migration). */
export async function migrateAddColumn(
  adapter: StoreAdapter,
  table: string,
  column: string,
  type: string,
): Promise<void> {
  const { rows } = await adapter.executeAll<{ name: string }>(`PRAGMA table_info(${table})`);
  const cols = rows.map((c) => c.name);
  if (!cols.includes(column)) {
    await adapter.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/**
 * Initialize a new scope database with metadata.
 * Idempotent: if the scope row already exists, returns existing metadata.
 */
export async function initScope(
  adapter: StoreAdapter,
  scope: ScopeKind,
  scopeId: string,
): Promise<MemoryScope> {
  const existing = await adapter.executeGet<MemoryScope>(
    'SELECT * FROM memory_scope WHERE scope = ?',
    [scope],
  );
  if (existing) return existing;

  const now = new Date().toISOString();
  const embedModel = getActiveEmbedModel() ?? 'unknown';
  await adapter.executeRun(
    `INSERT INTO memory_scope(scope, scope_id, embed_model, embed_dim, schema_ver, created_at)
     VALUES (?, ?, ?, ?, 1, ?)`,
    [scope, scopeId, embedModel, EMBED_DIM, now],
  );

  return {
    scope,
    scope_id: scopeId,
    embed_model: embedModel,
    embed_dim: EMBED_DIM,
    schema_ver: 1,
    created_at: now,
  };
}

// ── Adapter connection cache (singleton map keyed by resolved path) ────────────

const adapterCache = new Map<string, StoreAdapter>();

/**
 * Return a cached StoreAdapter for the given `dbPath`, or open a new
 * connection and cache it.
 *
 * The caller is responsible for resolving tilde/relative paths before
 * calling (e.g. via `expandTilde` + `path.resolve`).
 */
export async function getDb(dbPath: string): Promise<StoreAdapter> {
  const cached = adapterCache.get(dbPath);
  if (cached) return cached;
  const adapter = await openDb(dbPath);
  adapterCache.set(dbPath, adapter);
  return adapter;
}

/**
 * Open a read-only WAL connection (for federated recall from non-primary stores).
 */
export async function openDbReadOnly(dbPath: string): Promise<StoreAdapter> {
  // BL-41: expand ~ at the sink (mirrors openDb).
  dbPath = expandDbPath(dbPath);
  const { createStoreAdapter } = await import('@adhd/sox-store-adapter');
  // BL-391: allowFtsInReadonly is required — without it, federated recall's
  // BM25 arm is dead on Turso. Turso's native readonly connect option (and,
  // independently, `PRAGMA query_only=ON`) both make `fts_match`/`fts_score`
  // fail with a write-shaped error even though the query is a pure SELECT —
  // a genuine engine limitation, not a missing `index_method` experimental
  // flag (that flag is unconditionally on for every Turso connection; see
  // TursoAdapterImpl.connect()). On SqliteAdapter this option is a no-op —
  // SQLite's native readonly already coexists fine with FTS5.
  const adapter = await createStoreAdapter({ dbPath, readonly: true, allowFtsInReadonly: true });

  // Load sqlite-vec extension only for adapters without native vector support.
  // BL-323: named export only — see dropVec0ViaBetterSqlite3() above.
  if (!adapter.capabilities.nativeVectors) {
    const { load: loadSqliteVec } = await import('sqlite-vec');
    const rawDb = (adapter as SqliteAdapter).unwrap();
    loadSqliteVec(rawDb);
  }

  // WAL pragma needed for read-only connections.
  await adapter.pragmaSet('journal_mode', 'WAL');
  await adapter.pragmaSet('busy_timeout', 3000);
  // BL-391: `query_only` is intentionally NOT set here anymore. On Turso it
  // blocks `fts_match`/`fts_score` exactly like native readonly does
  // (`Parse error: Cannot execute write statement in query_only mode`,
  // measured empirically) — it is not a safe belt-and-suspenders addition on
  // this backend. Write protection instead comes from `allowFtsInReadonly`'s
  // application-level guard on TursoAdapterImpl (`executeRun`/`exec`/
  // `transaction` all throw — see `_assertWritable()`), and, on SQLite, from
  // the real OS-level `readonly: true` passed to better-sqlite3 (which was
  // never the problem and needs no additional pragma).
  return adapter;
}

/**
 * Close all cached adapter connections with lease release.
 *
 * Iterates the adapterCache, calls closeDbWithLease on each entry, then clears
 * the cache. Used by the memory-server backend shutdown handler to ensure
 * all write leases are released before process exit.
 */
export async function closeAllAdapters(): Promise<void> {
  for (const [dbPath, adapter] of adapterCache) {
    await closeDbWithLease(adapter, dbPath);
  }
  adapterCache.clear();
}

/**
 * Synchronously wrap a raw better-sqlite3 Database handle as a StoreAdapter.
 * Used as a bridge for memory-core functions that still receive Database.Database
 * but need to pass a StoreAdapter to graph-store APIs (which have been migrated).
 *
 * The returned adapter does NOT own the connection — close() is a no-op.
 * Callers remain responsible for the raw db lifecycle.
 */
export function wrapRawDbAsAdapter(rawDb: Database.Database): StoreAdapter {
  return {
    config: { type: 'sqlite', dbPath: rawDb.name ?? undefined, readonly: rawDb.memory },
    capabilities: { multiprocessWrite: false, nativeVectors: false, concurrentTransactions: false, fts5: true, fts: true, needsWriteSerialization: true },

    async executeGet<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<T | null> {
      const stmt = rawDb.prepare(sql);
      const row = args !== undefined ? stmt.get(...args) : stmt.get();
      return (row as T | null) ?? null;
    },

    async executeAll<T = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<{ columns: string[]; rows: T[] }> {
      const stmt = rawDb.prepare(sql);
      const rows = args !== undefined ? stmt.all(...args) : stmt.all();
      const columns = stmt.columns().map((c: { name: string }) => c.name);
      return { columns, rows: rows as T[] };
    },

    async executeRun(sql: string, args?: unknown[]): Promise<{ rowsAffected: number; lastInsertRowid: number | bigint }> {
      const stmt = rawDb.prepare(sql);
      const info = args !== undefined ? stmt.run(...args) : stmt.run();
      return { rowsAffected: info.changes, lastInsertRowid: info.lastInsertRowid };
    },

    async exec(sql: string): Promise<void> {
      rawDb.exec(sql);
    },

    async pragmaSet(key: string, value: string | number | boolean): Promise<void> {
      const boolVal = typeof value === 'boolean' ? (value ? 1 : 0) : value;
      rawDb.pragma(`${key} = ${boolVal}`);
    },

    async pragmaGet<T = unknown>(key: string): Promise<T> {
      const result = rawDb.pragma(key, { simple: true });
      return result as T;
    },

    async transaction<T>(fn: (tx: import('@adhd/sox-store-adapter').AdapterTransaction) => T | Promise<T>, opts?: import('@adhd/sox-store-adapter').TransactionOptions): Promise<T> {
      const mode = opts?.mode ?? 'deferred';
      const beginSQL = mode === 'exclusive' ? 'BEGIN EXCLUSIVE'
        : mode === 'immediate' ? 'BEGIN IMMEDIATE'
        : mode === 'concurrent' ? 'BEGIN CONCURRENT'
        : 'BEGIN DEFERRED';

      rawDb.exec(beginSQL);
      const tx = {
        async executeGet<T2 = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<T2 | null> {
          const stmt = rawDb.prepare(sql);
          const row = args !== undefined ? stmt.get(...args) : stmt.get();
          return (row as T2 | null) ?? null;
        },
        async executeAll<T2 = Record<string, unknown>>(sql: string, args?: unknown[]): Promise<{ columns: string[]; rows: T2[] }> {
          const stmt = rawDb.prepare(sql);
          const rows = args !== undefined ? stmt.all(...args) : stmt.all();
          const columns = stmt.columns().map((c: { name: string }) => c.name);
          return { columns, rows: rows as T2[] };
        },
        async executeRun(sql: string, args?: unknown[]): Promise<{ rowsAffected: number; lastInsertRowid: number | bigint }> {
          const stmt = rawDb.prepare(sql);
          const info = args !== undefined ? stmt.run(...args) : stmt.run();
          return { rowsAffected: info.changes, lastInsertRowid: info.lastInsertRowid };
        },
        async exec(sql: string): Promise<void> { rawDb.exec(sql); },
      };
      try {
        const result = await fn(tx);
        rawDb.exec('COMMIT');
        return result;
      } catch (err) {
        try { rawDb.exec('ROLLBACK'); } catch { /* ignore */ }
        throw err;
      }
    },

    async executeMany(stmts: { sql: string; args?: unknown[] }[]): Promise<{ rowsAffected: number; lastInsertRowid: number | bigint }[]> {
      return stmts.map(({ sql, args }) => {
        const stmt = rawDb.prepare(sql);
        const info = args !== undefined ? stmt.run(...args) : stmt.run();
        return { rowsAffected: info.changes, lastInsertRowid: info.lastInsertRowid };
      });
    },

    async close(): Promise<void> {
      // no-op — the raw db lifecycle is managed by the caller
    },

    unwrap(): unknown {
      return rawDb;
    },
  };
}
