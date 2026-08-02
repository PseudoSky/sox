/**
 * bl406-stale-vector-blindness.spec.ts — BL-406: the stale-vector detector is
 * blind to unstamped-but-vectored episodes, and a stamped-but-vectorless row
 * can silently claim provenance it doesn't have.
 *
 * Pre-fix measurement against a snapshot of the live store found:
 *   - 1090 live episodes with embed_model IS NULL that DO have a valid
 *     vec_node row (legacy rows written before BL-88 added the embed_model
 *     column). `stale_vector_count` excludes them by construction
 *     (`embed_model IS NOT NULL` guard) — the store reports full freshness
 *     while 22% of the corpus has unverifiable model provenance.
 *   - 1 live episode with embed_model IS NOT NULL and NO vec_node row —
 *     provenance claimed with nothing to back it — while embed_backlog
 *     (the heal queue's own count) showed 0 queued for re-embed.
 *
 * This suite proves, red then green:
 *   1. Both shapes are counted and surfaced on embed_provenance instead of
 *      being silently excluded (unverifiable_vector_count, stamped_without_vector).
 *   2. The existing embed backlog (embedBacklogStats — the heal queue's own
 *      count, unchanged by this fix) already picks up the stamped-without-
 *      vector row on its own, because its query has no embed_model filter —
 *      so the "queue never sees it" half of the defect was a visibility gap,
 *      not a missing enqueue.
 *   3. runBatchEnrich backfills embed_model on the unstamped-with-vector row
 *      from memory_scope.embed_model, leaving the vector bytes untouched
 *      (byte-identical), and does NOT touch the vectorless row (nothing to
 *      attribute).
 *
 * DETERMINISM: global vitest.setup.ts installs DeterministicTestProvider.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb, initScope } from './db.js';
import { memoryGetStats } from './stats.js';
import { runBatchEnrich } from './enrich-batch.js';
import { embedBacklogStats } from './embed-pipeline.js';
import { _setEmbedProviderForTest, _resetEmbedSingleton, getActiveEmbedModel, vecToJson } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';

async function tmpDb(): Promise<{ dir: string; dbPath: string; db: StoreAdapter; cleanup: () => void }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl406-'));
  const dbPath = path.join(dir, 'm.db');
  const db = await openDb(dbPath);
  return {
    dir,
    dbPath,
    db,
    cleanup: () => {
      db.close().catch(() => { /* already closed */ });
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Insert a live episode with a vec_node row but NO embed_model stamp
 *  (the pre-BL-88 legacy shape — 1090 of these on the live store). */
async function insertUnstampedWithVector(db: StoreAdapter, uid: string, content: string): Promise<{ rowid: number; vecJson: string }> {
  const info = await db.executeRun(
    `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid, embed_model)
     VALUES (?, 'episode', ?, ?, datetime('now'), datetime('now'), NULL)`,
    [uid, content, `hash-${uid}`],
  );
  const rowid = info.lastInsertRowid as number;
  const vec = new Float32Array(768).fill(0.25);
  const vecJson = vecToJson(vec);
  await db.executeRun('INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)', [rowid, vecJson]);
  return { rowid, vecJson };
}

/** Insert a live episode stamped with embed_model but NO vec_node row —
 *  provenance claimed with nothing to back it (1 of these on the live store). */
async function insertStampedWithoutVector(db: StoreAdapter, uid: string, content: string, model: string): Promise<number> {
  const info = await db.executeRun(
    `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid, embed_model)
     VALUES (?, 'episode', ?, ?, datetime('now'), datetime('now'), ?)`,
    [uid, content, `hash-${uid}`, model],
  );
  return info.lastInsertRowid as number;
}

let ctx: Awaited<ReturnType<typeof tmpDb>>;

beforeEach(async () => {
  ctx = await tmpDb();
  _setEmbedProviderForTest(new DeterministicTestProvider());
  // In production, memory-server calls initScope() at startup; a bare openDb()
  // test store leaves memory_scope empty. Populate it so the backfill under
  // test has a real embed_model to attribute legacy vectors to.
  await initScope(ctx.db, 'project', '/test/project');
});

