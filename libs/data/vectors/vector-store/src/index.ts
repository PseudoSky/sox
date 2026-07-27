import * as sqliteVec from 'sqlite-vec';
import { buildNodeFilterClause } from '@adhd/sox-graph-store';
import type { NodeFilter } from '@adhd/sox-graph-store';
import type { StoreAdapter, SqliteAdapter } from '@adhd/sox-store-adapter';
import { createSqliteAdapter } from '@adhd/sox-store-adapter';


// ── Public types ────────────────────────────────────────────────────────────

export interface VectorSpace {
  modelId: string;
  dim: number;
}

export interface VecFilter {
  ids?: number[];
  /** NEW, additive. When present, pushed into the candidate-selection query as
   *  a JOIN + WHERE against the `node` table (via `@adhd/sox-graph-store`'s
   *  `buildNodeFilterClause` — the same NodeFilter->SQL translation that
   *  package's own queryNodes/countNodes/searchNodes use internally, so both
   *  packages can never silently diverge on a future NodeFilter field).
   *  ANDed with `ids` when both are given. Absent -> no behavior change from
   *  before this field existed. */
  nodeFilter?: NodeFilter;
}

export interface VectorBackend {
  ensureSpace(space: VectorSpace): void;
  listSpaces(): VectorSpace[];
  upsert(id: number, vec: Float32Array, space: VectorSpace): void;
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
}

// ── Error types ─────────────────────────────────────────────────────────────

export class SpaceInvariantError extends Error {
  constructor(
    public readonly nodeId: number,
    public readonly space: VectorSpace,
    public readonly actualDim: number,
  ) {
    super(
      `dim mismatch for node ${nodeId}: got ${actualDim}, expected ${space.dim} (${space.modelId})`,
    );
    this.name = 'SpaceInvariantError';
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
// Contract for `filter?.nodeFilter` on any FUTURE non-brute-force
// SimilarityBackend (e.g. one issuing sqlite-vec's native
// `WHERE embedding MATCH ? AND k = ?`): ANN traversal picks its `k` nearest
// BEFORE a joined WHERE on non-partition-key columns is applied, so
// `MATCH ... AND k=? JOIN node WHERE n.namespace=?` can legitimately return
// fewer than `k` rows even when plenty of matching-namespace items exist
// further out in vector space. Any such backend MUST over-fetch
// (`k' = k * overFetchMultiplier`, widening/retrying, or falling back to
// brute force) rather than passing the filter straight into `MATCH ... AND
// k=?` and returning whatever survives. BruteForceBackend below does not have
// this problem: it scores every SQL-filtered row before truncating to `k`,
// so its result is always the exact true top-k among filter-matching rows.

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
    const db = (adapter as SqliteAdapter).unwrap();
    if (!tableExists(db, tbl)) return [];

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filter?.nodeFilter) {
      // Reuse the EXACT predicate builder @adhd/sox-graph-store's own
      // queryNodes/countNodes/searchNodes already use internally — one
      // canonical NodeFilter->SQL translation across both packages, not two
      // that could silently diverge.
      const { where, params: fParams } = buildNodeFilterClause(filter.nodeFilter, true, 'n');
      if (where) clauses.push(where.replace(/^WHERE /, ''));
      params.push(...fParams);
    }
    if (filter?.ids && filter.ids.length > 0) {
      clauses.push(`v.node_id IN (${filter.ids.map(() => '?').join(',')})`);
      params.push(...filter.ids);
    }

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const joinSql = filter?.nodeFilter ? `JOIN node n ON n.rowid = v.node_id` : '';
    const rows = db
      .prepare<unknown[], { node_id: number; embedding: Buffer }>(
        `SELECT v.node_id, v.embedding FROM "${tbl}" v ${joinSql} ${whereSql}`,
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

export class SqliteVectorBackend implements VectorBackend {
  private db: import('better-sqlite3').Database;
  private adapter: StoreAdapter;
  private similarity: SimilarityBackend;
  public readonly capabilities: VectorStoreCapabilities;

  constructor(adapter: StoreAdapter, similarity?: SimilarityBackend) {
    this.adapter = adapter;
    this.similarity = similarity ?? new BruteForceBackend();
    this.capabilities = {
      vecEnabled: adapter.capabilities.nativeVectors || true, // sqlite-vec provides vector support via SqliteAdapter path
    };

    this.db = (adapter as SqliteAdapter).unwrap();
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
}

// ── openVectorStore — convenience factory ───────────────────────────────────

export function openVectorStore(
  adapterOrPath: string | StoreAdapter,
  opts: { dim: number; modelId: string },
): SqliteVectorBackend {
  let adapter: StoreAdapter;
  if (typeof adapterOrPath === 'string') {
    adapter = createSqliteAdapter({ dbPath: adapterOrPath });
    const db = (adapter as SqliteAdapter).unwrap();
    sqliteVec.load(db);
    db.pragma('journal_mode = WAL');
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
  config: LanceDbVectorBackendConfig & { db: import('better-sqlite3').Database },
): LanceDbVectorBackend & VectorBackend {
  return new LanceDbVectorBackend(config);
}

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
