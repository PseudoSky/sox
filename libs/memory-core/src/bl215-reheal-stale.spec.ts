/**
 * bl215-reheal-stale.spec.ts — BL-215: operator surface for `healStaleVectors`
 * (BL-88) via `memory_curate op: 'reheal_stale'`.
 *
 * THE DEFECT. `healStaleVectors` was fully implemented (BL-88) but had zero
 * callers anywhere — no MCP op, no CLI verb, no tick. `memoryCurate`'s op
 * switch fell through to `default: return { code: 'E_UNKNOWN_OP', op }` for
 * `reheal_stale`, so there was no code path an operator could invoke to
 * trigger a re-heal short of importing the function from a throwaway script.
 *
 * Self-contained fixture (mirrors bl434-heal-trace-id.spec.ts's
 * beforeEach/afterEach + insertStale shape) — does NOT import PKT-55's
 * export.spec.ts/concurrency-harness.spec.ts fixture, per SPEC-PKT-18.md §2.4.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { openDb } from './db.js';
import { memoryCurate } from './curate.js';
import { WriteQueue } from './write-queue.js';
import { _setEmbedProviderForTest, _resetEmbedSingleton, vecToJson } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';
import { _resetTelemetryForTest } from './telemetry.js';

let dir: string;
let dbPath: string;
let db: StoreAdapter;

beforeEach(async () => {
  _resetTelemetryForTest();

  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl215-'));
  dbPath = path.join(dir, 'm.db');
  db = await openDb(dbPath);
  await WriteQueue.clearInstances();
  WriteQueue.setBypass(false);
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

afterEach(async () => {
  _resetTelemetryForTest();
  _resetEmbedSingleton();
  await WriteQueue.clearInstances();
  await db.close().catch(() => { /* already closed */ });
  fs.rmSync(dir, { recursive: true, force: true });
});

/** An episode row WITH a vec_node row stamped with a foreign model — healStaleVectors' target. */
async function insertStale(uid: string, content: string): Promise<void> {
  const info = await db.executeRun(
    `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid, embed_model)
     VALUES (?, 'episode', ?, ?, datetime('now'), datetime('now'), 'some-other-model')`,
    [uid, content, `hash-${uid}`],
  );
  const rowid = info.lastInsertRowid as number;
  await db.executeRun('INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)', [
    rowid,
    vecToJson(new Float32Array(768).fill(0)),
  ]);
}

async function readEmbedModel(uid: string): Promise<string | null> {
  const row = await db.executeGet<{ embed_model: string | null }>(
    `SELECT embed_model FROM node WHERE uid = ?`,
    [uid],
  );
  return row?.embed_model ?? null;
}

async function readVecNodeEmbedding(uid: string): Promise<string | null> {
  const row = await db.executeGet<{ embedding: string | null }>(
    `SELECT v.embedding AS embedding FROM vec_node v
     JOIN node n ON n.rowid = v.node_id
     WHERE n.uid = ?`,
    [uid],
  );
  return row?.embedding ?? null;
}

