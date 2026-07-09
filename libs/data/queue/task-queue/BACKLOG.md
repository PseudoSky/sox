# Backlog — `@adhd/sox-task-queue`

Package-local backlog. No root `/BACKLOG.md` BL-ID has been minted for these yet (this package did
not exist in the root backlog prior to this build); a future triage pass should assign one and
cross-reference it here.

---

### TQ-1 — LOW: WAL checkpointing is not implemented

SPEC §13 ("What belongs in the implementation, not the spec") calls for periodic
`PRAGMA wal_checkpoint(TRUNCATE)` during idle periods to bound WAL file growth for long-running,
file-backed (non-`:memory:`) queues. Not implemented: doing this correctly requires idle detection
(a naive fixed-interval checkpoint tied to the existing reaper tick could stall a busy queue mid-burst)
and file-based-DB test coverage (WAL growth isn't observable against `:memory:`), which is
meaningfully more work than the rest of this build and risked destabilizing an otherwise fully
green, tested implementation this late in the state. Low risk in practice: WAL files are bounded by
normal SQLite auto-checkpoint (default every ~1000 pages) even without an explicit periodic
checkpoint call; this only matters for very long-running processes with sustained high write volume.

### TQ-2 — LOW: multi-process reaper/scheduler leader election not implemented

SPEC §13 items #1 and #2 defer this to future spec work ("Add a `reaperLeaderKey` config option...",
"scheduler should acquire an advisory lock..."). Both are explicitly spec-level deferrals, not gaps
introduced by this implementation — every process currently runs its own reaper and scheduler tick
loop independently. This is documented by the spec itself as safe-but-redundant for the reaper
(idempotent `UPDATE ... WHERE` — a second reaper finds zero rows) but NOT safe for the scheduler
(no leader election means N processes running a scheduler against the same `scheduler_entries` table
will each independently fire due cron entries, producing N duplicate enqueues per tick). Single-process
deployments (the common case per SPEC §1's three use cases) are unaffected.

### TQ-3 — LOW: WorkerPoolConfig.heartbeatIntervalMs cannot auto-derive from the queue's heartbeatTimeoutMs

SPEC §4 documents the default as `heartbeatTimeoutMs / 3`, but `WorkerPoolConfig.queue` is typed as
the public `TaskQueue` interface, which does not expose `heartbeatTimeoutMs`. Implemented default is
a fixed `10_000ms` (i.e. the *queue's own* default `heartbeatTimeoutMs` of `30_000ms` / 3). If a
caller configures a non-default `heartbeatTimeoutMs` on the queue, they must also set
`WorkerPoolConfig.heartbeatIntervalMs` explicitly to match (documented in `types.ts` and `README.md`).
A future improvement could expose a narrow read-only accessor on `TaskQueue` (e.g.
`get heartbeatTimeoutMs(): number`) so the pool can self-configure; deferred here to avoid widening
the pinned `TaskQueue` interface without an explicit decision from the interface owner.
