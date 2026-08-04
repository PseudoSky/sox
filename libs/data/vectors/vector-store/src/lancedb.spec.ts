import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as lancedb from '@lancedb/lancedb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  LanceDbVectorBackend,
  openLanceDbVectorStore,
  reembed,
  SpaceInvariantError,
  type LanceDbVectorBackendConfig,
  type VectorSpace,
} from './index.js';

// These tests exercise the REAL @lancedb/lancedb client against a real on-disk
// LanceDB database directory (no in-memory stub, no mocks). Each test gets its
// own tmp directory so tables never leak across tests.

function makeTmpLanceDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lancedb-vector-store-test-'));
  return {
    dir,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function makeVec(dim: number, seed: number): Float32Array {
  const vec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) {
    vec[i] = (seed * 0.1 + i * 0.01) % 1.0;
  }
  let norm = 0;
  for (let i = 0; i < dim; i++) norm += vec[i]! * vec[i]!;
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < dim; i++) vec[i] = vec[i]! / norm;
  return vec;
}

function unitVec(dim: number, component: number): Float32Array {
  const vec = new Float32Array(dim);
  if (component >= 0 && component < dim) {
    vec[component] = 1.0;
  }
  return vec;
}

// A dummy sqlite handle to satisfy the pinned `{ db: Database.Database }`
// constructor shape — the real LanceDB backend does not use it.
function dummyDb(): Database.Database {
  return new Database(':memory:');
}

function makeBackend(dir: string, index?: LanceDbVectorBackendConfig['index']): LanceDbVectorBackend {
  // `index` is an OPTIONAL property, not a `T | undefined` one — under
  // exactOptionalPropertyTypes it must be omitted, never passed as undefined.
  return new LanceDbVectorBackend({
    lancedbPath: dir,
    ...(index === undefined ? {} : { index }),
    db: dummyDb(),
  });
}

