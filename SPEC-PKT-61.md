# SPEC-PKT-61 — the operator migration for open `kind`/`rel` on existing stores (BL-442)

Author: architect stage, PKT-61. Implementer: build exactly this; do not improvise past a ruling
below. If you hit a decision this document does not cover, stop and escalate — do not guess.

Branch: `feat/pkt61-operator-migration`. Worktree:
`/Users/nix/dev/ai/sox-ecosystem/.worktrees/pkt61-operator-migration`.

---

## 1. Root cause

`SqliteGraphBackend.applySchema()` (`libs/data/graph/graph-store/src/index.ts:893-913`) creates fresh
stores via `INLINE_MIGRATION_DDL` (`:177-255`), whose `"kind"`/`"rel"` columns are plain
`text NOT NULL` — **no `CHECK` at all** (`:181`, `:213`). That is PKT-58/PKT-74/D1/D4 already landed.
But `CREATE TABLE IF NOT EXISTS` is a no-op against a table that already exists, so every store that
existed before those packets landed — including the live `~/.memory/memory.db` — was never touched by
that DDL edit and still has whatever schema it had.

`applySchema()` also calls `ensureCheckConstraints()` (`:915-958`) on every open. That method's own
rebuild path targets `NODE_TABLE_DDL`/`EDGE_TABLE_DDL` (`:259-303`), and **those two constants still
carry the closed enum CHECK** — `CHECK (kind IN ('episode',...,'generic'))` at `:262`,
`CHECK (rel IN ('MENTIONS',...,'DEPENDS_ON'))` at `:294`. `ensureCheckConstraints()`'s own rebuild
trigger (`hasEnumCheckConstraint()` + the `'generic'`/`'DEPENDS_ON'` literal check, `:915-931`) only
fires for a store whose CHECK predates those two enum members (a store from before both were added,
i.e. pre-mid-2026) — confirmed by tracing the condition: for the live store, whose CHECK already
contains `'generic'`/`'DEPENDS_ON'`, `nodeNeedsRebuild`/`edgeNeedsRebuild` both evaluate `false`, so
`applySchema()` does nothing to it. **This is by design** (BL-447, `CHANGELOG.md:5-40`) — the whole
point of BL-447's structural-presence fix was to stop that path from firing an *unconditional*
rebuild-on-every-open loop the moment `kind`/`rel` open up; upgrading a genuinely-legacy store is still
its job, performing the open-schema migration is explicitly **not**.

