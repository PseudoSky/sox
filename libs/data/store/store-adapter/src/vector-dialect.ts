/**
 * Vector dialect implementations for store-adapter.
 *
 * Provides two dialect implementations:
 * - SqliteVecDialect — for sqlite-vec (SQLite with the vec0 extension)
 * - TursoVectorDialect — for Turso/libsql (with native vector support)
 *
 * Plus utility functions vecToJson, vecToBlob, topKQueryCore,
 * and the createVectorDialect factory.
 */
import type { VectorDialect, VectorMetric } from './types.js';

// ── Re-export types ───────────────────────────────────────────────────────────

export type { VectorDialect, VectorMetric } from './types.js';

// ── Serialisation helpers ─────────────────────────────────────────────────────

/**
 * Convert a Float32Array to a JSON array string.
 * Each value is formatted to 8 decimal places.
 *
 * This is the canonical format for sqlite-vec MATCH queries.
 */
export function vecToJson(vec: Float32Array): string {
  const arr: number[] = Array.from(vec);
  return '[' + arr.map((v) => v.toFixed(8)).join(',') + ']';
}

/**
 * Convert a Float32Array to a Node.js Buffer (raw bytes, big-endian float32).
 *
 * This is the canonical format for storing vectors in BLOB columns.
 * Compatible with Buffer.from(vec.buffer).
 */
export function vecToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

// ── Core query builder ────────────────────────────────────────────────────────

/**
 * Build a parameterised top-K similarity search query.
 *
 * This is a stateless helper used by both dialect implementations.
 * Returns { sql, args } where `args` contains serialised vector bytes
 * or JSON, depending on the dialect.
 *
 * The returned SQL uses `?` placeholders to avoid SQL injection.
 */
export function topKQueryCore(
  table: string,
  column: string,
  queryVec: number[],
  k: number,
  metric: VectorMetric,
): { sql: string; args: unknown[] } {
  // Shared column/table name sanitisation is caller's responsibility.
  const vec = new Float32Array(queryVec);
  const vecJson = vecToJson(vec);

  // We return a template structure that each dialect customises.
  // This core version is the sqlite-vec pattern (MATCH + k).
  const distanceOrder = metric === 'dot' ? 'DESC' : 'ASC';
  return {
    sql: `SELECT node_id, distance FROM "${table}" WHERE ${column} MATCH ? AND k = ? ORDER BY distance ${distanceOrder}`,
    args: [vecJson, k],
  };
}

// ── SqliteVecDialect ──────────────────────────────────────────────────────────

/**
 * VectorDialect for sqlite-vec (SQLite with the vec0 extension).
 *
 * - vec0 virtual tables ARE the vector index (no separate index DDL needed).
 * - Query vector is passed as a JSON array string via MATCH.
 * - Distance is returned as a computed column named `distance`.
 */
export class SqliteVecDialect implements VectorDialect {
  /**
   * Return the vec0 column type for the given dimensionality.
   * e.g. `FLOAT[768]`
   */
  vectorColumnType(dim: number): string {
    return `FLOAT[${dim}]`;
  }

  /**
   * Return the distance expression for a SELECT query.
   * In sqlite-vec, the vec0 table exposes `distance` as a computed column
   * when queried via MATCH — no explicit expression is needed.
   */
  distanceExpr(_column: string, _queryVec: number[]): string {
    return 'distance';
  }

  /**
   * Generate DDL to create a vec0 virtual table.
   *
   * Example output:
   * ```sql
   * CREATE VIRTUAL TABLE IF NOT EXISTS "vec_mymodel" USING vec0(
   *   node_id INTEGER PRIMARY KEY,
   *   embedding FLOAT[768] distance_metric=cosine
   * )
   * ```
   *
   * BL-392: vec0 defaults an unqualified column to L2 (Euclidean) distance.
   * Every real call site in this codebase (recall.ts, neardup.ts, db.ts)
   * requests 'cosine' — declaring `distance_metric=cosine` explicitly here
   * makes the engine actually compute what the code has always claimed.
   * This is bound once, at table-creation time; vec0 has no per-query
   * override (see topKQuery below).
   */
  createTableDDL(table: string, column: string, dim: number): string {
    const colType = this.vectorColumnType(dim);
    return `CREATE VIRTUAL TABLE IF NOT EXISTS "${table}" USING vec0(node_id INTEGER PRIMARY KEY, ${column} ${colType} distance_metric=cosine)`;
  }

