# Architecture-fit / genericity review — `memory-enrich/filtered-clustering`

**Reviewer:** architect-reviewer · **Date:** 2026-06-22 · **Branch:** `memory-enrich/filtered-clustering`
**Scope:** architectural-fit / genericity only (correctness is a separate pass). DO-NOT-MODIFY review.

**Requester's question:** *"Did this agent implement the BEST thing for the system, or is there a
more GENERIC version with broader utility?"*

---

## Verdict: **(B) Ship with specified follow-ups.**

The core generalization is **genuinely the right one** and largely well-executed. The engine
unification (one selection path, one clustering core, one materializer) is real, not cosmetic —
verified in code (§2). The "no new tool, opaque tags, provenance-scoped coexistence" decisions are
sound and broadly useful.

But the change is **only half-wired**: the *write* path was made scope-aware while every *read* path
(`communityUidForRowid`, `memory_get_community`, `memory_stats`, `clusterStats`) remained
scope-blind. The moment a subset slice is persisted (`dry_run:false`), it leaks into global recall,
community lookup, and stats with **non-deterministic** results. The provenance model generalizes to
N lenses on the *write* side but the *read*/GC side only ever contemplated "global + nothing." That
is a contract-affecting gap, not a nit. It is the reason this is (B) and not (A).

No materially-more-generic *primitive* was missed (so not (C)) — but the *boundary placement* of one
sub-decision (raw-SQL `restrict`) is the wrong cut, and is cheap to fix now / expensive later.

---

## 1. Is `clusterSubset` + scope-aware `materializeClusters` the right general primitive?

**Mostly yes — and the implementer's own framing ("global is `clusterSubset(∅)`") is the correct
mental model — but the code stops one refactor short of realizing it.**

The decomposition is correct and broadly useful:

- `selectEpisodes(db, restrict?)` — `cluster.ts:417` — selection, parameterized by an optional predicate.
- `computeClusters(db, episodes, opts)` — `cluster.ts:446` — pure clustering core, no writes, salt-parameterized.
- `materializeClusters(db, clusters, opts)` — `cluster.ts:321` — the single writer, scope-parameterized.

This is the right three-stage pipeline (select → compute → materialize) and it *does* generalize to
future lenses (time-windowed, per-agent) for free, because each stage already takes the parameter
that those lenses would vary: `restrict` (a WHERE fragment), `salt` (UID namespace), and
`scope/provenanceHash` (invalidation domain). A time-windowed lens is just
`restrict = {sql: " AND n.t_created BETWEEN ? AND ?", ...}` with a different filter object. **The
primitive is correctly shaped for "global as the degenerate case."**

Where it stops short: the public surface still has **two** entry points — `clusterStore` (global) and
`clusterSubset` (filtered) — that are *near-identical wrappers* over the same core
(`cluster.ts:523-540` vs `cluster.ts:584-616`). `clusterStore` is `clusterSubset` with
`restrict=∅, persist=true, scope='global', salt=''`. The implementer asserts "global is now
`clusterSubset(∅)`" in the PHASE-0 rationale, but **the code does not actually route `clusterStore`
through `clusterSubset`** — they are two parallel functions that happen to call the same three
internals. That is the *shared-core* version of the claim, which is fine and DRY at the
internals level, but it is not the *single-parameterized-query-surface* version. See §2 for whether
that matters.

**Could a cleaner single primitive exist?** Yes, and it would be marginally better:

```ts
clusterPass(db, {
  lens: { kind: 'global' } | { kind: 'subset', restrict, filter },
  threshold?, nodeCap?, persist?,   // persist defaults true for global, false for subset
}): ClusterPassResult
```

…with `clusterStore`/`clusterSubset` kept as thin back-compat shims. This would make the "global is
the degenerate lens" claim true *at the surface*, not just the internals, and would mean a future
fifth read path can't forget one of the two functions. **ROI: low.** The current shared-internals
form already captures ~90% of the value (DRY persistence, DRY selection, DRY clustering). I would
**not** block on collapsing the two wrappers. Note it as a "if you touch this again" cleanup.

---

## 2. Did they truly unify, or only appear to?

**The claim holds for selection + clustering + materialization. It does NOT hold for the read /
provenance-resolution side, which is the part that actually breaks coexistence (§5).**

Verified in code — there is **one** of each:

