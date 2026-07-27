/**
 * async-embed.spec.ts — the two-phase write path through the MCP handler
 * (2026-07-04 incident fix: expensive compute must not block writes).
 *
 * The suite-wide setup pins every OTHER spec file to SOX_SYNC_EMBED=1; this
 * file deletes that env and exercises the ASYNC DEFAULT deterministically via
 * the BL-161 provider seam (no real ONNX, no wall-clock assertions):
 *
 *   - GatedProvider proves the memory_write response resolves while the
 *     embedding computation is still unresolved — the queue slot and the MCP
 *     call never wait on ONNX.
 *   - memory_ping surfaces `embed_backlog` and folds it into the enrichment
 *     verdict (stalled when the oldest no-vec episode outlives the threshold).
 *   - runEnrichPassOnDb heals a crashed Phase B (backlog N→0).
 *   - BL-186: memory_curate recluster enqueues a full-pass trigger row
 *     (HONEST `enqueued: true`) and the tick consumes it with a full pass.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  getDb,
  _setEmbedProviderForTest,
  DeterministicTestProvider,
  flushPendingEmbeds,
  WriteQueue,
} from '@adhd/sox-memory-core';
import { handleToolCall, runEnrichPassOnDb } from './index.js';

// ── Instrumented providers (seam-level, deterministic) ────────────────────────

/** Provider whose embedSingle blocks until the test releases the gate. */
class GatedProvider extends DeterministicTestProvider {
  private gate: Promise<void>;
  release!: () => void;
  calls = 0;
  constructor() {
    super();
    this.gate = new Promise<void>((r) => (this.release = r));
  }
  override async embedSingle(
    ...args: Parameters<DeterministicTestProvider['embedSingle']>
  ): Promise<Float32Array> {
    this.calls++;
    await this.gate;
    return super.embedSingle(...args);
  }
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const cleanups: Array<() => void> = [];
function tmpStorePath(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-async-embed-'));
  cleanups.push(() => fs.rmSync(d, { recursive: true, force: true }));
  return path.join(d, 'store.db');
}

function parseResult(resp: { content: Array<{ text?: string }> }): Record<string, unknown> {
  return JSON.parse(resp.content[0]?.text ?? '{}') as Record<string, unknown>;
}

async function backlogOf(dbPath: string): Promise<number> {
  const db = (await getDb(dbPath)).unwrap() as Database.Database;
  const row = db
    .prepare<[], { c: number }>(
      `SELECT COUNT(*) AS c FROM node n
       WHERE n.kind='episode' AND n.t_invalid IS NULL AND n.content IS NOT NULL AND n.content != ''
         AND NOT EXISTS (SELECT 1 FROM vec_node v WHERE v.node_id = n.rowid)`,
    )
    .get()!;
  return row.c;
}

/** Raw-insert a live episode WITHOUT a vec row — the "crashed Phase B" shape. */
async function insertOrphanEpisode(dbPath: string, content: string, tCreated: string): Promise<void> {
  const db = (await getDb(dbPath)).unwrap() as Database.Database;
  db.prepare(
    `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
     VALUES (?, 'episode', ?, ?, ?, ?)`,
  ).run(`orphan-${Math.random().toString(36).slice(2)}`, content, `hash-${Math.random()}`, tCreated, tCreated);
}

beforeAll(() => {
  // This file tests the ASYNC DEFAULT — undo the suite-wide kill-switch pin.
  delete process.env['SOX_SYNC_EMBED'];
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

afterAll(async () => {
  await flushPendingEmbeds();
  WriteQueue.clearInstances();
  process.env['SOX_SYNC_EMBED'] = '1'; // restore the suite-wide pin
});

afterEach(async () => {
  await flushPendingEmbeds();
  _setEmbedProviderForTest(new DeterministicTestProvider());
  for (const c of cleanups.splice(0)) c();
});

// ── The core proof: the response never waits on the embedding ─────────────────

describe('memory_write (async default) — response resolves before the embedding computes', () => {
  it('resolves with episode_uid while embedSingle is still gated; Phase B lands after release', async () => {
    const dbPath = tmpStorePath();
    const gated = new GatedProvider();
    _setEmbedProviderForTest(gated);

    // The MCP call RESOLVES while the provider gate is still closed — the
    // queue-slot task (Phase A) performed zero embed work and the handler
    // never awaited Phase B. This is the seam-level "no ONNX on the write
    // path" proof at the server boundary.
    const resp = await handleToolCall('memory_write', {
      db_path: dbPath,
      content: 'The response must not wait for this embedding to compute.',
      project_path: '/test/project',
    });
    const out = parseResult(resp);
    expect(typeof out['episode_uid']).toBe('string');
    // near_dup is deferred (documented): null in the async response.
    expect((out['enrichment'] as { near_dup: unknown }).near_dup).toBeNull();

    // The episode is committed and DETECTED as pending-embed…
    expect(await backlogOf(dbPath)).toBe(1);

    // …and once the gate opens, Phase B applies the vector off-slot.
    gated.release();
    await flushPendingEmbeds();
    expect(gated.calls).toBe(1);
    expect(await backlogOf(dbPath)).toBe(0);
  });

  it('forwards client_request_id (WP-4): replay through the MCP handler returns the original uid', async () => {
    const dbPath = tmpStorePath();
    const first = parseResult(await handleToolCall('memory_write', {
      db_path: dbPath,
      content: 'Idempotent through the MCP surface.',
      client_request_id: 'mcp-replay-1',
      project_path: '/test/project',
    }));
    const second = parseResult(await handleToolCall('memory_write', {
      db_path: dbPath,
      content: 'Changed content, same request id.',
      client_request_id: 'mcp-replay-1',
      project_path: '/test/project',
    }));
    expect(second['replayed']).toBe(true);
    expect(second['episode_uid']).toBe(first['episode_uid']);
    const db = (await getDb(dbPath)).unwrap() as Database.Database;
    const count = db
      .prepare<[], { c: number }>("SELECT COUNT(*) AS c FROM node WHERE kind='episode'")
      .get()!;
    expect(count.c).toBe(1);
  });

  it('auto-chunked content (>2000 chars) completes through the sync Phase-A task (BL-154 guard) and drains its embeds', async () => {
    const dbPath = tmpStorePath();
    // Distinct sentences so chunk-level dedup cannot collapse them.
    const sentences: string[] = [];
    for (let i = 0; i < 60; i++) {
      sentences.push(`Observation ${i} recorded the ${['aurora', 'tide', 'glacier', 'monsoon'][i % 4]} pattern shifting near station ${i * 7}.`);
    }
    const content = sentences.join(' ');
    expect(content.length).toBeGreaterThan(2000);

    const out = parseResult(await handleToolCall('memory_write', { db_path: dbPath, content, project_path: '/test/project' }));
    expect(typeof out['episode_uid']).toBe('string');
    expect((out['chunk_count'] as number)).toBeGreaterThan(1);
    expect((out['chunk_uids'] as string[]).length).toBeGreaterThan(0);

    await flushPendingEmbeds();
    expect(await backlogOf(dbPath)).toBe(0); // parent + every chunk got its vector
  });
});

describe('memory_write_batch (async default) — one queue entry, pipelined Phase B', () => {
  it('per-item semantics unchanged (E_DEDUP not a batch failure); backlog drains to zero', async () => {
    const dbPath = tmpStorePath();
    const resp = parseResult(await handleToolCall('memory_write_batch', {
      db_path: dbPath,
      items: [
        { content: 'Migratory birds navigate using geomagnetic gradients.', project_path: '/test/project' },
        { content: 'Deep-sea vents host chemosynthetic bacterial mats.', project_path: '/test/project' },
        { content: 'MIGRATORY BIRDS NAVIGATE USING GEOMAGNETIC GRADIENTS.', project_path: '/test/project' }, // byte-dup of [0]
      ],
    }));
    const results = resp['results'] as Array<{ ok: boolean; code?: string }>;
    expect(results).toHaveLength(3);
    expect(results[0]!.ok).toBe(true);
    expect(results[1]!.ok).toBe(true);
    expect(results[2]!.ok).toBe(false);
    expect(results[2]!.code).toBe('E_DEDUP');

    await flushPendingEmbeds();
    expect(await backlogOf(dbPath)).toBe(0);
  });
});

// ── Observability: ping surfaces the backlog + stall verdict ──────────────────

describe('memory_ping — embed_backlog is machine-visible, dead Phase B reads stalled', () => {
  interface StoreBlock {
    embed_backlog: number;
    embed_backlog_oldest_at: string | null;
    enrichment: { state: string; embed_backlog?: number };
  }

  async function pingStore(dbPath: string): Promise<StoreBlock> {
    const resp = await handleToolCall('memory_ping', { db_path: dbPath });
    const body = JSON.parse(resp.content[0]?.text ?? '{}') as { store: StoreBlock | null };
    expect(body.store).not.toBeNull();
    return body.store as StoreBlock;
  }

  it('fresh pending embed → embed_backlog=1, verdict ok (no false stall alarm)', async () => {
    const dbPath = tmpStorePath();
    await getDb(dbPath); // materialise the store
    await insertOrphanEpisode(dbPath, 'freshly written, vector still in flight', new Date().toISOString());

    const store = await pingStore(dbPath);
    expect(store.embed_backlog).toBe(1);
    expect(store.embed_backlog_oldest_at).not.toBeNull();
    expect(store.enrichment.state).toBe('ok');
    expect(store.enrichment.embed_backlog).toBe(1);
  });

  it('orphan older than the stall threshold → verdict stalled (dead Phase-B pipeline is NEVER silent)', async () => {
    const dbPath = tmpStorePath();
    await getDb(dbPath);
    const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString(); // 2h >> 15min threshold
    await insertOrphanEpisode(dbPath, 'orphan from a dead pipeline', old);

    const store = await pingStore(dbPath);
    expect(store.embed_backlog).toBe(1);
    expect(store.enrichment.state).toBe('stalled');
  });

  it('no orphans, no queue rows → verdict idle with embed_backlog=0', async () => {
    const dbPath = tmpStorePath();
    await getDb(dbPath);
    const store = await pingStore(dbPath);
    expect(store.embed_backlog).toBe(0);
    expect(store.enrichment.state).toBe('idle');
  });
});

// ── Observability: the embed_pipeline ping block (write→embed metrics) ────────

describe('memory_ping — embed_pipeline block (time_to_vector + counters + mirrored backlog)', () => {
  interface EmbedPipelineBlock {
    backlog: number;
    backlog_oldest_at: string | null;
    metrics: {
      time_to_vector_ms: { p50: number; p99: number; mean: number; max: number };
      time_to_vector_samples: number;
      embed_duration_ms: { p50: number; p99: number; mean: number; max: number };
      embed_duration_samples: number;
      heal_lag_ms: { p50: number; p99: number; mean: number; max: number };
      heal_lag_samples: number;
      counters: Record<string, number>;
    } | null;
  }
  interface PingStore {
    embed_backlog: number;
    embed_backlog_oldest_at: string | null;
    embed_pipeline: EmbedPipelineBlock;
    write_queue: {
      write_latency_ms: Record<string, number>;
      apply_latency_ms: Record<string, number>;
      counters: Record<string, number>;
    } | null;
  }

  async function pingStore(dbPath: string): Promise<PingStore> {
    const resp = await handleToolCall('memory_ping', { db_path: dbPath });
    const body = JSON.parse(resp.content[0]?.text ?? '{}') as { store: PingStore | null };
    expect(body.store).not.toBeNull();
    return body.store as PingStore;
  }

  it('fresh store: block present, backlog mirrored, metrics null (no Phase-B activity yet — honest)', async () => {
    const dbPath = tmpStorePath();
    getDb(dbPath); // materialise the store, zero pipeline traffic
    const store = await pingStore(dbPath);

    expect(store.embed_pipeline).toBeDefined();
    expect(store.embed_pipeline.backlog).toBe(0);
    expect(store.embed_pipeline.backlog_oldest_at).toBeNull();
    expect(store.embed_pipeline.metrics).toBeNull();
    // Top-level fields kept as-is (HF-3 additive rule) and mirrored.
    expect(store.embed_backlog).toBe(store.embed_pipeline.backlog);
    expect(store.embed_backlog_oldest_at).toBe(store.embed_pipeline.backlog_oldest_at);
  });

  it('after an async write drains: time_to_vector recorded, counters populated, apply rode the queue as apply-kind', async () => {
    const dbPath = tmpStorePath();
    await handleToolCall('memory_write', {
      db_path: dbPath,
      content: 'Ping observability episode about basalt column formation.',
      project_path: '/test/project',
    });
    await flushPendingEmbeds();

    const store = await pingStore(dbPath);
    const block = store.embed_pipeline;
    expect(block.backlog).toBe(0); // Phase B landed
    const m = block.metrics!;
    expect(m).not.toBeNull();

    // The headline metric: exactly one pipeline apply, one monotonic sample.
    expect(m.time_to_vector_samples).toBe(1);
    expect(m.time_to_vector_ms.p50).toBeGreaterThanOrEqual(0);
    expect(m.time_to_vector_ms.max).toBeGreaterThanOrEqual(m.time_to_vector_ms.p50);
    expect(m.embed_duration_samples).toBe(1);
    expect(m.counters).toMatchObject({
      embeds_completed: 1,
      embeds_failed: 0,
      applies_applied: 1,
      heals_applied: 0,
      heals_failed: 0,
    });
    // No heals ran — the wall-clock lag distribution is empty.
    expect(m.heal_lag_samples).toBe(0);

    // Task-kind separation is visible in the write_queue block alongside:
    // the Phase-A write and the Phase-B apply are counted apart.
    const wqm = store.write_queue!;
    expect(wqm).not.toBeNull();
    expect(wqm.counters['write_tasks_completed']).toBeGreaterThanOrEqual(1);
    expect(wqm.counters['apply_tasks_completed']).toBeGreaterThanOrEqual(1);
    expect(wqm.apply_latency_ms).toBeDefined();
  });

  it('heal-path applies surface as heals_applied + heal_lag, never as time_to_vector', async () => {
    const dbPath = tmpStorePath();
    const adapter = await getDb(dbPath);
    const db = adapter.unwrap() as Database.Database;
    const old = new Date(Date.now() - 60_000).toISOString();
    await insertOrphanEpisode(dbPath, 'ping heal-path orphan with unique fjord tokens', old);

    const pass = await runEnrichPassOnDb(db, dbPath);
    expect(pass.healed).toBe(1);

    const m = (await pingStore(dbPath)).embed_pipeline.metrics!;
    expect(m.counters.heals_applied).toBe(1);
    expect(m.heal_lag_samples).toBe(1);
    expect(m.heal_lag_ms.p50).toBeGreaterThanOrEqual(60_000); // wall-clock age
    expect(m.time_to_vector_samples).toBe(0); // heals never pollute the headline
  });
});

// ── The heal: periodic tick repairs a crashed Phase B ─────────────────────────

describe('runEnrichPassOnDb — the tick heals missing vectors (crash between phases)', () => {
  it('orphaned no-vec episodes are re-embedded on the tick; backlog N→0; verdict flips to idle', async () => {
    const dbPath = tmpStorePath();
    const adapter = await getDb(dbPath);
    const db = adapter.unwrap() as Database.Database;
    const old = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    await insertOrphanEpisode(dbPath, 'first crash orphan with unique glacier tokens', old);
    await insertOrphanEpisode(dbPath, 'second crash orphan with unique monsoon tokens', old);
    expect(await backlogOf(dbPath)).toBe(2);

    const pass = await runEnrichPassOnDb(db, dbPath);
    expect(pass.healed).toBe(2);
    expect(pass.heal_failed).toBe(0);
    expect(await backlogOf(dbPath)).toBe(0);

    const resp = await handleToolCall('memory_ping', { db_path: dbPath });
    const body = JSON.parse(resp.content[0]?.text ?? '{}') as {
      store: { embed_backlog: number; enrichment: { state: string } };
    };
    expect(body.store.embed_backlog).toBe(0);
    expect(body.store.enrichment.state).toBe('idle');
  });
});

// ── BL-186: recluster is queued and honest ────────────────────────────────────

describe('memory_curate recluster (global) — BL-186: honest enqueue, consumed by the tick as a FULL pass', () => {
  it('enqueued:true is backed by a committed full-pass trigger row; the tick runs full then reverts to incremental', async () => {
    const dbPath = tmpStorePath();
    const adapter = await getDb(dbPath);
    const db = adapter.unwrap() as Database.Database;
    await handleToolCall('memory_write', {
      db_path: dbPath,
      content: 'Calibration of the pneumatic widget press requires forty newton metres.',
      project_path: '/test/project',
    });
    await handleToolCall('memory_write', {
      db_path: dbPath,
      content: 'Albatross navigation relies on geomagnetic field gradients over open ocean.',
      project_path: '/test/project',
    });
    await flushPendingEmbeds();

    const out = parseResult(await handleToolCall('memory_curate', { db_path: dbPath, op: 'recluster' }));
    expect(out['op']).toBe('recluster');
    expect(out['enqueued']).toBe(true); // HONEST: the row below exists
    expect(typeof out['seq']).toBe('number');

    const row = db
      .prepare<[number], { op: string; payload: string; done_at: string | null }>(
        'SELECT op, payload, done_at FROM organizer_queue WHERE seq = ?',
      )
      .get(out['seq'] as number)!;
    expect(row.op).toBe('enrich');
    expect((JSON.parse(row.payload) as { full: boolean }).full).toBe(true);
    expect(row.done_at).toBeNull(); // pending until the tick

    // The tick consumes it as a FULL (non-incremental) pass and completes the row.
    const pass = await runEnrichPassOnDb(db, dbPath);
    expect(pass.full_pass).toBe(true);
    const done = db
      .prepare<[number], { done_at: string | null }>(
        'SELECT done_at FROM organizer_queue WHERE seq = ?',
      )
      .get(out['seq'] as number)!;
    expect(done.done_at).not.toBeNull();

    // One-shot: with the row completed, the next tick is incremental again.
    const nextPass = await runEnrichPassOnDb(db, dbPath);
    expect(nextPass.full_pass).toBe(false);
  });

  it('dry_run stays enqueued:false and writes no trigger row', async () => {
    const dbPath = tmpStorePath();
    const adapter = await getDb(dbPath);
    const db = adapter.unwrap() as Database.Database;
    const before = db
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM organizer_queue')
      .get()!.c;
    const out = parseResult(
      await handleToolCall('memory_curate', { db_path: dbPath, op: 'recluster', dry_run: true }),
    );
    expect(out['enqueued']).toBe(false);
    expect(out['dry_run']).toBe(true);
    const after = db
      .prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM organizer_queue')
      .get()!.c;
    expect(after).toBe(before);
  });
});
