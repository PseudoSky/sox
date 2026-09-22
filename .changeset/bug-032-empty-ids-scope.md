---
'@adhd/sox-graph-store': patch
'@adhd/sox-vector-store': patch
'@adhd/sox-hybrid-search': patch
---

fix: a present-but-empty scoped filter (`ids: []`, `kind: []`, `tags: []`, metadata `in: []`) now
matches nothing instead of silently degrading into an unfiltered scan (BUG-032 / ADR-0017).

`@adhd/sox-graph-store`'s `buildNodeFilterClause` dropped each set-membership clause when its array
was empty, so `queryNodes({ ids: [] })` returned the whole store. `@adhd/sox-vector-store` did the
same in every backend — `BruteForceBackend.search`, `SqliteVectorBackend.iter`, `TursoVectorBackend`
`knn` (which compiled the empty id filter to the tautology `1=1`) and `iter`, and the LanceDB
worker's `knn`/`iter`. `@adhd/sox-hybrid-search` could not compensate: its `matchingIds.length === 0`
guard never fired because the graph layer had already widened the empty scope back to the full set.

A filter that is present but empty is a scope that resolves to zero candidates, and it must yield
zero results at every layer. Absent ids still applies no constraint; non-empty ids still selects
exactly that set. `sox-hybrid-search` additionally now short-circuits a present-but-empty resolved
`NodeFilter` to zero results itself, rather than depending on the injected graph backend to compile
the empty scope correctly. The stale "an empty `VecFilter.ids` means no filter" wording in the
hybrid-search package invariant, README, and `COMPILED_INTERFACES.md` is corrected.
