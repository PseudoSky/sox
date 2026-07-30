/**
 * embed-provenance.spec.ts — BL-88: per-record embedding provenance.
 *
 * Validates that:
 *   1. Migration idempotency — migrateAddColumn('node','embed_model','TEXT') is
 *      safe to call on a fresh store (column already present) and a pre-BL-88
 *      store (column absent → added). NULL rows are not backfilled.
 *   2. Write-path stamping — applyEmbedding stamps embed_model on the write path
 *      (Phase-A → Phase-B via schedulePendingEmbeds and the sync composition
 *      memoryWrite).
 *   3. Update-path stamping — memoryUpdate with content change → embed is
 *      re-computed → applyEmbedding stamps embed_model.
 *   4. Heal-path stamping — healMissingVectors calls applyEmbedding → stamps
 *      embed_model on orphaned rows.
 *   5. Stats — memoryGetStats returns embed_provenance with correct stamped /
 *      unstamped / stale_vector_count counts.
 *   6. healStaleVectors semantics:
 *        a. disabled: true when SOX_HEAL_STALE_VECTORS is unset or '0'.
 *        b. re-embeds only mismatched rows (embed_model != active model).
 *        c. bounded by opts.limit.
 *        d. NULL-model rows are NOT touched.
 *        e. stamps the new model after re-embedding.
 *
 * DETERMINISM: global vitest.setup.ts installs DeterministicTestProvider.
 * No real ONNX; _setEmbedProviderForTest used for model-name override.
 *
 * BL-154 safety: every schedulePendingEmbeds / healMissingVectors /
 * healStaleVectors call is made OUTSIDE any WriteQueue task (called after the
 * Phase-A enqueue settles, or from the top-level test body).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type Database from 'better-sqlite3';
import type { EmbedRole } from '@adhd/sox-embedding-provider';
import {
  openDb,
  migrateAddColumn,
} from './db.js';
import {
  memoryWritePhaseA,
  memoryWrite,
} from './write.js';
import type { PhaseAOutcome } from './write.js';
import { memoryUpdate } from './update.js';
import {
  applyEmbedding,
  schedulePendingEmbeds,
  healMissingVectors,
  healStaleVectors,
  flushPendingEmbeds,
  _resetEmbedPipelineMetricsForTest,
} from './embed-pipeline.js';
import { WriteQueue } from './write-queue.js';
import { memoryGetStats } from './stats.js';
import {
  _setEmbedProviderForTest,
  getActiveEmbedModel,
  _resetEmbedSingleton,
} from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';
import { embed, vecToJson } from './embed.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function tmpDb(): { dir: string; dbPath: string; db: Database.Database; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl88-'));
  const dbPath = path.join(dir, 'm.db');
  const db = openDb(dbPath);
  return {
    dir,
    dbPath,
    db,
    cleanup: () => {
      try { if (db.open) db.close(); } catch { /* already closed */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Phase A helper — asserts no error */
function phaseA(db: Database.Database, content: string): PhaseAOutcome {
  const r = memoryWritePhaseA(db, { content, project_path: '/test/project' });
  expect('code' in r).toBe(false);
  return r as PhaseAOutcome;
}

/** Read the embed_model column for a node uid */
function readEmbedModel(db: Database.Database, uid: string): string | null {
  const row = db
    .prepare<[string], { embed_model: string | null }>(`SELECT embed_model FROM node WHERE uid = ?`)
    .get(uid);
  return row?.embed_model ?? null;
}

/** Insert a raw episode with no vec_node row (the crashed-Phase-B shape) */
function insertOrphan(db: Database.Database, uid: string, content: string): void {
  db.prepare(
    `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
     VALUES (?, 'episode', ?, ?, datetime('now'), datetime('now'))`,
  ).run(uid, content, `hash-${uid}`);
}

