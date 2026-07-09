// @adhd/sox-task-queue — Scheduler implementation (SPEC §5)
import Database from 'better-sqlite3';
import { Cron } from 'croner';
import { randomUUID } from 'node:crypto';
import { applySchema } from './schema.js';
import { SchedulerEntryConflictError, SchedulerEntryNotFoundError } from './errors.js';
import type { Scheduler, SchedulerConfig, ScheduledEntry } from './types.js';

interface SchedulerEntryRow {
  id: string;
  name: string;
  task_type: string;
  payload: string;
  cron_expression: string;
  priority: number;
  max_retries: number;
  ttl_ms: number | null;
  run_on_start: number;
  enabled: number;
  created_at: string;
  updated_at: string;
  last_enqueued_at: string | null;
  last_error: string | null;
}

function rowToEntry(row: SchedulerEntryRow): ScheduledEntry {
  let payload: unknown;
  try {
    payload = JSON.parse(row.payload);
  } catch {
    payload = row.payload;
  }
  return {
    id: row.id,
    name: row.name,
    taskType: row.task_type,
    payload,
    cronExpression: row.cron_expression,
    priority: row.priority,
    maxRetries: row.max_retries,
    ttlMs: row.ttl_ms,
    runOnStart: !!row.run_on_start,
    enabled: !!row.enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
    lastEnqueuedAt: row.last_enqueued_at,
    lastError: row.last_error,
  };
}

/**
 * Spec reconciliation: §5's `SchedulerConfig` omits `dbPath`, but
 * `Scheduler.open()` documents "Open the scheduler database" and §6 defines
 * `scheduler_entries` in the same DDL block as `tasks`. We resolve the path
 * by preferring an explicit `config.dbPath`, falling back to the `dbPath`
 * property that `SqliteTaskQueue` exposes on its concrete class (duck-typed
 * here so the `Scheduler` never needs to import `SqliteTaskQueue` and the
 * pinned `TaskQueue` interface stays untouched).
 */
function resolveDbPath(config: SchedulerConfig): string {
  if (config.dbPath) return config.dbPath;
  const maybe = config.queue as unknown as { dbPath?: unknown };
  if (typeof maybe.dbPath === 'string' && maybe.dbPath.length > 0) return maybe.dbPath;
  throw new Error(
    '[task-queue] Scheduler requires a dbPath: pass SchedulerConfig.dbPath explicitly, or ' +
      'use a queue created via createTaskQueue()/SqliteTaskQueue which exposes .dbPath.',
  );
}

class SqliteScheduler implements Scheduler {
  private db: InstanceType<typeof Database> | null = null;
  private _isRunning = false;
  private tickTimer: NodeJS.Timeout | null = null;
  private _nextTickAt: string | null = null;
  private readonly dbPath: string;

