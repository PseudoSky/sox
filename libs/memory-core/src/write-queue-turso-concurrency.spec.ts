/**
 * write-queue-turso-concurrency.spec.ts — BL-321: concurrent writes against a
 * Turso-backed store, exercised through the real WriteQueue.enqueue() path.
 *
 * `TursoAdapterImpl.connect()` sets `needsWriteSerialization: false`
 * (Turso default — deliberately unchanged, per store-owner directive: never
 * revert a Turso default or multiprocess-writer concurrency improvement).
 * `WriteQueue._create()` reads that flag and sets `queue._noop = true`, so
 * `enqueue()` bypasses the FIFO queue entirely and runs directly against the
 * adapter — this is intended behavior, not a bug, and this spec asserts it
 * STAYS that way.
 *
 * The actual concurrency hazard lives one level down, inside
 * `TursoAdapterImpl.transaction()`: N concurrent transactional writes on one
 * shared connection handle can contend for the same logical transaction slot
 * and throw `Transaction error: cannot start a transaction within a
 * transaction` once a transaction is held open longer than the adapter's
 * retry budget (~70ms) can absorb. That is a robustness/availability
 * failure, not silent data loss — verified against the real driver directly
 * (see `turso-concurrent-writes.test.ts` in store-adapter) and independently
 * by the team. The fix is `TursoAdapterImpl`'s own `_withTxLock` mutex, which
 * this spec exercises transitively through `WriteQueue.enqueue()` to prove
 * the fix holds end-to-end through the real production call path, not just
 * against the bare adapter.
 *
 * Forces STORE_ADAPTER=turso (real @tursodatabase/database, not the mock).
 * Skipped automatically if @tursodatabase/database is not installed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WriteQueue } from './write-queue.js';
import type { StorageError } from './errors.js';
import type { StoreAdapter } from '@adhd/sox-store-adapter';

const hasTurso = (() => {
  try {
    require.resolve('@tursodatabase/database');
    return true;
  } catch {
    return false;
  }
})();

const tursoDescribe = hasTurso ? describe : describe.skip;

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wq-turso-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/**
 * Force the real TursoAdapter for any openDb call within this test.
 * WriteQueue.forPath → openDb reads process.env.STORE_ADAPTER at call time;
 * must be set before every invocation since vitest's fork pool may not
 * inherit a mutation made in a different test file's process.
 */
function forceTursoAdapter(): void {
  process.env.STORE_ADAPTER = 'turso';
}

/** Same jitter used in store-adapter's turso-concurrent-writes.test.ts —
 *  widens the interleaving window past the retry budget so contention
 *  reproduces deterministically instead of coincidentally avoiding it. */
function jitter(maxMs = 8): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.random() * maxMs));
}

let priorAdapterEnv: string | undefined;

