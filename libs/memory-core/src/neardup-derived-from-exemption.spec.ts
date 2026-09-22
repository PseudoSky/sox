/**
 * neardup-derived-from-exemption.spec.ts — Q1-C regression
 * (docs/reporting/memory/findings/2026-09-22-neardup-invalidation-fix-plan.md §2, "structural
 * parent↔chunk exemption").
 *
 * A parent episode and its own chunk (linked by a `DERIVED_FROM` edge,
 * written by `linkChunksToParent`, memory-server/src/index.ts:1637-1655) are a
 * whole and its part, not a duplicate pair — a chunk is, by construction,
 * near-identical to material inside its own parent. Even with Q1-A removing
 * automatic invalidation, reporting that pair as a near-dup candidate
 * pollutes the `memory_near_duplicates` review queue and the Q3 triage set
 * with pairs no reviewer should ever be asked to adjudicate. This is a
 * STRUCTURAL fact about the pair (an edge exists), not a score, so
 * `detectNearDup` checks it directly rather than relying on a downstream
 * filter.
 *
 * RED (exemption reverted — restore the un-exempted bestPair-only selection):
 *   Case A fails: `detectNearDup` returns the parent as a near-dup hit instead
 *   of `null`.
 * GREEN (as shipped): Case A returns `null`; Case B (a THIRD, non-derived,
 * near-dup node also present in the KNN set) proves the exemption falls
 * through to the next-best candidate rather than bailing out entirely.
 *
 * Gate: npx nx test memory-core --skip-nx-cache -- neardup-derived-from-exemption
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

describe('Q1-C — detectNearDup exempts a structural DERIVED_FROM (parent/chunk) pair', () => {
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
  ): Promise<number> => {
    const r = await adapter.executeRun(
      `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
       VALUES (?, 'episode', ?, ?, datetime('now'), datetime('now'))`,
      [uid, `content for ${uid}`, `hash-${uid}`],
    );
    const rowid = Number(r.lastInsertRowid);
    await adapter.executeRun(
      'INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)',
      [rowid, ser(vec)],
    );
    return rowid;
  };

  it('Case A: parent + its own chunk, cosine >= threshold, live DERIVED_FROM edge — detectNearDup returns null', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'neardup-derived-a-'));
    const dbPath = path.join(dir, 'm.db');
    process.env['STORE_ADAPTER'] = 'sqlite';

    const adapter = await openDb(dbPath);
    const binary = adapter.capabilities.nativeVectors;
    const ser = (v: Float32Array) => (binary ? vecToBuffer(v) : vecToJson(v));

    const parentVec = makeVec(3);
    const chunkVec = makeVec(3, 0.002); // near-identical to parent, cosine >= 0.95

    const parentRowid = await seed(adapter, 'derived-parent', parentVec, ser);
    const chunkRowid = await seed(adapter, 'derived-chunk', chunkVec, ser);

    // Exactly the shape linkChunksToParent writes: src=chunk, dst=parent.
    await adapter.executeRun(
      `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
       VALUES (?, ?, 'DERIVED_FROM', 'user_asserted', datetime('now'), '{"auto_chunk":true}')`,
      [chunkRowid, parentRowid],
    );

    const vectorDialect = await vectorDialectFor(adapter);
    const result = await adapter.transaction(
      async (tx) => detectNearDup(tx, chunkRowid, chunkVec, 0.95, vectorDialect),
      { mode: 'immediate' },
    );

    expect(result).toBeNull();
  }, 60_000);

  it('Case B: exemption falls through to the next-best NON-derived near-dup candidate, not a bail-out', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'neardup-derived-b-'));
    const dbPath = path.join(dir, 'm.db');
    process.env['STORE_ADAPTER'] = 'sqlite';

    const adapter = await openDb(dbPath);
    const binary = adapter.capabilities.nativeVectors;
    const ser = (v: Float32Array) => (binary ? vecToBuffer(v) : vecToJson(v));

    const parentVec = makeVec(5);
    // The chunk under test: near-identical to its OWN parent (highest cosine,
    // would win bestPair-only selection) AND near-identical to a THIRD,
    // structurally-unrelated node (second-best cosine).
    const chunkVec = makeVec(5, 0.001); // extremely close to parent
    const unrelatedVec = makeVec(5, 0.01); // close to chunk, but slightly further than parent

    const parentRowid = await seed(adapter, 'derived-b-parent', parentVec, ser);
    const chunkRowid = await seed(adapter, 'derived-b-chunk', chunkVec, ser);
    const unrelatedRowid = await seed(adapter, 'derived-b-unrelated', unrelatedVec, ser);

    await adapter.executeRun(
      `INSERT INTO edge (src, dst, rel, origin, t_created, meta)
       VALUES (?, ?, 'DERIVED_FROM', 'user_asserted', datetime('now'), '{"auto_chunk":true}')`,
      [chunkRowid, parentRowid],
    );

    const vectorDialect = await vectorDialectFor(adapter);
    const result = await adapter.transaction(
      async (tx) => detectNearDup(tx, chunkRowid, chunkVec, 0.90, vectorDialect),
      { mode: 'immediate' },
    );

    // The parent (DERIVED_FROM-exempt) must NOT be returned; the unrelated
    // node — a genuine near-dup candidate with no structural relationship —
    // must be, proving the exemption continues the search rather than
    // returning null the moment the best-scoring candidate is exempt.
    expect(result).not.toBeNull();
    expect(result!.existing_uid).toBe('derived-b-unrelated');
    expect(unrelatedRowid).toBeGreaterThan(0);
  }, 60_000);
});
