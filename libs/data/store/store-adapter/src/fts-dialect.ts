/**
 * FTS dialect implementations for store-adapter.
 *
 * This is the SINGLE place that knows how full-text search works per backend:
 * creation DDL, legacy-residue detection/teardown for a store migrated from
 * the other backend, and query construction (MATCH/score clauses). Callers
 * (memory-core's db.ts / recall.ts) ask the dialect — they never branch on
 * `adapter.config.type` for FTS decisions themselves. Adding a third backend
 * means implementing FTSDialect once, here.
 *
 * Provides two dialect implementations:
 * - SqliteFTS5Dialect — for SQLite FTS5 virtual tables (sqlite-vec stores)
 * - TursoFTSDialect — for Turso/libSQL Tantivy-based FTS indexes
 *
 * Plus the createFTSDialect factory.
 *
 * ── Backend mechanisms, side by side ────────────────────────────────────────
 *
 * SQLite FTS5:
 *   - `fts_node` is a real FTS5 virtual table (external-content, `content='node'`,
 *     `content_rowid='rowid'`) plus 4 shadow tables SQLite manages internally
 *     (`fts_node_data`/`_idx`/`_docsize`/`_config`).
 *   - Kept in sync by 3 triggers on `node`: `fts_node_ai` (AFTER INSERT),
 *     `fts_node_ad` (AFTER DELETE), `fts_node_au` (AFTER UPDATE).
 *   - Queried via `fts_node MATCH ?`, ranked via the built-in `rank` column.
 *
 * Turso/libSQL Tantivy FTS (`@tursodatabase/database@0.7.1`):
 *   - No shadow table, no triggers — a single native index directly on `node`:
 *     `CREATE INDEX idx_node ON "node" USING fts (...)`.
 *   - Matched via `fts_match(col, col, ..., query)`, scored via `fts_score(...)`.
 *   - REQUIRES the connection to be opened with `experimental: ['index_method']`
 *     (verified empirically, 2026-07-30 — `CREATE INDEX ... USING fts` throws
 *     `Parse error: index method is an experimental feature` without it, and
 *     — critically — so does every subsequent `fts_match`/`fts_score` query,
 *     even against an index created by a different, correctly-flagged
 *     connection. The flag is a connect-time-only requirement of the RUNTIME
 *     connection, not a one-shot migration step; there is no PRAGMA that
 *     enables it after connect(). This lives in TursoAdapterImpl.connect()
 *     (turso-adapter.ts), not here.
 *   - Turso does NOT execute AFTER INSERT/UPDATE/DELETE trigger bodies that
 *     reference objects it cannot resolve (verified empirically: a `node`
 *     table carrying the 3 SQLite FTS5 triggers above, opened via Turso,
 *     accepts INSERT/UPDATE/DELETE without error — the trigger body is simply
 *     never invoked, not even attempted). This is why a store migrated from
 *     SQLite to Turso without residue cleanup APPEARS to work; it is an
 *     accidental, undocumented gap in Turso's trigger support, not a
 *     guarantee — a future Turso version that executes trigger bodies would
 *     break every write on such a store instantly. Residue cleanup below is
 *     not optional just because writes currently happen to survive it.
 *   - `DROP TABLE`/`DROP TRIGGER` issued directly through the Turso engine
 *     against fts5 objects it doesn't understand silently "succeeds" (no
 *     error) while leaving the object in `sqlite_master` untouched (verified
 *     empirically — the same silent-no-op behavior already documented for
 *     vec0 DROPs in db.ts). Residue cleanup MUST go through better-sqlite3.
 */
import type { FTSDialect } from './types.js';

// ── Re-export types ───────────────────────────────────────────────────────────

export type { FTSDialect } from './types.js';

// ── Shared FTS5 object names (SQLite side) ─────────────────────────────────────

/** The FTS5 virtual table + its 4 SQLite-managed shadow tables. */
const FTS5_TABLE_NAMES = ['fts_node', 'fts_node_data', 'fts_node_idx', 'fts_node_docsize', 'fts_node_config'];
/** The 3 content-sync triggers on `node` (see graph-store's FTS_TRIGGERS). */
const FTS5_TRIGGER_NAMES = ['fts_node_ai', 'fts_node_ad', 'fts_node_au'];

// ── Shared Tantivy FTS object names (Turso side) ────────────────────────────────