describe('LanceDbVectorBackend (real on-disk @lancedb/lancedb)', () => {
  let dir: string;
  let cleanup: () => void;
  let backend: LanceDbVectorBackend;

  beforeEach(() => {
    const tmp = makeTmpLanceDir();
    dir = tmp.dir;
    cleanup = tmp.cleanup;
    backend = makeBackend(dir);
  });

  afterEach(() => {
    cleanup();
  });

  // ── ensureSpace ───────────────────────────────────────────────────────

  describe('ensureSpace', () => {
    it('creates table idempotently', () => {
      const space: VectorSpace = { modelId: 'test-model', dim: 4 };
      backend.ensureSpace(space);
      backend.ensureSpace(space);
      backend.ensureSpace(space);
      expect(backend.listSpaces()).toHaveLength(1);
    });

    it('creates a real on-disk LanceDB table (not in-memory)', () => {
      const space: VectorSpace = { modelId: 'disk-check', dim: 4 };
      backend.ensureSpace(space);

      // Files must actually exist on disk under lancedbPath.
      const entries = fs.readdirSync(dir);
      expect(entries.length).toBeGreaterThan(0);
    });

    it('persists spaces across a fresh backend instance pointed at the same path', async () => {
      const space: VectorSpace = { modelId: 'persisted-model', dim: 8 };
      backend.ensureSpace(space);
      backend.upsert(1, makeVec(8, 1), space);

      // Open a brand new backend instance against the SAME on-disk path —
      // this only works if ensureSpace/upsert wrote real, durable state.
      const reopened = makeBackend(dir);
      const spaces = reopened.listSpaces();
      expect(spaces).toHaveLength(1);
      expect(spaces[0]!.modelId).toBe('persisted-model');
      expect(spaces[0]!.dim).toBe(8);
      expect(reopened.get(1, 'persisted-model')).not.toBeNull();
    });
  });

  // ── listSpaces ────────────────────────────────────────────────────────

  describe('listSpaces', () => {
    it('returns created spaces', () => {
      backend.ensureSpace({ modelId: 'model-a', dim: 4 });
      backend.ensureSpace({ modelId: 'model-b', dim: 8 });

      const spaces = backend.listSpaces();
      expect(spaces).toHaveLength(2);
      const modelIds = spaces.map((s) => s.modelId).sort();
      expect(modelIds).toEqual(['model-a', 'model-b']);
    });

    it('returns empty for fresh backend', () => {
      expect(backend.listSpaces()).toEqual([]);
    });
  });

  // ── upsert / get ──────────────────────────────────────────────────────

  describe('upsert + get', () => {
    const space: VectorSpace = { modelId: 'test-model', dim: 4 };

    beforeEach(() => {
      backend.ensureSpace(space);
    });

    it('round-trips a vector through a real on-disk table', () => {
      const vec = makeVec(4, 1);
      backend.upsert(1, vec, space);
      const retrieved = backend.get(1, space.modelId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.length).toBe(4);
      for (let i = 0; i < 4; i++) {
        expect(retrieved![i]!).toBeCloseTo(vec[i]!, 4);
      }
    });

    it('updates vector on same id without creating a duplicate row', () => {
      const vec1 = makeVec(4, 1);
      const vec2 = makeVec(4, 99);
      backend.upsert(1, vec1, space);
      backend.upsert(1, vec2, space);

      const retrieved = backend.get(1, space.modelId);
      expect(retrieved).not.toBeNull();
      for (let i = 0; i < 4; i++) {
        expect(retrieved![i]!).toBeCloseTo(vec2[i]!, 4);
      }

      const items = [...backend.iter(space.modelId)];
      expect(items).toHaveLength(1);
    });

    it('throws SpaceInvariantError on dim mismatch', () => {
      const vec = makeVec(8, 1);
      expect(() => backend.upsert(1, vec, space)).toThrow(SpaceInvariantError);
      try {
        backend.upsert(1, vec, space);
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(SpaceInvariantError);
        const se = err as SpaceInvariantError;
        expect(se.nodeId).toBe(1);
        expect(se.space).toEqual(space);
        expect(se.actualDim).toBe(8);
      }
    });

    it('auto-calls ensureSpace on first upsert to an unseen space', () => {
      const autoSpace: VectorSpace = { modelId: 'auto-created', dim: 4 };
      backend.upsert(1, makeVec(4, 1), autoSpace);
      expect(backend.listSpaces().some((s) => s.modelId === 'auto-created')).toBe(true);
      expect(backend.get(1, 'auto-created')).not.toBeNull();
    });
  });

  // ── delete ────────────────────────────────────────────────────────────

  describe('delete', () => {
    const space: VectorSpace = { modelId: 'test-model', dim: 4 };

    beforeEach(() => {
      backend.ensureSpace(space);
    });

    it('removes from specific space', () => {
      backend.upsert(1, makeVec(4, 1), space);
      expect(backend.get(1, space.modelId)).not.toBeNull();

      backend.delete(1, space.modelId);
      expect(backend.get(1, space.modelId)).toBeNull();
    });

    it('does not affect vectors in other spaces', () => {
      const space2: VectorSpace = { modelId: 'other-model', dim: 4 };
      backend.ensureSpace(space2);

      backend.upsert(1, makeVec(4, 1), space);
      backend.upsert(1, makeVec(4, 2), space2);

      backend.delete(1, space.modelId);
      expect(backend.get(1, space.modelId)).toBeNull();
      expect(backend.get(1, space2.modelId)).not.toBeNull();
    });

    it('no-ops on non-existent id', () => {
      expect(() => backend.delete(999, space.modelId)).not.toThrow();
    });
  });

  // ── knn ───────────────────────────────────────────────────────────────

  describe('knn', () => {
    const space: VectorSpace = { modelId: 'test-model', dim: 4 };

    beforeEach(() => {
      backend.ensureSpace(space);
    });

    it('returns nearest neighbors sorted by score descending', () => {
      const query = unitVec(4, 0); // [1, 0, 0, 0]

      backend.upsert(1, unitVec(4, 0), space); // cos=1.0 — closest
      backend.upsert(2, unitVec(4, 1), space); // cos=0.0
      backend.upsert(3, unitVec(4, 2), space); // cos=0.0
      backend.upsert(4, new Float32Array([-1, 0, 0, 0]), space); // cos=-1.0 — farthest

      const results = backend.knn(query, space, 4);
      expect(results).toHaveLength(4);
      expect(results[0]!.id).toBe(1);
      expect(results[0]!.score).toBeCloseTo(1.0, 4);
      expect(results[results.length - 1]!.id).toBe(4);
      expect(results[results.length - 1]!.score).toBeCloseTo(-1.0, 4);
    });

    it('limits results to k', () => {
      for (let i = 1; i <= 5; i++) {
        backend.upsert(i, makeVec(4, i), space);
      }
      const results = backend.knn(makeVec(4, 0), space, 2);
      expect(results).toHaveLength(2);
    });

    it('respects filter.ids', () => {
      for (let i = 1; i <= 5; i++) {
        backend.upsert(i, makeVec(4, i), space);
      }
      const results = backend.knn(makeVec(4, 0), space, 5, { ids: [1, 3, 5] });
      const resultIds = results.map((r) => r.id);
      for (const id of resultIds) {
        expect([1, 3, 5]).toContain(id);
      }
    });

    it('returns empty for empty table', () => {
      const results = backend.knn(makeVec(4, 0), space, 10);
      expect(results).toEqual([]);
    });
  });

  // ── iter ──────────────────────────────────────────────────────────────

  describe('iter', () => {
    const space: VectorSpace = { modelId: 'test-model', dim: 4 };

    beforeEach(() => {
      backend.ensureSpace(space);
    });

    it('yields all vectors', () => {
      for (let i = 1; i <= 3; i++) {
        backend.upsert(i, makeVec(4, i), space);
      }
      const items = [...backend.iter(space.modelId)];
      expect(items).toHaveLength(3);
      const ids = items.map((i) => i.id).sort();
      expect(ids).toEqual([1, 2, 3]);
      for (const item of items) {
        expect(item.vec).toBeInstanceOf(Float32Array);
        expect(item.vec.length).toBe(4);
      }
    });

    it('respects filter.ids', () => {
      for (let i = 1; i <= 5; i++) {
        backend.upsert(i, makeVec(4, i), space);
      }
      const items = [...backend.iter(space.modelId, { filter: { ids: [2, 4] } })];
      expect(items.map((i) => i.id).sort()).toEqual([2, 4]);
    });

    it('returns empty for unknown modelId', () => {
      expect([...backend.iter('nonexistent-model')]).toHaveLength(0);
    });
  });

  // ── multiple spaces ───────────────────────────────────────────────────

  describe('multiple spaces', () => {
    it('different dims coexist (384 and 768)', () => {
      const space384: VectorSpace = { modelId: 'model-small', dim: 384 };
      const space768: VectorSpace = { modelId: 'model-large', dim: 768 };
      backend.ensureSpace(space384);
      backend.ensureSpace(space768);

      backend.upsert(1, makeVec(384, 1), space384);
      backend.upsert(1, makeVec(768, 2), space768);

      expect(backend.get(1, 'model-small')!.length).toBe(384);
      expect(backend.get(1, 'model-large')!.length).toBe(768);

      expect(() => backend.upsert(1, makeVec(384, 1), space768)).toThrow(SpaceInvariantError);
    });

    it('same dim, different modelId stay isolated (reembed source/target shape)', () => {
      const oldSpace: VectorSpace = { modelId: 'old', dim: 4 };
      const newSpace: VectorSpace = { modelId: 'new', dim: 4 };
      backend.ensureSpace(oldSpace);
      backend.ensureSpace(newSpace);

      backend.upsert(1, makeVec(4, 1), oldSpace);
      expect(backend.get(1, 'new')).toBeNull();
      expect(backend.get(1, 'old')).not.toBeNull();
    });
  });
});

