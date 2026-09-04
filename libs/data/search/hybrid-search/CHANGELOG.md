# @adhd/sox-hybrid-search

## 0.4.3

### Patch Changes

- 884e3e7: Rewrite the package README against real, executed behaviour.

  These packages published to npm with READMEs that were missing, wrong, or unusable:
  no install line, no runnable example, and in several cases relative links pointing
  outside the package directory — dead for every npm reader, since a tarball carries
  only the package's own directory plus a force-included README and LICENSE.

  Every README now has an install line and at least one example that was actually run
  against the built artifact, with real output. Every documented symbol is verified to
  exist in that package's own declarations.

  Packages built on `@adhd/sox-store-adapter` now state the concurrency properties they
  inherit from it: the default Turso backend mandates `multiprocess-wal`, so multiple
  processes hold concurrent write connections to one store file. The claim is scoped
  per package rather than asserted blanket-wide — packages whose default path is
  single-writer by construction say so.

  Corrections found by reading and running the code rather than trusting the prose:
  `sox-graph-store` described itself as a store "over SQLite" when it has no
  better-sqlite3 dependency and is built on StoreAdapter; `sox-hybrid-search` described
  itself as an unimplemented skeleton when its implementation is complete;
  `sox-embedding-provider` advertised a hash provider that exists in no factory branch;
  and `sox-tokenguard-core` documented `detectFqdn` as returning `<FQDN_1>` when it
  returns `<HOST_1>`.

- Updated dependencies [884e3e7]
- Updated dependencies [884e3e7]
  - @adhd/sox-graph-store@0.9.2
  - @adhd/sox-vector-store@0.6.1
  - @adhd/sox-embedding-provider@0.5.0

## 0.4.2

### Patch Changes

- Republish with workspace: deps rewritten to published ranges (0.4.1 shipped raw workspace:^ — npm cannot resolve it).

## 0.4.1

### Patch Changes

- Republish 0.4.1 with the final dist (deprecated SqliteSearchBackend/SqliteSearchOpts re-exports removed). 0.4.0 shipped a stale build that still carried them.

## 0.4.0

### Minor Changes

- d9a5023: Backlog-v2 library layer: decoupling, uniqueness policy, surface completion, N-signal ranker.

  ## Breaking changes (renames — no deprecated aliases)

  - **graph-store** — `SqliteGraphBackend` → `StoreGraphBackend`.
  - **hybrid-search** — `SqliteSearchBackend` → `StoreSearchBackend`, `SqliteSearchOpts` → `StoreSearchOpts`.

  The `Sqlite*` prefix was a misnomer — these backends are `StoreAdapter`-backed (sqlite _or_ turso), not SQLite-specific. Update import sites; there are no back-compat re-exports.

  - **graph-store** — `NodeUniquenessPolicy` seam (injectable `check(meta, tx)` run inside `writeNode` before the INSERT) replaces the reverted global `(kind,name)` unique index; surface primitives: `transaction`, `invalidateEdge`, `writeEdges`, `getNodesByIds`, `countBy`, edge-metadata filtering, keyset pagination (`NodeFilter.after`); bi-temporal content immutability enforced (supersede is the sole content mutation).
  - **store-adapter** — vector dialect no longer joins the graph `node` table; `topKQuery` is a pure WHERE-predicate seam and each dialect owns its own LIMIT.
  - **vector-store** — `VecFilter` is now pure `{ids}` (the graph-coupled `nodeFilter`/`liveOnly` are removed); `pruneInvalidatedVectors` → `deleteMany`; the graph-store dependency is dropped.
  - **hybrid-search** — N-signal reciprocal-rank fusion (`rrfFuse`, `temporalRescore`, `StoreSearchBackend.searchRanked`) alongside the existing min-max fusion.
  - **semantic** — first publish of the RAG composition facade (ADR-0016); delegates search fusion, no longer vector-only.
  - **memory-core** — `recall` consumes the shared `rrfScore` from hybrid-search (the hand-rolled duplicate is deleted).
  - **analysis** — `await writeEdge` at three call sites (fixes un-awaited writes).

### Patch Changes

- Updated dependencies [d9a5023]
- Updated dependencies
  - @adhd/sox-graph-store@0.9.0
  - @adhd/sox-vector-store@0.6.0
  - @adhd/sox-embedding-provider@0.4.1

