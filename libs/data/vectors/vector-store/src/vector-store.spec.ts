import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGraphBackend, type GraphBackend } from '@adhd/sox-graph-store';
import { createSqliteAdapter, type StoreAdapter, type SqliteAdapter } from '@adhd/sox-store-adapter';

import {
  openVectorStore,
  reembed,
  SpaceInvariantError,
  StorageError,
  SqliteVectorBackend,
  type ReembedOpts,
  type ReembedResult,
  type VectorSpace,
} from './index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeTmpDb(): { adapter: StoreAdapter; db: Database.Database; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-store-test-'));
  const dbPath = path.join(dir, 'test.db');
  const adapter = createSqliteAdapter({ dbPath });
  const db = (adapter as SqliteAdapter).unwrap();
  sqliteVec.load(db);
  return {
    adapter,
    db,
    cleanup: () => {
      try { adapter.close(); } catch { /* ignore */ }
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

// ── Tests ────────────────────────────────────────────────────────────────────

describe('SqliteVectorBackend', () => {
  let db: Database.Database;
  let adapter: StoreAdapter;
  let backend: SqliteVectorBackend;
  let cleanup: () => void;

  beforeEach(() => {
    const tmp = makeTmpDb();
    adapter = tmp.adapter;
    db = tmp.db;
    cleanup = tmp.cleanup;
    backend = new SqliteVectorBackend(adapter);
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
    });

    it('records space in _vector_spaces metadata', () => {
      const space: VectorSpace = { modelId: 'model-a', dim: 384 };
      backend.ensureSpace(space);
      const row = db
        .prepare<[string], { model_id: string; dim: number }>(
          `SELECT model_id, dim FROM _vector_spaces WHERE model_id = ?`,
        )
        .get(space.modelId);
      expect(row).toBeDefined();
      expect(row!.model_id).toBe(space.modelId);
      expect(row!.dim).toBe(space.dim);
    });
  });

  // ── listSpaces ────────────────────────────────────────────────────────

  describe('listSpaces', () => {
    it('returns created spaces', () => {
      const space1: VectorSpace = { modelId: 'model-a', dim: 384 };
      const space2: VectorSpace = { modelId: 'model-b', dim: 768 };
      backend.ensureSpace(space1);
      backend.ensureSpace(space2);

      const spaces = backend.listSpaces();
      expect(spaces).toHaveLength(2);
      const modelIds = spaces.map((s) => s.modelId).sort();
      expect(modelIds).toEqual(['model-a', 'model-b']);
      const dims = spaces.map((s) => s.dim).sort();
      expect(dims).toEqual([384, 768]);
    });

    it('returns empty for fresh backend', () => {
      expect(backend.listSpaces()).toEqual([]);
    });
  });

  // ── upsert ────────────────────────────────────────────────────────────

  describe('upsert', () => {
    const space: VectorSpace = { modelId: 'test-model', dim: 4 };

    beforeEach(() => {
      backend.ensureSpace(space);
    });

    it('inserts vector (INSERT path)', () => {
      const vec = makeVec(4, 1);
      backend.upsert(1, vec, space);
      const retrieved = backend.get(1, space.modelId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.length).toBe(4);
      for (let i = 0; i < 4; i++) {
        expect(retrieved![i]!).toBeCloseTo(vec[i]!, 5);
      }
    });

    it('updates vector on same id (UPDATE path)', () => {
      const vec1 = makeVec(4, 1);
      const vec2 = makeVec(4, 99);
      backend.upsert(1, vec1, space);
      backend.upsert(1, vec2, space);

      const retrieved = backend.get(1, space.modelId);
      expect(retrieved).not.toBeNull();
      for (let i = 0; i < 4; i++) {
        expect(retrieved![i]!).toBeCloseTo(vec2[i]!, 5);
      }
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

    it('BL-91: uses UPDATE-then-INSERT (verify no UNIQUE error on re-upsert)', () => {
      const vec = makeVec(4, 1);
      backend.upsert(1, vec, space);
      backend.upsert(1, makeVec(4, 2), space);
      backend.upsert(1, makeVec(4, 3), space);
      backend.upsert(2, makeVec(4, 4), space);

      expect(backend.get(1, space.modelId)).not.toBeNull();
      expect(backend.get(2, space.modelId)).not.toBeNull();
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
      backend.delete(999, space.modelId);
    });
  });

  // ── get ───────────────────────────────────────────────────────────────

  describe('get', () => {
    const space: VectorSpace = { modelId: 'test-model', dim: 4 };

    beforeEach(() => {
      backend.ensureSpace(space);
    });

    it('returns vector for existing id', () => {
      const vec = makeVec(4, 42);
      backend.upsert(1, vec, space);
      const retrieved = backend.get(1, space.modelId);
      expect(retrieved).not.toBeNull();
      expect(retrieved!.length).toBe(4);
      for (let i = 0; i < 4; i++) {
        expect(retrieved![i]!).toBeCloseTo(vec[i]!, 5);
      }
    });

    it('returns null for non-existing id', () => {
      expect(backend.get(999, space.modelId)).toBeNull();
    });

    it('returns null for unknown modelId', () => {
      expect(backend.get(1, 'nonexistent-model')).toBeNull();
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
      backend.upsert(
        4,
        new Float32Array([-1, 0, 0, 0]),
        space, // cos=-1.0 — farthest
      );

      const results = backend.knn(query, space, 4);
      expect(results).toHaveLength(4);
      expect(results[0]!.id).toBe(1); // id=1 should be closest
      expect(results[0]!.score).toBeCloseTo(1.0, 5);
    });

    it('limits results to k', () => {
      const query = makeVec(4, 0);
      for (let i = 1; i <= 5; i++) {
        backend.upsert(i, makeVec(4, i), space);
      }

      const results = backend.knn(query, space, 2);
      expect(results).toHaveLength(2);
    });

    it('respects filter.ids', () => {
      const query = makeVec(4, 0);
      for (let i = 1; i <= 5; i++) {
        backend.upsert(i, makeVec(4, i), space);
      }

      const results = backend.knn(query, space, 5, { ids: [1, 3, 5] });
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

  // ── knn — filtered-KNN pushdown (VecFilter.nodeFilter) ──────────────────
  //
  // Proves the real correctness gap this upgrade closes: a neighbor that is
  // nearest by cosine but out-of-scope must be EXCLUDED once a nodeFilter is
  // supplied, and the same query WITHOUT a filter must still return that
  // out-of-scope neighbor unchanged (the pre-upgrade behavior, preserved).
  describe('knn — nodeFilter (filtered-KNN pushdown)', () => {
    const space: VectorSpace = { modelId: 'test-model', dim: 4 };
    let graph: GraphBackend;
    let inScopeId: number;
    let outOfScopeId: number;

    beforeEach(async () => {
      backend.ensureSpace(space);
      // SqliteVectorBackend.knn's nodeFilter JOINs against the `node` table —
      // this is only meaningful when the vector store is constructed over the
      // SAME db handle as a real GraphBackend (per RAG-SPEC §2.1 / DESIGN.md
      // §2's "constructed directly over an existing Database handle" usage),
      // exactly as production backlog/hybrid-search callers do.
      graph = createGraphBackend(adapter);
      await graph.applySchema();

      inScopeId = await graph.writeNode('in-scope node content', {
        namespace: 'scope-a',
        kind: 'generic',
      });
      outOfScopeId = await graph.writeNode('out-of-scope node content', {
        namespace: 'scope-b',
        kind: 'generic',
      });

      const query = unitVec(4, 0); // [1, 0, 0, 0]
      // out-of-scope vector is the TRUE nearest neighbor (cos = 1.0, identical
      // to the query); in-scope vector is farther (cos = 0.0) — so an
      // unfiltered/pre-filter-pushdown knn call must prefer the out-of-scope
      // node, and only the nodeFilter forces it out of the result.
      backend.upsert(outOfScopeId, unitVec(4, 0), space);
      backend.upsert(inScopeId, unitVec(4, 1), space);
    });

    it('negative control: WITHOUT a filter, the nearer out-of-scope neighbor IS returned (pre-change behavior, unaffected by this upgrade)', () => {
      const query = unitVec(4, 0);
      const results = backend.knn(query, space, 1);
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe(outOfScopeId);
      expect(results[0]!.score).toBeCloseTo(1.0, 5);
    });

    it('WITH nodeFilter.namespace, the nearer out-of-scope neighbor is excluded and the farther in-scope neighbor is returned', () => {
      const query = unitVec(4, 0);
      const results = backend.knn(query, space, 1, {
        nodeFilter: { namespace: 'scope-a' },
      });
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe(inScopeId);
    });

    it('WITH nodeFilter over the full k, only in-scope ids ever appear — the out-of-scope id never leaks in', () => {
      const query = unitVec(4, 0);
      const results = backend.knn(query, space, 10, {
        nodeFilter: { namespace: 'scope-a' },
      });
      const resultIds = results.map((r) => r.id);
      expect(resultIds).toContain(inScopeId);
      expect(resultIds).not.toContain(outOfScopeId);
    });

    it('nodeFilter matching zero nodes returns zero candidates (never "no filter applied")', () => {
      const query = unitVec(4, 0);
      const results = backend.knn(query, space, 10, {
        nodeFilter: { namespace: 'scope-does-not-exist' },
      });
      expect(results).toEqual([]);
    });

    it('nodeFilter is ANDed with ids when both are given', () => {
      const query = unitVec(4, 0);
      // ids includes BOTH nodes, but nodeFilter restricts to scope-a only —
      // the AND must still exclude the out-of-scope id even though it passes
      // the ids filter alone.
      const results = backend.knn(query, space, 10, {
        ids: [inScopeId, outOfScopeId],
        nodeFilter: { namespace: 'scope-a' },
      });
      const resultIds = results.map((r) => r.id);
      expect(resultIds).toEqual([inScopeId]);
    });

    it('unfiltered ids-only path (no nodeFilter) is unaffected — existing {ids} callers keep working byte-identically', () => {
      const query = unitVec(4, 0);
      const results = backend.knn(query, space, 10, {
        ids: [inScopeId, outOfScopeId],
      });
      const resultIds = results.map((r) => r.id).sort();
      expect(resultIds).toEqual([inScopeId, outOfScopeId].sort());
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

    it('supports for...of iteration', () => {
      backend.upsert(1, makeVec(4, 1), space);
      backend.upsert(2, makeVec(4, 2), space);

      let count = 0;
      for (const item of backend.iter(space.modelId)) {
        expect(typeof item.id).toBe('number');
        expect(item.vec).toBeInstanceOf(Float32Array);
        count++;
      }
      expect(count).toBe(2);
    });

    it('respects filter.ids', () => {
      for (let i = 1; i <= 5; i++) {
        backend.upsert(i, makeVec(4, i), space);
      }

      const items = [...backend.iter(space.modelId, { filter: { ids: [2, 4] } })];
      expect(items.map((i) => i.id).sort()).toEqual([2, 4]);
    });

    it('returns empty for unknown modelId', () => {
      const items = [...backend.iter('nonexistent-model')];
      expect(items).toHaveLength(0);
    });

    it('returns empty when no vectors inserted', () => {
      const items = [...backend.iter(space.modelId)];
      expect(items).toHaveLength(0);
    });
  });

  // ── Multiple spaces ───────────────────────────────────────────────────

  describe('multiple spaces', () => {
    it('different dims coexist (384 and 768)', () => {
      const space384: VectorSpace = { modelId: 'model-small', dim: 384 };
      const space768: VectorSpace = { modelId: 'model-large', dim: 768 };

      backend.ensureSpace(space384);
      backend.ensureSpace(space768);

      const vec384 = makeVec(384, 1);
      const vec768 = makeVec(768, 2);

      backend.upsert(1, vec384, space384);
      backend.upsert(1, vec768, space768);

      expect(backend.get(1, 'model-small')!.length).toBe(384);
      expect(backend.get(1, 'model-large')!.length).toBe(768);

      // Cross-space dim mismatch
      expect(() => backend.upsert(1, vec384, space768)).toThrow(
        SpaceInvariantError,
      );
    });

    it('listSpaces returns all spaces', () => {
      backend.ensureSpace({ modelId: 'a', dim: 384 });
      backend.ensureSpace({ modelId: 'b', dim: 768 });
      backend.ensureSpace({ modelId: 'c', dim: 1024 });

      const spaces = backend.listSpaces();
      expect(spaces).toHaveLength(3);
    });
  });
});

// ── openVectorStore ─────────────────────────────────────────────────────────

describe('openVectorStore', () => {
  it('opens a standalone DB and creates backend with initial space', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vector-store-ovs-'));
    const dbPath = path.join(dir, 'store.db');

    let store: SqliteVectorBackend | undefined;
    try {
      store = openVectorStore(dbPath, { modelId: 'init-model', dim: 8 });
      const spaces = store.listSpaces();
      expect(spaces).toHaveLength(1);
      expect(spaces[0]!.modelId).toBe('init-model');
      expect(spaces[0]!.dim).toBe(8);

      const vec = makeVec(8, 1);
      store.upsert(1, vec, { modelId: 'init-model', dim: 8 });
      expect(store.get(1, 'init-model')).not.toBeNull();
    } finally {
      try {
        store = undefined;
        // close by letting gc handle; delete file
      } catch {
        /* ignore */
      }
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});

// ── reembed ─────────────────────────────────────────────────────────────────

describe('reembed', () => {
  let db: Database.Database;
  let adapter: StoreAdapter;
  let backend: SqliteVectorBackend;
  let cleanup: () => void;

  beforeEach(() => {
    const tmp = makeTmpDb();
    adapter = tmp.adapter;
    db = tmp.db;
    cleanup = tmp.cleanup;
    backend = new SqliteVectorBackend(adapter);
  });

  afterEach(() => {
    cleanup();
  });

  it('dry-run walks source space and reports count', async () => {
    const sourceSpace: VectorSpace = { modelId: 'old-model', dim: 4 };
    const targetSpace: VectorSpace = { modelId: 'new-model', dim: 8 };

    backend.ensureSpace(sourceSpace);
    for (let i = 1; i <= 5; i++) {
      backend.upsert(i, makeVec(4, i), sourceSpace);
    }

    const mockProvider = {
      metadata: { modelId: 'new-model', dimensions: 8 },
      embedBatch: async function* () {
        yield new Float32Array(8);
      },
    };

    const result = await reembed(backend, mockProvider, {
      targetSpace,
      sourceModelId: 'old-model',
      dryRun: true,
    });

    expect(result.migrated).toBe(5);
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    // Source space is preserved
    expect([...backend.iter('old-model')]).toHaveLength(5);
  });

  it('dry-run auto-detects source space', async () => {
    const sourceSpace: VectorSpace = { modelId: 'src', dim: 4 };
    backend.ensureSpace(sourceSpace);
    backend.upsert(1, makeVec(4, 1), sourceSpace);

    const targetSpace: VectorSpace = { modelId: 'dst', dim: 8 };

    const mockProvider = {
      metadata: { modelId: 'dst', dimensions: 8 },
      embedBatch: async function* () {
        yield new Float32Array(8);
      },
    };

    const result = await reembed(backend, mockProvider, {
      targetSpace,
      dryRun: true,
    });

    expect(result.migrated).toBe(1);
  });

  it('dry-run returns zero when no source space found', async () => {
    const mockProvider = {
      metadata: { modelId: 'm', dimensions: 8 },
      embedBatch: async function* () {
        yield new Float32Array(8);
      },
    };

    const result = await reembed(backend, mockProvider, {
      targetSpace: { modelId: 'dst', dim: 8 },
      dryRun: true,
    });

    expect(result.migrated).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('non-dry-run migrates vectors with getText', async () => {
    const sourceSpace: VectorSpace = { modelId: 'old', dim: 4 };
    const targetSpace: VectorSpace = { modelId: 'new', dim: 4 };

    backend.ensureSpace(sourceSpace);
    backend.upsert(1, makeVec(4, 1), sourceSpace);
    backend.upsert(2, makeVec(4, 2), sourceSpace);

    const textMap = new Map<number, string>([
      [1, 'hello world'],
      [2, 'foo bar baz'],
    ]);

    let batchReceived: string[] = [];
    const mockProvider = {
      metadata: { modelId: 'new', dimensions: 4 },
      embedBatch: async function* (
        texts: string[],
      ): AsyncIterable<Float32Array> {
        batchReceived = texts;
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
    expect(result.skipped).toBe(0);
    expect(result.errors).toHaveLength(0);
    expect(batchReceived).toEqual(['hello world', 'foo bar baz']);

    // Target space has the migrated vectors
    expect(backend.get(1, 'new')).not.toBeNull();
    expect(backend.get(2, 'new')).not.toBeNull();
  });

  it('non-dry-run skips entries without text', async () => {
    const sourceSpace: VectorSpace = { modelId: 'old', dim: 4 };
    const targetSpace: VectorSpace = { modelId: 'new', dim: 4 };

    backend.ensureSpace(sourceSpace);
    backend.upsert(1, makeVec(4, 1), sourceSpace);
    backend.upsert(2, makeVec(4, 2), sourceSpace);

    const textMap = new Map<number, string>([[1, 'has text']]);

    const mockProvider = {
      metadata: { modelId: 'new', dimensions: 4 },
      embedBatch: async function* (
        texts: string[],
      ): AsyncIterable<Float32Array> {
        for (const _ of texts) {
          yield makeVec(4, 1);
        }
      },
    };

    const result = await reembed(backend, mockProvider, {
      targetSpace,
      sourceModelId: 'old',
      getText: (id) => textMap.get(id) ?? null,
    });

    expect(result.migrated).toBe(1);
    expect(result.skipped).toBe(1);
  });
});

// ── Edge cases ───────────────────────────────────────────────────────────────

describe('edge cases', () => {
  let db: Database.Database;
  let adapter: StoreAdapter;
  let backend: SqliteVectorBackend;
  let cleanup: () => void;

  beforeEach(() => {
    const tmp = makeTmpDb();
    adapter = tmp.adapter;
    db = tmp.db;
    cleanup = tmp.cleanup;
    backend = new SqliteVectorBackend(adapter);
  });

  afterEach(() => {
    cleanup();
  });

  it('handles special chars in modelId for table sanitization', () => {
    const space: VectorSpace = { modelId: 'my-model@v1.5+bge', dim: 4 };
    backend.ensureSpace(space);
    backend.upsert(1, makeVec(4, 1), space);
    expect(backend.get(1, space.modelId)).not.toBeNull();
    expect(backend.listSpaces()).toHaveLength(1);
  });

  it('get returns identical vector values after round-trip', () => {
    const space: VectorSpace = { modelId: 'roundtrip', dim: 8 };
    backend.ensureSpace(space);

    const original = makeVec(8, 123);
    backend.upsert(1, original, space);
    const retrieved = backend.get(1, space.modelId)!;

    expect(retrieved.length).toBe(8);
    for (let i = 0; i < 8; i++) {
      expect(retrieved[i]).toBeCloseTo(original[i]!, 4);
    }
  });

  it('iter yields each vector once', () => {
    const space: VectorSpace = { modelId: 'dedup-test', dim: 4 };
    backend.ensureSpace(space);
    backend.upsert(1, makeVec(4, 1), space);
    backend.upsert(2, makeVec(4, 2), space);
    backend.upsert(3, makeVec(4, 3), space);

    const seen = new Set<number>();
    for (const item of backend.iter(space.modelId)) {
      expect(seen.has(item.id)).toBe(false);
      seen.add(item.id);
    }
    expect(seen.size).toBe(3);
  });

  it('listSpaces is idempotent after repeated ensureSpace', () => {
    const space: VectorSpace = { modelId: 'dup-space', dim: 16 };
    backend.ensureSpace(space);
    backend.ensureSpace(space);
    backend.ensureSpace(space);

    const spaces = backend.listSpaces();
    expect(spaces).toHaveLength(1);
    expect(spaces[0]!).toEqual(space);
  });
});