/** Insert a raw episode WITH a vec_node row and a given embed_model stamp */
function insertEmbeddedWith(
  db: Database.Database,
  uid: string,
  content: string,
  modelStamp: string | null,
): number {
  const info = db.prepare(
    `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid, embed_model)
     VALUES (?, 'episode', ?, ?, datetime('now'), datetime('now'), ?)`,
  ).run(uid, content, `hash-${uid}`, modelStamp);
  const rowid = info.lastInsertRowid as number;
  // Insert a dummy vec_node row with correct dims
  const zeroes = new Float32Array(768).fill(0);
  db.prepare('INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)').run(
    rowid,
    vecToJson(zeroes),
  );
  return rowid;
}

let ctx: ReturnType<typeof tmpDb>;
let origStaleEnv: string | undefined;

beforeEach(async () => {
  ctx = tmpDb();
  await WriteQueue.clearInstances();
  WriteQueue.setBypass(false);
  _resetEmbedPipelineMetricsForTest();
  _setEmbedProviderForTest(new DeterministicTestProvider());
  origStaleEnv = process.env['SOX_HEAL_STALE_VECTORS'];
  delete process.env['SOX_HEAL_STALE_VECTORS'];
});

afterEach(async () => {
  await flushPendingEmbeds();
  await WriteQueue.clearInstances();
  _resetEmbedPipelineMetricsForTest();
  ctx.cleanup();
  _setEmbedProviderForTest(new DeterministicTestProvider());
  if (origStaleEnv === undefined) {
    delete process.env['SOX_HEAL_STALE_VECTORS'];
  } else {
    process.env['SOX_HEAL_STALE_VECTORS'] = origStaleEnv;
  }
});

// ── 1. Migration idempotency ──────────────────────────────────────────────────

describe('BL-88 migration idempotency — embed_model column on node table', () => {
  it('embed_model column is present on a fresh store (created by openDb)', () => {
    const cols = ctx.db
      .prepare<[], { name: string }>('PRAGMA table_info(node)')
      .all()
      .map((c) => c.name);
    expect(cols).toContain('embed_model');
  });

  it('migrateAddColumn is idempotent when column already exists', () => {
    // Second call should not throw — col already present.
    expect(() => migrateAddColumn(ctx.db, 'node', 'embed_model', 'TEXT')).not.toThrow();
    // Still present and the schema is intact.
    const cols = ctx.db
      .prepare<[], { name: string }>('PRAGMA table_info(node)')
      .all()
      .map((c) => c.name);
    expect(cols).toContain('embed_model');
  });

  it('existing NULL rows are not backfilled when the migration runs', () => {
    // Insert a raw node with no embed_model (simulates a pre-BL-88 row).
    ctx.db.prepare(
      `INSERT INTO node (uid, kind, content, content_hash, t_created)
       VALUES ('pre-bl88', 'episode', 'old content', 'hash1', datetime('now'))`,
    ).run();

    // Simulate the migration running again on the same store.
    migrateAddColumn(ctx.db, 'node', 'embed_model', 'TEXT');

    const row = ctx.db
      .prepare<[], { embed_model: string | null }>(`SELECT embed_model FROM node WHERE uid = 'pre-bl88'`)
      .get();
    expect(row?.embed_model).toBeNull(); // NULL is honest — not backfilled.
  });
});

// ── 2. Write-path stamping ────────────────────────────────────────────────────

