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
});
