/**
 * bl401-stage-migration.spec.ts — BL-401's headline acceptance.
 *
 * BL-351 shipped `declareStages` / `withContendedStage` as a published,
 * tested interface with **no production caller anywhere in the repo**. The
 * live memory-server therefore reported:
 *
 *     "telemetry_self_check": { "stages_declared": 0, "stages": [] }
 *
 * — an instrument that exists and is wired to nothing, which is
 * indistinguishable from an instrument that is broken. This suite locks the
 * consumer migration that makes that number non-zero, and locks the two
 * properties the number is only worth anything because of:
 *
 *  1. **Wait is separated from work by measurement, not by convention.**
 *     `docs/observability/README.md` §5.3 documents that the split was already
 *     reconstructible by joining `writequeue.enqueue` to `writequeue.task.start`
 *     on `trace_id` + `label` — and records that nobody ever did it. A queued
 *     item that waits behind a slow predecessor must now report that wait
 *     directly.
 *
 *  2. **Both sibling execution paths are instrumented, not just the tested one.**
 *     The LIVE service runs the `bypass` path (the Turso adapter sets `_noop`),
 *     while most specs pin `STORE_ADAPTER=sqlite` and exercise `queued`.
 *     Instrumenting only the FIFO path would have produced a stage reading zero
 *     in production while passing every test — BL-319's exact defect, on the
 *     exact code path it was found in. Both are asserted here, each under the
 *     adapter that selects it.
 *
 * ⚠️ `wait_ms`/`work_ms` are wall-clock and accrue during system sleep
 * (BL-369). These assertions are ordinal ("the queued item waited longer than
 * the work took"), never a percentile.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { telemetrySelfCheck, _resetTelemetryForTest } from '@adhd/sox-telemetry';
import { MEMORY_CORE_STAGES } from './stages.js';
import { WriteQueue } from './write-queue.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl401-wq-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function stageNamed(stage: string): ReturnType<typeof telemetrySelfCheck>['stages'][number] | undefined {
  return telemetrySelfCheck().stages.find((s) => s.stage === stage);
}

describe('BL-401: memory-core is a real consumer of the stage substrate', () => {
  let cleanup: () => void;
  let dbPath: string;
  let priorAdapterEnv: string | undefined;

  beforeEach(async () => {
    const t = tmpDir();
    cleanup = t.cleanup;
    dbPath = path.join(t.dir, 'test.db');
    await WriteQueue.clearInstances();
    WriteQueue.setBypass(false);
    priorAdapterEnv = process.env['STORE_ADAPTER'];
    // Zero the since-process-start aggregates so counts below are this test's.
    // Declarations survive a reset by design — they are the inventory, not a
    // sample.
    _resetTelemetryForTest();
  });

  afterEach(async () => {
    await WriteQueue.clearInstances();
    cleanup();
    if (priorAdapterEnv === undefined) delete process.env['STORE_ADAPTER'];
    else process.env['STORE_ADAPTER'] = priorAdapterEnv;
  });

  it('declares a non-zero stage inventory merely by being loaded — THE BL-401 headline', () => {
    const check = telemetrySelfCheck();
    // The number that read 0 on the live production server.
    expect(check.stages_declared).toBeGreaterThan(0);
    const names = check.stages.map((s) => s.stage);
    expect(names).toContain('memory-core.write_queue');
    expect(names).toContain('memory-core.embed');
  });

  it('names every sibling code path up front, so an unwired one is a visible finding', () => {
    // BL-319 is literally "an instrument wired to one of two code paths".
    // Declaring both members of each pair is what turns the unwired sibling
    // into a machine-readable `paths_with_zero_samples` entry instead of a
    // silent zero nobody can distinguish from an idle system.
    expect(Object.keys(MEMORY_CORE_STAGES.stages.write_queue.paths.slice())).toHaveLength(2);
    expect(MEMORY_CORE_STAGES.stages.write_queue.paths).toEqual(['queued', 'bypass']);
    expect(MEMORY_CORE_STAGES.stages.embed.paths).toEqual(['write', 'heal', 'reembed']);

    const zeroPaths = telemetrySelfCheck().paths_with_zero_samples;
    expect(zeroPaths).toContain('memory-core.embed:heal');
    expect(zeroPaths).toContain('memory-core.embed:reembed');
  });

  it('measures queue WAIT separately from WORK on the FIFO path', async () => {
    process.env['STORE_ADAPTER'] = 'sqlite'; // needsWriteSerialization → real FIFO
    const queue = await WriteQueue.forPath(dbPath);

    // A slow head-of-line task, then a fast follower. The follower's WORK is
    // ~0 while its WAIT is the predecessor's duration — the distinction that
    // did not exist before this change.
    const slow = queue.enqueue('bl401-slow', async () => {
      await new Promise((res) => setTimeout(res, 120));
      return 1;
    });
    const fast = queue.enqueue('bl401-fast', () => 2);
    await Promise.all([slow, fast]);

    const stage = stageNamed('memory-core.write_queue');
    expect(stage).toBeDefined();
    expect(stage!.wait_ms.count).toBe(2);
    expect(stage!.work_ms.count).toBe(2);
    // The follower waited behind the 120 ms predecessor. Ordinal, not a
    // percentile — these are wall-clock durations (BL-369).
    expect(stage!.wait_ms.max).toBeGreaterThanOrEqual(100);
    // Nothing is left unaccounted: every start reached a finish.
    expect(stage!.unaccounted['queued']).toBe(0);
  });

  it('instruments the BYPASS path the live service actually runs', async () => {
    // The Turso adapter reports needsWriteSerialization: false, so `enqueue`
    // executes immediately instead of taking a FIFO slot. This is production's
    // path; an instrument wired only to the branch above would have read zero
    // on the live server forever.
    process.env['STORE_ADAPTER'] = 'sqlite';
    const queue = await WriteQueue.forPath(dbPath);
    WriteQueue.setBypass(true);
    try {
      await queue.enqueue('bl401-bypass', () => 'ok');
    } finally {
      WriteQueue.setBypass(false);
    }

    const stage = stageNamed('memory-core.write_queue');
    expect(stage).toBeDefined();
    expect(stage!.unaccounted['bypass']).toBe(0);
    expect(telemetrySelfCheck().paths_with_zero_samples).not.toContain('memory-core.write_queue:bypass');
  });

  it('keeps a failed task inside the accounting instead of dropping it', async () => {
    process.env['STORE_ADAPTER'] = 'sqlite';
    const queue = await WriteQueue.forPath(dbPath);
    await expect(
      queue.enqueue('bl401-boom', () => {
        throw new Error('bl401-expected');
      }),
    ).rejects.toBeDefined();

    const stage = stageNamed('memory-core.write_queue');
    // A task that was admitted and then failed still occupied the resource. If
    // errors escaped the pair, `starts − (finishes + errors)` — the highest
    // value query in docs/observability/README.md §5.2 — would report a
    // phantom hang on every genuine error.
    expect(stage!.unaccounted['queued']).toBe(0);
    expect(stage!.work_ms.count).toBe(1);
  });

  it('does not disturb FIFO ordering, the E_BUSY contract, or the returned value', async () => {
    process.env['STORE_ADAPTER'] = 'sqlite';
    const queue = await WriteQueue.forPath(dbPath);
    const order: number[] = [];
    const all: Array<Promise<number>> = [];
    for (let i = 0; i < 10; i++) {
      all.push(
        queue.enqueue(`bl401-order-${i}`, async () => {
          await new Promise((res) => setTimeout(res, Math.floor(Math.random() * 6)));
          order.push(i);
          return i;
        }),
      );
    }
    const values = await Promise.all(all);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(values).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
});
