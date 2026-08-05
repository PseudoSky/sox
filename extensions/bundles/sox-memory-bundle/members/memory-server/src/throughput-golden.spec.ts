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
 *
 * ── BL-425: why this file injects a deterministic embed provider ────────────
 *
 * The seeding hooks used to run 12 (Sqlite) + 30 (Turso) REAL fastembed/ONNX
 * inferences, because `vitest.setup.ts` sets only `SOX_SYNC_EMBED=1` and
 * `STORE_ADAPTER=sqlite` and injects no provider. On a machine running many
 * concurrent agent sessions, embed latency degrades severely (BL-331: 25–50x
 * from cross-process CoreML/ANE queue contention; BL-432), and the Turso
 * `beforeAll` intermittently blew its 30 s `hookTimeout` — reproduced twice,
 * both times passing in isolation and on re-run of identical code.
 *
 * ⛔ Raising `hookTimeout` DOES NOT fix this, and BL-425's original fix sketch
 * (since corrected) said to do exactly that. The assertion under test is
 * `throughput ≥ 0.5`, i.e. `30 writes ÷ THROUGHPUT_WINDOW_MS`, and that window
 * is a FIXED 60 000 ms rolling window (`libs/memory-core/src/write-queue.ts`
 * `THROUGHPUT_WINDOW_MS`, pruned in `getMetrics()`). A hook permitted to run
 * past 60 s ages its own earliest completions out of the window before the
 * ping reads it: the hook goes green and the assertion goes red. The hook
 * budget and the measurement window are ONE coupled budget, so the only sound
 * fix is to make the seeding fast and load-independent.
 *
 * Fix: inject `DeterministicTestProvider` via the BL-161 `_setEmbedProviderForTest`
 * seam (same mechanism as `permission-guard.spec.ts`, `async-embed.spec.ts`,
 * `libs/memory-core/src/recall-live-incident.spec.ts`). Embeds become ~0 ms, so
 * both budgets stop depending on machine load. Scoped to THIS file and restored
 * in the root `afterAll` — other specs in this bundle legitimately exercise the
 * real provider.
 *
 * Measured on an IDLE machine, 2026-08-05 (seed wall-time, this file):
 *
 *              12-write (Sqlite)   30-write (Turso)   whole file
 *   before        4 808 ms            9 900 ms          14.54 s
 *   after            65 ms              345 ms           0.45 s
 *
 * The 9 900 ms figure is the whole of BL-425: idle, the flaking hook already
 * consumed a THIRD of its 30 s budget, so a mere 3x degradation blows it — and
 * BL-331 measured 25–50x. At 6x it crosses 60 s, where no hookTimeout can help
 * because the window itself has moved on. After injection the same hook has 87x
 * margin to the budget and 174x to the window.
 *
 * The sample sizes (12 / 30) and the thresholds (≥ 0.1 / ≥ 0.2 / ≥ 0.5) are
 * UNCHANGED: they are the only thing this file measures about
 * `WriteQueue._trackCompletion`, and shrinking or lowering either would delete
 * the test while leaving it green. Each block additionally asserts its own hook
 * wall-time against `SEED_BUDGET_MS`, so a future regression that re-introduces
 * slow embeds fails on a CLEAR budget assertion naming BL-425 rather than on an
 * opaque `Hook timed out in 30000ms`.
 */

import { DeterministicTestProvider, WriteQueue, _setEmbedProviderForTest } from '@adhd/sox-memory-core';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { handleToolCall } from './index.js';

/**
 * BL-425 seeding budget. Must stay strictly below `THROUGHPUT_WINDOW_MS`
 * (60 000 ms) — a seed phase that outlives the window ages its own earliest
 * completions out before the ping reads them, which is the trap that makes
 * "just raise the timeout" unsound. 30 s of headroom over a deterministic-embed
 * seed that measures ~1 s is generous; if it is ever exceeded, embeds are real
 * again (or something else regressed), and that is worth failing loudly on.
 */
const SEED_BUDGET_MS = 30_000;

/**
 * BL-425: explicit per-hook timeout for the two seeding hooks, deliberately
 * chosen as `SEED_BUDGET_MS` < `SEED_HOOK_TIMEOUT_MS` < `THROUGHPUT_WINDOW_MS`.
 *
 *   30 000  budget  — clear, named failure with a diagnostic message
 *   45 000  timeout — the opaque `Hook timed out` floor
 *   60 000  window  — the point at which completions age out and the throughput
 *                     assertion silently reds
 *
 * At the project default (`hookTimeout: 30_000`, `vitest.config.ts`) the budget
 * assertion would be unreachable — the hook would die of an opaque timeout at
 * exactly the instant the budget was breached, which is the failure mode BL-425
 * is about. Raising it to 45 s makes the budget assertion the thing that fires,
 * WITHOUT crossing 60 s, so the "raise the timeout" trap stays structurally
 * unreachable: a hook can never run long enough to age out its own completions.
 * Do not raise this to or past 60 000.
 */
const SEED_HOOK_TIMEOUT_MS = 45_000;

