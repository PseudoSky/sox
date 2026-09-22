// ── LanceDB worker thread ────────────────────────────────────────────────────
//
// Real @lancedb/lancedb calls live here, and only here. `@lancedb/lancedb` is an
// async (napi/tokio-backed) client; the public `VectorBackend` interface
// (ensureSpace/upsert/delete/get/knn/iter) is synchronous and must stay that way
// ([iface:vector-backend] is pinned). `synckit` bridges the two: this file runs
// inside a `worker_threads.Worker`, the caller (lancedb.ts) blocks on
// `Atomics.wait` via `createSyncFn` until a request below resolves.
//
// Every table here is a genuine on-disk LanceDB dataset under the caller's
// `lancedbPath` — nothing in this file is an in-memory simulation. Space
// metadata (`modelId` -> `dim`) is itself persisted to a `_vector_spaces`
// LanceDB table so `listSpaces()` survives process restarts against the same
// `lancedbPath`, mirroring `SqliteVectorBackend`'s `_vector_spaces` metadata
// table.
//
// Kept deliberately free of "erasable TypeScript syntax" violations (no enums,
// no parameter properties, no namespaces) so Node's native type-stripping can
// run this file directly during tests without a transform step.

import { runAsWorker } from 'synckit';
import * as lancedb from '@lancedb/lancedb';
import { Index } from '@lancedb/lancedb';
import { Field, FixedSizeList, Float32, Int32, Schema, Utf8 } from 'apache-arrow';

// ── Wire types (structured-clone friendly: plain objects/arrays/typed arrays) ─

export interface WorkerVectorSpace {
  modelId: string;
  dim: number;
}

export interface WorkerVecFilter {
  ids?: number[];
}

export interface WorkerIndexConfig {
  type: 'hnsw' | 'ivf-pq';
  M?: number;
  efConstruction?: number;
  numPartitions?: number;
  numSubVectors?: number;
  bitsPerSubVector?: number;
  metric?: 'cosine' | 'l2' | 'dot';
}

export type WorkerOp =
  | 'init'
  | 'ensureSpace'
  | 'listSpaces'
  | 'upsert'
  | 'delete'
  | 'deleteMany'
  | 'get'
  | 'knn'
  | 'iter'
  | 'hasVectors';

export interface WorkerRequest {
  op: WorkerOp;
  lancedbPath: string;
  // Explicit `| undefined` (not just `?`) throughout: this repo compiles with
  // exactOptionalPropertyTypes, and callers (lancedb.ts) legitimately pass
  // `undefined` through for fields sourced from other optional properties
  // (e.g. `this.indexConfig`, `opts?.filter`) rather than omitting the key.
  indexConfig?: WorkerIndexConfig | undefined;
  space?: WorkerVectorSpace | undefined;
  modelId?: string | undefined;
  id?: number | undefined;
  ids?: number[] | undefined;
  vec?: Float32Array | undefined;
  query?: Float32Array | undefined;
  k?: number | undefined;
  filter?: WorkerVecFilter | undefined;
}

export interface WorkerResponse {
  spaces?: WorkerVectorSpace[];
  vec?: number[] | null;
  results?: Array<{ id: number; score: number }>;
  items?: Array<{ id: number; vec: number[] }>;
  count?: number;
  exists?: boolean;
}

// ── Per-lancedbPath connection state (persists across calls in this worker) ──

interface DbState {
  connection: lancedb.Connection;
  tables: Map<string, lancedb.Table>;
  spaces: Map<string, WorkerVectorSpace>;
  indexBuilt: Set<string>;
}

const dbStates = new Map<string, Promise<DbState>>();

const SPACES_TABLE = '_vector_spaces';

// LanceDB IVF/HNSW training tolerates very small tables once `numPartitions`
// is clamped to the live row count (see maybeBuildIndex) — 1 row is enough to
// exercise the "index exists" path deterministically in tests without needing
// a large fixture.
const MIN_ROWS_FOR_INDEX = 1;

function sanitize(modelId: string): string {
  const cleaned = modelId.replace(/[^a-zA-Z0-9_]/g, '_').replace(/^_+|_+$/g, '');
  return cleaned || 'default';
}