// ── openLanceDbVectorStore ────────────────────────────────────────────────────

describe('openLanceDbVectorStore', () => {
  it('creates a real on-disk backend via the factory', () => {
    const tmp = makeTmpLanceDir();
    try {
      const store = openLanceDbVectorStore({ lancedbPath: tmp.dir, db: dummyDb() });
      store.ensureSpace({ modelId: 'factory-model', dim: 4 });
      store.upsert(1, makeVec(4, 1), { modelId: 'factory-model', dim: 4 });
      expect(store.get(1, 'factory-model')).not.toBeNull();
      expect(fs.readdirSync(tmp.dir).length).toBeGreaterThan(0);
    } finally {
      tmp.cleanup();
    }
  });
});

// ── reembed (backend-agnostic — must work against LanceDbVectorBackend too) ──

describe('reembed against LanceDbVectorBackend', () => {
  it('migrates vectors from a Lance source space into a Lance target space', async () => {
    const tmp = makeTmpLanceDir();
    try {
      const backend = makeBackend(tmp.dir);
      const sourceSpace: VectorSpace = { modelId: 'old', dim: 4 };
      const targetSpace: VectorSpace = { modelId: 'new', dim: 4 };

      backend.ensureSpace(sourceSpace);
      backend.upsert(1, makeVec(4, 1), sourceSpace);
      backend.upsert(2, makeVec(4, 2), sourceSpace);

      const textMap = new Map<number, string>([
        [1, 'hello world'],
        [2, 'foo bar baz'],
      ]);

      const mockProvider = {
        metadata: { modelId: 'new', dimensions: 4 },
        embedBatch: async function* (texts: string[]): AsyncIterable<Float32Array> {
          for (const _ of texts) {
            yield makeVec(4, texts.length);
          }
        },
      };

      const result = await reembed(backend, mockProvider, {
        targetSpace,
        sourceModelId: 'old',
        getText: (id) => textMap.get(id) ?? null,
      });

      expect(result.migrated).toBe(2);
      expect(result.errors).toHaveLength(0);
      expect(backend.get(1, 'new')).not.toBeNull();
      expect(backend.get(2, 'new')).not.toBeNull();
      // Source space untouched.
      expect([...backend.iter('old')]).toHaveLength(2);
    } finally {
      tmp.cleanup();
    }
  });
});

