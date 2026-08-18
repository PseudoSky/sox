# BUG-014 Store-Adapter Hardening — Full Task Specifications

> Source of truth for the BUG-014 remediation program. This document is the foolproof work order
> each executor follows. Root-cause record: BUG-014 (+ corrected-triage notes). Deterministic
> repro: `/tmp/bug014-lab` exp1–exp10 (exp9 = poison, exp10 = readonly-safe control), reproducible
> from the transcripts in this doc's §Appendix.
>
> ⚠️ **PLAN-LOCAL IDS — NOT GRAPH ITEMS (DEBT-006).** The task headings below (`T1 — BUG-017`,
> `T3 — BUG-021`, `T4 — BUG-018`, `T5 — BUG-019`, `T6 — BUG-020`, `T8`–`T11`'s `DEBT-*` labels)
> are **this plan's own internal numbering**, not backlog graph ids, *except where a task's number
> happens to already be a real graph item* (e.g. `BUG-017`, `BUG-014`, `DEBT-003` below genuinely
> exist in the graph and refer to the same work — verified 2026-08-18). `BUG-018`..`BUG-042` and
> `DEBT-006`..`DEBT-032` are **not** allocated in the graph's numeric families (`BUG` stops at
> `BUG-017`, `DEBT` at `DEBT-005`) — citing one of those numbers as if it were a graph id is a
> defect (`DEBT-006`, filed 2026-08-18: 514 refs to 48 ids across 139 files resolved to nothing).
> `HANDOFF-20260814.md` §C carries the authoritative former→graph-id map for the tasks that were
> refiled under descriptive slugs after the 2026-08-14 data-loss incident (`BUG-018`→
> `BUG-STOREADAPTER-DBPATH-NOT-CANONICALIZED-001`, etc.) — consult it, and
> `tools/backlog-citation-allowlist.json`, before assuming any `BUG-0NN`/`DEBT-0NN` string in this
> file resolves as written. Do not allocate new plan-local numbers in this family going forward;
> use a `T<n>` task reference or the item's real graph id once filed.
>
> **Global rules for every task**: no `git stash`/`reset --hard`; commit by pathspec only; build/test
> via nx targets only; a suite result is quotable only with `node tools/check-suite-tree-state.mjs
> --project <p>` output; no BL/BUG item goes RESOLVED without a red→green test **naming the item id**
> (BL-225); never open the live store (`/Users/nix/.adhd/backlog/production/data/backlog.db`)
> writable with any classic engine — that is the bug.

## Invariants this program establishes (the "definition of safe")

- **INV-1 (engine exclusivity)**: while any live turso multiprocess peer holds a store, no classic
  (better-sqlite3 / stock sqlite) WRITABLE open of that store may occur, from any process.
- **INV-2 (one-shot liveness)**: a fresh one-shot open must never fail because a server holds the
  store (BUG-014 owner directive).
- **INV-3 (derived-state reconcile)**: a content-provably-dead `-tshm` may be reconciled at any
  time, live peers or not (Probe D + exp8 class); a content-live `-tshm` may never be renamed.
- **INV-4 (identity)**: all cross-process coordination (leases, quiescence, markers, sidecars) keys
  off ONE canonical path per physical store.
- **INV-5 (no silent destruction)**: every declined or performed destructive/repair action logs
  loudly with a typed reason.

---

## T1 — BUG-017 (CRITICAL): quiescence-gate the writable classic-engine escape hatch

**Objective**: writable better-sqlite3 opens (the proven poisoner, exp9) become impossible while
live turso peers hold the store — INV-1 enforced at the only writable classic call path.