  /**
   * For sqlite-vec, the vec0 virtual table IS the index.
   * No separate index creation is needed — this returns an empty string.
   */
  createIndexDDL(_table: string, _column: string, _metric: VectorMetric): string {
    return '';
  }

  /**
   * Build a top-K query for sqlite-vec.
   *
   * Uses the vec0 MATCH operator with a JSON-formatted query vector
   * and the k-nearest-neighbour limit.
   */
  topKQuery(
    table: string,
    column: string,
    queryVec: number[],
    k: number,
    metric: VectorMetric,
  ): { sql: string; args: unknown[] } {
    // BL-392: vec0's distance metric is bound at CREATE TABLE time
    // (`distance_metric=cosine`, see createTableDDL) — sqlite-vec has no
    // query-time override for MATCH/KNN queries. Every vec_node table this
    // codebase creates now declares cosine, and every call site (recall.ts,
    // neardup.ts) only ever requests 'cosine'. Silently accepting 'l2'/'dot'
    // here would compute cosine distance while claiming a different metric
    // was used — fail loudly instead of lying.
    if (metric !== 'cosine') {
      throw new Error(
        `SqliteVecDialect.topKQuery: metric '${metric}' is not supported. ` +
        `vec0's distance metric is fixed at table-creation time via ` +
        `distance_metric=cosine (see createTableDDL) and cannot be ` +
        `overridden per query — only 'cosine' is valid.`,
      );
    }
    const vec = new Float32Array(queryVec);
    const vecJson = vecToJson(vec);
    // metric is narrowed to the 'cosine' literal by the guard above, so this
    // is always 'ASC' now — widen back to VectorMetric so the (now
    // unreachable but intentionally-retained, see BL-392 spec) 'dot' branch
    // still typechecks. Left as dead-but-harmless: simplifying this
    // ASC/DESC selection is out of scope for BL-392.
    const distanceOrder = (metric as VectorMetric) === 'dot' ? 'DESC' : 'ASC';
    // BL-367: exactly-tied distances (real, not hypothetical — orthogonal
    // candidates against a query vector routinely tie exactly) resolve to
    // vec0's own undocumented KNN iteration order, which was observed to
    // differ from Turso's tie order on an identical corpus. vec0 KNN
    // queries reject a compound `ORDER BY distance, <col>` (rejects with
    // "Only a single 'ORDER BY distance' clause is allowed on vec0 KNN
    // queries" — verified empirically), so the tiebreak CANNOT be pushed
    // into this SQL. Callers (recall.ts) apply a stable secondary sort on
    // `node_id` in JS after fetching instead — see its doc comment.
    return {
      sql: `SELECT v.node_id, v.distance FROM "${table}" v JOIN node n ON n.rowid = v.node_id WHERE v.${column} MATCH ? AND k = ? AND __PLACEHOLDER__ ORDER BY v.distance ${distanceOrder}`,
      args: [vecJson, k],
    };
  }

}

// ── TursoVectorDialect ────────────────────────────────────────────────────────

/**
 * VectorDialect for Turso/libsql with native vector support.
 *
 * - Vector columns are declared as `F32_BLOB(dim)`.
 * - A separate vector index is created via `libsql_vector_descr()`.
 * - Distance functions: `vector_distance_cos`, `vector_distance_l2`, `vector_distance_dot`.
 */