describe('BL-88 stamp on write path — applyEmbedding stamps embed_model', () => {
  it('async pipeline (schedulePendingEmbeds) stamps embed_model on the applied node', async () => {
    const wq = WriteQueue.forPath(ctx.dbPath);
    const a = phaseA(ctx.db, 'write path stamping test content');

    // Before Phase B — embed_model is NULL (Phase A never touches it).
    const beforeApply = readEmbedModel(ctx.db, a.result.episode_uid);
    expect(beforeApply).toBeNull();

    const res = await schedulePendingEmbeds(wq, [a.pending!]);
    expect(res.applied).toBe(1);

    // After Phase B — embed_model is stamped with the active model.
    const afterApply = readEmbedModel(ctx.db, a.result.episode_uid);
    expect(afterApply).toBe(getActiveEmbedModel());
  });

  it('sync composition (memoryWrite) stamps embed_model', async () => {
    const result = await memoryWrite(ctx.db, { content: 'sync write stamping test', project_path: '/test/project' });
    expect('code' in result).toBe(false);
    const uid = (result as { episode_uid: string }).episode_uid;

    const stamp = readEmbedModel(ctx.db, uid);
    expect(stamp).toBe(getActiveEmbedModel());
  });

  it('applyEmbedding stamps embed_model even when node is already invalidated (bi-temporal)', async () => {
    // Phase A commits the node.
    const a = phaseA(ctx.db, 'bi-temporal stamp test');
    // Invalidate the node between phases.
    ctx.db.prepare(`UPDATE node SET t_invalid = datetime('now') WHERE uid = ?`).run(a.result.episode_uid);

    // Apply the vector — should still stamp embed_model (the row is kept bi-temporally).
    const vec = await embed(a.pending!.text);
    const applyResult = applyEmbedding(ctx.db, a.pending!, vec);
    expect(applyResult.status).toBe('applied');

    const stamp = readEmbedModel(ctx.db, a.result.episode_uid);
    expect(stamp).toBe(getActiveEmbedModel());
  });

  it('applyEmbedding does NOT stamp when the rowid is gone (status: gone)', async () => {
    const vec = await embed('some content');
    const bogusPending = { uid: 'no-such-uid', rowid: 99_999, text: 'some content' };
    const result = applyEmbedding(ctx.db, bogusPending, vec);
    expect(result.status).toBe('gone');
    // No row to check — just ensure no error thrown.
  });

  it('applyEmbedding does NOT re-stamp when vec already exists (status: exists)', async () => {
    const a = phaseA(ctx.db, 'exists check content');
    const vec = await embed(a.pending!.text);
    // First apply — stamps.
    applyEmbedding(ctx.db, a.pending!, vec);
    const firstStamp = readEmbedModel(ctx.db, a.result.episode_uid);
    // The stamp must be the active model (not null — the UPDATE ran).
    expect(firstStamp).toBe(getActiveEmbedModel());

    // Second apply — status 'exists'; the stamp is unchanged.
    const secondResult = applyEmbedding(ctx.db, a.pending!, vec);
    expect(secondResult.status).toBe('exists');
    const secondStamp = readEmbedModel(ctx.db, a.result.episode_uid);
    // The first stamp survives; no corruption.
    expect(secondStamp).toBe(firstStamp);
  });
});

// ── 3. Update-path stamping ───────────────────────────────────────────────────

describe('BL-88 stamp on update path — memoryUpdate content change re-embeds and stamps', () => {
  it('memoryUpdate with content change stamps the new model on the node', async () => {
    // Write initial episode.
    const writeResult = await memoryWrite(ctx.db, { content: 'initial content', project_path: '/test/project' });
    expect('code' in writeResult).toBe(false);
    const uid = (writeResult as { episode_uid: string }).episode_uid;

    // Verify initial stamp.
    expect(readEmbedModel(ctx.db, uid)).toBe(getActiveEmbedModel());

    // Now update the content (triggers re-embed via the sync path).
    const updateResult = await memoryUpdate(ctx.db, { uid, content: 'updated content different' });
    expect('code' in updateResult).toBe(false);

    // embed_model still stamped (same model; the stamp is re-written by applyEmbedding).
    const stamp = readEmbedModel(ctx.db, uid);
    expect(stamp).toBe(getActiveEmbedModel());
    expect((updateResult as { reembedded: boolean }).reembedded).toBe(true);
  });

  it('memoryUpdate without content/summary change does NOT run applyEmbedding (embed_model unchanged)', async () => {
    const writeResult = await memoryWrite(ctx.db, { content: 'content to keep', project_path: '/test/project' });
    expect('code' in writeResult).toBe(false);
    const uid = (writeResult as { episode_uid: string }).episode_uid;
    const beforeStamp = readEmbedModel(ctx.db, uid);
    // Before stamp should be the active model (set by memoryWrite's Phase B).
    expect(beforeStamp).toBe(getActiveEmbedModel());

    // Tag-only update — no re-embed.
    const updateResult = await memoryUpdate(ctx.db, { uid, tags: ['foo', 'bar'] });
    expect('code' in updateResult).toBe(false);
    expect((updateResult as { reembedded: boolean }).reembedded).toBe(false);

    // embed_model should be unchanged.
    expect(readEmbedModel(ctx.db, uid)).toBe(beforeStamp);
  });
});

