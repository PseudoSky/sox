import type { VectorBackend, VectorSpace, VecFilter } from './index.js';
import { SpaceInvariantError } from './index.js';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createSyncFn } from 'synckit';
import type { WorkerRequest, WorkerResponse } from './lancedb-worker.js';

// ── Config ──────────────────────────────────────────────────────────────────

export interface LanceDbVectorBackendConfig {
  lancedbPath: string;
  index?: {
    type: 'hnsw' | 'ivf-pq';
    M?: number;
    efConstruction?: number;
    numPartitions?: number;
    numSubVectors?: number;
    bitsPerSubVector?: number;
    metric?: 'cosine' | 'l2' | 'dot';
  };
}

// ── Synchronous bridge to the real @lancedb/lancedb client ──────────────────
//
// @lancedb/lancedb is an async (napi/tokio) client; VectorBackend is a
// synchronous interface ([iface:vector-backend] is pinned — unchanged by this
// swap). `synckit` runs lancedb-worker.ts in a worker_threads.Worker and
// blocks the calling thread on Atomics.wait until each request resolves, so
// every method below is a real synchronous call into a real on-disk LanceDB
// table — not a simulation and not a cache that silently drops writes.

type SyncLanceFn = (req: WorkerRequest) => WorkerResponse;

let cachedSyncFn: SyncLanceFn | undefined;

function resolveWorkerPath(): string {
  // Production/build: dist/lancedb-worker.js sits next to dist/lancedb.js.
  const compiledPath = fileURLToPath(new URL('./lancedb-worker.js', import.meta.url));
  if (fs.existsSync(compiledPath)) return compiledPath;
  // Dev/test (vitest runs directly against src/*.ts, no dist/ sibling yet):
  // fall back to the TypeScript source; Node's native type-stripping (>=22.6,
  // unflagged since 23.6) runs it directly, matched by `synckit`'s default
  // 'node' ts runner.
  return fileURLToPath(new URL('./lancedb-worker.ts', import.meta.url));
}

function getSyncFn(): SyncLanceFn {
  if (!cachedSyncFn) {
    cachedSyncFn = createSyncFn(resolveWorkerPath()) as SyncLanceFn;
  }
  return cachedSyncFn;
}

// A raw driver handle (e.g. `better-sqlite3.Database`) has no `capabilities`
// field — duck-type on that to catch the mistake at the boundary with a named
// error, rather than letting it surface as an opaque failure three calls
// later inside `getSyncFn()`. Mirrors `index.ts`'s `requireSqliteHandle`
// guard (same package, same BL-364 lesson). A plain `TypeError` is used
// (not `index.ts`'s `StorageError`) to avoid a circular import — `index.ts`
// imports `LanceDbVectorBackend` from this file.
function requireStoreAdapterShape(adapter: unknown): asserts adapter is StoreAdapter {
  if (
    adapter === null ||
    typeof adapter !== 'object' ||
    (adapter as { capabilities?: unknown }).capabilities === undefined
  ) {
    throw new TypeError(
      'LanceDbVectorBackend requires a StoreAdapter, not a raw driver handle — ' +
        'construct one via createSqliteAdapter()/createTursoAdapter() (or ' +
        'createStoreAdapter()) from @adhd/sox-store-adapter and pass it as `adapter`.',
    );
  }
}

// ── LanceDbVectorBackend ────────────────────────────────────────────────────

export class LanceDbVectorBackend implements VectorBackend {
  private readonly lancedbPath: string;
  private readonly indexConfig: LanceDbVectorBackendConfig['index'];
  private readonly adapter: StoreAdapter;
  private spaces: VectorSpace[];

  constructor(config: LanceDbVectorBackendConfig & { adapter: StoreAdapter }) {
    requireStoreAdapterShape(config.adapter);
    this.adapter = config.adapter;
    this.lancedbPath = config.lancedbPath;
    this.indexConfig = config.index;

    // Synchronously open (or reopen) the on-disk LanceDB database at
    // lancedbPath and rehydrate any spaces persisted from a previous process
    // — real persistence, not a fresh-every-time in-memory cache.
    const res = getSyncFn()({ op: 'init', lancedbPath: this.lancedbPath });
    this.spaces = res.spaces ?? [];

    console.info(
      `[vector-store] LanceDbVectorBackend opened: path=${config.lancedbPath} ` +
        `adapterType=${this.adapter.config.type}`,
    );
  }

  ensureSpace(space: VectorSpace): void {
    if (this.spaces.some((s) => s.modelId === space.modelId && s.dim === space.dim)) {
      return;
    }
    getSyncFn()({ op: 'ensureSpace', lancedbPath: this.lancedbPath, space });
    this.spaces.push(space);
    console.info(
      `[vector-store] LanceDB space created: modelId=${space.modelId} dim=${space.dim}`,
    );
  }

  listSpaces(): VectorSpace[] {
    return [...this.spaces];
  }

  upsert(id: number, vec: Float32Array, space: VectorSpace): void {
    if (vec.length !== space.dim) {
      throw new SpaceInvariantError(id, space, vec.length);
    }
    this.ensureSpace(space);
    getSyncFn()({
      op: 'upsert',
      lancedbPath: this.lancedbPath,
      space,
      id,
      vec,
      indexConfig: this.indexConfig,
    });
  }

  upsertVectors(items: Array<{ id: number; vec: Float32Array }>, space: VectorSpace): void {
    // LanceDB has no cross-table transaction via the synckit worker; a batch is
    // a bounded loop of single upserts (correct, not optimized). Turso/sqlite
    // backends get the transactional fast path.
    for (const { id, vec } of items) this.upsert(id, vec, space);
  }

  delete(id: number, modelId: string): void {
    getSyncFn()({ op: 'delete', lancedbPath: this.lancedbPath, modelId, id });
  }

  /**
   * DEBT-011 (Move 3) — remove exactly the given ids, returning the count
   * removed. LanceDB vectors live in a separate store (no graph `node` table),
   * so this is a pure id-scoped delete — which is exactly why the old
   * `pruneInvalidatedVectors` (node-join) was unsupported here and the
   * node-specific prune is now facade/host composition.
   */
  deleteMany(ids: number[], modelId: string): number {
    if (ids.length === 0) return 0;
    const res = getSyncFn()({ op: 'deleteMany', lancedbPath: this.lancedbPath, modelId, ids });
    return res.count ?? 0;
  }

  get(id: number, modelId: string): Float32Array | null {
    const res = getSyncFn()({ op: 'get', lancedbPath: this.lancedbPath, modelId, id });
    return res.vec ? new Float32Array(res.vec) : null;
  }

  knn(
    query: Float32Array,
    space: VectorSpace,
    k: number,
    filter?: VecFilter,
  ): Array<{ id: number; score: number }> {
    const res = getSyncFn()({
      op: 'knn',
      lancedbPath: this.lancedbPath,
      space,
      query,
      k,
      filter,
      indexConfig: this.indexConfig,
    });
    return res.results ?? [];
  }

  iter(
    modelId: string,
    opts?: { filter?: VecFilter },
  ): Iterable<{ id: number; vec: Float32Array }> {
    const res = getSyncFn()({
      op: 'iter',
      lancedbPath: this.lancedbPath,
      modelId,
      filter: opts?.filter,
    });
    const items = (res.items ?? []).map((it) => ({ id: it.id, vec: new Float32Array(it.vec) }));
    return {
      *[Symbol.iterator]() {
        for (const item of items) yield item;
      },
    };
  }
}