// ── ANN index construction (HNSW / IVF-PQ) ────────────────────────────────────
//
// Verifies against the RAW @lancedb/lancedb client (bypassing our own sync
// bridge) that createIndex() actually ran and produced a real index of the
// requested type on the 'vector' column — proof this isn't a brute-force
// scan wearing an ANN config.

describe('ANN index construction', () => {
  it('builds a real IVF_PQ index when index.type is "ivf-pq"', async () => {
    const tmp = makeTmpLanceDir();
    try {
      const backend = makeBackend(tmp.dir, {
        type: 'ivf-pq',
        numPartitions: 2,
        // PQ trains one codebook of 2^bitsPerSubVector centroids per
        // sub-vector; a small bit width keeps the training-set floor low
        // enough for a fast, deterministic test fixture (real LanceDB
        // requires >= 2^bitsPerSubVector training rows for PQ).
        bitsPerSubVector: 4,
        metric: 'cosine',
      });
      const space: VectorSpace = { modelId: 'ivfpq-model', dim: 8 };
      backend.ensureSpace(space);

      for (let i = 1; i <= 40; i++) {
        backend.upsert(i, makeVec(8, i), space);
      }

      const conn = await lancedb.connect(tmp.dir);
      const table = await conn.openTable('vec_ivfpq_model_8');
      const indices = await table.listIndices();
      const vectorIndex = indices.find((idx) => idx.columns.includes('vector'));
      expect(vectorIndex).toBeDefined();
      expect(vectorIndex!.indexType.toUpperCase()).toContain('IVF');

      // The index is actually usable for search (real ANN, not vestigial).
      const results = backend.knn(makeVec(8, 1), space, 5);
      expect(results.length).toBeGreaterThan(0);
    } finally {
      tmp.cleanup();
    }
  });

  it('builds a real HNSW index when index.type is "hnsw"', async () => {
    const tmp = makeTmpLanceDir();
    try {
      const backend = makeBackend(tmp.dir, {
        type: 'hnsw',
        M: 8,
        efConstruction: 100,
        metric: 'cosine',
      });
      const space: VectorSpace = { modelId: 'hnsw-model', dim: 8 };
      backend.ensureSpace(space);

      for (let i = 1; i <= 40; i++) {
        backend.upsert(i, makeVec(8, i), space);
      }

      const conn = await lancedb.connect(tmp.dir);
      const table = await conn.openTable('vec_hnsw_model_8');
      const indices = await table.listIndices();
      const vectorIndex = indices.find((idx) => idx.columns.includes('vector'));
      expect(vectorIndex).toBeDefined();
      expect(vectorIndex!.indexType.toUpperCase()).toContain('HNSW');

      const results = backend.knn(makeVec(8, 1), space, 5);
      expect(results.length).toBeGreaterThan(0);
    } finally {
      tmp.cleanup();
    }
  });
});
