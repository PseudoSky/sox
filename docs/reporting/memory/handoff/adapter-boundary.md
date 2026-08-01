# Handoff — adapter boundary / storage dialect thread

> **Written by the team lead, not the agent.** `adapter-boundary` hit a session limit before it
> could write its own. Everything here is from its final report; where I could verify a claim
> against the repo I did, and where I could not I say so. Treat unverified claims as leads.
>
> **Entry point:** [`../README.md`](../README.md) → [`../STATE.md`](../STATE.md).

**Committed:** `fc71730` (BL-381 fix, memory-core only).

---

## 1. BL-381 — FIXED, and the item's stated root cause was WRONG

The backlog said the defect was `neardup.ts:46` emitting `vec0` SQL. That is where the error
*surfaced*, not where it originated.

`neardup.ts` **already had** a `useNativeVectors` bail-out. The live failure came from **three
`memory-server` call sites dropping the flag** — `index.ts` 1302 / 1369 / 1772 passed only
`useBinaryFormat`, and `schedulePendingEmbeds` defaulted the flag to `false`. So the `vec0`
statement was issued against Turso on **every `memory_write`** — the main path, not an edge case.

**The structural fix is the type, not the SQL.** The dialect is now **required** on
`detectNearDup` / `applyEmbedding` / `schedulePendingEmbeds`; omitting it is a compile error. New
`libs/memory-core/src/dialect.ts` provides `vectorDialectFor` / `ftsDialectFor`.

Red→green watched: with the literal SQL restored, turso fails with the exact production error
(`prepare failed: Parse error: no such column: k`) and sqlite still passes; restored → 3/3.
`enrich.spec.ts` went 8 → 6 failures, A/B'd against HEAD — the remaining 6 are BL-325's
`clusterStore ON CONFLICT` drift, identical in both runs.

`enrich.ts`'s bare `catch {}` now logs `enrich.neardup.error`, so the next failure is not silent.

**Generalisable lesson:** the item named the symptom's location confidently and was wrong. That is
the third such case today (BL-323's severity, BL-342's root cause). **An item's own root-cause
claim is a lead, not evidence.**

---

## 2. ⚠ BL-385 (CRITICAL) — a Turso store cannot be backed up. At all.

This closes a question three agents had left open as "unknown". It is not unknown; it is broken.

Measured by replaying `backup.ts`'s exact statement sequence against a **copy** of
`~/.memory/memory.db` + `-wal` (copied together per BL-330; the live store was not touched):

```
sqliteVec.load           ok
PRAGMA journal_mode=WAL  FAILED — malformed database schema
                                  (__turso_internal_fts_dir_idx_fts_node_key) - near "USING"
PRAGMA busy_timeout      ok
VACUUM INTO              FAILED — database disk image is malformed
```

**No destination file is produced.** `backupStore()` returns `E_IO`. `backup.ts:169-217` hardcodes
`createSqliteAdapter(...) as SqliteAdapter` → `unwrap()` → `sqliteVec.load()` → `VACUUM INTO`,
never consulting the store's actual backend.

Two things make this worse than a missing feature:

1. **The failure text reads as data corruption.** During an incident it sends an operator down
   entirely the wrong path — chasing a corrupt store that is in fact healthy. This box has already
   lost power mid-backfill once (BL-338).
2. **Two `backup.spec.ts` failures were being attributed to spec drift and are actually this.**
   Third instance today of a production defect hiding inside "test debt" (BL-377 was 30 of 162;
   BL-364 sat red four days). **A failure count is an upper bound on test debt, never a measure.**

**It is a genuine capability gap** — `StoreAdapter` has no backup surface — so making the cast
conditional is *not* the fix. The adapter must own the operation. Someone will try the former.

---

## 3. BL-384 (HIGH) — every entity search on the live store is a substring scan

`memory-core/src/extensions.ts:1043` issues raw SQLite FTS5 shadow-table SQL in
`memory_search_entities`:

```sql
FROM fts_node f … WHERE fts_node MATCH ? … ORDER BY f.rank
```

