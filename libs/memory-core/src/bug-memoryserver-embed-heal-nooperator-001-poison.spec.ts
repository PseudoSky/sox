/**
 * bug-memoryserver-embed-heal-nooperator-001-poison.spec.ts —
 * BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001, the per-row poison ledger.
 *
 * RED→GREEN (BL-225): the pre-fix heal loop re-attempted the SAME failing rows
 * on every tick forever — 212 heal-row failures + 235 embed errors on
 * 2026-08-26, all spinning on an identical head-of-queue window. A row that
 * fails embed N times is POISONING the heal window. `enrich_poison` + the
 * `poisonThreshold`-gated heal scan now EXCLUDE a poisoned row from retry (the
 * row is NEVER dropped and NEVER mutated — it stays in `node`, recallable via
 * BM25/temporal), until an operator unpoisons it. These arms fail against the
 * pre-fix scan (which had no poison table/exclusion) and pass now.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { healMissingVectors, flushPendingEmbeds, _resetEmbedPipelineMetricsForTest } from './embed-pipeline.js';
import { WriteQueue } from './write-queue.js';
import { _setEmbedProviderForTest } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';
import {
  recordRowFailure,
  poisonThreshold,
  poisonReentryMs,
  unpoisonRow,
  unpoisonAll,
  countPoisonedRows,
  isRowPoisoned,
  listPoisonedRows,
} from './enrich-poison.js';

const cleanups: Array<() => void> = [];

async function insertOrphanEpisode(adapter: StoreAdapter, uid: string, content: string): Promise<void> {
  await adapter.executeRun(
    `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
     VALUES (?, 'episode', ?, ?, datetime('now'), datetime('now'))`,
    [uid, content, `hash-${uid}`],
  );
}

async function orphanCount(adapter: StoreAdapter): Promise<number> {
  const r = await adapter.executeGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM node n
     WHERE n.kind = 'episode' AND n.t_invalid IS NULL
       AND NOT EXISTS (SELECT 1 FROM vec_node v WHERE v.node_id = n.rowid)`,
  );
  return r?.c ?? 0;
}

let ctx: { dir: string; dbPath: string; adapter: StoreAdapter };

beforeEach(async () => {
  process.env.STORE_ADAPTER = 'sqlite';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-poison-'));
  ctx = {
    dir,
    dbPath: path.join(dir, 'm.db'),
    adapter: await openDb(path.join(dir, 'm.db')),
  };
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  await WriteQueue.clearInstances();
  WriteQueue.setBypass(false);
  _resetEmbedPipelineMetricsForTest();
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

afterEach(async () => {
  await flushPendingEmbeds();
  await WriteQueue.clearInstances();
  _resetEmbedPipelineMetricsForTest();
  ctx.adapter.close().catch(() => undefined);
  for (const c of cleanups.splice(0)) c();
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

describe('BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001 — recordRowFailure + poisonThreshold', () => {
  it('recordRowFailure upserts and increments the per-row failure count (ON CONFLICT-safe)', async () => {
    const uid = 'poison-me-1';
    await recordRowFailure(ctx.adapter, uid, 'Model not initialized');
    await recordRowFailure(ctx.adapter, uid, 'Model not initialized');
    const n = await recordRowFailure(ctx.adapter, uid, 'Model not initialized');
    expect(n).toBe(3);

    const rows = await listPoisonedRows(ctx.adapter);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.uid).toBe(uid);
    expect(rows[0]!.failures).toBe(3);
    expect(rows[0]!.last_error).toBe('Model not initialized');
    expect(rows[0]!.first_poisoned_at).not.toBeNull();
  });

  it('isRowPoisoned/countPoisonedRows only count rows AT OR ABOVE the threshold', async () => {
    expect(poisonThreshold()).toBe(3);

    await recordRowFailure(ctx.adapter, 'under-1', 'e');
    await recordRowFailure(ctx.adapter, 'under-1', 'e'); // 2 < 3 — not poisoned yet
    expect(await isRowPoisoned(ctx.adapter, 'under-1')).toBe(false);
    expect(await countPoisonedRows(ctx.adapter)).toBe(0);

    await recordRowFailure(ctx.adapter, 'under-1', 'e'); // 3 == threshold → poisoned
    expect(await isRowPoisoned(ctx.adapter, 'under-1')).toBe(true);
    expect(await countPoisonedRows(ctx.adapter)).toBe(1);
  });

  it('unpoisonRow removes a single row; unpoisonAll clears the whole ledger', async () => {
    await recordRowFailure(ctx.adapter, 'a', 'e');
    await recordRowFailure(ctx.adapter, 'a', 'e');
    await recordRowFailure(ctx.adapter, 'a', 'e');
    await recordRowFailure(ctx.adapter, 'b', 'e');
    await recordRowFailure(ctx.adapter, 'b', 'e');
    await recordRowFailure(ctx.adapter, 'b', 'e');

    await unpoisonRow(ctx.adapter, 'a');
    expect(await isRowPoisoned(ctx.adapter, 'a')).toBe(false);
    expect(await isRowPoisoned(ctx.adapter, 'b')).toBe(true);

    await unpoisonAll(ctx.adapter);
    expect(await countPoisonedRows(ctx.adapter)).toBe(0);
  });
});

describe('BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001 — heal scan excludes poisoned rows (row NEVER dropped)', () => {
  it('a row poisoned at threshold is excluded from the next heal scan; the node row is untouched (still recallable)', async () => {
    const uid = 'poisoned-orphan';
    await insertOrphanEpisode(ctx.adapter, uid, 'recallable even while poisoned');

    // Poison it: 3 consecutive failures (the exact "fails embed 3x" shape).
    for (let i = 0; i < poisonThreshold(); i++) {
      await recordRowFailure(ctx.adapter, uid, 'Model not initialized');
    }
    expect(await isRowPoisoned(ctx.adapter, uid)).toBe(true);

    // The heal scan must SKIP the poisoned row entirely — and report it as
    // `poisoned_skipped` (parked, not healed).
    const wq = await WriteQueue.forPath(ctx.dbPath);
    const heal = await healMissingVectors(ctx.adapter, wq, { limit: 100 });
    expect(heal.scanned).toBe(0);
    expect(heal.healed).toBe(0);
    expect(heal.poisoned_skipped).toBe(1);

    // The node itself is NEVER dropped — still a live, recallable episode.
    const node = await ctx.adapter.executeGet<{ content: string }>(
      `SELECT content FROM node WHERE uid = ? AND t_invalid IS NULL`,
      [uid],
    );
    expect(node).not.toBeNull();
    expect(node!.content).toBe('recallable even while poisoned');
    // Still counted as backlog (it has no vec row) — poisoned ≠ resolved.
    expect(await orphanCount(ctx.adapter)).toBe(1);
  });

  it('unpoison re-admits the row: the next heal scan picks it up and heals it', async () => {
    const uid = 'unpoison-orphan';
    await insertOrphanEpisode(ctx.adapter, uid, 're-enters after unpoison');

    for (let i = 0; i < poisonThreshold(); i++) {
      await recordRowFailure(ctx.adapter, uid, 'e');
    }
    const wq = await WriteQueue.forPath(ctx.dbPath);
    const before = await healMissingVectors(ctx.adapter, wq, { limit: 100 });
    expect(before.scanned).toBe(0); // excluded while poisoned

    await unpoisonRow(ctx.adapter, uid);
    const after = await healMissingVectors(ctx.adapter, wq, { limit: 100 });
    expect(after.scanned).toBe(1);
    expect(after.healed).toBe(1);
    expect(await orphanCount(ctx.adapter)).toBe(0);
  });

  it('a successful heal clears a prior poison (recordRowFailure then a real embed succeeds)', async () => {
    const uid = 'recovered-orphan';
    await insertOrphanEpisode(ctx.adapter, uid, 'recoverable');
    await recordRowFailure(ctx.adapter, uid, 'transient');
    await recordRowFailure(ctx.adapter, uid, 'transient');

    const wq = await WriteQueue.forPath(ctx.dbPath);
    const heal = await healMissingVectors(ctx.adapter, wq, { limit: 100 });
    // 2 failures < threshold(3) → still scanned; the embed succeeds → the
    // heal path clears the poison row.
    expect(heal.scanned).toBe(1);
    expect(heal.healed).toBe(1);
    expect(await listPoisonedRows(ctx.adapter)).toHaveLength(0);
  });

  it('BOUNDED QUARANTINE: a poisoned row re-enters the next scan once last_failed_at ages past poisonReentryMs (no operator)', async () => {
    const uid = 'bounded-orphan';
    await insertOrphanEpisode(ctx.adapter, uid, 'auto re-enters after cooldown');

    // Poison it (recent last_failed_at).
    for (let i = 0; i < poisonThreshold(); i++) {
      await recordRowFailure(ctx.adapter, uid, 'Model not initialized');
    }
    expect(await isRowPoisoned(ctx.adapter, uid)).toBe(true);
    expect(await countPoisonedRows(ctx.adapter)).toBe(1);

    const wq = await WriteQueue.forPath(ctx.dbPath);
    const before = await healMissingVectors(ctx.adapter, wq, { limit: 100 });
    expect(before.scanned).toBe(0); // excluded while within the cooldown window
    expect(before.poisoned_skipped).toBe(1);

    // Simulate the cooldown elapsing: backdate `last_failed_at` past the
    // reentry boundary. This is the bounded-quarantine circuit breaker — the
    // row re-enters WITHOUT any operator action.
    const stale = new Date(Date.now() - poisonReentryMs() - 60_000).toISOString();
    await ctx.adapter.executeRun(
      `UPDATE enrich_poison SET last_failed_at = ? WHERE uid = ?`,
      [stale, uid],
    );

    // It is no longer counted as quarantined…
    expect(await isRowPoisoned(ctx.adapter, uid)).toBe(false);
    expect(await countPoisonedRows(ctx.adapter)).toBe(0);

    // …and the next heal scan picks it up and heals it.
    const after = await healMissingVectors(ctx.adapter, wq, { limit: 100 });
    expect(after.scanned).toBe(1);
    expect(after.healed).toBe(1);
    expect(after.poisoned_skipped).toBe(0);
    expect(await orphanCount(ctx.adapter)).toBe(0);
    // The successful heal cleared the poison row entirely.
    expect(await listPoisonedRows(ctx.adapter)).toHaveLength(0);
  });

  it('reset_pipeline clears the poison table (cause-cleared re-entry)', async () => {
    const uid = 'reset-orphan';
    await insertOrphanEpisode(ctx.adapter, uid, 'cleared by reset_pipeline');
    for (let i = 0; i < poisonThreshold(); i++) {
      await recordRowFailure(ctx.adapter, uid, 'e');
    }
    expect(await isRowPoisoned(ctx.adapter, uid)).toBe(true);

    await unpoisonAll(ctx.adapter); // what reset_pipeline calls
    expect(await countPoisonedRows(ctx.adapter)).toBe(0);
    expect(await listPoisonedRows(ctx.adapter)).toHaveLength(0);
  });
});
