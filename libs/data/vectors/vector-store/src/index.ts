import * as sqliteVec from 'sqlite-vec';
import type { StoreAdapter, SqliteAdapter } from '@adhd/sox-store-adapter';
import { createSqliteAdapter } from '@adhd/sox-store-adapter';


// ── Public types ────────────────────────────────────────────────────────────

export interface VectorSpace {
  modelId: string;
  dim: number;
}

/**
 * DEBT-011 — the vector store's filter contract is now PURE. A vector store's
 * real contract is `(opaque id → vector) + kNN`; it knows nothing about the
 * graph's `node` table. `nodeFilter`/`liveOnly` (the old graph-coupled form)
 * are retired — the semantic facade / hybrid-search own the node-join and
 * realize matching ids up front, then pass `{ ids }` here.
 */
export interface VecFilter {
  ids?: number[];
}

/**
 * A bounded existence probe over one space's vector table.
 *
 * Deliberately NOT part of the pinned `VectorBackend` contract
 * ([iface:vector-backend]) — it is an additive *capability* interface that a
 * caller narrows to (via `typeof backend.hasVectors === 'function'` or
 * `'hasVectors' in backend`) when it needs a cheap "does this space hold any
 * vectors?" answer. Widening `VectorBackend` itself would force every
 * structural implementor — including the untyped mock backends downstream
 * packages carry in fixtures — to grow the method, and would silently
 * un-pin a documented contract; the capability interface gets the same
 * guarantee without either cost.
 *
 * Why this exists: `iter()` is a full corpus scan and is not lazy on every
 * backend — `TursoVectorBackend.iter` is backed by the adapter's `executeAll`
 * (`db.all`), which materializes every row *including the full embedding
 * BLOB* before its first yield. An existence check built on `iter` therefore
 * reads the entire vector table. `hasVectors` issues a bounded
 * `SELECT 1 … LIMIT 1` instead: no embedding column is projected, so no blob
 * is read, and the scan stops at the first row — O(1) in the size of the
 * space.
 */
export interface VectorExistenceProbe {
  hasVectors(modelId: string): boolean;
}

export interface VectorBackend {
  ensureSpace(space: VectorSpace): void;
  listSpaces(): VectorSpace[];
  upsert(id: number, vec: Float32Array, space: VectorSpace): void;
  /** FEAT-020 — batch upsert, all items share one space. Enforces the dim
   *  invariant per item up-front; transactional. */
  upsertVectors(items: Array<{ id: number; vec: Float32Array }>, space: VectorSpace): void;
  delete(id: number, modelId: string): void;
  get(id: number, modelId: string): Float32Array | null;
  knn(
    query: Float32Array,
    space: VectorSpace,
    k: number,
    filter?: VecFilter,
  ): Array<{ id: number; score: number }>;
  iter(
    modelId: string,
    opts?: { filter?: VecFilter },
  ): Iterable<{ id: number; vec: Float32Array }>;
  /**
   * DEBT-011 (Move 3) — remove exactly the given ids from `modelId`'s space,
   * returning the count removed. Idempotent; tolerant of an absent vector table
   * (returns 0). The node-specific prune (old `pruneInvalidatedVectors`) is now
   * facade/host composition: `graphStore.queryNodes({ liveOnly:false })` →
   * `deleteMany(ids)`.
   */
  deleteMany(ids: number[], modelId: string): number;
}

// ── Error types ─────────────────────────────────────────────────────────────

/**
 * Sentinel `nodeId` carried by a {@link SpaceInvariantError} raised from the
 * query path (`knn`). A query vector has no owning node, so the node-oriented
 * field is meaningless there; this constant lets a consumer discriminate the
 * query site from the write site without parsing the message.
 */
export const QUERY_VECTOR_NODE_ID = -1;