So: no code path in this repository today ever removes the closed CHECK from an existing store's
`node`/`edge` tables. That removal requires the exact rename→create→copy→drop rebuild BL-313 proved
cascade-deletes every edge (`CHANGELOG.md:2835-2889`) — with `PRAGMA foreign_keys = ON` always on
(`index.ts:11`), `ALTER TABLE node RENAME TO node_old` rewrites `edge`'s FK to dangle at `node_old`,
and `DROP TABLE node_old` cascades every `edge` row away, silently, no exception. BL-313's fix
(`rebuild-table.ts:52-54`'s `skipDrop` flag, consumed at `index.ts:933-957`) is the only proven-safe
sequencing: copy *both* tables' data into their new incarnations before dropping *either* `_old`, so
by the time any `ON DELETE CASCADE` can fire, the data it would have deleted has already been copied
forward. PKT-61 is the packet that reuses that sequencing to perform the CHECK removal itself, as an
explicit, operator-invoked, offline, verified-and-reversible action — never automatic, per ADR-0010 D3
(`docs/decisions/0010-open-node-and-edge-typing.md:76-96`).

---

## 2. The change, file by file

### 2.1 `libs/data/graph/graph-store/src/index.ts` — ADDITIVE ONLY

No existing line changes meaning. No new logic in `applySchema()` or `ensureCheckConstraints()`. Two
kinds of edit, both additive:

1. **Promote five module-private `const`s to `export const`** (no other change to their bodies):
   `NODE_TABLE_DDL` (`:259`), `EDGE_TABLE_DDL` (`:290`), `NODE_COLUMNS` (`:305`), `EDGE_COLUMNS`
   (`:313`), `NODE_INDEX_DDLS` (`:318`), `EDGE_INDEX_DDLS` (`:332`). `FTS_TRIGGERS` and `FTS_DDL` are
   already exported (`:149`, `:144`) — no change needed there. `rebuildTable` is already exported
   (`:5`) — no change needed.
2. **Add two new exported constants**, `NODE_TABLE_DDL_OPEN` and `EDGE_TABLE_DDL_OPEN` — byte-identical
   to `NODE_TABLE_DDL`/`EDGE_TABLE_DDL` with only the `CHECK (kind IN (...))` / `CHECK (rel IN (...))`
   clause removed (leave `kind`/`rel` as plain `TEXT NOT NULL`, matching `INLINE_MIGRATION_DDL`'s
   `"kind" text NOT NULL` / `"rel" text NOT NULL` shape at `:181`/`:213`). **Do not derive this
   programmatically by regex-stripping the CHECK out of `NODE_TABLE_DDL`** — write it out literally,
   the same way `NODE_TABLE_DDL` itself is written out literally. The exact text already exists,
   proven correct, in
   `libs/data/graph/graph-store/src/ensure-check-constraints.bl447.spec.ts:81-125` as
   `OPEN_SCHEMA_NODE_DDL`/`OPEN_SCHEMA_EDGE_DDL` — copy those two constants verbatim (same 28 node
   columns including `access_count`/`last_access`/`t_updated`, same 12 edge columns). That test file's
   own comment block (`:70-80`) documents a prior mismatch that was caught by a crash, not a silent
   pass — copying its already-corrected text sidesteps re-discovering the same mistake.

**Out of bounds in this file:** the bodies of `applySchema()`, `ensureCheckConstraints()`,
`hasEnumCheckConstraint()`, `addColumnIfMissing()` (`:855-966`) — zero changes. Do not add an import of
the new migration module (§2.2) into this file, in either direction beyond what's listed above. See
Decision D-6 for why.

### 2.2 `libs/data/graph/graph-store/src/rebuild-table.ts` — UNCHANGED

Import and call `rebuildTable(...)` with `{ skipDrop: true, tx }` exactly as `ensureCheckConstraints()`
already does at `:936`/`:939`. **Do not add a parameter, branch, or new call shape to this file.** The
packet's own instruction is explicit: "reuse `skipDrop`; do not re-invent the sequencing." This file
already supports everything the migration needs (`opts.tx` to run inside a caller-supplied transaction,
`opts.skipDrop` to defer both drops) — verified by reading `rebuild-table.ts:1-62` directly.

### 2.3 NEW `libs/data/graph/graph-store/src/open-schema-migration.ts`

The operator-invoked entry point. Exports:

```ts
export interface MigrateOpenSchemaOptions {
  /** TEST-ONLY. Never set this from production code or the CLI (§2.5 enforces this).
   *  When true, the post-commit re-verification step (§3 step 8) is told the just-recomputed
   *  edge count is wrong regardless of what it actually is, forcing the restore-from-backup path
   *  to execute for real. This is the only way to prove AC-3 (rollback) without engineering a
   *  genuine torn write. */
  __test_forcePostCommitMismatch?: boolean;
}

export type MigrateOpenSchemaResult =
  | { status: 'migrated'; backupPath: string; before: StoreSnapshot; after: StoreSnapshot }
  ;
  // (the function never *returns* a failure — every failure mode throws one of the typed errors
  //  below, so a caller cannot mistake "rejected" for "succeeded")

export interface StoreSnapshot {
  nodeCount: number;
  edgeCount: number;
  perRelation: Record<string, number>; // rel -> count, live edges only (matches BL-442's
                                        // "per-relation edge breakdown" wording)
  nodeChecksum: string;                // sha256 over an ordered, stable projection — see §3 step 6
  edgeChecksum: string;
}

export class MigrationPreflightError extends Error {}
export class UnsupportedBackendError extends Error {}      // Turso-formatted file — refuse
export class StoreOpenElsewhereError extends Error {}       // exclusive lock unobtainable
export class BackupNotVerifiedError extends Error {}        // backupTo()'s integrityReport
                                                              // wasn't 'verified'
export class MigrationVerificationError extends Error {}    // in-transaction pre-commit mismatch
                                                              // (SQL ROLLBACK already ran)
export class MigrationRolledBackError extends Error {}       // post-commit mismatch; file-level
                                                              // restore ran and was itself verified
export class MigrationRestoreFailedError extends Error {}    // restore itself didn't reproduce the
                                                              // backup's counts — unrecoverable,
                                                              // never silently swallowed

export async function migrateToOpenSchema(
  dbPath: string,
  opts?: MigrateOpenSchemaOptions,
): Promise<MigrateOpenSchemaResult>;
```

Imports FROM `./index.js`: `rebuildTable`, `NODE_TABLE_DDL_OPEN`, `EDGE_TABLE_DDL_OPEN`,
`NODE_COLUMNS`, `EDGE_COLUMNS`, `NODE_INDEX_DDLS`, `EDGE_INDEX_DDLS`, `FTS_TRIGGERS`. Imports from
`@adhd/sox-store-adapter`: `createSqliteAdapter`, `ETursoNativeStore`, and the `SqliteAdapter` type.
Imports `node:crypto`, `node:fs`. **This file imports FROM `index.ts`; `index.ts` never imports from
this file (Decision D-6).**

### 2.4 NEW `libs/data/graph/graph-store/src/open-schema-migration.bl442.spec.ts`

The full test suite — see §4 for the exact criteria and RED arms.

### 2.5 NEW `tools/graph-store-migrate-open-schema.mjs` — the CLI surface

A thin, dependency-free Node ESM script (repo tool, not a package export — Decision D-6). Contract:

```
node tools/graph-store-migrate-open-schema.mjs --db <path> --confirm
node tools/graph-store-migrate-open-schema.mjs --db <path>          # dry-run: prints what it would
                                                                      # do, touches nothing, exits 0
```

- Requires `npx nx build graph-store` to have been run first; imports
  `../libs/data/graph/graph-store/dist/open-schema-migration.js` by relative path (never through the
  package's public `exports` map — see D-6) and fails loudly with a clear "build graph-store first"
  message (not a raw `ERR_MODULE_NOT_FOUND`) if `dist/` is missing.
- Without `--confirm`: print the resolved `dbPath`, confirm the file exists, and stop — no adapter is
  opened, nothing is touched. This is the safety rail for an operator who fat-fingers the path.
- With `--confirm`: call `migrateToOpenSchema(dbPath)`. On success, print the returned
  `MigrateOpenSchemaResult` (backup path, before/after counts) and exit 0. On any thrown error, print
  the error's `name` and `message` plainly (these are the typed errors from §2.3 — each one's message
  must be operator-readable on its own, no stack-trace spelunking required) and exit 1.
- **Never** exposes `__test_forcePostCommitMismatch` as a flag. There is no code path from any CLI
  argument to that option.
- No `--repair`/`--force`/backend-override flag. If the store is Turso-formatted, the script prints
  `UnsupportedBackendError`'s message (which names BL-337/BL-361 and says this migration does not
  support Turso-backed stores) and exits 1. This is deliberate — see Decision D-3.

---

## 3. The migration function's control flow (bind this exactly — every step is load-bearing)

1. **Existence check.** `fs.existsSync(dbPath)` — else `throw new MigrationPreflightError(...)`.
2. **Open + Turso-format detection, for free.** `const adapter = createSqliteAdapter({ dbPath })`.
   `SqliteAdapterImpl`'s constructor already probes `sqlite_master` at open time and throws a typed
   `ETursoNativeStore` if the file carries a Turso `USING fts (...)` index row — proven, shipped,
   tested at `libs/data/store/store-adapter/src/sqlite-adapter.ts:140-164` and
   `libs/data/store/store-adapter/src/__tests__/sqlite-turso-native-store.bl329.test.ts`. Catch
   `ETursoNativeStore` specifically and re-throw as `UnsupportedBackendError` with a message naming
   BL-337/BL-361 and stating this migration does not run against Turso-formatted stores. Do not write
   a second, hand-rolled Turso-format probe — see Decision D-2.
