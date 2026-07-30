/**
 * write-queue-backpressure.spec.ts — time-based admission control + write-path
 * observability (2026-07-04 saturation incident).
 *
 * WHAT IS PINNED HERE:
 *   1. Deadline admission control: when `(pending + in-flight + 1) ×
 *      recent_avg_task_latency` exceeds the deadline budget, enqueue rejects
 *      IMMEDIATELY with the CONTRACTS §B E_BUSY shape and a retry_after_ms
 *      DERIVED from the estimate (not a constant).
 *   2. Cold start admits: with zero latency samples there is no estimate, so
 *      the deadline guard never rejects (the size cap still protects).
 *   3. Kill-switch: SOX_WRITEQ_NO_DEADLINE=1 disables ONLY time-based
 *      rejection; the size cap still enforces independently.
 *   4. Committed work is never lost or duplicated by rejections.
 *   5. Saturation hysteresis logs exactly once per threshold transition.
 *   6. Slow-task detection logs once per offending task.
 *   7. getMetrics()/metricsForPath() snapshots are pure (no side effects).
 *
 * DETERMINISM (BL-161 pattern): the latency estimator is driven through the
 * `_recordLatencySample` seam — no real ONNX, no timing-sensitive sleeps for
 * the admission-control math. All depth-sensitive enqueues happen in a single
 * synchronous block (the queue's _processNext only starts on a microtask), so
 * estimated-wait values are exact, not raced.
 *
 * NEGATIVE CONTROL (NC): encoded as a SKIPPED test per the chaos-spec
 * convention — with the deadline guard disabled the identical scenario does
 * NOT reject, proving the guard is the load-bearing element.
 *
 * Gate: npx nx test memory-core --skip-nx-cache
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WriteQueue, type QueueBusyError } from './write-queue.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wq-bp-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A promise gate: the anchor task blocks until release() is called. */
function makeGate(): { gate: Promise<void>; release: () => void } {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return { gate, release };
}

/** Type-guard for the CONTRACTS §B E_BUSY shape. */
function isEBusy(err: unknown): err is QueueBusyError {
  if (!err || typeof err !== 'object') return false;
  const e = err as Record<string, unknown>;
  return (
    e.code === 'E_BUSY' &&
    e.retryable === true &&
    typeof e.retry_after_ms === 'number' &&
    (e.retry_after_ms as number) > 0
  );
}

