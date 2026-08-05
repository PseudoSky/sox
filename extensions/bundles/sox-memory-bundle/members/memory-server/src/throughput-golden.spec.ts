/**
 * throughput-golden.spec.ts — Golden baseline regression test for
 * `throughput_writes_per_sec` on both SqliteAdapter and TursoAdapter.
 *
 * `throughput_writes_per_sec` is a rolling measurement exposed via
 * `WriteQueueMetrics` (`libs/memory-core/src/write-queue.ts`). It counts
 * write-task completions within a 60-second window divided by 60.
 *
 * The two adapters have fundamentally different throughput profiles:
 *
 *   **SqliteAdapter** — writes are serialized through the WriteQueue.
 *   With SOX_SYNC_EMBED=1 (sync embed inside the queue slot), throughput
 *   is bounded by embed time (~0.3–0.8/s). Conservative threshold: 0.1.
 *
 *   **TursoAdapter** — writes bypass the queue (noop). Embedded via the
 *   same sync-embed path inside the operation. Conservative threshold: 0.5.
 *
 * Each describe block uses a fresh temp DB, one env context, and the real
 * `handleToolCall` path so the test exercises the full tool surface.
 *
 * NOTE on WriteQueue singleton lifecycle: `WriteQueue.clearInstances()` is
 * called in afterAll (not afterEach) because all tests within a describe
 * block share the same dbPath and therefore the same WriteQueue — clearing
 * between tests would destroy the queue singleton and make `memory_ping`
 * return `write_queue: null` for subsequent assertions.
 */

import { WriteQueue } from '@adhd/sox-memory-core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleToolCall } from './index.js';

// ── Turso availability check (synchronous at module load time) ──────────────
// `{ skip: hasTurso }` in the describe block must be a fixed boolean at test
// definition time, not a lazily-evaluated expression. We resolve synchronously
// here by checking the known module entry path on disk.