- **One selection path.** Both `clusterStore` (`cluster.ts:527`) and `clusterSubset`
  (`cluster.ts:589`) call `selectEpisodes`. The global call passes no `restrict`; the subset passes
  one. The `LENGTH(n.content) >= 50` and `kind='episode' AND t_invalid IS NULL` invariants live in
  exactly one query (`cluster.ts:421-429`). **No fork.**
- **One clustering core.** Both call `computeClusters` (`cluster.ts:528`, `cluster.ts:591`). The
  degenerate-cluster guard, the threshold-retry loop, the vec fetch, and the union-find all exist in
  exactly one place. The only delta is the `salt` argument. **No duplicated logic.**
- **One materializer.** Both persist through `materializeClusters` (`cluster.ts:536`,
  `cluster.ts:600`). The upsert + MEMBER_OF insert exists once. **No fork.** The scope-branch
  (`cluster.ts:334-352`) is a clean parameterization of *which prior nodes to invalidate*, not a
  duplicated write body.

So the **producer** side is genuinely unified. Good.

**But the unification was not carried to the consumer side**, and that is a hidden fork of a
different kind — not duplicated code, but *stale code that silently disagrees with the new model*:

- `communityUidForRowid` (`index.ts:678-688`) resolves an episode's community with
  `... kind='community' AND t_invalid IS NULL ... LIMIT 1` — **no `cluster_scope` filter, no ORDER
  BY.** After a subset persist, an episode that is `MEMBER_OF` both a global and a subset community
  returns *whichever row SQLite yields first*. This feeds `memory_recall.community_uid`
  (`index.ts:884, 947, 1512, 1595`).
- `memory_stats.with_community` (`index.ts:2034-2043`) and `clusterStats` (`cluster.ts:622-657`)
  count **all** live communities with no scope filter, so persisted subset slices inflate
  `cluster_count`, `coverage`, `largest_cluster_size`, and `mean_intra_cluster_sim`.
- `memory_get_community` member/lookup queries (`index.ts:1047, 1056, 1281`) are likewise
  scope-blind.

**Conclusion:** "they truly unified" is **half-true and stated too strongly in PHASE-0.** The
write/compute/select pipeline is unified (verified). The read + provenance-resolution + stats +
GC surfaces were never updated for the new two-axis (global × subset) community space. This is the
single most important architectural gap in the change.

---

## 3. The `restrict: {sql, params}` raw-SQL engine API

**This is the wrong boundary cut. Recommend changing it before merge — highest-ROI item in the
review.** The engine should accept the **structured filter** and own the SQL.

Today: the server builds the WHERE fragment via `buildFiltersClause` (`index.ts:580-662`) and hands
the engine a raw `{sql, params}` over alias `n` (`index.ts:1949`, consumed at `cluster.ts:426`).
Weighing the three axes the brief names:

- **DRY-with-recall (the pro):** real but shallow. The *vocabulary* is shared (`buildFiltersClause`
  is reused), but the **predicate builder lives on the server, not in `@sox/memory-enrich`.** So the
  engine's public contract (`clusterSubset`) is *not* reusable on its own — any other caller of the
  library must reimplement `buildFiltersClause` or reach into the server to get it. That is the
  opposite of "broadly useful": the library's most interesting new capability is **un-callable
  without server-private code.**
- **Injection surface (the con):** `selectEpisodes` interpolates `restrict.sql` directly into the
  query string (`cluster.ts:426`). It is parameterized for *values* (good), but the **SQL fragment
  itself is trusted, free-form text crossing a package boundary.** Today the only producer is
  `buildFiltersClause` (safe), but the contract *invites* any caller to pass arbitrary SQL over
  alias `n`. For a library that is explicitly meant to be domain-agnostic and reusable, exporting
  "give me a WHERE fragment and I'll splice it into my query" is the least safe generic contract
  available. The alias coupling (`n`) is also a leaky abstraction — the caller must know the
  engine's internal table alias.
