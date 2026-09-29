---
'@adhd/sox-store-adapter': minor
---

Per-call DB-operation tracing for both `SqliteAdapterImpl` and `TursoAdapterImpl`: which
operation is in flight, phased duration, and success/failure — plus an optional DI hook so a
consumer can observe DB-operation granularity without importing anything from store-adapter's
internals.

- `_trackOp` on both adapters now measures `health_ms` (turso only — sqlite's `_trackOp` has no
  health-check phase), `op_ms` (time in the caller's `fn()`), and, for writes, `post_write_ms`
  (the WAL-identity-recovery + wal-cap-flush check). All ~15 call sites (`executeGet`,
  `executeAll`, `executeRun`, `exec`, `pragmaSet`, `pragmaGet`, `transaction`, and turso's
  `backupTo`) now pass a short op label. The counter increment, `_ensureHealthy()` call, existing
  try body, and `finally` re-arm run in EXACTLY the same order as before — only additive timing
  capture and hooks were introduced; no reordering.
- The 9 documented bypass sites (sqlite: `_performIdleFlush`, `_performWalOwnershipHeartbeat`,
  `_closeOnce`; turso: `_maybeOptimizeFts`, `_countInServiceOptimizePass`, `_performIdleFlush`,
  `_performWalOwnershipHeartbeat`, `_reconnect`, `_closeConnection`) are instrumented with the
  same timing helper WITHOUT routing through `_trackOp` — routing them through it would re-arm
  the idle timer and break the documented BUG-022 quiescence rules. Several were split into a
  thin timing wrapper plus an unmodified `*Body` method so their existing early-return control
  flow is untouched.
- A completed op is logged (`store_adapter.<sqlite|turso>.op_slow`) only when its `op_ms` meets or
  exceeds a new typed `AdapterConfig.slowOpThresholdMs` field (default 1000ms, ADR-0013 — never an
  env toggle). A failed op is always logged (`store_adapter.<sqlite|turso>.op_failed`) with a
  local error classification (`fatal_connection` / `concurrent_conflict` / `busy` /
  `unique_constraint` / `foreign_key` / the raw driver code) built from `errors.ts`'s existing
  detectors — ADR-0012 §3 keeps the real driver-agnostic taxonomy in memory-core, which a `data`
  package may not import, so this is a local tracing-only label, not a re-implementation. Every
  op — logged or not — updates a process-local aggregate (count, error count, slow count, avg/max
  ms) surfaced under a `store_adapter.op_timing` `metrics.snapshot` section
  (`registerSnapshotSection`, registered once at module scope, never per adapter instance).
- New optional `AdapterConfig` fields: `onOpStart?(label)` / `onOpEnd?()` (ADR-0006 DI-for-live-
  objects — fired at the start/end of every tracked op and bypass site) and `slowOpThresholdMs?`.
  Threaded through `createStoreAdapter`/`createSqliteAdapter`/`createTursoAdapter`,
  `SqliteAdapterImpl`'s constructor, and `TursoAdapterImpl._buildConfig`/`_openReal`.