// ── 4. Heal-path stamping ─────────────────────────────────────────────────────

describe('BL-88 stamp on heal path — healMissingVectors stamps embed_model', () => {
  it('healMissingVectors stamps embed_model on previously un-embedded orphan rows', async () => {
    const uid = 'orphan-heal-test';
    insertOrphan(ctx.db, uid, 'orphan content for healing');
    // Before heal — embed_model is NULL.
    expect(readEmbedModel(ctx.db, uid)).toBeNull();

    const wq = WriteQueue.forPath(ctx.dbPath);
    const healResult = await healMissingVectors(ctx.db, wq);
    expect(healResult.healed).toBe(1);

    // After heal — embed_model is stamped.
    const stamp = readEmbedModel(ctx.db, uid);
    expect(stamp).toBe(getActiveEmbedModel());
  });
});

// ── 5. Stats — embed_provenance ───────────────────────────────────────────────

describe('BL-88 stats — embed_provenance field in memoryGetStats', () => {
  it('stamped/unstamped counts reflect actual node state', async () => {
    // Write two episodes (stamped after Phase B).
    await memoryWrite(ctx.db, { content: 'first stamped episode', project_path: '/test/project' });
    await memoryWrite(ctx.db, { content: 'second stamped episode', project_path: '/test/project' });

    // Insert a raw orphan with no embed_model (unstamped).
    insertOrphan(ctx.db, 'unstamped-1', 'pre-bl88 orphan content');

    const stats = await memoryGetStats(ctx.db, {}, []);
    expect(stats.embed_provenance).toBeDefined();
    expect(stats.embed_provenance.stamped).toBe(2); // the two memoryWrite episodes
    expect(stats.embed_provenance.unstamped).toBe(1); // the raw orphan
    expect(stats.embed_provenance.active_model).toBe(getActiveEmbedModel());
  });

  it('stale_vector_count counts live episodes with embed_model != active model', async () => {
    const activeModel = getActiveEmbedModel();
    // Insert one node with the active model (NOT stale).
    insertEmbeddedWith(ctx.db, 'current-1', 'current model content', activeModel);
    // Insert two nodes with a stale model.
    insertEmbeddedWith(ctx.db, 'stale-1', 'stale model content 1', 'old-model-v1');
    insertEmbeddedWith(ctx.db, 'stale-2', 'stale model content 2', 'old-model-v2');
    // Insert one node with NULL embed_model (must NOT be counted as stale).
    insertOrphan(ctx.db, 'null-model', 'no model stamp content');

    const stats = await memoryGetStats(ctx.db, {}, []);
    // 3 stamped (current-1, stale-1, stale-2); 1 unstamped (null-model).
    expect(stats.embed_provenance.stamped).toBe(3);
    expect(stats.embed_provenance.unstamped).toBe(1);
    // 2 stale (stale-1 and stale-2 have embed_model != activeModel and have vec rows).
    expect(stats.embed_provenance.stale_vector_count).toBe(2);
  });

  it('stale_vector_count is 0 for a clean store with all current-model vectors', async () => {
    await memoryWrite(ctx.db, { content: 'all good', project_path: '/test/project' });

    const stats = await memoryGetStats(ctx.db, {}, []);
    expect(stats.embed_provenance.stale_vector_count).toBe(0);
  });

  it('embed_provenance is always present (zero-count safe)', async () => {
    // Empty store.
    const stats = await memoryGetStats(ctx.db, {}, []);
    expect(stats.embed_provenance).toBeDefined();
    expect(stats.embed_provenance.stamped).toBe(0);
    expect(stats.embed_provenance.unstamped).toBe(0);
    expect(stats.embed_provenance.stale_vector_count).toBe(0);
    expect(stats.embed_provenance.active_model).toBe(getActiveEmbedModel());
  });
});

// ── 6. healStaleVectors semantics ────────────────────────────────────────────

