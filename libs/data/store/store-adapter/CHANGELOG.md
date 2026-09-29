# @adhd/sox-store-adapter

## 0.13.0

### Minor Changes

- 2bf37fe: Turso's native driver now runs on a process-wide off-thread worker, so a slow driver step no longer
  freezes the Node main thread.

  `@adhd/sox-store-adapter` — **public-surface change, hence MINOR (on 0.x).** `TursoAdapter.unwrap()`
  now returns a `TursoDriverConnection` (the off-thread connection proxy, async methods), **not** the
  native `@tursodatabase/database` `Database`. Callers must `await` its `run`/`get`/`all`/`exec`/
  `pragma`/`close`. `unwrap()` remains synchronous and still throws `[DEBT-003]` before the first real
  operation has opened the connection.

  The driver is loaded in exactly one place — the `turso-driver-worker.js` sidecar (a worker realm) — via
  a lazy, non-literal import (ADR-0019), so the native chain is absent from every main-thread module
  graph. All main-thread driver calls for a process are served FIFO from one worker held in a
  `globalThis` slot keyed on `Symbol.for('@adhd/sox-store-adapter/turso-driver-host')`; a copy of the
  package speaking a different protocol version throws `E_TURSO_DRIVER_PROTOCOL_MISMATCH` rather than
  spawning a second worker. An unexpected worker exit rejects every pending call with
  `E_TURSO_DRIVER_WORKER_EXITED` (recognized by `isFatalConnectionError`, so the existing
  reconnect path recovers) and the next open spawns a fresh worker. New public read surface:
  `TursoAdapter.driverStatus` and the typed `AdapterConfig.driverStallAfterMs` — a synchronous,
  zero-worker-touch snapshot that reports a `'stalled'` driver (deadline verdict) without cancelling it
  (a native call cannot be aborted).

  **Explicit non-guarantees:** this bounds main-thread blocking, not operation latency; one driver
  thread per process serializes all ops on that store; same-process writers still pay the full 5s busy
  timeout until upstream 0.8's `STEP_SLEEP` lands (BL `809153d1`); and recall reads still queue behind a
  store's writes pending a dedicated read connection (BL `56c72ccb`, deferred).

  `@adhd/sox-extension-memory-server` — consumes the new surface: a driver-stall watchdog reads
  `getTursoDriverStatus()` on an interval and force-exits the process once the oldest in-flight driver op
  exceeds its kill threshold, and `memory_ping` reports the driver status. No consumer-visible behavior
  change beyond added telemetry.

  > Release note: `registry/index.json` is untouched (ADR-0021) — the registry is written by the release
  > flow, not by this change.

## 0.12.0

### Minor Changes

- d215fc3: Per-call DB-operation tracing for both `SqliteAdapterImpl` and `TursoAdapterImpl`: which
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

## 0.11.0

### Minor Changes

- a37ca25: Opening a store never blocks on `deep` integrity verification any more, and a
  failed clean-shutdown write is no longer read as a crash (BL-fc5ab895).

  `@adhd/sox-store-adapter` — `runOpenTimeIntegrity` blocks only on the `fast`
  tier. When `deep` is owed (unclean shutdown, `SOX_STORE_VERIFY=deep`, or an
  outstanding obligation) it runs `PRAGMA integrity_check` in a background,
  non-detached, SIGKILL-able child process (`deep-verify-child.js`, a declared
  sidecar) that opens its own `readonly` + `query_only` connection, never repairs,
  and reaps itself off-thread if its parent dies or its hard deadline passes. The
  bound is typed config (`AdapterConfig.deepVerify.timeoutMs`, default 30 min,
  rejected loudly with `EInvalidDeepVerifyConfig`). On timeout/failure the child
  is killed, the probe is recorded `unknown`, and a loud event is emitted. The
  obligation lives in `_adapter_meta.deep_verify_owed`, separate from any
  clean-shutdown signal, and is cleared only by a deep pass that completes `ok`;
  the latest attempt is in `_adapter_meta.deep_verify_state`. At most one verifier
  runs per store across processes (`.deep-verify.lock` in the lease dir).
  Behaviour change: damage found by `deep` is reported but no longer REINDEXed at
  open. Both adapters now take their crash signal from the dead-pid per-connection
  open marker instead of `_adapter_meta.clean_shutdown`, and no longer write that
  flag at close — it was set to '0' by every concurrent open and its close-time
  write failed with `database is locked` under a peer's write lock.

  `@adhd/sox-memory-core` — `computePingHealthVerdict` accepts `deepVerify` and
  reports `degraded` while a deep pass is owed and its last attempt ended
  `timed_out`/`failed`/`damaged`/`inconclusive`. `resolveStoreVerifyConfig` carries
  the bound from the `deep_verify_timeout_ms` config key into every writable open.

  `@adhd/sox-extension-memory-server` — `memory_ping` reports `store.deep_verify`
  and degrades on it. The off-thread main-thread watcher now SIGKILLs the process
  after `mainthread_kill_after_ms` (default 5 min) of main-thread silence, writing
  a raw fd-2 FATAL line first; the heartbeat uses the monotonic clock.

