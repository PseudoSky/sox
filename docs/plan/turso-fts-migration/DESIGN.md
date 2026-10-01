# DESIGN — Turso FTS 0.7.x → 0.8.x: migration, reclamation, gate, rollback

> Status: **design spec, not authorized to execute.** The pin bump is the owner's
> decision and has **not** been made (see `STATE.md`). Every `file:line` below is
> anchored to a line this author read; anchors read only by a dispatched agent are
> marked `(agent-read)`; anything not confirmed is marked `(UNVERIFIED)`.
> ADR constraints are binding — a step that violates one is rejected in §9.

## 0. TL;DR for the executor

Bumping `@tursodatabase/database` from `^0.7.1` to `0.8.x` **is a data migration, not
a version edit.** 0.8.0 (substantive release; 0.8.1 is plumbing-only) replaced the FTS
on-disk format: v1 stored a whole-index Tantivy manifest (`meta.json`, `.term`, …) in a
`(path TEXT, chunk_no INTEGER, bytes BLOB)` B-tree; v2 stores per-segment
descriptor/chunk/tombstone rows keyed `fts2/control`, `fts2/seg/<uuid>`,
`fts2/chunk/<uuid>/<ord>`, `fts2/tomb/<identity>` (upstream PR **#8517**, merged
2026-08-31; present in `v0.8.0`). 0.8.x **opens** a 0.7-written store and leaves the
catalog, base tables, and `PRAGMA integrity_check` intact, but the **first read or write
of an FTS index fails** with an explicit, actionable error:

> `FTS index <name> was created by an older version of Turso and its storage format is
> no longer supported; rebuild it with DROP INDEX <name> followed by CREATE INDEX ...
> USING fts`

