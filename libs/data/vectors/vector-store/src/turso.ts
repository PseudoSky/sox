import { buildNodeFilterClause } from '@adhd/sox-graph-store';
import { createVectorDialect, vecToBlob } from '@adhd/sox-store-adapter';
import type { StoreAdapter } from '@adhd/sox-store-adapter';

import type { VecFilter, VectorSpace } from './index.js';
import { SpaceInvariantError, StorageError } from './index.js';

// ── Public types ─────────────────────────────────────────────────────────────

/**
 * The async mirror of `VectorBackend` ([iface:vector-backend] in index.ts,
 * pinned — this file must never change it). Every method has the identical
 * name and semantics as its synchronous counterpart; only the return type
 * changes (`T` -> `Promise<T>`, `Iterable<T>` -> `AsyncIterable<T>`).
 *
 * This interface exists because Turso's `@tursodatabase/database` driver is
 * genuinely async (real network/IPC round-trips even against a local file —
 * see `TursoAdapter`), and unlike `LanceDbVectorBackend` (which bridges an
 * async driver to the sync `VectorBackend` shape via a `synckit`
 * worker_threads RPC), a Turso backend must NOT spin up a second connection
 * to the same database file: `synckit`'s worker would open its own handle,
 * violating the "one file, one writer" invariant this store depends on
 * elsewhere (see WriteQueue / needsWriteSerialization in
 * `@adhd/sox-store-adapter`). So `TursoVectorBackend` stays async and
 * in-process, reusing the caller's own `StoreAdapter` connection directly —
 * which means it cannot satisfy the synchronous `VectorBackend` interface,
 * hence this separate, additive, async-native contract.
 */
export interface AsyncVectorBackend {
  ensureSpace(space: VectorSpace): Promise<void>;
  listSpaces(): Promise<VectorSpace[]>;
  upsert(id: number, vec: Float32Array, space: VectorSpace): Promise<void>;
  delete(id: number, modelId: string): Promise<void>;
  get(id: number, modelId: string): Promise<Float32Array | null>;
  knn(
    query: Float32Array,
    space: VectorSpace,
    k: number,
    filter?: VecFilter,
  ): Promise<Array<{ id: number; score: number }>>;
  iter(
    modelId: string,
    opts?: { filter?: VecFilter },
  ): AsyncIterable<{ id: number; vec: Float32Array }>;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

// Mirrors index.ts's `sanitizeModelId`/`tableName` exactly (kept private and
// duplicated rather than exported+shared from index.ts, since index.ts's
// versions are unexported internals of the pinned sync module and this file
// must not widen that module's surface to satisfy an async sibling).
function sanitizeModelId(modelId: string): string {
  return modelId.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'default';
}

function tableName(modelId: string): string {
  return `vec_${sanitizeModelId(modelId)}`;
}

function blobToFloat32(buf: Buffer): Float32Array {
  // Copy into a fresh, correctly-aligned ArrayBuffer rather than viewing the
  // driver's own Buffer in place: `@tursodatabase/database` BLOB columns are
  // not guaranteed to hand back a buffer whose `byteOffset` is a multiple of
  // 4 (Float32.BYTES_PER_ELEMENT), and constructing a Float32Array directly
  // over a misaligned offset throws `RangeError: start offset ... is not a
  // multiple of BYTES_PER_ELEMENT`. `Uint8Array#slice` copies the bytes into
  // a new, zero-offset buffer, which is always safely alignable.
  const copy = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength).slice();
  return new Float32Array(copy.buffer, copy.byteOffset, copy.byteLength / 4);
}

/**
 * Guard the `TursoVectorBackend` constructor. Mirrors index.ts's
 * `requireSqliteHandle` in tone and intent (same BL-364 lesson: a raw driver
 * handle or the wrong adapter kind must fail here, by name, not three calls
 * deeper as an opaque TypeError or a `no such table` SQL error) — but checks
 * for the OPPOSITE misconfiguration: this backend requires a native-vector
 * (Turso) adapter, not a sqlite one.
 */
