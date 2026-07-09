# CLAUDE.md — data/queue/task-queue

Rules for working in this package (agent-routing layer; keep authoritative + minimal).

## Interface contract

The authoritative interface spec for this package is:
**[docs/plan/task-queue/SPEC.md](../../../../docs/plan/task-queue/SPEC.md)** (in this repo).

See this package's `README.md` §"Spec reconciliations" for the handful of places where the SPEC has
an internal gap or inconsistency and how the implementation resolved it — read that before assuming
a discrepancy between the spec and the code is a bug.

## Invariants (do not violate)

- durability: `enqueue()`/`enqueueBatch()` commit to SQLite before the returned Promise resolves
- at-least-once execution — duplicates are possible on crash recovery; handlers must be idempotent
- `dequeue()` claim is a single atomic `UPDATE ... RETURNING` transaction, ordered priority DESC then
  `created_at` ASC — never split into a SELECT + separate UPDATE (introduces a race window)
- `fail()`/reaper-requeue backoff uses the PRE-increment `retryCount` (first failure = 2^0 * 1000ms)
- `close()` / `WorkerPool.stop()` NEVER force-kill running handlers — the lease-expiry reaper is the
  crash-recovery safety net, not forced termination
- all mutating operations THROW `TaskQueueNotOpenError` before `open()` / after `close()`

## Boundaries

- `area:data` may import `area:data` + `area:shared` only — NEVER `area:platform` (enforced by nx
  module-boundary lint).
- Published npm name (`@adhd/sox-task-queue`) is decoupled from this folder path — never rename the
  package name on a folder move.
- Declared deps: `better-sqlite3`, `croner`. Do not add undeclared deps without updating
  `package.json` + the SPEC.

## Build / test

- `npx nx build task-queue` · `npx nx test task-queue` · `npx nx lint task-queue`
- Build via nx targets only — bare `tsc` emits into `src/` and bypasses the project graph.
- This is a data-layer library; it is NOT registered in `registry/index.json` — skip
  `npx nx run registry:sync-index` after changes here.
- Tests use `vi.useFakeTimers()` + `vi.setSystemTime()`/`vi.advanceTimersByTimeAsync()` everywhere
  time matters (backoff, lease expiry, reaper ticks, worker-pool polling, scheduler cron ticks) — the
  implementation deliberately computes all timestamps via `new Date()`/`Date.now()` (not SQLite's
  `strftime('now')`) specifically so it is fake-timer-controllable. Keep it that way; reintroducing
  SQL-side `now()` computation breaks test determinism.
