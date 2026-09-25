---
'@adhd/sox-store-adapter': minor
---

(BUG-026) Reconcile a classic `-shm` sidecar when an exclusive lock probe proves it **unlocked** — even while live turso peers hold the store — instead of refusing the open forever.

- **New exports** (additive public surface): `probeForeignShmLock`, `removeForeignShmIfUnlocked`, `foreignShmPath`, the `ForeignShmLockState` / `ForeignShmLockProbe` types, `ReconcileForeignSqliteShmOptions`, and the typed, clamped probe-timeout tuning (`FOREIGN_SHM_LOCK_PROBE_*` + `clampForeignShmLockProbeTimeoutMs`). A live classic SQLite opener holds a SHARED lock on the store, so an **exclusive** better-sqlite3 open distinguishes abandoned residue (`unlocked`) from a live classic holder (`locked`) — and succeeds under live turso peers (turso never reads the classic `-shm`). The probe runs in a short-lived child process that opens read-write, takes the exclusive lock, and `process.exit`s **without** `close()`, so it can never checkpoint or delete the shared `-wal` (the exp9 poisoner).
- **Behavior change** (`reconcileForeignSqliteShm` + `TursoAdapterImpl._openReal`): an abandoned `-shm` is now renamed aside and the open proceeds — it no longer throws `EForeignSqliteSidecar` merely because a turso peer holds the store. A **live classic** holder (or an unprovable state) still refuses, marked `retryable`. This is what unblocks a store whose persistent `-shm` residue was previously unopenable for as long as any peer held it.
- **New optional** `ReconcileForeignSqliteShmOptions.foreignHolderLock`; the second `reconcileForeignSqliteShm` argument is a structurally-wider interface, so existing callers are unaffected.
- `preflightSchemaSanity` now removes the `-shm` its own readonly open materialised, once the probe proves it unlocked, so a read-only connection no longer leaves accumulating residue.
- `EForeignSqliteSidecar` gained an optional third constructor argument (message refinement only; backward compatible).

No dependent's declared range needs to change and no consumer call site must act, but this is a behavior change (not purely additive), so it is a pre-1.0 minor.