function requireTursoAdapter(adapter: StoreAdapter): StoreAdapter {
  if (adapter === null || typeof adapter !== 'object' || adapter.capabilities === undefined) {
    throw new StorageError(
      `TursoVectorBackend requires a StoreAdapter, not a raw driver handle — ` +
        `the value passed has no \`capabilities\`. Wrap the handle with ` +
        `createStoreAdapter({ dbPath }) (or createTursoAdapter(...)), or use ` +
        `openTursoVectorStore(adapter, { dim, modelId }).`,
    );
  }
  if (!adapter.capabilities.nativeVectors) {
    throw new StorageError(
      `TursoVectorBackend requires a Turso-backed StoreAdapter (native ` +
        `F32_BLOB vector columns + vector_distance_* functions) — got an ` +
        `adapter with capabilities.nativeVectors=false (e.g. SqliteAdapter). ` +
        `Use SqliteVectorBackend (sqlite-vec/vec0) or openVectorStore() for a ` +
        `sqlite-backed store instead.`,
    );
  }
  return adapter;
}

// ── TursoVectorBackend ───────────────────────────────────────────────────────

/**
 * Async, Turso-native implementation of the vector store's storage contract.
 *
 * Unlike `SqliteVectorBackend` (sqlite-vec/vec0, synchronous, brute-force
 * cosine over a virtual table) and `LanceDbVectorBackend` (real HNSW/IVF-PQ
 * ANN via a synckit worker bridge), this backend talks directly — and only —
 * to the async `StoreAdapter` the caller already owns, using
 * `@adhd/sox-store-adapter`'s `TursoVectorDialect` for every piece of
 * backend-specific SQL (column type, DDL, index DDL, and the top-K query
 * shape). It never opens a second connection to the database file.
 *
 * Storage shape: one ordinary table per (sanitized) modelId, named like
 * `SqliteVectorBackend`'s (`vec_<modelId>`), with an `F32_BLOB(dim)` vector
 * column — see `TursoVectorDialect.createTableDDL`. A `_vector_spaces`
 * metadata table (identical name/shape to `SqliteVectorBackend`'s) records
 * the (modelId, dim) pairs that have been `ensureSpace`d, so `listSpaces()`
 * doesn't have to introspect `sqlite_master` and guess.
 */
export class TursoVectorBackend implements AsyncVectorBackend {
  private readonly adapter: StoreAdapter;
  private readonly dialect = createVectorDialect('turso');

  constructor(adapter: StoreAdapter) {
    this.adapter = requireTursoAdapter(adapter);
  }

  /**
   * Idempotently create the `_vector_spaces` metadata table (first call only,
   * on any instance) and the per-space vector table + index. Safe to call
   * repeatedly for the same space — `CREATE TABLE/INDEX IF NOT EXISTS`
   * throughout, and the metadata row is `INSERT OR IGNORE`d.
   */
  async ensureSpace(space: VectorSpace): Promise<void> {
    try {
      await this.adapter.exec(`
        CREATE TABLE IF NOT EXISTS _vector_spaces (
          model_id TEXT PRIMARY KEY,
          dim INTEGER NOT NULL,
          created_at TEXT NOT NULL
        )
      `);

      const tbl = tableName(space.modelId);
      await this.adapter.exec(this.dialect.createTableDDL(tbl, 'embedding', space.dim));
      const indexDDL = this.dialect.createIndexDDL(tbl, 'embedding', 'cosine');
      if (indexDDL) {
        await this.adapter.exec(indexDDL);
      }

      await this.adapter.executeRun(
        `INSERT OR IGNORE INTO _vector_spaces(model_id, dim, created_at) VALUES(?, ?, ?)`,
        [space.modelId, space.dim, new Date().toISOString()],
      );
    } catch (err) {
      throw new StorageError(
        `Failed to ensure space ${space.modelId}`,
        err instanceof Error ? err : undefined,
      );
    }
  }

  async listSpaces(): Promise<VectorSpace[]> {
    try {
      const { rows } = await this.adapter.executeAll<{ model_id: string; dim: number }>(
        `SELECT model_id, dim FROM _vector_spaces`,
      );
      return rows.map((r) => ({ modelId: r.model_id, dim: r.dim }));
    } catch {
      return [];
    }
  }

