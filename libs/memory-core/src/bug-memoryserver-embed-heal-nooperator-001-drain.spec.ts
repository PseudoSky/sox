/**
 * bug-memoryserver-embed-heal-nooperator-001-drain.spec.ts —
 * BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001, the backlog drain.
 *
 * RED→GREEN (BL-225): the pre-fix heal ran ONLY inside the periodic tick's
 * 240s time budget, so a stuck backlog could never be cleared in one pass —
 * each tick drained a bounded window and the backlog kept re-growing (the
 * 2026-08-26 shape). `drainBacklog` loops heal batches WITHOUT the tick time
 * budget (per-row embed timeout stays) until the backlog reaches 0 or a batch
 * makes no forward progress, and re-verifies `fully_drained` against a fresh
 * `embedBacklogStats` read. It is the operator (`memory_curate drain`) and
 * rate-limited auto-heal recovery path. Empty queue is idempotent.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { drainBacklog, embedBacklogStats, flushPendingEmbeds, _resetEmbedPipelineMetricsForTest } from './embed-pipeline.js';
import { WriteQueue } from './write-queue.js';
import { _setEmbedProviderForTest } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';

interface Ctx { dir: string; dbPath: string; adapter: StoreAdapter; }

async function tmpDb(): Promise<Ctx> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-drain-'));
  const dbPath = path.join(dir, 'm.db');
  const adapter = await openDb(dbPath);
  return { dir, dbPath, adapter };
}

async function insertOrphanEpisode(adapter: StoreAdapter, i: number): Promise<void> {
  await adapter.executeRun(
    `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
     VALUES (?, 'episode', ?, ?, datetime('now'), datetime('now'))`,
    [`drain-orphan-${i}`, `drain backlog orphan ${i}`, `hash-${i}`],
  );
}

let ctx: Ctx;

beforeEach(async () => {
  process.env.STORE_ADAPTER = 'sqlite';
  ctx = await tmpDb();
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
  fs.rmSync(ctx.dir, { recursive: true, force: true });
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

describe('BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001 — drainBacklog', () => {
  it('empty queue is idempotent: fully_drained + verified, remaining 0, zero batches', async () => {
    const wq = await WriteQueue.forPath(ctx.dbPath);
    const r = await drainBacklog(ctx.adapter, wq, { limit: 64 });
    expect(r.fully_drained).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.remaining).toBe(0);
    expect(r.healed_total).toBe(0);
    expect(r.batches).toBe(0);
  });

  it('drains a stuck backlog below the batch size in one verified batch', async () => {
    for (let i = 0; i < 7; i++) await insertOrphanEpisode(ctx.adapter, i);
    expect((await embedBacklogStats(ctx.adapter)).count).toBe(7);

    const wq = await WriteQueue.forPath(ctx.dbPath);
    const r = await drainBacklog(ctx.adapter, wq, { limit: 64 });

    expect(r.fully_drained).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.remaining).toBe(0);
    expect(r.healed_total).toBe(7);
    expect(r.batches).toBe(1);
    expect((await embedBacklogStats(ctx.adapter)).count).toBe(0);
  });

  it('loops multiple batches (beyond the limit) WITHOUT the per-tick budget — the whole backlog drains', async () => {
    // 3 batches worth of backlog (limit 8), drained in one drainBacklog call.
    for (let i = 0; i < 20; i++) await insertOrphanEpisode(ctx.adapter, i);
    expect((await embedBacklogStats(ctx.adapter)).count).toBe(20);

    const wq = await WriteQueue.forPath(ctx.dbPath);
    const r = await drainBacklog(ctx.adapter, wq, { limit: 8 });

    expect(r.fully_drained).toBe(true);
    expect(r.verified).toBe(true);
    expect(r.remaining).toBe(0);
    expect(r.healed_total).toBe(20);
    expect(r.batches).toBe(3); // 8 + 8 + 4
    expect((await embedBacklogStats(ctx.adapter)).count).toBe(0);
  });
});
