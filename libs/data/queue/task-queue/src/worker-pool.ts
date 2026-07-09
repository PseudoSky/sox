// @adhd/sox-task-queue — WorkerPool implementation (SPEC §4)
import { randomUUID } from 'node:crypto';
import type { Task, WorkerPool, WorkerPoolConfig } from './types.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SqlitePoolWorkerPool implements WorkerPool {
  private _isRunning = false;
  private _activeCount = 0;
  private pollTimer: NodeJS.Timeout | null = null;
  private readonly workerId: string;
  private readonly inFlight = new Set<Promise<void>>();
  private readonly _stats = { tasksProcessed: 0, tasksFailed: 0, tasksTimedOut: 0 };

  /**
   * Tasks that `queue.dequeue()` already claimed (status='running' in the
   * DB, lease held) but for which we have no free concurrency slot yet.
   * `dequeue()` returns up to the queue's own `dequeueBatchSize`, which is
   * independent of this pool's `concurrency` — rather than either (a)
   * running all of them immediately (over-committing concurrency) or (b)
   * leaving them un-heartbeated (wasting their lease), we buffer them here
   * and heartbeat them until a slot frees up, then hand them to `runTask`.
   */
  private readonly pending: Task[] = [];
  private readonly pendingHeartbeats = new Map<string, NodeJS.Timeout>();

  constructor(private readonly config: WorkerPoolConfig) {
    this.workerId = config.workerName ?? randomUUID();
    if (config.autoStart !== false) {
      this.start();
    }
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  get activeCount(): number {
    return this._activeCount;
  }

  get stats(): { tasksProcessed: number; tasksFailed: number; tasksTimedOut: number } {
    return { ...this._stats };
  }

  start(): void {
    if (this._isRunning) return;
    this._isRunning = true;
    this.scheduleTick(0);
  }

  private scheduleTick(delayMs: number): void {
    if (!this._isRunning) return;
    this.pollTimer = setTimeout(() => {
      void this.tick();
    }, delayMs);
    this.pollTimer.unref?.();
  }

  private concurrency(): number {
    return this.config.concurrency ?? 1;
  }

  private heartbeatIntervalMs(): number {
    return this.config.heartbeatIntervalMs ?? 10_000;
  }

  private async tick(): Promise<void> {
    if (!this._isRunning) return;

    const spare = this.concurrency() - this._activeCount - this.pending.length;
    let fetchedAny = false;
    if (spare > 0) {
      let results: Awaited<ReturnType<WorkerPoolConfig['queue']['dequeue']>> = [];
      try {
        results = await this.config.queue.dequeue(this.workerId);
      } catch (err) {
        console.error('[task-queue] worker pool dequeue error:', err);
      }
      for (const { task } of results) {
        this.pending.push(task);
        this.startPendingHeartbeat(task);
      }
      fetchedAny = results.length > 0;
    }

    this.drainPending();

    // Only re-poll immediately when we just fetched a batch (there may be
    // more eligible tasks waiting right now). If we didn't fetch — either
    // because there was no spare capacity, or the queue had nothing
    // eligible — fall back to the normal poll interval. Backlog sitting in
    // `pending` because concurrency is full does NOT need the tick loop to
    // keep spinning: `runTask`'s `finally` calls `drainPending()` the
    // instant a slot frees, which is the event that actually matters. A
    // "pending.length > 0" condition here would busy-loop at 0ms forever
    // while concurrency stays saturated.
    if (fetchedAny) {
      this.scheduleTick(0);
    } else {
      this.scheduleTick(this.config.pollIntervalMs ?? 1_000);
    }
  }

  /** Promote buffered (already-claimed) tasks into active handlers as slots free up. */
  private drainPending(): void {
    while (this._activeCount < this.concurrency() && this.pending.length > 0) {
      const task = this.pending.shift();
      if (!task) break;
      this.stopPendingHeartbeat(task.id);
      this.runTask(task);
    }
  }

  private startPendingHeartbeat(task: Task): void {
    const timer: NodeJS.Timeout = setInterval(() => {
      this.config.queue.heartbeat(task.id).catch((err: unknown) => {
        console.warn(`[task-queue] heartbeat failed for buffered task ${task.id}:`, err);
      });
    }, this.heartbeatIntervalMs());
    timer.unref?.();
    this.pendingHeartbeats.set(task.id, timer);
  }

  private stopPendingHeartbeat(taskId: string): void {
    const timer = this.pendingHeartbeats.get(taskId);
    if (timer) {
      clearInterval(timer);
      this.pendingHeartbeats.delete(taskId);
    }
  }

  private runTask(task: Task): void {
    this._activeCount++;
    const hbTimer: NodeJS.Timeout = setInterval(() => {
      this.config.queue.heartbeat(task.id).catch((err: unknown) => {
        console.warn(`[task-queue] heartbeat failed for task ${task.id}:`, err);
      });
    }, this.heartbeatIntervalMs());
    hbTimer.unref?.();

    const run = (async (): Promise<void> => {
      try {
        await this.config.handler(task);
        await this.config.queue.complete(task.id);
        this._stats.tasksProcessed++;
      } catch (err) {
        this._stats.tasksFailed++;
        const message = err instanceof Error ? err.message : String(err);
        try {
          await this.config.queue.fail(task.id, message);
        } catch (failErr) {
          console.warn(
            `[task-queue] fail() call failed for task ${task.id} (task is now in an inconsistent state and must be reconciled manually):`,
            failErr,
          );
        }
      } finally {
        clearInterval(hbTimer);
        this._activeCount--;
        // A slot just freed — immediately promote any buffered backlog
        // rather than waiting for the next scheduled tick.
        this.drainPending();
      }
    })();

    this.inFlight.add(run);
    void run.finally(() => {
      this.inFlight.delete(run);
    });
  }

  async stop(): Promise<void> {
    if (!this._isRunning) return;
    this._isRunning = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = null;
    }

    // Buffered-but-not-yet-started tasks are abandoned like any other
    // in-flight work past the drain timeout: stop heartbeating them here so
    // their lease expires naturally and the queue's reaper reclaims them
    // (see SPEC §8 "Graceful shutdown behaviour").
    for (const taskId of this.pendingHeartbeats.keys()) {
      this.stopPendingHeartbeat(taskId);
    }
    this.pending.length = 0;

    const drainTimeoutMs = this.config.drainTimeoutMs ?? 30_000;
    const deadline = Date.now() + drainTimeoutMs;
    while (this.inFlight.size > 0 && Date.now() < deadline) {
      const remaining = Math.max(1, deadline - Date.now());
      await Promise.race([...this.inFlight, sleep(Math.min(50, remaining))]);
    }
    // Any tasks still in flight past the drain timeout are abandoned here —
    // their leases will expire naturally and the queue's reaper will
    // re-queue them (see SPEC §8 "Graceful shutdown behaviour").
  }
}

export function createWorkerPool(config: WorkerPoolConfig): WorkerPool {
  return new SqlitePoolWorkerPool(config);
}
