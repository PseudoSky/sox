/**
 * neardup-no-auto-invalidate.spec.ts — Q1 regression
 * (docs/plan-drafts/neardup-invalidation-fix-plan.md §2).
 *
 * `applyNearDupResult` (enrich.ts) used to bi-temporally invalidate the OLDER
 * of a near-dup pair with a bare `UPDATE node SET t_invalid = ? WHERE uid = ?`
 * whenever `NearDupResult.should_invalidate` was true — which, per Q1-B, was
 * EVERY result the function could ever produce (the field was structurally
 * always true on a 'near_dup'-classified pair). No reason was recorded, no
 * SUPERSEDES edge was written, and the loss was silent: the episode simply
 * dropped out of every filtered ("live only") recall the moment the pass ran.
 * Live-store sample: 684 already-merged SAME_AS pairs, with false positives
 * sampled at cosine 0.9916 and 0.9967 between semantically unrelated content
 * — well above any threshold retune could exclude (plan §2, "THRESHOLD TUNING
 * ALONE CANNOT FIX THIS").
 *
 * Fix: `applyNearDupResult` now emits ONLY the `SAME_AS` edge (carrying
 * cosine/model/status/detector in `meta`, plus `weight` for the BL-386 read
 * path) and never touches `t_invalid`. Destruction now requires intent —
 * `memoryInvalidate` or `memory_curate merge_duplicates` — not an automatic
 * pass reacting to a retrieval-ranking signal.
 *
 * RED (fix reverted — restore the deleted invalidation block in its NEW-FIELD
 * form, `if (nearDup.status === 'near_dup') { UPDATE ... t_invalid ... }`,
 * since `should_invalidate` no longer exists on the type and reverting to
 * that name would fail to compile rather than fail the assertion): assertion
 * (b) below fails — the neighbour's `t_invalid` is a timestamp, not null.
 * GREEN (as shipped): both nodes stay live, the SAME_AS edge carries the
 * evidence, and both are returned by a liveOnly recall.
 *
 * Both the SYNCHRONOUS path (enrichOnWrite / detectAndApplyNearDup, exercised
 * directly via applyNearDupResult below) and the ASYNC Phase-B path
 * (embed-pipeline.ts applyEmbedding — the DEFAULT write path) are exercised;
 * per the plan, the async path must not be skipped.
 *
 * Gate: npx nx test memory-core --skip-nx-cache -- neardup-no-auto-invalidate
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fsSync from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, closeAllAdapters } from './db.js';
import { vectorDialectFor } from './dialect.js';
import { detectNearDup } from './neardup.js';
import { applyNearDupResult } from './enrich.js';
import { applyEmbedding, type PendingEmbed } from './embed-pipeline.js';
import { memoryGetNearDuplicates } from './near-duplicates.js';
import { memoryRecall } from './recall.js';
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

describe('Q1 — applyNearDupResult never sets t_invalid (SYNC path)', () => {
  let dir: string | undefined;
  const priorAdapterEnv = process.env['STORE_ADAPTER'];

  afterEach(async () => {
    await closeAllAdapters();
    if (dir) fsSync.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
    else process.env['STORE_ADAPTER'] = priorAdapterEnv;
  });

  it('leaves BOTH nodes live, writes SAME_AS with cosine + evidence meta, and both survive a liveOnly recall', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'neardup-noinv-'));
    const dbPath = path.join(dir, 'm.db');
    process.env['STORE_ADAPTER'] = 'sqlite';

    const adapter = await openDb(dbPath);
    const binary = adapter.capabilities.nativeVectors;
    const ser = (v: Float32Array) => (binary ? vecToBuffer(v) : vecToJson(v));

    const base = makeVec(7);
    const dupe = makeVec(7, 0.002); // cosine well above NEARDUP_THRESHOLD (0.95)

    const seed = async (uid: string, vec: Float32Array): Promise<number> => {
      const r = await adapter.executeRun(
        `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid, project_path)
         VALUES (?, 'episode', ?, ?, datetime('now'), datetime('now'), '/test/project')`,
        [uid, `content for ${uid}`, `hash-${uid}`],
      );
      const rowid = Number(r.lastInsertRowid);
      await adapter.executeRun(
        'INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)',
        [rowid, ser(vec)],
      );
      return rowid;
    };

    await seed('neardup-noinv-base', base);
    const dupeRowid = await seed('neardup-noinv-dupe', dupe);

    const vectorDialect = await vectorDialectFor(adapter);
    const nearDup = await adapter.transaction(
      async (tx) => detectNearDup(tx, dupeRowid, dupe, 0.95, vectorDialect),
      { mode: 'immediate' },
    );
    expect(nearDup).not.toBeNull();
    expect(nearDup!.existing_uid).toBe('neardup-noinv-base');
    expect(nearDup!.cosine_sim).toBeGreaterThan(0.95);
    expect(nearDup!.status).toBe('near_dup');

    await adapter.transaction(
      async (tx) => applyNearDupResult(tx, dupeRowid, nearDup!),
      { mode: 'immediate' },
    );

    // (a) SAME_AS edge exists with weight === cosine AND the new meta fields.
    const dup = await memoryGetNearDuplicates(adapter, {});
    expect(dup.total).toBe(1);
    expect(dup.pairs[0]!.cosine_sim).toBeCloseTo(nearDup!.cosine_sim, 5);

    const edgeRow = await adapter.executeGet<{ weight: number; meta: string | null }>(
      `SELECT weight, meta FROM edge WHERE rel = 'SAME_AS' LIMIT 1`,
    );
    expect(edgeRow).not.toBeNull();
    expect(edgeRow!.weight).toBeCloseTo(nearDup!.cosine_sim, 5);
    expect(edgeRow!.meta).not.toBeNull();
    const meta = JSON.parse(edgeRow!.meta!) as Record<string, unknown>;
    expect(meta['cosine_sim']).toBeCloseTo(nearDup!.cosine_sim, 5);
    expect(meta['status']).toBe('near_dup');
    expect(meta['detector']).toBe('auto-neardup');
    expect(typeof meta['model']).toBe('string');
    expect(typeof meta['detected_at']).toBe('string');

    // (b) BOTH nodes still live — the assertion that goes red if the deleted
    // invalidation block is restored.
    const rows = await adapter.executeAll<{ uid: string; t_invalid: string | null }>(
      `SELECT uid, t_invalid FROM node WHERE uid IN ('neardup-noinv-base', 'neardup-noinv-dupe')`,
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row.t_invalid).toBeNull();
    }

    // (c) Both returned by a liveOnly recall (memory_recall filters t_invalid
    // IS NULL by construction — no explicit flag needed).
    const recall = await memoryRecall(adapter, 'project', {
      query: 'content for neardup-noinv',
      limit: 10,
    });
    const recalledUids = new Set(recall.results.map((r) => r.uid));
    expect(recalledUids.has('neardup-noinv-base')).toBe(true);
    expect(recalledUids.has('neardup-noinv-dupe')).toBe(true);
  }, 60_000);
});

describe('Q1 — the async Phase-B path (embed-pipeline applyEmbedding) does not invalidate either', () => {
  let dir: string | undefined;
  const priorAdapterEnv = process.env['STORE_ADAPTER'];

  afterEach(async () => {
    await closeAllAdapters();
    if (dir) fsSync.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
    if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
    else process.env['STORE_ADAPTER'] = priorAdapterEnv;
  });

  it('applyEmbedding (default async write path) inserts vec + SAME_AS but never t_invalid', async () => {
    dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'neardup-noinv-async-'));
    const dbPath = path.join(dir, 'm.db');
    process.env['STORE_ADAPTER'] = 'sqlite';

    const adapter = await openDb(dbPath);
    const binary = adapter.capabilities.nativeVectors;
    const ser = (v: Float32Array) => (binary ? vecToBuffer(v) : vecToJson(v));

    const base = makeVec(11);
    const dupe = makeVec(11, 0.002);

    // Neighbour ('base') is fully embedded already — this is the pre-existing
    // near-dup candidate the Phase-B pass for the NEW node will find.
    const baseRes = await adapter.executeRun(
      `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid, project_path)
       VALUES ('neardup-async-base', 'episode', 'content for base', 'hash-base', datetime('now'), datetime('now'), '/test/project')`,
    );
    const baseRowid = Number(baseRes.lastInsertRowid);
    await adapter.executeRun(
      'INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)',
      [baseRowid, ser(base)],
    );

    // The node under test is committed but deliberately left UNEMBEDDED
    // (no vec_node row) so applyEmbedding's `status: 'exists'` early exit
    // (embed-pipeline.ts:442) cannot make this test a false green.
    const dupeRes = await adapter.executeRun(
      `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid, project_path)
       VALUES ('neardup-async-dupe', 'episode', 'content for dupe', 'hash-dupe', datetime('now'), datetime('now'), '/test/project')`,
    );
    const dupeRowid = Number(dupeRes.lastInsertRowid);

    const vectorDialect = await vectorDialectFor(adapter);
    const pending: PendingEmbed = {
      uid: 'neardup-async-dupe',
      rowid: dupeRowid,
      text: 'content for dupe',
    };

    const result = await adapter.transaction(
      async (tx) => applyEmbedding(tx, pending, dupe, binary, vectorDialect),
      { mode: 'immediate' },
    );

    // Positive proof the real path ran, not a no-op early exit.
    expect(result.status).toBe('applied');
    expect(result.near_dup).not.toBeNull();
    expect(result.near_dup!.existing_uid).toBe('neardup-async-base');
    expect(result.near_dup!.status).toBe('near_dup');

    const edgeRow = await adapter.executeGet<{ weight: number; meta: string | null }>(
      `SELECT weight, meta FROM edge WHERE rel = 'SAME_AS' LIMIT 1`,
    );
    expect(edgeRow).not.toBeNull();
    expect(edgeRow!.weight).toBeGreaterThan(0.95);
    expect(edgeRow!.meta).not.toBeNull();

    // THE assertion: neither node was invalidated by the async default path.
    const rows = await adapter.executeAll<{ uid: string; t_invalid: string | null }>(
      `SELECT uid, t_invalid FROM node WHERE uid IN ('neardup-async-base', 'neardup-async-dupe')`,
    );
    expect(rows.rows).toHaveLength(2);
    for (const row of rows.rows) {
      expect(row.t_invalid).toBeNull();
    }
  }, 60_000);
});
