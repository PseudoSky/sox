# Code Review — `memory-enrich/filtered-clustering`

**Reviewer:** code-reviewer (correctness + security; design genericity reviewed separately)
**Scope:** `git diff main..memory-enrich/filtered-clustering` — 4 commits (`dc30ee8`, `c003bbc`, `b2d1dd0`, `c3f1721`)
**Date:** 2026-06-22

## Verdict: **approve-with-fixes**

The core capability (`clusterSubset` / scoped `materializeClusters` / salted UIDs / provenance hashing)
is **correct, parameterized, and reality-verified**. SQL injection is not present. Scoped invalidation,
salt-collision-avoidance, determinism, and coexistence all hold and are backed by tests
(`nx test memory-enrich` 47/47, `nx test memory-server` 55/55; both lint clean). The P6 organizer
removal is complete and consistent. Two **High** items below are not in the clustering hot path but
are real defects introduced/left by the diff and should be fixed before merge; the rest are Medium/Low.

Files read in full or in relevant part:
`libs/memory-enrich/src/cluster.ts`, `libs/memory-enrich/src/cluster-subset.spec.ts`,
`libs/memory-enrich/src/index.ts`, `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`
(filter + recluster regions), `.../memory-server/src/memory-tools.spec.ts`,
`libs/memory-core/src/memoryd.ts`, the three `memoryd.ts` member copies, `libs/memory-core/src/schema.ts`,
`libs/memory-core/src/extensions.ts`, `libs/memory-core/src/index.ts`, the daemon `index.ts`/`bin.ts`,
`extensions/bundles/sox-memory-bundle/extension.json`, `registry/index.json`, `nx.json`, `scripts/v2-e2e.test.ts`.

---

## Focus-area findings (the 6 asked-for questions)

### 1. SQL injection / `restrict:{sql,params}` — **SAFE**

Traced the full path: `memory_curate.recluster` → `buildFiltersClause(filters)`
(`memory-server/src/index.ts:584-662`) → `restrict` → `clusterSubset` → `selectEpisodes`
(`cluster.ts:417-430`). `buildFiltersClause` emits **only static SQL fragments plus `?` placeholders**;
every caller-supplied value (`project_path`, `topic`/`topic[]`, `tags[]`, `importance_min`,
`t_created_after/before`, prefix) is pushed to `params` and bound, never interpolated
(`index.ts:596,600-601,609,613-614,625,632,642-643,649-650,656-657`). `selectEpisodes` appends
`restrict.sql` verbatim but it contains no caller string — only `?`. The `filter` object is used **only**
for the provenance hash and stored via a parameterized `meta` insert (`cluster.ts:369,392`). **No
injection vector.** A non-string array element (e.g. an object in `tags`) is bound as-is and
better-sqlite3 throws — fail-closed, not an injection. No fix required.

### 2. Scoped upsert / invalidation correctness — **CORRECT**

`materializeClusters` (`cluster.ts:321-404`) computes `priorIds` from `meta.cluster_scope`:

- `subset` (`:337-342`): only communities whose `$.cluster_scope.hash` equals this `provenanceHash`.
- `global` (`:344-352`): only communities where `$.cluster_scope.kind IS NULL` (legacy/pre-P1) **or**
  `= 'global'`. Subset communities (`kind='subset'`) are excluded → a global pass never touches them.

Invalidation closes `t_invalid` on exactly those node rowids and their `MEMBER_OF` edges scoped by
`dst IN (priorIds)` (`:356-359`) — no broader wipe, no orphaned live edges (each member edge's `dst`
is in `priorIds`). The self-revive on idempotent re-run (invalidate then `t_invalid=NULL` the same uid,
`:382-384`) plus fresh edge inserts is correct: prior edges stay invalidated, new edges are live, so live
edge count does not accumulate. Tests assert exactly this (`cluster-subset.spec.ts:153-180, 198-224`).

### 3. Salted community UID — **CORRECT, back-compat holds**

`communityUid(sortedRowids, salt)` (`cluster.ts:170-173`): `salt ? "${salt}:${rowids}" : rowids.join(',')`.

- Empty salt reproduces `main`'s `sha256(rowids.join(',')).slice(0,32)` **byte-for-byte** (verified
  against `git show main:.../cluster.ts` — the only change is the optional salt prefix). Global UIDs are
  unchanged → existing global communities keep their uids.
- Subset salt = the 16-hex provenance hash, so a subset community with identical membership to a global
  community has a different `uid` → the `WHERE uid = ?` upsert (`:377`) can never overwrite the global
  node. Test `cluster-subset.spec.ts:182-196` asserts the two uids differ.

### 4. Determinism — **CORRECT**

`filterProvenanceHash` (`:176-179`) hashes `stableStringify` output (`:182-187`), which sorts object
keys recursively → equal filters hash equal regardless of key order. Rowids are sorted ascending before
UID derivation (`:256`) and before traversal (caller-sorted, `:226-227`). `groups()` iteration order does
not affect output (each group is independently sorted). No `Date.now()`/`Math.random()` in the UID or
hash path (`new Date().toISOString()` is used only for `t_created`/`t_invalid`, not for identity).
Tests assert stable provenance + uid across runs (`:143-149`, server `:derives a stable provenance hash`).

