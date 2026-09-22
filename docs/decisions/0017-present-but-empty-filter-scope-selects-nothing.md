# ADR-0017 — A present-but-empty scoped filter selects nothing; it is never "no filter"

**Status:** ACCEPTED (2026-09-21).
**Owner:** pseudosky.
**Relates to:** ADR-0006 (DI for live objects), ADR-0010 (open node/edge typing), BL-294
(vector-channel filter parity), BUG-032 (the defect this records), DEBT-011 (vector-store's pure
`{ ids }` contract).

## Context

A filter field that is **present but empty** (`ids: []`, `tags: []`, `kind: []`, a metadata `in: []`)
is a *scope that resolves to zero candidates*. The read path treated it as the opposite: every layer
dropped the empty array as if the field had been absent, so a caller who asked for "these zero rows"
silently received the **whole store**.

The confirmed chain (BUG-032, reproduced from the installed dists):

- `@adhd/sox-graph-store`'s `buildNodeFilterClause` emitted the `rowid IN (…)` clause only when
  `filter.ids.length > 0`; `ids: []` dropped the clause entirely.
- `@adhd/sox-vector-store` dropped `ids` on `length === 0` in `BruteForceBackend.search`,
  `SqliteVectorBackend.iter`, `TursoVectorBackend.knn` (compiling the KNN filter to the tautology
  `1=1`), `TursoVectorBackend.iter`, and the LanceDB worker's `knn`/`iter`.
- `@adhd/sox-hybrid-search` resolved the node join with `graph.queryNodes(nodeFilter)` and skipped
  the vector channel only when `matchingIds.length === 0` — which could never fire, because the
  graph layer had already widened the empty scope back to the full set.

Consumer-visible symptom: `searchRanked({ filters: { kind: 'issue', ids: [] } })` returned the one
issue on a single-issue store instead of **zero**. `ids: [<absent rowid>]` returned zero correctly —
the guard existed, it just never fired for `[]`.

The inverse claim was written into the code as a documented invariant
(`libs/data/search/hybrid-search/package.json` `sox.invariants`, its README, and
`docs/plan/memory-refactor/COMPILED_INTERFACES.md`): *"an empty `VecFilter.ids` means 'no filter' to
the vector backend, not 'match nothing'."* That sentence **is** the defect; this ADR supersedes it.

The class is not hypothetical for any consumer: a filter built by mapping a list of candidate ids
(an authorization scope, a dedupe candidate set, a caller-supplied id allowlist) legitimately
resolves to `[]`, and returning the unfiltered corpus is a **data-exposure** bug, not a cosmetic one.

## Decision

1. **A present-but-empty scoped membership filter means "match nothing".** It must resolve to **zero
   results at every layer** — never be dropped as "no filter". This applies to `NodeFilter.ids`,
   `NodeFilter.kind[]`, `NodeFilter.topic[]`, `NodeFilter.tags[]`, `NodeFilter.confidence[]`,
   `NodeFilter.name[]`, `MetadataFilter.in[]`, and `VecFilter.ids`.

2. **Absent stays unfiltered; non-empty stays exact.** The rule changes only the
   present-but-empty case. Omitting a field still applies no constraint, and a non-empty set still
   selects exactly that set.

3. **Every layer owns its half of the invariant; no layer delegates it downward.**
   `sox-graph-store` compiles a present-but-empty scope to a tautologically-false predicate
   (`0 = 1`). `sox-vector-store` short-circuits to zero candidates in each backend.
   `sox-hybrid-search` returns zero results for a resolved filter that selects nothing, rather than
   relying on the injected graph backend to compile the empty scope correctly. An empty scope that
   only works because a *lower* layer happens to handle it is not an invariant — it is a latent
   regression the moment the backend is swapped (ADR-0006 DI makes that a one-line change).

4. **A present-but-empty membership array must not produce invalid SQL.** Before this ADR, an empty
   array on the `kind`/`topic`/`confidence`/`name` fields emitted `col IN ()`, which SQLite rejects
   with a syntax error. "Match nothing" is both the correct semantics and a strictly safer
   compilation than either the dropped clause or the invalid one.

## Consequences

- **BUG-032** is fixed across `@adhd/sox-graph-store`, `@adhd/sox-vector-store`, and
  `@adhd/sox-hybrid-search`; the regression tests are named for it
  (`libs/data/{graph/graph-store,vectors/vector-store,search/hybrid-search}/src/bug-032-empty-ids-filter.spec.ts`)
  and each carries a red→green pin: `ids: []` returns zero (fails pre-fix), `ids: [<absent>]` stays
  zero, absent ids stays unfiltered, non-empty ids stays exact.
- The stale "empty ids = no filter" wording is removed from the hybrid-search `package.json`
  invariant, its README, and `COMPILED_INTERFACES.md`.
- Any future filter field added to `NodeFilter`/`VecFilter` that is a set-membership scope inherits
  this rule: **present-but-empty ⇒ zero**, and its clause-builder must never drop it on
  `length === 0`.
