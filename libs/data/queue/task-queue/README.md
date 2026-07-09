# @adhd/sox-task-queue

Durable SQLite-backed task queue — priority-aware FIFO scheduling, retry with exponential backoff,
heartbeat-based lease management, a worker pool with graceful shutdown, and a croner-backed cron
scheduler for recurring tasks.

- **area:** data · **group:** queue · **publish:** PUBLIC (`private: false`, publish owner-gated)
- **engines:** Node >=22
- **deps:** `better-sqlite3`, `croner`

## Why

Durability is the point: state survives process restart in SQLite (a `tasks` table + indexes on
`(priority,created_at)`/`(lease_expires_at)`/`(type,status)`, an append-only `request_ledger` for
`clientRequestId` dedup, and `scheduler_entries`). No external message broker, no Redis.

## Invariants

- `enqueue()`/`enqueueBatch()` commit to SQLite before the returned Promise resolves (durability).
- At-least-once execution — every queued task executes at least once; duplicates are possible on
  crash recovery, and callers are responsible for idempotent handlers.
- `dequeue()` eligibility is uniform for `'queued'` and `'scheduled'` rows:
  `scheduled_at IS NULL OR scheduled_at <= now`. Claim order is priority DESC, then `created_at` ASC
  (FIFO within priority), via a single atomic `UPDATE ... RETURNING` transaction.
- `fail()` applies exponential backoff (`min(1000 * 2^retryCount, 86_400_000)`) using the
  **pre-increment** `retryCount` — the first failure (retryCount=0) backs off 1s, matching SPEC §9's
  worked example.
- Lease-expiry re-queue (the reaper) consumes one retry slot and applies the same backoff formula as
  `fail()`, per SPEC §9's "just like an explicit fail() call".
- `close()` / `WorkerPool.stop()` never force-kill running handlers — abandoned work is left for the
  lease-expiry reaper to reclaim on the next tick (or after restart).
- All task-queue and scheduler-entry mutating operations throw `TaskQueueNotOpenError` /
  `[task-queue] scheduler is not open` when called before `open()` or after `close()`.

## Spec reconciliations

The package is built against `sox-ecosystem/docs/plan/task-queue/SPEC.md` verbatim, with the
following gaps in that document resolved during implementation (each is called out inline in the
source with a "Spec reconciliation" comment):

1. **`maxQueueDepth` / `QueueFullError`** — §2's `TaskQueueConfig` code block omits the field, but
   D-8 in the decisions log names it explicitly and §3's `enqueue` doc comment throws
   `QueueFullError` "if configured". Added `maxQueueDepth?: number` (default 0 = unbounded) to make
   the documented error reachable.
2. **Dequeue eligibility vs. retry backoff** — §3's prose says eligibility is
   `status='queued' OR (status='scheduled' AND scheduled_at<=now)`, but §8's literal SQL gates
   **both** statuses on `scheduled_at`. The literal SQL is authoritative here: without it, a
   `fail()`-requeued task (`status='queued'`, `scheduled_at` = now+backoff) would be immediately
   re-dequeued, defeating the entire backoff feature.
3. **Cancellation flag** — §6's schema has no column for a running task's cancellation request, yet
   §3's `cancel()`/`isCancelled()` contract requires tracking one distinct from `status` (a running
   task stays `'running'`; the worker polls `isCancelled()`). Added `cancel_requested INTEGER` to
   `tasks`.
4. **`TaskTimeoutError` vs. "QueueShutdownTimeout"** — §3's `close()` doc comment names a
   `QueueShutdownTimeout` that has no class in §10's taxonomy. Reconciled to `TaskTimeoutError`
   (already documented there for the worker pool's drain timeout).
5. **Backoff table typo** — §9's worked example (0-indexed `retryCount`, `2^retryCount * 1000ms`) is
   internally consistent with attempts 1-5, but the table's rows for attempts 10/16/18 are off by a
   power of 2 from that same formula. Implemented the formula + the consistent worked example
   verbatim; the larger table rows are treated as a documentation typo.
6. **Scheduler `dbPath`** — §5's `SchedulerConfig` omits a database path, yet `open()`'s doc comment
   says "Open the scheduler database" and §6 defines `scheduler_entries` in the same DDL block as
   `tasks`. `SchedulerConfig.dbPath` is optional; when omitted, the scheduler derives it from the
   `dbPath` property `SqliteTaskQueue` exposes on its concrete class (both open independent WAL-mode
   connections to the same file — exactly the D-1 rationale for choosing WAL).
7. **Worker pool concurrency vs. `dequeueBatchSize`** — `dequeue()` returns up to the *queue's*
   `dequeueBatchSize` (default 10), independent of the pool's `concurrency`. Rather than either
   running every returned task immediately (over-committing concurrency) or leaving the overflow
   un-heartbeated (wasting its lease), the pool buffers claimed-but-not-yet-running tasks and
   heartbeats them until a slot frees, then promotes them in claim order.
8. **`onDead` callback** — named as a deferred item in §13.5 ("Dead task alerting"); implemented as
   `TaskQueueConfig.onDead?: (task: Task) => void`, called synchronously (errors caught, logged at
   `warn`) when a task goes dead via `fail()` or the reaper.

## Build / test

```
npx nx build task-queue
npx nx test task-queue
npx nx lint task-queue
```

- Build via nx targets only — bare `tsc` emits into `src/` and bypasses the project graph.
- This is a data-layer library; it is NOT registered in `registry/index.json` — skip
  `npx nx run registry:sync-index` after changes here.

## Usage

```ts
import { createTaskQueue, createWorkerPool, createScheduler } from '@adhd/sox-task-queue';

const queue = createTaskQueue({ dbPath: './queue.sqlite' });
await queue.open();

await queue.enqueue({ type: 'send-email', payload: { to: 'a@b.com' }, maxRetries: 3 });

const pool = createWorkerPool({
  queue,
  concurrency: 4,
  handler: async (task) => {
    // ... do work; throw to trigger retry/backoff, return to complete.
  },
});

const scheduler = createScheduler({ queue, dbPath: './queue.sqlite' });
await scheduler.open();
await scheduler.register({
  name: 'nightly-vacuum',
  taskType: 'maintenance',
  payload: { kind: 'vacuum' },
  cronExpression: '0 0 * * *',
  enabled: true,
});

// Graceful shutdown:
await pool.stop();
await scheduler.close();
await queue.close();
```