## 0.3.9

### Patch Changes

- Updated dependencies
  - @adhd/sox-vector-store@0.5.0

## 0.3.8

### Patch Changes

- Updated dependencies
  - @adhd/sox-graph-store@0.8.5
  - @adhd/sox-embedding-provider@0.4.0
  - @adhd/sox-vector-store@0.4.4

## 0.3.7

### Patch Changes

- Updated dependencies
  - @adhd/sox-graph-store@0.8.3
  - @adhd/sox-vector-store@0.4.3

## 0.3.6

### Patch Changes

- Updated dependencies
- Updated dependencies [659a9d7]
  - @adhd/sox-graph-store@0.8.2
  - @adhd/sox-vector-store@0.4.2

## 0.3.5

### Patch Changes

- Updated dependencies [d0644be]
- Updated dependencies
  - @adhd/sox-embedding-provider@0.3.0
  - @adhd/sox-graph-store@0.7.0
  - @adhd/sox-vector-store@0.4.1

## 0.3.4

### Patch Changes

- Updated dependencies [32275f7]
- Updated dependencies [7f46e96]
- Updated dependencies [7f46e96]
  - @adhd/sox-embedding-provider@0.2.0
  - @adhd/sox-graph-store@0.6.0
  - @adhd/sox-vector-store@0.4.0

## 0.3.3

### Patch Changes

- @adhd/sox-graph-store@0.5.3
- @adhd/sox-vector-store@0.3.3

## 0.3.1

### Patch Changes

- @adhd/sox-graph-store@0.5.1
- @adhd/sox-vector-store@0.3.1

## 0.3.0

### Minor Changes

- 0f63dfe: Filtered-KNN pushdown (additive, backward-compatible):

  - `@adhd/sox-graph-store`: export `buildNodeFilterClause` (and its `FilterClause` return
    type) — previously a private helper used only internally by `queryNodes`/`countNodes`/
    `searchNodes`. No behavior change.
  - `@adhd/sox-vector-store`: `VecFilter` gains an optional `nodeFilter?: NodeFilter` field,
    ANDed with `ids` when both are given. `BruteForceBackend.search` now pushes
    `nodeFilter` down into the candidate-selection SQL via a `JOIN node n ON n.rowid =
v.node_id` + the reused `buildNodeFilterClause`, replacing the two-step
    `queryNodes(...).map(id)` -> `{ids}` workaround (which could exceed
    `SQLITE_LIMIT_VARIABLE_NUMBER` for large matched-id sets). `knn`'s signature is
    unchanged; existing `{ids}`-only and unfiltered callers are unaffected. New dependency
    on `@adhd/sox-graph-store` (no cycle).
  - `@adhd/sox-hybrid-search`: `SqliteSearchBackend`'s vector channel now passes
    `{ nodeFilter }` directly to `knn` instead of resolving matching ids through the graph
    store first — same fix, same BL-294 zero-match invariant, fewer round-trips.

### Patch Changes

- Updated dependencies [0f63dfe]
  - @adhd/sox-graph-store@0.4.0
  - @adhd/sox-vector-store@0.2.0

## 0.2.0

### Minor Changes

- Fixed a namespace/tenant data leak in `SqliteSearchBackend.search()`: the vector (kNN) channel previously ran with no filtering applied at all, so a namespace-scoped (or otherwise filtered) hybrid or vector-only query could return another namespace's nodes fused into the results. The vector channel now resolves the same `NodeFilter` used by the text channel through `graph.queryNodes()` and constrains `vec.knn()` to the matching node-id set; a filter matching zero nodes now correctly yields zero vector candidates instead of silently falling back to unfiltered search (BL-294).

  `SearchBackend.search()` results (and the top-level `search()` function's `SearchResult[]`) gained an additive `degraded?: { unsupportedFilters: string[] }` field, set whenever a caller's `filters` included a key with no mapping onto `NodeFilter` — surfaced unconditionally, not gated behind `explain: true`.

  `buildFilterClause()`'s `project_path`/`agent_id`/`kind` filter keys now route to first-class `NodeFilter` fields instead of being silently dropped into an `extraClauses` value that was never actually applied to either search channel.

### Patch Changes

- Updated dependencies
  - @adhd/sox-graph-store@0.3.0
