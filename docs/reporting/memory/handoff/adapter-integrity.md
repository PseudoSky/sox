# Handoff — adapter integrity (BL-352 family)

> Written 2026-07-31 by `p0-adapter-integrity` at context rotation. Assumes you know nothing
> about today. Optimised for **not repeating my dead ends**.
> Entry point for the wider program: [`../README.md`](../README.md) → [`../STATE.md`](../STATE.md).

---

## 0. Read this first — the one thing that will mislead you

**The running service does NOT contain the BL-374 or BL-373 fixes.** Verified by inspecting the
deployed bundle, not inferred:

```
extensions/bundles/sox-memory-bundle/members/memory-server/dist/index.js   (built 17:44)
  pickSentinelTokens     0     ← BL-374 fix absent
  isStaleWalIndexError   0     ← BL-373 fix absent
  recoverStaleWalIndex   0     ← BL-373 fix absent
  last_integrity         1     ← BL-334 durable persistence present
```

My fixes landed in `8fe0571` at ~18:35, after that build.

**Therefore: a live `memory_ping` reporting `integrity.overall: "ok"` is NOT evidence that BL-374
is fixed.** The false positive was *probabilistic* — 7.3% of rows, ~1-in-5 chance per pass — so a
clean reading is the expected 4-in-5 outcome of the **old, still-deployed** probe. Do not close
BL-374 on a green ping until the bundle is rebuilt and you can see `pickSentinelTokens` in the
artifact. I flagged this to team-lead at rotation.

What *is* confirmed working in production is the **BL-352 engine itself** (see §2).

---

## 1. What shipped

`libs/data/store/store-adapter/src/integrity.ts` — verification and self-repair of the artifacts
the adapter generates, discovered by introspecting `sqlite_master`, so it needs **no schema
knowledge from any consumer**. That is why it works on the live store without `memory-core`
declaring anything.

| Probe | Detects | Repair |
|---|---|---|
| `wal_identity` | WAL unlinked/replaced under a live connection (BL-330) | `wal_checkpoint(PASSIVE)` + loud report |
| `adapter_meta_unique` | duplicate PK rows (BL-336) | table rebuild, earliest row per key |
| `btree_index_populated` | index exists but is unpopulated (BL-335) | `REINDEX "<name>"` individually (BL-337) |
| `fts_index_live` | FTS index does not match its own rows (BL-347) | `DROP INDEX` + dialect `createIndexDDL` |
| `pragma_integrity_check` (deep) | everything else, cap-aware (BL-341) | `REINDEX` by named object |

Wired into `TursoAdapterImpl.connect()` and `SqliteAdapterImpl.init()`, so it runs on the normal
open path. `StoreAdapter.init()` is a declared interface member (was an `as any` in the factory).

**Cost tiers**, measured **from a terminal-spawned process** — always state the spawn context
(BL-331), because until 18:05 today the service ran at priority 4 where the same work was ~19x
slower:

| Probe | 43 MB / 9 428 nodes | 69 MB / 9 488 nodes |
|---|---|---|
| `adapter_meta_unique` | < 0.5 ms | < 0.5 ms |
| `fts_index_live` | 9.3 ms | 9.8 ms |
| `btree_index_populated` | 78.5 ms | 84 ms |
| **fast total (every open)** | **91 ms** | **96 ms** |
| **deep total** | **392 ms** | **424 ms** |

`deep` tracks database **size**, not row count — `integrity_check` is O(pages). `fast` runs every
open; `deep` runs on an unclean shutdown (the `_adapter_meta.clean_shutdown` marker), on request,
or never otherwise. Controls: `SOX_STORE_VERIFY=off|fast|deep`, `SOX_STORE_REPAIR=off`.

**Durable persistence** — the verdict is written to `_adapter_meta.last_integrity` as versioned
JSON (`persistIntegrityResult` / `readIntegrityResult`). **Do not replace this with an in-process
registry**; see §4. It also proved its worth diagnostically: I root-caused BL-374 by reading the
failed pass straight out of that row instead of trying to reproduce it.

**Status surface** — `memory_ping.store.integrity` + `store.integrity_headline`, same block on
`memory_stats`. Rendering lives in `integrity-status.ts`, deliberately separate and separately
tested, because *the reporting layer is where "damaged" historically turns back into "healthy"*.
`healthy: true` requires a pass that ran, completed, found no damage, **and** whose every probe
demonstrably exercised its artifact. Never-ran / aborted / unvalidated / verification-disabled all
render `unknown`, and `unknown` is not healthy. `repaired` is distinct from `ok` on purpose.

