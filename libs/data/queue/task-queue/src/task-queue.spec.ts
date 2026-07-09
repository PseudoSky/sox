/**
 * @adhd/sox-task-queue — TaskQueue tests
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTaskQueue,
  SqliteTaskQueue,
  TaskStatus,
  PRAGMAS,
  TASK_QUEUE_DDL,
  computeBackoffDelayMs,
  QueueFullError,
  TaskNotFoundError,
  TaskNotRunningError,
  TaskPermanentlyFailedError,
  TaskNotDeadError,
  QueueNotEmptyError,
  TaskQueueNotOpenError,
  TaskTimeoutError,
} from './index.js';
import type { TaskQueue } from './index.js';

function freshQueue(overrides: Partial<Parameters<typeof createTaskQueue>[0]> = {}): TaskQueue {
  return createTaskQueue({ dbPath: ':memory:', autoRequeueExpired: false, ...overrides });
}

/**
 * Many tests deliberately leave a task 'running' (dequeued, never
 * completed/failed) to exercise dequeue/lease/reaper behaviour. `close()`'s
 * documented drain semantics would otherwise block test teardown for up to
 * the default 30s drainTimeoutMs. Use a short timeout and swallow the
 * resulting TaskTimeoutError in teardown — tests that specifically assert
 * close()'s drain/timeout *contract* call `queue.close()` directly instead.
 */
async function closeQuietly(q: TaskQueue): Promise<void> {
  try {
    await q.close({ drainTimeoutMs: 10 });
  } catch {
    // best-effort teardown
  }
}

describe('static exports', () => {
  it('PRAGMAS is a non-empty string array', () => {
    expect(PRAGMAS.length).toBeGreaterThan(0);
    expect(PRAGMAS.every((p) => typeof p === 'string')).toBe(true);
  });

  it('TASK_QUEUE_DDL is a non-empty string', () => {
    expect(typeof TASK_QUEUE_DDL).toBe('string');
    expect(TASK_QUEUE_DDL.length).toBeGreaterThan(0);
  });

  it('createTaskQueue returns a SqliteTaskQueue', () => {
    const q = createTaskQueue({ dbPath: ':memory:' });
    expect(q).toBeInstanceOf(SqliteTaskQueue);
  });
});

describe('backoff formula', () => {
  it('matches the SPEC §9 worked example (0-indexed retryCount)', () => {
    expect(computeBackoffDelayMs(0)).toBe(1_000); // first retry: 1s
    expect(computeBackoffDelayMs(1)).toBe(2_000); // second retry: 2s
    expect(computeBackoffDelayMs(2)).toBe(4_000); // third retry: 4s
    expect(computeBackoffDelayMs(3)).toBe(8_000);
    expect(computeBackoffDelayMs(4)).toBe(16_000);
  });

  it('caps at 24h regardless of retryCount', () => {
    expect(computeBackoffDelayMs(30)).toBe(86_400_000);
    expect(computeBackoffDelayMs(1000)).toBe(86_400_000);
  });
});

describe('lifecycle', () => {
  it('isOpen is false before open() and true after', async () => {
    const q = freshQueue();
    expect(q.isOpen).toBe(false);
    await q.open();
    expect(q.isOpen).toBe(true);
    await q.close();
    expect(q.isOpen).toBe(false);
  });

  it('open() is idempotent', async () => {
    const q = freshQueue();
    await q.open();
    await q.open();
    expect(q.isOpen).toBe(true);
    await q.close();
  });

  it('close() is idempotent (no-op when not open)', async () => {
    const q = freshQueue();
    await expect(q.close()).resolves.toBeUndefined();
  });

  it('throws TaskQueueNotOpenError when used before open()', async () => {
    const q = freshQueue();
    await expect(q.enqueue({ type: 'x', payload: {} })).rejects.toBeInstanceOf(TaskQueueNotOpenError);
    await expect(q.get('nope')).rejects.toBeInstanceOf(TaskQueueNotOpenError);
  });

  it('throws TaskQueueNotOpenError after close()', async () => {
    const q = freshQueue();
    await q.open();
    await q.close();
    await expect(q.enqueue({ type: 'x', payload: {} })).rejects.toBeInstanceOf(TaskQueueNotOpenError);
  });

  it('applies schema: tasks, request_ledger, scheduler_entries tables exist', async () => {
    const q = new SqliteTaskQueue({ dbPath: ':memory:' });
    await q.open();
    const db = q.getDatabase();
    const tables = db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain('tasks');
    expect(names).toContain('request_ledger');
    expect(names).toContain('scheduler_entries');
    expect(names).toContain('_schema_version');
    await q.close();
  });
});

