/**
 * FTS dialect implementations for store-adapter.
 *
 * Provides two dialect implementations:
 * - SqliteFTS5Dialect — for SQLite FTS5 virtual tables (sqlite-vec stores)
 * - TursoFTSDialect — for Turso/libSQL Tantivy-based FTS indexes
 *
 * Plus the createFTSDialect factory.
 */
import type { FTSDialect } from './types.js';

// ── Re-export types ───────────────────────────────────────────────────────────

export type { FTSDialect } from './types.js';

// ── SqliteFTS5Dialect ─────────────────────────────────────────────────────────

/**
 * FTSDialect for SQLite FTS5 virtual tables.
 *
 * - FTS5 uses `CREATE VIRTUAL TABLE ... USING fts5(...)` — schema-level DDL
 *   managed separately by graph-store's FTS_DDL constant.
 * - MATCH queries use the `fts_node MATCH ?` syntax.
 * - Ranking is exposed via the built-in `rank` column on the FTS virtual table.
 */
export class SqliteFTS5Dialect implements FTSDialect {
  readonly supported = true;
  readonly dialect = 'sqlite' as const;

  /**
   * FTS5 DDL is schema-level (CREATE VIRTUAL TABLE) and is handled by
   * graph-store's FTS_DDL constant, not per-column. This returns empty
   * for the general DDL interface; the caller uses the pre-defined FTS_DDL.
   */
  createIndexDDL(_table: string, _columns: string[], _weights?: Record<string, number>): string {
    return '';
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
}

// ── TursoFTSDialect ───────────────────────────────────────────────────────────

/**
 * FTSDialect for Turso/libSQL using Tantivy-based FTS indexes.
 *
 * - Indexes are created via `CREATE INDEX ... USING fts(...) WITH (weights = '...')`.
 * - Matching uses the `fts_match(column, query)` function.
 * - Scoring uses the `fts_score(column, query)` function.
 * - Highlighting uses `fts_highlight(column, open_tag, close_tag, query)`.
 */
export class TursoFTSDialect implements FTSDialect {
  readonly supported = true;
  readonly dialect = 'turso' as const;

  /**
   * Generate DDL to create a Tantivy FTS index.
   *
   * Example output:
   * ```sql
   * CREATE INDEX IF NOT EXISTS idx_fts_node ON "node" USING fts ("content", "name", "summary")
   *   WITH (weights = 'content=1.0,name=1.0,summary=1.0')
   * ```
   */
  createIndexDDL(table: string, columns: string[], weights?: Record<string, number>): string {
    const colList = columns.map((c) => `"${c}"`).join(', ');
    let ddl = `CREATE INDEX IF NOT EXISTS idx_fts_${table} ON "${table}" USING fts (${colList})`;
    if (weights && Object.keys(weights).length > 0) {
      const w = Object.entries(weights)
        .map(([k, v]) => `${k}=${v}`)
        .join(',');
      ddl += ` WITH (weights = '${w}')`;
    }
    return ddl;
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
