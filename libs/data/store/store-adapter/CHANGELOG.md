# @adhd/sox-store-adapter

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