describe('enqueue', () => {
  let queue: TaskQueue;
  beforeEach(async () => {
    queue = freshQueue();
    await queue.open();
  });
  afterEach(async () => {
    await closeQuietly(queue);
  });

  it('generates a UUIDv4 id when omitted', async () => {
    const result = await queue.enqueue({ type: 'test', payload: { a: 1 } });
    expect(result.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(result.isNew).toBe(true);
    expect(result.deduplicated).toBe(false);
  });

  it('respects a caller-supplied id', async () => {
    const result = await queue.enqueue({ id: 'my-id', type: 'test', payload: {} });
    expect(result.id).toBe('my-id');
    const task = await queue.get('my-id');
    expect(task).not.toBeNull();
  });

  it('defaults priority to 0, maxRetries to 3, status to queued', async () => {
    const { id } = await queue.enqueue({ type: 'test', payload: {} });
    const task = await queue.get(id);
    expect(task?.priority).toBe(0);
    expect(task?.maxRetries).toBe(3);
    expect(task?.status).toBe(TaskStatus.Queued);
    expect(task?.retryCount).toBe(0);
    expect(task?.dead).toBe(false);
  });

  it('honours defaultMaxRetries from config', async () => {
    const q2 = freshQueue({ defaultMaxRetries: 7 });
    await q2.open();
    const { id } = await q2.enqueue({ type: 'test', payload: {} });
    const task = await q2.get(id);
    expect(task?.maxRetries).toBe(7);
    await q2.close();
  });

  it('preserves the JSON payload round-trip', async () => {
    const payload = { nested: { value: [1, 2, 3] }, str: 'hi' };
    const { id } = await queue.enqueue({ type: 'test', payload });
    const task = await queue.get(id);
    expect(task?.payload).toEqual(payload);
  });

  it('sets status=scheduled when scheduledAt is in the future', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const { id } = await queue.enqueue({ type: 'test', payload: {}, scheduledAt: future });
    const task = await queue.get(id);
    expect(task?.status).toBe(TaskStatus.Scheduled);
    expect(task?.scheduledAt).toBe(future);
  });

  it('deduplicates on repeated clientRequestId, returning the original id', async () => {
    const first = await queue.enqueue({ type: 'test', payload: { n: 1 }, clientRequestId: 'req-1' });
    const second = await queue.enqueue({ type: 'test', payload: { n: 2 }, clientRequestId: 'req-1' });
    expect(second.id).toBe(first.id);
    expect(second.deduplicated).toBe(true);
    expect(second.isNew).toBe(false);
    const count = await queue.countTasks({});
    expect(count).toBe(1);
  });

  it('enqueueBatch commits all tasks atomically', async () => {
    const results = await queue.enqueueBatch([
      { type: 'a', payload: {} },
      { type: 'b', payload: {} },
      { type: 'c', payload: {} },
    ]);
    expect(results).toHaveLength(3);
    const count = await queue.countTasks({});
    expect(count).toBe(3);
  });

  it('throws QueueFullError once maxQueueDepth is reached', async () => {
    const q2 = freshQueue({ maxQueueDepth: 2 });
    await q2.open();
    await q2.enqueue({ type: 'a', payload: {} });
    await q2.enqueue({ type: 'b', payload: {} });
    await expect(q2.enqueue({ type: 'c', payload: {} })).rejects.toBeInstanceOf(QueueFullError);
    await q2.close();
  });
});