function spaceKey(modelId: string, dim: number): string {
  return `vec_${sanitize(modelId)}_${dim}`;
}

function toNumberArray(value: unknown): number[] {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map((v) => Number(v));
  if (ArrayBuffer.isView(value)) {
    return Array.from(value as unknown as ArrayLike<number>);
  }
  if (typeof (value as { toArray?: () => unknown }).toArray === 'function') {
    return toNumberArray((value as { toArray: () => unknown }).toArray());
  }
  return Array.from(value as ArrayLike<number>);
}

async function getDbState(lancedbPath: string): Promise<DbState> {
  let statePromise = dbStates.get(lancedbPath);
  if (!statePromise) {
    statePromise = (async () => {
      const connection = await lancedb.connect(lancedbPath);
      const tables = new Map<string, lancedb.Table>();
      const spaces = new Map<string, WorkerVectorSpace>();
      const indexBuilt = new Set<string>();

      const existingNames = await connection.tableNames();

      if (existingNames.includes(SPACES_TABLE)) {
        const spacesTable = await connection.openTable(SPACES_TABLE);
        const rows = await spacesTable.query().toArray();
        for (const row of rows) {
          const modelId = String(row.modelId);
          const dim = Number(row.dim);
          spaces.set(modelId, { modelId, dim });
        }
      }

      for (const space of spaces.values()) {
        const key = spaceKey(space.modelId, space.dim);
        if (existingNames.includes(key)) {
          const table = await connection.openTable(key);
          tables.set(key, table);
          const indices = await table.listIndices();
          if (indices.some((idx) => idx.columns.includes('vector'))) {
            indexBuilt.add(key);
          }
        }
      }

      return { connection, tables, spaces, indexBuilt };
    })();
    dbStates.set(lancedbPath, statePromise);
  }
  return statePromise;
}

async function getOrCreateSpacesTable(state: DbState): Promise<lancedb.Table> {
  const names = await state.connection.tableNames();
  if (names.includes(SPACES_TABLE)) {
    return state.connection.openTable(SPACES_TABLE);
  }
  const schema = new Schema([
    new Field('modelId', new Utf8(), false),
    new Field('dim', new Int32(), false),
  ]);
  return state.connection.createEmptyTable(SPACES_TABLE, schema);
}

async function ensureSpace(state: DbState, space: WorkerVectorSpace): Promise<void> {
  const key = spaceKey(space.modelId, space.dim);
  const already = state.spaces.get(space.modelId);
  if (state.tables.has(key) && already && already.dim === space.dim) return;

  const schema = new Schema([
    new Field('id', new Int32(), false),
    new Field('vector', new FixedSizeList(space.dim, new Field('item', new Float32(), true)), false),
  ]);

  const names = await state.connection.tableNames();
  const table = names.includes(key)
    ? await state.connection.openTable(key)
    : await state.connection.createEmptyTable(key, schema);
  state.tables.set(key, table);
  state.spaces.set(space.modelId, space);

  const spacesTable = await getOrCreateSpacesTable(state);
  await spacesTable
    .mergeInsert('modelId')
    .whenMatchedUpdateAll()
    .whenNotMatchedInsertAll()
    .execute([{ modelId: space.modelId, dim: space.dim }]);
}

function buildIndexDef(cfg: WorkerIndexConfig, rowCount: number): lancedb.Index {
  const metric = cfg.metric ?? 'cosine';
  if (cfg.type === 'hnsw') {
    const opts: Parameters<typeof Index.hnswSq>[0] = {
      distanceType: metric,
      numPartitions: cfg.numPartitions ?? 1,
    };
    if (cfg.M !== undefined) opts.m = cfg.M;
    if (cfg.efConstruction !== undefined) opts.efConstruction = cfg.efConstruction;
    return Index.hnswSq(opts);
  }

  const numPartitions =
    cfg.numPartitions ?? Math.max(1, Math.min(Math.round(Math.sqrt(rowCount)), rowCount));
  const opts: Parameters<typeof Index.ivfPq>[0] = {
    distanceType: metric,
    numPartitions,
  };
  if (cfg.numSubVectors !== undefined) opts.numSubVectors = cfg.numSubVectors;
  if (cfg.bitsPerSubVector !== undefined) opts.numBits = cfg.bitsPerSubVector;
  return Index.ivfPq(opts);
}

