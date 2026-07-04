/**
 * embed-pipeline-metrics.spec.ts — Phase-B pipeline observability
 * (two-phase write follow-on: "what about the metrics on write to embed?").
 *
 * WHAT IS PINNED HERE:
 *   1. time_to_vector_ms — the headline eventual-consistency window (Phase-A
 *      commit → vec_node applied) — is recorded on the ASYNC pipeline path
 *      from the monotonic startedAtMs stamp, and NEVER on the heal path
 *      (heal applies lost their in-process stamp to a crash; mixing week-old
 *      wall-clock lags into the distribution would destroy it).
 *   2. Heal-path applies are counted separately (heals_applied) and aged via
 *      the WALL-CLOCK heal_lag_ms distribution (node.t_created-based).
 *   3. Monotonic counters cover every branch: embeds_completed/failed,
 *      applies applied/exists/gone, heals applied/failed.
 *   4. embed_duration_ms measures the embed call itself (both paths).
 *   5. Metrics are PER-STORE, keyed identically to WriteQueue.metricsForPath
 *      (wq.storePath) — two stores never bleed into each other.
 *   6. getEmbedPipelineMetrics is pure and null for unknown stores.
 *
 * DETERMINISM (BL-161): deterministic provider seam, no real ONNX; the clock
 * seam is the startedAtMs stamp itself (backdated by the test — lower-bound
 * assertions, zero sleeps).
 *
 * Gate: npx nx test memory-core --skip-nx-cache
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import type Database from 'better-sqlite3';
import type { EmbedRole } from '@adhd/sox-embedding-provider';
import { openDb } from './db.js';
import { memoryWritePhaseA } from './write.js';
import type { PhaseAOutcome } from './write.js';
import {
  applyEmbedding,
  schedulePendingEmbeds,
  flushPendingEmbeds,
  healMissingVectors,
  getEmbedPipelineMetrics,
  _resetEmbedPipelineMetricsForTest,
} from './embed-pipeline.js';
import type { PendingEmbed } from './embed-pipeline.js';
import { WriteQueue } from './write-queue.js';
import { _setEmbedProviderForTest, embed } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';

/** Provider whose embedSingle always throws — the Phase-B failure injector. */
class FailingProvider extends DeterministicTestProvider {
  override async embedSingle(_text: string, _role?: EmbedRole): Promise<Float32Array> {
    throw new Error('injected Phase-B embed failure');
  }
}

