// @adhd/sox-task-queue — TaskQueue implementation (SPEC §3, §7, §8, §9)
import type { StoreAdapter, AdapterTransaction } from '@adhd/sox-store-adapter';
import { createSqliteAdapter } from '@adhd/sox-store-adapter';
import { randomUUID } from 'node:crypto';
import { applySchema } from './schema.js';
import { computeBackoffDelayMs } from './backoff.js';
import {
  QueueFullError,
  QueueNotEmptyError,
  TaskNotDeadError,
  TaskNotFoundError,
  TaskNotRunningError,
  TaskPermanentlyFailedError,
  TaskQueueNotOpenError,
  TaskQueueSystemError,
  TaskTimeoutError,
} from './errors.js';
import {
  TaskStatus,
  type DequeueResult,
  type EnqueueResult,
  type QueueStats,
  type Task,
  type TaskFilter,
  type TaskQueue,
  type TaskQueueConfig,
} from './types.js';

// ─── Raw DB row shape ────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  type: string;
  status: string;
  priority: number;
  payload: string;
  retry_count: number;
  max_retries: number;
  scheduled_at: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  dead: number;
  result: string | null;
  lease_expires_at: string | null;
  worker_id: string | null;
  ttl_ms: number | null;
  cancel_requested: number;
  client_request_id: string | null;
}

function rowToTask(row: TaskRow): Task {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = row.payload;
  }
  return {
    id: row.id,
    type: row.type,
    status: row.status as TaskStatus,
    priority: row.priority,
    payload,
    retryCount: row.retry_count,
    maxRetries: row.max_retries,
    scheduledAt: row.scheduled_at,
    created_at: row.created_at,
    started_at: row.started_at,
    completed_at: row.completed_at,
    error: row.error,
    dead: !!row.dead,
    clientRequestId: row.client_request_id,
    result: row.result,
    leaseExpiresAt: row.lease_expires_at,
    workerId: row.worker_id,
    ttlMs: row.ttl_ms,
  };
}

function isoNow(): string {
  return new Date().toISOString();
}

