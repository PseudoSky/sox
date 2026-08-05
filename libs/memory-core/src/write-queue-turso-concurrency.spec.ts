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

      await expect(
        queue.enqueue('bl445-boom', async () => {
          await new Promise((r) => setTimeout(r, 2));
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

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

      await expect(
        queue.enqueue('bl445-sync-boom', () => {
          throw new Error('sync boom');
        }),
      ).rejects.toThrow('sync boom');

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
});