---

## 2. Confirmed working in production

The live store **self-repaired on first open**, with no manual DDL — the owner's explicit
requirement, after a manual `DROP INDEX`+`CREATE` was proposed and rejected.

| check | before | after |
|---|---|---|
| `fts_match('memory')` | 0 | **1156** |
| `fts_match('turso')` | 0 | **138** |
| `fts_match('backlog')` | 0 | **84** |
| `_adapter_meta` duplicate keys | 3 keys ×2 | none |

`memory_recall` returns `"provenance":["fts"]` with non-zero BM25. Keyword search had been dead
for over a day while the service reported healthy.

---

## 3. Open work

### BL-352 items 2–5
2. **Repairs are direct adapter operations, not versioned migrations.** Needs BL-302's migration
   executor, which does not exist (`targetVersion` hard-coded to 1, no `migrations[]`).
3. **No committable Turso FTS damage fixture** (BL-362). Four recipes tried, all failed — do not
   repeat them: (a) deleting Tantivy directory rows — Turso refuses, and via better-sqlite3 the
   delete affects nothing because that table holds **0 rows in every state**; (b) repointing the
   directory table's rootpage — FTS kept working, content is not read through it; (c) inserting
   without `experimental:['index_method']` — the INSERT itself throws, so this is *not* how the
   live damage happened; (d) reinstating the index's `sqlite_master` row without its directory
   table — **panics the driver and aborts the process** (BL-361).
4. **`vec_node` consistency unprobed** — row present, correct byte length (768×4=3072), no orphans.
5. **Deep verification has no cadence** — only unclean-shutdown or explicit request.

### BL-373 — stale `-tshm`. **Fixed in source, not deployed.**
`TursoAdapterImpl.connect()` now detects the WAL-frame open failure, moves the sidecar aside
(**renamed, never deleted** — that file is the only forensic record) and retries once. Acts only
when the WAL is absent or 0 bytes; a non-empty WAL is declined and reported. The error names
`<db>-tshm` and keeps the driver's original text. Distinct `[BL-373]` telemetry.

Verified against the preserved artifact (`~/.adhd/.../prerestart-20260731-174637/stale-tshm-jul30`):
opens, 9478 nodes intact. **What remains: deploy, and BL-330's orphaned-sidecar guard should cover
`*-tshm` alongside `*-wal`.**

Committable repro: seed ≥900 rows, capture the `-tshm`, `wal_checkpoint(TRUNCATE)`, close, restore.
300/600 rows do **not** reproduce; 900/1200 do. **The seed must use the raw driver** — going
through the adapter writes `_adapter_meta` after the checkpoint and puts fresh frames back in the
WAL, defeating the fixture. That cost me a cycle.

### BL-330 remainder
The documented consistent-snapshot procedure and the orphaned-`*-wal` maintenance guard.
`~/.memory/` still holds `memory-turso.db-wal` and `memory-turso-live.db-wal` from earlier
migrations — "a cleanup mistakes a live WAL for debris" remains plausible. Detection + checkpoint
recovery shipped; recovery is `wal_checkpoint(PASSIVE)`, measured 140/140 vs total loss.

### BL-360 — the filter, so nobody reimplements it
Turso's `PRAGMA integrity_check` emits
`wrong # of entries in index __turso_internal_fts_dir_<idx>_key` **unconditionally**, including on
a freshly built index whose `fts_match` returns 200/200. **The filter lives in
`integrity.ts` → `isKnownFalsePositive()`**, with a guard test that fails if Turso stops emitting
it. This invalidated the stated acceptance of **BL-335, BL-337 and BL-341**, each of which demanded
"a clean `integrity_check`" — an unreachable state on this backend. Team-lead amended BL-335/338;
BL-337 I amended myself.

---

## 4. Lessons that will cost you a day each

**A probe that cannot fail on the damaged state is a comment.** But the inverse bit us harder:
**a probe that fires on a healthy state gets tuned out.** I fixed *two separate causes* of the same
"verdict that can never return to ok" symptom:

- **Page accounting.** `Page N: never used` is reclaimable free space, not damage, and a
  `DROP INDEX` — *including the one my own FTS repair performs* — routinely leaves them. Counting
  them kept the live copy at `reverified: damaged` forever after a fully successful repair.
- **Truncated sentinel token (BL-374).** The picker matched `/[A-Za-z][A-Za-z]{5,19}/`, capping at
  20 characters and **silently truncating longer runs**. Live row 9478 contains
  `sharedFastembedProcess` (22 letters); the probe searched for `sharedFastembedProce`, which is
  not a term in any tokenizer. Measured on 400 live rows against a known-good index: **29 false
  misses (7.3%)** vs **0** with whole-word candidates.

**What would cause a third.** Any check that (a) treats a message class as damage without asking
whether a *correct repair* can produce it, or (b) derives its query input from data rather than
from the artifact's own contract. Before adding a probe, ask: *can a successful repair make this
fire?* and *can this input be wrong in a way that looks like damage?* Both fixes were structural
— whole-word lookarounds, and up to three candidate tokens per row with any-match — not another
filter. Prefer that.

**Do not use an in-process registry for status data.** Two independent mechanisms make it
unreadable from `memory_ping`, both measured: `openDb()` returns `instrumentAdapter(adapter)`, a
**Proxy**, so a WeakMap keyed on the adapter misses; and `memory-core` compiles to CJS and reaches
store-adapter through `require()` while an ESM consumer gets it through the ESM loader — **two
module instances, two module-level Maps**. Path-keying fixes only the first. Both fail *silently*
as "never ran". Hence `_adapter_meta.last_integrity`. (BL-368.)

**Engine facts worth knowing before you write SQL here.**
- `SELECT COUNT(*) FROM t` is optimised to scan the smallest index — so on a store with an
  unpopulated index the *baseline* reads 0 and a naive probe compares 0 against 0. Count through
  the table btree (`ORDER BY rowid`).
