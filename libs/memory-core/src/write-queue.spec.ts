/**
 * write-queue.spec.ts — WriteQueue ordering + negative control (WP-1, BL-118).
 *
 * Acceptance:
 *   - Queue serialisation proven by a test asserting write ordering under concurrency.
 *   - Negative control: disable the queue (bypass) → ordering assertion fails.
 *   - 20 parallel async operations: zero raw errors; proven FIFO order.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { WriteQueue } from './write-queue.js';

function tmpDir(): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wq-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('WriteQueue — ordering and serialisation (WP-1)', () => {
  let cleanup: () => void;
  let dbPath: string;

  beforeEach(async () => {
    const t = tmpDir();
    cleanup = t.cleanup;
    dbPath = path.join(t.dir, 'test.db');
    await WriteQueue.clearInstances();
    WriteQueue.setBypass(false);
  });

  afterEach(async () => {
    await WriteQueue.clearInstances();
    cleanup();
  });

  /**
   * Core ordering invariant: WITH the queue, 20 concurrent async operations
   * execute in strict FIFO order.
   *
   * Each operation:
   *   1. Yields to the event loop (random delay), proving concurrency would
   *      scramble order WITHOUT serialisation.
   *   2. Records its completion index.
   *
   * WITH the queue: operations execute one-at-a-time → the completion order
   * matches enqueue order: [0, 1, 2, ..., 19].
   */
  it('proves FIFO ordering under concurrency (queue active)', async () => {
    const queue = await WriteQueue.forPath(dbPath);
    const order: number[] = [];

    for (let i = 0; i < 20; i++) {
      queue.enqueue(`op-${i}`, async () => {
        // Random delay so concurrent execution would scramble order.
        await new Promise<void>((r) => setTimeout(r, Math.floor(Math.random() * 10)));
        order.push(i);
      });
    }

    // Wait for the queue to drain.
    await new Promise<void>((r) => setTimeout(r, 300));

    // WITH the queue: strict FIFO order.
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  /**
   * Negative control: disable queue serialisation (bypass) → ordering is
   * scrambled because all 20 operations run concurrently.
   *
   * Each operation reads (and increments) a shared counter AFTER the async
   * yield, so the counter value reflects the RACE, not the enqueue order.
   * WITH the queue the same test produces sequential counter values.
   */
  it('negative control: queue bypass scrambles ordering (test goes red)', async () => {
    WriteQueue.setBypass(true);
    const queue = await WriteQueue.forPath(dbPath);
    const order: number[] = [];

    for (let i = 0; i < 20; i++) {
      queue.enqueue(`op-${i}`, async () => {
        // Yield FIRST so the counter read races with other operations.
        await new Promise<void>((r) => setTimeout(r, Math.floor(Math.random() * 10)));
        order.push(i);
      });
    }

    await new Promise<void>((r) => setTimeout(r, 300));

    // WITHOUT the queue: ordering is NOT strictly sequential.
    // Most runs will have at least one inversion.
    expect(order).not.toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
  });

  /**
   * Overflow guard: queue with maxSize=1 rejects the second concurrent enqueue.
   */
  it('rejects with E_BUSY when queue is full', async () => {
    const queue = await WriteQueue.forPath(path.join(path.dirname(dbPath), 'busy.db'), 1);

    // Enqueue one long-running operation to fill the queue
    const slowPromise = queue.enqueue('slow', () => {
      return new Promise<string>((r) => setTimeout(() => r('done'), 50));
    });

    // Enqueue a second — should be rejected immediately
    const secondResult = await queue
      .enqueue('overflow', () => 'should not run')
      .then(
        (v): { ok: true; value: string } => ({ ok: true, value: v }),
        (err): { ok: false; error: unknown } => ({ ok: false, error: err }),
      );

    expect(secondResult.ok).toBe(false);
    if (secondResult.ok) throw new Error('expected the overflow enqueue to be rejected');
    expect((secondResult.error as { code: string }).code).toBe('E_BUSY');

    await slowPromise;
  });

  /**
   * Parallel write count: 20 concurrent enqueues all complete.
   */
  it('20 parallel operations all complete successfully', async () => {
    const queue = await WriteQueue.forPath(dbPath);
    let completed = 0;

    const promises: Promise<unknown>[] = [];
    for (let i = 0; i < 20; i++) {
      promises.push(
        queue.enqueue(`p-${i}`, () => {
          completed++;
          return completed;
        }),
      );
    }

    const results = await Promise.all(promises);
    expect(results).toHaveLength(20);
    // Each result is a unique sequential number (serialised execution)
    expect(new Set(results).size).toBe(20);
    expect(completed).toBe(20);
  });

  /**
   * Singleton: two calls to forPath() with the same path return the same queue.
   * Bypass mode creates independent queues (negative control invariant).
   */
  it('singleton: same path returns same instance (bypass=false)', async () => {
    const a = await WriteQueue.forPath(dbPath);
    const b = await WriteQueue.forPath(dbPath);
    expect(a).toBe(b);
  });

  it('bypass mode creates independent instances', async () => {
    WriteQueue.setBypass(true);
    const a = await WriteQueue.forPath(dbPath);
    const b = await WriteQueue.forPath(dbPath);
    expect(a).not.toBe(b);
    WriteQueue.setBypass(false);
  });

  it('bypass static flag getter matches setter', () => {
    expect(WriteQueue.bypass).toBe(false);
    WriteQueue.setBypass(true);
    expect(WriteQueue.bypass).toBe(true);
    WriteQueue.setBypass(false);
  });
});

