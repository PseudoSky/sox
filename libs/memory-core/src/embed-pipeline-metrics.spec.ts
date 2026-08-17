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
 *   7. BL-319: embed_throughput_per_sec — rolling 60s throughput window.
 *   8. BL-319: heal_time_budget_exceeded — true when last heal pass hit budget.
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
import type { StoreAdapter } from '@adhd/sox-store-adapter';
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
import { vectorDialectFor } from './dialect.js';
import { _setEmbedProviderForTest, embed } from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';

/** Provider whose embedSingle always throws — the Phase-B failure injector. */
class FailingProvider extends DeterministicTestProvider {
  override async embedSingle(_text: string, _role?: EmbedRole): Promise<Float32Array> {
    throw new Error('injected Phase-B embed failure');
  }
}

interface TestContext {
  dir: string;
  dbPath: string;
  adapter: StoreAdapter;
  cleanup: () => void;
}

/**
 * Create a test database via openDb. STORE_ADAPTER is forced to 'sqlite' at
 * module scope (above) so openDb's createStoreAdapter uses SqliteAdapter
 * rather than the live server's TursoAdapter with multiprocess_wal.
 */
async function tmpDb(): Promise<TestContext> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-metrics-'));
  const dbPath = path.join(dir, 'm.db');
  const adapter = await openDb(dbPath);
  return {
    dir,
    dbPath,
    adapter,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * Raw-insert a live episode WITHOUT a vec row — the "crashed Phase B" shape.
 * Uses the StoreAdapter's executeRun to write directly.
 */
async function insertOrphanEpisode(adapter: StoreAdapter, content: string, tCreated: string): Promise<void> {
  await adapter.executeRun(
    `INSERT INTO node (uid, kind, content, content_hash, t_created, t_valid)
     VALUES (?, 'episode', ?, ?, ?, ?)`,
    [`orphan-${Math.random().toString(36).slice(2)}`, content, `hash-${Math.random()}`, tCreated, tCreated],
  );
}

async function phaseA(adapter: StoreAdapter, content: string): Promise<PhaseAOutcome> {
  const r = await memoryWritePhaseA(adapter, { content, project_path: '/test/project' });
  expect('code' in r).toBe(false);
  return r as PhaseAOutcome;
}

let ctx: TestContext;

/**
 * Force SqliteAdapter for any openDb call within this test. WriteQueue.forPath
 * calls openDb which reads process.env.STORE_ADAPTER. The live env may be
 * set to 'turso' which uses multiprocess_wal — incompatible with /tmp paths.
 * Must be set before EVERY openDb invocation because vitest's fork pool may
 * inherit the parent's env without our override.
 */
function forceSqliteAdapter(): void {
  process.env.STORE_ADAPTER = 'sqlite';
}

beforeEach(async () => {
  forceSqliteAdapter();
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
  ctx.cleanup();
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

// ── 1. time_to_vector on the async pipeline path ─────────────────────────────

describe('time_to_vector_ms — recorded on the async path from the monotonic Phase-A stamp', () => {
  it('Phase A stamps startedAtMs; a pipeline apply records one sample bounded below by the stamp age', async () => {
    const wq = await WriteQueue.forPath(ctx.dbPath);
    const a = await phaseA(ctx.adapter, 'time to vector headline metric sample one');

    // The stamp is minted by Phase A itself (performance.now-based).
    expect(typeof a.pending!.startedAtMs).toBe('number');

    // Clock seam (no sleeps): backdate the stamp by 5s — the recorded sample
    // must be ≥ 5000ms, proving apply_time − startedAtMs is what lands.
    a.pending!.startedAtMs = performance.now() - 5000;
    const res = await schedulePendingEmbeds(wq, [a.pending!], { vectorDialect: await vectorDialectFor(ctx.adapter) });
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
    // BL-319: throughput recorded on completion
    expect(m.embed_throughput_per_sec).toBeGreaterThan(0);
    expect(m.heal_time_budget_exceeded).toBe(false);
  });

  it('a stamped pending whose apply resolves "exists" records NO time_to_vector sample', async () => {
    const wq = await WriteQueue.forPath(ctx.dbPath);
    const a = await phaseA(ctx.adapter, 'vector already landed via a racing path');

    // Land the vector first (direct apply via transaction — the heal/pipeline race shape).
    const vec = await embed(a.pending!.text);
    const applyResult = await ctx.adapter.transaction(async (tx) => {
      return applyEmbedding(tx, a.pending!, vec, ctx.adapter.capabilities.nativeVectors, await vectorDialectFor(ctx.adapter));
    });
    expect(applyResult.status).toBe('applied');

    const res = await schedulePendingEmbeds(wq, [a.pending!], { vectorDialect: await vectorDialectFor(ctx.adapter) });
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
    const wq = await WriteQueue.forPath(ctx.dbPath);
    // Crash orphan created 60s ago (wall clock) — no in-process stamp exists.
    const old = new Date(Date.now() - 60_000).toISOString();
    await insertOrphanEpisode(ctx.adapter, 'crash orphan with unique zeppelin tokens', old);

    const heal = await healMissingVectors(ctx.adapter, wq, { limit: 1000 });
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
    const wq = await WriteQueue.forPath(ctx.dbPath);
    const bogus: PendingEmbed = {
      uid: 'no-such-uid',
      rowid: 99_999,
      text: 'whatever',
      startedAtMs: performance.now(),
    };
    const res = await schedulePendingEmbeds(wq, [bogus], { vectorDialect: await vectorDialectFor(ctx.adapter) });
    expect(res.gone).toBe(1);

    const m = getEmbedPipelineMetrics(ctx.dbPath)!;
    expect(m.counters.applies_gone).toBe(1);
    expect(m.time_to_vector_samples).toBe(0); // gone never records latency
  });

  it('failed: an embed failure counts embeds_failed (pipeline) / heals_failed (heal) — disjoint', async () => {
    const wq = await WriteQueue.forPath(ctx.dbPath);
    _setEmbedProviderForTest(new FailingProvider());

    const a = await phaseA(ctx.adapter, 'first doomed pipeline embed');
    const sched = await schedulePendingEmbeds(wq, [a.pending!], { logSink: () => {}, vectorDialect: await vectorDialectFor(ctx.adapter) });
    expect(sched.failed).toBe(1);

    const heal = await healMissingVectors(ctx.adapter, wq, { limit: 1000, logSink: () => {} });
    expect(heal.failed).toBe(1); // same orphan, embed still failing

    const m = getEmbedPipelineMetrics(ctx.dbPath)!;
    expect(m.counters.embeds_failed).toBe(1); // schedulePendingEmbeds branch
    expect(m.counters.heals_failed).toBe(1); // healMissingVectors branch
    expect(m.counters.embeds_completed).toBe(0);
    // BL-319: failed embeds record no duration and no throughput
    expect(m.embed_duration_samples).toBe(0); // failed embeds record no duration
    expect(m.embed_throughput_per_sec).toBe(0);
  });
});

// ── 4. Per-store keying + purity ──────────────────────────────────────────────

describe('per-store keying (mirrors WriteQueue.metricsForPath) + snapshot purity', () => {
  it('two stores keep independent metrics; unknown stores return null', async () => {
    const other = await tmpDb();
    try {
      const wqA = await WriteQueue.forPath(ctx.dbPath);
      const a = await phaseA(ctx.adapter, 'store A episode about lighthouse optics');
      await schedulePendingEmbeds(wqA, [a.pending!], { vectorDialect: await vectorDialectFor(ctx.adapter) });

      // Store A has activity; store B has NONE — and stays null (honest:
      // no Phase-B activity for that store in this process).
      expect(getEmbedPipelineMetrics(ctx.dbPath)!.counters.applies_applied).toBe(1);
      expect(getEmbedPipelineMetrics(other.dbPath)).toBeNull();

      const wqB = await WriteQueue.forPath(other.dbPath);
      const b = await memoryWritePhaseA(other.adapter, { content: 'store B episode about tidal harmonics', project_path: '/test/project' });
      await schedulePendingEmbeds(wqB, [(b as PhaseAOutcome).pending!], { vectorDialect: await vectorDialectFor(other.adapter) });

      const mA = getEmbedPipelineMetrics(ctx.dbPath)!;
      const mB = getEmbedPipelineMetrics(other.dbPath)!;
      expect(mA.counters.applies_applied).toBe(1); // A unchanged by B's traffic
      expect(mB.counters.applies_applied).toBe(1);
    } finally {
      other.cleanup();
    }
  });

  it('getEmbedPipelineMetrics is pure — repeated snapshots are identical and mutation-safe', async () => {
    const wq = await WriteQueue.forPath(ctx.dbPath);
    const a = await phaseA(ctx.adapter, 'purity check episode content');
    await schedulePendingEmbeds(wq, [a.pending!], { vectorDialect: await vectorDialectFor(ctx.adapter) });

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
    const wq = await WriteQueue.forPath(ctx.dbPath);
    // Phase A through the queue (write-kind), Phase B apply (apply-kind).
    const outcome = await wq.enqueue('memory_write', async (qdb) => {
      return memoryWritePhaseA(qdb, { content: 'kind separation end to end proof', project_path: '/test/project' });
    });
    await schedulePendingEmbeds(wq, [(outcome as PhaseAOutcome).pending!], { vectorDialect: await vectorDialectFor(ctx.adapter) });

    const c = wq.getMetrics().counters;
    expect(c.write_tasks_completed).toBe(1);
    expect(c.apply_tasks_completed).toBe(1);
    expect(c.tasks_completed).toBe(2);
  });
});

// ── 6. BL-319: embed_throughput_per_sec rolling window ────────────────────────

describe('embed_throughput_per_sec — rolling 60s window', () => {
  it('records throughput from pipeline completions', async () => {
    const wq = await WriteQueue.forPath(ctx.dbPath);
    const a = await phaseA(ctx.adapter, 'throughput sample one');
    await schedulePendingEmbeds(wq, [a.pending!], { vectorDialect: await vectorDialectFor(ctx.adapter) });

    const m = getEmbedPipelineMetrics(ctx.dbPath)!;
    expect(m.embed_throughput_per_sec).toBeGreaterThan(0);
    // With a single completion in the 60s window: 1/60 = ~0.0167
    expect(m.embed_throughput_per_sec).toBeLessThanOrEqual(1);
  });

  it('heal path also feeds the throughput metric', async () => {
    const wq = await WriteQueue.forPath(ctx.dbPath);
    await insertOrphanEpisode(ctx.adapter, 'heal throughput test item', new Date().toISOString());
    const heal = await healMissingVectors(ctx.adapter, wq, { limit: 1000 });
    expect(heal.healed).toBe(1);

    const m = getEmbedPipelineMetrics(ctx.dbPath)!;
    expect(m.embed_throughput_per_sec).toBeGreaterThan(0);
  });
});

// ── 7. BL-319: heal_time_budget_exceeded ──────────────────────────────────────

describe('heal_time_budget_exceeded — per-tick time budget', () => {
  it('defaults to false on a clean heal pass (no items or items healed fully)', async () => {
    const wq = await WriteQueue.forPath(ctx.dbPath);
    const heal = await healMissingVectors(ctx.adapter, wq, { limit: 1000 });
    expect(heal.time_budget_exceeded).toBe(false);

    const m = getEmbedPipelineMetrics(ctx.dbPath)!;
    expect(m.heal_time_budget_exceeded).toBe(false);
  });

  it('is false after a heal pass that fully heals all scanned items', async () => {
    const wq = await WriteQueue.forPath(ctx.dbPath);
    await insertOrphanEpisode(ctx.adapter, 'single budget-respecting orphan', new Date().toISOString());
    const heal = await healMissingVectors(ctx.adapter, wq, { limit: 1000 });
    expect(heal.healed).toBe(1);
    expect(heal.time_budget_exceeded).toBe(false);

    const m = getEmbedPipelineMetrics(ctx.dbPath)!;
    expect(m.heal_time_budget_exceeded).toBe(false);
  });
});
