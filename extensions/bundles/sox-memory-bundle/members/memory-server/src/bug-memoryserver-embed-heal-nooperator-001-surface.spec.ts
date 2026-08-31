/**
 * bug-memoryserver-embed-heal-nooperator-001-surface.spec.ts —
 * BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001, the memory_ping / memory_curate
 * surface.
 *
 * RED→GREEN (BL-225): the pre-fix ping surfaced `enrichment.state` (queue
 * freshness) and NO `enrichment.health`/`progress`/`alarm` blocks at all; its
 * top-level `status` was `ok` whenever store + embed read healthy, even while
 * the enrich/embed pipeline had not SUCCEEDED in >24h (2026-08-26). And the
 * five lifetime control-plane ops (`drain`/`reset_pipeline`/`resume`/`unpoison`
 * /`ack_alarm`) did not exist. These arms assert the new surface:
 *   - ping surfaces enrichment.health{state,reasons,poisoned_rows} +
 *     enrichment.progress (the ledger) + enrichment.alarm;
 *   - top-level status is `degraded` when store + embed are ok but the pipeline
 *     verdict is `stalled`;
 *   - the five curate ops round-trip idempotently through handleToolCall.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { getDb, closeAllAdapters, WriteQueue } from '@adhd/sox-memory-core';
import { handleToolCall } from './index.js';

const cleanups: Array<() => void> = [];

afterEach(async () => {
  await closeAllAdapters();
  WriteQueue.clearInstances();
  for (const c of cleanups.splice(0)) c();
});

function tmpDbPath(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-surface-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'store.db');
}

function parse(resp: { content: Array<{ text?: string }> }): Record<string, any> {
  return JSON.parse(resp.content[0]?.text ?? '{}') as Record<string, any>;
}

/** Seed a store with one live episode that has NO vec row (backlog > 0) — the
 *  "dead Phase-B pipeline" shape that makes the honest verdict `stalled`.
 *  Keeps the adapter OPEN (getDb caches by path — closing it would leave
 *  handleToolCall holding a dead cached adapter). */
async function seedOrphanStore(dbPath: string): Promise<void> {
  const adapter = await getDb(dbPath);
  await adapter.executeRun(
    `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
     VALUES (?, 'episode', ?, ?, datetime('now'), datetime('now'))`,
    ['orphan-surface', 'orphan episode missing its vector', 'hash-surface'],
  );
}

describe('BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001 — memory_ping surfaces the honest health plane', () => {
  it('surfaces enrichment.health{state,reasons,poisoned_rows} + progress + alarm blocks (additive, HF-3)', async () => {
    const dbPath = tmpDbPath();
    await seedOrphanStore(dbPath);

    const resp = await handleToolCall('memory_ping', { db_path: dbPath });
    const body = parse(resp);
    expect(body.store).toBeDefined();

    const enr = body.store.enrichment;
    expect(enr).toBeDefined();

    // The new HONEST verdict (last_successful_pass_at keyed), distinct from the
    // legacy queue-freshness `enr.state` spread field.
    expect(enr.health).toBeDefined();
    expect(enr.health.state).toBe('stalled');
    expect(Array.isArray(enr.health.reasons)).toBe(true);
    expect(typeof enr.health.poisoned_rows).toBe('number');

    // The durable ledger (all-zero on a never-ticked fresh store).
    expect(enr.progress).toBeDefined();
    expect(enr.progress.last_successful_pass_at).toBeNull();
    expect(enr.progress.net_drained).toBe(0);

    // The tiered alarm (null until the tick escalates).
    expect(enr.alarm).toBeNull();
  });

  it('top-level status is degraded when store + embed are ok but the pipeline verdict is stalled', async () => {
    const dbPath = tmpDbPath();
    await seedOrphanStore(dbPath);

    const resp = await handleToolCall('memory_ping', { db_path: dbPath });
    const body = parse(resp);

    // Both store and embed read HEALTHY — the exact 2026-08-26 false-positive
    // inputs. The pre-fix ping said `status: "ok"` here.
    expect(body.store_ok).toBe(true);
    expect(body.embed_state).toBe('real');

    // But the pipeline has a backlog and no successful pass → stalled.
    expect(body.store.enrichment.health.state).toBe('stalled');

    // THE regression: the pre-fix verdict read `ok`; now it must be degraded.
    expect(body.status).toBe('degraded');
    expect(body.status).not.toBe('ok');
  });
});

