import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createStoreAdapter, createSqliteAdapter, type StoreAdapter } from '@adhd/sox-store-adapter';

import {
  SpaceInvariantError,
  QUERY_VECTOR_NODE_ID,
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

/**
 * A pass-through proxy over a real `StoreAdapter` that records every SQL
 * statement the backend issues through it. Lets a test assert what a backend
 * *actually sent to the driver* — in particular whether a statement projected
 * the `embedding` column (i.e. read a vector BLOB) — without mocking the
 * database. Method calls are forwarded with `this` bound to the real adapter,
 * so the driver's own connection handling is untouched.
 */
interface SqlRecorder {
  adapter: StoreAdapter;
  statements: string[];
  /** Statements that projected the embedding column (a blob read). */
  blobReads: () => string[];
  reset: () => void;
}

function recordSql(real: StoreAdapter): SqlRecorder {
  const statements: string[] = [];
  const RECORDED = new Set(['executeGet', 'executeAll', 'executeRun', 'exec']);
  const adapter = new Proxy(real, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof prop === 'string' && RECORDED.has(prop)) {
        return (...args: unknown[]) => {
          statements.push(String(args[0]));
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return {
    adapter,
    statements,
    blobReads: () => statements.filter((s) => /embedding/i.test(s)),
    reset: () => {
      statements.length = 0;
    },
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('TursoVectorBackend', () => {
  let adapter: StoreAdapter;
  let cleanup: () => Promise<void>;
  let backend: TursoVectorBackend;
  const space: VectorSpace = { modelId: 'test-model', dim: 8 };

  // DEBT-011: TursoVectorBackend's knn/iter are pure `{ ids }` — they no longer
  // join a graph `node` table (the vector store has zero graph-store dependency).
  // `makeNode` mints a unique synthetic id; no node table is created or needed.
  let nextId = 1000;
  function makeNode(_namespace: string): number {
    return nextId++;
  }

  beforeEach(async () => {
    const tmp = await makeTmpTursoDb();
    adapter = tmp.adapter;
    cleanup = tmp.cleanup;
    backend = new TursoVectorBackend(adapter);
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

    // ── knn — pure `{ ids }` contract (DEBT-011) ───────────────────────────
    it('WITH { ids }, only the given ids appear (no node table required)', async () => {
      const idA = 9001;
      const idB = 9002;
      await backend.upsert(idA, unitVec(8, 0), space);
      await backend.upsert(idB, unitVec(8, 0), space);

      const results = await backend.knn(unitVec(8, 0), space, 10, { ids: [idA] });
      expect(results.map((r) => r.id)).toEqual([idA]);
    });

    it('rejects a wrong-dimension query with SpaceInvariantError — not a raw driver error', async () => {
      // Parity with upsert: a query vector whose length ≠ space.dim must fail
      // with the typed space-invariant error BEFORE it reaches SQL. Without
      // the check, `vector_distance_cos` on a mismatched pair leaks a raw
      // Turso/SQL error (wrapped as StorageError) — an ADR-0012 violation.
      // A real row is present so the mismatch actually reaches the driver.
      const id = await makeNode('query-dim');
      await backend.upsert(id, unitVec(8, 0), space);

      const wrongDim = new Float32Array(4); // space.dim === 8
      await expect(backend.knn(wrongDim, space, 5)).rejects.toMatchObject({
        name: 'SpaceInvariantError',
        source: 'knn',
        nodeId: QUERY_VECTOR_NODE_ID,
        actualDim: 4,
        space,
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

  // ── hasVectors — bounded existence probe ──────────────────────────────

  describe('hasVectors', () => {
    it('is false for a space that was never ensured', async () => {
      expect(await backend.hasVectors('never-ensured-model')).toBe(false);
    });

    it('is false for an ensured-but-empty space', async () => {
      expect(await backend.hasVectors(space.modelId)).toBe(false);
    });

    it('is true after a single upsert', async () => {
      await backend.upsert(await makeNode('hv-one'), makeVec(8, 1), space);
      expect(await backend.hasVectors(space.modelId)).toBe(true);
    });

    it('is false again after the only vector is deleted', async () => {
      const id = await makeNode('hv-del');
      await backend.upsert(id, makeVec(8, 2), space);
      expect(await backend.hasVectors(space.modelId)).toBe(true);

      await backend.delete(id, space.modelId);
      expect(await backend.hasVectors(space.modelId)).toBe(false);
    });

    it('reads no embedding blob and its work is O(1) in table size', async () => {
      const rec = recordSql(adapter);
      const probe = new TursoVectorBackend(rec.adapter);
      const smallSpace: VectorSpace = { modelId: 'bounded-small', dim: 8 };
      const largeSpace: VectorSpace = { modelId: 'bounded-large', dim: 8 };
      await probe.ensureSpace(smallSpace);
      await probe.ensureSpace(largeSpace);

      await probe.upsert(1, makeVec(8, 1), smallSpace);
      await probe.upsertVectors(
        Array.from({ length: 500 }, (_, i) => ({ id: 1000 + i, vec: makeVec(8, i) })),
        largeSpace,
      );

      rec.reset();
      expect(await probe.hasVectors(smallSpace.modelId)).toBe(true);
      const smallStatements = rec.statements.length;
      const smallBlobReads = rec.blobReads().length;

      rec.reset();
      expect(await probe.hasVectors(largeSpace.modelId)).toBe(true);
      const largeStatements = rec.statements.length;
      const largeBlobReads = rec.blobReads().length;

      // Bounded: the same single statement for a 1-row and a 500-row table.
      expect(smallStatements).toBe(1);
      expect(largeStatements).toBe(smallStatements);
      // No blob read in either case — the probe never projects `embedding`.
      expect(smallBlobReads).toBe(0);
      expect(largeBlobReads).toBe(0);
      expect(rec.statements[0]).toMatch(/SELECT 1 AS one/i);
      expect(rec.statements[0]).toMatch(/LIMIT 1/i);
    });

    it('NEGATIVE CONTROL: the iter-first-row probe it replaces DOES read the embedding blob', async () => {
      // Proves the spy above has teeth: the old readiness pattern reads the
      // full vector column, so a regression back to `iter` would be caught.
      const rec = recordSql(adapter);
      const probe = new TursoVectorBackend(rec.adapter);
      const bigSpace: VectorSpace = { modelId: 'negative-control', dim: 8 };
      await probe.ensureSpace(bigSpace);
      await probe.upsertVectors(
        Array.from({ length: 50 }, (_, i) => ({ id: 2000 + i, vec: makeVec(8, i) })),
        bigSpace,
      );

      rec.reset();
      for await (const _row of probe.iter(bigSpace.modelId)) break;

      expect(rec.blobReads().length).toBeGreaterThan(0);
      expect(rec.statements[0]).toMatch(/embedding/i);
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
      const store = await openTursoVectorStore(tmp.adapter, { dim: 4, modelId: 'init-model' });
      const spaces = await store.listSpaces();
      expect(spaces).toContainEqual({ modelId: 'init-model', dim: 4 });

      const id = 12345;
      await store.upsert(id, unitVec(4, 0), { modelId: 'init-model', dim: 4 });
      const got = await store.get(id, 'init-model');
      expect(got).not.toBeNull();
    } finally {
      await tmp.cleanup();
    }
  });
});