- e5b712d: A reopen after an idle release no longer writes to the store, and a close with
  nothing in the WAL no longer truncates it (BL-1010e417, 595e7daf, 5eacd776,
  44896cff).

  - `stampAdapterMeta` reads first. When `adapter_type` and `adapter_version`
    already match and `created_at` exists, it returns without a transaction.
    Otherwise it takes `BEGIN IMMEDIATE`, re-reads, and upserts only the values
    that differ. The Turso open also skips `CREATE TABLE IF NOT EXISTS
_adapter_meta` when the stamp is current.
  - `_openReal` has a typed internal open reason: `'initial'`, `'poison'` or
    `'release'`. It is not an option or an env var.
    - A `'release'` reopen reuses the instance's `recursiveCte` probe.
    - A `'release'` reopen skips the `fast` integrity pass and its
      `_adapter_meta.last_integrity` upsert, which was the only WAL frame such a
      reopen wrote. An owed deep verification is still picked up and scheduled.
    - The skip applies only when the retained verdict is clean: `verify.ok`,
      no damaged finding, no unknown finding, and no failed repair. An aborted
      pass (the BL-352 `ok:false` shape), a damaged or unvalidated verdict, or a
      failed repair makes the next release reopen run the full pass, so repair
      is retried on the next reopen instead of waiting for a poison event or a
      restart. A store whose fast verdict carries a standing `unknown` finding
      (for example an FTS table with no row longer than 24 characters, a probe
      skipped through `SOX_STORE_VERIFY_SKIP`, or a non-FTS custom index method)
      runs that full pass and its upsert on every release reopen, so it is not
      write-free.
    - A release reopens as `'release'` only when its own close was clean: the
      `wal_identity` check found no damage and every PASSIVE checkpoint it ran
      succeeded. Otherwise the reopen is `'initial'`. A non-writable close runs
      neither check and counts as clean.
    - Release reopens no longer run the periodic `fast` verification.
      `_adapter_meta.last_integrity`, which `memory_ping` reads, now reflects
      the last full open, so its age grows over the process lifetime. This
      trades against ADR-0013
      (`docs/decisions/0013-feature-switches-are-typed-config-not-env-vars.md`),
      which says verification "always runs ≥ fast"; here it runs at every full
      open, not at every release reopen. No periodic re-verify cadence is added.
    - Under `SOX_STORE_VERIFY=deep`, a release reopen no longer requests a deep
      pass itself. It still schedules a deep pass that another opener recorded
      as owed.
    - A `'release'` reopen keeps the lease, the foreign-shm and sidecar
      preflight, the BUG-026 WAL baseline and the orphaned-FTS guard.
    - `'initial'` and `'poison'` opens run the full ceremony.
    - `lastOpenTiming` reports the wall time of each phase.
  - Close reads the frame count from its PASSIVE checkpoint. With zero frames it
    skips the TRUNCATE and the `-tshm` rename. When the count is unavailable, it
    skips them only if the `-wal` was 0 bytes at close start and is still 0.
    With frames present the path is unchanged.
  - `.stale-*` sidecar names are collision-free:
    `YYYY-MM-DD-HHMM-SSmmm-p<pid>[-n]` (`staleSidecarPath`). Before this, every
    rename inside one minute overwrote the previous one. Retention matches and
    ranks both the new and the legacy minute-only names.
  - Measured on a 115 MB copy of a store snapshot: a release reopen takes
    2.6–10.4 ms, against 506–542 ms for a full open.
  - Renames per idle-release cycle are unchanged at one, moved from close to
    open: the `-tshm` that a zero-frame close keeps is moved aside by the next
    open's BL-373 preflight.

## 0.10.0

### Minor Changes

- f6cbbb5: (BUG-026) Reconcile a classic `-shm` sidecar when an exclusive lock probe proves it **unlocked** — even while live turso peers hold the store — instead of refusing the open forever.

  - **New exports** (additive public surface): `probeForeignShmLock`, `removeForeignShmIfUnlocked`, `foreignShmPath`, the `ForeignShmLockState` / `ForeignShmLockProbe` types, `ReconcileForeignSqliteShmOptions`, and the typed, clamped probe-timeout tuning (`FOREIGN_SHM_LOCK_PROBE_*` + `clampForeignShmLockProbeTimeoutMs`). A live classic SQLite opener holds a SHARED lock on the store, so an **exclusive** better-sqlite3 open distinguishes abandoned residue (`unlocked`) from a live classic holder (`locked`) — and succeeds under live turso peers (turso never reads the classic `-shm`). The probe runs in a short-lived child process that opens read-write, takes the exclusive lock, and `process.exit`s **without** `close()`, so it can never checkpoint or delete the shared `-wal` (the exp9 poisoner).
  - **Behavior change** (`reconcileForeignSqliteShm` + `TursoAdapterImpl._openReal`): an abandoned `-shm` is now renamed aside and the open proceeds — it no longer throws `EForeignSqliteSidecar` merely because a turso peer holds the store. A **live classic** holder (or an unprovable state) still refuses, marked `retryable`. This is what unblocks a store whose persistent `-shm` residue was previously unopenable for as long as any peer held it.
  - **New optional** `ReconcileForeignSqliteShmOptions.foreignHolderLock`; the second `reconcileForeignSqliteShm` argument is a structurally-wider interface, so existing callers are unaffected.
  - `preflightSchemaSanity` now removes the `-shm` its own readonly open materialised, once the probe proves it unlocked, so a read-only connection no longer leaves accumulating residue.
  - `EForeignSqliteSidecar` gained an optional third constructor argument (message refinement only; backward compatible).

  No dependent's declared range needs to change and no consumer call site must act, but this is a behavior change (not purely additive), so it is a pre-1.0 minor.

- 7b42583: fix(store-adapter): the BUG-026 foreign-`-shm` probe no longer opens a main db file that is missing or under one page. SQLite's pager deletes the `-wal` beside a zero-page main file on a read-write open (and better-sqlite3 creates a missing main file first), so the probe could destroy a store whose data lived only in its WAL. It now returns `indeterminate` without spawning and emits `store_adapter.foreign_shm.probe_declined_small_main`.
- 5882e24: fix(store-adapter): the in-service FTS optimize pass no longer merges an unknown backlog at a fresh process's first idle point (4cd68c4e). The write counter starts at 0, so the idle pass only merges steady-state growth. The one-time backlog merge is the new offline entry point `optimizeFtsIndexes(dbPath)`, exposed as `memory fts-optimize --db <path>`. It refuses while any store-lease peer is live and reports duration per index. The idle pass now skips and logs, never runs unchecked, when the adapter holds no lease. It warns `fts.optimize.starved` once when live peers have kept it skipping past 4× the threshold, and backs off exponentially (capped at 1 h) after a failed pass.
- fdd9909: feat(store-adapter): a process-liveness "opener" registry (4cd68c4e-H1). Every `TursoAdapterImpl` that opens a local store now registers an opener entry, one file per process per store at `<db>.sox-lease.d/.openers/<pid>`. The entry lasts from `connect()` to the final `close()`, stays through idle-release and reconnects, is unlinked on process exit, and is swept once its pid is dead. `optimizeFtsIndexes(dbPath)` now also refuses with `reason: 'openers'` while any other live process or adapter has the store open. Before this, a running-but-idle memory-server, which drops its lease on idle-release, passed the lease-only check. New exports: `registerStoreOpener`, `storeOpeners`, `openerDirPath` and `FTS_OPTIMIZE_INSERVICE_MAX_MULTIPLE`. The in-service FTS optimize pass is now bounded (4cd68c4e-H2). Once live peers have starved it past 4× the threshold, it never runs in-service. It skips with `backlog_exceeds_bound`, warns `fts.optimize.starved` once, and leaves the backlog to the offline entry point. `memory fts-optimize` now tells you to run `soxe service disable memory-server` first, because under launchd KeepAlive a killed process respawns.

