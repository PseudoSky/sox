import type { VectorBackend, VectorSpace, VecFilter } from './index.js';
import { SpaceInvariantError } from './index.js';
import type Database from 'better-sqlite3';
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

// ── LanceDbVectorBackend ────────────────────────────────────────────────────

export class LanceDbVectorBackend implements VectorBackend {
  private readonly lancedbPath: string;
  private readonly indexConfig: LanceDbVectorBackendConfig['index'];
  private spaces: VectorSpace[];

  constructor(config: LanceDbVectorBackendConfig & { db: Database.Database }) {
    this.lancedbPath = config.lancedbPath;
    this.indexConfig = config.index;

    // Synchronously open (or reopen) the on-disk LanceDB database at
    // lancedbPath and rehydrate any spaces persisted from a previous process
    // — real persistence, not a fresh-every-time in-memory cache.
    const res = getSyncFn()({ op: 'init', lancedbPath: this.lancedbPath });
    this.spaces = res.spaces ?? [];

    console.info(`[vector-store] LanceDbVectorBackend opened: path=${config.lancedbPath}`);
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

  delete(id: number, modelId: string): void {
    getSyncFn()({ op: 'delete', lancedbPath: this.lancedbPath, modelId, id });
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