export class SpaceInvariantError extends Error {
  constructor(
    public readonly nodeId: number,
    public readonly space: VectorSpace,
    public readonly actualDim: number,
    /**
     * Which operation detected the mismatch — `'upsert'` (the write path, the
     * default, preserving the original 3-arg contract) or `'knn'` (the query
     * path). On the `'knn'` path `nodeId` is {@link QUERY_VECTOR_NODE_ID}.
     */
    public readonly source: 'upsert' | 'knn' = 'upsert',
  ) {
    super(
      source === 'knn'
        ? `query dim mismatch: got ${actualDim}, expected ${space.dim} (${space.modelId})`
        : `dim mismatch for node ${nodeId}: got ${actualDim}, expected ${space.dim} (${space.modelId})`,
    );
    this.name = 'SpaceInvariantError';
  }

  /**
   * The query-path constructor: a `knn` query vector whose length ≠
   * `space.dim`. Parity with the `upsert` check — a wrong-dim query is a
   * space-invariant violation and must reject with this typed error, never a
   * raw driver/SQL error (ADR-0012: a raw driver exception reaching a caller
   * is a bug).
   */
  static forQuery(space: VectorSpace, actualDim: number): SpaceInvariantError {
    return new SpaceInvariantError(QUERY_VECTOR_NODE_ID, space, actualDim, 'knn');
  }
}

export class StorageError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super(message);
    this.name = 'StorageError';
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

function sanitizeModelId(modelId: string): string {
  return modelId.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '') || 'default';
}

function tableName(modelId: string): string {
  return `vec_${sanitizeModelId(modelId)}`;
}