### Patch Changes

- e8592b9: A non-ENOENT failure statting a turso store's `-shm` sidecar (e.g. EACCES) no
  longer escalates into `EForeignSqliteSidecar` through the open path's bounded
  retry loop. `reconcileForeignSqliteShm` now tags every decline with a
  `declineKind` (`stat_unprovable` | `locked` | `in_use` | `rename_failed`) and the
  open path routes through the new `foreignShmOpenAction()`: a `stat_unprovable`
  decline proceeds with the open (traced as
  `store_adapter.foreign_shm.open_proceeds_stat_unprovable`), while a proven live
  classic holder still refuses exactly as before. (25af34c2)
- 8d601a9: Turso FTS (Tantivy) index segments are now bounded. Every committed write that
  touches an `USING fts`-indexed table adds a segment and nothing merged them, so
  insert cost and `fts_match` latency grew linearly with a store's write history
  (prod: 5,001 segments, fts_match 601 ms). The turso adapter now runs
  `OPTIMIZE INDEX` on every index-method index at its idle point once
  `DEFAULT_FTS_OPTIMIZE_WRITE_THRESHOLD` (256) writes have landed since the last
  pass — only when the store is quiescent (a live peer lease skips the pass and
  keeps the counter), never on a request path. A fresh process runs one catch-up
  pass at its first quiescent idle point (a 14 ms no-op on a merged index).
  Telemetry: `fts.optimize.start` / `fts.optimize.finish{index, duration_ms}` /
  `fts.optimize.skipped{reason, peer_count}` / `fts.optimize.failed`. New typed
  test-only connect option `ftsOptimizeWriteThreshold`; new read-only
  `ftsMaintenance` getter. (4cd68c4e)