describe('dequeue', () => {
  let queue: TaskQueue;
  beforeEach(async () => {
    queue = freshQueue();
    await queue.open();
  });
  afterEach(async () => {
    await closeQuietly(queue);
  });

  it('returns [] when nothing is eligible', async () => {
    const results = await queue.dequeue('worker-1');
    expect(results).toEqual([]);
  });

  it('claims a task atomically: status becomes running, lease + worker set', async () => {
    const { id } = await queue.enqueue({ type: 'test', payload: {} });
    const [result] = await queue.dequeue('worker-1');
    expect(result?.task.id).toBe(id);
    expect(result?.task.status).toBe(TaskStatus.Running);
    expect(result?.task.workerId).toBe('worker-1');
    expect(result?.task.leaseExpiresAt).not.toBeNull();
    expect(result?.task.started_at).not.toBeNull();
  });

  it('does not return the same task to two concurrent dequeues', async () => {
    await queue.enqueue({ type: 'test', payload: {} });
    const [a] = await queue.dequeue('worker-1');
    const b = await queue.dequeue('worker-2');
    expect(a).toBeDefined();
    expect(b).toEqual([]);
  });

  it('orders by priority DESC, then created_at ASC (FIFO within priority)', async () => {
    const low = await queue.enqueue({ type: 'test', payload: { n: 'low' }, priority: 0 });
    const high = await queue.enqueue({ type: 'test', payload: { n: 'high' }, priority: 10 });
    const mid = await queue.enqueue({ type: 'test', payload: { n: 'mid' }, priority: 5 });
    const results = await queue.dequeue('worker-1');
    expect(results.map((r) => r.task.id)).toEqual([high.id, mid.id, low.id]);
  });

  it('preserves FIFO among equal priority', async () => {
    const first = await queue.enqueue({ type: 'test', payload: { n: 1 }, priority: 1 });
    // Ensure created_at ordering is deterministic even at same-millisecond resolution
    // by asserting insertion order is preserved regardless.
    const second = await queue.enqueue({ type: 'test', payload: { n: 2 }, priority: 1 });
    const results = await queue.dequeue('worker-1');
    expect(results.map((r) => r.task.id)).toEqual([first.id, second.id]);
  });

  it('respects dequeueBatchSize', async () => {
    const q2 = freshQueue({ dequeueBatchSize: 2 });
    await q2.open();
    await q2.enqueueBatch([
      { type: 'a', payload: {} },
      { type: 'b', payload: {} },
      { type: 'c', payload: {} },
    ]);
    const results = await q2.dequeue('worker-1');
    expect(results).toHaveLength(2);
    await closeQuietly(q2);
  });

  it('does not dequeue a scheduled task before scheduledAt arrives, and does after', async () => {
    vi.useFakeTimers();
    try {
      const future = new Date(Date.now() + 10_000).toISOString();
      await queue.enqueue({ type: 'test', payload: {}, scheduledAt: future });
      expect(await queue.dequeue('worker-1')).toEqual([]);
      vi.setSystemTime(new Date(Date.now() + 10_001));
      const results = await queue.dequeue('worker-1');
      expect(results).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('complete', () => {
  let queue: TaskQueue;
  beforeEach(async () => {
    queue = freshQueue();
    await queue.open();
  });
  afterEach(async () => {
    await closeQuietly(queue);
  });

  it('marks status completed and stores the JSON-serialized result', async () => {
    const { id } = await queue.enqueue({ type: 'test', payload: {} });
    await queue.dequeue('worker-1');
    await queue.complete(id, { ok: true });
    const task = await queue.get(id);
    expect(task?.status).toBe(TaskStatus.Completed);
    expect(task?.completed_at).not.toBeNull();
    expect(task?.result).toBe(JSON.stringify({ ok: true }));
  });

  it('throws TaskNotFoundError for an unknown id', async () => {
    await expect(queue.complete('missing', {})).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it('throws TaskNotRunningError if the task was never dequeued', async () => {
    const { id } = await queue.enqueue({ type: 'test', payload: {} });
    await expect(queue.complete(id, {})).rejects.toBeInstanceOf(TaskNotRunningError);
  });

  it('throws TaskNotRunningError on double-complete', async () => {
    const { id } = await queue.enqueue({ type: 'test', payload: {} });
    await queue.dequeue('worker-1');
    await queue.complete(id, {});
    await expect(queue.complete(id, {})).rejects.toBeInstanceOf(TaskNotRunningError);
  });
});

describe('fail — retry with exponential backoff', () => {
  let queue: TaskQueue;
  beforeEach(async () => {
    queue = freshQueue();
    await queue.open();
  });
  afterEach(async () => {
    await closeQuietly(queue);
  });

  it('throws TaskNotFoundError for an unknown id', async () => {
    await expect(queue.fail('missing', 'boom')).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it('throws TaskNotRunningError if not currently running', async () => {
    const { id } = await queue.enqueue({ type: 'test', payload: {} });
    await expect(queue.fail(id, 'boom')).rejects.toBeInstanceOf(TaskNotRunningError);
  });

  it('re-queues with incremented retryCount and a backoff-delayed scheduledAt when under maxRetries', async () => {
    vi.useFakeTimers();
    try {
      const start = Date.now();
      const { id } = await queue.enqueue({ type: 'test', payload: {}, maxRetries: 3 });
      await queue.dequeue('worker-1');
      await queue.fail(id, 'transient error');
      const task = await queue.get(id);
      expect(task?.status).toBe(TaskStatus.Queued);
      expect(task?.retryCount).toBe(1);
      expect(task?.dead).toBe(false);
      expect(task?.error).toBe('transient error');
      expect(task?.workerId).toBeNull();
      expect(task?.leaseExpiresAt).toBeNull();
      expect(new Date(task!.scheduledAt as string).getTime() - start).toBe(1_000); // 2^0 * 1000ms
    } finally {
      vi.useRealTimers();
    }
  });

  it('is not eligible for dequeue until the backoff window elapses', async () => {
    vi.useFakeTimers();
    try {
      const { id } = await queue.enqueue({ type: 'test', payload: {}, maxRetries: 3 });
      await queue.dequeue('worker-1');
      await queue.fail(id, 'err');
      expect(await queue.dequeue('worker-1')).toEqual([]);
      vi.advanceTimersByTime(1_001);
      const results = await queue.dequeue('worker-1');
      expect(results).toHaveLength(1);
      expect(results[0]?.task.id).toBe(id);
    } finally {
      vi.useRealTimers();
    }
  });

  it('goes dead once retryCount reaches maxRetries', async () => {
    vi.useFakeTimers();
    try {
      const { id } = await queue.enqueue({ type: 'test', payload: {}, maxRetries: 2 });

      await queue.dequeue('worker-1');
      await queue.fail(id, 'err-1'); // retryCount 0 -> 1, still < 2

      // Backoff for retryCount=0 is 2^0*1000=1000ms — the task is not
      // eligible for re-dequeue until that window elapses.
      vi.advanceTimersByTime(1_001);

      await queue.dequeue('worker-1');
      await queue.fail(id, 'err-2'); // retryCount 1 -> 2, 2 >= 2 -> dead

      const task = await queue.get(id);
      expect(task?.dead).toBe(true);
      expect(task?.status).toBe(TaskStatus.Failed);
      expect(task?.error).toBe('err-2');
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws TaskPermanentlyFailedError if fail() is called again on a dead task', async () => {
    const { id } = await queue.enqueue({ type: 'test', payload: {}, maxRetries: 1 });
    await queue.dequeue('worker-1');
    await queue.fail(id, 'err'); // -> dead (1 >= 1)
    // Force back to 'running' to hit the dead-check branch specifically
    // rather than the not-running branch.
    const db = (queue as SqliteTaskQueue).getDatabase();
    db.prepare(`UPDATE tasks SET status = 'running' WHERE id = ?`).run(id);
    await expect(queue.fail(id, 'again')).rejects.toBeInstanceOf(TaskPermanentlyFailedError);
  });

  it('calls onDead exactly once when a task goes dead via fail()', async () => {
    const onDead = vi.fn();
    const q2 = freshQueue({ maxRetries: 0, defaultMaxRetries: 1, onDead });
    await q2.open();
    const { id } = await q2.enqueue({ type: 'test', payload: {} });
    await q2.dequeue('worker-1');
    await q2.fail(id, 'boom');
    expect(onDead).toHaveBeenCalledTimes(1);
    expect(onDead.mock.calls[0]?.[0]?.id).toBe(id);
    await q2.close();
  });
});

describe('heartbeat', () => {
  let queue: TaskQueue;
  beforeEach(async () => {
    queue = freshQueue({ heartbeatTimeoutMs: 5_000 });
    await queue.open();
  });
  afterEach(async () => {
    await closeQuietly(queue);
  });

  it('throws TaskNotFoundError for an unknown id', async () => {
    await expect(queue.heartbeat('missing')).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it('returns false if the task is not running', async () => {
    const { id } = await queue.enqueue({ type: 'test', payload: {} });
    expect(await queue.heartbeat(id)).toBe(false);
  });

  it('extends the lease and returns true while running', async () => {
    vi.useFakeTimers();
    try {
      const { id } = await queue.enqueue({ type: 'test', payload: {} });
      await queue.dequeue('worker-1');
      const before = (await queue.get(id))!.leaseExpiresAt;
      vi.advanceTimersByTime(2_000);
      expect(await queue.heartbeat(id)).toBe(true);
      const after = (await queue.get(id))!.leaseExpiresAt;
      expect(new Date(after!).getTime()).toBeGreaterThan(new Date(before!).getTime());
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cancel / isCancelled', () => {
  let queue: TaskQueue;
  beforeEach(async () => {
    queue = freshQueue();
    await queue.open();
  });
  afterEach(async () => {
    await closeQuietly(queue);
  });

  it('throws TaskNotFoundError for an unknown id (both methods)', async () => {
    await expect(queue.cancel('missing')).rejects.toBeInstanceOf(TaskNotFoundError);
    await expect(queue.isCancelled('missing')).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it('cancels a queued task immediately (terminal)', async () => {
    const { id } = await queue.enqueue({ type: 'test', payload: {} });
    expect(await queue.cancel(id)).toBe(true);
    const task = await queue.get(id);
    expect(task?.status).toBe(TaskStatus.Cancelled);
  });

  it('sets a cancellation flag for a running task without changing its status', async () => {
    const { id } = await queue.enqueue({ type: 'test', payload: {} });
    await queue.dequeue('worker-1');
    expect(await queue.cancel(id)).toBe(true);
    const task = await queue.get(id);
    expect(task?.status).toBe(TaskStatus.Running);
    expect(await queue.isCancelled(id)).toBe(true);
  });

  it('is a no-op returning false for an already-terminal task', async () => {
    const { id } = await queue.enqueue({ type: 'test', payload: {} });
    await queue.dequeue('worker-1');
    await queue.complete(id, {});
    expect(await queue.cancel(id)).toBe(false);
  });
});

describe('query: get / listTasks / countTasks / stats', () => {
  let queue: TaskQueue;
  beforeEach(async () => {
    queue = freshQueue();
    await queue.open();
  });
  afterEach(async () => {
    await closeQuietly(queue);
  });

  it('get() returns null for an unknown id', async () => {
    expect(await queue.get('missing')).toBeNull();
  });

  it('listTasks filters by status', async () => {
    const a = await queue.enqueue({ type: 'test', payload: {} });
    await queue.enqueue({ type: 'test', payload: {} });
    await queue.dequeue('worker-1'); // claims one -> running
    const running = await queue.listTasks({ status: TaskStatus.Running });
    const queued = await queue.listTasks({ status: TaskStatus.Queued });
    expect(running.length + queued.length).toBe(2);
    expect(running.every((t) => t.status === TaskStatus.Running)).toBe(true);
    void a;
  });

  it('listTasks filters by type (array form)', async () => {
    await queue.enqueue({ type: 'email', payload: {} });
    await queue.enqueue({ type: 'sms', payload: {} });
    await queue.enqueue({ type: 'push', payload: {} });
    const results = await queue.listTasks({ type: ['email', 'sms'] });
    expect(results).toHaveLength(2);
  });

  it('listTasks respects limit/offset and orderBy/orderDir', async () => {
    await queue.enqueue({ type: 'test', payload: { n: 1 }, priority: 1 });
    await queue.enqueue({ type: 'test', payload: { n: 2 }, priority: 2 });
    await queue.enqueue({ type: 'test', payload: { n: 3 }, priority: 3 });
    const results = await queue.listTasks({ orderBy: 'priority', orderDir: 'desc', limit: 2 });
    expect(results).toHaveLength(2);
    expect(results[0]?.priority).toBe(3);
    expect(results[1]?.priority).toBe(2);
  });

  it('countTasks matches listTasks length without a limit', async () => {
    await queue.enqueueBatch([
      { type: 'a', payload: {} },
      { type: 'b', payload: {} },
    ]);
    expect(await queue.countTasks({})).toBe(2);
  });

  it('stats() reports byStatus, total, deadCount, runningCount', async () => {
    await queue.enqueue({ type: 'test', payload: {} });
    const { id } = await queue.enqueue({ type: 'test', payload: {}, maxRetries: 1 });
    await queue.dequeue('worker-1');
    await queue.dequeue('worker-1');
    await queue.fail(id, 'boom'); // -> dead (1 >= 1)

    const stats = await queue.stats();
    expect(stats.total).toBe(2);
    expect(stats.deadCount).toBe(1);
    expect(stats.runningCount).toBe(1);
    expect(stats.enqueueCount).toBe(2);
    expect(stats.dequeueCount).toBe(2);
    expect(stats.failCount).toBe(1);
  });

  it('stats() oldestQueuedAgeMs is 0 with no queued tasks', async () => {
    const stats = await queue.stats();
    expect(stats.oldestQueuedAgeMs).toBe(0);
  });
});

describe('admin: purgeCompleted / requeue / deleteTasks', () => {
  let queue: TaskQueue;
  beforeEach(async () => {
    queue = freshQueue();
    await queue.open();
  });
  afterEach(async () => {
    await closeQuietly(queue);
  });

  it('purgeCompleted removes only completed tasks older than the threshold', async () => {
    vi.useFakeTimers();
    try {
      const { id: oldId } = await queue.enqueue({ type: 'test', payload: {} });
      await queue.dequeue('worker-1');
      await queue.complete(oldId, {});

      vi.advanceTimersByTime(10_000);

      const { id: newId } = await queue.enqueue({ type: 'test', payload: {} });
      await queue.dequeue('worker-1');
      await queue.complete(newId, {});

      const purged = await queue.purgeCompleted(5_000);
      expect(purged).toBe(1);
      expect(await queue.get(oldId)).toBeNull();
      expect(await queue.get(newId)).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('requeue resets a dead task back to queued', async () => {
    const { id } = await queue.enqueue({ type: 'test', payload: {}, maxRetries: 1 });
    await queue.dequeue('worker-1');
    await queue.fail(id, 'boom'); // -> dead
    await queue.requeue(id);
    const task = await queue.get(id);
    expect(task?.status).toBe(TaskStatus.Queued);
    expect(task?.dead).toBe(false);
    expect(task?.retryCount).toBe(0);
    expect(task?.error).toBeNull();
  });

  it('requeue throws TaskNotDeadError on a live task', async () => {
    const { id } = await queue.enqueue({ type: 'test', payload: {} });
    await expect(queue.requeue(id)).rejects.toBeInstanceOf(TaskNotDeadError);
  });

  it('requeue throws TaskNotFoundError for an unknown id', async () => {
    await expect(queue.requeue('missing')).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it('deleteTasks removes matching tasks and returns the count', async () => {
    await queue.enqueueBatch([
      { type: 'a', payload: {} },
      { type: 'a', payload: {} },
      { type: 'b', payload: {} },
    ]);
    const deleted = await queue.deleteTasks({ type: 'a' });
    expect(deleted).toBe(2);
    expect(await queue.countTasks({})).toBe(1);
  });

  it('deleteTasks throws QueueNotEmptyError if any matching task is running', async () => {
    await queue.enqueue({ type: 'test', payload: {} });
    await queue.dequeue('worker-1');
    await expect(queue.deleteTasks({ type: 'test' })).rejects.toBeInstanceOf(QueueNotEmptyError);
  });
});

describe('reaper — lease expiry', () => {
  it('re-queues an expired-lease task with retryCount+1 and backoff scheduling', async () => {
    vi.useFakeTimers();
    try {
      const queue = new SqliteTaskQueue({
        dbPath: ':memory:',
        heartbeatTimeoutMs: 1_000,
        autoRequeueExpired: false,
      });
      await queue.open();
      const { id } = await queue.enqueue({ type: 'test', payload: {}, maxRetries: 3 });
      await queue.dequeue('worker-1');
      vi.advanceTimersByTime(1_001); // lease expires
      queue.reap();
      const task = await queue.get(id);
      expect(task?.status).toBe(TaskStatus.Queued);
      expect(task?.retryCount).toBe(1);
      expect(task?.workerId).toBeNull();
      expect(task?.scheduledAt).not.toBeNull();
      await queue.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('marks the task dead once retries are exhausted via repeated lease expiry', async () => {
    vi.useFakeTimers();
    try {
      const queue = new SqliteTaskQueue({
        dbPath: ':memory:',
        heartbeatTimeoutMs: 1_000,
        autoRequeueExpired: false,
      });
      await queue.open();
      const { id } = await queue.enqueue({ type: 'test', payload: {}, maxRetries: 1 });
      await queue.dequeue('worker-1');
      vi.advanceTimersByTime(1_001);
      queue.reap(); // retryCount 0 -> 1, 1 >= 1 -> dead
      const task = await queue.get(id);
      expect(task?.dead).toBe(true);
      expect(task?.status).toBe(TaskStatus.Failed);
      expect(task?.error).toBe('lease expired');
      await queue.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('auto-runs via setInterval when autoRequeueExpired is true (default)', async () => {
    vi.useFakeTimers();
    try {
      const queue = new SqliteTaskQueue({
        dbPath: ':memory:',
        heartbeatTimeoutMs: 100,
        reaperIntervalMs: 50,
      });
      await queue.open();
      const { id } = await queue.enqueue({ type: 'test', payload: {}, maxRetries: 3 });
      await queue.dequeue('worker-1');
      await vi.advanceTimersByTimeAsync(200); // lease expires + at least one reaper tick
      const task = await queue.get(id);
      expect(task?.status).toBe(TaskStatus.Queued);
      expect(task?.retryCount).toBeGreaterThanOrEqual(1);
      await queue.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('kills a task whose ttlMs has been exceeded, independent of lease state', async () => {
    vi.useFakeTimers();
    try {
      const queue = new SqliteTaskQueue({
        dbPath: ':memory:',
        heartbeatTimeoutMs: 60_000, // lease far from expiring
        autoRequeueExpired: false,
      });
      await queue.open();
      const { id } = await queue.enqueue({ type: 'test', payload: {}, ttlMs: 500 });
      await queue.dequeue('worker-1');
      vi.advanceTimersByTime(600);
      queue.reap();
      const task = await queue.get(id);
      expect(task?.dead).toBe(true);
      expect(task?.status).toBe(TaskStatus.Failed);
      expect(task?.error).toBe('task timed out (ttl_ms exceeded)');
      await queue.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops running on close()', async () => {
    vi.useFakeTimers();
    try {
      const queue = new SqliteTaskQueue({ dbPath: ':memory:', reaperIntervalMs: 10 });
      await queue.open();
      await queue.close();
      // Should not throw even though timers may still be scheduled elsewhere in the runtime.
      await vi.advanceTimersByTimeAsync(100);
      expect(queue.isOpen).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('close() drain behaviour', () => {
  it('waits for running tasks to complete before closing', async () => {
    vi.useFakeTimers();
    try {
      const queue = freshQueue();
      await queue.open();
      const { id } = await queue.enqueue({ type: 'test', payload: {} });
      await queue.dequeue('worker-1');

      const closePromise = queue.close({ drainTimeoutMs: 5_000 });
      // Complete the task shortly after close() begins draining.
      await queue.complete(id, {});
      await vi.advanceTimersByTimeAsync(100);
      await closePromise;
      expect(queue.isOpen).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('throws TaskTimeoutError if a running task never completes within drainTimeoutMs', async () => {
    vi.useFakeTimers();
    try {
      const queue = freshQueue();
      await queue.open();
      await queue.enqueue({ type: 'test', payload: {} });
      await queue.dequeue('worker-1'); // left running forever

      const closePromise = queue.close({ drainTimeoutMs: 200 });
      const assertion = expect(closePromise).rejects.toBeInstanceOf(TaskTimeoutError);
      await vi.advanceTimersByTimeAsync(300);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
