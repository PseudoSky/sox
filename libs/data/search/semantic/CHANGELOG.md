# @adhd/sox-semantic

## 0.1.7

### Patch Changes

- @adhd/sox-hybrid-search@0.4.8

## 0.1.6

### Patch Changes

- Updated dependencies [b730340]
  - @adhd/sox-graph-store@0.11.0
  - @adhd/sox-hybrid-search@0.4.7

## 0.1.5

### Patch Changes

- 521b4c9: Make the native chain optional: `@adhd/sox-vector-store` and `@adhd/sox-embedding-provider` become `optionalDependencies`, resolved only on the default capability-probe path.

  `createSemanticBackend` used to reach both packages through **static** value imports, so every consumer loaded `sqlite-vec` / `better-sqlite3` / `lancedb` and the `onnxruntime` / `fastembed` graph at module load — even a caller that injected its own provider and vector backend. Both are now reached through lazy, non-literal dynamic imports taken only when nothing was injected; their types stay type-only imports (erased at emit).

  - The DI-injected path (`embeddingProvider` + `vectorBackend`) resolves **neither** specifier. Loading the module with both injected can no longer throw `ERR_MODULE_NOT_FOUND` for either package.
  - A genuinely absent optional package on a default path returns the typed `not_installed` failure — `createSemanticBackend` still never throws for a configurable failure. `provider_failed` / `unsupported_adapter` / `vector_store_failed` are unchanged.
  - `semanticSearchNodes` also loads `@adhd/sox-hybrid-search` lazily. That is required, not incidental: hybrid-search's entrypoint re-exports `cross-encoder.js`, which statically imports `@adhd/sox-embedding-provider`, so a static hybrid-search import resolved the optional package on **every** path and defeated the invariant above. hybrid-search stays a mandatory dependency; it is simply no longer resolved until a search runs. (Superseded 2026-09-22: `@adhd/sox-hybrid-search` 0.4.9 no longer eagerly imports `@adhd/sox-embedding-provider` — its cross-encoder resolves it lazily on first `createCrossEncoder()` (ADR-0019). The lazy hybrid-search load above is retained and remains correct: it keeps hybrid-search's graph off the injected path until a search runs.)
  - The specifiers are held in variables rather than written as literals, so no bundler can statically hoist them back into an eager import.

  New regression guard `src/optional-loadability.spec.ts` loads the **built artifact** in a child process behind an ESM resolve hook (`module.register()`) that throws on either specifier, runs the injected path under it, and asserts neither was requested. It also asserts the manifest keeps both optional. Verified red against the pre-change build and green after.

  Residual (follow-up, not fixed here): `@adhd/sox-hybrid-search` — a mandatory dependency of this package — still declares both packages as mandatory `dependencies`, so a default install of `@adhd/sox-semantic` still pulls the native chain transitively. Closing that needs the same treatment inside hybrid-search.

## 0.1.4

### Patch Changes

- Updated dependencies [1bc47e2]
  - @adhd/sox-graph-store@0.10.0
  - @adhd/sox-hybrid-search@0.4.5

## 0.1.3

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
  - @adhd/sox-hybrid-search@0.4.3
  - @adhd/sox-vector-store@0.6.1
  - @adhd/sox-embedding-provider@0.5.0
  - @adhd/sox-store-adapter@0.9.0

## 0.1.2

### Patch Changes

- Republish with workspace: deps rewritten to published ranges (0.1.1 shipped raw workspace:^ — npm cannot resolve it).

## 0.1.1

### Patch Changes

- Republish 0.1.1 with the final dist (text+vec RRF delegation in semanticSearchNodes). 0.1.0 shipped a stale build.

## 0.1.0

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
  - @adhd/sox-store-adapter@0.8.0
  - @adhd/sox-vector-store@0.6.0
  - @adhd/sox-hybrid-search@0.4.0
  - @adhd/sox-embedding-provider@0.4.1