/** Turso's native FTS index name, plus the internal directory objects it
 *  provisions alongside it (`__turso_internal_fts_dir_<index>` table and
 *  `__turso_internal_fts_dir_<index>_key` index — verified empirically by
 *  inspecting `sqlite_master` after `CREATE INDEX idx_fts_node ... USING fts`). */
function tursoFtsIndexName(table: string): string {
  return `idx_fts_${table}`;
}
function tursoFtsInternalNames(table: string): string[] {
  const idx = tursoFtsIndexName(table);
  return [idx, `__turso_internal_fts_dir_${idx}`, `__turso_internal_fts_dir_${idx}_key`];
}

// ── SqliteFTS5Dialect ─────────────────────────────────────────────────────────

/**
 * FTSDialect for SQLite FTS5 virtual tables.
 *
 * - FTS5 uses `CREATE VIRTUAL TABLE ... USING fts5(...)` — the canonical DDL
 *   is graph-store's `FTS_DDL`/`FTS_TRIGGERS` constants (re-exported via
 *   memory-core's schema.ts), passed in via `createIndexDDL`'s `sqliteDDL`
 *   param since store-adapter cannot depend on graph-store.
 * - MATCH queries use the `fts_node MATCH ?` syntax.
 * - Ranking is exposed via the built-in `rank` column on the FTS virtual table.
 */
export class SqliteFTS5Dialect implements FTSDialect {
  readonly supported = true;
  readonly dialect = 'sqlite' as const;
  readonly supportsShadowTable = true;

  /**
   * Returns the caller-supplied SQLite FTS5 DDL verbatim, in order (typically
   * `[FTS_DDL, FTS_TRIGGERS]`). Returns `[]` if no DDL was supplied — callers
   * that don't have it (e.g. dialect-only unit tests) get a safe no-op rather
   * than a guess at the schema.
   */
  createIndexDDL(
    _table: string,
    _columns: string[],
    _weights?: Record<string, number>,
    sqliteDDL?: readonly string[],
  ): string[] {
    return sqliteDDL ? [...sqliteDDL] : [];
  }

  /**
   * A store previously opened by Turso leaves its native FTS index
   * (`idx_fts_<table>` + Turso's internal directory table/index) behind.
   * These are harmless to better-sqlite3 as opaque `sqlite_master` rows, but
   * cleaning them up keeps the schema honest and avoids a stale index name
   * colliding with a future `CREATE INDEX IF NOT EXISTS idx_fts_<table>`
   * issued by a different dialect.
   */
  legacyResidueNames(table: string): string[] {
    return tursoFtsInternalNames(table);
  }

  dropLegacyDDL(table: string): string[] {
    const [idx, dirTable, dirKeyIdx] = tursoFtsInternalNames(table);
    return [
      `DROP INDEX IF EXISTS "${dirKeyIdx}"`,
      `DROP TABLE IF EXISTS "${dirTable}"`,
      `DROP INDEX IF EXISTS "${idx}"`,
    ];
  }

  /**
   * Build a MATCH clause for FTS5.
   *
   * Example output:
   * ```sql
   * fts_node MATCH ?
   * ```
   */
  matchClause(_columns: string[], queryParam: string): { sql: string } {
    return { sql: `fts_node MATCH ${queryParam}` };
  }

  /**
   * Build a score expression for FTS5.
   *
   * FTS5 exposes `rank` as a computed column on the virtual table.
   *
   * Example output:
   * ```sql
   * fts_node.rank
   * ```
   */
  scoreClause(_columns: string[], _queryParam: string): string {
    return 'fts_node.rank';
  }

  /**
   * FTS5 bareword queries default to AND between tokens — build an explicit
   * OR of quoted tokens instead, so multi-term queries behave like a
   * "any term matches" text-search signal (matching Turso's default and
   * recall's intent). See the BL-367 doc comment on `FTSDialect.buildMatchQuery`.
   */
  buildMatchQuery(tokens: string[]): string {
    return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
  }
}

// ── TursoFTSDialect ───────────────────────────────────────────────────────────

/**
 * FTSDialect for Turso/libSQL using Tantivy-based FTS indexes.
 *
 * - Indexes are created via `CREATE INDEX ... USING fts(...) WITH (weights = '...')`.
 * - Matching uses the `fts_match(column, query)` function.
 * - Scoring uses the `fts_score(column, query)` function.
 * - Highlighting uses `fts_highlight(column, open_tag, close_tag, query)`.
 *
 * REQUIRES the underlying connection to have been opened with
 * `experimental: ['index_method']` — see the module-level doc comment above.
 */