- 74cc494: An integrity verdict's detail now agrees with the verdict. A row filtered as the
  documented Turso FTS false positive (`wrong # of entries in index
__turso_internal_fts_dir_*_key`, upstream turso#7611) is labelled as filtered
  and cites the new `KNOWN_FALSE_POSITIVE_RULE_ID` in the `pragma_integrity_check`
  probe detail (surfaced by `memory_ping`), and the new
  `formatIntegrityVerdictDetail()` gives callers one verdict-consistent detail
  string instead of the raw rows (which printed `integrity_ok=true` next to what
  read as a defect). (8c93d821)
- 20c97c9: Serialize concurrent cold opens of the same Turso store across processes.
  `@tursodatabase/database` 0.7.x aborts in Rust
  (`shared_wal_coordination.rs:1644`) when many processes open one store at the
  same instant, and the adapter's open retry cannot catch an abort. The real
  open now holds an advisory lock (`<db>.sox-lease.d/.coldopen.lock`, new
  `acquireColdOpenLock`) around the driver open and the open-time
  WAL-coordination init. The lock is released before the adapter is returned, so
  no caller query ever runs under it. It is stale-safe: a dead or aged-out holder
  is swept, and a live holder is waited on for at most 15 s before the open
  proceeds unlocked. Measured with 24 simultaneous cold opens per path: 7
  panics in 1536 processes without the lock, 0 in 1536 with it. 0.7.2 does not
  change the coordination code, so the lockfile stays on 0.7.1. (6fd60658)
- Updated dependencies [2657cb4]
  - @adhd/sox-telemetry@0.3.2

## 0.9.3

### Patch Changes

- 9ffd5a8: Fix a Turso FTS parse error that silently killed the whole BM25 arm for any
  recall query containing double quotes.

  `normalizeFtsTokens` split on whitespace without stripping quotes, so a query
  like `"e68be52c" or "cb47fb79" review` produced tokens with the quotes glued
  on. `buildMatchQuery` then escaped each embedded quote by doubling it (the
  SQLite FTS5 convention) and wrapped the result, yielding a triple-quoted
  token. SQLite FTS5 parses that; Turso's Tantivy parser has no doubled-quote
  escape and rejects the entire match query, which memory-core's recall handler
  downgrades to a silent `fts:` degradation — so BM25 contributed zero rows and
  the caller saw a normal-looking payload.

  The strip lands in the shared tokenizer rather than in `TursoFTSDialect`, so
  both backends keep receiving identical token sets — the invariant
  `normalizeFtsTokens` exists to guarantee. `buildMatchQuery` retains its
  escaping as defence-in-depth for callers that build tokens directly.

## 0.9.2

### Patch Changes

- 245474b: Retry the transient foreign `-shm` refusal instead of failing the open (BUG-031).

  A classic `-shm` beside a turso store is written only by a better-sqlite3 opener, and the
  guard inferred from that it must be foreign residue — refusing the open outright whenever a
  live peer held the store.

  The inference is false. This package's own sanctioned hatches are such openers:
  `preflightSchemaSanity`'s readonly `openSchemaReader` runs on the open path itself, and
  `deleteSchemaRowsViaBetterSqlite3` runs during FTS5 repair. SQLite materialises a `-shm` for
  the life of such a connection and removes it on last close, so the sidecar is routinely a
  live, legitimate artifact that clears within milliseconds — turning a millisecond window into
  a hard open failure. Reproduced in this repo's own suite at 1/300 cold-open processes by
  `tshm-init-race.spec.ts`.

  The refusal is now retried on the same bounded linear backoff the two other transient open
  races use (ADR-0012 §4). Genuine residue never clears and still refuses after the bound; a
  live hatch's sidecar clears and the open proceeds. The exhausted refusal is marked
  `retryable`, like its two siblings. The reconcile/rename branch is deliberately unchanged —
  it still fires only when the store is quiescent, so retrying cannot widen the window in which
  a live sidecar is renamed out from under its owner.

  Also corrects the "FOREIGN by construction" claim in `wal-ownership.ts`, which asserted the
  same false inference.

## 0.9.1

### Patch Changes

- Retry the transient `-tshm` cold-init open race.

  Two OS processes opening the same store concurrently could intermittently fail to
  open it at all, throwing `Corrupt database: shared WAL coordination map magic
mismatch` or `...coordination file is smaller than the coordination header: got 0,
minimum 4096`. Measured at 1/10 two-process races on 0.9.0 and 2/10 on the
  published 0.7.0, with zero application code in the path.

  It is not corruption despite the driver's wording: 5/5 observed failures recovered
  on a fresh-process retry with 0 sticky failures. A raw-driver control (no adapter)
  reproduced only the engine's own differently-worded open race and never once
  either coordination-map signature, confirming these two are adapter-path-only.

  `isTshmCoordinationInitRace` now joins `isAlreadyOpenWithoutMultiprocessWal` in the
  existing `openOnce` retry classifier — one retry path, shared attempt budget and
  backoff, original driver error rethrown unchanged on exhaustion. Scope is the
  cold-init window only; it deliberately does not touch the stale-sidecar-after-
  TRUNCATE mechanism.

## 0.9.0

### Minor Changes

- 884e3e7: Public API surface changed since the last publish.

  Each of these packages has `dist/*.d.ts` differing from the version currently on
  npm, with no changeset recording it — the drift the `check-changeset-surface` gate
  exists to catch. This changeset records it and ships the accumulated surface.

  The READMEs shipped alongside are rewritten and verified: every documented symbol
  is checked against that package's own built declarations, and every example is one
  that was executed against the built artifact.

  `@adhd/sox-memory-core` also corrects three source comments that asserted ADR-0007's
  single-writer architecture as current fact. ADR-0012 supersedes it — the default
  Turso backend runs `multiprocess-wal`, where multiple processes hold concurrent
  write connections to one store file, serialized through a `-tshm` coordinator, with
  no opt-out. Because those comments are emitted into the shipped `.d.ts`, the false
  claim was visible in consumers' editor tooltips.

### Patch Changes

- Updated dependencies [884e3e7]
  - @adhd/sox-telemetry@0.3.0

## 0.8.0

### Minor Changes

- d9a5023: Backlog-v2 library layer: decoupling, uniqueness policy, surface completion, N-signal ranker.

  ## Breaking changes (renames — no deprecated aliases)

  - **graph-store** — `SqliteGraphBackend` → `StoreGraphBackend`.
  - **hybrid-search** — `SqliteSearchBackend` → `StoreSearchBackend`, `SqliteSearchOpts` → `StoreSearchOpts`.

  The `Sqlite*` prefix was a misnomer — these backends are `StoreAdapter`-backed (sqlite _or_ turso), not SQLite-specific. Update import sites; there are no back-compat re-exports.

  - **graph-store** — `NodeUniquenessPolicy` seam (injectable `check(meta, tx)` run inside `writeNode` before the INSERT) replaces the reverted global `(kind,name)` unique index; surface primitives: `transaction`, `invalidateEdge`, `writeEdges`, `getNodesByIds`, `countBy`, edge-metadata filtering, keyset pagination (`NodeFilter.after`); bi-temporal content immutability enforced (supersede is the sole content mutation).
  - **store-adapter** — vector dialect no longer joins the graph `node` table; `topKQuery` is a pure WHERE-predicate seam and each dialect owns its own LIMIT.
  - **vector-store** — `VecFilter` is now pure `{ids}` (the graph-coupled `nodeFilter`/`liveOnly` are removed); `pruneInvalidatedVectors` → `deleteMany`; the graph-store dependency is dropped.
  - **hybrid-search** — N-signal reciprocal-rank fusion (`rrfFuse`, `temporalRescore`, `StoreSearchBackend.searchRanked`) alongside the existing min-max fusion.
  - **semantic** — first publish of the RAG composition facade (ADR-0016); delegates search fusion, no longer vector-only.
  - **memory-core** — `recall` consumes the shared `rrfScore` from hybrid-search (the hand-rolled duplicate is deleted).
  - **analysis** — `await writeEdge` at three call sites (fixes un-awaited writes).

## 0.7.1

### Patch Changes

- Fix ungated idle-flush self-re-arm and restore its self-heal (BUG-022).

  - `_performIdleFlush()`'s ungated branch was calling the public, `_trackOp`-wrapped
    `executeGet()` for its `PRAGMA wal_checkpoint(TRUNCATE)`; `_trackOp`'s `finally` unconditionally
    re-arms `_armIdleFlush()` once `_inFlightOps` hits 0, so every ungated flush re-armed its own
    timer with zero new caller activity, looping forever. It now calls `this.db.get()` directly (the
    same shape `close()` uses for the analogous checkpoint) and adds `_markIfFatal(err)` parity in the
    catch branch.
  - Restoring that direct call had silently dropped the `_ensureHealthy()` reconnection that
    `_trackOp` provided; it is now called explicitly so a flush firing on a dead/poisoned connection
    still self-heals without restoring the re-arm loop.
  - Comment-only backlog-ID disambiguation (DEBT-008) also landed on `errors`/`integrity`/`preflight`/
    `sidecar-retention`/`store-lease`/`turso-adapter` JSDoc with no signature change.

  No exported signature changed; gated (production-default) flush is untouched.

## 0.7.0

### Minor Changes

- Tune the idle-flush debounce and the WAL cap relative to what they actually govern (BL-590, BL-587).

  Minor rather than patch because this adds public API: `captureWalCapBaseline()` on the `SqliteAdapter` and `TursoAdapter` interfaces, and a new `wal-tuning` module export (`effectiveIdleFlushMs`, `effectiveWalCapBytes`, `updateWriteIntervalEwma` and their constants).

  **Idle-flush debounce is now adaptive.** The flat 2000ms window was shorter than the write cadence it existed to coalesce — the dominant writes are async vector writes from the embed pipeline at a measured `time_to_vector` p50 of 4516ms, so each one formed its own isolated burst and paid a full flush (measured coalescing ratio 12 writes / 11 flushes = 1.09). The window is now derived from an EWMA of observed inter-write gaps and clamped to `[2000ms, 30000ms]`, and both the chosen window and the EWMA are emitted on every `idle_flush` telemetry event so the tuning is checkable from logs.

  **The WAL cap is now baseline-relative.** Headroom is inherently relative to a starting point, but the cap was absolute: both adapters shared `DEFAULT_WAL_CAP_BYTES = 262144` despite very different post-schema WAL baselines (identical at 16512 bytes on a trivial schema, but a single FTS5 virtual table takes the sqlite arm to 32992, and memory-core's real schema to ~150-165 KB). The effective cap is now `baseline + HEADROOM_BYTES`, clamped to a 1 MiB ceiling.

  **Behaviour is unchanged until callers opt in.** The WAL baseline defaults to `0`, which reproduces the previous flat-cap behaviour exactly, because store-adapter cannot know when a caller's own schema DDL has finished — call `captureWalCapBaseline()` once your schema is created to get the baseline-relative cap. An explicit `walCapBytes` override still wins unconditionally.

## 0.6.0

### Minor Changes

- The adapter now owns WAL durability end to end, so no consumer has to drive checkpointing.

  - **Idle flush**: an idle adapter self-arms a coalesced flush and releases its connection, then transparently reconnects on the next operation. Consumers no longer think about connect/disconnect after the first cycle.
  - **WAL size cap**: a 256 KiB backstop issues an ungated PASSIVE checkpoint from the write path, so a store under sustained load stays bounded even when the idle timer provably never fires.
  - **Lazy connect from birth** (DEBT-003): `connect()` performs zero driver opens — no db file, no `-wal`, no lease entry — until the first real operation. Open-time integrity repair (BL-352) and the FTS orphan guard (BL-461) still run exactly once on that first operation, and an unopenable store still surfaces its error eagerly at `connect()`.
  - **SqliteAdapterImpl gained its own WAL checkpoint path** (BL-571). It previously had none, so after checkpoint ownership moved to the adapter layer the legacy backend had no TRUNCATE mechanism at all.
  - **Poison-reconnect no longer leaks a lease** (BUG-015): recovery released the connection but not its lease entry, so every recovery left an orphaned-but-live entry that made `storeQuiescence()` report a peer that did not exist and deferred TRUNCATE indefinitely.
  - `storeQuiescence` is exported, so callers can probe liveness without paying a writable classic open on the healthy path.

### Patch Changes

- Updated dependencies
  - @adhd/sox-telemetry@0.2.1

## 0.5.8

### Patch Changes

- **BUG-014 hardening program (T1–T5): the store can no longer be poisoned, and a poisoned store
  heals on the next fresh open even under live peers (INV-1/2/3/4/5).**

  - **T1/BUG-017 — quiescence-gate the writable classic-engine escape hatch (INV-1):** the proven
    poisoner (a writable better-sqlite3 open+close under live turso multiprocess peers checkpoints
    the WAL the engine needs) now declines loudly when `storeQuiescence` reports live peers —
    `preflightSchemaSanity(repair:true)` returns a typed `failed: 'declined…'` contract, and
    `withConnectionClosedForRepair` throws `RepairDeclinedLivePeersError` (carrying peer count +
    pids) instead of opening the store writable.
  - **T2/DEBT-003 — content-dead `-tshm` reconcile before the non-quiescent retry (INV-2/3):** when
    an open short-reads and the `-tshm` is provably content-dead (WAL 0 bytes, or its first indexed
    frame offset lies beyond WAL EOF), the sidecar is reconciled under live peers — the BUG-014
    lease-gate deadlock is gone; the bounded retry is reserved for genuinely-transient races and
    now logs the LATEST error on every attempt.
  - **T3/BUG014.T3 — content-deadness at ALL three reconcile decision sites (INV-3):** the mtime
    staleness heuristic (false-positive under multiprocess WAL, where `-tshm` mtime freezes at
    creation) is demoted to a log-only hint; `isTshmContentDead` is the only rename gate, so a
    healthy live store is never churned through `*.stale-*` renames.
  - **T4/BUG014.T4 — canonical path identity (INV-4):** `dbPath` is canonicalized once at connect
    (realpath of the parent dir + basename), so leases, quiescence, markers, and sidecars all key
    off ONE spelling per physical store — symlink/`/tmp`-class aliasing can no longer yield false
    quiescence.
  - **T5/BUG014.T5 — per-connection open marker:** the single shared `-openmark` (any orderly close
    unlinked it while siblings held the store) is replaced by per-connection `<leaseDir>/<token>.openmark`
    files with dead-pid unclean detection and a legacy-marker one-shot shim.

## 0.5.7

### Patch Changes

- **Lease-gate sidecar reconcile + TRUNCATE; transient-retry catch (BUG-007/008/009).**

  The adapter previously destroyed live multiprocess-WAL coordination state in three ways, all
  exposed by the 2026-08-12 live 20-way proof (15/20 WAL short-reads + 3 native panics):
  (1) the pre-open mtime heuristic renamed a live `-tshm` (its mtime freezes at creation under
  mmap-shared coordination, so active stores read as "provably stale"); (2) `close()` TRUNCATE-
  checkpointed TWICE per writable close, physically zeroing `-wal` while siblings were mid-frame-
  pread; (3) the open-time catch treated a transient race as permanent BL-373 corruption and
  renamed `-tshm` + `-shm` while siblings were live.

  Fix — one primitive: a per-store, pure-JS, cross-process **lease registry**
  (`<dbPath>.sox-lease.d/`, pid-liveness + 24h age-out sweep) answers "are any other live
  connections holding this store?", and every destructive sidecar operation is gated on it:
  **a live store is never reconciled, never truncated, and a failed open against a live store is
  retried as transient, never classified as corruption.**

  - `proactivelyReconcileStaleSidecar` / `recoverStaleWalIndex` take `{ storeInUse }` and decline
    (rename nothing) when a live peer holds the store.
  - `connect()` acquires a lease; the open-time catch checks quiescence first — live peer ⇒ bounded
    transient retry (`open_shortread_transient_retry`, reusing the ADR-0012 3-attempt ceiling),
    exhaustion rethrows the original error `retryable: true`, never the `STALE WAL-INDEX SIDECAR`
    wrapper; quiescent ⇒ the existing recovery runs unchanged.
  - `close()`: PASSIVE always (durability backstop), clean-shutdown stamp before the checkpoint,
    exactly ONE quiescence-gated TRUNCATE (contended close defers with the preserved
    `close_checkpoint_busy` event), lease released after the driver close.

  RED→GREEN: both race arms reproduced in isolation (8-way aged-tshm scratch store — the live
  `-tshm` renamed and a contended close truncating a live WAL), both green with the gates.
  Suite 465/465 (incl. the 3-leg `wal-contention-8way.bug007-009.test.ts` integration); smoke 13/13.

## 0.5.6

### Patch Changes

- **Bounded connect-level retry for the driver open-handshake race (BL-512 follow-on).**

  turso 0.7.1 rejects a `multiprocess_wal` open while a sibling opener holds the file —
  "Database is already open without experimental multiprocess WAL in another process".
  Under barrier-synced maximal contention this is the driver's own open-handshake race
  (raw-driver parity proven 2026-08-12: 1-14/20 failures with barrier sync, 0/20 without;
  a failed open mutates nothing, so retry is safe by construction). `connect()` now retries
  ONLY that exact error text — new `isAlreadyOpenWithoutMultiprocessWal` predicate in
  `errors.ts` — bounded to 3 total attempts (ADR-0012 §4 ceiling, same as
  `_runTransaction`), linear 100→200 ms backoff, WARN per attempt
  (`store_adapter.turso.open_multiprocess_wal_retry`), exhaustion rethrows the original
  driver error with `retryable: true` so the caller decides beyond the bound. No config
  toggle (ADR-0013). The BL-373 sidecar-recovery reopen inherits the retry via `openOnce`.

  18/20 → ~20/20 concurrent writers on the live store; suite 450/450 (11 new tests).

## 0.5.5

### Patch Changes

- **Header-first `application_id` probe + unconditional `multiprocess_wal` (BL-512 concurrent-write race).**

  `connect()` previously ran `readApplicationId()` on EVERY writable connect, opening the same store
  with better-sqlite3 (a legacy stock-SQLite engine) for `PRAGMA application_id`. Under concurrency that
  legacy opener made the turso engine refuse a sibling process's `multiprocess_wal` open — "Database is
  already open without experimental multiprocess WAL in another process" — and the write was lost
  (measured 2026-08-12: 6 parallel backlog `create-item` processes, 5-9/18 lost; live reproduction with
  lsof-clean external state).

  - `readApplicationId` is now **header-first** (fs `openSync`/`readSync` at offset 68 — lock-free, no
    driver, no sidecars); the better-sqlite3 pragma is the fallback for unidentifiable files only.
  - `multiprocess_wal` is **unconditional** — the `experimental: { multiprocessWal }` option was removed
    from `AdapterConfig`/`connect()`/`createTursoAdapter()` (zero callers passed it, grep-verified;
    graph-store's dead `cfg.experimental` forwarding line removed to compile).
  - **Bounded busy timeout** (`dbOpts.timeout = 5000`, always-on) on both adapters' driver connects and
    the identity probe — with the driver default `busy_timeout=0`, a connect landing in another
    process's `close()`-TRUNCATE window failed instantly "database is locked" (2-7/18 measured); with
    `timeout: 5000` that class is zero.

  RED: 9/18 persisted with the legacy-opener probe. GREEN: 18/18 production-shaped across 11 runs;
  `wal-multiwriter.bl512.spec.ts` pins cold-child better-sqlite3 load count = 0. Suite 439/439,
  graph-store 123/123, smoke-test 13/13.

## 0.5.4

### Patch Changes

- **WAL always consolidated on writable close + busy-row inspection (BL-512).**

  `close()` now runs `PRAGMA wal_checkpoint(TRUNCATE)` on EVERY writable close —
  not just on the damaged-`wal_identity` path — with a `PASSIVE` fallback and a
  never-blocks-close guarantee. Defect: a clean writable close left every frame in
  the WAL, so short-lived writers (the backlog CLI spawns one process per command)
  accumulated a forever-growing `-wal` (measured 3.8 MB beside a 19 MB db) and a
  later connection's stale-`-tshm` reconciliation could discard those uncheckpointed
  frames — the phantom-write class (`created:true`, row never persisted). TRUNCATE
  resets the `-wal` to ~0 bytes, so no uncheckpointed window survives the process
  that wrote it. A second TRUNCATE after the clean-shutdown stamp write leaves the
  file at literally 0 bytes. `_softReadonly` connections (BL-391, FTS requires a
  driver-writable handle) checkpoint too; hard `readonly` opens never do.

  The TRUNCATE result is now inspected: when a concurrent reader holds the WAL the
  pragma returns `busy:1` rather than throwing, and the adapter logs
  `store_adapter.turso.close_checkpoint_busy` instead of silently recording a
  flush that did not truncate. Frames are fsynced at COMMIT, so durability is never
  at risk — only the growth guarantee degrades under concurrency, and the next
  writable close without a concurrent reader truncates.

## 0.5.3

### Patch Changes

- **FK-heal escape hatch shared export + same-instance repair reconnect (BL-506/507/508).**

  `deleteSchemaRowsViaBetterSqlite3` — the sanctioned better-sqlite3 + `writable_schema`
  out-of-band schema-row delete the pre-flight already used for orphaned Tantivy backing —
  is promoted from preflight-private to a shared export so graph-store's FK-heal can drop
  fts5 residue with the same mechanism. New `TursoAdapterImpl.withConnectionClosedForRepair(fn)`
  closes the turso connection, runs an out-of-band repair while no turso connection holds the
  file, then reopens through the full `connect()` ceremony on the SAME instance (SPEC-CONN-RECYCLE
  pattern) so callers keep a valid handle. This is what makes the residue-drop safe: cross-engine
  WAL coordination (turso `-tshm` vs SQLite `-shm`) is exactly what destroyed stores (BL-373/BL-508),
  so the better-sqlite3 write must never run while a turso connection is open.

  Behavior for existing consumers: unchanged unless they opt into the new methods. The
  pre-flight's own repair now funnels through the shared helper with identical semantics.

## 0.5.2

### Patch Changes

- Fix Turso explicit-rowid FK failure (BL-507) + verify FTS backing materialization + engine-identity guard (BL-508) + lossy-WAL-path removal (ADR-0013) + stale-sidecar proactive reconcile (BL-373).

  - **Defect B (the production outage):** live Drizzle-era edge DDL `REFERENCES node(rowid)` fails on Turso with `foreign_keys=ON` (`foreign key mismatch referencing "node"`). `hasExplicitRowidForeignKey` detects the form; `ensureCheckConstraints` rebuilds the edge constraint on turso only — stock SQLite resolves the form and its stores stay byte-identical (BL-448 AC-3).
  - **Defect A:** `ensureFtsIndex` returned `ensured:true` without verifying 3-row materialization; `verifyTursoFtsMaterialization` (DROP+recreate once) + materialization verify in fts-ops close the half-materialized-index panic-bomb (BL-361/BL-507).
  - **Engine-identity guard (BL-508):** `application_id` marker `0x534F5854` 'SOXT' (turso) / `0x534F5853` 'SOXS' (sqlite) + `_sox_engine` row; better-sqlite3 PRAGMA-is-primary probe (WAL-aware); pre-open refusal both sides; `getEngineIdentity`/`ensureEngineMarker`/`warnOnEngineVersionMismatch`; `store_engine` surfaced on ping.
  - **ADR-0013 (owner directive #3):** `recoverTruncatedWal` and the auto-WAL-aside path deleted — a probe-truncated WAL is refusal-only with a typed operator action (manual `mv` with data-loss disclosure). `SOX_ALLOW_AUTO_WAL_ASIDE` removed. Verify `'off'` removed — the store always validates ≥ `'fast'`; an `off` request throws loudly. Repair always on (`repairEnabled()` gone). `SOX_STORE_VERIFY_SKIP` kept as a documented, visible operator lever.
  - **BL-373 (owner directive #2):** proactive stale-`-tshm` reconcile before open (`proactivelyReconcileStaleSidecar`, mtime heuristic vs WAL, 60s default threshold) — root-cause prevention, not just catch-side healing; the catch stays as the backstop. `_reconnect()` replays `connect()` so fresh-open and poisoned-cached paths heal in one place. Ping-honesty verdict `computePingHealthVerdict` (status ok/degraded/unhealthy; ok only when store opened).
  - BackupConfig typed skeleton (`enabled: true` literal, un-disablable) per ADR-0013 D2/D3 — landing pad for the upcoming backup feature; `SOX_AUTO_BACKUP_ENABLED` deleted, `SOX_AUTO_BACKUP_DIR` kept (D5 host config).
  - graph-store workspace relock: `@adhd/sox-store-adapter` from `^0.5.0` → `workspace:*` (no published-snapshot resolution).

## 0.5.1

### Patch Changes

- Republish of 0.5.0 with the `@adhd/sox-telemetry` dependency resolved to
  `0.2.0`. 0.5.0 shipped with the literal pnpm `workspace:*` protocol (it was
  published with `npm publish`, which does not rewrite the protocol the way
  `pnpm publish` does), making the published tarball uninstallable for any
  consumer (`Unsupported URL Type "workspace:"`). 0.5.0 is deprecated on npm;
  `^0.5.0` ranges (including graph-store 0.8.0's) resolve to 0.5.1. No code
  changes.

## 0.5.0

### Minor Changes

- Add the `recursiveCte` adapter capability — probed once at connect, not guessed.

  Turso Database Rust < 0.8.0 rejects `WITH RECURSIVE` at prepare (`Parse error:
Recursive CTEs are not yet supported` — proven empirically by
  `recursive-cte.probe.test.ts`), which breaks graph-store's five recursive-graph
  methods on every real 0.7.x Turso store. graph-store 0.8.0 reads this flag to
  switch those methods to iterative BFS fallbacks.

  - `AdapterCapabilities.recursiveCte: boolean` — true when the engine accepts
    `WITH RECURSIVE` at prepare. `SqliteAdapterImpl` / `MockAdapter`: always
    `true`. `TursoAdapterImpl.connect()` probes once (a read-only counter CTE in a
    try/catch, before the capabilities object is built) and caches the result on
    the instance.
  - **Source-breaking for external `StoreAdapter` implementors (0.x):** the new
    field is REQUIRED, so a hand-written adapter whose capabilities literal omits
    it stops compiling. External adapters that wrap a recursive-capable engine
    (better-sqlite3, libsql >= 0.8.0) should report `true`. graph-store reads
    `recursiveCte ?? true` so a runtime adapter that predates the field still
    defaults to the recursive path.

## 0.4.0

### Minor Changes

- 0a588bf: `TursoAdapter` detects fatal driver-level faults and recycles the poisoned connection
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
  - Lazily reconnects on the _next_ call after poisoning — via a full re-run of
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

- 6f2bb72a: Add the A2 full-text search operation surface to every adapter
  (FEAT-SOXGRAPH-001) — `ftsSearch`, `ftsCount`, and `ensureFtsIndex` on
  `StoreAdapter`, implemented by `SqliteAdapterImpl`, `TursoAdapterImpl`,
  `MockAdapter` (and memory-core's `wrapRawDbAsAdapter` bridge).

  - `ftsSearch<T>(table, columns, query, opts?)` — ranked FTS row search
    returning `Array<T & { rowid, score }>`, ordered `score DESC`. `score` is
    higher = better on BOTH backends: SQLite FTS5's negated `rank` column,
    Turso's native `fts_score`. `opts.where` is AND-ed after the match and may
    reference the base table alias `n`; `limit` defaults to 50; `offset`
    pages. Multi-term queries are normalized (trim → lowercase →
    whitespace-split) and rebuilt as an explicit `"tok1" OR "tok2"` match
    query via `FTSDialect.buildMatchQuery` (BL-367), so both engines return
    IDENTICAL rowid sets for the same query — SQLite FTS5's bareword default
    is AND and silently drops rows where not every token co-occurs.
  - `ftsCount(table, columns, query, opts?)` — row count for the same match
    (no limit/offset).
  - `ensureFtsIndex(table, columns, opts?)` — idempotent index
    creation/adoption. Resolves the index actually present rather than asking
    whether one canonical NAME is free (BL-461 — a repaired `idx_fts_node__r1`
    is adopted, never duplicated), skips per-statement `already exists`
    races, backfills the FTS5 shadow table only when `capabilities.fts5` and
    only while its segment table is empty (re-backfill would duplicate
    segments and inflate BM25 scores), and cleans the other dialect's legacy
    FTS residue — dropped on SQLite via `dialect.dropLegacyDDL`, detected and
    reported as `residueNeedsOutOfBand` on Turso, whose engine cannot
    reliably `DROP` fts5 objects.

  New types: `FtsSearchOptions`, `FtsCountOptions`, `FtsEnsureOptions`,
  `FtsEnsureResult`. New module `fts-ops.ts` (re-exported from the package
  entry) holds the per-backend SQL builders, keyed on
  `FTSDialect.supportsShadowTable` — never on `adapter.config.type`.
  Capability gate: `capabilities.fts === false` → `[]` / `0` /
  `{ ensured: false, … }`, never a throw. Noted engine deviation: Turso's
  Tantivy FTS scan ignores `OFFSET` on the same query as `fts_match`, so the
  turso builder wraps an offset query in a subquery and applies `LIMIT ?
OFFSET ?` to the materialized result (verified 2026-08-08).

### Patch Changes

- 62c72a9: Widen `isBusyError`, `isConcurrentConflict`, `isUniqueConstraintError`, `isForeignKeyError`, and
  `isDatabaseError` to also match Turso `GenericFailure` errors by message marker
  (BUG-MEMORY-001 / subsumed BUG-ERRORS-TS-CODE-HELPERS-NEVER-MATCH-TURSO-001).

  Previously all five helpers were keyed exclusively on an `SQLITE_*`-prefixed `err.code` — a shape
  real for `SqliteAdapterImpl`'s better-sqlite3 driver but never produced by the live
  `@tursodatabase/database@0.7.1` driver, which emits `code: 'GenericFailure'` on every error it
  raises. On the live (Turso) backend these helpers were unreachable dead code: a genuine lock/busy
  condition, UNIQUE violation, or FOREIGN KEY violation was never classified as such, and
  `memory-core`'s `wrapDbError` (which is meant to build on these helpers) fell through to a generic,
  permanent `E_IO` for a condition that was actually transient and retryable.

  Each helper now additionally matches the driver's own message text, following the same technique
  already established by `isFatalConnectionError` (match message markers, never `err.code`):

  - `isBusyError` / `isConcurrentConflict` — `/database (is|table is) locked/i` or `/database is
busy/i`
  - `isUniqueConstraintError` — `/Runtime error:\s*UNIQUE constraint failed/i`
  - `isForeignKeyError` — `/Runtime error:\s*FOREIGN KEY constraint failed/i`
  - `isDatabaseError` — `code === 'GenericFailure'` AND the driver's own phase-prefix convention
    (`/^(prepare|step|reset) failed:/i`)

  No function changed signature; no previously-`true` result becomes `false` — this is a strict
  widening (more `true`, never fewer) over the existing SQLite `code`-based branch, which is
  unchanged. Existing SQLite-mode callers see byte-identical behavior.

## 0.3.0

### Minor Changes

- 32275f7: Additive FTS-index tooling (BL-461).

  New exports in `fts-dialect.d.ts`: `canonicalFtsIndexName(table): string` and `resolveExistingFtsIndexName(adapter, table): Promise<string | null>`. New module
  `fts-orphan-guard.d.ts` (types `OrphanedFtsIndex`, `FtsOrphanRepair`, `FtsOrphanGuardResult`;
  functions `findOrphanedFtsIndexes`, `nextShadowIndexName`, `guardSucceeded`,
  `guardOrphanedFtsIndexes`, `describeFtsOrphanGuard`), re-exported from `index.d.ts` via `export *
from './fts-orphan-guard.js'`. No removed or narrowed export in any of the three changed files —
  minor.

## 0.2.0

### Minor Changes

- A backup can no longer be certified `ok` when nothing was actually verified (BL-449, BL-341).

  Post-`VACUUM INTO` reverification ran `only: ['pragma_integrity_check']`, so every probe written after that narrowing — including `fts_index_live` — never ran on the copy. A backup whose full-text index was dead came back `'ok'`. It also read a flag that excludes `unknown` by design, so a probe that could not run **at all** also reported `'ok'`. And `integrity_check` truncated at its 100-message cap read as a clean bill of health.

  - New additive `integrityReport` on `AdapterBackupResult`/`BackupStoreResult`: `status: 'verified' | 'damaged' | 'unverified'`, plus `capped`, `unknownCount`, `damagedCount`, `probesRun` and structured `findings`.
  - `capped` travels via a structural `IntegrityFinding.truncated` boolean — nobody parses prose.
  - `integrityCheck: string` keeps its exact prior semantics for compatibility.

  `unverified` deliberately **keeps** the backup: a store too small to yield an FTS sentinel is healthy, not damaged, and an earlier cut that treated it as failure deleted the backup of a healthy store. Deletion still happens only on `damaged`.

  Verified on a copy of a live 108 MB store: verdict `verified`, six probes instead of one, verification 0.6s → 1.1–2.1s inside a 2.1–3.2s backup.

## 0.1.1

### Patch Changes

- Updated dependencies [1291af4]
  - @adhd/sox-telemetry@0.2.0
