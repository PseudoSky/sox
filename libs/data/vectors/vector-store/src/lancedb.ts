import type { VectorBackend, VectorSpace, VecFilter } from './index.js';
import { SpaceInvariantError } from './index.js';
import type Database from 'better-sqlite3';

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

interface LanceDbTable {
  dimension: number;
  upsert(id: number, vec: Float32Array): void;
  search(query: Float32Array, k: number, filter?: VecFilter): Array<{ id: number; score: number }>;
  delete(id: number): void;
  get(id: number): Float32Array | null;
  iter(): Array<{ id: number; vec: Float32Array }>;
  count(): number;
}

// ── In-memory LanceDB simulation ─────────────────────────────────────────────
// LanceDB client is not yet installed. This provides the VectorBackend adapter
// interface with an in-memory fallback that mirrors the LanceDB API shape.
// When @lancedb/lancedb is added as a dependency, swap the implementation.

/**
 * In-memory simulation of a LanceDB table.
 * Placeholder for when `@lancedb/lancedb` is available as a dependency.
 * Once added, replace this class with the real LanceDB Table binding.
 */
class InMemoryLanceTable implements LanceDbTable {
  readonly dimension: number;
  private vectors = new Map<number, Float32Array>();

  constructor(dim: number) {
    this.dimension = dim;
  }

  upsert(id: number, vec: Float32Array): void {
    if (vec.length !== this.dimension) {
      throw new Error(`dimension mismatch: got ${vec.length}, expected ${this.dimension}`);
    }
    this.vectors.set(id, vec);
  }

  search(query: Float32Array, k: number, filter?: VecFilter): Array<{ id: number; score: number }> {
    const candidates: Array<{ id: number; score: number }> = [];

    for (const [id, vec] of this.vectors) {
      if (filter?.ids && !filter.ids.includes(id)) continue;
      const score = cosineSimilarity(query, vec);
      candidates.push({ id, score });
    }

    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, k);
  }

  delete(id: number): void {
    this.vectors.delete(id);
  }

  get(id: number): Float32Array | null {
    return this.vectors.get(id) ?? null;
  }

  iter(): Array<{ id: number; vec: Float32Array }> {
    return [...this.vectors.entries()].map(([id, vec]) => ({ id, vec }));
  }

  count(): number {
    return this.vectors.size;
  }
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

// ── LanceDbVectorBackend ────────────────────────────────────────────────────

export class LanceDbVectorBackend implements VectorBackend {
  private tables = new Map<string, InMemoryLanceTable>();
  private spaces: VectorSpace[] = [];

  constructor(config: LanceDbVectorBackendConfig & { db: Database.Database }) {
    console.info(`[vector-store] LanceDbVectorBackend created: path=${config.lancedbPath}`);
  }

  ensureSpace(space: VectorSpace): void {
    const key = this.tableKey(space);
    if (!this.tables.has(key)) {
      this.tables.set(key, new InMemoryLanceTable(space.dim));
      this.spaces.push(space);
      console.info(
        `[vector-store] LanceDB space created: modelId=${space.modelId} dim=${space.dim}`,
      );
    }
  }

  listSpaces(): VectorSpace[] {
    return [...this.spaces];
  }

  upsert(id: number, vec: Float32Array, space: VectorSpace): void {
    if (vec.length !== space.dim) {
      throw new SpaceInvariantError(id, space, vec.length);
    }
    const table = this.getTable(space);
    table.upsert(id, vec);
  }

  delete(id: number, modelId: string): void {
    const space = this.spaces.find((s) => s.modelId === modelId);
    if (!space) return;
    const table = this.getTable(space);
    table.delete(id);
  }

  get(id: number, modelId: string): Float32Array | null {
    const space = this.spaces.find((s) => s.modelId === modelId);
    if (!space) return null;
    const table = this.getTable(space);
    return table.get(id);
  }

  knn(
    query: Float32Array,
    space: VectorSpace,
    k: number,
    filter?: VecFilter,
  ): Array<{ id: number; score: number }> {
    const table = this.getTable(space);
    return table.search(query, k, filter);
  }

  iter(
    modelId: string,
    opts?: { filter?: VecFilter },
  ): Iterable<{ id: number; vec: Float32Array }> {
    const space = this.spaces.find((s) => s.modelId === modelId);
    if (!space) {
      return {
        *[Symbol.iterator]() {
          // empty
        },
      };
    }
    const table = this.getTable(space);
    const all = table.iter();
    const filterIds = opts?.filter?.ids;

    if (filterIds) {
      const filtered = all.filter((item) => filterIds.includes(item.id));
      return {
        *[Symbol.iterator]() {
          for (const item of filtered) yield item;
        },
      };
    }

    return {
      *[Symbol.iterator]() {
        for (const item of all) yield item;
      },
    };
  }

  // ── Private ─────────────────────────────────────────────────────────────

  private tableKey(space: VectorSpace): string {
    return `${space.modelId}_${space.dim}`;
  }

  private getTable(space: VectorSpace): InMemoryLanceTable {
    const key = this.tableKey(space);
    const existing = this.tables.get(key);
    if (!existing) {
      throw new Error(`Space not found: ${space.modelId} dim=${space.dim} — call ensureSpace() first`);
    }
    return existing;
  }
}