3. **`await adapter.init()`** — runs the adapter's own BL-352 stamp/self-heal. If it throws, close the
   adapter and re-throw as-is (do not proceed against a store whose own integrity gate failed).
4. **Lock probe.** `try { await adapter.transaction(async () => {}, { mode: 'exclusive', maxRetries: 0
   }); } catch (err) { await adapter.close(); throw new StoreOpenElsewhereError(dbPath, { cause: err
   }); }`. An empty `BEGIN EXCLUSIVE ... COMMIT` — proves no other connection currently holds so much
   as a read transaction. `maxRetries: 0` is required: `SqliteAdapterImpl.transaction()`'s default
   (`maxRetries: 3`, exponential backoff, `sqlite-adapter.ts:298-305,311`) would silently retry past a
   momentary lock instead of refusing — see Decision D-4.
5. **Verified backup.** `const backupPath = \`${dbPath}.pre-open-schema-migration-${Date.now()}.bak\`;
   const backupResult = await adapter.backupTo(backupPath);` — `backupTo()` already runs `VACUUM INTO`
   plus a full `verifyStoreIntegrity({ depth: 'deep' })` pass against the copy and returns a structured
   `integrityReport.status` of `'verified' | 'damaged' | 'unverified'`
   (`sqlite-adapter.ts:215-247`, `types.ts:1841-1865`). Do not pass `skipIntegrityCheck: true`. If
   `backupResult.integrityReport?.status !== 'verified'`, close the adapter and
   `throw new BackupNotVerifiedError(backupResult)` — **nothing has been mutated yet**, this is a safe
   abort. See Decision D-1 for why this existing primitive is the backup mechanism, not a hand-rolled
   `fs.copyFileSync`.
6. **Baseline snapshot from the backup, not the live file.** Open a *second*, read-only adapter on
   `backupPath` (`createSqliteAdapter({ dbPath: backupPath, readonly: true })`), compute a
   `StoreSnapshot` (§2.3) via a shared `captureSnapshot(adapter)` helper:
   - `nodeCount` / `edgeCount`: `SELECT COUNT(*) FROM node` / `edge`.
   - `perRelation`: `SELECT rel, COUNT(*) AS c FROM edge GROUP BY rel ORDER BY rel`.
   - `nodeChecksum`: `crypto.createHash('sha256')` over
     `SELECT rowid, uid, kind, content_hash FROM node ORDER BY rowid` rows, joined with a stable
     separator.
   - `edgeChecksum`: same hash shape over `SELECT rowid, src, dst, rel FROM edge ORDER BY rowid`.
   Close this read-only adapter. This snapshot is the canonical "before" state for every later
   comparison — it comes from the verified backup, not from a live read that could itself be stale.
7. **The migration transaction — one transaction, both tables, exact BL-313 sequencing.**
   `await adapter.transaction(async (tx) => { ... }, { mode: 'exclusive', maxRetries: 0 })`:
   1. Re-capture a snapshot via `tx` reads and compare it to step 6's backup baseline. If they
      disagree, `throw new MigrationVerificationError('backup baseline and live store disagree before
      any rebuild ran — another writer touched the store between backup and migration')` — this
      catches the TOCTOU window between steps 5/6 and this transaction (see Risk R-1); the transaction
      auto-rolls-back (nothing was touched) and the thrown error surfaces to the caller.
   2. `await rebuildTable(adapter, 'node', NODE_TABLE_DDL_OPEN, NODE_COLUMNS, { skipDrop: true, tx })`
   3. `await rebuildTable(adapter, 'edge', EDGE_TABLE_DDL_OPEN, EDGE_COLUMNS, { skipDrop: true, tx })`
   4. `await tx.exec('DROP TABLE node_old'); await tx.exec('DROP TABLE edge_old');` — **both drops only
      after both new tables are fully populated** — this ordering is the entire fix; do not drop either
      `_old` earlier, and do not reorder 2/3 relative to 4. This is `ensureCheckConstraints()`'s own
      proven sequencing (`index.ts:934-943`), reused verbatim.
   5. `for (const ddl of NODE_INDEX_DDLS) await tx.exec(ddl); await tx.exec(FTS_TRIGGERS); await
      tx.exec('INSERT INTO fts_node(rowid, content, name, summary) SELECT rowid, content, name,
      summary FROM node'); for (const ddl of EDGE_INDEX_DDLS) await tx.exec(ddl);` — mirrors
      `index.ts:945-955` exactly, including the FTS re-sync step, for the same reason: consistency with
      the one sequencing this codebase has already proven safe, not a "should be unnecessary" shortcut.
   6. Re-capture a snapshot via `tx` reads and compare to the step-7.1 snapshot (equivalently, step 6's
      baseline). Compare `nodeCount`, `edgeCount`, `perRelation` (deep-equal), `nodeChecksum`,
      `edgeChecksum`. **Any** disagreement: `throw new MigrationVerificationError(diff)` — the
      surrounding `adapter.transaction()` call catches this, issues `ROLLBACK`, and re-throws
      (`sqlite-adapter.ts:319-330`) — the working file's `node`/`edge` are left byte-identical to
      before this call, no file-level restore needed for this layer. This is the criterion that must
      reproduce BL-313's exact failure mode when the sequencing in 7.2-7.4 is deliberately broken (see
      AC-1).
   7. On success, `tx` returns the post-rebuild snapshot; the outer `transaction()` call commits.
