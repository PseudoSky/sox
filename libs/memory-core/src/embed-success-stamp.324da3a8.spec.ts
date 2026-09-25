/**
 * 324da3a8 — memory_ping `enrichment.progress.last_successful_embed_at` froze
 * (prod: 2026-09-24T17:26:51Z) while the write-path pipeline embedded
 * successfully (1,703 host request.finish on 09-25).
 *
 * Root cause: the field lives in the persisted enrich-health ledger and was
 * written ONLY by `recordEnrichPass`, fed by the periodic HEAL count
 * (`embeds_completed: heal.healed`, memory-server index.ts). A healthy
 * pipeline leaves the heal nothing to do, so the stamp never moved.
 *
 * Fix: `schedulePendingEmbeds` stamps the ledger (throttled) after an apply
 * lands (`stampSuccessfulEmbed`), and the stamp is monotonic.
 *
 * RED (fix disabled — the `maybeStampEmbedSuccess` call removed): the ledger
 * still reads the stale seeded timestamp after a successful pipeline embed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { openDb } from './db.js';
import { memoryWritePhaseA } from './write.js';
import type { PhaseAOutcome } from './write.js';
import {
  schedulePendingEmbeds,
  flushPendingEmbeds,
  _resetEmbedPipelineMetricsForTest,
} from './embed-pipeline.js';
import { WriteQueue } from './write-queue.js';
import { vectorDialectFor } from './dialect.js';
import { _setEmbedProviderForTest } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';
import { readEnrichHealthLedger, recordEnrichPass, stampSuccessfulEmbed } from './enrich-health.js';

const STALE = '2026-09-24T17:26:51.000Z';

let dir: string;
let dbPath: string;
let adapter: StoreAdapter;

beforeEach(async () => {
  process.env.STORE_ADAPTER = 'sqlite';
  dir = fs.mkdtempSync(path.join(os.tmpdir(), '324da3a8-'));
  dbPath = path.join(dir, 'm.db');
  adapter = await openDb(dbPath);
  await WriteQueue.clearInstances();
  WriteQueue.setBypass(false);
  _resetEmbedPipelineMetricsForTest();
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

afterEach(async () => {
  await flushPendingEmbeds();
  await WriteQueue.clearInstances();
  _resetEmbedPipelineMetricsForTest();
  fs.rmSync(dir, { recursive: true, force: true });
});

async function phaseA(content: string): Promise<PhaseAOutcome> {
  const r = await memoryWritePhaseA(adapter, { content, project_path: '/test/project' });
  expect('code' in r).toBe(false);
  return r as PhaseAOutcome;
}

describe('324da3a8 — last_successful_embed_at advances on the write-path (funnel) embed', () => {
  it('a successful pipeline embed moves the ledger stamp past a stale value', async () => {
    await stampSuccessfulEmbed(adapter, STALE);
    expect((await readEnrichHealthLedger(adapter)).last_successful_embed_at).toBe(STALE);

    const wq = await WriteQueue.forPath(dbPath);
    const a = await phaseA('pipeline embed advances the freshness stamp');
    const before = new Date().toISOString();
    const res = await schedulePendingEmbeds(wq, [a.pending!], { vectorDialect: await vectorDialectFor(adapter) });
    expect(res.applied).toBe(1);

    const ledger = await readEnrichHealthLedger(adapter);
    expect(ledger.last_successful_embed_at).not.toBe(STALE);
    expect(ledger.last_successful_embed_at! >= before).toBe(true);
  });

  it('a later heal pass that healed nothing does not roll the stamp back', async () => {
    const wq = await WriteQueue.forPath(dbPath);
    const a = await phaseA('stamp survives an empty heal pass');
    await schedulePendingEmbeds(wq, [a.pending!], { vectorDialect: await vectorDialectFor(adapter) });
    const stamped = (await readEnrichHealthLedger(adapter)).last_successful_embed_at;
    expect(stamped).not.toBeNull();

    await recordEnrichPass(adapter, {
      ok: true,
      embeds_completed: 0,
      embeds_failed: 0,
      heals_applied: 0,
      heals_failed: 0,
      poisoned_skipped: 0,
      backlog_before: 0,
      backlog_after: 0,
    });
    expect((await readEnrichHealthLedger(adapter)).last_successful_embed_at).toBe(stamped);
  });

  it('stampSuccessfulEmbed is monotonic — an older timestamp never overwrites a newer one', async () => {
    await stampSuccessfulEmbed(adapter, '2026-09-25T10:00:00.000Z');
    await stampSuccessfulEmbed(adapter, STALE);
    expect((await readEnrichHealthLedger(adapter)).last_successful_embed_at).toBe('2026-09-25T10:00:00.000Z');
  });
});
