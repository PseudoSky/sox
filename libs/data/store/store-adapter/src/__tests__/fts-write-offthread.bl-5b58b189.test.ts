/**
 * BL-5b58b189 — an FTS-backed write must NOT block the Node main thread.
 *
 * The defect (filed 2026-09-25): every FTS write blocked the Node event loop.
 * The native `@tursodatabase/database` driver ran its FTS index maintenance
 * (`stepSync`) synchronously on whatever thread issued the write; with the
 * adapter driving the driver in-thread, that was the Node main thread. In
 * production this surfaced as `RunMicrotasks` CPU saturation — no request
 * could be handled while an FTS write was in flight (measured at the filing
 * time at ~100 ms PER WRITE, even with a single post-optimize index segment).
 *
 * The fix (plan `862129b5`, packet **TUR-D**, commit `fdd2e61b`) rewired the
 * adapter onto the process-wide off-thread driver host (`turso-driver-host.ts`,
 * TUR-C). The native driver — and therefore its `stepSync` FTS maintenance —
 * now runs on a `worker_threads.Worker`, so the main thread is free to turn
 * while a write is in flight.
 *
 * ── What this file pins, and how it was re-measured on 0.8.1 ────────────────
 *
 * The binary invariant: `WRITES` FTS writes through a REAL `TursoAdapterImpl`
 * while a main-thread heartbeat runs at a 10 ms period must leave the main
 * thread turning — the longest between-tick gap must stay below
 * `MAX_ADAPTER_DELAY_MS`. Before TUR-D the adapter opened the native driver
 * in-thread, so the loop starved the timer queue; with the rewiring it passes.
 *
 * The ORIGINAL form also asserted an ABSOLUTE tick floor (≥200 ticks) and a
 * NEGATIVE CONTROL that ran the SAME loop through a direct in-thread
 * `connect()` and required it to starve (≤2 ticks). BOTH were re-baselined off
 * with the 0.8.1 driver bump, and NOT as a migration-signal label — the two
 * premises themselves changed:
 *   1. 0.8.1 writes the same corpus in ~778 ms (vs ~2395 ms on 0.7.1), so a
 *      never-blocked loop only ticks ~77× and can no longer reach a 200-tick
 *      floor derived from the 0.7.1 write duration. An absolute tick count is
 *      duration-sensitive, not blocking-sensitive — it is retired.
 *   2. The control's premise — "the direct in-thread driver starves the
 *      loop" — is FALSIFIED: 0.8.1's driver no longer runs its FTS
 *      maintenance in a way that blocks the main thread for the whole loop
 *      (measured 33–35 ticks, longest gap 44 ms). The in-thread control no
 *      longer blocks, so it can no longer serve as a discriminator.
 *
 * The redesigned form keeps the duration-INVARIANT, blocking-sensitive signal
 * (longest heartbeat gap against a declared budget) and replaces the falsified
 * control with a SIMULATED synchronous main-thread block: a target that blocks
 * the thread for `BLOCK_MS` (> budget) and MUST be detected. Together the
 * positive arm (writes don't block: gap < budget) and the discriminator (a
 * block IS detected: gap ≥ budget) prove the measure still discriminates in
 * both directions.
 *
 * ── Why the gap is measured from the heartbeat, not `monitorEventLoopDelay` ──
 *
 * On the Node that runs this suite (v24) `monitorEventLoopDelay` does NOT
 * report a starved main thread: measured directly, a synchronous block leaves
 * `histogram.max` at ~5.7 ms, because the implementation re-baselines after a
 * long stall instead of recording it. The heartbeat's own inter-fire gap DOES
 * record it (a blocked loop yields exactly one post-block fire carrying the
 * whole stall), so the gap signal is taken from the heartbeat.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TursoAdapterImpl } from '../turso-adapter.js';

const require = createRequire(import.meta.url);
const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch (err) {
    process.stderr.write(`[bl-5b58b189 test] turso driver unavailable: ${String(err)}\n`);
    return false;
  }
})();
/** Both cases need the real native driver; skip cleanly (never silently pass) when absent. */
const itTurso = hasTurso ? it : it.skip;