There is **no auto-migrate by design** (`format.rs:33`: "The code refuses older stores
with a rebuild hint and never converts them"). The prescribed migration is the upstream
one: **rebuild the index from the base table** (`DROP INDEX` then
`CREATE INDEX ... USING fts`). `DROP INDEX` always succeeds because the destroy path
never opens the store.

The migration is **narrow and in-place-safe**, but it is **offline** (the store must not
be served while un-migrated — writes to the FTS index error) and it **must reclaim the
pages 0.7.x already leaked**, not merely stop new leaks.

**Vehicle verdict (explicit, per the brief):** the existing `rebuildStoreOffline` engine
(`libs/data/store/store-adapter/src/store-rebuild.ts:721`) is **partially** the migration
vehicle — reuse its offline-exclusive gate, capture/verify, atomic swap, and hard-link
backup; but its **core assumption is wrong** for a format migration. The engine
deliberately "NEVER drops anything" (`store-rebuild.ts:5-18`) and reclaims via
`VACUUM INTO` of the store **as-is**. A `VACUUM INTO` of a v1 store is **unverified and
likely broken** (the v1 backing rows are copied raw; the FTS `create()` stages a fresh v2
control row beside them — `core/vdbe/vacuum.rs`, `fts/mod.rs:2803`; LOW confidence). The
migration therefore **adds a pre-step the current engine forbids** — per-index
`DROP INDEX` + `CREATE INDEX ... USING fts` — and runs the `VACUUM INTO` **after** the
index is already v2 (same-version 0.8→0.8), which sidesteps the cross-version VACUUM
hazard entirely.

## 1. What happens on first open under 0.8.x

Measured upstream (PR #8517 body + regression test
`fts_pre_registry_store_is_refused_until_rebuilt`, `tests/integration/index_method/mod.rs:5065-5179`,
fixture `fts_pre_registry_v0.8.0-pre.7.db`) — all HIGH confidence:

| statement | 0.8.x on a 0.7 store |
|---|---|
| open, `SELECT ... FROM sqlite_master` | OK |
| `PRAGMA integrity_check` | OK |
| base-table `SELECT * FROM node` | OK |
| unrelated `CREATE`/`INSERT` | OK |
| `UPDATE node ...` (touches FTS index) | **Runtime error** |
| `fts_match(...)` / `fts_score(...)` | **Runtime error** |

Consequences for this repo:

- The **memory service must not run against an un-migrated store.** `memory-server`'s
  recall path calls `fts_match`/`fts_score` (`libs/data/store/store-adapter/src/fts-ops.ts:303,316`
  via `buildFtsSearchSql:110-133`), and the write path updates the index on every node
  write. A live service on an un-migrated store is a hard outage, not a partial
  degradation.
- The migration is therefore an **offline, operator-invoked** step — consistent with
  ADR-0013 D4 (one-shot operator actions are explicit CLI/API invocations, never
  env-gated) and with the existing `memory fts-rebuild` precedent.

**Does it need an explicit FTS rebuild? Yes** — per FTS index, `DROP INDEX` +
`CREATE INDEX ... USING fts`. **Does it need a store copy first? Yes** — a byte-exact
pre-migration image (§4/§7). There is no in-place auto-migrate to rely on.

## 2. The migration sequence (settle point 1)

All steps offline-exclusive; refuse (never force) on any unmet precondition.

1. **Quiesce the writer.** `soxe service disable memory-server --host …` and await
   `[inv:unload-then-reap]`; the offline gate is the same one `fts-rebuild` uses:
   `TursoAdapterImpl.openOfflineExclusive` → peers via `storeQuiescence` and openers via
   `storeOpeners` (`libs/data/store/store-adapter/src/store-lease.ts`; `store-rebuild.ts:774`).
   Refuse if `storeOpeners` shows a live pid or `storeQuiescence` is false. Require the
   source `-wal` to be empty before any swap (`store-rebuild.ts` swap path).
2. **Pre-migration image — while still on 0.7.** Take a byte-exact copy
   `<db>.pre-migration-<ts>` via reflink (`COPYFILE_FICLONE`) — the same mechanism the
   engine uses for its pre-image `store-rebuild.ts:803-856` and for the restore clone
   `:1159`. This image is a **v1-format store restorable by 0.7.x** and is the *only*
   thing that makes rollback possible (§5). Record `readFileIdentity(canonical)`
   (`store-rebuild.ts:861`) so a concurrent mutation is detected later.
   *Also verify the image is restorable by 0.7 before proceeding* (the §6 spike).
3. **Deploy the 0.8.x driver** (the version bump is a separate, owner-authorized change —
   §8; not part of this spec's execution).
4. **Migrate (one offline-exclusive session, under 0.8):**
   a. Open the store with the 0.8 driver. The FTS index is v1 → reads/writes of it error;
      that is expected and is what step (b) removes.
   b. For **each** index whose `sqlite_master.sql` matches `/\bUSING\s+fts\b/i`
      (`isFtsIndex`, `integrity.ts`; `resolveExistingFtsIndexName`, `fts-dialect.ts:115`):
      `DROP INDEX <idx>;` then `CREATE INDEX <idx> ON <table> USING fts (<cols>);`
      (cols from `parseFtsColumns`, `integrity.ts`; DDL from `createIndexDDL`,
      `fts-dialect.ts:252`). The base table is untouched. `DROP INDEX` succeeds
      regardless of format because the destroy path never opens the store (HIGH).
   c. **`VACUUM INTO <db>.migrate-<ts>`** via `adapter.backupTo` (`store-rebuild.ts:865`)
      — now a **same-version (0.8→0.8)** VACUUM of a store whose index is already v2,
      which reclaims the orphaned v1 directory B-tree and the already-leaked pages
      (§3). This is the step that must **not** be run before (b).
   d. **Reset growth counters in the copy** (`fts_optimize_passes_since_rebuild=0`,
      `last_rebuild_at`) — `stampRebuildMeta` (`store-rebuild.ts:373`), which also does
      `PRAGMA wal_checkpoint(TRUNCATE)` and refuses if the copy still has a `-wal`.
   e. **Verify the copy** (the bytes verified are the bytes swapped) —
      `verifyReplacement` (`store-rebuild.ts:287`): base table row counts equal (mutable
      tables only need presence, `REBUILD_MUTABLE_TABLES`, `:285`), **every FTS sentinel
      token still returns its recorded hit count** (`captureFtsSentinels` `:226` /
      `countFtsHits` `:210`, which uses a bound `fts_match(cols, ?)` — works on v2),
      `PRAGMA integrity_check` classified via `classifyIntegrityMessages` (no *new*
      damage beyond the documented Tantivy false positive), and the counter reads 0.
   f. **Swap** (`swapIntoPlace`): cold-open lock, re-check peers/openers, require source
      `-wal` empty, move a stale `-tshm` aside, confirm source identity unchanged,
      hard-link the source to `<db>.pre-rebuild-<ts>`, `rename(2)` the migrated copy over
      `<db>` (`store-rebuild.ts:912`). The hard-link backup is an *additional* safety net
      on top of the §2.2 pre-migration image.
5. **Restart** the service and confirm `memory_ping` reports healthy; run a probe
   `fts_match` (the `memory` search surface) to prove the rebuilt index serves.

**What proves the migrated store is whole:** identical live `node`/`edge`/`vec_node`
counts pre/post, identical FTS sentinel hit counts (round-trip through `fts_match`),
`integrity_check` with no new damage, `page_count`/`file_bytes` strictly down, growth
counter 0, and a live `fts_match` on the restarted service. (This mirrors the measured
0.7.1→VACUUM result in `89849d2a`: 436.1 MB → 160.3 MB, identical counts, integrity_check
only the known false positive.)

## 3. Reclaiming already-leaked pages (settle point 2)

A 0.7.x store carries two classes of reclaimable bytes:

1. **Leaked orphan segments** — every in-service `OPTIMIZE INDEX` round left merged-away
   FTS segments as orphaned pages the freelist never reused (`store-rebuild.ts:5-18`;
   `89849d2a`: 7,273 orphan segments, 216.9 MB on a 436.1 MB store). These live in the
   **v1** FTS directory B-tree.
2. **The orphaned v1 directory B-tree itself** — `DROP INDEX` on an FTS index orphans its
   directory B-tree (page_count unchanged, 1 page freed) — this is exactly why the
   current engine "NEVER drops anything" (`store-rebuild.ts:5-18`).

The migration reclaims **both**, in this order:

- `DROP INDEX` (§2.4b) removes the v1 backing rows, orphaning the whole v1 directory
  B-tree (including the leaked segments — they are rows of that B-tree).
- The **same-version `VACUUM INTO`** (§2.4c) rewrites the file compactly and frees every
  orphaned page. Because the index was already rebuilt to v2 *before* the VACUUM, no v1
  row can survive into the copy (the hazard of §0 does not apply).

**How it is verified:** compare `readStorePageStats` (`store-rebuild.ts:168`: `file_bytes`,
`wal_bytes`, `page_count`, `page_size`, `freelist_count`) before vs after on a
production-store copy; require `file_bytes`/`page_count` to drop by at least the measured
leak mass (0.7.1 baseline: ~2.7× reduction) **and** every sentinel round-trip hit count
to be unchanged. The reclaim is a page-accounting claim and a content claim — both, never
one.

## 4. Verification gate + the `2bf0b7c8` observability fix (settle point 3)

Two gates, both required.

### 4a. Migration gate (on a production-store **copy**)

A new spec drives §2 end-to-end against a copy of a real store and asserts: base counts
equal, sentinel hits equal, `integrity_check` no new damage, `file_bytes`/`page_count`
strictly down, counter 0, and a post-migration `fts_match` returns the expected row. It
**names the backlog id** (`89849d2a`) — see §6.

### 4b. Leak gate — and its observability defect (`2bf0b7c8`)

The existing gate `libs/data/store/store-adapter/src/__tests__/fts-optimize-leak-gate.bl-c5249cdd.spec.ts`
TEST 1 (`:96-117`) has two assertions in this order:

- A `:102-106` — `expect(interleaved).toBeGreaterThan(single * 1.1)` (asserts the leak
  **reproduces**);
- B `:107-114` — `expect(installedTursoVersion()).toBe(FTS_OPTIMIZE_LEAK_MEASURED_ON)`
  (the version pin).

vitest throws on the **first** failing expect. So (from `2bf0b7c8`): if the leak is fixed
(A fails) the error message embeds both numbers (self-documenting — this is what the
2026-09-30 measurement relied on); but if the leak **still reproduces on a bumped
driver** (A passes, B fails) the run prints **only the version mismatch and no
`page_count` at all** — the single most decision-relevant scenario is the one the gate
is blind to.

**The fix (part of this work):** compute both arms **unconditionally**, build a single
combined result object, and assert on **that** object so both `interleaved` and `single`
values are always in the thrown message — the `2bf0b7c8` suggested direction, implemented
as a single-assertion restructure (not a reporter hook, which is fire-and-forget). Keep
the two facts as separate assertions *inside* one combined `expect(result)` so neither can
mask the other. Also update the pin literal `FTS_OPTIMIZE_LEAK_MEASURED_ON`
(`store-rebuild.ts:128`) only **after** re-measuring on the new driver, and re-measure
`SUPPRESSION_VALID_FOR` (`integrity.ts:2454`) similarly (its guard is
`integrity-selfheal.test.ts:48,79-92,663-699`; also surfaced as `suppression_valid_for` in
`libs/memory-core/src/restore-neardup.ts:435-487`).

The measured differential to preserve (agent-read; recorded as citation `e258aa0a` on
`89849d2a`): on **0.8.1** the interleaved arm gave **264 pages vs single 266** (ratio
0.9925) — assertion A fails, i.e. the leak is gone; the pinned **0.7.1 control passes**
(exit 0, 375 s), i.e. the harness is sensitive. The rewritten gate must keep this
differential demonstrable (§6, control run).

## 5. Rollback (settle point 4)

Two directions, two different answers.

- **Before the first 0.8 write:** rollback is trivial — nothing changed. Stop, restore
  the pin, restart. No store action.
- **After a store is written under 0.8 (fts2):** 0.7.x **cannot** read the FTS index.
  There is **no primary source** stating otherwise (`2bf0b7c8`'s sibling `89849d2a` research
  Q4 is explicitly UNVERIFIED/LOW); 0.7 has no control-row concept, so its Tantivy
  `Index::open` finds no `meta.json` and fails. **Do not promise a downgrade.** Rollback
  means: stop the service, then
  `memory restore <db>.pre-migration-<ts> --db <db>` — `restoreStoreOffline`
  (`store-rebuild.ts:1159`): refuses if the backup is the target (`backup_is_target`,
  same dev+ino, `:1159`), if the backup has live peers/openers (`backup_in_use`), if the
  backup `-wal` is non-empty (`backup_wal_not_empty`), or if it shrinks content beyond
  `maxContentDrop` (default `0.9`, `store-rebuild.ts:995`); then clones, re-verifies,
  and swaps. The pre-migration image therefore **must be proven restorable before the
  migration is declared safe** (§6 spike).

Consequence: the §2.2 image is **mandatory**, and its restorability is a **pre-flight
gate**, not a hope. If the image cannot be produced or verified, the migration must not
run.

## 6. Prerequisites, tests, and red→green (settle points 6 & 7)

### 6a. Pre-flight spike (BLOCKING — do first)

A throwaway-DB spike that converts two UNVERIFIED facts into measured ones:

1. **Rollback:** create a store under 0.8.x (fts2), open it under 0.7.1, record the exact
   failure mode. (Converts `89849d2a`-research Q4 from LOW to verified.)
2. **Cross-version VACUUM INTO:** confirm the §0 hazard — that a `VACUUM INTO` of a v1
   store under 0.8.x does **not** produce a clean v2 index — and that `DROP INDEX` →
   `CREATE INDEX` → `VACUUM` (same-version) **does**. This is the whole basis of §2's
   ordering.

Both run in an isolated worktree (`BL-235`/`BL-456`: nx build/test/typecheck have no
dry-run and rebuild upstream `dist/`; quote
`node tools/check-suite-tree-state.mjs --project store-adapter`).

### 6b. Tests (red→green, named for the id)

- `fts-format-migration.bl-89849d2a.spec.ts` — v1 fixture store → run §2 → assert base
  counts, sentinel hits, `integrity_check`, `page_count` shrink, counter 0, live
  `fts_match`. **Written and seen RED with the migration disabled, then GREEN.**
- `fts-optimize-leak-gate.bl-c5249cdd.spec.ts` — rewritten per §4b so both arms are
  **always** emitted; keep the leak assertion and the version-pin assertion both legible.
- `fts-gate-evidence.bl-2bf0b7c8.spec.ts` — drives the failure path (A passes, B fails)
  and asserts the thrown message contains **both** `interleaved` and `single`; seen RED
  on the current gate, GREEN after the restructure.
- **Control run on 0.7.1** — the gate's control arm must still show the leak reproduces
  on the old driver, so the differential stays demonstrable. Do **not** delete the 0.7.1
  control path when the pin moves (`89849d2a` records the 0.7.1 PASS as the sensitivity
  proof).
- `memory-cli/src/fts-rebuild-cli.bl-c5249cdd.spec.ts` exists (`(agent-read)`
  `:101` type-only `.Database` import) — extend it for the migration verb.

### 6c. Publishable-package / deployment classes

- `memory-cli` (command, registry `0.3.3`), `memory-flush` (hook, `0.2.7`),
  `memory-server` (mcp-server, `1.4.4`) are **publishable extensions with registry rows**
  `(agent-read)` — shipping the driver change to them goes through the **changesets
  release flow** (`PUBLISHING.md`); do **not** hand-publish or hand-bump.
- `libs/data/store/store-adapter` (`@adhd/sox-store-adapter` 0.13.2, `private:false`) is
  the library that bundles the driver as a sidecar external (`store-adapter/package.json:60`);
  it must be rebuilt (`npx nx build store-adapter`) after the bump.
- `memory-server` is a **service** — must be stopped for the migration (ADR-0013 D4 CLI
  path). The **backlog store** (`~/.adhd/backlog/production/data/backlog-v2.db`) is the
  second 0.7.1-backed store but lives in the **other repo** — cross-repo blocker B1;
  this spec covers the memory store only.
- `registry/index.json` is **not touched** (ADR-0021; `git diff --exit-code registry/index.json`
  must stay clean).

## 7. Blast radius of the pin change (settle point 5)

**Five `^0.7.1` caret manifests** (`(agent-read)`) — the in-repo claim of "3" (and
`integrity.ts:2437-2438`'s "2") is incomplete:

| # | path:line |
|---|---|
| 1 | `package.json:62` (root) |
| 2 | `libs/data/store/store-adapter/package.json:28` |
| 3 | `extensions/bundles/sox-memory-bundle/members/memory-flush/package.json:23` |
| 4 | `…/memory-server/package.json:25` |
| 5 | `…/memory-cli/package.json:25` |

Plus one **exact `0.7.2` scratch** manifest
`libs/data/store/store-adapter/scripts/turso-driver-probes/researcher-exp/package.json:13`
(`private:true`, package `exp`) — decide: remove or bump.

**Non-dependency marker (no change):** `store-adapter/package.json:60`
`sox.sidecarExternals` contains `'@tursodatabase/database'` (versionless).

**Lockfile (`pnpm-lock.yaml`, `(agent-read)`):** importers at root `10-13`,
memory-cli `177-180`, memory-flush `205-208`, memory-server `221-224`, store-adapter
`418-420`; `researcher-exp` `426-430`; package resolutions `2599-2649`; snapshots
`7266-7310`. **Relock (`pnpm install`) and commit the lockfile diff in the same change**
(AGENTS.md relock rule). Today only `0.7.1` is resolved for real consumers; `0.7.2` is the
scratch.

**Transitive drag (`(agent-read)`):** `@tursodatabase/database-common` (no runtime deps)
+ four optional native N-API platform binaries (only `database-darwin-arm64` materialized
on this machine). All move to `0.8.x` together; the platform binaries are `optional:true`
so a missing target is a non-fatal skip.

**Source constants to change — only after re-measurement:**
`FTS_OPTIMIZE_LEAK_MEASURED_ON` (`store-rebuild.ts:128`, `'0.7.1'`) and
`SUPPRESSION_VALID_FOR` (`integrity.ts:2454`, `'0.7.1'`). No semver comparison exists
anywhere in the repo; both are string-equality guard anchors.

**FTS API/behaviour change to guard against:** the fts2 rewrite may drop the
`__turso_internal_fts_dir_<idx>_key` sqlite_master row. The repo's
`tursoFtsInternalNames` (`fts-dialect.ts:78-81`) expects **three** objects (index +
`…_dir_<idx>` + `…_key`) and `verifyTursoFtsMaterialization` (`fts-ops.ts:346`) DROPs and
re-CREATEs the index when any is missing (then THROWs after one retry, `BL-507`). If
`_key` no longer exists under 0.8, **every open would DROP+CREATE the FTS index** — which
per `store-rebuild.ts:5-18` orphans the directory B-tree on each open, i.e. **re-leaks
pages**. This is a first-class hazard to verify in the spike and to fix before any live
open under 0.8. The backing **table name is unchanged** (`__turso_internal_fts_dir_<idx>`).

## 8. What this spec does NOT do (authorization boundary)

- **It does not bump the pin.** The owner has not authorized the version change; §7 is the
  decision input.
- It does not edit `registry/index.json`, run `registry:sync-index`, or touch any
  `BACKLOG.md`.
- It does not author ADR-0026; a new ADR for the migration decision is **proposed** in
  §9, to be written only on owner approval.

## 9. Blockers / reasons the migration is NOT yet safe

1. **`2bf0b7c8` observability** — the gate is blind to the "bumped but still leaking"
   case; fix (§4b) before the bump so the measurement is legible.
2. **Rollback direction UNVERIFIED** (0.7 ← fts2). The §6a spike must convert this; until
   then no downgrade may be promised and the pre-migration image is mandatory.
3. **Cross-version `VACUUM INTO` UNVERIFIED** (LOW). §2 orders the VACUUM *after* the
   index rebuild so it is same-version; the spike must confirm this is sufficient.
4. **`_key` object / `verifyTursoFtsMaterialization` misfire** (§7) — a re-leak-on-open
   risk under 0.8; verify in the spike.
5. **Cross-repo blocker B1** — the backlog store is in `/Users/nix/dev/node/adhd`; the
   memory-store migration is independently safe, the backlog half is not covered here.
6. **ADR constraint** — ADR-0013 forbids an env-var-armed migration; it must be a CLI
   subcommand (§2/§4a). ADR-0021 forbids touching the registry. ADR-0012 notes the
   `multiprocess_wal` TRUNCATE race is an open upstream hazard on every line — the
   migration must not introduce a new WAL-checkpoint mechanism.

## 10. Proposed ADR (owner approval required — not written)

`docs/decisions/0026-turso-fts-format-migration.md` (next free number = 0026; note
`store-reclaim` referenced a *different* proposed 0026 — reconcile numbering with the
owner before writing). Decision: pin 0.8.x only with the explicit offline
index-rebuild + same-version VACUUM migration; never auto-migrate on open; never
env-gate; upgrade-gated by the (fixed) leak gate; hard-link pre-migration image
mandatory; downgrade unsupported.