function isoPlus(ms: number): string {
  return new Date(Date.now() + ms).toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const ALL_STATUSES: TaskStatus[] = [
  TaskStatus.Queued,
  TaskStatus.Running,
  TaskStatus.Completed,
  TaskStatus.Failed,
  TaskStatus.Cancelled,
  TaskStatus.Scheduled,
];

// ─── Filter -> SQL ───────────────────────────────────────────────────────────

interface WhereClause {
  sql: string;
  params: unknown[];
}

function buildWhereClause(filter?: TaskFilter): WhereClause {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (filter?.status !== undefined) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    if (statuses.length > 0) {
      clauses.push(`status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
  }
  if (filter?.type !== undefined) {
    const types = Array.isArray(filter.type) ? filter.type : [filter.type];
    if (types.length > 0) {
      clauses.push(`type IN (${types.map(() => '?').join(',')})`);
      params.push(...types);
    }
  }
  if (filter?.priorityMin !== undefined) {
    clauses.push('priority >= ?');
    params.push(filter.priorityMin);
  }
  if (filter?.priorityMax !== undefined) {
    clauses.push('priority <= ?');
    params.push(filter.priorityMax);
  }
  if (filter?.dead !== undefined) {
    clauses.push('dead = ?');
    params.push(filter.dead ? 1 : 0);
  }
  if (filter?.createdAfter !== undefined) {
    clauses.push('created_at > ?');
    params.push(filter.createdAfter);
  }
  if (filter?.createdBefore !== undefined) {
    clauses.push('created_at < ?');
    params.push(filter.createdBefore);
  }
  if (filter?.scheduledBefore !== undefined) {
    clauses.push('scheduled_at IS NOT NULL AND scheduled_at <= ?');
    params.push(filter.scheduledBefore);
  }

  const sql = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
  return { sql, params };
}

const ORDER_COLUMN: Record<NonNullable<TaskFilter['orderBy']>, string> = {
  created_at: 'created_at',
  priority: 'priority',
  scheduled_at: 'scheduled_at',
};

// ─── SqliteTaskQueue ─────────────────────────────────────────────────────────

export class SqliteTaskQueue implements TaskQueue {
  /** Path to the underlying SQLite database file. Exposed so a Scheduler can share the connection target (see SchedulerConfig.dbPath reconciliation). */
  public readonly dbPath: string;

  private adapter: StoreAdapter | null = null;
  private ownAdapter = false;
  private _isOpen = false;
  private reaperTimer: NodeJS.Timeout | null = null;

  private readonly counters = {
    enqueueCount: 0,
    dequeueCount: 0,
    completeCount: 0,
    failCount: 0,
    heartbeatMisses: 0,
  };

  constructor(private readonly config: TaskQueueConfig) {
    this.dbPath = config.dbPath;
  }

  get isOpen(): boolean {
    return this._isOpen;
  }

  /** Expose the StoreAdapter for co-located schema consumers (e.g. Scheduler on ':memory:'). Only valid while open. */
  getAdapter(): StoreAdapter {
    this.assertOpen();
    return this.adapter as StoreAdapter;
  }

  async open(): Promise<void> {
    if (this._isOpen) return;
    try {
      if (this.config.adapter) {
        this.adapter = this.config.adapter;
        this.ownAdapter = false;
      } else {
        this.adapter = createSqliteAdapter({ dbPath: this.config.dbPath });
        this.ownAdapter = true;
      }
      await applySchema(this.adapter);
    } catch (err) {
      throw new TaskQueueSystemError('failed to open task queue database', err as Error);
    }
    this._isOpen = true;
    if (this.config.autoRequeueExpired !== false) {
      this.startReaper();
    }
  }

  async close(opts?: { drainTimeoutMs?: number }): Promise<void> {
    if (!this._isOpen) return;
    const drainTimeoutMs = opts?.drainTimeoutMs ?? 30_000;
    const deadline = Date.now() + drainTimeoutMs;
    while ((await this.countRunning()) > 0 && Date.now() < deadline) {
      await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    }
    if ((await this.countRunning()) > 0) {
      throw new TaskTimeoutError(
        `task queue shutdown timed out after ${drainTimeoutMs}ms with running tasks remaining`,
        drainTimeoutMs,
      );
    }
    this.stopReaper();
    if (this.ownAdapter) {
      await this.adapter?.close();
    }
    this.adapter = null;
    this._isOpen = false;
  }

  // ── internal helpers ──────────────────────────────────────────────────────

  private assertOpen(): void {
    if (!this._isOpen || !this.adapter) throw new TaskQueueNotOpenError();
  }

  private async countRunning(): Promise<number> {
    if (!this.adapter) return 0;
    const row = await this.adapter
      .executeGet<{ n: number }>(`SELECT COUNT(*) as n FROM tasks WHERE status = ?`, [TaskStatus.Running]);
    return row?.n ?? 0;
  }

  private async getRow(taskId: string): Promise<TaskRow | undefined> {
    return await this.adapter!.executeGet<TaskRow>('SELECT * FROM tasks WHERE id = ?', [taskId]) ?? undefined;
  }

  private async countLiveDepth(): Promise<number> {
    const row = await this.adapter!.executeGet<{ n: number }>(
      `SELECT COUNT(*) as n FROM tasks WHERE status IN ('queued','scheduled','running')`,
    );
    return row?.n ?? 0;
  }

  private startReaper(): void {
    const intervalMs = this.config.reaperIntervalMs ?? 5_000;
    this.reaperTimer = setInterval(async () => {
      try {
        await this.reap();
      } catch (err) {
        console.error('[task-queue] reaper tick failed:', err);
      }
    }, intervalMs);
    this.reaperTimer.unref?.();
  }

  private stopReaper(): void {
    if (this.reaperTimer) {
      clearInterval(this.reaperTimer);
      this.reaperTimer = null;
    }
  }

  /** Reclaim tasks whose lease has expired or whose ttlMs has elapsed. Exposed for tests. */
  async reap(): Promise<void> {
    if (!this.adapter) return;
    const a = this.adapter;
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    // 1. TTL kills — independent of lease state.
    const ttlResult = await a.executeAll<TaskRow>(
      `SELECT * FROM tasks WHERE status = 'running' AND ttl_ms IS NOT NULL AND started_at IS NOT NULL`,
    );
    for (const row of ttlResult.rows) {
      const startedMs = new Date(row.started_at as string).getTime();
      if (row.ttl_ms !== null && nowMs - startedMs >= row.ttl_ms) {
        await a.executeRun(
          `UPDATE tasks SET dead = 1, status = 'failed', completed_at = ?, error = ?, lease_expires_at = NULL, worker_id = NULL WHERE id = ? AND status = 'running'`,
          [nowIso, 'task timed out (ttl_ms exceeded)', row.id],
        );
        this.counters.failCount++;
        await this.notifyDead(row.id);
      }
    }

    // 2. Lease-expiry re-queue / dead-letter.
    const expiredResult = await a.executeAll<TaskRow>(
      `SELECT * FROM tasks WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?`,
      [nowIso],
    );
    for (const row of expiredResult.rows) {
      const heartbeatTimeoutMs = this.config.heartbeatTimeoutMs ?? 30_000;
      const leaseExpiredMs = nowMs - new Date(row.lease_expires_at as string).getTime();
      if (leaseExpiredMs > heartbeatTimeoutMs * 5) {
        console.warn(
          `[task-queue] reaper: task ${row.id} lease has been expired for ${leaseExpiredMs}ms (> 5x heartbeatTimeout) — possible systemic issue`,
        );
      }

      const newRetryCount = row.retry_count + 1;
      if (newRetryCount >= row.max_retries) {
        await a.executeRun(
          `UPDATE tasks SET dead = 1, status = 'failed', completed_at = ?, error = ?, retry_count = ?, lease_expires_at = NULL, worker_id = NULL WHERE id = ? AND status = 'running'`,
          [nowIso, 'lease expired', newRetryCount, row.id],
        );
        this.counters.failCount++;
        await this.notifyDead(row.id);
      } else {
        const backoffMs = computeBackoffDelayMs(row.retry_count);
        const scheduledAt = new Date(nowMs + backoffMs).toISOString();
        await a.executeRun(
          `UPDATE tasks SET status = 'queued', retry_count = ?, scheduled_at = ?, error = ?, lease_expires_at = NULL, worker_id = NULL, started_at = NULL WHERE id = ? AND status = 'running'`,
          [newRetryCount, scheduledAt, 'lease expired', row.id],
        );
      }
      this.counters.heartbeatMisses++;
    }
  }

  private async notifyDead(taskId: string): Promise<void> {
    if (!this.config.onDead) return;
    const row = await this.getRow(taskId);
    if (!row) return;
    try {
      this.config.onDead(rowToTask(row));
    } catch (err) {
      console.warn('[task-queue] onDead callback threw:', err);
    }
  }

  // ── Enqueue ────────────────────────────────────────────────────────────────

  private async enqueueOne(
    task: Partial<Task> & { type: string; payload: unknown },
    tx?: AdapterTransaction,
  ): Promise<EnqueueResult> {
    const a = tx ?? this.adapter!;
    const maxQueueDepth = this.config.maxQueueDepth ?? 0;
    if (maxQueueDepth > 0) {
      const depth = await this.countLiveDepth();
      if (depth >= maxQueueDepth) {
        throw new QueueFullError(depth, maxQueueDepth);
      }
    }

    const clientRequestId = task.clientRequestId ?? null;
    if (clientRequestId) {
      const existing = await a.executeGet<{ task_id: string }>(
        'SELECT task_id FROM request_ledger WHERE client_request_id = ?',
        [clientRequestId],
      );
      if (existing) {
        return { id: existing.task_id, deduplicated: true, isNew: false };
      }
    }

    const id = task.id ?? randomUUID();
    const now = isoNow();
    const maxRetries = task.maxRetries ?? this.config.defaultMaxRetries ?? 3;
    const priority = task.priority ?? 0;
    const scheduledAt = task.scheduledAt ?? null;
    const ttlMs = task.ttlMs ?? this.config.defaultTtlMs ?? null;
    const status = scheduledAt && scheduledAt > now ? TaskStatus.Scheduled : TaskStatus.Queued;

    await a.executeRun(
      `INSERT INTO tasks (id, type, status, priority, payload, retry_count, max_retries, scheduled_at, created_at, ttl_ms, client_request_id)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
      [id, task.type, status, priority, JSON.stringify(task.payload), maxRetries, scheduledAt, now, ttlMs, clientRequestId],
    );

    if (clientRequestId) {
      const info = await a.executeRun(
        `INSERT INTO request_ledger (client_request_id, task_id, t_created) VALUES (?, ?, ?) ON CONFLICT(client_request_id) DO NOTHING`,
        [clientRequestId, id, now],
      );
      if (info.rowsAffected === 0) {
        await a.executeRun('DELETE FROM tasks WHERE id = ?', [id]);
        const existing = await a.executeGet<{ task_id: string }>(
          'SELECT task_id FROM request_ledger WHERE client_request_id = ?',
          [clientRequestId],
        );
        return { id: existing!.task_id, deduplicated: true, isNew: false };
      }
    }

    this.counters.enqueueCount++;
    return { id, deduplicated: false, isNew: true };
  }

  async enqueue(task: Partial<Task> & { type: string; payload: unknown }): Promise<EnqueueResult> {
    this.assertOpen();
    try {
      return await this.adapter!.transaction(async (tx) => this.enqueueOne(task, tx));
    } catch (err) {
      if (err instanceof QueueFullError) throw err;
      throw new TaskQueueSystemError('enqueue failed', err as Error);
    }
  }

  async enqueueBatch(
    tasks: Array<Partial<Task> & { type: string; payload: unknown }>,
  ): Promise<EnqueueResult[]> {
    this.assertOpen();
    try {
      return await this.adapter!.transaction(async (tx) => {
        const results: EnqueueResult[] = [];
        for (const t of tasks) {
          results.push(await this.enqueueOne(t, tx));
        }
        return results;
      });
    } catch (err) {
      if (err instanceof QueueFullError) throw err;
      throw new TaskQueueSystemError('enqueueBatch failed', err as Error);
    }
  }

  // ── Dequeue ──────────────────────────────────────────────────────────────

  async dequeue(workerId: string): Promise<DequeueResult[]> {
    this.assertOpen();
    const batchSize = this.config.dequeueBatchSize ?? 10;
    const now = isoNow();
    const leaseExpiresAt = isoPlus(this.config.heartbeatTimeoutMs ?? 30_000);
    let rows: TaskRow[];
    try {
      const result = await this.adapter!.executeAll<TaskRow>(
        `UPDATE tasks
         SET status = 'running', started_at = ?, lease_expires_at = ?, worker_id = ?
         WHERE id IN (
           SELECT id FROM tasks
           WHERE status IN ('queued', 'scheduled')
             AND (scheduled_at IS NULL OR scheduled_at <= ?)
           ORDER BY priority DESC, created_at ASC
           LIMIT ?
         )
         RETURNING *`,
        [now, leaseExpiresAt, workerId, now, batchSize],
      );
      rows = result.rows;
    } catch (err) {
      throw new TaskQueueSystemError('dequeue failed', err as Error);
    }
    // Claim order is guaranteed by the subquery; RETURNING order is not
    // guaranteed by SQLite, so re-sort defensively to match the documented
    // priority DESC, created_at ASC contract.
    rows.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority;
      return a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : 0;
    });
    this.counters.dequeueCount += rows.length;
    return rows.map((row) => ({ task: rowToTask(row) }));
  }

  // ── Completion ───────────────────────────────────────────────────────────

  async complete(taskId: string, result?: unknown): Promise<void> {
    this.assertOpen();
    const row = await this.getRow(taskId);
    if (!row) throw new TaskNotFoundError(taskId);
    if (row.status !== TaskStatus.Running) throw new TaskNotRunningError(taskId, row.status);
    const now = isoNow();
    const resultJson = result === undefined ? null : JSON.stringify(result);
    await this.adapter!.executeRun(
      `UPDATE tasks SET status = 'completed', completed_at = ?, result = ?, lease_expires_at = NULL, worker_id = NULL WHERE id = ?`,
      [now, resultJson, taskId],
    );
    this.counters.completeCount++;
  }

  async fail(taskId: string, error: string): Promise<void> {
    this.assertOpen();
    const row = await this.getRow(taskId);
    if (!row) throw new TaskNotFoundError(taskId);
    if (row.dead) throw new TaskPermanentlyFailedError(taskId, row.retry_count);
    if (row.status !== TaskStatus.Running) throw new TaskNotRunningError(taskId, row.status);

    const newRetryCount = row.retry_count + 1;
    const now = isoNow();
    if (newRetryCount >= row.max_retries) {
      await this.adapter!.executeRun(
        `UPDATE tasks SET status = 'failed', dead = 1, completed_at = ?, error = ?, retry_count = ?, lease_expires_at = NULL, worker_id = NULL WHERE id = ?`,
        [now, error, newRetryCount, taskId],
      );
      this.counters.failCount++;
      await this.notifyDead(taskId);
    } else {
      const backoffMs = computeBackoffDelayMs(row.retry_count);
      const scheduledAt = isoPlus(backoffMs);
      await this.adapter!.executeRun(
        `UPDATE tasks SET status = 'queued', retry_count = ?, scheduled_at = ?, error = ?, lease_expires_at = NULL, worker_id = NULL, started_at = NULL WHERE id = ?`,
        [newRetryCount, scheduledAt, error, taskId],
      );
    }
  }

  // ── Heartbeat ────────────────────────────────────────────────────────────

  async heartbeat(taskId: string): Promise<boolean> {
    this.assertOpen();
    const row = await this.getRow(taskId);
    if (!row) throw new TaskNotFoundError(taskId);
    if (row.status !== TaskStatus.Running) return false;
    if (row.lease_expires_at && new Date(row.lease_expires_at).getTime() <= Date.now()) return false;
    const leaseExpiresAt = isoPlus(this.config.heartbeatTimeoutMs ?? 30_000);
    const info = await this.adapter!.executeRun(
      `UPDATE tasks SET lease_expires_at = ? WHERE id = ? AND status = 'running'`,
      [leaseExpiresAt, taskId],
    );
    return info.rowsAffected > 0;
  }

  // ── Cancellation ─────────────────────────────────────────────────────────

  async cancel(taskId: string): Promise<boolean> {
    this.assertOpen();
    const row = await this.getRow(taskId);
    if (!row) throw new TaskNotFoundError(taskId);
    if (row.status === TaskStatus.Queued || row.status === TaskStatus.Scheduled) {
      await this.adapter!.executeRun(
        `UPDATE tasks SET status = 'cancelled', completed_at = ? WHERE id = ?`,
        [isoNow(), taskId],
      );
      return true;
    }
    if (row.status === TaskStatus.Running) {
      await this.adapter!.executeRun(`UPDATE tasks SET cancel_requested = 1 WHERE id = ?`, [taskId]);
      return true;
    }
    return false;
  }

  async isCancelled(taskId: string): Promise<boolean> {
    this.assertOpen();
    const row = await this.getRow(taskId);
    if (!row) throw new TaskNotFoundError(taskId);
    return !!row.cancel_requested;
  }

  // ── Query ────────────────────────────────────────────────────────────────

  async get(taskId: string): Promise<Task | null> {
    this.assertOpen();
    const row = await this.getRow(taskId);
    return row ? rowToTask(row) : null;
  }

  async listTasks(filter?: TaskFilter): Promise<Task[]> {
    this.assertOpen();
    const { sql: whereSql, params } = buildWhereClause(filter);
    const orderBy = ORDER_COLUMN[filter?.orderBy ?? 'created_at'];
    const orderDir = filter?.orderDir === 'desc' ? 'DESC' : 'ASC';
    let query = `SELECT * FROM tasks${whereSql} ORDER BY ${orderBy} ${orderDir}`;
    const allParams = [...params];
    if (filter?.limit !== undefined) {
      query += ' LIMIT ?';
      allParams.push(filter.limit);
      if (filter?.offset !== undefined) {
        query += ' OFFSET ?';
        allParams.push(filter.offset);
      }
    } else if (filter?.offset !== undefined) {
      query += ' LIMIT -1 OFFSET ?';
      allParams.push(filter.offset);
    }
    const result = await this.adapter!.executeAll<TaskRow>(query, allParams);
    return result.rows.map(rowToTask);
  }

  async countTasks(filter?: TaskFilter): Promise<number> {
    this.assertOpen();
    const { sql: whereSql, params } = buildWhereClause(filter);
    const row = await this.adapter!.executeGet<{ n: number }>(
      `SELECT COUNT(*) as n FROM tasks${whereSql}`,
      params,
    );
    return row?.n ?? 0;
  }

  async stats(): Promise<QueueStats> {
    this.assertOpen();
    const a = this.adapter!;
    const byStatus = {} as Record<TaskStatus, number>;
    for (const status of ALL_STATUSES) {
      const row = await a.executeGet<{ n: number }>(
        'SELECT COUNT(*) as n FROM tasks WHERE status = ?',
        [status],
      );
      byStatus[status] = row?.n ?? 0;
    }
    const total = ALL_STATUSES.reduce((sum, s) => sum + (byStatus[s] ?? 0), 0);
    const deadRow = await a.executeGet<{ n: number }>('SELECT COUNT(*) as n FROM tasks WHERE dead = 1');
    const runningCount = byStatus[TaskStatus.Running] ?? 0;

    const latencyRow = await a.executeGet<{ avgMs: number | null }>(
      `SELECT AVG((julianday(completed_at) - julianday(started_at)) * 86400000.0) as avgMs
       FROM tasks WHERE status = 'completed' AND started_at IS NOT NULL AND completed_at IS NOT NULL`,
    );

    const retryResult = await a.executeAll<{ retryCount: number; n: number }>(
      `SELECT retry_count as retryCount, COUNT(*) as n FROM tasks
       WHERE status IN ('queued','running','scheduled') GROUP BY retry_count`,
    );
    const retryDistribution: Record<number, number> = {};
    for (const r of retryResult.rows) retryDistribution[r.retryCount] = r.n;

    const oldestQueuedRow = await a.executeGet<{ createdAt: string }>(
      `SELECT created_at as createdAt FROM tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`,
    );
    const oldestQueuedAgeMs = oldestQueuedRow
      ? Date.now() - new Date(oldestQueuedRow.createdAt).getTime()
      : 0;

    return {
      byStatus,
      total,
      deadCount: deadRow?.n ?? 0,
      runningCount,
      avgProcessingLatencyMs: latencyRow?.avgMs ?? 0,
      retryDistribution,
      oldestQueuedAgeMs,
      heartbeatMisses: this.counters.heartbeatMisses,
      enqueueCount: this.counters.enqueueCount,
      dequeueCount: this.counters.dequeueCount,
      completeCount: this.counters.completeCount,
      failCount: this.counters.failCount,
    };
  }

  // ── Admin / Maintenance ──────────────────────────────────────────────────

  async purgeCompleted(olderThanMs: number): Promise<number> {
    this.assertOpen();
    const cutoff = isoPlus(-olderThanMs);
    const info = await this.adapter!.executeRun(
      `DELETE FROM tasks WHERE status = 'completed' AND completed_at IS NOT NULL AND completed_at <= ?`,
      [cutoff],
    );
    return info.rowsAffected;
  }

  async requeue(taskId: string): Promise<void> {
    this.assertOpen();
    const row = await this.getRow(taskId);
    if (!row) throw new TaskNotFoundError(taskId);
    if (!row.dead) throw new TaskNotDeadError(taskId, row.status);
    await this.adapter!.executeRun(
      `UPDATE tasks SET status = 'queued', dead = 0, retry_count = 0, error = NULL, completed_at = NULL, scheduled_at = NULL WHERE id = ?`,
      [taskId],
    );
  }

  async deleteTasks(filter: TaskFilter): Promise<number> {
    this.assertOpen();
    const { sql: whereSql, params } = buildWhereClause(filter);
    const runningWhere = whereSql
      ? `${whereSql} AND status = 'running'`
      : ` WHERE status = 'running'`;
    const runningRow = await this.adapter!.executeGet<{ n: number }>(
      `SELECT COUNT(*) as n FROM tasks${runningWhere}`,
      params,
    );
    if ((runningRow?.n ?? 0) > 0) throw new QueueNotEmptyError(runningRow!.n);
    const info = await this.adapter!.executeRun(`DELETE FROM tasks${whereSql}`, params);
    return info.rowsAffected;
  }
}

export function createTaskQueue(config: TaskQueueConfig): TaskQueue {
  return new SqliteTaskQueue(config);
}
