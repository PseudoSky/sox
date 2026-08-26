import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGraphBackend, type GraphBackend } from '@adhd/sox-graph-store';
import { createStoreAdapter, createSqliteAdapter, type StoreAdapter } from '@adhd/sox-store-adapter';

import {
  SpaceInvariantError,
  StorageError,
  TursoVectorBackend,
  openTursoVectorStore,
  type VectorSpace,
} from './index.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

// A REAL Turso adapter on a REAL temp database file — createStoreAdapter's
// default STORE_ADAPTER is 'turso' (see factory.ts), so handing it only
// `dbPath` (no explicit `type`) is exactly the "native, default backend"
// path a real consumer hits, not a special test-only construction.
async function makeTmpTursoDb(): Promise<{ adapter: StoreAdapter; cleanup: () => Promise<void> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turso-vector-store-test-'));
  const dbPath = path.join(dir, 'test.db');
  const adapter = await createStoreAdapter({ dbPath });
  return {
    adapter,
    cleanup: async () => {
      try {
        await adapter.close();
      } catch {
        /* ignore */
      }
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

describe('TursoVectorBackend', () => {
  let adapter: StoreAdapter;
  let cleanup: () => Promise<void>;
  let backend: TursoVectorBackend;
  let graph: GraphBackend;
  const space: VectorSpace = { modelId: 'test-model', dim: 8 };

  // `TursoVectorDialect.topKQuery` unconditionally JOINs the vector table
  // against a real `node` table (see vector-dialect.ts) — every id used in a
  // `knn`/`iter` assertion below must correspond to a real node row, exactly
  // as the existing SqliteVectorBackend nodeFilter suite in
  // vector-store.spec.ts already establishes for this repo.
  async function makeNode(namespace: string): Promise<number> {
    return graph.writeNode(`content ${namespace} ${Math.random()}`, {
      namespace,
      kind: 'generic',
    });
  }

  beforeEach(async () => {
    const tmp = await makeTmpTursoDb();
    adapter = tmp.adapter;
    cleanup = tmp.cleanup;
    backend = new TursoVectorBackend(adapter);
    graph = createGraphBackend(adapter);
    await graph.applySchema();
    await backend.ensureSpace(space);
  });

  afterEach(async () => {
    await cleanup();
  });

  // ── ensureSpace ───────────────────────────────────────────────────────

  describe('ensureSpace', () => {
    it('is idempotent — calling twice does not throw', async () => {
      await expect(backend.ensureSpace(space)).resolves.toBeUndefined();
      await expect(backend.ensureSpace(space)).resolves.toBeUndefined();
    });

    it('registers the space in listSpaces()', async () => {
      const spaces = await backend.listSpaces();
      expect(spaces).toContainEqual(space);
    });
  });

  // ── upsert / get ──────────────────────────────────────────────────────

  describe('upsert / get', () => {
    it('round-trips a vector exactly', async () => {
      const id = await makeNode('rt');
      const vec = makeVec(8, 3);
      await backend.upsert(id, vec, space);

      const got = await backend.get(id, space.modelId);
      expect(got).not.toBeNull();
      expect(got!.length).toBe(8);
      for (let i = 0; i < 8; i++) {
        expect(got![i]).toBeCloseTo(vec[i]!, 6);
      }
    });

    it('returns null for an unknown id', async () => {
      const got = await backend.get(999_999, space.modelId);
      expect(got).toBeNull();
    });

    it('throws SpaceInvariantError for a wrong-dimension vector', async () => {
      const id = await makeNode('bad-dim');
      const wrongDimVec = new Float32Array(4);
      await expect(backend.upsert(id, wrongDimVec, space)).rejects.toBeInstanceOf(
        SpaceInvariantError,
      );
    });

    it('upsert on an existing id updates in place (UPDATE branch), not a duplicate row', async () => {
      const id = await makeNode('update-branch');
      await backend.upsert(id, makeVec(8, 1), space);
      const updatedVec = makeVec(8, 7);
      await backend.upsert(id, updatedVec, space);

      const got = await backend.get(id, space.modelId);
      for (let i = 0; i < 8; i++) {
        expect(got![i]).toBeCloseTo(updatedVec[i]!, 6);
      }
    });
  });

  // ── delete ────────────────────────────────────────────────────────────

  describe('delete', () => {
    it('removes a vector', async () => {
      const id = await makeNode('to-delete');
      await backend.upsert(id, makeVec(8, 2), space);
      expect(await backend.get(id, space.modelId)).not.toBeNull();

      await backend.delete(id, space.modelId);
      expect(await backend.get(id, space.modelId)).toBeNull();
    });
  });

  // ── knn — ranking ─────────────────────────────────────────────────────

  describe('knn', () => {
    it('ranks correctly and returns higher-is-better scores', async () => {
      // Query = e0. Insert 4 vectors at increasing angular distance from e0:
      // exact match, near, farther, and orthogonal-ish — the expected order
      // is unambiguous.
      const idExact = await makeNode('exact');
      const idNear = await makeNode('near');
      const idFar = await makeNode('far');
      const idOrtho = await makeNode('ortho');

      await backend.upsert(idExact, unitVec(8, 0), space);
      const near = makeVec(8, 0);
      near[0] = 0.9;
      await backend.upsert(idNear, near, space);
      const far = makeVec(8, 0);
      far[0] = 0.3;
      await backend.upsert(idFar, far, space);
      await backend.upsert(idOrtho, unitVec(8, 1), space);

      const results = await backend.knn(unitVec(8, 0), space, 4);
      expect(results).toHaveLength(4);
      expect(results[0]!.id).toBe(idExact);
      expect(results[0]!.score).toBeCloseTo(1.0, 5);
      expect(results[results.length - 1]!.id).toBe(idOrtho);
      // higher-is-better: top result strictly outranks the last result.
      expect(results[0]!.score).toBeGreaterThan(results[results.length - 1]!.score);
    });

    it('honors filter.ids — an excluded id is absent even though it would otherwise rank top', async () => {
      const idTop = await makeNode('top-excluded');
      const idSecond = await makeNode('second');

      await backend.upsert(idTop, unitVec(8, 0), space);
      const second = makeVec(8, 0);
      second[0] = 0.5;
      await backend.upsert(idSecond, second, space);

      const results = await backend.knn(unitVec(8, 0), space, 5, { ids: [idSecond] });
      expect(results).toHaveLength(1);
      expect(results[0]!.id).toBe(idSecond);
      expect(results.map((r) => r.id)).not.toContain(idTop);
    });

    // ── knn — filtered-KNN pushdown (VecFilter.nodeFilter) ────────────────
    //
    // Load-bearing: proves the filter is pushed into SQL, not applied after
    // the k/LIMIT cutoff. Insert MORE matching rows than k plus a batch of
    // non-matching (but nearer!) rows, ask for a small k — a post-filter
    // implementation would fetch k candidates pre-filter (dominated by the
    // nearer non-matching rows) and could return FEWER than k matching rows.
    // A real pushdown returns exactly k matching rows every time.
    describe('nodeFilter pushdown', () => {
      it('returns exactly k in-scope rows even when more out-of-scope rows are nearer', async () => {
        const query = unitVec(8, 0);
        const k = 3;

        // 5 nearer, OUT-of-scope neighbours (would fill every knn slot
        // pre-filter if the filter were applied after the fact).
        for (let i = 0; i < 5; i++) {
          const id = await makeNode('scope-b');
          const v = unitVec(8, 0);
          v[0] = 0.99 - i * 0.001; // extremely close to the query
          await backend.upsert(id, v, space);
        }

        // 5 farther, IN-scope neighbours — genuinely matching rows that a
        // correct pushdown must surface instead of the nearer non-matches.
        const inScopeIds: number[] = [];
        for (let i = 0; i < 5; i++) {
          const id = await makeNode('scope-a');
          inScopeIds.push(id);
          const v = unitVec(8, 0);
          v[0] = 0.5 - i * 0.01; // farther from the query than every scope-b row
          await backend.upsert(id, v, space);
        }

        const results = await backend.knn(query, space, k, {
          nodeFilter: { namespace: 'scope-a' },
        });

        expect(results).toHaveLength(k);
        for (const r of results) {
          expect(inScopeIds).toContain(r.id);
        }
      });

      it('nodeFilter is ANDed with ids when both are given', async () => {
        const idA = await makeNode('scope-a');
        const idB = await makeNode('scope-b');
        await backend.upsert(idA, unitVec(8, 0), space);
        await backend.upsert(idB, unitVec(8, 0), space);

        const results = await backend.knn(unitVec(8, 0), space, 10, {
          ids: [idA, idB],
          nodeFilter: { namespace: 'scope-a' },
        });
        expect(results.map((r) => r.id)).toEqual([idA]);
      });

      it('nodeFilter matching zero nodes returns zero candidates', async () => {
        const id = await makeNode('scope-a');
        await backend.upsert(id, unitVec(8, 0), space);

        const results = await backend.knn(unitVec(8, 0), space, 10, {
          nodeFilter: { namespace: 'scope-does-not-exist' },
        });
        expect(results).toEqual([]);
      });
    });
  });

  // ── iter ──────────────────────────────────────────────────────────────

  describe('iter', () => {
    it('yields everything that was inserted', async () => {
      const ids: number[] = [];
      for (let i = 0; i < 3; i++) {
        const id = await makeNode(`iter-${i}`);
        ids.push(id);
        await backend.upsert(id, makeVec(8, i), space);
      }

      const seen: number[] = [];
      for await (const row of backend.iter(space.modelId)) {
        seen.push(row.id);
        expect(row.vec.length).toBe(8);
      }
      expect(seen.sort()).toEqual([...ids].sort());
    });
  });

  // ── constructor guard ───────────────────────────────────────────────────

  it('constructing with a sqlite (non-native-vector) adapter throws a named StorageError', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'turso-vs-sqlite-guard-'));
    const dbPath = path.join(dir, 'sqlite.db');
    try {
      // createStoreAdapter's factory chooses its backend from process.env.STORE_ADAPTER
      // only (ignoring config.type) — createSqliteAdapter is the direct, unambiguous
      // way to construct a real sqlite (non-native-vector) adapter for this guard test,
      // matching how vector-store.spec.ts's own SqliteVectorBackend suite does it.
      const sqliteAdapter = createSqliteAdapter({ dbPath });
      let thrown: unknown;
      try {
        new TursoVectorBackend(sqliteAdapter);
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeInstanceOf(StorageError);
      expect((thrown as Error).message).toMatch(/nativeVectors=false/);
      expect((thrown as Error).message).toMatch(/SqliteVectorBackend|openVectorStore/);
      await sqliteAdapter.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('constructing with a raw driver handle throws a named StorageError', () => {
    let thrown: unknown;
    try {
      // Intentionally the wrong calling convention — a value with no
      // `capabilities` at all.
      new TursoVectorBackend({} as unknown as StoreAdapter);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(StorageError);
    expect((thrown as Error).message).toMatch(/raw driver handle/);
  });
});

// ── openTursoVectorStore ─────────────────────────────────────────────────────

describe('openTursoVectorStore', () => {
  it('constructs and ensures the initial space in one call', async () => {
    const tmp = await makeTmpTursoDb();
    try {
      const graph = createGraphBackend(tmp.adapter);
      await graph.applySchema();

      const store = await openTursoVectorStore(tmp.adapter, { dim: 4, modelId: 'init-model' });
      const spaces = await store.listSpaces();
      expect(spaces).toContainEqual({ modelId: 'init-model', dim: 4 });

      const id = await graph.writeNode('hello', { namespace: 'ns', kind: 'generic' });
      await store.upsert(id, unitVec(4, 0), { modelId: 'init-model', dim: 4 });
      const got = await store.get(id, 'init-model');
      expect(got).not.toBeNull();
    } finally {
      await tmp.cleanup();
    }
  });
});