- **Generic utility (the deciding axis):** a **structured** filter is *more* generic, not less. The
  brief's framing is exactly right. Move `buildFiltersClause` (or its structured input shape) **into
  `@sox/memory-enrich`** so the engine accepts:

  ```ts
  clusterSubset(db, { filter: MemoryFilter, threshold?, persist? })
  // MemoryFilter = { project_path?, topic?, tags?, tags_match_all?, importance_min?, t_created_after?, t_created_before? }
  ```

  Then: (a) the library is self-contained and callable by anyone; (b) the SQL is built in exactly
  one place that the engine owns, eliminating the cross-boundary SQL string; (c) recall and subset
  *share the structured type*, which is a stronger DRY than sharing a stringified fragment; (d) the
  provenance hash can key on the canonical structured filter directly (it already does —
  `cluster.ts:588` hashes `opts.filter`, and the raw `restrict.sql` is redundant once the engine
  owns the builder).

  The server keeps `memory_recall`'s use of the same builder by importing it *from the library*
  instead of defining it locally — net reduction in duplicated filter logic across the two surfaces.

**This is the one place I'd push back hardest.** The current cut makes the headline feature of the
library depend on server-private code and crosses a package boundary with raw SQL. Both are avoidable
with a same-day refactor while the only caller is in-repo. **ROI: high — do it before merge.**

---

## 4. Is a sync read-only synthesis query correctly homed inside a CURATION op?

**Partially. The behavioral overloading of `memory_curate.recluster` is a real clarity cost, but
the cheapest acceptable fix is documentation + response-shape discipline, not a new tool.**

The concern is legitimate. `recluster` now has **two unrelated behaviors keyed on the presence of
`filters`** (`index.ts:1945`):

- `filters` absent → **async, fire-and-forget, mutating** global enqueue (returns `{enqueued}`).
- `filters` present → **synchronous, read-or-write, returns data** subset pass (returns
  `{clusters, provenance_hash, candidate_count, ...}`).

And `dry_run` is **doubly overloaded**: for global it means "don't enqueue"; for subset it means
"don't persist (read-only synthesis)." Two flags, four behaviors, one op. That is a genuine surface
smell — a caller reading the schema cannot predict the return shape without knowing the branch.

*Conceptually*, the read-only subset path (`dry_run:true`) **is** a RECALL/QUERY capability
("cluster this subset and show me the groups, no writes") wearing a curation costume. The persist
path (`dry_run:false`) **is** genuinely curation (it mutates the graph). So the op now spans both
families.

**However**, I do *not* recommend a new tool — the brief's constraint #4 is reasonable and surface
sprawl is a real cost in a 19-tool server. The right resolution:

- **Keep it on `memory_curate`** but make the two behaviors explicit and self-describing, so the
  smell is contained rather than hidden. Two concrete options, in ROI order:
  1. **(low effort, recommended)** Keep the `filters`-presence dispatch but tighten the schema docs
     and **guarantee the response always carries a discriminator** (`scope: 'global'|'subset'` is
     already emitted at `index.ts:1956` — good; document it as the discriminant the caller switches
     on). Ship as-is behaviorally, fix the contract docs (§6).
  2. **(cleaner, optional)** Replace the implicit `filters`-presence branch with an explicit
     sub-mode, e.g. `op:'recluster'` with `mode:'global'|'subset'`, so the dispatch is named rather
     than inferred from which optional field is set. This removes the "presence of an optional field
     silently changes sync/async + return shape" foot-gun. Worth doing if you're already amending
     the contract anyway.

The `dry_run` reuse is acceptable — "don't commit the proposed change" is a coherent meaning in both
branches even if the *thing not committed* differs (an enqueue vs a community slice). I would not add
a separate `persist` flag at the MCP layer; that would fragment the surface more than the overload
costs. **ROI: medium — fix via docs (mandatory) + optional explicit `mode`.**

---

## 5. Does the provenance-scope model generalize to N coexisting lenses?

**On the WRITE side: yes, cleanly. On the READ + GC + lifecycle side: no — it only ever works for
"global + the lens you're currently looking at." This is the core defect.**

Write-side generalization is correct and I verified it: `materializeClusters`'s subset branch keys
invalidation on `json_extract(meta,'$.cluster_scope.hash')` (`cluster.ts:340`), so filter X never
touches filter Y's slice, and the salted UID (`cluster.ts:170`) prevents same-membership collisions.
N filters can coexist as N disjoint slices. The test suite proves the 2-lens case
(`cluster-subset.spec.ts:152-225`). Good.

But three N-lens gaps surface the moment slices are persisted and then *read or aged*:

