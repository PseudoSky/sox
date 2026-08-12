# @adhd/sox-store-adapter

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
  - **T3/BUG-021 — content-deadness at ALL three reconcile decision sites (INV-3):** the mtime
    staleness heuristic (false-positive under multiprocess WAL, where `-tshm` mtime freezes at
    creation) is demoted to a log-only hint; `isTshmContentDead` is the only rename gate, so a
    healthy live store is never churned through `*.stale-*` renames.
  - **T4/BUG-018 — canonical path identity (INV-4):** `dbPath` is canonicalized once at connect
    (realpath of the parent dir + basename), so leases, quiescence, markers, and sidecars all key
    off ONE spelling per physical store — symlink/`/tmp`-class aliasing can no longer yield false
    quiescence.
  - **T5/BUG-019 — per-connection open marker:** the single shared `-openmark` (any orderly close
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