describe('WriteQueue — time-based backpressure + observability', () => {
  let cleanup: () => void;
  let dbPath: string;
  let savedNoDeadline: string | undefined;
  let savedDeadlineMs: string | undefined;

  beforeEach(async () => {
    const t = tmpDir();
    cleanup = t.cleanup;
    dbPath = path.join(t.dir, 'test.db');
    await WriteQueue.clearInstances();
    WriteQueue.setBypass(false);
    savedNoDeadline = process.env['SOX_WRITEQ_NO_DEADLINE'];
    savedDeadlineMs = process.env['SOX_WRITEQ_DEADLINE_MS'];
    delete process.env['SOX_WRITEQ_NO_DEADLINE'];
    delete process.env['SOX_WRITEQ_DEADLINE_MS'];
  });

  afterEach(async () => {
    await WriteQueue.clearInstances();
    cleanup();
    if (savedNoDeadline === undefined) delete process.env['SOX_WRITEQ_NO_DEADLINE'];
    else process.env['SOX_WRITEQ_NO_DEADLINE'] = savedNoDeadline;
    if (savedDeadlineMs === undefined) delete process.env['SOX_WRITEQ_DEADLINE_MS'];
    else process.env['SOX_WRITEQ_DEADLINE_MS'] = savedDeadlineMs;
  });

  // ── 1. Deadline rejection with a DERIVED retry hint ─────────────────────────

  it('rejects with E_BUSY(deadline) when estimated wait exceeds the budget; retry_after_ms is derived', async () => {
    const queue = WriteQueue.forPath(dbPath);
    queue._setDeadlineBudgetForTest(20_000);
    const logs: string[] = [];
    queue._setLogSinkForTest((l) => logs.push(l));

    // Seed the estimator: recent avg task latency = 5000ms (test seam — no sleeps).
    for (let i = 0; i < 5; i++) queue._recordLatencySample(5000);

    const { gate, release } = makeGate();
    const ran: string[] = [];

    // Single synchronous block — depths are exact:
    //   anchor: slots = 0+0+1 = 1 → est  5000 ≤ 20000 → admit
    //   A:      slots = 1+1+1 = 3 → est 15000 ≤ 20000 → admit
    //   B:      slots = 2+1+1 = 4 → est 20000 ≤ 20000 → admit (boundary)
    //   C:      slots = 3+1+1 = 5 → est 25000 > 20000 → REJECT
    const anchor = queue.enqueue('anchor', async () => { await gate; ran.push('anchor'); });
    const a = queue.enqueue('A', () => { ran.push('A'); return 'A'; });
    const b = queue.enqueue('B', () => { ran.push('B'); return 'B'; });
    const c = await queue.enqueue('C', () => { ran.push('C'); return 'C'; }).then(
      (v) => ({ ok: true as const, v }),
      (err) => ({ ok: false as const, err }),
    );

    expect(c.ok).toBe(false);
    const err = (c as { ok: false; err: unknown }).err as QueueBusyError;
    expect(isEBusy(err)).toBe(true);
    expect(err.code).toBe('E_BUSY');
    expect(err.retryable).toBe(true);
    // Derived: excess (25000-20000=5000) + one task of slack (5000) = 10000 — not the 250 constant.
    expect(err.retry_after_ms).toBe(10_000);
    expect(err.details).toMatchObject({
      reason: 'deadline',
      queue_depth: 3,
      estimated_wait_ms: 25_000,
      deadline_budget_ms: 20_000,
    });

    // The rejection was logged to the (injected) stderr sink.
    const rejectLines = logs.filter((l) => l.includes('REJECT E_BUSY(deadline)'));
    expect(rejectLines).toHaveLength(1);
    expect(rejectLines[0]).toContain('est_wait_ms=25000');
    expect(rejectLines[0]).toContain('budget_ms=20000');
    expect(rejectLines[0]).toContain('retry_after_ms=10000');

    // Committed work is never lost or duplicated by the rejection.
    release();
    await expect(anchor).resolves.toBeUndefined();
    await expect(a).resolves.toBe('A');
    await expect(b).resolves.toBe('B');
    expect(ran).toEqual(['anchor', 'A', 'B']); // exactly once each; C never ran

    // Counters reflect the outcome.
    const m = queue.getMetrics();
    expect(m.counters.rejections_busy_deadline).toBe(1);
    expect(m.counters.rejections_busy_size).toBe(0);
  });

  it('retry_after_ms scales with the estimate — a different latency profile yields a different hint', async () => {
    const queue = WriteQueue.forPath(dbPath);
    queue._setDeadlineBudgetForTest(20_000);
    queue._setLogSinkForTest(() => { /* silence */ });

    // recent avg = 10000ms → anchor admits (est 10000), first pending item
    // rejects at slots=3 → est 30000, excess 10000, retry = 10000+10000 = 20000.
    for (let i = 0; i < 5; i++) queue._recordLatencySample(10_000);

    const { gate, release } = makeGate();
    const anchor = queue.enqueue('anchor', async () => { await gate; });
    const rejected = await queue.enqueue('A', () => 'A').then(
      () => null,
      (err) => err as QueueBusyError,
    );

    expect(rejected).not.toBeNull();
    expect(rejected!.retry_after_ms).toBe(20_000); // ≠ 10000 from the 5000ms profile → derived, not constant

    release();
    await anchor;
  });

  // ── 2. Cold start admits ─────────────────────────────────────────────────────

  it('cold start (zero latency samples) never deadline-rejects, even with a tiny budget', async () => {
    const queue = WriteQueue.forPath(dbPath);
    queue._setDeadlineBudgetForTest(1); // absurdly tight — but no samples → no estimate
    queue._setLogSinkForTest(() => { /* silence */ });

    const { gate, release } = makeGate();
    const anchor = queue.enqueue('anchor', async () => { await gate; });
    const results: Array<Promise<number>> = [];
    for (let i = 0; i < 10; i++) {
      results.push(queue.enqueue(`cold-${i}`, () => i));
    }

    release();
    await anchor;
    const values = await Promise.all(results); // no rejection — all admitted
    expect(values).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(queue.getMetrics().counters.rejections_busy_deadline).toBe(0);
  });

  // ── 3. Kill-switch + size cap independence ──────────────────────────────────

  it('SOX_WRITEQ_NO_DEADLINE=1 disables time-based rejection only; size cap still enforces', async () => {
    process.env['SOX_WRITEQ_NO_DEADLINE'] = '1';
    const queue = WriteQueue.forPath(dbPath, 3);
    queue._setDeadlineBudgetForTest(100);
    const logs: string[] = [];
    queue._setLogSinkForTest((l) => logs.push(l));

    // Estimator screams "over budget" — but the kill-switch admits anyway.
    for (let i = 0; i < 5; i++) queue._recordLatencySample(60_000);

    const { gate, release } = makeGate();
    const anchor = queue.enqueue('anchor', async () => { await gate; });
    const a = queue.enqueue('A', () => 'A'); // depth 2 — deadline would reject; kill-switch admits
    const b = queue.enqueue('B', () => 'B'); // depth 3 — admitted
    // depth 3 ≥ maxSize 3 → SIZE cap rejects with the pinned constant shape.
    const overflow = await queue.enqueue('C', () => 'C').then(
      () => null,
      (err) => err as QueueBusyError,
    );

    expect(overflow).not.toBeNull();
    expect(isEBusy(overflow)).toBe(true);
    expect(overflow!.retry_after_ms).toBe(250); // size-cap contract (chaos spec pin)
    expect(overflow!.details).toBeUndefined(); // size rejections carry no deadline details

    release();
    await anchor;
    await expect(a).resolves.toBe('A');
    await expect(b).resolves.toBe('B');

    const m = queue.getMetrics();
    expect(m.deadline_guard_enabled).toBe(false);
    expect(m.counters.rejections_busy_deadline).toBe(0);
    expect(m.counters.rejections_busy_size).toBe(1);
    expect(logs.filter((l) => l.includes('REJECT E_BUSY(size)'))).toHaveLength(1);
    expect(logs.filter((l) => l.includes('REJECT E_BUSY(deadline)'))).toHaveLength(0);
  });

  it('size cap enforces independently while the deadline guard is active but cold', async () => {
    const queue = WriteQueue.forPath(dbPath, 2);
    queue._setLogSinkForTest(() => { /* silence */ });

    const { gate, release } = makeGate();
    const anchor = queue.enqueue('anchor', async () => { await gate; });
    const a = queue.enqueue('A', () => 'A'); // depth 2 = maxSize
    const overflow = await queue.enqueue('B', () => 'B').then(
      () => null,
      (err) => err as QueueBusyError,
    );

    expect(overflow).not.toBeNull();
    expect(overflow!.code).toBe('E_BUSY');
    expect(overflow!.retry_after_ms).toBe(250);

    release();
    await anchor;
    await expect(a).resolves.toBe('A');
  });

  // ── 4. Rejections never lose/duplicate committed work (real DB) ─────────────

  it('deadline rejections never lose or duplicate committed writes', async () => {
    const queue = WriteQueue.forPath(dbPath);
    queue._setDeadlineBudgetForTest(20_000);
    queue._setLogSinkForTest(() => { /* silence */ });
    for (let i = 0; i < 5; i++) queue._recordLatencySample(5000);

    const { gate, release } = makeGate();
    const settled: Array<Promise<unknown>> = [];
    const rejectedSeqs: number[] = [];

    // Seed table synchronously as part of the anchor (single enqueue — keeps
    // depths exact for the flood below).
    const anchor = queue.enqueue('anchor', async (tx) => {
      await tx.exec(`CREATE TABLE IF NOT EXISTS bp_commit_test (
        seq_num INTEGER UNIQUE NOT NULL
      )`);
      await gate;
      await tx.executeRun('INSERT INTO bp_commit_test (seq_num) VALUES (?)', [0]);
    });

    // Flood: same profile as test 1 — items 1..2 admit, 3..10 deadline-reject.
    for (let seq = 1; seq <= 10; seq++) {
      const p = queue.enqueue(`item-${seq}`, async (tx) => {
        await tx.executeRun('INSERT INTO bp_commit_test (seq_num) VALUES (?)', [seq]);
        return seq;
      });
      settled.push(p.then(
        (v) => v,
        (err) => {
          expect(isEBusy(err)).toBe(true);
          rejectedSeqs.push(seq);
          return -1;
        },
      ));
    }

    release();
    await anchor;
    await Promise.all(settled);

    expect(rejectedSeqs).toEqual([3, 4, 5, 6, 7, 8, 9, 10]);

    const { openDbReadOnly } = await import('./db.js');
    const roDb = openDbReadOnly(dbPath);
    const rows = roDb
      .prepare<[], { seq_num: number }>('SELECT seq_num FROM bp_commit_test ORDER BY seq_num')
      .all();
    roDb.close();

    const committed = rows.map((r) => r.seq_num);
    // Admitted work committed exactly once; rejected work never committed.
    expect(committed).toEqual([0, 1, 2]);
  });

  // ── 5. Saturation hysteresis ─────────────────────────────────────────────────

  it('saturation warn/clear logs exactly once per transition (hysteresis)', async () => {
    // maxSize=8 → enter at ceil(0.75×8)=6, clear at floor(0.4×8)=3.
    const queue = WriteQueue.forPath(dbPath, 8);
    const logs: string[] = [];
    queue._setLogSinkForTest((l) => logs.push(l));

    const { gate, release } = makeGate();
    queue.enqueue('anchor', async () => { await gate; });
    const items: Array<Promise<number>> = [];
    for (let i = 0; i < 6; i++) {
      // depth climbs 2..7 — crosses enter threshold (6) exactly once
      items.push(queue.enqueue(`sat-${i}`, () => i));
    }

    const warnLines = logs.filter((l) => l.includes('SATURATION store='));
    expect(warnLines).toHaveLength(1);
    expect(warnLines[0]).toContain('enter_threshold=6');

    release();
    await Promise.all(items); // drain — depth falls 6→0, crossing clear (3) once

    const clearLines = logs.filter((l) => l.includes('SATURATION CLEARED'));
    expect(clearLines).toHaveLength(1);
    expect(clearLines[0]).toContain('clear_threshold=3');
    // No per-task spam: still exactly one warn line after the drain.
    expect(logs.filter((l) => l.includes('SATURATION store='))).toHaveLength(1);

    // High watermark captured the peak pending depth (anchor + 6 items = 7).
    expect(queue.getMetrics().queue_high_watermark).toBe(7);
  });

  // ── 6. Slow-task detection ───────────────────────────────────────────────────

  it('logs a slow task once when latency exceeds the floor AND 3× the rolling average', async () => {
    const queue = WriteQueue.forPath(dbPath);
    queue._setSlowTaskMinMsForTest(10); // avoid a real 1s sleep in the spec
    const logs: string[] = [];
    queue._setLogSinkForTest((l) => logs.push(l));

    // Rolling average baseline: 1ms.
    for (let i = 0; i < 5; i++) queue._recordLatencySample(1);

    // Slow task: ~50ms ≫ max(10ms floor, 3×1ms).
    await queue.enqueue('slow-one', async () => {
      await new Promise<void>((r) => setTimeout(r, 50));
      return 'slow';
    });
    // Fast task afterwards must NOT log.
    await queue.enqueue('fast-one', () => 'fast');

    const slowLines = logs.filter((l) => l.includes('SLOW task'));
    expect(slowLines).toHaveLength(1);
    expect(slowLines[0]).toContain('label=slow-one');
    expect(queue.getMetrics().counters.slow_tasks).toBe(1);
  });

  // ── 7. Metrics snapshot: shape, math, purity ────────────────────────────────

  it('getMetrics() reports rolling percentiles, counters, and budget — and is pure', async () => {
    const queue = WriteQueue.forPath(dbPath);
    queue._setDeadlineBudgetForTest(20_000);
    queue._setLogSinkForTest(() => { /* silence */ });

    for (const v of [10, 20, 30, 40, 50, 60, 70, 80, 90, 100]) {
      queue._recordLatencySample(v);
    }

    const m1 = queue.getMetrics();
    expect(m1.write_latency_ms.p50).toBe(50);
    expect(m1.write_latency_ms.p99).toBe(100);
    expect(m1.write_latency_ms.mean).toBe(55);
    expect(m1.write_latency_ms.max).toBe(100);
    expect(m1.recent_avg_task_latency_ms).toBe(55);
    expect(m1.queue_depth).toBe(0);
    expect(m1.in_flight).toBe(0);
    expect(m1.queue_max_size).toBe(100);
    expect(m1.deadline_budget_ms).toBe(20_000);
    expect(m1.deadline_guard_enabled).toBe(true);
    expect(m1.saturated).toBe(false);
    expect(m1.counters).toEqual({
      tasks_completed: 0,
      write_tasks_completed: 0,
      apply_tasks_completed: 0,
      rejections_busy_size: 0,
      rejections_busy_deadline: 0,
      slow_tasks: 0,
    });

    // Purity: a second snapshot is identical — reading changed nothing.
    const m2 = queue.getMetrics();
    expect(m2).toEqual(m1);

    // tasks_completed is monotonic and driven by real completions.
    await queue.enqueue('one', () => 1);
    expect(queue.getMetrics().counters.tasks_completed).toBe(1);
  });

  it('metricsForPath returns the snapshot for a known store and null for an unknown one', async () => {
    const queue = WriteQueue.forPath(dbPath);
    await queue.enqueue('touch', () => 'ok');

    const viaPath = WriteQueue.metricsForPath(dbPath);
    expect(viaPath).not.toBeNull();
    expect(viaPath!.counters.tasks_completed).toBe(1);

    expect(WriteQueue.metricsForPath('/nonexistent/store.db')).toBeNull();
  });

  // ── 7b. Task-kind separation (two-phase write follow-on) ────────────────────
  //
  // Phase-B applyEmbedding tasks ride the same queue as writes but must not
  // dilute write_latency_ms. REPORTING is per-kind; the ADMISSION ESTIMATOR
  // stays on the blended all-kind ring + raw depth (an apply occupies the slot
  // exactly like a write — removing it would under-estimate wait and re-open
  // the 2026-07-04 hang class).

  it('write_latency_ms reports ONLY write-kind samples; apply_latency_ms reports apply-kind; the estimator blends both', () => {
    const queue = WriteQueue.forPath(dbPath);

    // Seam-seeded distributions (BL-161 — no sleeps): 4×100ms writes, 4×5ms applies.
    for (let i = 0; i < 4; i++) queue._recordLatencySample(100, 'write');
    for (let i = 0; i < 4; i++) queue._recordLatencySample(5, 'apply');

    const m = queue.getMetrics();
    expect(m.write_latency_ms).toEqual({ p50: 100, p99: 100, mean: 100, max: 100 });
    expect(m.apply_latency_ms).toEqual({ p50: 5, p99: 5, mean: 5, max: 5 });
    // Estimator input is the BLENDED mean over all 8 samples: (400+20)/8 = 52.5.
    expect(m.recent_avg_task_latency_ms).toBe(52.5);
  });

  it('completed tasks split the counters by kind; tasks_completed keeps the all-kind semantic', async () => {
    const queue = WriteQueue.forPath(dbPath);
    queue._setLogSinkForTest(() => { /* silence */ });

    await queue.enqueue('w1', () => 1);
    await queue.enqueue('w2', () => 2); // default kind = 'write' (back-compat)
    await queue.enqueue('a1', () => 3, 'apply');

    const c = queue.getMetrics().counters;
    expect(c.tasks_completed).toBe(3);
    expect(c.write_tasks_completed).toBe(2);
    expect(c.apply_tasks_completed).toBe(1);
  });

  it('a queue full of apply-kind tasks still deadline-rejects a new WRITE — occupancy accounting is kind-blind', async () => {
    const queue = WriteQueue.forPath(dbPath);
    queue._setDeadlineBudgetForTest(20_000);
    queue._setLogSinkForTest(() => { /* silence */ });

    // Every latency sample is APPLY-kind — the write ring is EMPTY. If the
    // estimator consumed the write ring, it would be cold and admit everything.
    for (let i = 0; i < 5; i++) queue._recordLatencySample(5000, 'apply');
    expect(queue.getMetrics().write_latency_ms.p50).toBe(0); // write ring empty

    const { gate, release } = makeGate();
    // Same depth profile as test 1, but the occupants are all apply tasks:
    //   anchor(apply): slots 1 → est  5000 ≤ 20000 → admit
    //   A(apply):      slots 3 → est 15000 ≤ 20000 → admit
    //   B(apply):      slots 4 → est 20000 ≤ 20000 → admit (boundary)
    //   C(WRITE):      slots 5 → est 25000 > 20000 → REJECT
    const anchor = queue.enqueue('apply-anchor', async () => { await gate; }, 'apply');
    const a = queue.enqueue('apply-A', () => 'A', 'apply');
    const b = queue.enqueue('apply-B', () => 'B', 'apply');
    const c = await queue.enqueue('write-C', () => 'C').then(
      () => null,
      (err) => err as QueueBusyError,
    );

    expect(c).not.toBeNull();
    expect(isEBusy(c)).toBe(true);
    expect(c!.details).toMatchObject({
      reason: 'deadline',
      queue_depth: 3, // the three pending APPLY tasks count as occupancy
      estimated_wait_ms: 25_000,
      deadline_budget_ms: 20_000,
    });
    expect(queue.getMetrics().counters.rejections_busy_deadline).toBe(1);

    release();
    await anchor;
    await expect(a).resolves.toBe('A');
    await expect(b).resolves.toBe('B');
  });

  // ── 8. Env-var surface ───────────────────────────────────────────────────────

  it('SOX_WRITEQ_DEADLINE_MS overrides the default budget; invalid values fall back', async () => {
    process.env['SOX_WRITEQ_DEADLINE_MS'] = '12345';
    const q1 = WriteQueue.forPath(dbPath);
    expect(q1.deadlineBudgetMs).toBe(12_345);
    await WriteQueue.clearInstances();

    process.env['SOX_WRITEQ_DEADLINE_MS'] = 'not-a-number';
    const q2 = WriteQueue.forPath(dbPath);
    expect(q2.deadlineBudgetMs).toBe(20_000);
    await WriteQueue.clearInstances();

    delete process.env['SOX_WRITEQ_DEADLINE_MS'];
    const q3 = WriteQueue.forPath(dbPath);
    expect(q3.deadlineBudgetMs).toBe(20_000);
  });

  /**
   * NEGATIVE CONTROL — skipped in normal CI (chaos-spec convention).
   *
   * Purpose: prove the deadline guard is the load-bearing element. This runs
   * the EXACT scenario of test 1 (seeded 5000ms avg, 20s budget, anchor + 3
   * pending) but with the guard disabled via SOX_WRITEQ_NO_DEADLINE=1, and
   * asserts ZERO rejections — the caller hangs to completion instead of
   * failing fast, which is precisely the 2026-07-04 incident behaviour.
   *
   * To activate: change `it.skip` → `it` and run:
   *   npx nx test memory-core --skip-nx-cache
   * Observe: all items are admitted; test 1's E_BUSY assertion would go RED
   * under this flag.
   */
  it.skip('[NC] with the deadline guard disabled, the same scenario does NOT reject', async () => {
    process.env['SOX_WRITEQ_NO_DEADLINE'] = '1';
    const queue = WriteQueue.forPath(dbPath);
    queue._setDeadlineBudgetForTest(20_000);
    queue._setLogSinkForTest(() => { /* silence */ });
    for (let i = 0; i < 5; i++) queue._recordLatencySample(5000);

    const { gate, release } = makeGate();
    const anchor = queue.enqueue('anchor', async () => { await gate; });
    const results: Array<Promise<unknown>> = [];
    let rejections = 0;
    for (const label of ['A', 'B', 'C']) {
      results.push(queue.enqueue(label, () => label).catch(() => { rejections++; }));
    }

    release();
    await anchor;
    await Promise.all(results);

    // NC assertion: no backpressure — every caller waited to completion.
    expect(rejections).toBe(0);
    expect(queue.getMetrics().counters.rejections_busy_deadline).toBe(0);
  });
});