describe('BL-215: memory_curate reheal_stale — operator surface for healStaleVectors', () => {
  // AC1 — the op exists and is reachable through the real dispatcher.
  it('BL-215/AC1: reheal_stale is a real op, not E_UNKNOWN_OP', async () => {
    const wq = await WriteQueue.forPath(dbPath);
    const result = await memoryCurate(db, { op: 'reheal_stale' }, wq);
    expect('code' in result).toBe(false);
    expect((result as { op: string }).op).toBe('reheal_stale');
    expect(typeof (result as { scanned: number }).scanned).toBe('number');
    expect(typeof (result as { healed: number }).healed).toBe('number');
    expect(typeof (result as { remaining: number }).remaining).toBe('number');
  });

  // AC2 — a model-swap-stale row actually gets healed. ALWAYS enabled: the
  // SOX_HEAL_STALE_VECTORS gate was an anti-feature and is gone (ADR-0013).
  it('BL-215/AC2: a model-swap-stale row is re-embedded and committed without any env var', async () => {
    await insertStale('bl215-a', 'stale row to reheal');
    const originalEmbedding = await readVecNodeEmbedding('bl215-a');

    const wq = await WriteQueue.forPath(dbPath);
    const result = await memoryCurate(db, { op: 'reheal_stale' }, wq);

    expect(result).toMatchObject({
      op: 'reheal_stale',
      scanned: 1,
      healed: 1,
      remaining: 0,
      gone: 0,
      failed: 0,
    });

    // Do not trust the return value alone — read the DB (BL-167 standard).
    const newEmbedModel = await readEmbedModel('bl215-a');
    expect(newEmbedModel).toBe('test-feature-hash-768');
    expect(newEmbedModel).not.toBe('some-other-model');

    const newEmbedding = await readVecNodeEmbedding('bl215-a');
    expect(newEmbedding).not.toBeNull();
    expect(newEmbedding).not.toBe(originalEmbedding);
  });

  // AC3 — bounded, and rerunnable ("operator needs to be able to run it twice").
  it('BL-215/AC3: limit bounds each call; remaining decreases monotonically to 0', async () => {
    await insertStale('bl215-b1', 'stale row one');
    await insertStale('bl215-b2', 'stale row two');
    await insertStale('bl215-b3', 'stale row three');
    const wq = await WriteQueue.forPath(dbPath);

    const call1 = await memoryCurate(db, { op: 'reheal_stale', limit: 1 }, wq);
    expect(call1).toMatchObject({ scanned: 1, healed: 1, remaining: 2 });

    const call2 = await memoryCurate(db, { op: 'reheal_stale', limit: 1 }, wq);
    expect(call2).toMatchObject({ scanned: 1, healed: 1, remaining: 1 });

    const call3 = await memoryCurate(db, { op: 'reheal_stale', limit: 1 }, wq);
    expect(call3).toMatchObject({ scanned: 1, healed: 1, remaining: 0 });

    const remainingSeries = [call1, call2, call3].map(
      (r) => (r as { remaining: number }).remaining,
    );
    expect(remainingSeries).toEqual([2, 1, 0]);
    for (const r of [call1, call2, call3]) {
      expect((r as { scanned: number }).scanned).toBe(1);
    }
  });

  // AC4 — there is no disabled state: the gate is gone (ADR-0013), so the
  // operator action heals with NO env var set, and the result carries no
  // `disabled` field at all (an honest absent field, not a silent false).
  it('BL-215/AC4: no env gate — the operator action heals and reports no disabled field', async () => {
    await insertStale('bl215-c', 'stale row, no gate to trip');
    const wq = await WriteQueue.forPath(dbPath);

    const result = await memoryCurate(db, { op: 'reheal_stale' }, wq);
    expect(result).toMatchObject({
      op: 'reheal_stale',
      scanned: 1,
      healed: 1,
      remaining: 0,
    });
    expect('disabled' in (result as object)).toBe(false);

    // Confirm the heal really landed (BL-167 standard).
    expect(await readEmbedModel('bl215-c')).toBe('test-feature-hash-768');
  });

  // AC5 — dry_run: true is rejected, not silently ignored (D4).
  it('BL-215/AC5: dry_run:true is rejected with E_UNSUPPORTED, no mutation happens', async () => {
    await insertStale('bl215-d', 'stale row, dry run requested');
    const wq = await WriteQueue.forPath(dbPath);

    const result = await memoryCurate(db, { op: 'reheal_stale', dry_run: true }, wq);
    expect((result as { code: string }).code).toBe('E_UNSUPPORTED');

    // Assert on the DB row state, not just the response shape (BL-167 lesson).
    expect(await readEmbedModel('bl215-d')).toBe('some-other-model');
  });

  // AC6 — no wq supplied fails structured, not thrown (D7 defensive path).
  it('BL-215/AC6: missing wq resolves to a structured E_MISSING, never throws', async () => {
    await insertStale('bl215-e', 'stale row, no wq supplied');
    await expect(memoryCurate(db, { op: 'reheal_stale' })).resolves.toMatchObject({
      code: 'E_MISSING',
    });
  });
});