afterEach(async () => {
  ctx.cleanup();
  _resetEmbedSingleton();
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

describe('BL-406 — stale-vector detector blindness', () => {
  it('surfaces unverifiable_vector_count and stamped_without_vector instead of silently excluding them', async () => {
    const activeModel = getActiveEmbedModel() ?? 'unknown';

    // Legacy shape: vector present, provenance unknown.
    const { rowid: unstampedRowid, vecJson: originalVecJson } = await insertUnstampedWithVector(
      ctx.db,
      'bl406-unstamped-with-vector',
      'legacy episode written before BL-88',
    );

    // Contradiction shape: provenance claimed, no vector to back it.
    await insertStampedWithoutVector(
      ctx.db,
      'bl406-stamped-without-vector',
      'episode that claims a model but has no vector',
      activeModel,
    );

    // ── RED-arm assertions: every one of the three counts below must be
    // non-zero, or the seeded rows aren't actually being exercised. ─────────
    const stats = await memoryGetStats(ctx.db, {}, []);

    // 1) The legacy row must not be silently folded into stale_vector_count
    //    (it isn't stamped, so it can't be judged stale) NOR omitted entirely.
    expect(stats.embed_provenance.stale_vector_count).toBe(0);
    expect(stats.embed_provenance.unverifiable_vector_count).toBe(1);

    // 2) The contradiction row must be visible as its own count.
    expect(stats.embed_provenance.stamped_without_vector).toBe(1);

    // 3) The embed heal queue (embedBacklogStats — the thing that actually
    //    schedules re-embeds) already counts the vectorless row on its own,
    //    because its query has no embed_model filter. This proves defect 3's
    //    "nothing is queued to embed it" half was a stats-surface visibility
    //    gap, not a missing enqueue — the row WAS always eligible for heal.
    const backlog = await embedBacklogStats(ctx.db);
    expect(backlog.count).toBe(1);

    // ── Backfill pass: stamp the legacy row from memory_scope.embed_model,
    // leave its vector bytes untouched. ─────────────────────────────────────
    const result = await runBatchEnrich(ctx.db);
    expect(result.embed_model_backfilled).toBe(1);

    const afterUnstamped = await ctx.db.executeGet<{ embed_model: string | null }>(
      `SELECT embed_model FROM node WHERE uid = 'bl406-unstamped-with-vector'`,
    );
    expect(afterUnstamped?.embed_model).toBe(activeModel);

    // Vector bytes are byte-identical after the backfill (attribution only,
    // never a re-embed).
    const afterVec = await ctx.db.executeGet<{ embedding: string }>(
      `SELECT embedding FROM vec_node WHERE node_id = ?`,
      [unstampedRowid],
    );
    expect(afterVec?.embedding).toBe(originalVecJson);

    // The vectorless row is untouched by the backfill — it had nothing to
    // attribute (still stamped, still no vector; it's the heal queue's job,
    // not the backfill's).
    const statsAfter = await memoryGetStats(ctx.db, {}, []);
    expect(statsAfter.embed_provenance.stamped_without_vector).toBe(1);
    expect(statsAfter.embed_provenance.unverifiable_vector_count).toBe(0);
  });

  it('uses memory_scope.embed_model (the model the row was actually written under), not the currently-active model', async () => {
    // Simulate a model swap: the scope was created under an older model than
    // whatever is currently active in this test run.
    await ctx.db.executeRun(`UPDATE memory_scope SET embed_model = 'legacy-model-v1'`);

    await insertUnstampedWithVector(ctx.db, 'bl406-scope-model-check', 'legacy row under an old scope model');

    const result = await runBatchEnrich(ctx.db);
    expect(result.embed_model_backfilled).toBe(1);

    const row = await ctx.db.executeGet<{ embed_model: string | null }>(
      `SELECT embed_model FROM node WHERE uid = 'bl406-scope-model-check'`,
    );
    expect(row?.embed_model).toBe('legacy-model-v1');
  });

  it('embed_provenance is zero-count safe on an empty store', async () => {
    const stats = await memoryGetStats(ctx.db, {}, []);
    expect(stats.embed_provenance.unverifiable_vector_count).toBe(0);
    expect(stats.embed_provenance.stamped_without_vector).toBe(0);
  });
});