export class TursoVectorDialect implements VectorDialect {
  /**
   * Return the Turso/libsql F32_BLOB column type for the given dimensionality.
   * e.g. `F32_BLOB(768)`
   */
  vectorColumnType(dim: number): string {
    return `F32_BLOB(${dim})`;
  }

  /**
   * Return the distance expression for a SELECT query.
   *
   * Uses Turso's built-in vector_distance_* functions with a parameterised
   * vector blob as the second argument.
   */
  distanceExpr(column: string, queryVec: number[]): string {
    const vec = new Float32Array(queryVec);
    const hex = Buffer.from(vec.buffer).toString('hex');
    // Inline the vector as a hex literal blob since Turso does not support
    // bound parameter blobs in vector_distance() arguments (libsql limitation).
    return `vector_distance_cos(${column}, X'${hex}')`;
  }

  /**
   * Generate DDL to create a table with a vector column.
   *
   * Example output:
   * ```sql
   * CREATE TABLE IF NOT EXISTS "vec_mymodel" (
   *   node_id INTEGER PRIMARY KEY,
   *   embedding F32_BLOB(768)
   * )
   * ```
   */
  createTableDDL(table: string, column: string, dim: number): string {
    const colType = this.vectorColumnType(dim);
    return `CREATE TABLE IF NOT EXISTS "${table}" (node_id INTEGER PRIMARY KEY, ${column} ${colType})`;
  }

  /**
   * Generate DDL to create a vector index on the given column.
   *
   * Uses a simple `CREATE INDEX ON table(column)` syntax — Turso/libSQL
   * infers the index type from the F32_BLOB column type.
   *
   * Example output:
   * ```sql
   * CREATE INDEX IF NOT EXISTS "idx_vec_node_embedding"
   *   ON "vec_node" ("embedding")
   * ```
   */
  createIndexDDL(table: string, column: string, _metric: VectorMetric): string {
    return `CREATE INDEX IF NOT EXISTS "idx_${table}_${column}" ON "${table}" ("${column}")`;
  }

  /**
   * Build a top-K query for Turso/libsql.
   *
   * Uses the vector_distance_cos function in ORDER BY with a limit,
   * which Turso's query planner optimises via the vector index.
   */
  topKQuery(
    table: string,
    column: string,
    queryVec: number[],
    _k: number,
    metric: VectorMetric,
  ): { sql: string; args: unknown[] } {
    const vec = new Float32Array(queryVec);
    const hex = Buffer.from(vec.buffer).toString('hex');

    const distFn =
      metric === 'l2'
        ? 'vector_distance_l2'
        : metric === 'dot'
          ? 'vector_distance_dot'
          : 'vector_distance_cos';

    const distanceOrder = metric === 'dot' ? 'DESC' : 'ASC';
    const hexBlob = `X'${hex}'`;

    // BL-367: unlike vec0, Turso's plain ORDER BY happily accepts a
    // compound key, so the tiebreak COULD live here — but it is applied
    // uniformly in JS by the caller instead (see SqliteVecDialect.topKQuery
    // for why sqlite can't do it in SQL), so both dialects get identical
    // tie-break behaviour from one place rather than two different
    // mechanisms that could drift apart.
    return {
      sql: `SELECT v.node_id, ${distFn}(v.${column}, ${hexBlob}) AS distance FROM "${table}" v JOIN node n ON n.rowid = v.node_id WHERE __PLACEHOLDER__ ORDER BY distance ${distanceOrder}`,
      args: [],
    };
  }

}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create the appropriate VectorDialect for the given adapter type.
 *
 * @param type - 'sqlite' for SqliteVecDialect (sqlite-vec),
 *               'turso' for TursoVectorDialect (Turso/libsql native vectors)
 * @returns A VectorDialect instance matching the given type.
 */
export function createVectorDialect(type: 'sqlite' | 'turso'): VectorDialect {
  if (type === 'turso') {
    return new TursoVectorDialect();
  }
  return new SqliteVecDialect();
}
