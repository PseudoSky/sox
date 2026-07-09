// @adhd/sox-task-queue — durable SQLite-backed task queue
//
// Primary exports: TaskQueue (+ createTaskQueue), createWorkerPool, Scheduler
// (+ createScheduler), the Task/TaskStatus/TaskFilter/QueueStats types, the
// SQLite schema, and the TaskQueueError taxonomy. See SPEC:
// sox-ecosystem/docs/plan/task-queue/SPEC.md

export {
  TaskStatus,
  type Task,
  type TaskQueue,
  type TaskQueueConfig,
  type TaskFilter,
  type QueueStats,
  type EnqueueResult,
  type DequeueResult,
  type WorkerPool,
  type WorkerPoolConfig,
  type Scheduler,
  type SchedulerConfig,
  type ScheduledEntry,
} from './types.js';

export { SqliteTaskQueue, createTaskQueue } from './task-queue.js';
export { createWorkerPool } from './worker-pool.js';
export { createScheduler } from './scheduler.js';

export {
  PRAGMAS,
  SCHEMA_VERSION,
  SCHEMA_VERSION_DDL,
  TASK_QUEUE_DDL,
  applySchema,
} from './schema.js';

export { computeBackoffDelayMs, BACKOFF_BASE_DELAY_MS, BACKOFF_MAX_DELAY_MS } from './backoff.js';

export {
  TaskQueueError,
  QueueFullError,
  TaskNotFoundError,
  TaskNotRunningError,
  TaskPermanentlyFailedError,
  TaskTimeoutError,
  TaskNotDeadError,
  QueueNotEmptyError,
  TaskQueueNotOpenError,
  TaskQueueSystemError,
  SchedulerEntryConflictError,
  SchedulerEntryNotFoundError,
} from './errors.js';
