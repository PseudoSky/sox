import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createSqliteAdapter,
  createStoreAdapter,
  type StoreAdapter,
  type SqliteAdapter,
} from '@adhd/sox-store-adapter';
import * as sqliteVec from 'sqlite-vec';

import { SqliteVectorBackend, TursoVectorBackend, type VectorSpace } from './index.js';

function makeVec(dim: number, seed: number): Float32Array {
  const vec = new Float32Array(dim);
  for (let i = 0; i < dim; i++) vec[i] = (seed * 0.1 + i * 0.01) % 1.0;
  let n = 0;
  for (let i = 0; i < dim; i++) n += vec[i]! * vec[i]!;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < dim; i++) vec[i] = vec[i]! / n;
  return vec;
}

function hasTursoDriver(): boolean {
  try { require.resolve('@tursodatabase/database'); return true; } catch { return false; }
}

const space: VectorSpace = { modelId: 'debt011', dim: 8 };

// ── Acceptance 1 — knn runs against a store with NO `node` table ─────────────
// The vector store's real contract is `(opaque id → vector) + kNN`. It must not
// require the graph schema to exist. These backends are constructed directly
// over an adapter with ONLY the vector table — no createGraphBackend, no
// applySchema of the node table.

describe('DEBT-011 — sqlite knn without a node table', () => {
  let adapter: StoreAdapter;
  let cleanup: () => void;
  let backend: SqliteVectorBackend;

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-debt011-'));
    adapter = createSqliteAdapter({ dbPath: path.join(dir, 't.db') });
    sqliteVec.load((adapter as SqliteAdapter).unwrap());
    cleanup = () => {
      try { adapter.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    };
    backend = new SqliteVectorBackend(adapter);
    backend.ensureSpace(space);
  });

  afterEach(() => cleanup());

  it('returns correct { id, score } over synthetic ids with no node table present', () => {
    backend.upsert(100, makeVec(8, 1), space);
    backend.upsert(200, makeVec(8, 2), space);
    backend.upsert(300, makeVec(8, 3), space);

    const hits = backend.knn(makeVec(8, 1), space, 2);
    expect(hits.length).toBe(2);
    // id 100 is closest to itself (seed 1)
    expect(hits[0]!.id).toBe(100);
    expect(hits[0]!.score).toBeGreaterThan(0.9);
    expect(hits.every((h) => [100, 200, 300].includes(h.id))).toBe(true);
  });

  it('knn with { ids } restricts candidates to the given ids', () => {
    backend.upsert(100, makeVec(8, 1), space);
    backend.upsert(200, makeVec(8, 2), space);
    backend.upsert(300, makeVec(8, 3), space);

    const hits = backend.knn(makeVec(8, 3), space, 10, { ids: [100, 200] });
    expect(hits.every((h) => [100, 200].includes(h.id))).toBe(true);
    expect(hits.some((h) => h.id === 300)).toBe(false);
  });

  it('deleteMany removes exactly those ids and returns the count', () => {
    backend.upsert(100, makeVec(8, 1), space);
    backend.upsert(200, makeVec(8, 2), space);
    backend.upsert(300, makeVec(8, 3), space);

    expect(backend.deleteMany([100, 200], space.modelId)).toBe(2);
    expect(backend.get(100, space.modelId)).toBeNull();
    expect(backend.get(200, space.modelId)).toBeNull();
    expect(backend.get(300, space.modelId)).not.toBeNull();
  });

  it('deleteMany is idempotent and tolerant of a missing table', () => {
    backend.upsert(100, makeVec(8, 1), space);
    expect(backend.deleteMany([100], space.modelId)).toBe(1);
    expect(backend.deleteMany([100], space.modelId)).toBe(0);
    expect(backend.deleteMany([999], 'nonexistent-space')).toBe(0);
  });
});

// ── Acceptance 1 (turso) — knn without a node table ─────────────────────────

describe('DEBT-011 — turso knn without a node table', () => {
  let adapter: StoreAdapter;
  let cleanup: () => Promise<void>;
  let backend: TursoVectorBackend;
  const skip = !hasTursoDriver();

  beforeEach(async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vs-debt011-turso-'));
    adapter = await createStoreAdapter({ dbPath: path.join(dir, 't.db') });
    cleanup = async () => {
      try { await adapter.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    };
    backend = new TursoVectorBackend(adapter);
    await backend.ensureSpace(space);
  });

  afterEach(async () => { await cleanup(); });

  it('returns correct { id, score } over synthetic ids with no node table', { skip, timeout: 20000 }, async () => {
    await backend.upsert(100, makeVec(8, 1), space);
    await backend.upsert(200, makeVec(8, 2), space);

    const hits = await backend.knn(makeVec(8, 1), space, 2);
    expect(hits.length).toBe(2);
    expect(hits[0]!.id).toBe(100);
  });

  it('deleteMany removes exactly those ids and returns the count', { skip, timeout: 20000 }, async () => {
    await backend.upsert(100, makeVec(8, 1), space);
    await backend.upsert(200, makeVec(8, 2), space);

    expect(await backend.deleteMany([100], space.modelId)).toBe(1);
    expect(await backend.get(100, space.modelId)).toBeNull();
    expect(await backend.get(200, space.modelId)).not.toBeNull();
    expect(await backend.deleteMany([100], space.modelId)).toBe(0);
  });
});