8. **Post-commit paranoia re-verification.** Close the working `adapter`, open a *fresh*
   `createSqliteAdapter({ dbPath })`, capture a snapshot the same way as step 6. If
   `opts?.__test_forcePostCommitMismatch === true`, overwrite this snapshot's `edgeCount` with `-1`
   before comparing (documented test-only hook, §2.3). Compare against the step-6 backup baseline
   (`nodeCount`, `edgeCount`, `perRelation`, `nodeChecksum`, `edgeChecksum`).
   - **Match:** close the fresh adapter, `return { status: 'migrated', backupPath, before, after }`.
   - **Mismatch:** this is the rollback path (§3.1). Close the fresh adapter. Delete `dbPath` and any
     of `${dbPath}-wal` / `${dbPath}-shm` / `${dbPath}-journal` that exist. `fs.copyFileSync(backupPath,
     dbPath)`. Open one more fresh adapter on `dbPath`, capture a snapshot, and compare it to the step-6
     baseline. If it now matches: close, `throw new MigrationRolledBackError({ mismatch, backupPath,
     restoredSnapshot })` — the caller sees a clear failure, but the store on disk is provably restored.
     If it still does *not* match (should be unreachable — `backupPath` was itself verified in step 5):
     close, `throw new MigrationRestoreFailedError({ backupPath, restoredSnapshot })` and never claim
     success.

### 3.1 Why a two-layer verify/rollback, not one

Step 7.6's in-transaction check (Layer 1) is sufficient, by SQLite's own transactional guarantees, to
make the naive-sequential BL-313 failure mode unreachable: everything through the rebuild happens
inside one uncommitted transaction, so throwing before `COMMIT` undoes the cascade delete along with
everything else. Step 8's post-commit re-check (Layer 2) exists for two reasons stated explicitly, not
assumed: (a) BL-442's own acceptance text requires a *demonstrated* restore-from-backup, which Layer 1
alone can never exercise — a SQL rollback restores by never having committed, not by "restoring", so a
test built only against Layer 1 could not prove the restore machinery works at all; (b) Layer 1 can only
see what the transaction itself reads — it cannot catch damage introduced by something outside the
transaction's view (e.g. a torn write during `COMMIT` itself). Layer 2 is the genuine safety net for
that residual case, and its file-level restore path is what `__test_forcePostCommitMismatch` exists to
exercise deterministically.

---

## 4. Decisions, ruled

### D-1 — Backup is `StoreAdapter.backupTo()`, not a hand-rolled file copy

**Ruling:** use the existing `backupTo()` (`VACUUM INTO` + `verifyStoreIntegrity({depth:'deep'})`,
`sqlite-adapter.ts:215-247`) exactly as-is, and gate on `integrityReport.status === 'verified'`.

**Rejected alternative — `fs.copyFileSync(dbPath, backupPath)`.** Loses because a raw file copy of a
WAL-mode SQLite database taken while any connection (even our own) has the file open is not guaranteed
consistent — WAL contents may not be checkpointed into the main file yet. `VACUUM INTO` is the
SQLite-native, engine-driven way to produce a single consistent file regardless of WAL state, and this
codebase already has a tested, backend-agnostic implementation of exactly that plus a real
post-copy integrity verdict. Re-implementing either half would be duplicating already-shipped,
already-tested infrastructure for no gain, and would drop the integrity verdict PKT-61's own acceptance
criteria requires ("verified rollback").

### D-2 — Turso-format detection reuses `ETursoNativeStore`, no new probe

**Ruling:** `createSqliteAdapter({ dbPath })`'s constructor already performs a single
`SELECT name FROM sqlite_master LIMIT 1` at open time and converts a Turso-native schema-parse failure
into a typed `ETursoNativeStore` (`sqlite-adapter.ts:140-164`, proven by
`sqlite-turso-native-store.bl329.test.ts`). The migration catches that specific type and converts it to
`UnsupportedBackendError`.

**Rejected alternative — hand-write a second `sqlite_master` scan for `USING fts (` inside
`open-schema-migration.ts`, modelled on `store-adapter/src/preflight.ts`'s private `openSchemaReader`/
`isTursoFtsIndexSql`.** Loses on two grounds: (1) it requires either a new direct `better-sqlite3`
import into `graph-store` — which nothing in this package does today (confirmed: no `better-sqlite3`
or `drizzle-orm` import anywhere in `libs/data/graph/graph-store/src/*.ts`, despite the package's own
`CLAUDE.md` listing them as "declared deps" — that note is stale, not a license to add a new one), or
exporting `preflight.ts`'s private helpers from `store-adapter`, which is out of this packet's Files
scope; (2) it would duplicate detection logic BL-329 already ships, tested, for a case this packet does
not otherwise need to touch at all. Reusing the typed error is strictly less code and zero new surface.

### D-3 — Turso-backed stores are refused outright, never repaired inline

**Ruling:** on `UnsupportedBackendError`, the migration stops. It does not attempt the BL-337 orphan-FTS
repair path (`preflight.ts`'s `preflightSchemaSanity({ repair: true })`).

**Rejected alternative — detect Turso, then run the BL-337 repair before proceeding.** Loses because
that repair addresses a *different* failure (orphaned Tantivy backing objects causing a driver PANIC on
`fts_match`, BL-361) that is explicitly owned by other packets (PKT-69, PKT-70, named in BL-442's own
text as owning "those two hazards" — read their outputs before choosing, which the packet instructs and
which have not landed as of this spec). Implementing that repair here would (a) roughly double this
packet's scope past its ~34-turn budget, (b) require the migration to run against a live Turso engine
connection for the rebuild itself — a combination (`BEGIN EXCLUSIVE` semantics, `rebuildTable`'s
`AdapterTransaction` shape, FTS5 trigger recreation) that has never been exercised against
`TursoAdapterImpl` and would need its own from-scratch verification, not a decision to make by
extension of this one. An explicit refusal with a clear, BL-337/BL-361-citing error message is the
correct scope boundary: it is a decision, not a gap — this ADR's own D3 language explicitly requires
deciding this, not discovering it at runtime, and refusing satisfies that.

### D-4 — the "store open elsewhere" gate is `BEGIN EXCLUSIVE` with `maxRetries: 0`, not the Turso
open-marker file

**Ruling:** the lock probe in §3 step 4 (a no-op `adapter.transaction(fn, { mode: 'exclusive',
maxRetries: 0 })`) is the sole mechanism.

**Rejected alternative — reuse `hasStoreOpenMarker()`/`markStoreOpen()` from `store-adapter/preflight.ts`.**
Loses because that marker mechanism is wired **only** into `TursoAdapterImpl`
(`turso-adapter.ts:287,364,668` — confirmed by grep; `SqliteAdapterImpl` never calls any of
`markStoreOpen`/`clearStoreOpenMarker`/`hasStoreOpenMarker`). Since D-3 already refuses every
Turso-backed store before reaching this point, the marker would never even be consulted for a store
this migration actually operates on — it is a dead check for this code path, not a real one. `BEGIN
EXCLUSIVE` is a real, engine-enforced lock acquisition that works for exactly the backend (SQLite-format
file) this migration runs against, requires no other process's cooperation (unlike the marker, which is
only as good as every writer remembering to maintain it), and is already exposed on the interface this
migration already depends on (`StoreAdapter.transaction()`'s documented `'exclusive'` mode,
`types.ts:278`: *"'exclusive' for schema migrations"* — this is literally what that mode is for).
`maxRetries: 0` is required because the default (3 retries, exponential backoff,
`sqlite-adapter.ts:298-299`) is built for transient contention, not a hard refusal — with the default,
a momentarily-busy store would silently succeed a few hundred milliseconds later instead of refusing.