// BL-425: deterministic, ~0 ms embeds for THIS FILE ONLY. Restored below.
beforeAll(() => {
  _setEmbedProviderForTest(new DeterministicTestProvider());
});

afterAll(() => {
  _setEmbedProviderForTest(null);
});

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
  let seedMs = Number.NaN;

  beforeAll(async () => {
    // Write 12 episodes → throughput = 12/60 = 0.2 (meets ideal ≥ 0.2).
    // The conservative golden threshold is ≥ 0.1, which 6 writes would
    // clear (6/60 = 0.1), but we test closer to real throughput by
    // meeting the ideal threshold.
    const t0 = performance.now();
    await writeEpisodes(dbPath, 12);
    seedMs = performance.now() - t0;
  }, SEED_HOOK_TIMEOUT_MS);

  afterAll(async () => {
    await WriteQueue.clearInstances();
    tmp.cleanup();
  });

  it(`BL-425: seeding 12 writes stays inside the ${SEED_BUDGET_MS}ms budget`, () => {
    expect(
      seedMs,
      `BL-425: the 12-write seed took ${seedMs.toFixed(0)}ms, over the ` +
      `${SEED_BUDGET_MS}ms budget. This budget is NOT a timeout to be raised: ` +
      `throughput is measured over a FIXED 60000ms rolling window ` +
      `(WriteQueue.THROUGHPUT_WINDOW_MS), so a seed that runs long ages its own ` +
      `earliest completions out of the window and reds the throughput assertion ` +
      `below. The fix is to make embeds fast again — confirm this file's ` +
      `_setEmbedProviderForTest(new DeterministicTestProvider()) injection is ` +
      `still in force and has not been overridden by a later hook.`,
    ).toBeLessThan(SEED_BUDGET_MS);
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
      'mode', 'admission_control', 'queue_depth', 'in_flight', 'queue_max_size', 'queue_high_watermark',
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

    // BL-394: on the SQLITE backend both admission guards genuinely apply, so
    // the surface reports them active WITH their real configured values. This
    // is the other half of the pair — the Turso block below must report the
    // opposite, and before the fix both reported identically.
    expect(wq['mode']).toBe('fifo');
    expect(wq['admission_control']).toBe('active');
    expect(wq['deadline_guard_enabled']).toBe(true);
    expect(wq['queue_max_size']).toBe(100);
    expect(wq['deadline_budget_ms']).toBe(20_000);
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
  let seedMs = Number.NaN;

  beforeAll(async () => {
    if (!_hasTurso) return;

    // Save and override STORE_ADAPTER
    _origStoreAdapter = process.env['STORE_ADAPTER'];
    process.env['STORE_ADAPTER'] = 'turso';

    // Write 30 episodes → throughput = 30/60 = 0.5 (meets golden threshold).
    // Turso writes bypass the queue (noop), so they are fast — only bounded
    // by the sync embed time inside each operation. BL-425: that embed is the
    // deterministic provider injected at the top of this file, so this hook is
    // load-independent; it used to run 30 real ONNX inferences and blow the
    // 30 s hookTimeout under concurrent-agent contention.
    const t0 = performance.now();
    await writeEpisodes(dbPath, 30);
    seedMs = performance.now() - t0;
  }, SEED_HOOK_TIMEOUT_MS);

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
    `BL-425: seeding 30 writes stays inside the ${SEED_BUDGET_MS}ms budget`,
    { skip: !_hasTurso },
    () => {
      expect(
        seedMs,
        `BL-425: the 30-write seed took ${seedMs.toFixed(0)}ms, over the ` +
        `${SEED_BUDGET_MS}ms budget. This is THE hook that flaked (twice ` +
        `reproduced: "Hook timed out in 30000ms"), and the budget is NOT a ` +
        `timeout to be raised: throughput is measured over a FIXED 60000ms ` +
        `rolling window (WriteQueue.THROUGHPUT_WINDOW_MS), so a seed permitted ` +
        `to run past 60s ages its own earliest completions out of the window — ` +
        `the hook would go green and the ≥0.5 assertion below would go red. ` +
        `Confirm this file's _setEmbedProviderForTest(new DeterministicTestProvider()) ` +
        `injection is still in force; if embeds are real again, that is the bug.`,
      ).toBeLessThan(SEED_BUDGET_MS);
    },
  );

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
        'mode', 'admission_control', 'queue_depth', 'in_flight', 'queue_max_size', 'queue_high_watermark',
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
      // BL-394, through the real memory_ping surface the item quotes: on the
      // PRODUCTION backend neither admission guard can fire, so the block must
      // not print `"deadline_guard_enabled": true, "queue_max_size": 100,
      // "deadline_budget_ms": 20000` — the exact JSON BL-394 filed as the
      // defect. The sqlite block above asserts the mirror image; before the fix
      // the two were indistinguishable.
      expect(wq['admission_control']).toBe('inactive — adapter handles concurrency natively');
      expect(wq['deadline_guard_enabled']).toBe(false);
      expect(wq['queue_max_size']).toBeNull();
      expect(wq['deadline_budget_ms']).toBeNull();
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