function minTrainingRows(cfg: WorkerIndexConfig): number {
  // IVF_PQ trains one product-quantization codebook of 2^bitsPerSubVector
  // centroids per sub-vector — LanceDB refuses to train PQ with fewer rows
  // than that codebook size. HNSW_SQ (our 'hnsw' mapping) uses scalar
  // quantization, not PQ, and has no such floor.
  if (cfg.type === 'ivf-pq') {
    return Math.max(MIN_ROWS_FOR_INDEX, 2 ** (cfg.bitsPerSubVector ?? 8));
  }
  return MIN_ROWS_FOR_INDEX;
}

async function maybeBuildIndex(
  state: DbState,
  key: string,
  table: lancedb.Table,
  cfg: WorkerIndexConfig,
): Promise<void> {
  if (state.indexBuilt.has(key)) return;
  const rowCount = await table.countRows();
  if (rowCount < minTrainingRows(cfg)) return;

  try {
    const indexDef = buildIndexDef(cfg, rowCount);
    await table.createIndex('vector', { config: indexDef, replace: true });
    state.indexBuilt.add(key);
  } catch (err) {
    // Training can legitimately fail transiently on very small/skewed tables
    // (e.g. not enough distinct vectors to seed partitions yet). Leave
    // indexBuilt unset so the next upsert (more data) retries automatically —
    // never fake success here.
    console.warn(`[vector-store] ANN index build deferred for ${key}: ${String(err)}`);
  }
}

async function upsert(
  state: DbState,
  space: WorkerVectorSpace,
  id: number,
  vec: Float32Array,
  indexConfig: WorkerIndexConfig | undefined,
): Promise<void> {
  await ensureSpace(state, space);
  const key = spaceKey(space.modelId, space.dim);
  const table = state.tables.get(key);
  if (!table) throw new Error(`Space not found after ensureSpace: ${key}`);

  await table
    .mergeInsert('id')
    .whenMatchedUpdateAll()
    .whenNotMatchedInsertAll()
    .execute([{ id, vector: vec }]);

  if (indexConfig) {
    await maybeBuildIndex(state, key, table, indexConfig);
  }
}

async function del(state: DbState, modelId: string, id: number): Promise<void> {
  const space = state.spaces.get(modelId);
  if (!space) return;
  const key = spaceKey(modelId, space.dim);
  const table = state.tables.get(key);
  if (!table) return;
  await table.delete(`id = ${id}`);
}

async function deleteMany(state: DbState, modelId: string, ids: number[]): Promise<number> {
  const space = state.spaces.get(modelId);
  if (!space) return 0;
  const key = spaceKey(modelId, space.dim);
  const table = state.tables.get(key);
  if (!table) return 0;
  const res = await table.delete(`id IN (${ids.join(',')})`);
  return res.numDeletedRows;
}

async function get(state: DbState, modelId: string, id: number): Promise<number[] | null> {
  const space = state.spaces.get(modelId);
  if (!space) return null;
  const key = spaceKey(modelId, space.dim);
  const table = state.tables.get(key);
  if (!table) return null;

  const rows = await table.query().where(`id = ${id}`).limit(1).toArray();
  if (rows.length === 0) return null;
  return toNumberArray(rows[0].vector);
}