### 5. P6 daemon rewire — **CORRECT, complete**

- `processBatchEnrich` (`memoryd.ts:286-300`) calls `runBatchEnrich(this.db)` from `@adhd/sox-memory-enrich`;
  the LLM organizer (`organizeItem`, provider fetch, `SYSTEM_PROMPT`, `MEMORY_PROVIDER_*`) is fully
  removed from `memory-daemon/src/{index,bin}.ts` and both member `memoryd.ts` copies. No leftover
  provider code path. `MemoryDaemon` constructor is now single-arg `(dbPath)` and both call sites
  (`memory-daemon/src/bin.ts:51`, `memory-server/src/bin.ts:51`) match.
- Queue drain semantics preserved: `enrich`/`ingest` rows trigger one batch-enrich pass per cycle;
  `decay`/`reindex` handled in-daemon (`drainBatch` `:179-190`).
- Schema CHECK constraint adds `'enrich'` (`schema.ts`), consistent with the drain filter
  (`:179-180`). **But see High-2 — nothing currently enqueues `'enrich'`.**
- Bundle `members[]` 6→5, registry resynced (organizer record + checksums updated, working tree clean),
  e2e fixtures updated (`v2-e2e.test.ts` 4→3 / 6→5). All consistent.

### 6. Test adequacy — **GOOD for the engine; thin at the server boundary (acceptable)**

`cluster-subset.spec.ts` genuinely asserts coexistence (`:153-180`), salt no-collision (`:182-196`),
idempotent re-replace (`:198-212`), and global-after-subset survival (`:214-224`) with controlled
embeddings — not happy-path only. `memory-tools.spec.ts` covers server wiring: subset selection +
dry_run read-only, opaque/non-matching filter → empty, stable hash, no-filter → global enqueue.
Coverage gaps noted below (none blocking).

---

## Severity-ranked findings

### HIGH-1 — Stale `memory-organizer` reference in `nx.json` release group

`nx.json:62-71` — the `memory-extensions` release group still lists `"memory-organizer"` as a project,
but the project was deleted in this diff (its dir and `project.json` are gone; `nx show projects`
confirms it is absent from the graph). `nx show projects` tolerates this lazily, but **`nx release`
(version/changelog/tag) against this group will fail or skip on the missing project**. This is the same
class of registry/manifest drift the repo's C2 gate guards against, just in the release config.
**Fix:** remove the `"memory-organizer",` line from `nx.json:66`.

### HIGH-2 — `'enrich'` op added to schema CHECK + drain filter but never enqueued (dead op)

`schema.ts` adds `'enrich'` to the `organizer_queue.op` CHECK constraint and `memoryd.ts:179-180`
drains it, but **no producer ever inserts `op='enrich'`** — `enqueueIngest` writes `VALUES ('ingest', …)`
(`memoryd.ts:351-364`) and `memory_curate.recluster`'s global branch calls `enqueueReindex` (→
`op='reindex'`, `memory-server/src/index.ts:1983`). The new op is therefore unreachable. This is not a
correctness bug today (drain handles it if present), but it is a **schema migration that ships unused
surface** and a CHECK-constraint widening with no caller — easy to mistake for wired behavior.
**Fix (pick one):** either (a) make `enqueueReindex`/a new `enqueueEnrich` emit `op='enrich'` so the
batch-enrich path has an explicit trigger distinct from `ingest`, and assert it in a test; or (b) drop
`'enrich'` from the CHECK constraint and the drain filter until a producer exists. (a) is preferable —
it gives the daemon an explicit "re-run global enrichment" trigger, which is exactly what
`memory_curate.recluster` (no filters) wants instead of overloading `reindex`.

### MEDIUM-1 — Three divergent `memoryd.ts` copies; member copies silently lack reembed-on-reindex

`libs/memory-core/src/memoryd.ts` retains the `reindex` `reembed=true` path (`:218-268`) and exports
`enqueueReindex`, but the two member copies
(`.../memory-daemon/src/memoryd.ts`, `.../memory-server/src/memoryd.ts`) have a **FTS-only** `reindex`
case with no re-embed and no `enqueueReindex`. The **member copy is what the daemon process actually
runs** (`memory-daemon/src/index.ts` imports `MemoryDaemon` from `./memoryd.js`). So after
`SOX_EMBED_BACKEND` changes, the running daemon will not re-embed nodes on a `reindex` op — vectors go
stale and clustering silently degrades. (This divergence pre-exists `main` for the member copy, so it is
not a regression *introduced* here, but P6 touched all three copies and is the right moment to converge
them.) The triple-maintained file is itself the hazard: the diff already shows the three copies drifting
in comments and socket-path handling. **Fix:** make the bundle members import `MemoryDaemon` from
`@adhd/sox-memory-core` (the C7 reuse pattern this repo already enforces) rather than carrying a forked
`memoryd.ts`, or at minimum port the reembed branch into the member copies and add a test that a
`reindex {reembed:true}` op re-embeds. Track in BACKLOG either way.