export class TursoFTSDialect implements FTSDialect {
  readonly supported = true;
  readonly dialect = 'turso' as const;
  readonly supportsShadowTable = false;

  /**
   * Generate DDL to create a Tantivy FTS index. `sqliteDDL` is ignored — this
   * dialect generates its own DDL from `columns`/`weights`.
   *
   * Example output:
   * ```sql
   * CREATE INDEX IF NOT EXISTS idx_fts_node ON "node" USING fts ("content", "name", "summary")
   *   WITH (weights = 'content=1.0,name=1.0,summary=1.0')
   * ```
   */
  createIndexDDL(
    table: string,
    columns: string[],
    weights?: Record<string, number>,
    _sqliteDDL?: readonly string[],
  ): string[] {
    const colList = columns.map((c) => `"${c}"`).join(', ');
    let ddl = `CREATE INDEX IF NOT EXISTS ${tursoFtsIndexName(table)} ON "${table}" USING fts (${colList})`;
    if (weights && Object.keys(weights).length > 0) {
      const w = Object.entries(weights)
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
      ddl += ` WITH (weights = '${w}')`;
    }
    return [ddl];
  }

  /**
   * A store previously opened by SQLite leaves the FTS5 virtual table, its 4
   * shadow tables, and its 3 content-sync triggers behind. Turso cannot
   * instantiate the fts5 module (`no such table: fts_node` the moment
   * anything tries to read it) and — per the module doc comment — silently
   * never fires the triggers, so writes appear to succeed while the residue
   * quietly rots. Must be cleaned up regardless.
   */
  legacyResidueNames(_table: string): string[] {
    return [...FTS5_TRIGGER_NAMES, ...FTS5_TABLE_NAMES];
  }

  /** Triggers first (they reference the tables), then the virtual table,
   *  then its shadow tables. `DROP TABLE IF EXISTS fts_node` cascades to the
   *  4 shadow tables under real SQLite/FTS5 semantics, but they're listed
   *  explicitly too so this is correct even if a partial-residue store is
   *  missing the virtual table itself but still carries orphaned shadows. */
  dropLegacyDDL(_table: string): string[] {
    return [
      ...FTS5_TRIGGER_NAMES.map((t) => `DROP TRIGGER IF EXISTS "${t}"`),
      ...FTS5_TABLE_NAMES.map((t) => `DROP TABLE IF EXISTS "${t}"`),
    ];
  }

  /**
   * Build a MATCH clause for Turso Tantivy FTS.
   *
   * Example output:
   * ```sql
   * fts_match("content", "name", "summary", 'query')
   * ```
   *
   * Columns are quoted to handle reserved-word column names.
   */
  matchClause(columns: string[], queryParam: string): { sql: string } {
    const colList = columns.map((c) => `"${c}"`).join(', ');
    return { sql: `fts_match(${colList}, ${queryParam})` };
  }

  /**
   * Build a score expression for Turso Tantivy FTS.
   *
   * Example output:
   * ```sql
   * fts_score("content", "name", "summary", 'query')
   * ```
   */
  scoreClause(columns: string[], queryParam: string): string {
    const colList = columns.map((c) => `"${c}"`).join(', ');
    return `fts_score(${colList}, ${queryParam})`;
  }

  /**
   * Tantivy's `fts_match` already matches on any token present (effectively
   * OR by default) — but building the SAME explicit `"tok1" OR "tok2"` form
   * here anyway makes both dialects' boolean semantics identical and
   * documented, rather than SQLite's explicit-OR being paired with an
   * implicit, undocumented default on this side. See the BL-367 doc comment
   * on `FTSDialect.buildMatchQuery`.
   */
  buildMatchQuery(tokens: string[]): string {
    return tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
  }
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create the appropriate FTSDialect for the given adapter type.
 *
 * @param type - 'sqlite' for SqliteFTS5Dialect (SQLite FTS5),
 *               'turso' for TursoFTSDialect (Turso/libSQL Tantivy FTS)
 * @returns An FTSDialect instance matching the given type.
 */
export function createFTSDialect(type: 'sqlite' | 'turso'): FTSDialect {
  if (type === 'turso') {
    return new TursoFTSDialect();
  }
  return new SqliteFTS5Dialect();
}