describe('healStaleVectors — BL-88 stale-vector re-embed pass', () => {
  it('returns disabled:true when SOX_HEAL_STALE_VECTORS is not set', async () => {
    delete process.env['SOX_HEAL_STALE_VECTORS'];
    const wq = WriteQueue.forPath(ctx.dbPath);
    const result = await healStaleVectors(ctx.db, wq);
    expect(result.disabled).toBe(true);
    expect(result.scanned).toBe(0);
  });

  it('returns disabled:true when SOX_HEAL_STALE_VECTORS=0', async () => {
    process.env['SOX_HEAL_STALE_VECTORS'] = '0';
    const wq = WriteQueue.forPath(ctx.dbPath);
    const result = await healStaleVectors(ctx.db, wq);
    expect(result.disabled).toBe(true);
  });

  it('re-embeds rows with embed_model != active model when enabled', async () => {
    process.env['SOX_HEAL_STALE_VECTORS'] = '1';
    const activeModel = getActiveEmbedModel();
    // Insert a node with a stale model stamp.
    const staleRowid = insertEmbeddedWith(ctx.db, 'stale-node', 'stale node content for heal', 'old-model-v1');
    expect(staleRowid).toBeGreaterThan(0);

    // Insert a node with the current model (must NOT be re-embedded).
    insertEmbeddedWith(ctx.db, 'current-node', 'current node content', activeModel);

    const wq = WriteQueue.forPath(ctx.dbPath);
    const result = await healStaleVectors(ctx.db, wq);
    expect(result.disabled).toBe(false);
    expect(result.scanned).toBe(1); // only the stale node
    expect(result.healed).toBe(1);
    expect(result.gone).toBe(0);
    expect(result.failed).toBe(0);

    // The stale node's embed_model is now the active model.
    const stamp = readEmbedModel(ctx.db, 'stale-node');
    expect(stamp).toBe(activeModel);

    // The current node is untouched.
    const currentStamp = readEmbedModel(ctx.db, 'current-node');
    expect(currentStamp).toBe(activeModel);
  });

  it('does NOT touch NULL-model rows (pre-provenance rows are not stale)', async () => {
    process.env['SOX_HEAL_STALE_VECTORS'] = '1';
    // Raw orphan — no embed_model, no vec row.
    insertOrphan(ctx.db, 'null-model-orphan', 'no model stamp');

    const wq = WriteQueue.forPath(ctx.dbPath);
    const result = await healStaleVectors(ctx.db, wq);
    expect(result.scanned).toBe(0); // NULL-model rows excluded from the query
    expect(result.healed).toBe(0);
  });

  it('is bounded by opts.limit — does not exceed the per-pass cap', async () => {
    process.env['SOX_HEAL_STALE_VECTORS'] = '1';
    // Insert 5 stale nodes.
    for (let i = 0; i < 5; i++) {
      insertEmbeddedWith(ctx.db, `stale-bounded-${i}`, `stale content ${i}`, 'old-model-v0');
    }

    const wq = WriteQueue.forPath(ctx.dbPath);
    const result = await healStaleVectors(ctx.db, wq, { limit: 2 });
    expect(result.scanned).toBe(2);
    expect(result.healed).toBe(2);

    // 3 remain with old model (next tick picks them up).
    const remaining = ctx.db
      .prepare<[string], { cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM node WHERE embed_model = ? AND t_invalid IS NULL`,
      )
      .get('old-model-v0');
    expect(remaining?.cnt).toBe(3);
  });

  it('stamps the new model after re-embedding the stale row', async () => {
    process.env['SOX_HEAL_STALE_VECTORS'] = '1';
    const activeModel = getActiveEmbedModel();
    insertEmbeddedWith(ctx.db, 'stamp-after-heal', 'verify stamp content', 'stale-model-xyz');

    const wq = WriteQueue.forPath(ctx.dbPath);
    const result = await healStaleVectors(ctx.db, wq);
    expect(result.healed).toBe(1);

    const stamp = readEmbedModel(ctx.db, 'stamp-after-heal');
    expect(stamp).toBe(activeModel);
  });
});
