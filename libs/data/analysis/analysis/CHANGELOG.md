# @adhd/sox-analysis

## 0.1.11

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
  - @adhd/sox-graph-store@0.9.2
  - @adhd/sox-vector-store@0.6.1

## 0.1.10

### Patch Changes

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

- Updated dependencies [d9a5023]
  - @adhd/sox-graph-store@0.9.0
  - @adhd/sox-vector-store@0.6.0

## 0.1.9

### Patch Changes

- Updated dependencies
  - @adhd/sox-vector-store@0.5.0

## 0.1.8

### Patch Changes

- Updated dependencies
  - @adhd/sox-graph-store@0.8.3
  - @adhd/sox-vector-store@0.4.3

## 0.1.7

### Patch Changes

- Updated dependencies
- Updated dependencies [659a9d7]
  - @adhd/sox-graph-store@0.8.2
  - @adhd/sox-vector-store@0.4.2

## 0.1.6

### Patch Changes

- Updated dependencies
  - @adhd/sox-graph-store@0.7.0
  - @adhd/sox-vector-store@0.4.1

## 0.1.5

### Patch Changes

- Updated dependencies [7f46e96]
- Updated dependencies [7f46e96]
  - @adhd/sox-graph-store@0.6.0
  - @adhd/sox-vector-store@0.4.0

## 0.1.4

### Patch Changes

- @adhd/sox-graph-store@0.5.3
- @adhd/sox-vector-store@0.3.3

## 0.1.2

### Patch Changes

- @adhd/sox-graph-store@0.5.1
- @adhd/sox-vector-store@0.3.1

## 0.1.1

### Patch Changes

- Updated dependencies [0f63dfe]
  - @adhd/sox-graph-store@0.4.0
  - @adhd/sox-vector-store@0.2.0