  /**
   * Insert or update the vector for `id` in `space`'s table. Enforces the
   * space invariant ([def:space-invariant]) BEFORE any I/O: a caller handing
   * a vector of the wrong length gets `SpaceInvariantError` synchronously off
   * the returned (still-pending) promise's rejection, never a partially
   * written row.
   */
  async upsert(id: number, vec: Float32Array, space: VectorSpace): Promise<void> {
    if (vec.length !== space.dim) {
      throw new SpaceInvariantError(id, space, vec.length);
    }

    try {
      const tbl = tableName(space.modelId);
      const vecBuf = vecToBlob(vec);

      const updated = await this.adapter.executeRun(
        `UPDATE "${tbl}" SET embedding = ? WHERE node_id = CAST(? AS INTEGER)`,
        [vecBuf, id],
      );
      if (updated.rowsAffected === 0) {
        await this.adapter.executeRun(
          `INSERT INTO "${tbl}"(node_id, embedding) VALUES(CAST(? AS INTEGER), ?)`,
          [id, vecBuf],
        );
      }
    } catch (err) {
      throw new StorageError(
        `Failed to upsert vector for node ${id} in space ${space.modelId}`,
        err instanceof Error ? err : undefined,
      );
    }
  }

  async delete(id: number, modelId: string): Promise<void> {
    try {
      const tbl = tableName(modelId);
      await this.adapter.executeRun(
        `DELETE FROM "${tbl}" WHERE node_id = CAST(? AS INTEGER)`,
        [id],
      );
    } catch (err) {
      // Mirrors SqliteVectorBackend.delete: a table that doesn't exist yet
      // (space never ensured) is not an error for a delete — there is
      // nothing to delete. Real driver errors on an EXISTING table still
      // throw via the catch below, same as upsert/ensureSpace.
      const msg = err instanceof Error ? err.message : String(err);
      if (/no such table/i.test(msg)) return;
      throw new StorageError(
        `Failed to delete vector for node ${id} in space ${modelId}`,
        err instanceof Error ? err : undefined,
      );
    }
  }

  async get(id: number, modelId: string): Promise<Float32Array | null> {
    try {
      const tbl = tableName(modelId);
      const row = await this.adapter.executeGet<{ embedding: Buffer }>(
        `SELECT embedding FROM "${tbl}" WHERE node_id = CAST(? AS INTEGER)`,
        [id],
      );
      if (!row) return null;
      return blobToFloat32(row.embedding);
    } catch {
      return null;
    }
  }

  /**
   * k-nearest-neighbour search via `TursoVectorDialect.topKQuery` (native
   * `vector_distance_cos`, index-accelerated). Both `VecFilter.ids` and
   * `VecFilter.nodeFilter` are compiled into the SQL that fills the
   * dialect's `__PLACEHOLDER__` seam — the exact same seam
   * `libs/memory-core/src/recall.ts` and `neardup.ts` fill — so filtering
   * happens INSIDE the query, before the `k`/`LIMIT` cutoff is applied.
   * This is load-bearing: a post-filter (fetch k, then discard non-matching
   * rows in JS) can return fewer than k matching rows even when plenty
   * exist further out in vector space; pushing the predicate into the WHERE
   * clause does not have that failure mode.
   *
   * `topKQuery`'s `distance` column is `vector_distance_cos` — a genuine
   * DISTANCE (0 = identical, larger = more different), not a similarity.
   * This method converts it to a HIGHER-IS-BETTER score via `1 - distance`
   * (the standard cosine-distance -> cosine-similarity identity for
   * normalized vectors, matching `SqliteVectorBackend`'s
   * `cosineSimilarity()` scale so scores are comparable across backends)
   * before returning.
   */
  async knn(
    query: Float32Array,
    space: VectorSpace,
    k: number,
    filter?: VecFilter,
  ): Promise<Array<{ id: number; score: number }>> {
    const tbl = tableName(space.modelId);
    const { sql: dialectSql, args: dialectArgs } = this.dialect.topKQuery(
      tbl,
      'embedding',
      Array.from(query),
      k,
      'cosine',
    );

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter?.nodeFilter) {
      // Same predicate builder @adhd/sox-graph-store's own queryNodes /
      // countNodes / searchNodes use internally, and the same one
      // SqliteVectorBackend's BruteForceBackend uses for its own
      // `nodeFilter` support — one canonical NodeFilter->SQL translation
      // shared by every caller in this ecosystem, never a second one that
      // could silently diverge (see the `VecFilter.nodeFilter` doc comment
      // in index.ts).
      const { where, params: fParams } = buildNodeFilterClause(filter.nodeFilter, true, 'n');
      if (where) clauses.push(where.replace(/^WHERE /, ''));
      params.push(...fParams);
    }
    if (filter?.ids && filter.ids.length > 0) {
      clauses.push(`v.node_id IN (${filter.ids.map(() => '?').join(',')})`);
      params.push(...filter.ids);
    }