function tmpDb(): { dir: string; dbPath: string; db: Database.Database; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-metrics-'));
  const dbPath = path.join(dir, 'm.db');
  const db = openDb(dbPath);
  return {
    dir,
    dbPath,
    db,
    cleanup: () => {
      try { if (db.open) db.close(); } catch { /* closed */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** Raw-insert a live episode WITHOUT a vec row — the "crashed Phase B" shape. */
function insertOrphanEpisode(db: Database.Database, content: string, tCreated: string): void {
  db.prepare(
    `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
     VALUES (?, 'episode', ?, ?, ?, ?)`,
  ).run(`orphan-${Math.random().toString(36).slice(2)}`, content, `hash-${Math.random()}`, tCreated, tCreated);
}

function phaseA(db: Database.Database, content: string): PhaseAOutcome {
  const r = memoryWritePhaseA(db, { content });
  expect('code' in r).toBe(false);
  return r as PhaseAOutcome;
}

let ctx: ReturnType<typeof tmpDb>;

beforeEach(() => {
  ctx = tmpDb();
  WriteQueue.clearInstances();
  WriteQueue.setBypass(false);
  _resetEmbedPipelineMetricsForTest();
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

afterEach(async () => {
  await flushPendingEmbeds();
  WriteQueue.clearInstances();
  _resetEmbedPipelineMetricsForTest();
  ctx.cleanup();
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

// ── 1. time_to_vector on the async pipeline path ─────────────────────────────

describe('time_to_vector_ms — recorded on the async path from the monotonic Phase-A stamp', () => {
  it('Phase A stamps startedAtMs; a pipeline apply records one sample bounded below by the stamp age', async () => {
    const wq = WriteQueue.forPath(ctx.dbPath);
    const a = phaseA(ctx.db, 'time to vector headline metric sample one');

    // The stamp is minted by Phase A itself (performance.now-based).
    expect(typeof a.pending!.startedAtMs).toBe('number');

    // Clock seam (no sleeps): backdate the stamp by 5s — the recorded sample
    // must be ≥ 5000ms, proving apply_time − startedAtMs is what lands.
    a.pending!.startedAtMs = performance.now() - 5000;
    const res = await schedulePendingEmbeds(wq, [a.pending!]);
    expect(res.applied).toBe(1);

    const m = getEmbedPipelineMetrics(ctx.dbPath)!;
    expect(m).not.toBeNull();
    expect(m.time_to_vector_samples).toBe(1);
    expect(m.time_to_vector_ms.p50).toBeGreaterThanOrEqual(5000);
    expect(m.time_to_vector_ms.max).toBeGreaterThanOrEqual(5000);
    // The embed computation was measured too (both fields move together).
    expect(m.embed_duration_samples).toBe(1);
    expect(m.embed_duration_ms.max).toBeGreaterThanOrEqual(0);
    expect(m.counters).toMatchObject({
      embeds_completed: 1,
      embeds_failed: 0,
      applies_applied: 1,
      applies_exists: 0,
      applies_gone: 0,
      heals_applied: 0,
      heals_failed: 0,
    });
  });

  it('a stamped pending whose apply resolves "exists" records NO time_to_vector sample', async () => {
    const wq = WriteQueue.forPath(ctx.dbPath);
    const a = phaseA(ctx.db, 'vector already landed via a racing path');

    // Land the vector first (direct apply — the heal/pipeline race shape).
    const vec = await embed(a.pending!.text);
    expect(applyEmbedding(ctx.db, a.pending!, vec).status).toBe('applied');

    const res = await schedulePendingEmbeds(wq, [a.pending!]);
    expect(res.exists).toBe(1);

    const m = getEmbedPipelineMetrics(ctx.dbPath)!;
    expect(m.time_to_vector_samples).toBe(0); // status !== 'applied' → no sample
    expect(m.counters.applies_exists).toBe(1);
    expect(m.counters.applies_applied).toBe(0);
  });
});

// ── 2. Heal path: excluded from time_to_vector, tracked as heal_lag ──────────

describe('heal path — never pollutes time_to_vector; wall-clock heal_lag_ms instead', () => {
  it('healed orphans record heals_applied + heal_lag_ms (≥ known t_created age), zero time_to_vector samples', async () => {
    const wq = WriteQueue.forPath(ctx.dbPath);
    // Crash orphan created 60s ago (wall clock) — no in-process stamp exists.
    const old = new Date(Date.now() - 60_000).toISOString();
    insertOrphanEpisode(ctx.db, 'crash orphan with unique zeppelin tokens', old);

    const heal = await healMissingVectors(ctx.db, wq);
    expect(heal.healed).toBe(1);
    expect(heal.failed).toBe(0);

    const m = getEmbedPipelineMetrics(ctx.dbPath)!;
    // The headline distribution is untouched by the heal.
    expect(m.time_to_vector_samples).toBe(0);
    // The heal is separately counted and aged (WALL-CLOCK, t_created-based).
    expect(m.counters.heals_applied).toBe(1);
    expect(m.counters.applies_applied).toBe(1); // apply outcomes span both paths
    expect(m.heal_lag_samples).toBe(1);
    expect(m.heal_lag_ms.p50).toBeGreaterThanOrEqual(60_000);
    // The heal's embed computation still feeds embed_duration.
    expect(m.embed_duration_samples).toBe(1);
    expect(m.counters.embeds_completed).toBe(1);
  });
});

// ── 3. Every counter branch ───────────────────────────────────────────────────

describe('monotonic counters — each outcome branch drives exactly its counter', () => {
  it('gone: a pending whose rowid no longer matches counts applies_gone', async () => {
    const wq = WriteQueue.forPath(ctx.dbPath);
    const bogus: PendingEmbed = {
      uid: 'no-such-uid',
      rowid: 99_999,
      text: 'whatever',
      startedAtMs: performance.now(),
    };
    const res = await schedulePendingEmbeds(wq, [bogus]);
    expect(res.gone).toBe(1);

    const m = getEmbedPipelineMetrics(ctx.dbPath)!;
    expect(m.counters.applies_gone).toBe(1);
    expect(m.time_to_vector_samples).toBe(0); // gone never records latency
  });

  it('failed: an embed failure counts embeds_failed (pipeline) / heals_failed (heal) — disjoint', async () => {
    const wq = WriteQueue.forPath(ctx.dbPath);
    _setEmbedProviderForTest(new FailingProvider());

    const a = phaseA(ctx.db, 'first doomed pipeline embed');
    const sched = await schedulePendingEmbeds(wq, [a.pending!], { logSink: () => {} });
    expect(sched.failed).toBe(1);

    const heal = await healMissingVectors(ctx.db, wq, { logSink: () => {} });
    expect(heal.failed).toBe(1); // same orphan, embed still failing

    const m = getEmbedPipelineMetrics(ctx.dbPath)!;
    expect(m.counters.embeds_failed).toBe(1); // schedulePendingEmbeds branch
    expect(m.counters.heals_failed).toBe(1); // healMissingVectors branch
    expect(m.counters.embeds_completed).toBe(0);
    expect(m.embed_duration_samples).toBe(0); // failed embeds record no duration
  });
});

// ── 4. Per-store keying + purity ──────────────────────────────────────────────

describe('per-store keying (mirrors WriteQueue.metricsForPath) + snapshot purity', () => {
  it('two stores keep independent metrics; unknown stores return null', async () => {
    const other = tmpDb();
    try {
      const wqA = WriteQueue.forPath(ctx.dbPath);
      const a = phaseA(ctx.db, 'store A episode about lighthouse optics');
      await schedulePendingEmbeds(wqA, [a.pending!]);

      // Store A has activity; store B has NONE — and stays null (honest:
      // no Phase-B activity for that store in this process).
      expect(getEmbedPipelineMetrics(ctx.dbPath)!.counters.applies_applied).toBe(1);
      expect(getEmbedPipelineMetrics(other.dbPath)).toBeNull();

      const wqB = WriteQueue.forPath(other.dbPath);
      const b = memoryWritePhaseA(other.db, { content: 'store B episode about tidal harmonics' });
      await schedulePendingEmbeds(wqB, [(b as PhaseAOutcome).pending!]);

      const mA = getEmbedPipelineMetrics(ctx.dbPath)!;
      const mB = getEmbedPipelineMetrics(other.dbPath)!;
      expect(mA.counters.applies_applied).toBe(1); // A unchanged by B's traffic
      expect(mB.counters.applies_applied).toBe(1);
    } finally {
      other.cleanup();
    }
  });

  it('getEmbedPipelineMetrics is pure — repeated snapshots are identical and mutation-safe', async () => {
    const wq = WriteQueue.forPath(ctx.dbPath);
    const a = phaseA(ctx.db, 'purity check episode content');
    await schedulePendingEmbeds(wq, [a.pending!]);

    const m1 = getEmbedPipelineMetrics(ctx.dbPath)!;
    const m2 = getEmbedPipelineMetrics(ctx.dbPath)!;
    expect(m2).toEqual(m1);

    // Mutating a snapshot never leaks back into the live state.
    m1.counters.applies_applied = 999;
    expect(getEmbedPipelineMetrics(ctx.dbPath)!.counters.applies_applied).toBe(1);

    expect(getEmbedPipelineMetrics('/nonexistent/store.db')).toBeNull();
  });
});

// ── 5. Apply tasks ride the queue as kind:'apply' ─────────────────────────────

describe('pipeline applies are apply-kind queue tasks (write_latency_ms stays honest)', () => {
  it('a pipeline apply increments apply_tasks_completed, not write_tasks_completed', async () => {
    const wq = WriteQueue.forPath(ctx.dbPath);
    // Phase A through the queue (write-kind), Phase B apply (apply-kind).
    const outcome = await wq.enqueue('memory_write', (qdb) =>
      memoryWritePhaseA(qdb, { content: 'kind separation end to end proof' }),
    );
    await schedulePendingEmbeds(wq, [(outcome as PhaseAOutcome).pending!]);

    const c = wq.getMetrics().counters;
    expect(c.write_tasks_completed).toBe(1);
    expect(c.apply_tasks_completed).toBe(1);
    expect(c.tasks_completed).toBe(2);
  });
});
