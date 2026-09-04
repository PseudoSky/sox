# @adhd/sox-task-queue

A durable task queue: atomic priority-aware FIFO claim/lease, retry with exponential backoff,
heartbeat-based lease reclamation, a worker pool with graceful shutdown, and a croner-backed cron
scheduler for recurring tasks. No external broker, no Redis — the queue's state (and the claim
itself) lives in one store file.

The queue talks to its store exclusively through `@adhd/sox-store-adapter`'s `StoreAdapter`
interface — every `enqueue`/`dequeue`/`fail`/`complete` is an adapter `transaction()`, never a raw
driver call. That means the backend is a config choice, not something baked into the queue:

- `createTaskQueue({ dbPath })` with nothing else opens its own local SQLite (`better-sqlite3`)
  connection — synchronous, single-writer, one process.
- `createTaskQueue({ dbPath, adapter })`, given a pre-built adapter from `@adhd/sox-store-adapter`,
  uses that adapter instead. Hand it a Turso adapter (the default backend there, `multiprocess-wal`
  mode) and the same queue file can be opened by **multiple worker-pool processes at once** — each
  with its own `WorkerPool` — with writes serialized through Turso's coordinator sidecar instead of
  one process's file lock. `Scheduler` accepts the identical `adapter` option for the cron table.

```bash
pnpm add @adhd/sox-task-queue
```

## Quick start

```typescript
import { createTaskQueue, createWorkerPool, createScheduler } from '@adhd/sox-task-queue';

const queue = createTaskQueue({ dbPath: './queue.sqlite' });
await queue.open();

await queue.enqueue({ type: 'send-email', payload: { to: 'a@b.com' }, maxRetries: 3 });

const pool = createWorkerPool({
  queue,
  concurrency: 4,
  handler: async (task) => {
    // do the work; throw to trigger retry/backoff, return normally to complete.
    console.log(task.type, task.payload);
  },
});
// pool.start() is implicit — WorkerPoolConfig.autoStart defaults to true.

const scheduler = createScheduler({ queue, dbPath: './queue.sqlite' });
await scheduler.open();
await scheduler.register({
  name: 'nightly-vacuum',
  taskType: 'maintenance',
  payload: { kind: 'vacuum' },
  cronExpression: '0 0 * * *',
  enabled: true,
});

// Graceful shutdown — waits for in-flight handlers before closing:
await pool.stop();
await scheduler.close();
await queue.close();
```

### Running the queue across multiple processes

Pass a Turso-backed `StoreAdapter` (from `@adhd/sox-store-adapter`) instead of a bare `dbPath`, and
any number of separate processes — separate `node` invocations, separate hosts — can hold their own
`TaskQueue` + `WorkerPool` open against the same logical queue at once:

```typescript
import { createStoreAdapter } from '@adhd/sox-store-adapter';
import { createTaskQueue, createWorkerPool } from '@adhd/sox-task-queue';

// Runs in every process; each gets an independently-negotiated write connection
// to the same store, serialized by Turso's multiprocess-wal coordinator.
const adapter = await createStoreAdapter({ dbPath: './queue.sqlite' });
const queue = createTaskQueue({ dbPath: './queue.sqlite', adapter });
await queue.open();

const pool = createWorkerPool({ queue, concurrency: 4, handler: async (task) => { /* ... */ } });
```

Each `dequeue()` claim is one atomic `UPDATE ... RETURNING` inside the adapter's transaction, so two
processes racing to claim the same row never both win it — the loser's `UPDATE` simply matches zero
rows. Everything above the claim (heartbeats, retries, the reaper) reads/writes through the same
adapter, so the durability and backoff guarantees below hold identically whether the queue is
single-process SQLite or a multi-process Turso file.

## API reference

### Queue

```typescript
function createTaskQueue(config: TaskQueueConfig): TaskQueue;

interface TaskQueueConfig {
  dbPath: string;                 // ':memory:' is valid for testing
  adapter?: StoreAdapter;         // pre-built adapter; see "multiple processes" above
  dequeueBatchSize?: number;      // default 10
  defaultMaxRetries?: number;     // default 3
  heartbeatTimeoutMs?: number;    // default 30_000
  defaultTtlMs?: number | null;   // default null (no wall-clock cap)
  autoRequeueExpired?: boolean;   // default true — the lease-expiry reaper
  reaperIntervalMs?: number;      // default 5_000
  maxQueueDepth?: number;         // default 0 (unbounded); throws QueueFullError above it
  onDead?: (task: Task) => void;  // called when a task exhausts retries
}

interface TaskQueue {
  open(): Promise<void>;
  close(opts?: { drainTimeoutMs?: number }): Promise<void>; // throws TaskTimeoutError if tasks are still running
  readonly isOpen: boolean;

  enqueue(task: Partial<Task> & { type: string; payload: unknown }): Promise<EnqueueResult>;
  enqueueBatch(tasks: Array<Partial<Task> & { type: string; payload: unknown }>): Promise<EnqueueResult[]>;
  dequeue(workerId: string): Promise<DequeueResult[]>;
  complete(taskId: string, result?: unknown): Promise<void>;
  fail(taskId: string, error: string): Promise<void>;
  heartbeat(taskId: string): Promise<boolean>;
  cancel(taskId: string): Promise<boolean>;
  isCancelled(taskId: string): Promise<boolean>;

  get(taskId: string): Promise<Task | null>;
  listTasks(filter?: TaskFilter): Promise<Task[]>;
  countTasks(filter?: TaskFilter): Promise<number>;
  stats(): Promise<QueueStats>;
  purgeCompleted(olderThanMs: number): Promise<number>;
  requeue(taskId: string): Promise<void>;
  deleteTasks(filter: TaskFilter): Promise<number>;
}
```

