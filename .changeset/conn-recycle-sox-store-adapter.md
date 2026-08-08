---
"@adhd/sox-store-adapter": minor
---

`TursoAdapter` detects fatal driver-level faults and recycles the poisoned connection
(BUG-TURSO-WAL-SHORTREAD-WEDGES-BACKEND-001).

Previously, once the native `@tursodatabase/database` driver raised a connection/storage-layer
fault (e.g. `I/O error: short read on WAL frame …`) on the adapter's one shared connection handle,
every subsequent caller — including reads that shared no state with the call that failed — kept
being handed the same poisoned handle. Recovery required killing the process.

New exports:

- `isFatalConnectionError(err: unknown): boolean` (from `errors.ts`) — classifies a Turso driver
  error as connection-fatal (`I/O error:` / `database disk image is malformed` category markers in
  the message) vs. statement-local (bad SQL, constraint violation, type mismatch). Never based on
  `err.code` — every Turso driver error observed carries `code: 'GenericFailure'`, so `code` alone
  cannot discriminate.

`TursoAdapterImpl` now:

- Marks itself `_poisoned` when a fatal fault is observed on any direct `this.db` call
  (`executeGet`/`executeAll`/`executeRun`/`exec`/`_runTransaction`'s BEGIN/COMMIT), while still
  rethrowing the original error unchanged to the caller that hit it.
- Lazily reconnects on the *next* call after poisoning — via a full re-run of
  `TursoAdapterImpl.connect()` with the original `opts`, so the reconnect inherits the existing
  BL-361 preflight, BL-461 FTS orphan guard, and BL-352 open-time integrity ceremony for free.
- Shares a single in-flight reconnect across concurrent callers that observe the poisoned state.
- Fires a detached, best-effort close of the stale handle after the fresh connection is live —
  never on the recovery critical path.

Additive-only interface change: `TursoAdapter` (narrow, Turso-only — `SqliteAdapter`/`MockAdapter`
unaffected) gains a new required member:

```ts
readonly connectionHealth: 'healthy' | 'poisoned' | 'reconnecting';
```

`TursoAdapterImpl` is the only current implementer of `TursoAdapter`; this is a seam for callers
(e.g. a health surface) that want to report connection state without triggering a query.