async function knn(
  state: DbState,
  space: WorkerVectorSpace,
  query: Float32Array,
  k: number,
  indexConfig: WorkerIndexConfig | undefined,
  filter?: WorkerVecFilter,
): Promise<Array<{ id: number; score: number }>> {
  const key = spaceKey(space.modelId, space.dim);
  const table = state.tables.get(key);
  if (!table) return [];

  const metric = indexConfig?.metric ?? 'cosine';
  let q = table.vectorSearch(query).distanceType(metric).limit(k);
  // BUG-032 / ADR-0017 — present-but-empty ids ⇒ match nothing.
  if (filter?.ids !== undefined && filter.ids.length === 0) return [];
  if (filter?.ids && filter.ids.length > 0) {
    q = q.where(`id IN (${filter.ids.join(',')})`);
  }

  const rows = await q.toArray();
  return rows.map((row) => {
    const distance = Number(row._distance);
    const score = metric === 'cosine' ? 1 - distance : -distance;
    return { id: Number(row.id), score };
  });
}

async function iter(
  state: DbState,
  modelId: string,
  filter?: WorkerVecFilter,
): Promise<Array<{ id: number; vec: number[] }>> {
  const space = state.spaces.get(modelId);
  if (!space) return [];
  const key = spaceKey(modelId, space.dim);
  const table = state.tables.get(key);
  if (!table) return [];

  let q = table.query();
  // BUG-032 / ADR-0017 — present-but-empty ids ⇒ match nothing.
  if (filter?.ids !== undefined && filter.ids.length === 0) return [];
  if (filter?.ids && filter.ids.length > 0) {
    q = q.where(`id IN (${filter.ids.join(',')})`);
  }

  const rows = await q.toArray();
  return rows.map((row) => ({ id: Number(row.id), vec: toNumberArray(row.vector) }));
}

function listSpaces(state: DbState): WorkerVectorSpace[] {
  return [...state.spaces.values()];
}

/**
 * Bounded existence probe for the worker's LanceDB table — projects only the
 * `id` column and `LIMIT 1`, so the vector column is never read and the scan
 * stops at the first row. Mirrors `SqliteVectorBackend`/`TursoVectorBackend`'s
 * `hasVectors` (an unknown space is "empty", not an error).
 */
async function hasVectors(state: DbState, modelId: string): Promise<boolean> {
  const space = state.spaces.get(modelId);
  if (!space) return false;
  const key = spaceKey(modelId, space.dim);
  const table = state.tables.get(key);
  if (!table) return false;

  const rows = await table.query().select(['id']).limit(1).toArray();
  return rows.length > 0;
}

runAsWorker(async (req: WorkerRequest): Promise<WorkerResponse> => {
  const state = await getDbState(req.lancedbPath);

  switch (req.op) {
    case 'init':
    case 'listSpaces': {
      return { spaces: listSpaces(state) };
    }
    case 'ensureSpace': {
      if (!req.space) throw new Error('ensureSpace requires space');
      await ensureSpace(state, req.space);
      return { spaces: listSpaces(state) };
    }
    case 'upsert': {
      if (!req.space || req.id == null || !req.vec) {
        throw new Error('upsert requires space, id, vec');
      }
      await upsert(state, req.space, req.id, req.vec, req.indexConfig);
      return {};
    }
    case 'delete': {
      if (!req.modelId || req.id == null) throw new Error('delete requires modelId, id');
      await del(state, req.modelId, req.id);
      return {};
    }
    case 'deleteMany': {
      if (!req.modelId || !req.ids) throw new Error('deleteMany requires modelId, ids');
      const count = await deleteMany(state, req.modelId, req.ids);
      return { count };
    }
    case 'get': {
      if (!req.modelId || req.id == null) throw new Error('get requires modelId, id');
      const vec = await get(state, req.modelId, req.id);
      return { vec };
    }
    case 'knn': {
      if (!req.space || !req.query || req.k == null) {
        throw new Error('knn requires space, query, k');
      }
      const results = await knn(state, req.space, req.query, req.k, req.indexConfig, req.filter);
      return { results };
    }
    case 'iter': {
      if (!req.modelId) throw new Error('iter requires modelId');
      const items = await iter(state, req.modelId, req.filter);
      return { items };
    }
    case 'hasVectors': {
      if (!req.modelId) throw new Error('hasVectors requires modelId');
      const exists = await hasVectors(state, req.modelId);
      return { exists };
    }
    default: {
      const _exhaustive: never = req.op;
      throw new Error(`Unknown op: ${String(_exhaustive)}`);
    }
  }
});