function bufferToVec(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

function vecToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

// BL-380: `SqliteVectorBackend` is fundamentally a sqlite-vec/vec0 backend —
// every query it issues is a SYNCHRONOUS `better-sqlite3` call, which only
// exists on `SqliteAdapter`. `TursoAdapter.unwrap()` returns an ASYNC
// `@tursodatabase/database` handle whose `.prepare().all()` returns a
// Promise, not rows — an unguarded `(adapter as SqliteAdapter).unwrap()`
// silently compiles and then crashes at runtime the moment a Turso store
// (the default backend) reaches this class. Gate on `adapter.config.type`
// the same way `libs/memory-core/src/db.ts:373`/`:896` gate on
// `adapter.capabilities.nativeVectors` before reaching for the raw handle,
// so a Turso-backed caller gets one clear, actionable error here instead of
// a `TypeError` deep inside a `.prepare()` call (or, per BL-364, a crash on
// `undefined.nativeVectors` when a caller skips the StoreAdapter wrapper
// altogether and passes a raw driver handle).
function requireSqliteHandle(adapter: StoreAdapter): import('better-sqlite3').Database {
  // The comment above has promised "one clear, actionable error" for the
  // raw-driver-handle case since BL-364, and until now it did not deliver one:
  // reading `.capabilities` off a raw `better-sqlite3` handle throws
  // `TypeError: Cannot read properties of undefined (reading 'nativeVectors')`,
  // which names neither this class nor the mistake. That exact TypeError killed
  // all 12 DB-integrated tests in `analysis.spec.ts` for 8 days after the
  // store-adapter migration (83cd0b0) left that caller behind — the message was
  // opaque enough that the suite read as a mysterious environment problem
  // rather than a stale constructor call. Say what is actually wrong.
  if (adapter === null || typeof adapter !== 'object' || adapter.capabilities === undefined) {
    throw new StorageError(
      `SqliteVectorBackend requires a StoreAdapter, not a raw driver handle — ` +
        `the value passed has no \`capabilities\`. This is the pre-83cd0b0 calling convention: ` +
        `\`new SqliteVectorBackend(db)\` became \`new SqliteVectorBackend(adapter)\`. ` +
        `Wrap the handle with createSqliteAdapter({ dbPath }), or use openVectorStore(dbPath, { dim, modelId }).`,
    );
  }
  // Blessed pattern (see libs/memory-core/src/db.ts:373,896): gate on the
  // capability flag, never on config.type — nativeVectors is false ONLY for
  // SqliteAdapter (needs the sqlite-vec extension loaded on a synchronous
  // better-sqlite3 handle, which is exactly the shape this class requires);
  // it's true for TursoAdapter, whose native vector support is reached
  // through the async StoreAdapter API this class does not speak.
  if (adapter.capabilities.nativeVectors) {
    throw new StorageError(
      `SqliteVectorBackend requires a SqliteAdapter (sqlite-vec/vec0 is a synchronous, sqlite-only mechanism) — ` +
        `got an adapter with capabilities.nativeVectors=true (e.g. TursoAdapter). ` +
        `Use LanceDbVectorBackend for a Turso-backed store, or wrap a sqlite handle via createSqliteAdapter().`,
    );
  }
  return (adapter as SqliteAdapter).unwrap();
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function tableExists(db: import('better-sqlite3').Database, name: string): boolean {
  const row = db
    .prepare<[string], { name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
    )
    .get(name);
  return row !== undefined;
}

// ── SimilarityBackend (internal seam — NOT exported) ────────────────────────
//
// DEBT-011 — the filter contract is now pure `{ ids }`. A vector store's real
// contract is `(opaque id → vector) + kNN`; it knows nothing about the graph's
// `node` table. Node filtering lives in the facade / hybrid-search, which
// realize matching ids up front and pass `{ ids }` here.

interface SimilarityBackend {
  search(
    query: Float32Array,
    k: number,
    adapter: StoreAdapter,
    tableName: string,
    filter?: VecFilter,
  ): Array<{ nodeId: number; score: number }>;
}

class BruteForceBackend implements SimilarityBackend {
  search(
    query: Float32Array,
    k: number,
    adapter: StoreAdapter,
    tbl: string,
    filter?: VecFilter,
  ): Array<{ nodeId: number; score: number }> {
    const db = requireSqliteHandle(adapter);
    if (!tableExists(db, tbl)) return [];

    const clauses: string[] = [];
    const params: unknown[] = [];

    // BUG-032 / ADR-0017 — a PRESENT-BUT-EMPTY ids is a scope that resolves to
    // zero candidates, never "no filter". Dropping it would widen the query to
    // an unfiltered scan.
    if (filter?.ids !== undefined) {
      if (filter.ids.length === 0) return [];
      clauses.push(`v.node_id IN (${filter.ids.map(() => '?').join(',')})`);
      params.push(...filter.ids);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = db
      .prepare<unknown[], { node_id: number; embedding: Buffer }>(
        `SELECT v.node_id, v.embedding FROM "${tbl}" v ${whereSql}`,
      )
      .all(...params);

    const results: Array<{ nodeId: number; score: number }> = [];
    for (const row of rows) {
      const vec = bufferToVec(row.embedding);
      results.push({ nodeId: row.node_id, score: cosineSimilarity(query, vec) });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, k);
  }
}

// ── SqliteVectorBackend ─────────────────────────────────────────────────────

export interface VectorStoreCapabilities {
  vecEnabled: boolean;
}

export class SqliteVectorBackend implements VectorBackend, VectorExistenceProbe {
  private db: import('better-sqlite3').Database;
  private adapter: StoreAdapter;
  private similarity: SimilarityBackend;
  public readonly capabilities: VectorStoreCapabilities;

  constructor(adapter: StoreAdapter, similarity?: SimilarityBackend) {
    this.adapter = adapter;
    this.similarity = similarity ?? new BruteForceBackend();
    // vecEnabled is unconditionally true here: requireSqliteHandle() below
    // throws before construction completes if `adapter` isn't a sqlite-vec-
    // capable SqliteAdapter, so reaching this line already proves vector
    // support is available. (The old `adapter.capabilities.nativeVectors ||
    // true` read the capability and then ignored it — dead code, BL-380.)
    this.capabilities = {
      vecEnabled: true,
    };

    this.db = requireSqliteHandle(adapter);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS _vector_spaces (
        model_id TEXT PRIMARY KEY,
        dim INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )
    `);
  }

  ensureSpace(space: VectorSpace): void {
    try {
      const tbl = tableName(space.modelId);
      this.db.exec(
        `CREATE VIRTUAL TABLE IF NOT EXISTS "${tbl}" USING vec0(node_id INTEGER PRIMARY KEY, embedding FLOAT[${space.dim}])`,
      );
      this.db
        .prepare(
          `INSERT OR IGNORE INTO _vector_spaces(model_id, dim, created_at) VALUES(?, ?, ?)`,
        )
        .run(space.modelId, space.dim, new Date().toISOString());
      console.info(
        `[vector-store] new space created modelId=${space.modelId} dim=${space.dim}`,
      );
    } catch (err) {
      throw new StorageError(
        `Failed to ensure space ${space.modelId}`,
        err instanceof Error ? err : undefined,
      );
    }
  }

  listSpaces(): VectorSpace[] {
    try {
      const rows = this.db
        .prepare<[], { model_id: string; dim: number }>(
          `SELECT model_id, dim FROM _vector_spaces`,
        )
        .all();
      return rows.map((r: { model_id: string; dim: number }) => ({ modelId: r.model_id, dim: r.dim }));
    } catch {
      return [];
    }
  }

  upsert(id: number, vec: Float32Array, space: VectorSpace): void {
    if (vec.length !== space.dim) {
      throw new SpaceInvariantError(id, space, vec.length);
    }

    try {
      const tbl = tableName(space.modelId);
      const vecBuf = vecToBuffer(vec);

      const updated = this.db
        .prepare(`UPDATE "${tbl}" SET embedding = ? WHERE node_id = CAST(? AS INTEGER)`)
        .run(vecBuf, id);
      if (updated.changes === 0) {
        this.db
          .prepare(`INSERT INTO "${tbl}"(node_id, embedding) VALUES(CAST(? AS INTEGER), ?)`)
          .run(id, vecBuf);
      }
    } catch (err) {
      throw new StorageError(
        `Failed to upsert vector for node ${id} in space ${space.modelId}`,
        err instanceof Error ? err : undefined,
      );
    }
  }

  upsertVectors(items: Array<{ id: number; vec: Float32Array }>, space: VectorSpace): void {
    for (const { id, vec } of items) {
      if (vec.length !== space.dim) throw new SpaceInvariantError(id, space, vec.length);
    }
    try {
      const tbl = tableName(space.modelId);
      const update = this.db.prepare(`UPDATE "${tbl}" SET embedding = ? WHERE node_id = CAST(? AS INTEGER)`);
      const insert = this.db.prepare(`INSERT INTO "${tbl}"(node_id, embedding) VALUES(CAST(? AS INTEGER), ?)`);
      const tx = this.db.transaction((rows: Array<{ id: number; vec: Float32Array }>) => {
        for (const { id, vec } of rows) {
          const vecBuf = vecToBuffer(vec);
          const u = update.run(vecBuf, id);
          if (u.changes === 0) insert.run(id, vecBuf);
        }
      });
      tx(items);
    } catch (err) {
      throw new StorageError(
        `Failed to batch upsert vectors in space ${space.modelId}`,
        err instanceof Error ? err : undefined,
      );
    }
  }

  delete(id: number, modelId: string): void {
    try {
      const tbl = tableName(modelId);
      if (!tableExists(this.db, tbl)) return;
      this.db.prepare(`DELETE FROM "${tbl}" WHERE node_id = CAST(? AS INTEGER)`).run(id);
    } catch (err) {
      throw new StorageError(
        `Failed to delete vector for node ${id} in space ${modelId}`,
        err instanceof Error ? err : undefined,
      );
    }
  }

  /**
   * DEBT-011 (Move 3) — remove exactly the given ids, returning the count
   * removed. Idempotent; tolerant of a missing vector table (returns 0). The
   * old FEAT-016 `pruneInvalidatedVectors` (which hard-coded a `node` join) is
   * retired — node-specific pruning is now facade/host composition.
   */
  deleteMany(ids: number[], modelId: string): number {
    if (ids.length === 0) return 0;
    const tbl = tableName(modelId);
    if (!tableExists(this.db, tbl)) return 0;
    const info = this.db
      .prepare(`DELETE FROM "${tbl}" WHERE node_id IN (${ids.map(() => '?').join(',')})`)
      .run(...ids);
    return info.changes;
  }

  get(id: number, modelId: string): Float32Array | null {
    try {
      const tbl = tableName(modelId);
      if (!tableExists(this.db, tbl)) return null;
      const row = this.db
        .prepare<[number], { embedding: Buffer }>(
          `SELECT embedding FROM "${tbl}" WHERE node_id = CAST(? AS INTEGER)`,
        )
        .get(id);
      if (!row) return null;
      return bufferToVec(row.embedding);
    } catch {
      return null;
    }
  }

  knn(
    query: Float32Array,
    space: VectorSpace,
    k: number,
    filter?: VecFilter,
  ): Array<{ id: number; score: number }> {
    // Parity with upsert(): a query vector must match the space's dim. Without
    // this, the brute-force cosine loop reads past the shorter of the two and
    // returns NaN/garbage scores — a silently wrong answer, not an error.
    if (query.length !== space.dim) {
      throw SpaceInvariantError.forQuery(space, query.length);
    }
    const tbl = tableName(space.modelId);
    const results = this.similarity.search(query, k, this.adapter, tbl, filter);
    return results.map((r) => ({ id: r.nodeId, score: r.score }));
  }

  iter(
    modelId: string,
    opts?: { filter?: VecFilter },
  ): Iterable<{ id: number; vec: Float32Array }> {
    const tbl = tableName(modelId);
    const filter = opts?.filter;

    let rows: Array<{ node_id: number; embedding: Buffer }> = [];
    try {
      if (!tableExists(this.db, tbl)) {
        rows = [];
      } else if (filter?.ids !== undefined && filter.ids.length === 0) {
        // BUG-032 / ADR-0017 — present-but-empty ids ⇒ match nothing.
        rows = [];
      } else if (filter?.ids && filter.ids.length > 0) {
        const placeholders = filter.ids.map(() => '?').join(',');
        rows = this.db
          .prepare<unknown[], { node_id: number; embedding: Buffer }>(
            `SELECT node_id, embedding FROM "${tbl}" WHERE node_id IN (${placeholders})`,
          )
          .all(...filter.ids);
      } else {
        rows = this.db
          .prepare<[], { node_id: number; embedding: Buffer }>(
            `SELECT node_id, embedding FROM "${tbl}"`,
          )
          .all();
      }
    } catch {
      rows = [];
    }

    const captured = rows;
    return {
      *[Symbol.iterator]() {
        for (const row of captured) {
          yield { id: row.node_id, vec: bufferToVec(row.embedding) };
        }
      },
    };
  }

  /**
   * Bounded existence probe — `SELECT 1 … LIMIT 1` against the space's table.
   * Projects no `embedding` column, so no blob is read, and stops at the first
   * row; unlike `iter` it never materializes the corpus. Returns `false` for a
   * space whose table was never `ensureSpace`d (an absent table is "empty", not
   * an error). See {@link VectorExistenceProbe}.
   */
  hasVectors(modelId: string): boolean {
    const tbl = tableName(modelId);
    if (!tableExists(this.db, tbl)) return false;
    try {
      const row = this.db
        .prepare<[], { one: number }>(`SELECT 1 AS one FROM "${tbl}" LIMIT 1`)
        .get();
      return row !== undefined;
    } catch (err) {
      throw new StorageError(
        `Failed to probe space ${modelId} for vectors`,
        err instanceof Error ? err : undefined,
      );
    }
  }
}

// ── openVectorStore — convenience factory ───────────────────────────────────

export function openVectorStore(
  adapterOrPath: string | StoreAdapter,
  opts: { dim: number; modelId: string },
): SqliteVectorBackend {
  let adapter: StoreAdapter;
  if (typeof adapterOrPath === 'string') {
    // createSqliteAdapter({ dbPath }) is statically typed to return
    // SqliteAdapter — no cast needed, this is the legitimate "we just built
    // it, we know what it is" case (unlike the casts above, which reach for
    // unwrap() on a caller-supplied adapter of unknown provenance).
    const sqliteAdapter = createSqliteAdapter({ dbPath: adapterOrPath });
    const db = sqliteAdapter.unwrap();
    sqliteVec.load(db);
    db.pragma('journal_mode = WAL');
    adapter = sqliteAdapter;
  } else {
    adapter = adapterOrPath;
  }
  const backend = new SqliteVectorBackend(adapter);
  backend.ensureSpace({ modelId: opts.modelId, dim: opts.dim });
  return backend;
}

// ── LanceDbVectorBackend ──────────────────────────────────────────────────────

import { LanceDbVectorBackend } from './lancedb.js';
import type { LanceDbVectorBackendConfig } from './lancedb.js';

export { LanceDbVectorBackend, type LanceDbVectorBackendConfig } from './lancedb.js';

export function openLanceDbVectorStore(
  config: LanceDbVectorBackendConfig & { adapter: StoreAdapter },
): LanceDbVectorBackend & VectorBackend {
  return new LanceDbVectorBackend(config);
}

// ── TursoVectorBackend (async, native — additive, see turso.ts) ────────────

export {
  TursoVectorBackend,
  openTursoVectorStore,
  type AsyncVectorBackend,
  type AsyncVectorExistenceProbe,
} from './turso.js';

// ── reembed — cross-space migration ─────────────────────────────────────────

interface EmbedderLike {
  readonly metadata: { modelId: string; dimensions: number };
  embedBatch(
    texts: string[],
    opts?: { role?: 'document' | 'query'; batchSize?: number },
  ): AsyncIterable<Float32Array>;
}

export interface ReembedOpts {
  targetSpace: VectorSpace;
  sourceModelId?: string;
  dryRun?: boolean;
  getText?: (id: number) => string | null;
}

export interface ReembedResult {
  migrated: number;
  skipped: number;
  errors: Array<{ id: number; error: string }>;
}

async function processReembedBatch(
  backend: VectorBackend,
  provider: EmbedderLike,
  batch: Array<{ id: number; text: string }>,
  targetSpace: VectorSpace,
  result: ReembedResult,
): Promise<void> {
  const embeddings: Float32Array[] = [];
  try {
    for await (const emb of provider.embedBatch(batch.map((b) => b.text))) {
      embeddings.push(emb);
    }
  } catch (err) {
    const msg = `Batch embedding failed: ${String(err)}`;
    for (const { id } of batch) {
      result.errors.push({ id, error: msg });
    }
    return;
  }

  for (let i = 0; i < batch.length; i++) {
    const item = batch[i]!;
    const emb = embeddings[i];
    if (!emb) {
      result.errors.push({ id: item.id, error: 'Missing embedding from batch' });
      continue;
    }
    try {
      backend.upsert(item.id, emb, targetSpace);
      result.migrated++;
    } catch (err) {
      result.errors.push({ id: item.id, error: String(err) });
    }
  }
}

export async function reembed(
  backend: VectorBackend,
  provider: EmbedderLike,
  opts: ReembedOpts,
): Promise<ReembedResult> {
  const spaces = backend.listSpaces();
  const sourceModelId =
    opts.sourceModelId ??
    spaces.find((s) => s.modelId !== opts.targetSpace.modelId)?.modelId;

  if (!sourceModelId) {
    return {
      migrated: 0,
      skipped: 0,
      errors: [{ id: -1, error: 'No source space found' }],
    };
  }

  backend.ensureSpace(opts.targetSpace);

  const sourceVecs: Array<{ id: number; vec: Float32Array }> = [];
  for (const item of backend.iter(sourceModelId)) {
    sourceVecs.push(item);
  }

  if (opts.dryRun) {
    return { migrated: sourceVecs.length, skipped: 0, errors: [] };
  }

  const getText = opts.getText;
  if (!getText) {
    return {
      migrated: 0,
      skipped: sourceVecs.length,
      errors: [
        {
          id: -1,
          error: 'getText callback is required for non-dry-run reembed',
        },
      ],
    };
  }

  const result: ReembedResult = { migrated: 0, skipped: 0, errors: [] };
  const batchSize = 32;
  let batch: Array<{ id: number; text: string }> = [];

  for (const { id } of sourceVecs) {
    const text = getText(id);
    if (!text) {
      result.skipped++;
      continue;
    }
    batch.push({ id, text });

    if (batch.length >= batchSize) {
      await processReembedBatch(backend, provider, batch, opts.targetSpace, result);
      batch = [];
    }
  }

  if (batch.length > 0) {
    await processReembedBatch(backend, provider, batch, opts.targetSpace, result);
  }

  return result;
}