const TURSO_DRIVER_PATH = path.resolve(
  __dirname, '../../../../../../node_modules/@tursodatabase/database/dist/promise.js',
);
let _hasTurso = false;
try {
  if (fs.existsSync(TURSO_DRIVER_PATH)) {
    _hasTurso = true;
  }
} catch {
  _hasTurso = false;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Create a fresh temp directory for a test DB. */
function makeTempDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-throughput-'));
  return {
    dir,
    cleanup: () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

/**
 * Write `count` distinct episodes via the real `handleToolCall` MCP handler.
 * Returns once all writes have completed (ToolResult resolved).
 */
async function writeEpisodes(
  dbPath: string,
  count: number,
): Promise<void> {
  for (let i = 0; i < count; i++) {
    const result = await handleToolCall('memory_write', {
      db_path: dbPath,
      content: `Throughput golden baseline episode ${i}: The efficiency of any measurement system depends critically on the stability of its calibration reference across environmental conditions.`,
      project_path: '/test/throughput-golden',
    });
    expect(result.isError).toBeFalsy();
  }
}

/**
 * Call memory_ping and extract `store.write_queue.throughput_writes_per_sec`.
 * Fails loudly if the metric is missing from the response.
 */
async function readThroughput(dbPath: string): Promise<number> {
  const result = await handleToolCall('memory_ping', { db_path: dbPath });
  expect(result.isError).toBeFalsy();

  const body = JSON.parse(
    (result.content[0] as { type: string; text: string }).text,
  ) as Record<string, unknown>;

  // The ping response may omit the store block entirely (e.g. no writes yet).
  expect(body['store']).toBeDefined();
  const store = body['store'] as Record<string, unknown>;
  expect(store['write_queue']).toBeDefined();
  const wq = store['write_queue'] as Record<string, unknown>;
  expect(wq['throughput_writes_per_sec']).toBeDefined();

  const t = wq['throughput_writes_per_sec'];
  expect(typeof t).toBe('number');
  return t as number;
}

// ── SqliteAdapter ───────────────────────────────────────────────────────────
// vitest.setup.ts already sets STORE_ADAPTER=sqlite, SOX_SYNC_EMBED=1.
// The env overrides are stable across the whole file (no restore needed).

describe('throughput_writes_per_sec — SqliteAdapter', () => {
  const tmp = makeTempDir();
  const dbPath = path.join(tmp.dir, 'test.db');

  beforeAll(async () => {
    // Write 12 episodes → throughput = 12/60 = 0.2 (meets ideal ≥ 0.2).
    // The conservative golden threshold is ≥ 0.1, which 6 writes would
    // clear (6/60 = 0.1), but we test closer to real throughput by
    // meeting the ideal threshold.
    await writeEpisodes(dbPath, 12);
  });

  afterAll(async () => {
    await WriteQueue.clearInstances();
    tmp.cleanup();
  });

  it('records non-zero throughput after writes (golden baseline ≥ 0.1)', async () => {
    const t = await readThroughput(dbPath);
    expect(
      t,
      `Expected throughput_writes_per_sec ≥ 0.1 (golden conservative) but got ${t}. ` +
      `With 12 writes in the 60s rolling window, throughput = 12/60 = 0.2. ` +
      `A value of 0 implies the WriteQueue._trackCompletion path is broken.`,
    ).toBeGreaterThanOrEqual(0.1);
  });

  it('meets ideal throughput threshold ≥ 0.2', async () => {
    const t = await readThroughput(dbPath);
    expect(
      t,
      `Expected throughput_writes_per_sec ≥ 0.2 (golden ideal) but got ${t}. ` +
      `12 writes / 60s window = 0.2. If writes took >60s total, some ` +
      `completions aged out before the ping — verify test timing.`,
    ).toBeGreaterThanOrEqual(0.2);
  });

  it('throughput is not NaN or infinite', async () => {
    const t = await readThroughput(dbPath);
    expect(Number.isFinite(t)).toBe(true);
  });

  it('write_queue contains all required metrics fields', async () => {
    const result = await handleToolCall('memory_ping', { db_path: dbPath });
    const body = JSON.parse(
      (result.content[0] as { type: string; text: string }).text,
    ) as Record<string, unknown>;
    const wq = (body['store'] as Record<string, unknown>)['write_queue'] as Record<string, unknown>;

    // Sanity-check the full metrics shape from WriteQueueMetrics
    const expectedKeys = [
      'mode', 'queue_depth', 'in_flight', 'queue_max_size', 'queue_high_watermark',
      'saturated', 'write_latency_ms', 'apply_latency_ms',
      'recent_avg_task_latency_ms', 'deadline_budget_ms',
      'deadline_guard_enabled', 'throughput_writes_per_sec', 'counters',
    ];
    for (const key of expectedKeys) {
      expect(
        wq,
        `WriteQueueMetrics should have key "${key}"`,
      ).toHaveProperty(key);
    }
    // Counters sub-object
    expect(wq['counters']).toHaveProperty('tasks_completed');
    expect(wq['counters']).toHaveProperty('write_tasks_completed');
  });

  it('adapter_type is "sqlite" in ping store block', async () => {
    const result = await handleToolCall('memory_ping', { db_path: dbPath });
    const body = JSON.parse(
      (result.content[0] as { type: string; text: string }).text,
    ) as Record<string, unknown>;
    const store = body['store'] as Record<string, unknown>;
    expect(store['adapter_type']).toBe('sqlite');
  });
});

// ── TursoAdapter ────────────────────────────────────────────────────────────
// Override to turso for this describe block. The env must be set before any
// handleToolCall that opens the DB (WriteQueue.forPath / openDb reads it).

describe('throughput_writes_per_sec — TursoAdapter', () => {
  const tmp = makeTempDir();
  const dbPath = path.join(tmp.dir, 'test.db');
  let _origStoreAdapter: string | undefined;

  beforeAll(async () => {
    if (!_hasTurso) return;

    // Save and override STORE_ADAPTER
    _origStoreAdapter = process.env['STORE_ADAPTER'];
    process.env['STORE_ADAPTER'] = 'turso';

    // Write 30 episodes → throughput = 30/60 = 0.5 (meets golden threshold).
    // Turso writes bypass the queue (noop), so they are fast — only bounded
    // by the sync embed time inside each operation.
    await writeEpisodes(dbPath, 30);
  });

  afterAll(async () => {
    // Restore STORE_ADAPTER regardless of test outcome
    if (_origStoreAdapter === undefined) {
      delete process.env['STORE_ADAPTER'];
    } else {
      process.env['STORE_ADAPTER'] = _origStoreAdapter;
    }
    await WriteQueue.clearInstances();
    tmp.cleanup();
  });

  it(
    'records non-zero throughput after writes (golden baseline ≥ 0.5)',
    { skip: !_hasTurso },
    async () => {
      const t = await readThroughput(dbPath);
      expect(
        t,
        `Expected throughput_writes_per_sec ≥ 0.5 (golden) but got ${t}. ` +
        `With 30 writes in the 60s rolling window, throughput = 30/60 = 0.5. ` +
        `A value of 0 implies the WriteQueue._trackCompletion path is broken ` +
        `for the noop/bypass path.`,
      ).toBeGreaterThanOrEqual(0.5);
    },
  );

  it(
    'throughput is not NaN or infinite',
    { skip: !_hasTurso },
    async () => {
      const t = await readThroughput(dbPath);
      expect(Number.isFinite(t)).toBe(true);
    },
  );

  it(
    'write_queue contains all required metrics fields',
    { skip: !_hasTurso },
    async () => {
      const result = await handleToolCall('memory_ping', { db_path: dbPath });
      const body = JSON.parse(
        (result.content[0] as { type: string; text: string }).text,
      ) as Record<string, unknown>;
      const wq = (body['store'] as Record<string, unknown>)['write_queue'] as Record<string, unknown>;

      const expectedKeys = [
        'mode', 'queue_depth', 'in_flight', 'queue_max_size', 'queue_high_watermark',
        'saturated', 'write_latency_ms', 'apply_latency_ms',
        'recent_avg_task_latency_ms', 'deadline_budget_ms',
        'deadline_guard_enabled', 'throughput_writes_per_sec', 'counters',
      ];
      for (const key of expectedKeys) {
        expect(wq).toHaveProperty(key);
      }
    },
  );

  it(
    'adapter_type is "turso" in ping store block',
    { skip: !_hasTurso },
    async () => {
      const result = await handleToolCall('memory_ping', { db_path: dbPath });
      const body = JSON.parse(
        (result.content[0] as { type: string; text: string }).text,
      ) as Record<string, unknown>;
      const store = body['store'] as Record<string, unknown>;
      expect(store['adapter_type']).toBe('turso');
    },
  );

  it(
    'BL-445: noop queue path reports mode=bypass and a NULL queue_depth, not a fake zero',
    { skip: !_hasTurso },
    async () => {
      const result = await handleToolCall('memory_ping', { db_path: dbPath });
      const body = JSON.parse(
        (result.content[0] as { type: string; text: string }).text,
      ) as Record<string, unknown>;
      const wq = (body['store'] as Record<string, unknown>)['write_queue'] as Record<string, unknown>;

      // This assertion used to read `queue_depth === 0`, which pinned BL-334's
      // failure mode in place: on the Turso bypass path nothing is EVER pushed
      // to `this.queue`, so that zero was not an observation of an idle queue —
      // it was a value no code could change, indistinguishable from a healthy
      // one. BL-445 replaced it with an explicit `null` plus a `mode`
      // discriminator saying why.
      expect(wq['mode']).toBe('bypass');
      expect(wq['queue_depth']).toBeNull();
      expect(wq['queue_high_watermark']).toBeNull();
      expect(wq['saturated']).toBeNull();
      // in_flight, by contrast, IS meaningful on this path — it is a real count
      // of concurrently-executing operations, and this ping is taken at rest.
      expect(wq['in_flight']).toBe(0);
      // BL-445's headline: the bypass path now records what it executes, so the
      // deadline guard's input ring is non-empty on the production backend.
      expect(wq['recent_avg_task_latency_ms']).toBeGreaterThan(0);
      expect((wq['counters'] as Record<string, number>)['tasks_completed']).toBeGreaterThan(0);
    },
  );
});
