# @adhd/sox-store-adapter

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