1. **Read ambiguity (collision in the resolution, not the storage).** `communityUidForRowid`
   (`index.ts:678-688`) does `LIMIT 1` with no scope filter. An episode in both a global community
   and ≥1 subset community returns a **non-deterministic** `community_uid` in `memory_recall`. With
   N persisted lenses over overlapping tag sets, a single episode can be `MEMBER_OF` 1 global + k
   subset communities, and recall reports an arbitrary one. The UIDs *coexist* in storage (good) but
   the **read API has no way to say "which lens do you want?"** — it silently picks one. This is the
   collision the salted-UID design was meant to prevent, reappearing one layer up. **Must fix:**
   `communityUidForRowid` should default to `cluster_scope.kind='global'` (the stable partition) and
   take an optional lens argument; `memory_recall.community_uid` should mean *the global community*
   unless a lens is requested.

2. **Stats pollution.** `clusterStats` (`cluster.ts:622-657`) and `memory_stats.with_community`
   (`index.ts:2034-2043`) count *all* live communities. Persisting subset slices inflates
   `cluster_count`, `coverage`, `largest_cluster_size`, and `mean_intra_cluster_sim` — i.e. the
   health/CI-gate numbers (`memory_stats` is documented as a CI gate in CONTRACTS C2.12) now drift
   upward every time someone runs a filtered persist. **Must fix:** scope these to
   `cluster_scope.kind='global'` (or report global vs subset separately).

3. **No lifecycle / GC for subset slices.** A subset slice is only ever invalidated by **re-running
   the exact same filter** (same provenance hash → `cluster.ts:340`). There is **no path** that:
   - removes a subset slice whose member episodes were later invalidated (the community keeps a live
     MEMBER_OF edge to a now-dead episode set, or goes stale);
   - removes a slice a caller no longer wants (no `op` to drop a lens by hash);
   - bounds the number of accumulating slices.

   Over time a store accumulates orphaned subset communities that nothing reaps. The global pass at
   least fully rebuilds its partition each run; subset slices have **no equivalent re-anchor and no
   reaper.** This is fine for the "ad-hoc synthesis query, occasionally persisted" use the PHASE-0
   doc describes, but it does **not** generalize to "many filters persist slices over time" — which
   is exactly the multi-agent migration scenario that motivated the feature (PHASE-0 lines 13-26).
   **Must fix or explicitly bound:** add a `memory_curate` op to drop a lens by provenance hash, and
   scope-aware GC (invalidate subset communities whose membership no longer matches the live
   subset), OR document persisted subset lenses as ephemeral/best-effort with a known
   accumulation caveat and a manual cleanup path.

**Bottom line for Q5:** the storage/provenance model is N-lens-ready; the **read, stats, and
lifecycle surfaces are global+1-ready at best.** The implementer solved the hard half (coexistent
persistence without clobber) and left the consuming half unbuilt. That asymmetry is the defect that
makes persisting a subset (`dry_run:false`) currently *unsafe to expose* without the read-side
fixes — the read-only path (`dry_run:true`) is fine to ship today.

---

## 6. Contract drift — does this REQUIRE a CONTRACTS.md (MEMAPI) amendment?

**Yes — needed-amendment, not merely a compatible-extension, on three counts. CONTRACTS C2.11 must
be amended before this is "done."**

- **`memory_curate` (C2.11, CONTRACTS.md:996-1069) — AMENDMENT REQUIRED.** The committed schema adds
  `filters` and `threshold` inputs (`index.ts:482-483`) and a wholly new `recluster` output shape
  (`{scope, persisted, provenance_hash, candidate_count, cluster_count, unclustered_count,
  full_pass, clusters[]}`, `index.ts:1953-1967`). C2.11 currently documents `recluster` output as
  only `{op, enqueued}` (CONTRACTS.md:1061-1065) and resolves OQ-3 (CONTRACTS.md:1068-1069) as
  "dry_run returns `{enqueued:false, dry_run:true}`." Both the input enum-adjacent schema and the
  output union are now **materially different**. This is not backward-incompatible for existing
  global callers (absent `filters` → unchanged), so it is an *additive* change — but it is large
  enough that leaving CONTRACTS stale means the canonical surface doc lies about the tool. **Amend
  C2.11**: document the two-mode dispatch, the dual `dry_run` meaning, the new subset output
  interface, and supersede/extend OQ-3.

