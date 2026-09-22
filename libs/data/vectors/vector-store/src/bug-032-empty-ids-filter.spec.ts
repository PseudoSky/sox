/**
 * bug-032-empty-ids-filter.spec.ts — BUG-032 / ADR-0017.
 *
 * A PRESENT-BUT-EMPTY `VecFilter.ids` is a scope that resolves to zero
 * candidates. Every backend instead dropped it as "no filter" and returned the
 * whole corpus (or, for the Turso KNN, compiled the empty id filter to the
 * tautology `1=1`). This file pins the invariant across all three backends:
 *
 *   - SqliteVectorBackend (brute force `search` + `iter`)
 *   - TursoVectorBackend (async `knn` + `iter`)
 *   - LanceDbVectorBackend (worker-bridged `knn` + `iter`)
 *
 * Teeth: each `ids: []` assertion FAILS pre-fix (returns every upserted row
 * where zero is expected); the absent/non-empty assertions are the over-reach
 * guard — they fail if the fix makes an ordinary filter match nothing.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSqliteAdapter,
  createStoreAdapter,
  MockAdapter,
  type StoreAdapter,
  type SqliteAdapter,
} from '@adhd/sox-store-adapter';

import {
  SqliteVectorBackend,
  TursoVectorBackend,
  LanceDbVectorBackend,
  type VectorSpace,
} from './index.js';

function unitVec(dim: number, component: number): Float32Array {
  const vec = new Float32Array(dim);
  if (component >= 0 && component < dim) vec[component] = 1.0;
  return vec;
}

async function collectIter(
  source: Iterable<{ id: number }> | AsyncIterable<{ id: number }>,
): Promise<number[]> {
  const out: number[] = [];
  for await (const row of source as AsyncIterable<{ id: number }>) out.push(row.id);
  return out;
}

// ── SqliteVectorBackend ──────────────────────────────────────────────────────

describe('BUG-032 — SqliteVectorBackend: present-but-empty VecFilter.ids matches nothing', () => {
  let adapter: StoreAdapter;
  let cleanup: () => void;
  let backend: SqliteVectorBackend;
  const space: VectorSpace = { modelId: 'bug-032', dim: 4 };

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug032-sqlite-'));
    const sqlite = createSqliteAdapter({ dbPath: path.join(dir, 'test.db') });
    // vec0 virtual tables require the sqlite-vec extension on the connection.
    sqliteVec.load((sqlite as SqliteAdapter).unwrap());
    adapter = sqlite;
    cleanup = () => {
      try { adapter.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    };
    backend = new SqliteVectorBackend(adapter);
    backend.ensureSpace(space);
    backend.upsert(1, unitVec(4, 0), space);
    backend.upsert(2, unitVec(4, 1), space);
  });

  afterEach(() => cleanup());

  it('knn(ids: []) returns ZERO — not the whole corpus', () => {
    expect(backend.knn(unitVec(4, 0), space, 10, { ids: [] })).toEqual([]);
  });

  it('iter(ids: []) yields ZERO — not the whole corpus', async () => {
    expect(await collectIter(backend.iter(space.modelId, { filter: { ids: [] } }))).toEqual([]);
  });

  it('knn(ids: [<absent>]) stays ZERO', () => {
    expect(backend.knn(unitVec(4, 0), space, 10, { ids: [9999] })).toEqual([]);
  });

  it('absent ids stays unfiltered; non-empty ids stays exact', () => {
    expect(backend.knn(unitVec(4, 0), space, 10).map((r) => r.id).sort()).toEqual([1, 2]);
    expect(backend.knn(unitVec(4, 0), space, 10, { ids: [2] }).map((r) => r.id)).toEqual([2]);
    expect([...backend.iter(space.modelId)].map((r) => r.id).sort()).toEqual([1, 2]);
  });
});

// ── TursoVectorBackend ───────────────────────────────────────────────────────

describe('BUG-032 — TursoVectorBackend: present-but-empty VecFilter.ids matches nothing', () => {
  let adapter: StoreAdapter;
  let cleanup: () => Promise<void>;
  let backend: TursoVectorBackend;
  const space: VectorSpace = { modelId: 'bug-032-turso', dim: 8 };

  beforeEach(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug032-turso-'));
    adapter = await createStoreAdapter({ dbPath: path.join(dir, 'test.db') });
    cleanup = async () => {
      try { await adapter.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    };
    backend = new TursoVectorBackend(adapter);
    await backend.ensureSpace(space);
    await backend.upsert(1, unitVec(8, 0), space);
    await backend.upsert(2, unitVec(8, 1), space);
  });

  afterEach(async () => cleanup());

  it('knn(ids: []) returns ZERO — the empty filter is NOT compiled to `1=1`', async () => {
    expect(await backend.knn(unitVec(8, 0), space, 10, { ids: [] })).toEqual([]);
  });

  it('iter(ids: []) yields ZERO', async () => {
    expect(await collectIter(backend.iter(space.modelId, { filter: { ids: [] } }))).toEqual([]);
  });

  it('knn(ids: [<absent>]) stays ZERO', async () => {
    expect(await backend.knn(unitVec(8, 0), space, 10, { ids: [9999] })).toEqual([]);
  });

  it('absent ids stays unfiltered; non-empty ids stays exact', async () => {
    expect((await backend.knn(unitVec(8, 0), space, 10)).map((r) => r.id).sort()).toEqual([1, 2]);
    expect((await backend.knn(unitVec(8, 0), space, 10, { ids: [2] })).map((r) => r.id)).toEqual([2]);
    expect((await collectIter(backend.iter(space.modelId))).sort()).toEqual([1, 2]);
  });
});

// ── LanceDbVectorBackend ─────────────────────────────────────────────────────

describe('BUG-032 — LanceDbVectorBackend: present-but-empty VecFilter.ids matches nothing', () => {
  let dir: string;
  let cleanup: () => void;
  let backend: LanceDbVectorBackend;
  const space: VectorSpace = { modelId: 'bug-032-lance', dim: 4 };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bug032-lance-'));
    cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
    backend = new LanceDbVectorBackend({ lancedbPath: dir, adapter: new MockAdapter() });
    backend.ensureSpace(space);
    backend.upsert(1, unitVec(4, 0), space);
    backend.upsert(2, unitVec(4, 1), space);
  });

  afterEach(() => cleanup());

  it('knn(ids: []) returns ZERO — not the whole corpus', () => {
    expect(backend.knn(unitVec(4, 0), space, 10, { ids: [] })).toEqual([]);
  });

  it('iter(ids: []) yields ZERO', async () => {
    expect(await collectIter(backend.iter(space.modelId, { filter: { ids: [] } }))).toEqual([]);
  });

  it('absent ids stays unfiltered; non-empty ids stays exact', () => {
    expect(backend.knn(unitVec(4, 0), space, 10).map((r) => r.id).sort()).toEqual([1, 2]);
    expect(backend.knn(unitVec(4, 0), space, 10, { ids: [2] }).map((r) => r.id)).toEqual([2]);
    expect([...backend.iter(space.modelId)].map((r) => r.id).sort()).toEqual([1, 2]);
  });
});