  constructor(private readonly config: SchedulerConfig) {
    this.dbPath = resolveDbPath(config);
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  get nextTickAt(): string | null {
    return this._nextTickAt;
  }

  async open(): Promise<void> {
    if (this.db) return;
    this.db = new Database(this.dbPath);
    applySchema(this.db);

    // runOnStart: fire entries that have never fired yet, once, on open().
    const neverFired = this.db
      .prepare(`SELECT * FROM scheduler_entries WHERE enabled = 1 AND run_on_start = 1 AND last_enqueued_at IS NULL`)
      .all() as SchedulerEntryRow[];
    for (const row of neverFired) {
      await this.fireEntry(row);
    }

    if (this.config.autoStart !== false) {
      this.start();
    }
  }

  async close(): Promise<void> {
    this.stop();
    this.db?.close();
    this.db = null;
  }

  private start(): void {
    if (this._isRunning) return;
    this._isRunning = true;
    this.scheduleTick();
  }

  private stop(): void {
    this._isRunning = false;
    if (this.tickTimer) {
      clearTimeout(this.tickTimer);
      this.tickTimer = null;
    }
    this._nextTickAt = null;
  }

  private scheduleTick(): void {
    if (!this._isRunning) return;
    const tickIntervalMs = this.config.tickIntervalMs ?? 1_000;
    this._nextTickAt = new Date(Date.now() + tickIntervalMs).toISOString();
    this.tickTimer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleTick());
    }, tickIntervalMs);
    this.tickTimer.unref?.();
  }

  private async tick(): Promise<void> {
    if (!this.db) return;
    const rows = this.db
      .prepare(`SELECT * FROM scheduler_entries WHERE enabled = 1`)
      .all() as SchedulerEntryRow[];
    const now = Date.now();
    for (const row of rows) {
      let cron: Cron;
      try {
        cron = new Cron(row.cron_expression, { paused: true, unref: true });
      } catch (err) {
        this.recordError(row.id, `invalid cron expression: ${(err as Error).message}`);
        continue;
      }
      const reference = row.last_enqueued_at ? new Date(row.last_enqueued_at) : new Date(row.created_at);
      const next = cron.nextRun(reference);
      if (next === null) {
        // Expired cron (e.g. a one-shot date pattern already in the past
        // with no more occurrences): disable with a logged warning, per
        // SPEC §5 tick algorithm.
        console.warn(
          `[task-queue] scheduler: entry '${row.name}' (${row.id}) has no further cron occurrences — disabling`,
        );
        this.db
          .prepare(`UPDATE scheduler_entries SET enabled = 0, updated_at = ? WHERE id = ?`)
          .run(new Date().toISOString(), row.id);
        continue;
      }
      if (next.getTime() <= now) {
        await this.fireEntry(row);
      }
    }
  }

  private async fireEntry(row: SchedulerEntryRow): Promise<void> {
    if (!this.db) return;
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = row.payload;
    }
    try {
      await this.config.queue.enqueue({
        type: row.task_type,
        payload,
        priority: row.priority,
        maxRetries: row.max_retries,
        ttlMs: row.ttl_ms,
      });
      this.db
        .prepare(`UPDATE scheduler_entries SET last_enqueued_at = ?, last_error = NULL, updated_at = ? WHERE id = ?`)
        .run(new Date().toISOString(), new Date().toISOString(), row.id);
    } catch (err) {
      this.recordError(row.id, err instanceof Error ? err.message : String(err));
    }
  }

  private recordError(id: string, message: string): void {
    if (!this.db) return;
    console.warn(`[task-queue] scheduler: enqueue failed for entry ${id}: ${message}`);
    this.db
      .prepare(`UPDATE scheduler_entries SET last_error = ?, updated_at = ? WHERE id = ?`)
      .run(message, new Date().toISOString(), id);
  }

  private assertOpen(): void {
    if (!this.db) throw new Error('[task-queue] scheduler is not open');
  }

  private getRow(id: string): SchedulerEntryRow | undefined {
    return this.db!.prepare('SELECT * FROM scheduler_entries WHERE id = ?').get(id) as
      | SchedulerEntryRow
      | undefined;
  }

  async register(
    entry: Omit<ScheduledEntry, 'id' | 'created_at' | 'updated_at' | 'lastEnqueuedAt' | 'lastError'>,
  ): Promise<ScheduledEntry> {
    this.assertOpen();
    const existing = this.db!
      .prepare('SELECT id FROM scheduler_entries WHERE name = ?')
      .get(entry.name) as { id: string } | undefined;
    if (existing) throw new SchedulerEntryConflictError(entry.name);

    const id = randomUUID();
    const now = new Date().toISOString();
    this.db!
      .prepare(
        `INSERT INTO scheduler_entries
           (id, name, task_type, payload, cron_expression, priority, max_retries, ttl_ms, run_on_start, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        entry.name,
        entry.taskType,
        JSON.stringify(entry.payload),
        entry.cronExpression,
        entry.priority ?? this.config.defaultPriority ?? 0,
        entry.maxRetries ?? this.config.defaultMaxRetries ?? 0,
        entry.ttlMs ?? null,
        entry.runOnStart ? 1 : 0,
        entry.enabled ? 1 : 0,
        now,
        now,
      );
    return rowToEntry(this.getRow(id)!);
  }

  async update(id: string, entry: Partial<ScheduledEntry>): Promise<ScheduledEntry> {
    this.assertOpen();
    const existing = this.getRow(id);
    if (!existing) throw new SchedulerEntryNotFoundError(id);
    if (entry.name && entry.name !== existing.name) {
      const conflict = this.db!
        .prepare('SELECT id FROM scheduler_entries WHERE name = ? AND id != ?')
        .get(entry.name, id) as { id: string } | undefined;
      if (conflict) throw new SchedulerEntryConflictError(entry.name);
    }

    const merged: SchedulerEntryRow = {
      ...existing,
      name: entry.name ?? existing.name,
      task_type: entry.taskType ?? existing.task_type,
      payload: entry.payload !== undefined ? JSON.stringify(entry.payload) : existing.payload,
      cron_expression: entry.cronExpression ?? existing.cron_expression,
      priority: entry.priority ?? existing.priority,
      max_retries: entry.maxRetries ?? existing.max_retries,
      ttl_ms: entry.ttlMs !== undefined ? entry.ttlMs : existing.ttl_ms,
      run_on_start: entry.runOnStart !== undefined ? (entry.runOnStart ? 1 : 0) : existing.run_on_start,
      enabled: entry.enabled !== undefined ? (entry.enabled ? 1 : 0) : existing.enabled,
      updated_at: new Date().toISOString(),
    };

    this.db!
      .prepare(
        `UPDATE scheduler_entries SET
           name = ?, task_type = ?, payload = ?, cron_expression = ?, priority = ?,
           max_retries = ?, ttl_ms = ?, run_on_start = ?, enabled = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        merged.name,
        merged.task_type,
        merged.payload,
        merged.cron_expression,
        merged.priority,
        merged.max_retries,
        merged.ttl_ms,
        merged.run_on_start,
        merged.enabled,
        merged.updated_at,
        id,
      );
    return rowToEntry(this.getRow(id)!);
  }

  async unregister(id: string): Promise<void> {
    this.assertOpen();
    const existing = this.getRow(id);
    if (!existing) throw new SchedulerEntryNotFoundError(id);
    this.db!.prepare('DELETE FROM scheduler_entries WHERE id = ?').run(id);
  }

  async enable(id: string, enabled: boolean): Promise<void> {
    this.assertOpen();
    const existing = this.getRow(id);
    if (!existing) throw new SchedulerEntryNotFoundError(id);
    this.db!
      .prepare('UPDATE scheduler_entries SET enabled = ?, updated_at = ? WHERE id = ?')
      .run(enabled ? 1 : 0, new Date().toISOString(), id);
  }

  async get(id: string): Promise<ScheduledEntry | null> {
    this.assertOpen();
    const row = this.getRow(id);
    return row ? rowToEntry(row) : null;
  }

  async list(): Promise<ScheduledEntry[]> {
    this.assertOpen();
    const rows = this.db!.prepare('SELECT * FROM scheduler_entries ORDER BY name ASC').all() as SchedulerEntryRow[];
    return rows.map(rowToEntry);
  }

  async triggerNow(id: string): Promise<string> {
    this.assertOpen();
    const row = this.getRow(id);
    if (!row) throw new SchedulerEntryNotFoundError(id);
    let payload: unknown;
    try {
      payload = JSON.parse(row.payload);
    } catch {
      payload = row.payload;
    }
    const result = await this.config.queue.enqueue({
      type: row.task_type,
      payload,
      priority: row.priority,
      maxRetries: row.max_retries,
      ttlMs: row.ttl_ms,
    });
    this.db!
      .prepare('UPDATE scheduler_entries SET last_enqueued_at = ?, last_error = NULL, updated_at = ? WHERE id = ?')
      .run(new Date().toISOString(), new Date().toISOString(), id);
    return result.id;
  }
}

export function createScheduler(config: SchedulerConfig): Scheduler {
  return new SqliteScheduler(config);
}