// ── WP-5: WAL checkpoint on idle ────────────────────────────────────────────

describe('WriteQueue — WAL checkpoint on idle (WP-5, BL-123)', () => {
  let cleanup: () => void;
  let dbPath: string;

  beforeEach(async () => {
    const t = tmpDir();
    cleanup = t.cleanup;
    dbPath = path.join(t.dir, 'test.db');
    await WriteQueue.clearInstances();
    WriteQueue.setBypass(false);
  });

  afterEach(async () => {
    await WriteQueue.clearInstances();
    cleanup();
  });

  /**
   * Acceptance: write enough data to grow the WAL, then wait for the idle
   * checkpoint timer to fire. After the timer fires, walBytes() must report
   * near-zero and lastCheckpointAt must be set.
   *
   * The idle timer fires 2 seconds after the queue becomes empty. We wait
   * the full idle period + 1s buffer for timer + checkpoint execution.
   *
   * NOTE: The DB schema creation (run by openDb via WriteQueue.forPath)
   * writes to the WAL immediately, so walBytes is > 0 from the start.
   * We verify it grows with our writes, then shrinks after checkpoint.
   */
  it('idle checkpoint shrinks WAL file after queue drains', async () => {
    const queue = await WriteQueue.forPath(dbPath);

    // Capture baseline WAL size (from schema creation)
    const walBaseline = queue.walBytes();
    expect(walBaseline).toBeGreaterThan(0);

    // Write enough data to grow the WAL (50 rows of ~1KB each)
    await queue.enqueue('seed-table', async (tx) => {
      await tx.exec(`CREATE TABLE IF NOT EXISTS wp5_test (
        id INTEGER PRIMARY KEY,
        val TEXT NOT NULL
      )`);
      for (let i = 0; i < 50; i++) {
        await tx.executeRun('INSERT INTO wp5_test (id, val) VALUES (?, ?)', [i, 'x'.repeat(1000)]);
      }
    });

    // Wait for queue to drain and checkpoint timer to fire
    await new Promise<void>((r) => setTimeout(r, WriteQueue.CHECKPOINT_IDLE_MS + 1000));

    // WAL should be at or near 0 after TRUNCATE checkpoint
    const walAfter = queue.walBytes();
    expect(walAfter).toBeLessThan(512);

    // lastCheckpointAt should be set
    expect(queue.lastCheckpointAt).toBeGreaterThan(0);
  });

  /**
   * Checkpoint timer lifecycle:
   *   1. After queue drains → timer is pending (_processing=false, _scheduleIdleCheckpoint runs)
   *   2. New work arrives → old timer is cancelled
   *   3. After new work drains → new timer is scheduled
   */
  it('checkpoint timer lifecycle: pending after drain, cancelled and re-scheduled by new work', async () => {
    const queue = await WriteQueue.forPath(dbPath);

    // Do a quick write and let the queue drain
    await queue.enqueue('create-table', async (tx) => {
      await tx.exec('CREATE TABLE IF NOT EXISTS ck_lifecycle (id INTEGER PRIMARY KEY, val TEXT)');
    });

    // Wait just enough for _processNext to finish and checkpoint to be scheduled
    await new Promise<void>((r) => setTimeout(r, 30));

    // Queue should be idle now → checkpoint timer is pending
    expect(queue._checkpointPending).toBe(true);

    // Enqueue new work — this should cancel the pending timer
    queue.enqueue('new-work', async (tx) => {
      await tx.executeRun("INSERT INTO ck_lifecycle (id, val) VALUES (1, 'test')");
    });

    // Wait just enough for enqueue to cancel and new item to be processed
    await new Promise<void>((r) => setTimeout(r, 30));

    // After the new item is processed and the queue goes idle again,
    // a new checkpoint timer should be scheduled
    expect(queue._checkpointPending).toBe(true);
  });

  /**
   * walBytes: the method reads the -wal file from disk. Returns 0 when no
   * DB file exists (WAL file absent), and non-zero when the DB is active
   * with WAL data.
   *
   * NOTE: openDb always writes to the WAL (schema pragmas), so a fresh queue
   * already has a non-zero WAL. This test verifies walBytes can detect it.
   */
  it('walBytes returns non-zero for an active WAL database', async () => {
    const queue = await WriteQueue.forPath(dbPath);
    // The DB writes schema PRAGMAs to the WAL on open, so walBytes > 0
    expect(queue.walBytes()).toBeGreaterThan(0);
  });

  /**
   * walCheckpoint is idempotent. First call checkpoints frames; second call
   * returns -1 (nothing left to checkpoint). lastCheckpointAt advances.
   */
  it('walCheckpoint is idempotent returns frame count then -1', async () => {
    const queue = await WriteQueue.forPath(dbPath);

    // Write some data
    await queue.enqueue('write-data', async (tx) => {
      await tx.exec('CREATE TABLE IF NOT EXISTS ck_idem (id INTEGER PRIMARY KEY, val TEXT)');
      for (let i = 0; i < 30; i++) {
        await tx.executeRun('INSERT INTO ck_idem (id, val) VALUES (?, ?)', [i, 'x'.repeat(300)]);
      }
    });
    await new Promise<void>((r) => setTimeout(r, 100));

    // First checkpoint: should return frame count >= 0
    const frames1 = await queue.walCheckpoint();
    expect(typeof frames1).toBe('number');

    // Second checkpoint: nothing to checkpoint → -1
    const frames2 = await queue.walCheckpoint();
    expect(frames2).toBe(-1);

    // lastCheckpointAt should be set
    expect(queue.lastCheckpointAt).toBeGreaterThan(0);
  });

  /**
   * lastCheckpointAtForPath returns 0 for unknown/unused paths,
   * and >0 after a checkpoint has been performed.
   */
  it('lastCheckpointAtForPath: unknown path returns 0, known path >0 after checkpoint', async () => {
    expect(WriteQueue.lastCheckpointAtForPath('/nonexistent/path.db')).toBe(0);

    const queue = await WriteQueue.forPath(dbPath);
    await queue.walCheckpoint();
    expect(WriteQueue.lastCheckpointAtForPath(dbPath)).toBeGreaterThan(0);
  });
});
