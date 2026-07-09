/**
 * @adhd/sox-task-queue — WorkerPool tests
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTaskQueue, createWorkerPool, TaskStatus } from './index.js';
import type { Task, TaskQueue, WorkerPool } from './index.js';

/**
 * Some tests deliberately leave a task 'running' (handler abandoned past
 * drainTimeoutMs, or never resolved). `close()`'s documented drain
 * semantics would otherwise block teardown for up to the default 30s
 * drainTimeoutMs. Use a short timeout and swallow the resulting
 * TaskTimeoutError — no test in this file asserts queue.close()'s own
 * drain contract (that's covered in task-queue.spec.ts).
 */
async function closeQuietly(q: TaskQueue): Promise<void> {
  try {
    await q.close({ drainTimeoutMs: 10 });
  } catch {
    // best-effort teardown
  }
}

describe('WorkerPool', () => {
  let queue: TaskQueue;

  beforeEach(async () => {
    vi.useFakeTimers();
    queue = createTaskQueue({ dbPath: ':memory:', autoRequeueExpired: false });
    await queue.open();
  });

  afterEach(async () => {
    // Restore real timers FIRST: closeQuietly()'s internal drain loop uses
    // setTimeout-based polling, which would otherwise hang forever under
    // fake timers that nothing is left to advance during teardown.
    vi.useRealTimers();
    await closeQuietly(queue);
  });

  it('does not start polling until start() when autoStart is false', async () => {
    await queue.enqueue({ type: 'test', payload: {} });
    const handler = vi.fn(async () => {});
    const pool = createWorkerPool({ queue, handler, autoStart: false, pollIntervalMs: 10 });
    expect(pool.isRunning).toBe(false);
    await vi.advanceTimersByTimeAsync(50);
    expect(handler).not.toHaveBeenCalled();
    pool.start();
    await vi.advanceTimersByTimeAsync(50);
    expect(handler).toHaveBeenCalledTimes(1);
    await pool.stop();
  });

  it('processes a queued task and calls complete() on handler success', async () => {
    const { id } = await queue.enqueue({ type: 'test', payload: { n: 1 } });
    const handler = vi.fn(async (task: Task) => {
      expect(task.id).toBe(id);
    });
    const pool = createWorkerPool({ queue, handler, pollIntervalMs: 10 });
    await vi.advanceTimersByTimeAsync(50);
    const task = await queue.get(id);
    expect(task?.status).toBe(TaskStatus.Completed);
    expect(pool.stats.tasksProcessed).toBe(1);
    await pool.stop();
  });

  it('calls fail() with the error message when the handler throws', async () => {
    const { id } = await queue.enqueue({ type: 'test', payload: {}, maxRetries: 0 });
    const handler = vi.fn(async () => {
      throw new Error('boom');
    });
    const pool = createWorkerPool({ queue, handler, pollIntervalMs: 10 });
    await vi.advanceTimersByTimeAsync(50);
    const task = await queue.get(id);
    expect(task?.dead).toBe(true);
    expect(task?.error).toBe('boom');
    expect(pool.stats.tasksFailed).toBe(1);
    await pool.stop();
  });

  it('respects concurrency: never runs more than N handlers at once', async () => {
    await queue.enqueueBatch([
      { type: 'a', payload: {} },
      { type: 'b', payload: {} },
      { type: 'c', payload: {} },
      { type: 'd', payload: {} },
    ]);
    let maxConcurrent = 0;
    let current = 0;
    // Each handler self-resolves after a fixed fake-timer delay rather than
    // depending on externally-collected resolvers — this sidesteps ordering
    // hazards between microtask-scheduled continuations and a synchronous
    // release loop, and lets a single advanceTimersByTimeAsync drain
    // everything deterministically.
    const handler = vi.fn(async () => {
      current++;
      maxConcurrent = Math.max(maxConcurrent, current);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      current--;
    });
    const pool = createWorkerPool({ queue, handler, concurrency: 2, pollIntervalMs: 10 });
    await vi.advanceTimersByTimeAsync(200);
    expect(maxConcurrent).toBe(2);
    expect(current).toBe(0);
    expect(handler).toHaveBeenCalledTimes(4);
    const remaining = await queue.countTasks({ status: TaskStatus.Completed });
    expect(remaining).toBe(4);
    await pool.stop();
  });

  it('heartbeats a long-running task on heartbeatIntervalMs cadence', async () => {
    await queue.enqueue({ type: 'test', payload: {} });
    const heartbeatSpy = vi.spyOn(queue, 'heartbeat');
    let releaseHandler: (() => void) | null = null;
    const handler = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        releaseHandler = resolve;
      });
    });
    const pool = createWorkerPool({ queue, handler, heartbeatIntervalMs: 20, pollIntervalMs: 10 });
    await vi.advanceTimersByTimeAsync(10); // let it dequeue + start handler
    await vi.advanceTimersByTimeAsync(65); // >= 3 heartbeat intervals
    expect(heartbeatSpy.mock.calls.length).toBeGreaterThanOrEqual(2);
    releaseHandler?.();
    await vi.advanceTimersByTimeAsync(20);
    await pool.stop();
  });

  it('stop() drains in-flight handlers before resolving', async () => {
    await queue.enqueue({ type: 'test', payload: {} });
    let resolveHandler: (() => void) | null = null;
    const handler = vi.fn(async () => {
      await new Promise<void>((resolve) => {
        resolveHandler = resolve;
      });
    });
    const pool = createWorkerPool({ queue, handler, pollIntervalMs: 10 });
    await vi.advanceTimersByTimeAsync(10); // handler is now in flight

    let stopped = false;
    const stopPromise = pool.stop().then(() => {
      stopped = true;
    });
    await vi.advanceTimersByTimeAsync(10);
    expect(stopped).toBe(false); // still draining

    resolveHandler?.();
    await vi.advanceTimersByTimeAsync(50);
    await stopPromise;
    expect(stopped).toBe(true);
    expect(pool.isRunning).toBe(false);
  });

  it('stop() abandons a handler that exceeds drainTimeoutMs (lease survives for the reaper)', async () => {
    await queue.enqueue({ type: 'test', payload: {} });
    const handler = vi.fn(async () => {
      await new Promise<void>(() => {}); // never resolves
    });
    const pool: WorkerPool = createWorkerPool({ queue, handler, pollIntervalMs: 10, drainTimeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(10); // handler is now in flight, never resolves

    const stopPromise = pool.stop();
    // stop()'s internal drain loop polls via fake-timer-backed setTimeout —
    // it needs the fake clock advanced *while it's awaiting* to make
    // progress past its own 100ms drainTimeoutMs.
    await vi.advanceTimersByTimeAsync(150);
    await stopPromise;
    expect(pool.isRunning).toBe(false);
    // Task is still 'running' in the DB — abandoned, not force-completed.
    const tasks = await queue.listTasks({ status: TaskStatus.Running });
    expect(tasks).toHaveLength(1);
  });

  it('stop() is a no-op if not running', async () => {
    const handler = vi.fn(async () => {});
    const pool = createWorkerPool({ queue, handler, autoStart: false });
    await expect(pool.stop()).resolves.toBeUndefined();
  });
});