### MEDIUM-2 — Batch-enrich failure marks queue rows `done` (no retry), contradicting its own comment

`memoryd.ts:286-300` swallows a `runBatchEnrich` error and the comment says "items are marked done; next
cycle will retry" — but `drainBatch` marks the drained rows `done_at` unconditionally **after**
`processBatchEnrich` returns (`:193-197`), so a failed enrich pass is **not** retried; those episodes are
permanently dropped from enrichment. Pre-existing drain structure, but the P6 rewire makes
`processBatchEnrich` the sole consumer of `ingest`/`enrich` rows, so the data-loss-on-transient-failure
window now covers all enrichment. **Fix:** on enrich failure, do not mark the enrich/ingest rows `done`
(leave `done_at` NULL so the next cycle re-drains), or move the `done` update to only cover rows whose
op actually succeeded. Add a test that a throwing `runBatchEnrich` leaves the row re-drainable.

### MEDIUM-3 — `tags` filter cast `as string[]` without runtime validation

`memory-server/src/index.ts:619` casts `filters['tags'] as string[]` and `buildFiltersClause` binds each
element. Non-string elements don't inject (better-sqlite3 rejects object binds), but a caller passing
`tags: "skill:A"` (a bare string, not array) hits `tagsFilter.length` on a string → iterates characters,
producing a garbage predicate rather than a clear error. **Fix:** guard `Array.isArray(tagsFilter) &&
tagsFilter.every(t => typeof t === 'string')` and otherwise ignore or error. Low blast radius (the engine
is opaque-by-design) but a clearer failure mode. Mirror the `topic` handling which already branches on
`typeof`/`Array.isArray` (`:606-616`).

### LOW-1 — `clusterSubset` with no `restrict` and empty `filter` salts the global partition under a hash

`clusterSubset` (`:584-616`) always salts community UIDs with `provenanceHash` derived from
`filter ?? restrict.sql ?? ''`. Called with no filter and no restrict, it clusters all live episodes but
under a non-global salt and `scope:'subset'` — i.e. a *second*, hash-namespaced copy of the global
partition. That's defensible per the "named lens over everything" doc note, but it is a foot-gun: a
caller who omits `filters` on the engine API (not via the server, which routes empty filters to the
global path) gets a duplicate community set. Consider rejecting `persist:true` with neither `restrict`
nor a meaningful `filter`, or documenting the empty-filter hash explicitly. Not reachable from the
current MCP surface (server guards `Object.keys(filters).length > 0`, `index.ts:1943`).

### LOW-2 — Dead branch carried into the extracted core (pre-existing)

`computeClusters` `:507-509` (`if (clusters.length === 0 && attempts === 3)`) is unreachable: the loop
only breaks after assigning `clusters` (`:498-500`), and when `attempts===3` it assigns first. Verbatim
from `main`'s `clusterStore`, so not introduced here, but the extraction was the opportunity to drop it.
Harmless. Cleanup-only.

### LOW-3 — Test gap: no server-level assertion that `dry_run:false` persists + leaves global intact

`memory-tools.spec.ts` covers dry_run read-only and selection, but the **persist** path
(`dry_run:false` → `persisted:true`, global partition untouched) is only tested at the engine layer, not
through `handleToolCall`. The engine tests cover the hard logic, so this is a thoroughness gap, not a
correctness risk. Suggest one server test: persist a subset via `memory_curate`, then assert via
`memory_get_community`/`memory_stats` that the global communities still exist.

### LOW-4 — `'enrich'` schema change has no migration for existing DBs

`CREATE TABLE IF NOT EXISTS organizer_queue` (`schema.ts`) only applies to **new** stores; an existing
`memory.db` keeps the old CHECK constraint without `'enrich'`. If/when a producer emits `op='enrich'`
(HIGH-2 fix), inserts into pre-existing DBs will fail the old CHECK. Add an idempotent migration, or keep
using `'ingest'` for the enrich trigger. Currently latent because nothing emits `'enrich'`.

---

## Verification performed (read-only)

- `nx build memory-core`, `nx build memory-enrich` — succeeded.
- `nx test memory-enrich` → **47 passed**; `nx test memory-server` → **55 passed**.
- `nx lint memory-enrich`, `nx lint memory-server` → both clean.
- `nx show projects` — `memory-organizer` absent from graph (confirms HIGH-1 is a stale ref).
- `git show main:…` byte-compare of `communityUid` — back-compat (empty salt) confirmed.

## Merge recommendation

**approve-with-fixes.** The reviewed clustering/security surface is sound and tested. Fix **HIGH-1**
(one-line `nx.json` deletion) before merge — it breaks `nx release` for the memory group. Resolve
**HIGH-2** (wire or remove the `'enrich'` op) so the schema doesn't ship an unreachable constraint.
The Medium items (memoryd triple-copy convergence + reembed parity, enrich-failure retry, tags
validation) should be fixed now or logged to BACKLOG with owners; none block the filtered-clustering
feature itself.
