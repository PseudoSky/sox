import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { MockAdapter } from '@adhd/sox-store-adapter';
import type { StoreAdapter } from '@adhd/sox-store-adapter';

import { LanceDbVectorBackend, type VectorSpace } from './index.js';

// BL-389 — LanceDbVectorBackend's constructor was typed against a raw
// `better-sqlite3.Database`, outside the `StoreAdapter` boundary, even
// though the class never touches it (see SPEC-PKT-07.md §1 for the read-
// every-method root-cause trace). This file proves the fixed boundary:
// construction now requires a real StoreAdapter (AC-2, end-to-end), and a
// raw driver handle is rejected with a named error (AC-3), which the
// pre-fix constructor did NOT do — see the RED-arm note on AC-3 below.
//
// AC-1 (the compile-time boundary itself) is proven by `npx nx typecheck
// vector-store` and is not repeated here as a runtime test — see D5 in
// SPEC-PKT-07.md for why a runtime RED arm for AC-1 would be meaningless
// (the pre-fix constructor never validated `db` at runtime either).

function makeTmpLanceDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lancedb-bl389-'));
  return {
    dir,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('BL-389: LanceDbVectorBackend adapter boundary', () => {
  let cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const cleanup of cleanups) cleanup();
    cleanups = [];
  });

  // AC-2 — runtime end-to-end: construct from a real StoreAdapter, upsert
  // at least 2 vectors into a real on-disk LanceDB table, knn() a real
  // query and assert the nearest neighbor is the actually-closest vector.
  it('AC-2: constructs from a StoreAdapter and performs a real end-to-end knn query', () => {
    const tmp = makeTmpLanceDir();
    cleanups.push(tmp.cleanup);

    const backend = new LanceDbVectorBackend({
      lancedbPath: tmp.dir,
      adapter: new MockAdapter(),
    });

    const space: VectorSpace = { modelId: 'bl389-model', dim: 4 };
    backend.ensureSpace(space);

    const query = new Float32Array([1, 0, 0, 0]);
    backend.upsert(1, new Float32Array([1, 0, 0, 0]), space); // identical to query — closest
    backend.upsert(2, new Float32Array([0, 1, 0, 0]), space); // orthogonal — far
    backend.upsert(3, new Float32Array([-1, 0, 0, 0]), space); // opposite — farthest

    const results = backend.knn(query, space, 3);
    expect(results.length).toBe(3);
    expect(results[0]!.id).toBe(1);
    expect(results[0]!.score).toBeCloseTo(1.0, 4);
  });

  // AC-3 — guard rejects a raw driver handle at construction, with a named
  // error naming StoreAdapter (not an opaque failure deep inside the sync
  // bridge).
  //
  // RED-ARM EVIDENCE (recorded per SPEC-PKT-07.md §4 AC-3, run against the
  // pre-fix source with the constructor signature still `{ db }`):
  //
  //   const rawHandle = new Database(':memory:');
  //   const backend = new LanceDbVectorBackend({ lancedbPath: dir, db: rawHandle });
  //   // -> does NOT throw. `config.db` is never referenced anywhere in the
  //   // pre-fix class body (constructor, ensureSpace, upsert, delete, get,
  //   // knn, iter all skip it entirely and go through getSyncFn() keyed
  //   // only on lancedbPath) — passing a raw better-sqlite3 handle as `db`
  //   // was literally the intended, "working" pre-fix call shape. That is
  //   // the concrete behavior this guard changes: post-fix, the equivalent
  //   // call (now naming `adapter`) throws TypeError naming StoreAdapter.
  it('AC-3: rejects a raw driver handle with a named StoreAdapter error', () => {
    const tmp = makeTmpLanceDir();
    cleanups.push(tmp.cleanup);

    const rawHandle = new Database(':memory:');
    cleanups.push(() => rawHandle.close());

    expect(() =>
      // Deliberately proving the runtime guard against a value TypeScript
      // alone would not catch at this call site once cast, per
      // SPEC-PKT-07.md AC-3.
      new LanceDbVectorBackend({
        lancedbPath: tmp.dir,
        adapter: rawHandle as unknown as StoreAdapter,
      }),
    ).toThrow(/StoreAdapter/);
  });
});