/** Writes in the FTS loop. Fixed by the packet; on 0.8.1 ~778 ms of work. */
const WRITES = 300;
/** Main-thread heartbeat period. Fixed by the packet. */
const TICK_MS = 10;
/**
 * Longest main-thread stall an off-thread FTS write loop may cause, in ms —
 * the bound at which a stall means "a write blocked the loop" rather than "the
 * OS did not run this process". A duration-INVARIANT, blocking-sensitive
 * budget: it does not depend on how long the writes take (0.8.1's ~778 ms vs
 * 0.7.1's ~2395 ms), only on whether any single stall crosses it.
 *
 * 250 ms is the smallest bound that clears the shared checkout's ambient
 * main-thread jitter (the acceptance run measured a 57 ms scheduler
 * deschedule with 1114 ticks) with real margin while staying far below the
 * blocking signature: a genuine block is at least the simulated discriminator's
 * `BLOCK_MS` (400 ms), so a real block is 1.6×+ this bound.
 */
const MAX_ADAPTER_DELAY_MS = 250;
/**
 * Synchronous main-thread block the discriminator arm imposes, in ms —
 * deliberately > `MAX_ADAPTER_DELAY_MS` so a blocked loop MUST trip the gap
 * bound. `Atomics.wait` sleeps the thread without yielding to the event loop
 * (no CPU burn), exactly reproducing the symptom of a synchronous in-thread
 * driver.
 */
const BLOCK_MS = 400;

/** One row body per write — several searchable tokens, a realistic FTS payload. */
function rowContent(i: number): string {
  return `doc ${i} alpha beta gamma delta epsilon`;
}

/** Minimal write surface both the adapter and the raw driver expose here. */
interface LoopTarget {
  run(sql: string, args: unknown[]): Promise<unknown>;
}

interface LoopMeasurement {
  ticks: number;
  /**
   * Longest wall-clock gap between consecutive heartbeat firings, in ms. A
   * blocked loop cannot fire during the block, so its single post-block fire
   * carries the whole stall — the signal `monitorEventLoopDelay` misses (see
   * the module doc).
   */
  maxTickGapMs: number;
  durationMs: number;
}

/**
 * Run `WRITES` FTS INSERTs through `target` while a 10 ms heartbeat counts main-
 * thread turns and records the longest between-fire gap.
 *
 * After the loop the heartbeat is allowed ONE more turn before it is cleared,
 * so a loop that fully starved the main thread still surfaces its stall as a
 * single large gap (instead of a silent zero).
 */
async function measureWriteLoop(target: LoopTarget): Promise<LoopMeasurement> {
  let ticks = 0;
  let maxTickGapMs = 0;
  let lastFireAt = Date.now();
  const ticker = setInterval(() => {
    const now = Date.now();
    const gap = now - lastFireAt;
    if (gap > maxTickGapMs) maxTickGapMs = gap;
    lastFireAt = now;
    ticks += 1;
  }, TICK_MS);

  let durationMs = 0;
  const started = Date.now();
  try {
    for (let i = 0; i < WRITES; i++) {
      await target.run('INSERT INTO node (content) VALUES (?)', [rowContent(i)]);
    }
  } finally {
    durationMs = Date.now() - started;
    // One scheduling turn so an overdue (starved) heartbeat fires once and
    // records the stall in `maxTickGapMs`, THEN stop it.
    await new Promise((resolve) => setTimeout(resolve, TICK_MS));
    clearInterval(ticker);
  }

  return { ticks, maxTickGapMs, durationMs };
}

function report(label: string, m: LoopMeasurement): void {
  process.stderr.write(
    `[bl-5b58b189] ${label}: ticks=${m.ticks} maxTickGap=${m.maxTickGapMs}ms duration=${m.durationMs}ms\n`,
  );
}