`openDb()` **drops `fts_node`** on the turso branch. A bare `catch` then falls through to
`name LIKE ? OR content LIKE ?` ordered by importance. So entity search has silently degraded to a
substring scan **since the migration**.

This is the FTS twin of BL-381: `recall.ts` was converted to dialects and this site was missed.
**That is the argument for the lint rule in one sentence.**

---

## 4. The sweep — full results

Permitted modules (`store-adapter`, `migration.ts`) and comments excluded.

**Violations found:** BL-384 and BL-385 above (both new).

**Already filed, unchanged:** `vector-store/src/index.ts` 143/200/359 and `memory-cli` 180/218/322
(BL-380); `hybrid-search.spec.ts:451` (BL-364); `db.ts` 373/896 (capability-guarded — blessed).

**NOT violations — as valuable as the violations, because they stop the next agent "fixing"
correct code:**

- **`recall.ts` 363-560 is the model to copy** — dialect-driven, branches on
  `ftsDialect.supportsShadowTable`, never on `config.type`. `db.ts` 322-674 likewise.
- `graph-store/src/index.ts:961` (`fts_node MATCH ?`) — sole consumer is `hybrid-search`, not the
  memory-server recall path. A genuinely sqlite-only library, but with the same honesty problem as
  `SqliteVectorBackend`: a portable-looking signature over a sqlite-only body.
- `write-queue.ts:417`, `db.ts:348/664`, `integrity.ts:691` name a backend but are legitimate
  **engine-behaviour branches**, not dialect leaks.
- Every `STORE_ADAPTER` read outside `factory.ts` is test-only, except
  `memory-server/src/index.ts:2337` — a diagnostic message naming the driver, cosmetic.

---

## 5. Open, in the agent's recommended order

1. **BL-385** — it flagged this as arguably outranking everything else. I agree.
2. `memory-cli` ×3 (BL-380) — unambiguous reach-arounds, broken on the default backend today, pure
   wins. `openDb()` → `unwrap()` → sync `.prepare()`, surrounding functions already async.
3. **BL-384**.
4. The **lint rule** — banning backend names, `as SqliteAdapter`/`as TursoAdapter`, `.unwrap()` and
   raw `better-sqlite3` imports outside the two permitted modules. See
   [`../PLAN.md`](../PLAN.md) § *Standing architectural rule*.

**`vector-store` (BL-380 143/200/359) — blast radius MEASURED 2026-08-01: it is trivial.** Value-level
consumers outside the package are **two spec files** (`analysis.spec.ts:23`, `hybrid-search.spec.ts:16`);
`analysis/src/index.ts:6` and `hybrid-search/src/index.ts:15` are type-only re-exports. **`agent-source`
does not exist in this repo** — only `docs/ideas/phase-2-agent-source.md`. Convert the three casts; the
risk that held this back was never real.

> This paragraph previously read *"NOT ready to touch — the `agent-source` blast radius is still
> unmeasured."* That was a hedge from `adapter-integrity.md` ("I have not audited this, verify it")
> relayed as a prohibition, and it held a published package hostage for a day. The grep that
> disproved it takes seconds. Relay uncertainty as uncertainty, or resolve it.

**⚠ Trap, confirmed still present:** `vector-store/src/index.ts:196` reads
`vecEnabled: adapter.capabilities.nativeVectors || true` — unconditionally true. The only use of
the adapter interface in that constructor is dead code that can only crash. **Deleting it turns 15
tests green while fixing nothing.**

---

## 6. Tree hazard — read before touching `memory-server/src/index.ts`

`fc71730` made the dialect a **required** argument. `memory-server/src/index.ts` carries the
matching 3-call-site change, and `queue-perf` was rewriting the same file for BL-382 — its
`schedulePhaseBAndWake` wrapper now absorbs the `vectorDialect` field.

**Whoever edits that file must keep `vectorDialect:` or `memory-core` will not compile against it.**
I committed that file as WIP in `e9aa0cb` after `queue-perf` also hit its limit; it typechecks and
lints, but nobody has run its spec. See that commit message for exactly what is and is not verified.