### D-5 — content checksum is an app-level SHA-256 over an ordered projection, not a SQLite built-in

**Ruling:** compute `crypto.createHash('sha256')` over `rowid`-ordered, comma/newline-joined text built
from `(rowid, uid, kind, content_hash)` for nodes and `(rowid, src, dst, rel)` for edges (§3 step 6).

**Rejected alternative — `PRAGMA integrity_check` / a full-row hash including every column (`content`,
`meta`, `tags`, etc).** `integrity_check` verifies btree structure, not row *content* equality between
two points in time — it would pass even if row content silently changed, so it cannot serve as the
"content checksum" BL-442's acceptance text asks for. A full-row hash was considered and rejected as
unnecessarily fragile for this packet's purpose: `content`/`meta`/`tags` are exactly the columns
untouched by this migration (only `kind`'s/`rel`'s *constraint*, not their values, changes; the
`rebuildTable` `INSERT ... SELECT` in §3 step 7 copies every column through unmodified) — a narrower
projection over columns that uniquely identify a row (`uid`, `content_hash`) plus its structural
position (`rowid`) is sufficient to detect the BL-313 failure mode (rows disappearing) and is cheap
enough to run against a populated store without the migration itself becoming the next thing that times
out. `content_hash` is already the column this schema itself uses for node dedup
(`index.ts:972-976`) — reusing it here is consistent with what the schema already treats as identity.

### D-6 — `index.ts` never imports the migration module; the CLI lives in `tools/`, not a package
export

**Ruling:** `open-schema-migration.ts` imports FROM `index.ts` (exported DDL/column/index constants,
§2.1); `index.ts` contains zero reference — no import, no re-export — to `open-schema-migration.ts` or
`migrateToOpenSchema`. The CLI script lives at `tools/graph-store-migrate-open-schema.mjs` and imports
the built artifact by relative path into `dist/`, never through `@adhd/sox-graph-store`'s public
`exports` map.