    const filterClause = clauses.length > 0 ? clauses.join(' AND ') : '1=1';
    const knnSql = dialectSql.replace('__PLACEHOLDER__', filterClause) + ' LIMIT ?';
    const knnArgs = [...dialectArgs, ...params, k];

    let rows: Array<{ node_id: number; distance: number }>;
    try {
      const result = await this.adapter.executeAll<{ node_id: number; distance: number }>(
        knnSql,
        knnArgs,
      );
      rows = result.rows;
    } catch (err) {
      // A table that was never ensureSpace()d (e.g. an empty/unknown space)
      // is "no results", not a StorageError — matches
      // SqliteVectorBackend/BruteForceBackend's `tableExists` short-circuit.
      const msg = err instanceof Error ? err.message : String(err);
      if (/no such table/i.test(msg)) return [];
      throw new StorageError(
        `Failed to run knn query for space ${space.modelId}`,
        err instanceof Error ? err : undefined,
      );
    }

    return rows.map((r) => ({ id: r.node_id, score: 1 - r.distance }));
  }

  /**
   * Full (optionally id-filtered) corpus scan of a space's table — the
   * async mirror of `SqliteVectorBackend.iter`, used by `reembed()`-style
   * migration and clustering callers. `VecFilter.nodeFilter` is honored the
   * same way `knn` honors it (pushed into the SQL WHERE via
   * `buildNodeFilterClause`), not applied after the fact.
   */
  async *iter(
    modelId: string,
    opts?: { filter?: VecFilter },
  ): AsyncIterable<{ id: number; vec: Float32Array }> {
    const tbl = tableName(modelId);
    const filter = opts?.filter;

    const clauses: string[] = [];
    const params: unknown[] = [];
    let joinSql = '';

    if (filter?.nodeFilter) {
      joinSql = `JOIN node n ON n.rowid = v.node_id`;
      const { where, params: fParams } = buildNodeFilterClause(filter.nodeFilter, true, 'n');
      if (where) clauses.push(where.replace(/^WHERE /, ''));
      params.push(...fParams);
    }
    if (filter?.ids && filter.ids.length > 0) {
      clauses.push(`v.node_id IN (${filter.ids.map(() => '?').join(',')})`);
      params.push(...filter.ids);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    let rows: Array<{ node_id: number; embedding: Buffer }>;
    try {
      const result = await this.adapter.executeAll<{ node_id: number; embedding: Buffer }>(
        `SELECT v.node_id, v.embedding FROM "${tbl}" v ${joinSql} ${whereSql}`,
        params,
      );
      rows = result.rows;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/no such table/i.test(msg)) {
        rows = [];
      } else {
        throw new StorageError(
          `Failed to iterate space ${modelId}`,
          err instanceof Error ? err : undefined,
        );
      }
    }

    for (const row of rows) {
      yield { id: row.node_id, vec: blobToFloat32(row.embedding) };
    }
  }
}

// ── openTursoVectorStore — convenience factory ──────────────────────────────

/**
 * Construct a `TursoVectorBackend` over an existing Turso-backed
 * `StoreAdapter` and `await` `ensureSpace(opts)` before returning — the async
 * mirror of `openVectorStore()`'s convenience shape (construct + ensure the
 * initial space in one call).
 *
 * Unlike `openVectorStore`, this does not accept a bare `dbPath` string:
 * `TursoVectorBackend` is explicitly designed to REUSE the caller's existing
 * adapter/connection rather than open its own (see the `AsyncVectorBackend`
 * doc comment on why a second connection is unsafe here) — so a `StoreAdapter`
 * the caller already owns is a required argument, not an optional escape
 * hatch.
 */
export async function openTursoVectorStore(
  adapter: StoreAdapter,
  opts: { dim: number; modelId: string },
): Promise<TursoVectorBackend> {
  const backend = new TursoVectorBackend(adapter);
  await backend.ensureSpace({ modelId: opts.modelId, dim: opts.dim });
  return backend;
}