- **`memory_get_community` (C2.6, CONTRACTS.md:771-829) — AMENDMENT REQUIRED (semantic).** The
  contract describes a single community space. With persisted subset slices, "the community for this
  episode" is now ambiguous (§5.1). Even if the code is fixed to default to global, the contract
  must **state** that subset communities exist, that this tool returns global-scoped communities by
  default, and (if added) how to request a lens. Without this, a consumer cannot reason about why an
  episode's `community_uid` from recall may not match what `memory_get_community` returns.

- **`memory_recall` (C2.2) `community_uid` field — AMENDMENT REQUIRED (semantic, same root as
  above).** The field's meaning changes from "the episode's community" to "the episode's *global*
  community (one of possibly several lenses)." That semantic narrowing must be documented or the
  field becomes non-deterministic per §5.1.

- **`memory_stats` (C2.12) — AMENDMENT RECOMMENDED.** If the stats queries are scoped to global per
  §5.2, document that the cluster metrics describe the global partition only. If they are *not*
  scoped, the contract's CI-gate guarantee is silently violated. Either way the contract should say
  which.

- **`@sox/memory-enrich` library surface (MEMAPI engine side).** New exports `clusterSubset`,
  `materializeClusters`, `ClusterSubsetOptions/Result`, `MaterializeOptions` (`index.ts:47-55`).
  These are new public API and should be recorded wherever the engine's exported surface is
  contracted. If §3 is taken (engine accepts structured filter), the `restrict` shape disappears from
  the public contract entirely — another reason to settle §3 before writing the amendment.

---

## Ranked recommendations (by ROI)

| # | Recommendation | Severity | Effort | When |
|---|---|---|---|---|
| 1 | **Scope the read paths.** Default `communityUidForRowid`, `memory_get_community`, `memory_stats.with_community`, and `clusterStats` to `cluster_scope.kind='global'`; add optional lens selection. Without this, persisting a subset corrupts global recall + stats (§2, §5.1, §5.2). | **High / blocking for the `persist` path** | M | before exposing `dry_run:false` |
| 2 | **Move the filter builder into `@sox/memory-enrich`; engine takes the structured filter, not raw `{sql,params}`.** Makes the library self-contained, removes cross-boundary SQL, strengthens DRY-with-recall (§3). | **High** | M | before merge (only caller is in-repo now) |
| 3 | **Amend CONTRACTS C2.11 / C2.6 / C2.2 / C2.12** for the new `recluster` modes, output shape, and the global-vs-subset community semantics (§6). | **High** | S | before "done" |
| 4 | **Add subset-lens lifecycle:** a `memory_curate` op to drop a lens by provenance hash + scope-aware GC for slices whose subset membership went stale — OR document persisted lenses as ephemeral with a manual cleanup path and accumulation caveat (§5.3). | **Medium** | M | this phase if `dry_run:false` ships; else backlog with explicit caveat |
| 5 | **Make the `recluster` dispatch explicit** via `mode:'global'\|'subset'` instead of inferring from `filters` presence; rely on the already-emitted `scope` discriminator in responses (§4). | **Low / clarity** | S | optional, fold into #3 |
| 6 | **Collapse `clusterStore` into a thin shim over a single `clusterPass`/`clusterSubset`** so "global is the degenerate lens" is true at the surface, not just the internals (§1). | **Low / cleanup** | S | "if you touch this again" |

---

## What the implementer got right (so this isn't read as a teardown)

- The **select → compute → materialize** decomposition is the correct general primitive and is real,
  not cosmetic (§2). The "global is `clusterSubset(∅)`" instinct is the right one.
- **Domain-agnostic engine** (opaque tags, no `lesson`/`reflection` leakage) is correctly held —
  verified: `cluster.ts` and the subset branch carry zero claude-agent vocabulary.
- **Salted UIDs + `cluster_scope` provenance** is a clean, correct *storage* model for coexistence,
  with back-compat preserved byte-for-byte for empty salt (`cluster.ts:170-173`) — a nice touch.
- **`persist` defaults false** (read-only by default) is the right safety posture for a synthesis
  query.
- **No new tool** is a defensible call given the 19-tool surface; the overload is fixable with docs
  rather than sprawl.
- Test coverage of the *write-side* coexistence guarantees is genuinely good
  (`cluster-subset.spec.ts` proves scoped invalidation, no-collision, idempotence, and
  global-survives-subset).

The gap is consistent and explainable: **the producer side was generalized thoroughly; the consumer
side was not generalized at all.** Close that asymmetry (items 1–4) and this becomes an (A).