### Worker pool

```typescript
function createWorkerPool(config: WorkerPoolConfig): WorkerPool;

interface WorkerPoolConfig {
  queue: TaskQueue;
  handler: (task: Task) => Promise<void>;
  concurrency?: number;         // default 1
  pollIntervalMs?: number;      // default 1_000
  heartbeatIntervalMs?: number; // default heartbeatTimeoutMs / 3
  drainTimeoutMs?: number;      // default 30_000
  workerName?: string;          // default: auto UUID, used as the lease's workerId
  autoStart?: boolean;          // default true
}

interface WorkerPool {
  start(): void;
  stop(): Promise<void>;
  readonly isRunning: boolean;
  readonly activeCount: number;
  readonly stats: { tasksProcessed: number; tasksFailed: number; tasksTimedOut: number };
}
```

### Scheduler (cron)

```typescript
function createScheduler(config: SchedulerConfig): Scheduler;

interface SchedulerConfig {
  queue: TaskQueue;
  adapter?: StoreAdapter;   // pre-built adapter for the scheduler_entries table
  // + defaults for task type / tick interval on the registered entries
}
```

`Scheduler` registers `ScheduledEntry` rows (`cronExpression`, `taskType`, `payload`) persisted in
`scheduler_entries`; a tick loop enqueues each entry's task onto the queue when it comes due
(via `croner`).

### Backoff, schema, and errors

```typescript
function computeBackoffDelayMs(retryCount: number): number; // min(1000 * 2^retryCount, 86_400_000)
const BACKOFF_BASE_DELAY_MS: number;
const BACKOFF_MAX_DELAY_MS: number;

const PRAGMAS: string[];           // WAL mode, busy_timeout, synchronous=NORMAL, foreign_keys=ON
const SCHEMA_VERSION: number;
const TASK_QUEUE_DDL: string;
function applySchema(adapter: StoreAdapter): Promise<void>;

class TaskQueueError extends Error {}
class QueueFullError extends TaskQueueError {}
class TaskNotFoundError extends TaskQueueError {}
class TaskNotRunningError extends TaskQueueError {}
class TaskPermanentlyFailedError extends TaskQueueError {}
class TaskTimeoutError extends TaskQueueError {}
class TaskNotDeadError extends TaskQueueError {}
class QueueNotEmptyError extends TaskQueueError {}
class TaskQueueNotOpenError extends TaskQueueError {}
class TaskQueueSystemError extends TaskQueueError {}
class SchedulerEntryConflictError extends TaskQueueError {}
class SchedulerEntryNotFoundError extends TaskQueueError {}
```

## Invariants

- `enqueue()` / `enqueueBatch()` commit before the returned Promise resolves — durability, not
  fire-and-forget.
- At-least-once execution: every queued task executes at least once; a crash mid-handler can
  produce a duplicate delivery, so handlers should be idempotent.
- Claim order is priority DESC, then `created_at` ASC (FIFO within a priority), via one atomic
  `UPDATE ... RETURNING` — a task is never handed to two workers at once.
- `dequeue()` eligibility is `scheduled_at IS NULL OR scheduled_at <= now` for both `'queued'` and
  `'scheduled'` rows — this is what makes retry backoff actually delay redelivery: a `fail()`-requeued
  task has `scheduled_at` pushed into the future, so it is not immediately re-claimed.
- `fail()` backs off by `min(1000 * 2^retryCount, 86_400_000)` using the retry count *before* the
  increment — the first failure backs off 1s, the second 2s, doubling up to a 24h cap.
- Lease-expiry re-queue (the reaper) consumes one retry slot and applies that same backoff formula,
  so a worker that dies mid-task behaves like an explicit `fail()` call to the rest of the system.
- `close()` / `WorkerPool.stop()` never force-kill running handlers — abandoned in-flight work is
  left for the lease-expiry reaper to reclaim on its next tick or after restart.
- Every mutating operation throws `TaskQueueNotOpenError` (or the scheduler's equivalent) when
  called before `open()` or after `close()`.