- Turso **silently ignores `INDEXED BY` on a partial index** (real SQLite raises "no query
  solution"). 8 of the live store's 20 indexes are partial. Append the index's own predicate, and
  require `EXPLAIN QUERY PLAN` to name the index or report `unknown`.
- `GROUP BY key` on `_adapter_meta` resolves through the very index whose damage let duplicates in,
  so it reports one row per key on a table visibly holding six.
- `DELETE` cannot remove those duplicates (`Corrupt database: IdxDelete`); only a table rebuild
  works.
- `REINDEX <table>` is impossible on any table carrying a Tantivy index (BL-337) — reindex by
  index name.
- `better-sqlite3` **can** open a Turso-FTS store if `PRAGMA writable_schema = ON` is set first;
  a plain open fails with `malformed database schema`. That is how every damage fixture is seeded.
- **`grep` is a shell function** that returns nothing on a file with a raw NUL byte. Use
  `/usr/bin/grep` when proving absence. This produced two false "NOT FOUND" readings for me on
  symbols that were present. (BL-371, now guarded by `tools/check-no-nul-bytes.mjs`.)

---

## 5. My read on BL-380 — asked for at rotation

**Is BL-380 the root cause of BL-364? No — but they share one.** Be precise here, because the
distinction changes the fix.

BL-364 is the *inverse* of BL-380. BL-380 is casting a `StoreAdapter` **down** to `SqliteAdapter`
and unwrapping. BL-364 is a caller passing a **raw `better-sqlite3` Database where a `StoreAdapter`
is expected** (`hybrid-search.spec.ts:451` → `new SqliteVectorBackend(db)`), so
`adapter.capabilities` is `undefined` at `vector-store/src/index.ts:197`. Fixing every cast in
BL-380 would not, by itself, fix that call.

The shared root is that **`SqliteVectorBackend` is a sqlite-only class wearing a portable-looking
constructor.** It takes a `StoreAdapter`, immediately does `this.db = (adapter as SqliteAdapter).unwrap()`
(line 200), and thereafter uses the raw handle synchronously. The type boundary is fictional in
both directions, which is exactly why a caller could pass the wrong type and get 197 lines in
before anything noticed.

**A trap for whoever picks this up.** Line 196 is
`vecEnabled: adapter.capabilities.nativeVectors || true` — unconditionally `true`. The only use of
the adapter interface in that constructor is **dead code that can only crash**. Deleting it turns
15 tests green while fixing nothing and leaving the class just as backend-blind. Resist that.

**Capability gap vs reaching around, per site:**

| site | verdict |
|---|---|
| `memory-cli` 180, 218, 322 | **Reaching around, unambiguous.** All three are `openDb(dbPath)` → `unwrap()` → sync `.prepare().get()/.all()`. `openDb` defaults to **Turso**, so all three are broken on the default backend — identical shape to BL-377. The surrounding functions are already `async` and these are plain queries: direct `executeGet`/`executeAll` conversions. **Start here** — lowest risk, highest certainty. |
| `vector-store` 143, 200 | **Reaching around, but with a real cost.** Ordinary SQL/DDL that the adapter API covers — except both sit on **synchronous** methods (`topK` returns an array, the constructor `exec`s DDL). Converting means making `SqliteVectorBackend` async, which is an **API break for external consumers** (`agent-source` imports `VectorBackend`/`VectorSpace` as a `file:` dep). That is the real decision, and it is a design call, not a mechanical fix. |
| `vector-store` 359 | **Genuine capability gap.** `openVectorStore(path)` constructs its own sqlite adapter and calls `sqliteVec.load(db)`. **`StoreAdapter` has no extension-loading surface**, so there is no non-raw way to express this. Same class as the two sites BL-380 correctly blesses (`db.ts:373,896`) — which are legitimate *because they are `capabilities`-guarded*, not because they unwrap. Minimum fix: add the `capabilities.nativeVectors` guard. Better fix: give `StoreAdapter` an explicit extension/native-handle capability so the assumption is declared rather than asserted. |

**My recommendation.** Do the three `memory-cli` sites first and independently — they are pure
wins and they are broken in production today. Treat `vector-store` as one architectural decision
(does `SqliteVectorBackend` become async and genuinely portable, or is it explicitly renamed and
typed sqlite-only with a `SqliteAdapter` parameter?) rather than three separate cast removals.
**Either answer is defensible; the current state — portable signature, sqlite-only body — is the
one that is not.** Typing it honestly as sqlite-only would also make BL-364's caller a compile
error instead of a runtime crash.

**Confidence:** high on `memory-cli` and on the BL-364/BL-380 distinction (I read all six sites
and both backlog items). Medium on the `vector-store` async question — **I have not audited
`agent-source`'s usage**, so the true blast radius of an async break is unmeasured. Verify that
before committing to a direction.

> **ANSWERED 2026-08-01 — measured, and the answer is "trivial".** `@adhd/sox-vector-store`'s
> entire value-level consumer surface outside its own package is **two spec files**
> (`analysis.spec.ts:23`, `hybrid-search.spec.ts:16`); `analysis/src/index.ts:6` and
> `hybrid-search/src/index.ts:15` are **type-only** re-exports, which an async change does not
> affect. **`agent-source` is not a package in this repository at all** — it appears only in
> `docs/ideas/phase-2-agent-source.md`, an unbuilt phase-2 concept. There is no consumer to break.
>
> The hedge above was correct and correctly flagged: it said "I have not checked this, verify it."
> What followed was not. It was restated downstream as *"`vector-store` is NOT ready to touch"* and
> enforced as a prohibition for a full day, across five agents, plus a `warn`-only lint exemption —
> without anyone running the one grep that settles it. **An unverified hedge must not harden into a
> constraint as it is relayed.** If you are relaying someone else's caveat, either verify it or
> carry its uncertainty forward verbatim.

---

## 6. State of the tree at handoff

- Commits: `fa786a2` (engine), `52f9c8c` (durable verdict), `0d2d629` (status wiring +
  page-accounting fix), `8fe0571` (BL-374 + BL-373), plus backlog/docs commits.
- `store-adapter`: lint / typecheck / test / build green, **285/285**.
- `memory-server`: typecheck + lint green. **I never built or restarted it** — team-lead owns the
  deploy; it is currently held while the embed backlog drains.
- Guards: `check-backlog-markers` OK, `check-no-nul-bytes` OK, no duplicate BL ids.
- Filed by me today: BL-360, BL-361, BL-362, BL-363, BL-364, BL-379.
- **BL-373 and BL-374 are deliberately left `Open`, not RESOLVED** — the fixes are in source but
  the live service still runs the old bundle, and marking them resolved would delete an
  actively-firing production defect from the backlog. Flip them when the deploy verifies.
