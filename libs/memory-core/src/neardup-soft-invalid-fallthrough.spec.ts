/**
 * neardup-soft-invalid-fallthrough.spec.ts — 2026-09-22 re-review finding 4.
 *
 * `detectNearDup`'s candidate loop resolved the best-scoring candidate's
 * liveness with `SELECT uid FROM node WHERE rowid = ?` — NO `t_invalid IS
 * NULL` predicate. That means a SOFT-invalidated best-scoring candidate (a
 * live row, just already `t_invalid`-stamped by `memoryInvalidate` or
 * `merge_duplicates`) still matched and was RETURNED as the result.
 * `applyNearDupResult` (enrich.ts) then applies ITS OWN `t_invalid IS NULL`
 * filter on the same uid and silently no-ops — the SAME_AS edge is never
 * written, AND a genuine LIVE next-best candidate elsewhere in the KNN set
 * is never even considered, because `detectNearDup` already returned. Only a
 * HARD-deleted row (`!neighborUidRow`, no row at all) fell through to the
 * next candidate; soft-invalidation — the likelier real-world unusable
 * state, and exactly what `memoryInvalidate`/`merge_duplicates` produce — did
 * not.
 *
 * Fix: the SAME query the loop already uses to check existence now also
 * filters `t_invalid IS NULL`, so a soft-invalidated candidate falls through
 * exactly like a hard-deleted one — reusing the SAME fall-through mechanism
 * Q1-C's DERIVED_FROM exemption already exercises (this test's Case B
 * mirrors neardup-derived-from-exemption.spec.ts's Case B).
 *
 * RED (fix reverted — drop the `AND t_invalid IS NULL` predicate back to a
 * bare `SELECT uid FROM node WHERE rowid = ?`): Case A fails — the
 * soft-invalidated best-scoring candidate is returned instead of null; Case
 * B fails — `existing_uid` is the invalidated uid, not the live neighbor.
 * GREEN (as shipped): Case A returns null; Case B proves the exemption falls
 * through to a genuine live next-best candidate rather than bailing out.
 *
 * 2026-09-22 second re-review, finding B: Case B originally asserted only
 * `existing_uid === 'softinv-b-live-neighbor'`, which is ALSO true if the
 * soft-invalidated node was never actually the best-scoring candidate to
 * begin with — a characterization test that passes whether or not the
 * fall-through fires. Case B now asserts, as an independent precondition,
 * that the invalidated candidate's cosine genuinely outranks the live
 * neighbor's BEFORE checking `detectNearDup`'s result — making the
 * fall-through the only possible explanation for the result it asserts.
 *
 * Gate: npx nx test memory-core --skip-nx-cache -- neardup-soft-invalid-fallthrough
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, closeAllAdapters } from './db.js';
import { vectorDialectFor } from './dialect.js';
import { detectNearDup } from './neardup.js';
import { vecToJson, vecToBuffer, EMBED_DIM } from './embed.js';

/** L2-normalised 768-dim vector, deterministic per seed. */
function makeVec(seed: number, jitter = 0): Float32Array {
  const v = new Float32Array(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) {
    v[i] = Math.sin((i + 1) * 0.017 * (seed + 1)) + jitter * Math.cos(i * 0.31);
  }
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm);
  for (let i = 0; i < EMBED_DIM; i++) v[i] = v[i]! / norm;
  return v;
}

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

