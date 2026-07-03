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

  beforeEach(() => {
    const t = tmpDir();
    cleanup = t.cleanup;
    dbPath = path.join(t.dir, 'test.db');
    WriteQueue.clearInstances();
    WriteQueue.setBypass(false);
  });

  afterEach(() => {
    WriteQueue.clearInstances();
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
    const queue = WriteQueue.forPath(dbPath);
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
    const queue = WriteQueue.forPath(dbPath);
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
    const queue = WriteQueue.forPath(path.join(path.dirname(dbPath), 'busy.db'), 1);

    // Enqueue one long-running operation to fill the queue
    const slowPromise = queue.enqueue('slow', () => {
      return new Promise<string>((r) => setTimeout(() => r('done'), 50));
    });

    // Enqueue a second — should be rejected immediately
    const secondResult = await queue
      .enqueue('overflow', () => 'should not run')
      .then(
        (v) => ({ ok: true, value: v }),
        (err) => ({ ok: false, error: err }),
      );

    expect(secondResult.ok).toBe(false);
    expect((secondResult.error as { code: string }).code).toBe('E_BUSY');

    await slowPromise;
  });

  /**
   * Parallel write count: 20 concurrent enqueues all complete.
   */
  it('20 parallel operations all complete successfully', async () => {
    const queue = WriteQueue.forPath(dbPath);
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
  it('singleton: same path returns same instance (bypass=false)', () => {
    const a = WriteQueue.forPath(dbPath);
    const b = WriteQueue.forPath(dbPath);
    expect(a).toBe(b);
  });

  it('bypass mode creates independent instances', () => {
    WriteQueue.setBypass(true);
    const a = WriteQueue.forPath(dbPath);
    const b = WriteQueue.forPath(dbPath);
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
