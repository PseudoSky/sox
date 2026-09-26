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
 * Fix: `schedulePendingEmbeds` stamps the ledger (throttled) INSIDE the
 * embed's own apply task, after the vector commit (`stampSuccessfulEmbed`, one
 * atomic `json_set` upsert). The stamp is monotonic, never rewrites the rest of
 * the ledger, and never costs a second queue task — `apply_tasks_completed`
 * counts embed applies only.
 *
 * RED (fix disabled — the stamp call removed): the ledger still reads the stale
 * seeded timestamp after a successful pipeline embed. RED (stamp enqueued as its
 * own apply-kind task, the first 324da3a8 shape): `apply_tasks_completed` is 2
 * for one pipeline apply.
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

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch (err) {
    console.warn(`[324da3a8 spec] turso adapter unavailable, skipping turso cases: ${String(err)}`);
    return false;
  }
})();

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

describe('324da3a8 — the stamp rides the apply task, it is not a second queue task', () => {
  it('one pipeline apply completes exactly one apply-kind task AND advances last_successful_embed_at', async () => {
    await stampSuccessfulEmbed(adapter, STALE);
    const wq = await WriteQueue.forPath(dbPath);
    const a = await phaseA('one apply, one apply task, one fresh stamp');
    const before = new Date().toISOString();
    const res = await schedulePendingEmbeds(wq, [a.pending!], { vectorDialect: await vectorDialectFor(adapter) });
    expect(res.applied).toBe(1);

    const c = wq.getMetrics().counters;
    expect(c.apply_tasks_completed).toBe(1);
    expect(c.tasks_completed).toBe(1);

    const stamped = (await readEnrichHealthLedger(adapter)).last_successful_embed_at;
    expect(stamped).not.toBe(STALE);
    expect(stamped! >= before).toBe(true);
  });
});

describe.each(hasTurso ? (['sqlite', 'turso'] as const) : (['sqlite'] as const))(
  '324da3a8 — stampSuccessfulEmbed is one atomic json_set upsert (%s)',
  (kind) => {
    let kDir: string;
    let kAdapter: StoreAdapter;

    beforeEach(async () => {
      process.env.STORE_ADAPTER = kind;
      kDir = fs.mkdtempSync(path.join(os.tmpdir(), `324da3a8-${kind}-`));
      kAdapter = await openDb(path.join(kDir, 'm.db'));
    });

    afterEach(async () => {
      await kAdapter.close();
      process.env.STORE_ADAPTER = 'sqlite';
      fs.rmSync(kDir, { recursive: true, force: true });
    });

    it('seeds a missing ledger row with the stamp; every other field reads as empty', async () => {
      await stampSuccessfulEmbed(kAdapter, STALE);
      const l = await readEnrichHealthLedger(kAdapter);
      expect(l.last_successful_embed_at).toBe(STALE);
      expect(l.passes_ok).toBe(0);
    });

    it('rewrites only $.last_successful_embed_at — pass counters recorded by recordEnrichPass survive (86ca8a02)', async () => {
      await recordEnrichPass(kAdapter, {
        ok: true,
        embeds_completed: 0,
        embeds_failed: 2,
        heals_applied: 3,
        heals_failed: 0,
        poisoned_skipped: 1,
        backlog_before: 9,
        backlog_after: 5,
      });
      const before = await readEnrichHealthLedger(kAdapter);
      await stampSuccessfulEmbed(kAdapter, '2099-01-01T00:00:00.000Z');
      const after = await readEnrichHealthLedger(kAdapter);
      expect(after).toEqual({ ...before, last_successful_embed_at: '2099-01-01T00:00:00.000Z' });
    });

    it('is monotonic — an older timestamp never overwrites a newer one', async () => {
      await stampSuccessfulEmbed(kAdapter, '2026-09-25T10:00:00.000Z');
      await stampSuccessfulEmbed(kAdapter, STALE);
      expect((await readEnrichHealthLedger(kAdapter)).last_successful_embed_at).toBe('2026-09-25T10:00:00.000Z');
    });

    it('reseeds an unparseable ledger row instead of throwing', async () => {
      await kAdapter.executeRun(
        `INSERT INTO sox_store_meta (key, value) VALUES ('enrich_health_ledger', '{not json')
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
        [],
      );
      await stampSuccessfulEmbed(kAdapter, STALE);
      expect((await readEnrichHealthLedger(kAdapter)).last_successful_embed_at).toBe(STALE);
    });
  },
);