describe('2026-09-22 re-review finding 4 — detectNearDup falls through a SOFT-invalidated best candidate', () => {
  let dir: string | undefined;
  const priorAdapterEnv = process.env['STORE_ADAPTER'];

  afterEach(async () => {
    await closeAllAdapters();
    if (dir) fsSync.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
    else process.env['STORE_ADAPTER'] = priorAdapterEnv;
  });

  const seed = async (
    adapter: Awaited<ReturnType<typeof openDb>>,
    uid: string,
    vec: Float32Array,
    ser: (v: Float32Array) => Buffer | string,
    invalidated = false,
  ): Promise<number> => {
    const r = await adapter.executeRun(
      `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid, t_invalid)
       VALUES (?, 'episode', ?, ?, datetime('now'), datetime('now'), ?)`,
      [uid, `content for ${uid}`, `hash-${uid}`, invalidated ? new Date().toISOString() : null],
    );
    const rowid = Number(r.lastInsertRowid);
    await adapter.executeRun(
      'INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)',
      [rowid, ser(vec)],
    );
    return rowid;
  };

  it('Case A: the sole near-dup candidate is soft-invalidated — detectNearDup returns null, not the dead uid', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'neardup-softinv-a-'));
    const dbPath = path.join(dir, 'm.db');
    process.env['STORE_ADAPTER'] = 'sqlite';

    const adapter = await openDb(dbPath);
    const binary = adapter.capabilities.nativeVectors;
    const ser = (v: Float32Array) => (binary ? vecToBuffer(v) : vecToJson(v));

    const liveVec = makeVec(13);
    const invalidatedNeighborVec = makeVec(13, 0.002); // cosine well above threshold

    const liveRowid = await seed(adapter, 'softinv-a-live', liveVec, ser, false);
    await seed(adapter, 'softinv-a-invalidated', invalidatedNeighborVec, ser, true);

    const vectorDialect = await vectorDialectFor(adapter);
    const result = await adapter.transaction(
      async (tx) => detectNearDup(tx, liveRowid, liveVec, 0.95, vectorDialect),
      { mode: 'immediate' },
    );

    expect(result).toBeNull();
  }, 60_000);

  it('Case B: falls through the soft-invalidated best candidate to a genuine live next-best candidate', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'neardup-softinv-b-'));
    const dbPath = path.join(dir, 'm.db');
    process.env['STORE_ADAPTER'] = 'sqlite';

    const adapter = await openDb(dbPath);
    const binary = adapter.capabilities.nativeVectors;
    const ser = (v: Float32Array) => (binary ? vecToBuffer(v) : vecToJson(v));

    const liveVec = makeVec(17);
    // Best-scoring candidate: near-identical, but ALREADY soft-invalidated.
    const invalidatedVec = makeVec(17, 0.001);
    // Second-best candidate: still above threshold, still LIVE.
    const liveNeighborVec = makeVec(17, 0.01);

    const liveRowid = await seed(adapter, 'softinv-b-live', liveVec, ser, false);
    await seed(adapter, 'softinv-b-invalidated', invalidatedVec, ser, true);
    const liveNeighborRowid = await seed(adapter, 'softinv-b-live-neighbor', liveNeighborVec, ser, false);

    // 2026-09-22 second re-review, finding B: verify the TEST'S OWN PREMISE
    // — that the soft-invalidated candidate genuinely outranks the live
    // next-best candidate by cosine — as an assertion, not an assumption.
    // Without this, the test below is a characterization test that happens
    // to pass whether or not the fall-through fires: if the vector
    // construction ever failed to make the invalidated node the BEST
    // candidate (e.g. floating-point drift, an algorithm change elsewhere),
    // `liveNeighbor` would already be the top-ranked candidate with no
    // fall-through required, and the assertion on `existing_uid` below would
    // pass for the wrong reason. This makes the red mechanically guaranteed
    // by the test's own math rather than inferred from an external
    // red-capture run that isn't part of the automated suite.
    const invalidatedCosine = cosine(liveVec, invalidatedVec);
    const liveNeighborCosine = cosine(liveVec, liveNeighborVec);
    expect(invalidatedCosine).toBeGreaterThan(liveNeighborCosine);
    expect(invalidatedCosine).toBeGreaterThanOrEqual(0.9); // both must clear the threshold below
    expect(liveNeighborCosine).toBeGreaterThanOrEqual(0.9);

    const vectorDialect = await vectorDialectFor(adapter);
    const result = await adapter.transaction(
      async (tx) => detectNearDup(tx, liveRowid, liveVec, 0.9, vectorDialect),
      { mode: 'immediate' },
    );

    // The soft-invalidated node — PROVEN above to be the best-scoring
    // candidate — must NOT be returned; the live next-best candidate must
    // be — proving the fall-through continues the search rather than
    // returning the dead uid or bailing out to null outright.
    expect(result).not.toBeNull();
    expect(result!.existing_uid).toBe('softinv-b-live-neighbor');
    expect(liveNeighborRowid).toBeGreaterThan(0);
  }, 60_000);
});