**Rejected alternative A — re-export `migrateToOpenSchema` from `index.ts`'s bottom (alongside
`createGraphBackend`).** Loses on two independent grounds: (1) it creates a two-way module reference
between `index.ts` and `open-schema-migration.ts` (the new file imports constants from `index.ts`; a
re-export would have `index.ts` import back from it) — a circular ES-module import, which this
repository has already been burned by once in a related shape (BL-231, `libs/data/CLAUDE.md` §7,
top-level-await breaking every CJS consumer through the exact same "data package quietly changes its
module graph" mechanism); nothing about this packet requires taking that risk. (2) It would silently
widen `@adhd/sox-graph-store`'s **published, public** `.` entrypoint mid-release-train, which ADR-0010
explicitly scoped with care (`docs/decisions/0010-open-node-and-edge-typing.md:133-146` — the release
notes already have to explain what breaks about `EdgeRel`; adding a new public destructive-operation
export is a second API decision this packet has no owner authorization to make unilaterally). Keeping
the boundary one-directional also makes the static unreachability test in AC-4 simpler and stronger: a
whole-file text search of `index.ts` for the migration's identifiers is sufficient and correct, with no
need to bound-extract `applySchema()`'s body, because there is truly nothing to find.

**Rejected alternative B — add a `sox graph-store migrate-open-schema` verb to `apps/sox/src/main.ts`.**
Loses because BL-442's own Files list scopes this packet to `graph-store`'s `index.ts` + `rebuild-table.ts`
plus new files; `apps/sox/src/main.ts` is a hot, heavily-shared, actively-contended file this session
(per the repo's own CLI-shim rule, all CLI logic already funnels through this one file) and touching it
adds risk and review surface — a merge conflict here blocks every other agent's CLI work — for a
capability whose only consumer today is a single operator running a single, deliberate, offline command.
A `tools/*.mjs` script is the repository's own established shape for exactly this kind of one-off
operator tool (`tools/probe-adr0004-migrate-home.mjs`, `tools/baseline-capture/*` are the direct
precedent, confirmed by reading `tools/probe-adr0004-migrate-home.mjs:1-60`). If this migration later
needs to be a first-class `sox` verb, that is a separate, explicit decision for a later packet — not an
inherited scope expansion of this one.

### D-7 — the migration function owns its own `dbPath`; it never accepts a caller-supplied,
already-open `StoreAdapter`

**Ruling:** `migrateToOpenSchema(dbPath: string, opts?)` — the function opens, uses, and closes its own
adapter(s) internally. There is no overload or parameter that accepts a pre-constructed `StoreAdapter`.

**Rejected alternative — accept an already-open `StoreAdapter` (matching `SqliteGraphBackend`'s own
constructor shape, `index.ts:888-891`).** Loses because the file-level backup/restore machinery (§3
steps 5, 8) fundamentally needs direct filesystem access to `dbPath` and its `-wal`/`-shm` sidecars —
an already-open adapter doesn't expose that reliably (`config.dbPath` is optional on the interface,
`types.ts:216`, and a caller who constructed the adapter from a raw handle wouldn't have one at all).
More importantly: this is the structural property that makes AC-4 (unreachable from `applySchema()`)
true by construction rather than only by grep. `SqliteGraphBackend.applySchema()` only ever has
`this.adapter` in scope (`index.ts:884`) — an already-open connection, never a raw path string. A
function whose *signature* requires a `dbPath` it structurally does not have cannot be wired in by
accident; someone would have to deliberately thread a new path parameter all the way through
`GraphBackend`'s public interface to call it from there, which is a large, visible change this review
would catch, not a one-line accident. This is exactly BL-442's own stated bar: *"If a consumer can
trigger it by passing a value, the design is wrong — stop and report."*

---

## 5. Acceptance criteria (naming BL-442), each with its RED arm

Test file: `libs/data/graph/graph-store/src/open-schema-migration.bl442.spec.ts`, unless noted.
Every fixture that inserts rows must run with `PRAGMA foreign_keys = ON` **asserted in the test itself**
(`expect(await adapter.pragmaGet<number>('foreign_keys')).toBe(1)`), not merely relied on implicitly —
this is what makes the fixture prove the BL-313 mechanism rather than a defanged variant of it.

### AC-1 — BL-442 core: `skipDrop`-interleaved sequencing preserves edges; naive sequential does not

Seed 10 nodes and 90 edges (all-pairs `i != j` over 10 nodes, `RELATES_TO`) into a store carrying the
**closed** `NODE_TABLE_DDL`/`EDGE_TABLE_DDL` CHECK (reuse the exact fixture shape and row counts from
`graph-store.spec.ts:533-546`'s existing `'BL-313 cascade-delete'` test — same 10×9 all-pairs
construction, so this is a *retargeting* of an already-proven fixture, not a new invention). Call
`rebuildTable()` directly (not through `migrateToOpenSchema()` — see the note in §5 preamble below on
why this must be the low-level call) twice, in two sub-tests:

- **RED, run and observed, not asserted in prose:** call `rebuildTable(adapter, 'node', NODE_TABLE_DDL_OPEN, NODE_COLUMNS, { skipDrop: false })` immediately followed by
  `rebuildTable(adapter, 'edge', EDGE_TABLE_DDL_OPEN, EDGE_COLUMNS, { skipDrop: false })` (each call's own
  default `skipDrop: false` drops its `_old` table before the other rebuild has even started — the exact
  naive-sequential shape BL-313's incident had). Assert `SELECT COUNT(*) FROM edge` is `0` immediately
  after. Run this once, watch it report `0`, and record the observed output in the implementation
  report (per BL-225 — "watch the test fail without the fix"). This is the literal repro this packet
  exists to make impossible to ship silently.
- **GREEN:** the §3 step 7.2-7.4 sequencing (`skipDrop: true` for both, both rebuilds' rename→create→copy
  run before either `DROP TABLE ..._old`). Assert `edgeCount === 90`, `nodeCount === 10`, and the
  per-relation breakdown is `{ RELATES_TO: 90 }`.

**Why this is a `rebuildTable`-level test, not a `migrateToOpenSchema()`-level test:** BL-442's own
acceptance text says the RED observation is "0 edges survive" — a symptom visible on the *raw store*.
`migrateToOpenSchema()`'s own Layer-1 in-transaction check (§3 step 7.6) is specifically designed to
catch and roll back exactly this failure before it could ever be observed by a caller of that function
— so testing the naive-sequential RED arm *through* `migrateToOpenSchema()` would only prove Layer 1
works (a good property, covered separately in AC-2's note below) and would never reproduce "0 edges
survive" as an outcome. Testing `rebuildTable()`'s sequencing directly, exactly as
`graph-store.spec.ts:533-546` already does for the pre-existing legacy-upgrade rebuild, is the faithful
reproduction BL-442 asks for.

### AC-2 — BL-442 end-to-end: `migrateToOpenSchema()` succeeds against the same 90-edge fixture

Same fixture as AC-1. Call `migrateToOpenSchema(dbPath)` (real file — `:memory:` cannot be used, since
the function must `fs.existsSync`/backup/restore against a real path; use `mkdtempSync` per the
established pattern in `ensure-check-constraints.bl447.spec.ts:29-31`). Assert:

- Resolves with `status: 'migrated'`; `before` and `after` snapshots are deep-equal to each other and to
  `{ nodeCount: 10, edgeCount: 90, perRelation: { RELATES_TO: 90 }, ...checksums }`.
- Post-migration, a raw `INSERT INTO node (uid, kind, ...) VALUES (..., 'a-brand-new-consumer-kind',
  ...)` and `INSERT INTO edge (..., rel) VALUES (..., 'A_BRAND_NEW_REL')` both succeed (positive proof
  the CHECK is actually gone at the SQLite engine level, not just that the DDL text changed — mirrors
  `ensure-check-constraints.bl447.spec.ts:391-412`'s pattern).
- `sqlite_master.sql` for `node`/`edge` no longer contains `CHECK (kind IN (` / `CHECK (rel IN (`.
- `foreign_keys` pragma reads `1` throughout (assert it after migration, on a fresh open).
- **RED:** before `open-schema-migration.ts` exists (or before it is wired to the correct DDL
  constants), this test does not compile / the import fails — standard TDD RED, write this test file
  before the implementation file exists and watch it fail to run at all, then implement.
- **Bonus property, worth asserting but not a separate BL-id:** re-run AC-2's fixture-seeding with
  §3 step 7.2/7.3 temporarily reverted to `skipDrop: false` (the same mutation as AC-1's RED arm,
  applied inside `open-schema-migration.ts` itself this time) and confirm `migrateToOpenSchema()`
  **throws `MigrationVerificationError`**, and that a subsequent fresh read of `dbPath` still shows
  `edgeCount === 90` (Layer 1 protected the file even though the naive sequencing ran). Revert the
  mutation immediately after recording this observation — it is not the shipped code path, it is proof
  that AC-1's RED arm cannot reach an operator's real data through this function.

### AC-3 — BL-442 rollback: forced post-commit mismatch triggers a real, verified restore

Same fixture. Call `migrateToOpenSchema(dbPath, { __test_forcePostCommitMismatch: true })`. Assert:

- It rejects with `MigrationRolledBackError`.
- Before asserting anything else, capture `dbPath`'s file bytes are different from what they were
  pre-call is *not* the assertion (VACUUM'd files are not byte-identical to their WAL-mode source by
  construction) — instead, open a fresh adapter on `dbPath` post-call and assert its `StoreSnapshot`
  (nodeCount/edgeCount/perRelation/checksums) is deep-equal to the snapshot captured from `backupPath`
  independently, immediately after the call, via a second fresh read — i.e. prove the two files now
  agree, not just that no exception was thrown.
- `dbPath`'s CHECK-constraint state after restore matches the CHECK state that was live when the backup
  was taken (this migration's whole point is CHECK removal — since the rollback fires on a *forced* test
  hook rather than because the rebuild "actually" corrupted anything, this incidentally proves restore
  reverts the migration's own DDL change too, not just row counts).
- **RED, run and observed:** write this test before `MigrateOpenSchemaOptions.__test_forcePostCommitMismatch`
  and the restore branch in §3 step 8 exist. Watch it fail two ways in sequence as you build: first,
  with the hook present but no restore branch wired, the function either resolves successfully (hook has
  no effect — visible bug) or throws without touching the file (assertion "post-call snapshot matches
  backup" trivially passes for the wrong reason — the store was never mutated, since AC-3 uses the *same*
  successful-migration fixture as AC-2, so "matches backup" is only meaningful once you also assert the
  restored store's CHECK state, which without a real restore would just be the *migrated* state, not the
  pre-migration state — assert specifically that the restored `sqlite_master.sql` for `node` **does**
  contain `CHECK (kind IN (` again, proving a real file-level reversion happened, not a no-op). Record
  this observation, then wire the real restore branch and watch it pass for the right reason.

### AC-4 — BL-442 static unreachability from `applySchema()`

New standalone test (co-locate in the same spec file, its own top-level `describe`):

- Read `libs/data/graph/graph-store/src/index.ts` via `node:fs.readFileSync` (raw source text, not the
  transpiled/imported module — this must inspect what a human reviewing the file would see). Assert the
  text does not contain the substrings `'open-schema-migration'` or `'migrateToOpenSchema'`.
- **RED, run and observed:** temporarily add a single line inside `applySchema()`'s body (e.g.
  `// migrateToOpenSchema` as a comment is enough to trip a substring search deliberately, or better,
  temporarily add a real (even if type-broken) call) — run the test, watch it fail, remove the line, run
  it again, watch it pass. Record both observations. This is the literal red→green BL-225 requires,
  applied to a static-text assertion rather than a runtime one — the assertion itself doesn't change
  between the two runs, only the file it reads does.

### AC-5 — BL-442 refuses when the store is open elsewhere

Open a second, independent `SqliteAdapterImpl` on the same `dbPath` and hold an uncommitted `BEGIN
IMMEDIATE` transaction on it (a real second connection, real lock — not a mock). Call
`migrateToOpenSchema(dbPath)` concurrently. Assert:

- It rejects with `StoreOpenElsewhereError`, and does so quickly (assert wall-clock duration is well
  under the default retry/backoff window that `maxRetries: 3` would have produced — e.g. under 200ms —
  proving `maxRetries: 0` is actually wired, not merely documented).
- `sqlite_master.sql` for `node`/`edge` still contains the closed CHECK afterward — zero mutation was
  attempted.
- Release the second connection's transaction; confirm a subsequent `migrateToOpenSchema(dbPath)` call
  (no other change) now succeeds — proves the refusal is about contention, not a permanent, mis-fired
  condition.
- **RED, run and observed:** write this test against a version of §3 step 4 that uses
  `{ mode: 'exclusive' }` **without** `maxRetries: 0` (the adapter's default `maxRetries: 3` applies).
  Run it and observe the call does *not* reject within the tight time bound (it either eventually
  succeeds once the exponential backoff outlasts the held lock, or takes materially longer than 200ms) —
  record the actual observed duration/outcome. Restore `maxRetries: 0` and observe both assertions pass.

### AC-6 — BL-442 refuses on a Turso-formatted store

Two tests:

1. **Unit-level, always runs (no external Turso dependency):** stub/monkeypatch the point where
   `open-schema-migration.ts` constructs its adapter (inject a factory function it calls instead of
   importing `createSqliteAdapter` directly at module scope, or — simpler, if this seams awkwardly —
   test the catch-and-convert logic as a small pure helper: `function toRefusal(err: unknown):
   UnsupportedBackendError | null` that the main function calls, tested directly by passing a real
   `ETursoNativeStore` instance and asserting the returned error's message names BL-337 and BL-361 and
   does not leak the raw `__turso_internal_...` object name (mirroring the concern already documented at
   `sqlite-turso-native-store.bl329.test.ts:22-25`)). Implementer's choice which shape; either is
   acceptable, but the conversion logic must be independently testable without a live Turso engine.
2. **Integration-level, guarded like the existing precedent:** reuse the `hasTurso`/`tursoDescribe`
   pattern and `seedTursoNativeStore()` helper verbatim from
   `libs/data/store/store-adapter/src/__tests__/sqlite-turso-native-store.bl329.test.ts:36-45,71-78`
   (skips cleanly in any environment without `@tursodatabase/database` installed — do not make this
   test hard-fail in that environment). Seed a genuine Turso-native store, call `migrateToOpenSchema()`
   against it, assert it rejects with `UnsupportedBackendError` and that the file is untouched (its
   `sqlite_master` still contains the Turso FTS index row — read via the `writable_schema` technique or,
   simpler, via `TursoAdapterImpl.connect()` again post-call and confirm it still opens/reads the same
   content).
- **RED:** before §3 step 2's `try`/`catch(ETursoNativeStore)` conversion exists, `migrateToOpenSchema()`
  either throws the raw, unconverted `ETursoNativeStore` (message contains the opaque
  `__turso_internal_...` text — assert this is what's observed pre-fix) or, if the catch is missing
  entirely and something upstream swallows it, some other uncontrolled failure. Implement against
  whichever is actually observed; either way, the GREEN assertion (typed `UnsupportedBackendError`,
  clean message) is what must hold after.

---

## 6. Risks

- **R-1 (data loss) — the whole reason this packet exists.** Mitigated by the two-layer verify/rollback
  in §3 (Layer 1: in-transaction, SQL-native rollback; Layer 2: post-commit, file-level restore from a
  verified backup) plus reusing, unmodified, the one sequencing (`skipDrop`-both-before-either-drop)
  already proven safe against the live store (`CHANGELOG.md:2880-2885` — the BL-313 fix was deployed
  and verified against production). The TOCTOU window between the backup (step 5) and the migration
  transaction (step 7) is real but bounded and self-detecting: step 7.1 re-compares against the backup
  baseline before doing anything destructive and refuses if they disagree. This window is accepted
  because "offline" is this packet's own hard precondition (ADR-0010 D3) — there is no code path that
  makes this migration reachable from a live, writing process, so the only actor who could open a
  second connection between steps 5 and 7 is the operator running a second command by hand, which is a
  process discipline problem, not a code problem this packet can solve.
- **R-2 (destructive `nx build`, BL-235).** `npx nx build graph-store` deletes `dist/` before knowing the
  rebuild succeeds, and `graph-store` is depended on by `memory-core` → `memory-server`/`memory-cli`/
  `memory-flush`. **Sequencing: never build speculatively.** Run `npx nx test graph-store -- <new spec
  file>` (scoped) repeatedly while iterating; run the full `npx nx test graph-store` and
  `npx nx typecheck graph-store` and `npx nx lint graph-store` before ever running `npx nx build
  graph-store`, and only run the build once, at the very end, after every test in §5 is green. Do not
  run `npx nx build graph-store` merely to see a compile error — read the source instead (per the
  project-wide BL-235 rule).
- **R-3 (never touch `~/.memory/*`).** This is a constraint on *this packet's own development and
  testing process* — every fixture in §5 uses `mkdtempSync(tmpdir())`, never a real or copied path under
  `~/.memory/`. It is deliberately **not** a hardcoded path-blocklist inside `migrateToOpenSchema()`
  itself: baking `~/.memory` into the shipped function would be exactly backwards, since running this
  migration against that store (eventually, by explicit separate operator action, off a verified backup,
  outside this packet's scope) is the entire point ADR-0010 D3 exists to eventually enable. Do not add
  such a guard; do not run this packet's tests against a copy of the real store either — the 90-edge/
  10-node synthetic fixture (already proven sufficient by BL-313's own regression test) is what §5
  requires.
- **R-4 (Turso PANIC, BL-361).** Mitigated entirely by D-3's outright refusal — this packet's own test
  suite must never cause a `preflightSchemaSanity`-class PANIC, because it never calls anything that
  would probe `fts_match` against a Turso store; `ETursoNativeStore` detection happens on a plain
  `sqlite_master` read, which BL-361's own documentation (`preflight.ts:19-28`) confirms does **not**
  trigger the panic (only `fts_match` does).
- **R-5 (shared checkout / concurrent agents).** This worktree
  (`/Users/nix/dev/ai/sox-ecosystem/.worktrees/pkt61-operator-migration`, branch
  `feat/pkt61-operator-migration`) is isolated from the main checkout and other worktrees. Commit
  incrementally, by explicit pathspec, per file — never `git add -A`/`git add .`/bare `git commit`.

---

## 7. The gate — exact nx targets, in order

1. While iterating: `npx nx test graph-store -- open-schema-migration.bl442.spec.ts` (scoped; repeat
   freely — cheap, cached, non-destructive).
2. Before considering any criterion in §5 "done": `npx nx test graph-store` (full suite — must show
   `67 + <n new tests> passed`, i.e. the pre-existing 67 tests observed at worktree setup must still
   all pass; zero regressions).
3. `npx nx typecheck graph-store` — must be green. Do not weaken `strict` or any compiler flag to make
   this pass.
4. `npx nx lint graph-store` — must be green.
5. `node tools/check-suite-tree-state.mjs --project graph-store` — run and quote alongside the step-2
   result; report the tree state that produced it (BL-456 — a green suite is only evidence when the
   dependency-tree state it ran against is stated with it).
6. Only after 2-5 are all green: `npx nx build graph-store` (destructive — see R-2 — run exactly once,
   last).
7. `node tools/graph-store-migrate-open-schema.mjs --db <a throwaway populated fixture copy under
   /tmp or the scratchpad, never ~/.memory> --confirm` — one live, end-to-end run of the actual shipped
   CLI script against the built `dist/`, not just the vitest suite, per this repo's live-verification
   standard (`CONTRIBUTING.md` §1/§2 — read it before reporting complete). Build the fixture with the
   same 90-edge/10-node shape as §5, via a small throwaway script or by adapting AC-2's fixture-seeding
   into a standalone `.mjs`; do not point this at any real store.
8. Do **not** run `npx nx run-many -t build,lint,test,typecheck` (whole-repo) for this packet — scope
   the gate to `graph-store` per §7.1-7.6 plus the live CLI run in §7.7. `graph-store`'s consumers
   (`memory-core`, `memory-server`, etc.) are unaffected by this packet's changes (additive exports +
   two new files only) and PKT-62/PKT-63 own proving the published-tarball/consumer-facing contract —
   do not duplicate or pre-empt their scope here.
9. Commit by explicit pathspec, incrementally, per BL-225/BL-409 house rules — never `git add -A`.

Do not pass `--skip-nx-cache` to any of the above (owner instruction, standing).
