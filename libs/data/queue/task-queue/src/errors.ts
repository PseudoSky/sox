// @adhd/sox-task-queue — error taxonomy (SPEC §10)

/** Base error for the task-queue package. */
export class TaskQueueError extends Error {
  public readonly taskId: string | undefined;

  constructor(message: string, taskId?: string) {
    super(message);
    this.name = 'TaskQueueError';
    this.taskId = taskId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when the queue has reached its maximum depth (if `maxQueueDepth` is
 * configured). The caller should retry after tasks have been consumed.
 *
 * NOTE (spec reconciliation): §2 `TaskQueueConfig` does not literally list a
 * `maxQueueDepth` field, but D-8 in the decisions log explicitly specifies
 * "Optional per-queue maxDepth via config (default: 0 = unbounded)" and this
 * error class. We add `maxQueueDepth?: number` to `TaskQueueConfig` to make
 * the documented `QueueFullError` contract real rather than dead code.
 */
export class QueueFullError extends TaskQueueError {
  public readonly currentDepth: number;
  public readonly maxDepth: number;

  constructor(currentDepth: number, maxDepth: number) {
    super(`queue full: ${currentDepth}/${maxDepth}`);
    this.name = 'QueueFullError';
    this.currentDepth = currentDepth;
    this.maxDepth = maxDepth;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a task operation references a non-existent task ID. */
export class TaskNotFoundError extends TaskQueueError {
  constructor(taskId: string) {
    super(`task not found: ${taskId}`, taskId);
    this.name = 'TaskNotFoundError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when `complete()` or `fail()` is called on a task that is not in
 * 'running' status.
 */
export class TaskNotRunningError extends TaskQueueError {
  public readonly currentStatus: string;

  constructor(taskId: string, currentStatus: string) {
    super(`task ${taskId} is not running (status: ${currentStatus})`, taskId);
    this.name = 'TaskNotRunningError';
    this.currentStatus = currentStatus;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when `fail()` is called on a task that is already dead (maxRetries
 * exhausted).
 */
export class TaskPermanentlyFailedError extends TaskQueueError {
  public readonly retryCount: number;

  constructor(taskId: string, retryCount: number) {
    super(`task ${taskId} has permanently failed after ${retryCount} retries`, taskId);
    this.name = 'TaskPermanentlyFailedError';
    this.retryCount = retryCount;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a background operation times out: `queue.close()`'s drain
 * timeout (referred to informally as "QueueShutdownTimeout" in §3's doc
 * comment — that name has no dedicated class in the §10 taxonomy, so this
 * is the reconciled class for both queue- and pool-level drain timeouts)
 * and `WorkerPool.stop()`'s drain timeout.
 */
export class TaskTimeoutError extends TaskQueueError {
  public readonly timeoutMs: number;

  constructor(message: string, timeoutMs: number) {
    super(message);
    this.name = 'TaskTimeoutError';
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when `requeue()` is called on a task that is not in a dead state. */
export class TaskNotDeadError extends TaskQueueError {
  public readonly currentStatus: string;

  constructor(taskId: string, currentStatus: string) {
    super(`task ${taskId} is not dead (status: ${currentStatus})`, taskId);
    this.name = 'TaskNotDeadError';
    this.currentStatus = currentStatus;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when `deleteTasks()` matches tasks that are currently 'running'. */
export class QueueNotEmptyError extends TaskQueueError {
  public readonly runningCount: number;

  constructor(runningCount: number) {
    super(`cannot delete: ${runningCount} tasks are currently running`);
    this.name = 'QueueNotEmptyError';
    this.runningCount = runningCount;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when the queue is used before `open()` or after `close()`. */
export class TaskQueueNotOpenError extends TaskQueueError {
  constructor() {
    super('task queue is not open');
    this.name = 'TaskQueueNotOpenError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown on unrecoverable storage errors: disk full, SQLite I/O error, permission denied. */
export class TaskQueueSystemError extends TaskQueueError {
  public override readonly cause: Error | undefined;

  constructor(message: string, cause?: Error) {
    super(message);
    this.name = 'TaskQueueSystemError';
    this.cause = cause;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ─── Scheduler errors ───────────────────────────────────────────────────────

/** Thrown when a scheduler entry with the same name already exists. */
export class SchedulerEntryConflictError extends TaskQueueError {
  public readonly entryName: string;

  constructor(entryName: string) {
    super(`scheduler entry already exists: ${entryName}`);
    this.name = 'SchedulerEntryConflictError';
    this.entryName = entryName;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a scheduler entry operation references a non-existent entry. */
export class SchedulerEntryNotFoundError extends TaskQueueError {
  public readonly entryId: string;

  constructor(entryId: string) {
    super(`scheduler entry not found: ${entryId}`);
    this.name = 'SchedulerEntryNotFoundError';
    this.entryId = entryId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