let tmpDir: string;
beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'bl-5b58b189-'));
});
afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function tempDb(label: string): string {
  return join(tmpDir, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}

/** Turso DDL for the FTS table — the exact form `fts-dialect.ts` emits. */
const CREATE_TABLE = 'CREATE TABLE node (id INTEGER PRIMARY KEY, content TEXT)';

describe('BL-5b58b189 — an FTS write does not block the Node main thread', () => {
  itTurso(
    'runs 300 FTS writes through the adapter while the main thread never stalls past the blocking budget',
    async () => {
      const dbPath = tempDb('offthread');
      const adapter = await TursoAdapterImpl.connect({ dbPath });
      try {
        // Seed a REAL FTS-indexed table (the Turso FTS path, materialisation
        // verified by ensureFtsIndex per BL-507) and prove search works before
        // measuring — an unindexed table would make the "FTS write" claim a lie.
        await adapter.exec(CREATE_TABLE);
        const ensured = await adapter.ensureFtsIndex('node', ['content']);
        expect(ensured.ensured).toBe(true);
        await adapter.executeRun('INSERT INTO node (content) VALUES (?)', ['warmup alpha beta gamma']);
        const seeded = await adapter.ftsSearch<{ id: number }>('node', ['content'], 'alpha');
        expect(seeded.length).toBeGreaterThan(0);

        const m = await measureWriteLoop({
          run: (sql, args) => adapter.executeRun(sql, args),
        });
        report('adapter (off-thread host)', m);

        // The binary invariants, re-measured on 0.8.1: the main thread TURNED
        // (at least once — no absolute tick floor, which was duration-sensitive),
        // and it never stalled past the blocking budget. The gap bound is the
        // real invariant; reporting the measured numbers means a failure carries
        // its own margin.
        expect(
          m.ticks,
          `main thread never ticked over ${m.durationMs}ms of FTS writes`,
        ).toBeGreaterThan(0);
        expect(
          m.maxTickGapMs,
          `longest main-thread stall was ${m.maxTickGapMs}ms (bound ${MAX_ADAPTER_DELAY_MS}ms)`,
        ).toBeLessThan(MAX_ADAPTER_DELAY_MS);

        // Durability sanity: every write (and the warmup) landed, so the loop
        // genuinely exercised the FTS write path rather than erroring early.
        const count = await adapter.executeGet<{ n: number }>('SELECT COUNT(*) AS n FROM node');
        expect(count?.n).toBe(WRITES + 1);
      } finally {
        await adapter.close();
      }
    },
    60_000,
  );

  itTurso(
    'discriminator — a simulated synchronous main-thread block is detected by the heartbeat-gap measure',
    async () => {
      // A target whose first `run` blocks the main thread synchronously for
      // BLOCK_MS, reproducing the symptom of a synchronous in-thread driver
      // (pre-TUR-D). It never touches a real store — it exists solely to prove
      // the heartbeat-gap measure still DETECTS a blocked loop, so the positive
      // arm's <budget assertion is not vacuous.
      let blocked = false;
      const target: LoopTarget = {
        run: async () => {
          if (!blocked) {
            blocked = true;
            // `Atomics.wait` sleeps the thread without yielding to the event
            // loop and without burning CPU — the heartbeat cannot fire during
            // it, exactly like a synchronous native call.
            const sab = new SharedArrayBuffer(4);
            Atomics.wait(new Int32Array(sab), 0, 0, BLOCK_MS);
          }
        },
      };

      const m = await measureWriteLoop(target);
      report('simulated block (discriminator)', m);

      // The measure MUST detect the block: the longest between-tick gap
      // reaches the block size, far above the budget. If this failed, the
      // positive arm would be measuring nothing.
      expect(
        m.maxTickGapMs,
        `simulated ${BLOCK_MS}ms block produced a longest gap of only ${m.maxTickGapMs}ms — ` +
          `the measure failed to detect a blocking write`,
      ).toBeGreaterThanOrEqual(MAX_ADAPTER_DELAY_MS);
    },
    60_000,
  );
});
