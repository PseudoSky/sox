/**
 * write-queue-turso-concurrency.spec.ts — BL-321 regression: unserialized
 * concurrent writes against a Turso-backed store.
 *
 * Prior to the fix, `TursoAdapterImpl.connect()` set
 * `needsWriteSerialization: false`, which made `WriteQueue._create()` set
 * `queue._noop = true` — every `enqueue()` call then bypassed the FIFO queue
 * entirely (write-queue.ts `enqueue()`, the `WriteQueue._bypass || this._noop`
 * branch) and ran directly against the single shared Turso connection. Because
 * `TursoAdapterImpl.transaction()` had no mutual exclusion of its own, N
 * concurrent `enqueue()` calls that each open a transaction interleaved their
 * BEGIN/COMMIT/ROLLBACK and lost writes.
 *
 * This spec forces STORE_ADAPTER=turso (real @tursodatabase/database, not the
 * mock) and fires N concurrent `WriteQueue.enqueue()` transactional writes at
 * one store, then asserts every write is durably present. Skipped
 * automatically if @tursodatabase/database is not installed.
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

let priorAdapterEnv: string | undefined;

describe('WriteQueue — Turso durability under concurrency (BL-321)', () => {
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
    it('the queue for a Turso-backed store now serializes (BL-321 capability fix)', async () => {
      const queue = await WriteQueue.forPath(dbPath);
      // Reach the private flag only to document intent; the durability test
      // below is the behavioral proof. Accessed via bracket notation since
      // _noop is a private implementation detail, not a public contract.
      expect((queue as unknown as { _noop: boolean })._noop).toBe(false);
    });

    it('durably commits N concurrent WriteQueue.enqueue transactional writes', async () => {
      const queue = await WriteQueue.forPath(dbPath);
      const adapter = (queue as unknown as { adapter: StoreAdapter }).adapter;
      await adapter.exec('CREATE TABLE IF NOT EXISTS wq_t (id INTEGER PRIMARY KEY, val TEXT)');

      const N = 20;
      const jitter = () => new Promise<void>((r) => setTimeout(r, Math.random() * 8));

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