describe('WriteQueue — Turso concurrent transactional writes (BL-321)', () => {
  let cleanup: () => void;
  let dbPath: string;

  beforeEach(async () => {
    priorAdapterEnv = process.env.STORE_ADAPTER;
    forceTursoAdapter();
    const t = tmpDir();
    cleanup = t.cleanup;
    dbPath = path.join(t.dir, 'test.db');
    await WriteQueue.clearInstances();
    WriteQueue.setBypass(false);
  });

  afterEach(async () => {
    await WriteQueue.clearInstances();
    cleanup();
    if (priorAdapterEnv === undefined) delete process.env.STORE_ADAPTER;
    else process.env.STORE_ADAPTER = priorAdapterEnv;
  });

  tursoDescribe('real TursoAdapter via openDb', () => {
    it('WriteQueue bypass (_noop) stays true for Turso — the queue-level default is unchanged', async () => {
      const queue = await WriteQueue.forPath(dbPath);
      // Deliberately unchanged: Turso writes still skip WriteQueue's FIFO.
      // The fix for BL-321 lives entirely inside TursoAdapterImpl's own
      // transaction() mutex, not here.
      expect((queue as unknown as { _noop: boolean })._noop).toBe(true);
    });

    it('durably commits N concurrent WriteQueue.enqueue transactional writes, with zero rejections', async () => {
      const queue = await WriteQueue.forPath(dbPath);
      const adapter = (queue as unknown as { adapter: StoreAdapter }).adapter;
      await adapter.exec('CREATE TABLE IF NOT EXISTS wq_t (id INTEGER PRIMARY KEY, val TEXT)');

      const N = 20;

      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          queue.enqueue(`wq-op-${i}`, async (a) => {
            return a.transaction(async (tx) => {
              await jitter();
              await tx.executeRun('INSERT INTO wq_t (id, val) VALUES (?, ?)', [i, `v${i}`]);
              await jitter();
              return i;
            });
          }),
        ),
      );

      expect(results.sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i));

      const count = await adapter.executeGet<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM wq_t');
      expect(count!.cnt).toBe(N);

      for (let i = 0; i < N; i++) {
        const row = await adapter.executeGet<{ val: string }>('SELECT val FROM wq_t WHERE id = ?', [i]);
        expect(row, `expected id=${i} to be durably committed`).not.toBeNull();
        expect(row!.val).toBe(`v${i}`);
      }
    });
  });

  // ── BL-445 ────────────────────────────────────────────────────────────────
  //
  // The bypass path (`_runBypass`) executes the operation and returns without
  // touching ANY of the state `getMetrics()` reads except `_completionTimes`.
  // Result on the production backend: 8 of 12 top-level fields are structurally
  // unreachable zeros. The one that matters is `recent_avg_task_latency_ms` —
  // it is the deadline guard's ONLY input (`_latencies.recentMean(...)`, gated
  // by `if (avgMs > 0)`), so an empty ring keeps that guard permanently
  // disabled no matter where the guard itself sits (this is why BL-394's
  // "hoist the two checks" sketch is a no-op).
  //
  // These specs are about what the bypass path RECORDS. Nothing here changes
  // which path executes a write: `_noop` stays true, serialization stays off.
  tursoDescribe('BL-445 — the bypass path must record the work it does', () => {
    async function seedTable(queue: WriteQueue): Promise<StoreAdapter> {
      const adapter = (queue as unknown as { adapter: StoreAdapter }).adapter;
      await adapter.exec('CREATE TABLE IF NOT EXISTS wq_t (id INTEGER PRIMARY KEY, val TEXT)');
      return adapter;
    }

    it('BL-445: after N bypass writes, tasks_completed === N and the deadline guard\'s latency ring is fed', async () => {
      const queue = await WriteQueue.forPath(dbPath);
      expect((queue as unknown as { _noop: boolean })._noop).toBe(true);
      await seedTable(queue);

      const N = 5;
      for (let i = 0; i < N; i++) {
        await queue.enqueue(`bl445-${i}`, async (a) => {
          await a.executeRun('INSERT INTO wq_t (id, val) VALUES (?, ?)', [i, `v${i}`]);
        });
      }

      const m = queue.getMetrics();
      expect(m.counters.tasks_completed, 'completions on the bypass path are counted').toBe(N);
      expect(m.counters.write_tasks_completed).toBe(N);
      expect(m.counters.apply_tasks_completed).toBe(0);
      // THE assertion that pins this to BL-394: the guard's input.
      expect(
        m.recent_avg_task_latency_ms,
        'the admission estimator ring must be fed on the path production takes',
      ).toBeGreaterThan(0);
      expect(m.write_latency_ms.max).toBeGreaterThan(0);
      expect(m.write_latency_ms.p50).toBeGreaterThan(0);
    });

    it('BL-445: apply-kind bypass tasks are segregated exactly as on the FIFO path', async () => {
      const queue = await WriteQueue.forPath(dbPath);
      await seedTable(queue);

      await queue.enqueue('bl445-w', async (a) => {
        await a.executeRun('INSERT INTO wq_t (id, val) VALUES (?, ?)', [1, 'w']);
      });
      await queue.enqueue('bl445-a', async (a) => {
        await a.executeRun('INSERT INTO wq_t (id, val) VALUES (?, ?)', [2, 'a']);
      }, 'apply');

      const m = queue.getMetrics();
      expect(m.counters.tasks_completed).toBe(2);
      expect(m.counters.write_tasks_completed).toBe(1);
      expect(m.counters.apply_tasks_completed).toBe(1);
      expect(m.apply_latency_ms.max).toBeGreaterThan(0);
    });

    it('BL-445: a FAILED bypass task still records its service time (matches _processNext)', async () => {
      const queue = await WriteQueue.forPath(dbPath);
      await seedTable(queue);

      // (BUG-MEMORY-001 §2.3.1) Post-fix, EVERY bypass-path rejection is a
      // StorageError object (not a raw Error instance) — the direct, intended
      // consequence of closing defect (A). A synthetic `Error('boom')` is not
      // driver-shaped, so `wrapDbError` hits its generic fallback tier:
      // `{code:'E_IO', retryable:false}` — not retryable, so this fails on the
      // FIRST attempt with no retry delay.
      const settled = await queue
        .enqueue('bl445-boom', async () => {
          await new Promise((r) => setTimeout(r, 2));
          throw new Error('boom');
        })
        .then(
          (v) => ({ ok: true as const, value: v }),
          (err) => ({ ok: false as const, error: err as StorageError }),
        );

      expect(settled.ok).toBe(false);
      if (settled.ok) throw new Error('expected the boom task to reject');
      expect(settled.error.code).toBe('E_IO');
      expect(settled.error.message).toBe('boom');
      expect(settled.error.retryable).toBe(false);

      const m = queue.getMetrics();
      // _processNext:1066-1068 counts failed tasks deliberately — "they occupied
      // the slot, so their duration is service time for the wait estimator
      // either way". The bypass path must not silently under-count exactly when
      // the store is unhealthy.
      expect(m.counters.tasks_completed, 'a failed bypass task occupied service time').toBe(1);
      expect(m.recent_avg_task_latency_ms).toBeGreaterThan(0);
    });

    it('BL-445: a SYNCHRONOUSLY-thrown bypass task also records its service time', async () => {
      const queue = await WriteQueue.forPath(dbPath);
      await seedTable(queue);

      // (BUG-MEMORY-001 §2.3.1) Same wrapped-shape assertion as the async-boom
      // test above, for the sync-throw call site.
      const settled = await queue
        .enqueue('bl445-sync-boom', () => {
          throw new Error('sync boom');
        })
        .then(
          (v) => ({ ok: true as const, value: v }),
          (err) => ({ ok: false as const, error: err as StorageError }),
        );

      expect(settled.ok).toBe(false);
      if (settled.ok) throw new Error('expected the sync-boom task to reject');
      expect(settled.error.code).toBe('E_IO');
      expect(settled.error.message).toBe('sync boom');
      expect(settled.error.retryable).toBe(false);

      expect(queue.getMetrics().counters.tasks_completed).toBe(1);
    });

    it('BL-445: queue-shaped fields report null on bypass — "no queue" is not "empty queue"', async () => {
      const queue = await WriteQueue.forPath(dbPath);
      await seedTable(queue);
      await queue.enqueue('bl445-touch', async (a) => {
        await a.executeRun('INSERT INTO wq_t (id, val) VALUES (?, ?)', [9, 'touch']);
      });

      const m = queue.getMetrics();
      expect(m.mode, 'the block must say which path produced it').toBe('bypass');
      // BL-334's exact failure mode: 0/false here is indistinguishable from a
      // healthy idle queue, and no code can ever change it.
      expect(m.queue_depth).toBeNull();
      expect(m.queue_high_watermark).toBeNull();
      expect(m.saturated).toBeNull();
    });

    it('BL-445: in_flight is a REAL concurrent-operation count on the bypass path', async () => {
      const queue = await WriteQueue.forPath(dbPath);
      await seedTable(queue);

      const N = 6;
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      let peak = 0;

      const held = Array.from({ length: N }, (_, i) =>
        queue.enqueue(`bl445-hold-${i}`, async () => {
          peak = Math.max(peak, queue.getMetrics().in_flight);
          await gate;
          return i;
        }),
      );

      // Let every operation reach its await before releasing them.
      await new Promise((r) => setTimeout(r, 20));
      const observed = queue.getMetrics().in_flight;
      release();
      await Promise.all(held);

      expect(observed, `expected ${N} operations in flight simultaneously`).toBe(N);
      expect(peak).toBeGreaterThan(1);
      // …and it drains back to zero once they settle.
      expect(queue.getMetrics().in_flight).toBe(0);
    });
  });

  // ── BL-394 ────────────────────────────────────────────────────────────────
  //
  // ⛔ THIS BLOCK IS NOT ABOUT SERIALIZING TURSO WRITES. Five agents have now
  // misread `write-queue.ts` that way. Turso handling concurrent writes
  // natively is owner-mandated; `_noop` stays; nothing here makes one write
  // wait on another.
  //
  // BL-394's observable defect is a HONESTY defect: `memory_ping` reported
  //
  //     "queue_max_size": 100, "deadline_budget_ms": 20000,
  //     "deadline_guard_enabled": true, "rejections_busy_size": 0
  //
  // on the production backend, where the size cap is expressed over a queue
  // that is never pushed to (`0 >= 100` forever) and the deadline guard reads a
  // ring that — before BL-445 — was never fed. Every one of those fields read
  // as "admission control is configured and active"; none of it was in effect.
  //
  // OWNER RULING 2026-08-05 (fork D of PKT-65): no admission control is added.
  // Turso handles concurrent writes natively, the live store shows zero
  // rejections, and there is no evidence a bound is needed. If a stress harness
  // later shows a knee, a bound gets added then and sized from data. What is
  // fixed here is the claim, not the mechanism.
  tursoDescribe('BL-394 — the surface must not claim guards that cannot fire', () => {
    it('BL-394: a Turso-backed queue reports admission control INACTIVE, with no configured values for guards that cannot fire', async () => {
      const queue = await WriteQueue.forPath(dbPath);
      expect((queue as unknown as { _noop: boolean })._noop).toBe(true);

      const m = queue.getMetrics();
      // The three fields BL-394 quotes verbatim as the defect, asserted FIRST
      // so the red arm fails on the reported lie itself rather than on the
      // absence of the new field. Pre-fix these read `true` / `100` / `20000`.
      expect(m.deadline_guard_enabled, 'the guard cannot fire on this path').toBe(false);
      expect(m.queue_max_size, 'no queue exists for a size cap to bound').toBeNull();
      expect(m.deadline_budget_ms, 'no budget is consulted on this path').toBeNull();
      expect(m.mode).toBe('bypass');
      expect(m.admission_control).toBe('inactive — adapter handles concurrency natively');
    });

    it('BL-394: a sqlite-backed queue reports admission control ACTIVE, with its real configured values', async () => {
      // Same assertions, opposite backend. Before the fix BOTH queues reported
      // identically — which is precisely the bug: the block described
      // configuration, never the reality of the path taken.
      process.env.STORE_ADAPTER = 'sqlite';
      const sqlitePath = path.join(path.dirname(dbPath), 'bl394-sqlite.db');
      const queue = await WriteQueue.forPath(sqlitePath);
      expect((queue as unknown as { _noop: boolean })._noop).toBe(false);

      const m = queue.getMetrics();
      expect(m.mode).toBe('fifo');
      expect(m.admission_control).toBe('active');
      expect(m.deadline_guard_enabled).toBe(true);
      expect(m.queue_max_size).toBe(100);
      expect(m.deadline_budget_ms).toBe(20_000);
    });

    /**
     * MANDATORY REGRESSION GUARD — the reason it asserts peak in-flight rather
     * than "N writes completed".
     *
     * "N concurrent writes all resolved" passes just as happily against a
     * serialized queue: FIFO completes all N too, only slower. This assertion
     * cannot. Every operation parks on the same gate and the gate is not
     * released until all N have been observed in flight simultaneously — so if
     * anyone ever flips `needsWriteSerialization`, `concurrentTransactions` or
     * the `_noop` assignment, operation #2 never starts, the observation is
     * never made, and this test hangs to its timeout rather than quietly
     * passing. Unreachable, not merely false.
     */
    it('BL-394: N Turso writes run CONCURRENTLY — this test is unreachable, not just red, if anyone serializes this path', async () => {
      const queue = await WriteQueue.forPath(dbPath);
      const adapter = (queue as unknown as { adapter: StoreAdapter }).adapter;
      await adapter.exec('CREATE TABLE IF NOT EXISTS wq_c (id INTEGER PRIMARY KEY, val TEXT)');

      const N = 8;
      let release!: () => void;
      const allInFlight = new Promise<void>((r) => { release = r; });
      let entered = 0;

      const held = Array.from({ length: N }, (_, i) =>
        queue.enqueue(`bl394-conc-${i}`, async (a) => {
          entered++;
          // The last arrival frees everyone. Under serialization `entered`
          // never reaches N, because #2 cannot start until #1 settles — and #1
          // is waiting right here.
          if (entered === N) release();
          await allInFlight;
          await a.executeRun('INSERT INTO wq_c (id, val) VALUES (?, ?)', [i, `v${i}`]);
          return i;
        }),
      );

      const peakInFlight = await Promise.race([
        allInFlight.then(() => queue.getMetrics().in_flight),
        new Promise<number>((_, rej) =>
          setTimeout(() => rej(new Error(
            'BL-394 regression: N Turso writes did not reach the gate together — ' +
            'writes on this path are being serialized, which is exactly what must never happen.',
          )), 5000),
        ),
      ]);

      const results = await Promise.all(held);
      expect(results.sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => i));
      expect(peakInFlight, 'all N operations were in flight at once — no serialization').toBe(N);
      expect(entered).toBe(N);

      const count = await adapter.executeGet<{ cnt: number }>('SELECT COUNT(*) AS cnt FROM wq_c');
      expect(count!.cnt).toBe(N);
      // Admission control admitted every one of them, and said so honestly.
      const m = queue.getMetrics();
      expect(m.admission_control).toBe('inactive — adapter handles concurrency natively');
      expect(m.counters.rejections_busy_size).toBe(0);
      expect(m.counters.rejections_busy_deadline).toBe(0);
    });
  });

  // ── BUG-MEMORY-001 ──────────────────────────────────────────────────────
  //
  // AC1 + AC2: closes the write-loss/error-surface incident. The bypass path
  // (`_runBypass`, the one path production actually takes for Turso) used to
  // rethrow every rejection VERBATIM — a raw driver exception, never wrapped
  // via `wrapDbError`, and never retried even when the underlying condition
  // (a Turso lock/busy contention error) was transient. See
  // SPEC-BUG-MEMORY-001.md §1 for the full three-defect root cause.
  tursoDescribe('BUG-MEMORY-001 — bypass path wraps AND retries a classified-retryable failure', () => {
    it('AC1: a Turso-shaped GenericFailure lock error is a structured StorageError at the queue boundary, never a raw object', async () => {
      const queue = await WriteQueue.forPath(dbPath);
      expect((queue as unknown as { _noop: boolean })._noop).toBe(true);

      // Always throws the incident's own literal text — every attempt fails,
      // so this also exercises the exhausted-retry final-rejection path.
      const settled = await queue
        .enqueue('ac1-always-locked', async () => {
          throw { code: 'GenericFailure', message: 'database is locked' };
        })
        .then(
          (v) => ({ ok: true as const, value: v }),
          (err) => ({ ok: false as const, error: err as Record<string, unknown> }),
        );

      expect(settled.ok).toBe(false);
      if (settled.ok) throw new Error('expected the always-locked task to reject');
      // The structured shape AC1 requires — never a bare Error/raw object with
      // no .code/.retryable, and never "[object Object]" once it crosses the
      // MCP boundary (that half is formatToolError's contract, exercised
      // separately in mcp-runtime's own tests).
      expect(settled.error['code']).toBe('E_BUSY');
      expect(settled.error['retryable']).toBe(true);
      expect(settled.error['retry_after_ms']).toBe(250);
      expect(typeof settled.error['message']).toBe('string');
    }, 10_000);

    it('AC2: a fault that succeeds on the SECOND attempt does not lose the write — the episode is persisted', async () => {
      const queue = await WriteQueue.forPath(dbPath);
      const adapter = (queue as unknown as { adapter: StoreAdapter }).adapter;
      await adapter.exec('CREATE TABLE IF NOT EXISTS wq_retry (id INTEGER PRIMARY KEY, val TEXT)');

      let calls = 0;
      const result = await queue.enqueue('ac2-transient-then-success', async (a) => {
        calls++;
        if (calls === 1) {
          // The FIRST call throws the Turso-shaped lock error — classified
          // retryable by wrapDbError, so §2.3's retry loop must attempt again
          // rather than losing the write.
          throw { code: 'GenericFailure', message: 'database is locked' };
        }
        // Retry-from-scratch safety (SPEC-BUG-MEMORY-001.md §2.3's proof): the
        // whole operation closure re-runs, so this insert only happens once,
        // on the attempt that actually reaches it.
        await a.executeRun('INSERT INTO wq_retry (id, val) VALUES (?, ?)', [1, 'persisted']);
        return 'ok';
      });

      expect(result).toBe('ok');
      expect(calls, 'the operation was retried exactly once after the injected failure').toBe(2);

      const row = await adapter.executeGet<{ val: string }>('SELECT val FROM wq_retry WHERE id = ?', [1]);
      expect(row, 'the episode must be durably persisted, not lost to the first failed attempt').not.toBeNull();
      expect(row!.val).toBe('persisted');

      // A retried-but-ultimately-successful task still only counts once.
      const m = queue.getMetrics();
      expect(m.counters.tasks_completed).toBe(1);
    }, 10_000);

    it('pre-fix RED-arm regression guard: a NON-retryable classified failure (e.g. a plain Error) still fails on the FIRST attempt with no retry delay', async () => {
      const queue = await WriteQueue.forPath(dbPath);
      let calls = 0;
      const t0 = Date.now();
      const settled = await queue
        .enqueue('ac1-non-retryable', async () => {
          calls++;
          throw new Error('not a driver error at all');
        })
        .then(
          (v) => ({ ok: true as const, value: v }),
          (err) => ({ ok: false as const, error: err as Record<string, unknown> }),
        );
      const elapsedMs = Date.now() - t0;

      expect(settled.ok).toBe(false);
      if (settled.ok) throw new Error('expected rejection');
      expect(settled.error['code']).toBe('E_IO');
      expect(settled.error['retryable']).toBe(false);
      expect(calls, 'a non-retryable failure must not be retried').toBe(1);
      expect(elapsedMs, 'no retry delay should have been incurred').toBeLessThan(200);
    });
  });
});