**Preconditions**: none (first task; land before DEBT-003's heal so the heal cannot be re-poisoned).

**Changes**
1. `libs/data/store/store-adapter/src/preflight.ts`
   - `deleteSchemaRowsViaBetterSqlite3(dbPath, names)` (≈328–349): add required options arg
     `{ ownLeaseToken?: string }`. Before `openSchemaReader(dbPath, false)` call
     `storeQuiescence(dbPath, ownLeaseToken)`; if `!quiescent`, return
     `{ dropped: [], failed: 'declined: <n> live peer(s) hold the store (INV-1); repair deferred' }`
     and `log.warn('store_adapter.preflight.schema_repair_declined_live_peers', {...})`. Never
     silently skip (INV-5).
2. `libs/data/store/store-adapter/src/turso-adapter.ts`
   - Call site A (≈545–554): pass the connect-scope lease token into
     `preflightSchemaSanity(dbPath, { repair: true, ownLeaseToken: lease?.token })` and thread it
     through to the delete. NOTE the ordering trap: preflight currently runs BEFORE
     `acquireStoreLease` — move the lease acquisition above the preflight block (it is already
     above at ≈400; verify and use that token).
   - `withConnectionClosedForRepair` (≈1462–1498): after closing the own connection and BEFORE
     invoking `fn()`, check `storeQuiescence(dbPath, this._lease?.token)`; if not quiescent, throw
     a typed `RepairDeclinedLivePeersError` (new, in `errors.ts`) carrying peer count + pids. The
     caller decides (graph-store logs and skips the drop; the rebuild proceeds without it — the
     pre-BL-506 degradation, which is safe).
3. `libs/data/graph/graph-store/src/index.ts`
   - `dropFts5ResidueBeforeRebuild` (≈1268–1336): catch `RepairDeclinedLivePeersError`, log
     `graph_store.heal.fts5_residue_drop_deferred_live_peers`, and return without dropping
     (never proceed to a raw fallback bsql3 open — delete the "foreign adapter" fallback branch's
     unguarded path or gate it identically).
   - Also close **BL-563** here: early-return before the drop when `cfg.readonly === true`
     (mirror preflight's `opts.readonly !== true` gate).

**Tests (red→green, must name BUG-017 / BL-563)**
- `src/__tests__/cross-engine-quiescence-gate.bug017.spec.ts` (store-adapter): spawn a REAL child
  process (fixture like `__tests__/fixtures/bl461-open-child.ts`) holding a turso multiprocess
  connection on a temp store seeded with deletable schema rows; call
  `deleteSchemaRowsViaBetterSqlite3` → expect `failed: 'declined…'`, WAL byte-identical
  before/after; kill the child, release its lease → expect the delete to proceed. RED first: run
  against the ungated code and assert the WAL was destroyed (the exp9 assertion), then flip.
- graph-store: `dropFts5ResidueBeforeRebuild` under a live peer defers, rebuild still completes;
  `readonly:true` never drops (BL-563).

**Acceptance**: both tests red on pre-fix code, green after; `rg -n "openSchemaReader\(.*false"`
shows every reachable path behind a quiescence check; nx lint/typecheck/test green for
`store-adapter` + `graph-store` with tree-state quoted.

**Rollback**: revert the two commits; no data-shape changes.

---

## T2 — DEBT-003: heal — content-dead `-tshm` reconcile before the non-quiescent retry

**Objective**: a poisoned store self-heals on the next fresh open even under live peers (INV-2,
INV-3), replacing the guaranteed-failure retry loop.

**Preconditions**: T1 merged (heal without cure re-poisons). Reconcile the in-flight uncommitted
diff (+311/−23, `isTshmContentDead` integrity.ts:629–672 + turso-adapter.ts:642–721) — adopt it as
the starting point, do not rewrite it blind.

**Changes** (`turso-adapter.ts` non-quiescent catch, ≈631–668)
1. Before entering the retry loop, probe: `wal = statSync(dbPath + '-wal').size` (0 or ENOENT ⇒
   dead), else `probeWalFrames(dbPath + '-wal')` first-indexed-offset vs WAL EOF. Use/extend
   `isTshmContentDead` from the in-flight diff.
2. If content-dead: rename the `-tshm` aside (`recoverStaleWalIndex` with a new
   `{ allowUnderLivePeers: true, requireContentDead: true }` mode — content-deadness is the gate,
   not quiescence), `emitIntegrityReport('repaired', ...)`, then `openOnce()` once. Only if that
   still fails, fall through to the bounded retry.
3. If content-live: keep the existing bounded retry (genuine close()-TRUNCATE transient race).
4. Fix the log defect: retry-attempt log must serialize the LATEST error (`lastError`), not `err`
   (≈645–650). On exhaustion, set `retryable` only for the content-live branch — a content-dead
   failure after reconcile is NOT transient; surface the typed operator error instead.

**Tests** (`wal-contention-8way.bug007-009.test.ts` sibling, naming DEBT-003 + BUG-014)
- Two-process: peer child holds the store; parent fabricates the poisoned state on a TEMP store
  (zero the WAL out-of-band while tshm indexes frames — exp8 recipe); fresh adapter open must
  succeed via reconcile, AND the peer child must still answer queries afterward (the Probe D
  property). RED: current code exhausts 3 retries and throws.
- Content-live control: transient short-read (sibling TRUNCATE race) still takes the retry path,
  never renames the tshm.

**Acceptance**: red→green shown; INV-2 demo: with a live peer process attached, 5/5 fresh opens
succeed on a previously poisoned temp store.

---

## T3 — BUG-021: content-deadness at ALL THREE reconcile decision sites

**Objective**: eliminate mtime-heuristic false positives (tshm mtime freezes at creation —
integrity.ts:603–605) that caused the 08:28–08:46 rename churn.

**Preconditions**: T2 (shares `isTshmContentDead`).

**Changes** (`integrity.ts`)
- `proactivelyReconcileStaleSidecar`: replace the mtime staleness trigger with
  `isTshmContentDead`; mtime becomes a log-only hint.
- `recoverStaleWalIndex` quiescent path: same swap; the decline text carries the frame probe.
- `warnIfStaleSidecar`: keep as informational, reword so "stale" claims only mtime-skew observed.

**Tests** (naming BUG-021): healthy multiprocess temp store, live peer, tshm untouched >60 s
mtime-wise → fresh open performs NO rename (RED on current code: rename happens); content-dead
store quiescent → rename still happens.

**Acceptance**: `rg -n "mtime" integrity.ts` shows no rename decision keyed on mtime.

---

## T4 — BUG-018: canonical path identity (INV-4)

**Objective**: one physical store ⇒ one lease dir / marker / quiescence view, regardless of path
spelling.

**Changes**
- New `canonicalDbPath(dbPath)` in `store-lease.ts` (or a tiny `path-identity.ts`):
  `realpathSync(dirname)` + `basename`, tolerating a not-yet-created db file (parent must exist);
  memoized per call site.
- Apply at the SINGLE entry: `TursoAdapter.connect` canonicalizes `opts.dbPath` once and uses the
  canonical value for `acquireStoreLease`, `storeQuiescence`, `hasStoreOpenMarker`/`markStoreOpen`/
  `clearStoreOpenMarker`, sidecar probes, and passes it to preflight/graph-store repair options.
  `SqliteAdapterImpl` gets the same treatment at its open.

**Tests** (naming BUG-018): create store via real path; open adapter B via a symlinked directory
alias → `storeQuiescence` from B sees A's lease (RED currently: it does not); marker written via
alias is visible via real path.

**Acceptance**: `rg -n "acquireStoreLease|storeQuiescence|StoreOpenMarker" src/` shows only
canonicalized values flowing in.

---

## T5 — BUG-019: refcounted per-connection open marker

**Objective**: "unclean shutdown happened" becomes derivable with N concurrent processes; the
preflight trigger surface stops being wrong in both directions.

**Changes**
- Move the marker into the lease dir: `markStoreOpen` writes `<leaseDir>/<token>.openmark`
  (pid + ISO time), `clearStoreOpenMarker(token)` unlinks only its own. `hasUncleanShutdown` (new
  name; keep `hasStoreOpenMarker` as deprecated alias) = any `.openmark` whose pid is dead
  (reuse `storeQuiescence`'s liveness logic + 24 h age-out). Dead markers are swept after the
  preflight consumes them.
- Migration shim: if a legacy `${dbPath}-openmark` file exists, treat as unclean once, delete it.

**Tests** (naming BUG-019): two adapters open; A closes cleanly → B's marker survives; kill -9 a
child holding a marker → next open reports unclean and runs preflight exactly once; legacy marker
honored once.

**Preconditions**: T4 (marker path keys off canonical identity).

---

## T6 — BUG-020 close-out: un-flagged opener audit + post-ship watch

**Objective**: close the last attribution thread and prove the fleet is poison-free after ship.

**Steps**
1. Audit every deployed dist that opens a turso db: `rg -l "@tursodatabase/database"` across
   sox-ecosystem dists, `~/dev/node/adhd` dists, and the pnpm-global `@adhd/backlog` install; for
   each hit confirm `experimental` includes `multiprocess_wal` at the `connect()` call. File a BUG
   per violator (the 03:07 burst signature: "already open without experimental multiprocess WAL").
2. Post-ship observation window (48 h): armed monitor
   `fs_usage -w -f filesys | grep backlog.db` (or tight lsof poll) + daily
   `rg "connection.poisoned|short read" ~/.adhd/sox-ecosystem/backlog/logs/backlog.cli-*.jsonl`.
   Zero occurrences ⇒ resolve BUG-020 citing the window; any occurrence ⇒ captured argv/env goes
   into a new item.

**Acceptance**: audit table (dist → flag present y/n) attached as a citation; observation result
cited on resolution.

---

## T7 — Ship 0.5.8 + fleet runbook (closes BUG-014 itself)

**Preconditions**: T1–T5 merged; T6 audit done (step 1).

**Steps (exact order)**
1. Reconcile & commit the in-flight diff merged with T1–T3 (pathspec commits per file group;
   never sweep others' staged work — `tools/commit-mine.mjs` if contended).
2. `npx nx run-many -t lint,typecheck,build,test -p store-adapter graph-store` + quote
   `check-suite-tree-state.mjs` for both.
3. `npx nx run registry:sync-index`; commit regenerated `registry/index.json` with sources.
4. `rm -rf dist/smoke && node scripts/smoke-test.mjs` → `summary.failed === 0` (mandatory gate).
5. Publish `@adhd/sox-store-adapter@0.5.8` + `@adhd/sox-graph-store` bump; then in
   `~/dev/node/adhd`: bump, `pnpm install`, commit lockfile, republish `@adhd/backlog@0.1.6`,
   `pnpm -g` upgrade the global install.
6. **Fleet restart (the step everyone forgets)**: enumerate holders
   (`lsof /Users/nix/.adhd/backlog/production/data/backlog.db`), restart each MCP server session's
   backlog server (they hold pre-fix code in-memory). One-time heal of the live store per T2's
   logic if it is poisoned at that moment.
7. Live acceptance (INV-2): 5/5 fresh one-shot `backlog list-items` (readonly CLI invocations —
   safe) succeed while ≥2 servers hold the store. Resolve BUG-014/BUG-017/DEBT-003/BUG-021 with
   commit shas + test names; transition in the graph only (no markdown edits).

---

## T8 — NEW (DEBT): single choke point for ALL classic-engine access + lint ban

**Objective**: make INV-1 structural, not per-call-site — the next migration (memory-server)
cannot reintroduce the hazard.

**Changes**
- New `libs/data/store/store-adapter/src/classic-engine-access.ts`: the ONLY module allowed to
  `require('better-sqlite3')` for store files. Surface:
  `withClassicEngine(dbPath, {writable, ownLeaseToken, reason}, fn)` — readonly passes through;
  writable enforces quiescence (T1 logic lives HERE, T1's call sites refactor onto it), always
  logs `{reason, writable, peers}` (INV-5).
- Migrate existing classic opens onto it: `preflight.ts` (openSchemaReader), `engine-guard.ts`
  readonly probes (≈180, 268, 460), `fts-ops.ts` cleanup, **memory-core `db.ts` repair opens
  (≈202–278)**, graph-store fallback path.
- Enforcement: eslint `no-restricted-imports`/`no-restricted-syntax` rule (extend
  `tools/eslint-local/`) banning `better-sqlite3` imports outside `classic-engine-access.ts`,
  `sqlite-adapter.ts`, and vector/graph packages' own legitimate primary-engine usage — explicit
  allowlist in the rule, violation fails `nx lint`.

**Tests**: unit — writable+peers declines, readonly always passes; lint fixture proving the rule
fires. Acceptance: `rg -n "require\('better-sqlite3'\)" libs/` matches only the allowlist.

---

## T9 — NEW (DEBT): reusable two-process WAL-contention conformance suite

**Objective**: the exp1–exp10 lab becomes a permanent, parameterized test harness any consumer
(backlog store today, memory store next) runs pre-migration and in CI.

**Changes**: `libs/data/store/store-adapter/src/__tests__/harness/wal-conformance.ts` exporting
`runWalConformance({dbFactory, scenarios})` with scenarios ported from the lab: quiescent
truncate+close reopen (exp2/3), live-peer turso truncation (exp4), readonly classic scan
(exp10, must stay harmless), writable classic open+close under peer (exp9, must be DECLINED
post-T1/T8), out-of-band WAL zero + reconcile heal (exp8/T2), N-process open/write/close churn
(raw-driver control). Each scenario spawns REAL child processes. Wire as
`store-adapter` spec + document one-command invocation for other packages.

**Acceptance**: suite green on store-adapter; README section in the package documenting how a
consumer points it at its own store config.

---

## T10 — NEW (DEBT): migration playbook + `migrateOnAdapterChange` hardening

**Objective**: sqlite → store-adapter/turso migrations become a checklist, not archaeology.

**Changes**
1. `docs/standards/turso-migration.md` — the playbook: preconditions (engine marker stamped;
   consumers inventoried via lsof/lease dir; T8 choke point adopted; T9 suite passing against the
   consumer's schema), the fleet procedure (announce → drain/stop ALL holders → `createStoreAdapter
   {migrateOnAdapterChange:true}` → verify row counts via migration report → restart fleet on new
   engine → observation window), rollback (the pre-migration file is renamed, not deleted — cite
   `migration.ts` temp-swap mechanics after verifying them), and the standing invariants INV-1..5.
2. `factory.ts` hardening (≈41–89): `migrateOnAdapterChange` must REFUSE to run unless
   `storeQuiescence(dbPath)` is empty (it opens BOTH engines in one process — safe only quiescent);
   typed error naming the live pids. Migration writes a `migration-report.json` beside the db
   (tables, row counts src/dst, duration) — the playbook's verification artifact.

**Tests**: factory refusal under a live peer child (naming the item id); report file emitted with
matching counts on a 2-table fixture.

---

## T11 — NEW (DEBT): memory-server migration readiness

**Objective**: memory stack (`~/.memory/memory.db`, launchd `com.sox.user.memory-server`) can
migrate to turso multiprocess without replaying BUG-014.

**Steps**
1. Discovery: inventory every opener of `~/.memory/memory.db` (memory-server, memory-cli,
   memory-flush, reaper-class tools) and every classic-engine touch in memory-core
   (`db.ts:202–278` vec0/FTS5 repair opens — must move onto T8's choke point BEFORE migration).
2. Precondition checklist per T10 playbook; run T9 conformance against a copy of the real
   memory.db schema.
3. The migration itself is a separate, later plan — this item is DONE when the checklist document
   for memory-server exists with every box verifiable by a command, and the memory-core classic
   opens are behind the choke point.

**Sequencing note**: T8 → T11 are the "make future migrations easy" spine the owner asked for;
none of them block T1–T7 shipping.

---

## Dependency order

```
T1 (cure) ──► T2 (heal) ──► T3 (content-deadness everywhere)
T4 (identity) ──► T5 (marker)          [parallel with T2/T3 after T1]
T6.1 (audit)  [parallel any time]
T1..T5 + T6.1 ──► T7 (ship 0.5.8 + fleet restart + live acceptance) ──► T6.2 (watch) ──► resolve BUG-014/020
T1 ──► T8 (choke point refactor) ──► T9 (conformance suite) ──► T10 (playbook+factory) ──► T11 (memory readiness)
```

## Appendix — lab repro recipes (for test authors)

- **Poison (exp9)**: peer child: turso connect `{timeout:5000, experimental:['index_method','multiprocess_wal']}`,
  write ~400 rows, idle holding. Then `new Database(dbPath)` (better-sqlite3, writable),
  one `SELECT`, `close()` — WAL is checkpoint-deleted. Peer writes 50 more rows ("succeeds").
  Fresh turso open now fails `short read on WAL frame … got 0`. WAL on disk: 0 bytes; tshm: 86016.
- **Safe control (exp10)**: same peer; `new Database(dbPath, {readonly:true})` + scan + close —
  WAL intact, fresh opens fine, `-shm` created (benign).
- **Heal fixture (exp8)**: live peer with populated WAL; `: > store-wal` out-of-band; fresh opens
  see empty/failed store until tshm reconciled.
