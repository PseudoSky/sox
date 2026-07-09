/**
 * @adhd/sox-task-queue — Scheduler tests
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createScheduler, createTaskQueue } from './index.js';
import { SchedulerEntryConflictError, SchedulerEntryNotFoundError } from './errors.js';
import type { Scheduler, TaskQueue } from './index.js';

describe('Scheduler', () => {
  let queue: TaskQueue;
  let scheduler: Scheduler;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    queue = createTaskQueue({ dbPath: ':memory:', autoRequeueExpired: false });
    await queue.open();
  });

  afterEach(async () => {
    await scheduler?.close();
    await queue.close();
    vi.useRealTimers();
  });

  it('resolveDbPath: derives the db path from a queue exposing .dbPath when config.dbPath is omitted', async () => {
    scheduler = createScheduler({ queue, autoStart: false });
    await expect(scheduler.open()).resolves.toBeUndefined();
  });

  it('throws synchronously if no dbPath can be resolved', () => {
    const fakeQueue = { enqueue: vi.fn() } as unknown as TaskQueue;
    expect(() => createScheduler({ queue: fakeQueue, autoStart: false })).toThrow();
  });

  it('register() creates an entry with a generated id and persisted defaults', async () => {
    scheduler = createScheduler({ queue, dbPath: ':memory:', autoStart: false });
    await scheduler.open();
    const entry = await scheduler.register({
      name: 'nightly-maintenance',
      taskType: 'maintenance',
      payload: { kind: 'vacuum' },
      cronExpression: '0 0 * * *',
      enabled: true,
    });
    expect(entry.id).toBeTruthy();
    expect(entry.name).toBe('nightly-maintenance');
    expect(entry.lastEnqueuedAt).toBeNull();
    expect(entry.lastError).toBeNull();
    expect(entry.created_at).toBeTruthy();
  });

  it('register() throws SchedulerEntryConflictError on duplicate name', async () => {
    scheduler = createScheduler({ queue, dbPath: ':memory:', autoStart: false });
    await scheduler.open();
    await scheduler.register({
      name: 'dup',
      taskType: 't',
      payload: {},
      cronExpression: '0 0 * * *',
      enabled: true,
    });
    await expect(
      scheduler.register({ name: 'dup', taskType: 't', payload: {}, cronExpression: '0 0 * * *', enabled: true }),
    ).rejects.toBeInstanceOf(SchedulerEntryConflictError);
  });

  it('get() returns null for an unknown id, the entry otherwise', async () => {
    scheduler = createScheduler({ queue, dbPath: ':memory:', autoStart: false });
    await scheduler.open();
    expect(await scheduler.get('missing')).toBeNull();
    const entry = await scheduler.register({
      name: 'x',
      taskType: 't',
      payload: {},
      cronExpression: '0 0 * * *',
      enabled: true,
    });
    expect(await scheduler.get(entry.id)).toEqual(entry);
  });

  it('list() returns all entries ordered by name', async () => {
    scheduler = createScheduler({ queue, dbPath: ':memory:', autoStart: false });
    await scheduler.open();
    await scheduler.register({ name: 'zeta', taskType: 't', payload: {}, cronExpression: '0 0 * * *', enabled: true });
    await scheduler.register({
      name: 'alpha',
      taskType: 't',
      payload: {},
      cronExpression: '0 0 * * *',
      enabled: true,
    });
    const entries = await scheduler.list();
    expect(entries.map((e) => e.name)).toEqual(['alpha', 'zeta']);
  });

  it('update() merges fields and bumps updated_at', async () => {
    scheduler = createScheduler({ queue, dbPath: ':memory:', autoStart: false });
    await scheduler.open();
    const entry = await scheduler.register({
      name: 'x',
      taskType: 't',
      payload: { a: 1 },
      cronExpression: '0 0 * * *',
      enabled: true,
    });
    vi.advanceTimersByTime(1_000);
    const updated = await scheduler.update(entry.id, { priority: 5, enabled: false });
    expect(updated.priority).toBe(5);
    expect(updated.enabled).toBe(false);
    expect(updated.payload).toEqual({ a: 1 }); // unchanged
    expect(new Date(updated.updated_at).getTime()).toBeGreaterThan(new Date(entry.updated_at).getTime());
  });

  it('update() throws SchedulerEntryNotFoundError for an unknown id', async () => {
    scheduler = createScheduler({ queue, dbPath: ':memory:', autoStart: false });
    await scheduler.open();
    await expect(scheduler.update('missing', { priority: 1 })).rejects.toBeInstanceOf(SchedulerEntryNotFoundError);
  });

  it('update() throws SchedulerEntryConflictError renaming into an existing name', async () => {
    scheduler = createScheduler({ queue, dbPath: ':memory:', autoStart: false });
    await scheduler.open();
    await scheduler.register({ name: 'a', taskType: 't', payload: {}, cronExpression: '0 0 * * *', enabled: true });
    const b = await scheduler.register({
      name: 'b',
      taskType: 't',
      payload: {},
      cronExpression: '0 0 * * *',
      enabled: true,
    });
    await expect(scheduler.update(b.id, { name: 'a' })).rejects.toBeInstanceOf(SchedulerEntryConflictError);
  });

  it('unregister() removes the entry; throws SchedulerEntryNotFoundError if missing', async () => {
    scheduler = createScheduler({ queue, dbPath: ':memory:', autoStart: false });
    await scheduler.open();
    const entry = await scheduler.register({
      name: 'x',
      taskType: 't',
      payload: {},
      cronExpression: '0 0 * * *',
      enabled: true,
    });
    await scheduler.unregister(entry.id);
    expect(await scheduler.get(entry.id)).toBeNull();
    await expect(scheduler.unregister(entry.id)).rejects.toBeInstanceOf(SchedulerEntryNotFoundError);
  });

  it('enable() toggles the enabled flag; throws SchedulerEntryNotFoundError if missing', async () => {
    scheduler = createScheduler({ queue, dbPath: ':memory:', autoStart: false });
    await scheduler.open();
    const entry = await scheduler.register({
      name: 'x',
      taskType: 't',
      payload: {},
      cronExpression: '0 0 * * *',
      enabled: true,
    });
    await scheduler.enable(entry.id, false);
    expect((await scheduler.get(entry.id))?.enabled).toBe(false);
    await expect(scheduler.enable('missing', true)).rejects.toBeInstanceOf(SchedulerEntryNotFoundError);
  });

  it('triggerNow() enqueues immediately regardless of cron schedule and updates lastEnqueuedAt', async () => {
    scheduler = createScheduler({ queue, dbPath: ':memory:', autoStart: false });
    await scheduler.open();
    const entry = await scheduler.register({
      name: 'x',
      taskType: 'my-task',
      payload: { hello: 'world' },
      cronExpression: '0 0 1 1 *', // once a year, far away
      enabled: true,
    });
    const taskId = await scheduler.triggerNow(entry.id);
    const task = await queue.get(taskId);
    expect(task).not.toBeNull();
    expect(task?.type).toBe('my-task');
    expect(task?.payload).toEqual({ hello: 'world' });
    const updatedEntry = await scheduler.get(entry.id);
    expect(updatedEntry?.lastEnqueuedAt).not.toBeNull();
  });

  it('triggerNow() throws SchedulerEntryNotFoundError for an unknown id', async () => {
    scheduler = createScheduler({ queue, dbPath: ':memory:', autoStart: false });
    await scheduler.open();
    await expect(scheduler.triggerNow('missing')).rejects.toBeInstanceOf(SchedulerEntryNotFoundError);
  });

  it('runOnStart fires the entry immediately on the NEXT open(), if it never fired before', async () => {
    // ':memory:' connections are each independent, so use a real temp file
    // to persist scheduler_entries across a close()+open() cycle and
    // exercise the "on open(), fire never-fired runOnStart entries" path.
    const dbPath = path.join(os.tmpdir(), `task-queue-scheduler-test-${process.pid}-${Date.now()}.sqlite`);
    try {
      const first = createScheduler({ queue, dbPath, autoStart: false });
      await first.open();
      await first.register({
        name: 'boot-task',
        taskType: 'boot',
        payload: {},
        cronExpression: '0 0 1 1 *',
        enabled: true,
        runOnStart: true,
      });
      // No task yet: register() does not fire runOnStart by itself, only open() does.
      expect(await queue.listTasks({ type: 'boot' })).toHaveLength(0);
      await first.close();

      scheduler = createScheduler({ queue, dbPath, autoStart: false });
      await scheduler.open();
      const tasks = await queue.listTasks({ type: 'boot' });
      expect(tasks.length).toBe(1);
    } finally {
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
    }
  });

  it('tick loop fires a due cron entry and advances lastEnqueuedAt', async () => {
    scheduler = createScheduler({ queue, dbPath: ':memory:', tickIntervalMs: 50 });
    await scheduler.open();
    await scheduler.register({
      name: 'every-second',
      taskType: 'tick-test',
      payload: {},
      cronExpression: '* * * * * *', // every second (6-part, seconds field)
      enabled: true,
    });
    await vi.advanceTimersByTimeAsync(1_200);
    const tasks = await queue.listTasks({ type: 'tick-test' });
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    const entry = (await scheduler.list())[0];
    expect(entry?.lastEnqueuedAt).not.toBeNull();
  });

  it('disables an entry whose cron has no further occurrences, logging a warning', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // System time is 2026-01-01; a cron pinned to year 2020 has no future runs.
    scheduler = createScheduler({ queue, dbPath: ':memory:', tickIntervalMs: 50 });
    await scheduler.open();
    await scheduler.register({
      name: 'long-expired',
      taskType: 'expired',
      payload: {},
      cronExpression: '0 0 0 1 1 * 2020',
      enabled: true,
    });
    await vi.advanceTimersByTimeAsync(100);
    const entry = (await scheduler.list())[0];
    expect(entry?.enabled).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('records lastError and does not throw when a cron expression is invalid', async () => {
    scheduler = createScheduler({ queue, dbPath: ':memory:', tickIntervalMs: 50 });
    await scheduler.open();
    await scheduler.register({
      name: 'bad-cron',
      taskType: 'bad',
      payload: {},
      cronExpression: 'not a cron',
      enabled: true,
    });
    await vi.advanceTimersByTimeAsync(100);
    const entry = (await scheduler.list())[0];
    expect(entry?.lastError).toContain('invalid cron expression');
  });

  it('isRunning / nextTickAt reflect the tick loop state', async () => {
    scheduler = createScheduler({ queue, dbPath: ':memory:', tickIntervalMs: 100 });
    await scheduler.open();
    expect(scheduler.isRunning).toBe(true);
    expect(scheduler.nextTickAt).not.toBeNull();
    await scheduler.close();
    expect(scheduler.isRunning).toBe(false);
    expect(scheduler.nextTickAt).toBeNull();
  });
});
