/**
 * neardup-bl381-dialect.spec.ts — BL-381 regression.
 *
 * `detectNearDup` issued sqlite-vec `vec0` KNN syntax directly:
 *
 *     SELECT node_id, embedding FROM vec_node WHERE embedding MATCH ? AND k = ?
 *
 * Turso's `vec_node` is an ordinary table with an `F32_BLOB` column. It has no
 * `MATCH` operator on that column and no `k` pseudo-column, so the statement
 * failed at prepare with `no such column: k`. Both call sites caught the throw
 * and continued, so E8 near-duplicate detection was silently non-functional on
 * the default backend while every health surface reported healthy.
 *
 * RED (fix reverted — restore the literal SQL in neardup.ts):
 *   - `raw vec0 KNN syntax` FAILS to throw?  No: it throws either way. The test
 *     that goes red is `finds the near-duplicate on Turso`, because the old
 *     implementation returns null (via its `useNativeVectors` bail-out) or
 *     throws (when the flag was dropped, which is what production did).
 * GREEN (as shipped): both backends find the duplicate through the dialect.
 *
 * Gate: npx nx test memory-core --skip-nx-cache -- neardup-bl381
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

const BACKENDS = ['sqlite', 'turso'] as const;

describe('BL-381 — near-dup KNN goes through the VectorDialect on both backends', () => {
  let dir: string | undefined;
  const priorAdapterEnv = process.env['STORE_ADAPTER'];

  afterEach(async () => {
    await closeAllAdapters();
    if (dir) fsSync.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
    else process.env['STORE_ADAPTER'] = priorAdapterEnv;
  });

  for (const backend of BACKENDS) {
    it(`finds the near-duplicate on ${backend}`, async () => {
      dir = fsSync.mkdtempSync(path.join(os.tmpdir(), `bl381-${backend}-`));
      const dbPath = path.join(dir, 'm.db');
      process.env['STORE_ADAPTER'] = backend;

      const adapter = await openDb(dbPath);
      expect(adapter.config.type).toBe(backend);
      const binary = adapter.capabilities.nativeVectors;
      const ser = (v: Float32Array) => (binary ? vecToBuffer(v) : vecToJson(v));

      // Two near-identical vectors plus one clearly distinct neighbour, so a
      // pass that returns "the only other row" cannot masquerade as a hit.
      const base = makeVec(1);
      const dupe = makeVec(1, 0.002);
      const other = makeVec(99);

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

      const baseRowid = await seed('bl381-base', base);
      await seed('bl381-other', other);
      const dupeRowid = await seed('bl381-dupe', dupe);

      const vectorDialect = await vectorDialectFor(adapter);
      const result = await adapter.transaction(
        async (tx) => detectNearDup(tx, dupeRowid, dupe, 0.95, vectorDialect),
        { mode: 'immediate' },
      );

      expect(result).not.toBeNull();
      expect(result!.existing_uid).toBe('bl381-base');
      expect(result!.cosine_sim).toBeGreaterThan(0.95);
      // Q1-B (docs/reporting/memory/findings/2026-09-22-neardup-invalidation-fix-plan.md §2): `should_invalidate` was
      // replaced by `status` — this is a pure rename of a field the type no
      // longer has, not a semantic weakening of the BL-381 assertion (which
      // remains "the dialect-routed KNN finds the pair", unchanged above).
      expect(result!.status).toBe('near_dup');
      expect(baseRowid).toBeGreaterThan(0);
    }, 60_000);
  }

  it('the old hardcoded vec0 KNN statement is rejected by Turso — this is the defect', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'bl381-vec0-'));
    const dbPath = path.join(dir, 'm.db');
    process.env['STORE_ADAPTER'] = 'turso';
    const adapter = await openDb(dbPath);

    // Verbatim the pre-fix SQL from neardup.ts. If a future change makes this
    // succeed on Turso, the dialect indirection can be revisited — until then,
    // this is why the feature was dead.
    await expect(
      adapter.executeAll(
        `SELECT node_id, embedding
         FROM vec_node
         WHERE embedding MATCH ? AND k = ?`,
        [vecToJson(makeVec(1)), 21],
      ),
    ).rejects.toThrow();
  }, 60_000);
});
