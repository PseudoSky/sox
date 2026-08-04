/**
 * near-duplicates-bl386-cosine.spec.ts — BL-386 regression.
 *
 * `applyNearDupResult` (enrich.ts) binds `nearDup.cosine_sim` into the edge's
 * `weight` COLUMN and writes `meta` as a literal NULL:
 *
 *     INSERT INTO edge (src, dst, rel, origin, weight, t_created, meta)
 *     SELECT ?, ?, 'SAME_AS', 'inferred', ?, ?, NULL
 *
 * `memoryGetNearDuplicates` (near-duplicates.ts) read the similarity from
 * `e.metadata['cosine_sim']`, defaulting to 0 when absent — which was always,
 * since the writer never populated `meta`. Consequences: every pair reported
 * `cosine_sim: 0`, and the `threshold` filter (`cosineSim < cosineThreshold`)
 * excluded every pair for any positive threshold — a silent empty result,
 * indistinguishable from "no near-duplicates in this store".
 *
 * RED (fix reverted — read only `e.metadata['cosine_sim']`, never `e.weight`):
 *   - `reports a non-zero cosine_sim for a freshly-detected pair` fails:
 *     actual cosine_sim is 0.
 *   - `threshold below the pair's cosine_sim returns the pair` fails:
 *     `pairs` is `[]` and `total` is `0`.
 * GREEN (as shipped): reader falls back through `e.weight` first, `e.metadata`
 * second; both assertions pass.
 *
 * Gate: npx nx test memory-core --skip-nx-cache -- near-duplicates-bl386
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, closeAllAdapters } from './db.js';
import { vectorDialectFor } from './dialect.js';
import { detectNearDup } from './neardup.js';
import { applyNearDupResult } from './enrich.js';
import { memoryGetNearDuplicates } from './near-duplicates.js';
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

describe('BL-386 — SAME_AS cosine_sim survives the writer→reader round trip', () => {
  let dir: string | undefined;
  const priorAdapterEnv = process.env['STORE_ADAPTER'];

  afterEach(async () => {
    await closeAllAdapters();
    if (dir) fsSync.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
    else process.env['STORE_ADAPTER'] = priorAdapterEnv;
  });

  it('reports a non-zero cosine_sim for a freshly-detected pair, and a threshold below it returns the pair', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'bl386-'));
    const dbPath = path.join(dir, 'm.db');
    process.env['STORE_ADAPTER'] = 'sqlite';

    const adapter = await openDb(dbPath);
    const binary = adapter.capabilities.nativeVectors;
    const ser = (v: Float32Array) => (binary ? vecToBuffer(v) : vecToJson(v));

    const base = makeVec(1);
    const dupe = makeVec(1, 0.002);

    const seed = async (uid: string, vec: Float32Array): Promise<number> => {
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

    await seed('bl386-base', base);
    const dupeRowid = await seed('bl386-dupe', dupe);

    const vectorDialect = await vectorDialectFor(adapter);
    const nearDup = await adapter.transaction(
      async (tx) => detectNearDup(tx, dupeRowid, dupe, 0.95, vectorDialect),
      { mode: 'immediate' },
    );
    expect(nearDup).not.toBeNull();
    expect(nearDup!.cosine_sim).toBeGreaterThan(0.95);

    // Write the SAME_AS edge exactly as the E8 write-path enrichment does.
    await adapter.transaction(
      async (tx) => applyNearDupResult(tx, dupeRowid, nearDup!),
      { mode: 'immediate' },
    );

    // Assertion 1: cosine_sim survives the round trip, not a constant 0.
    const unfiltered = await memoryGetNearDuplicates(adapter, {});
    expect(unfiltered.total).toBe(1);
    expect(unfiltered.pairs[0]!.cosine_sim).toBeGreaterThan(0.95);

    // Assertion 2: a threshold strictly below the measured cosine_sim returns
    // the pair — this is the assertion that would have caught BL-386, since a
    // constant 0 cosine_sim makes any positive threshold silently exclude
    // every pair.
    const filtered = await memoryGetNearDuplicates(adapter, {
      threshold: nearDup!.cosine_sim - 0.01,
    });
    expect(filtered.total).toBe(1);
    expect(filtered.pairs).toHaveLength(1);
    expect(filtered.pairs[0]!.uid_a === 'bl386-base' || filtered.pairs[0]!.uid_a === 'bl386-dupe').toBe(
      true,
    );
  }, 60_000);
});

// BL-398: manual merges must not fabricate cosine_sim. The graph-store column
// default `weight REAL DEFAULT 1.0` used to silently fill the SAME_AS edge's
// NULL weight with 1.0, which memoryGetNearDuplicates misreported as a fake
// cosine_sim: 1.0 for every manually-merged pair. The merge writer now sets
// weight NULL explicitly and the reader reports null for unknown similarity.
// RED (pre-fix): weight omitted -> column default 1.0 -> cosine_sim reported
// 1.0. GREEN: weight NULL -> cosine_sim null.
describe('BL-398 — manual-merge pairs report cosine_sim: null, never a fabricated value', () => {
  let dir: string | undefined;
  const priorAdapterEnv = process.env['STORE_ADAPTER'];

  afterEach(async () => {
    await closeAllAdapters();
    if (dir) fsSync.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
    else process.env['STORE_ADAPTER'] = priorAdapterEnv;
  });

  it('a manually-merged pair reports cosine_sim null (not 1.0) and is excluded by any threshold', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'bl398-'));
    const dbPath = path.join(dir, 'm.db');
    process.env['STORE_ADAPTER'] = 'sqlite';

    const adapter = await openDb(dbPath);
    const now = new Date().toISOString();
    const insA = await adapter.executeRun(
      `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
       VALUES ('bl398-a', 'episode', 'content a', 'hash-a', datetime('now'), datetime('now'))`,
    );
    const rowA = Number(insA.lastInsertRowid);
    const insB = await adapter.executeRun(
      `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
       VALUES ('bl398-b', 'episode', 'content b', 'hash-b', datetime('now'), datetime('now'))`,
    );
    const rowB = Number(insB.lastInsertRowid);

    // Manual-merge SAME_AS edge — exactly what merge_duplicates writes now:
    // weight NULL (unknown similarity), meta records the manual provenance.
    await adapter.executeRun(
      `INSERT INTO edge (src, dst, rel, origin, weight, t_created, meta)
       VALUES (?, ?, 'SAME_AS', 'user_asserted', NULL, ?, '{"merge":"manual"}')`,
      [rowA, rowB, now],
    );

    const unfiltered = await memoryGetNearDuplicates(adapter, {});
    expect(unfiltered.total).toBe(1);
    // The honest answer: null, not the fabricated 1.0 (or 0) the pre-fix code
    // reported for every manual merge.
    expect(unfiltered.pairs[0]!.cosine_sim).toBeNull();

    // With a threshold, an unknown-similarity pair cannot be proven to meet it.
    const filtered = await memoryGetNearDuplicates(adapter, { threshold: 0.9 });
    expect(filtered.total).toBe(0);
    expect(filtered.pairs).toHaveLength(0);
  }, 60_000);
});