describe('BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001 — the 5 lifetime control-plane curate ops round-trip idempotently', () => {
  it('drain (dry_run previews; real drain is idempotent on an empty backlog)', async () => {
    const dbPath = tmpDbPath();
    await seedOrphanStore(dbPath);

    const dry = parse(await handleToolCall('memory_curate', { db_path: dbPath, op: 'drain', dry_run: true }));
    expect(dry.op).toBe('drain');
    expect(dry.dry_run).toBe(true);
    expect(dry.remaining).toBeGreaterThan(0);

    const drained = parse(await handleToolCall('memory_curate', { db_path: dbPath, op: 'drain' }));
    expect(drained.op).toBe('drain');
    expect(drained.fully_drained).toBe(true);
    expect(drained.remaining).toBe(0);

    // Idempotent: draining an already-empty backlog succeeds with zero work.
    const again = parse(await handleToolCall('memory_curate', { db_path: dbPath, op: 'drain' }));
    expect(again.fully_drained).toBe(true);
    expect(again.remaining).toBe(0);
  });

  it('reset_pipeline clears ledger + alarm + poison, idempotently', async () => {
    const dbPath = tmpDbPath();
    await seedOrphanStore(dbPath);

    const r1 = parse(await handleToolCall('memory_curate', { db_path: dbPath, op: 'reset_pipeline' }));
    expect(r1.op).toBe('reset_pipeline');
    expect(r1.cleared_ledger).toBe(true);
    expect(r1.cleared_alarm).toBe(true);
    expect(typeof r1.unpoisoned_rows).toBe('number');

    const r2 = parse(await handleToolCall('memory_curate', { db_path: dbPath, op: 'reset_pipeline' }));
    expect(r2.op).toBe('reset_pipeline');
    expect(r2.cleared_ledger).toBe(true);
    expect(r2.unpoisoned_rows).toBe(0); // nothing left to unpoison — idempotent
  });

  it('resume is idempotent (no alarm present → still succeeds)', async () => {
    const dbPath = tmpDbPath();
    await seedOrphanStore(dbPath);

    const r1 = parse(await handleToolCall('memory_curate', { db_path: dbPath, op: 'resume' }));
    expect(r1.op).toBe('resume');
    expect(r1.resumed).toBe(true);

    const r2 = parse(await handleToolCall('memory_curate', { db_path: dbPath, op: 'resume' }));
    expect(r2.op).toBe('resume');
    expect(r2.resumed).toBe(true);
  });

  it('unpoison (all, then by uid) is idempotent', async () => {
    const dbPath = tmpDbPath();
    await seedOrphanStore(dbPath);

    const all = parse(await handleToolCall('memory_curate', { db_path: dbPath, op: 'unpoison' }));
    expect(all.op).toBe('unpoison');
    expect(all.removed).toBe(0);

    const byUid = parse(await handleToolCall('memory_curate', { db_path: dbPath, op: 'unpoison', uid: 'nonexistent', dry_run: true }));
    expect(byUid.op).toBe('unpoison');
    expect(byUid.uid).toBe('nonexistent');
    expect(byUid.removed).toBe(0);
  });

  it('ack_alarm reports acknowledged:false when no alarm is raised (idempotent)', async () => {
    const dbPath = tmpDbPath();
    await seedOrphanStore(dbPath);

    const r1 = parse(await handleToolCall('memory_curate', { db_path: dbPath, op: 'ack_alarm' }));
    expect(r1.op).toBe('ack_alarm');
    expect(r1.acknowledged).toBe(false);

    const r2 = parse(await handleToolCall('memory_curate', { db_path: dbPath, op: 'ack_alarm' }));
    expect(r2.op).toBe('ack_alarm');
    expect(r2.acknowledged).toBe(false);
  });
});
