# @adhd/sox-vector-store

## 0.7.1

### Patch Changes

- b352914: fix(vector-store): validate the `knn` query dimension, parity with `upsert`

  `upsert()`/`upsertVectors()` have always rejected a vector whose length ≠ `space.dim` with
  `SpaceInvariantError` before any I/O. `knn()` did not — a wrong-dimension query vector reached the
  driver and surfaced an untyped error (Turso: a `StorageError` wrapping a raw SQL error; LanceDB: a
  raw `GenericFailure` from the worker RPC), and on `SqliteVectorBackend` it silently returned
  NaN/garbage scores from the brute-force cosine loop. That is an ADR-0012 violation — a raw driver
  exception reaching a caller is a bug.

  All three backends now check `query.length === space.dim` before issuing a query and reject with
  `SpaceInvariantError`, exactly as the write path does. The error gains an optional `source`
  discriminant (`'upsert'` — the default, preserving the original 3-arg contract — or `'knn'`) and a
  `SpaceInvariantError.forQuery(space, actualDim)` factory; on the `'knn'` path `nodeId` is the new
  exported `QUERY_VECTOR_NODE_ID` sentinel (`-1`), because a query vector has no owning node.

  Red→green tests ship per backend (`vector-store.spec.ts`, `turso.spec.ts`, `lancedb.spec.ts`), each
  asserting the typed error, its `source`, and its `nodeId`; a reverse-applied negative control
  confirmed all three go red without the check.

## 0.7.0

### Minor Changes

- feat(vector-store): add a bounded `hasVectors` existence probe

  A "does this space hold any vectors?" readiness check had no cheap surface:
  `iter()` is a full corpus scan and is not lazy on every backend —
  `TursoVectorBackend.iter` is backed by the adapter's `executeAll` (`db.all`),
  which materializes every row _including the full embedding BLOB_ before its
  first yield. Returning after the first yielded row therefore reads the entire
  vector table.

  Every backend now exposes `hasVectors(modelId)`:

  - `SqliteVectorBackend` / `LanceDbVectorBackend`: `hasVectors(modelId): boolean`
  - `TursoVectorBackend`: `hasVectors(modelId): Promise<boolean>`

  It is a bounded `SELECT 1 … LIMIT 1` probe — no `embedding` column is
  projected (so no blob is read) and the scan stops at the first row, making it
  O(1) in the size of the space. An absent table (a space never `ensureSpace`d)
  is `false`, not an error.

  ```ts
  // sync backends
  backend.hasVectors("bge-base-en-v1.5"); // boolean

  // async backend (the one a multiprocess store uses)
  await backend.hasVectors("bge-base-en-v1.5"); // Promise<boolean>
  ```

  The primitive is exposed on each concrete backend and on two new additive
  capability interfaces, `VectorExistenceProbe` (sync) and
  `AsyncVectorExistenceProbe` (async) — deliberately **not** on the pinned
  `VectorBackend` / `AsyncVectorBackend` contracts, so a caller narrows to it
  (`typeof backend.hasVectors === 'function'`) rather than every implementor
  being forced to grow the method.

  Additive and source-compatible: no existing exported type or method signature
  changes meaning.

## 0.6.2

### Patch Changes

- 14b917e: fix: a present-but-empty scoped filter (`ids: []`, `kind: []`, `tags: []`, metadata `in: []`) now
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

## 0.6.1

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
  - @adhd/sox-store-adapter@0.9.0

## 0.6.0

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
  - @adhd/sox-store-adapter@0.8.0

## 0.5.0

### Minor Changes

- Add `TursoVectorBackend` — an async, in-process vector backend for Turso-backed stores.

  The existing `VectorBackend` is synchronous and sqlite-vec-only; `SqliteVectorBackend` throws when handed an adapter with `capabilities.nativeVectors` (i.e. Turso), which is `@adhd/sox-store-adapter`'s default substrate. This adds the missing path without touching the pinned sync interface.

  New exports: `AsyncVectorBackend`, `TursoVectorBackend`, `openTursoVectorStore(adapter, { dim, modelId })`. `NodeFilter` is pushed into the candidate query (before the limit, never a post-filter).

## 0.4.5

### Patch Changes

- Updated dependencies
  - @adhd/sox-store-adapter@0.7.0
  - @adhd/sox-graph-store@0.8.6

## 0.4.4

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @adhd/sox-graph-store@0.8.5
  - @adhd/sox-store-adapter@0.6.0

## 0.4.3

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @adhd/sox-graph-store@0.8.3
  - @adhd/sox-store-adapter@0.5.3

## 0.4.2

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies [659a9d7]
  - @adhd/sox-store-adapter@0.5.2
  - @adhd/sox-graph-store@0.8.2

## 0.4.1

### Patch Changes

- Updated dependencies [62c72a9]
- Updated dependencies [0a588bf]
- Updated dependencies
  - @adhd/sox-store-adapter@0.4.0
  - @adhd/sox-graph-store@0.7.0

## 0.4.0

### Minor Changes

- 7f46e96: Breaking: `LanceDbVectorBackend` and `openLanceDbVectorStore` now require a `StoreAdapter`, not a
  raw `better-sqlite3` handle.

  BL-389 ("route `LanceDbVectorBackend` through `StoreAdapter`, not a raw sqlite handle") renamed a
  required constructor-config property in `dist/lancedb.d.ts`:

  ```
  -import type Database from 'better-sqlite3';
  +import type { StoreAdapter } from '@adhd/sox-store-adapter';
  ...
       constructor(config: LanceDbVectorBackendConfig & {
  -        db: Database.Database;
  +        adapter: StoreAdapter;
       });
  ```

  `dist/index.d.ts`'s `openLanceDbVectorStore` factory carries the identical rename in its config
  parameter:

  ```
   export declare function openLanceDbVectorStore(config: LanceDbVectorBackendConfig & {
  -    db: import('better-sqlite3').Database;
  +    adapter: StoreAdapter;
   }): LanceDbVectorBackend & VectorBackend;
  ```

  Both `db` and `adapter` are required (neither carries `?`). Code compiled against the published
  `0.3.3` shape — `new LanceDbVectorBackend({ lancedbPath, db: myDb })` or
  `openLanceDbVectorStore({ lancedbPath, db: myDb })` — fails to compile against this release on two
  independent counts: `db` is now an excess/unknown property, and `adapter` is a missing required
  property.

  **Migration:** pass `adapter: StoreAdapter` instead of a raw `better-sqlite3` handle — construct
  the adapter the same way `@adhd/sox-store-adapter`'s own consumers already do, then pass that
  adapter into `LanceDbVectorBackend`'s constructor or `openLanceDbVectorStore`'s config in place of
  the old `db` field.

### Patch Changes

- Updated dependencies [7f46e96]
- Updated dependencies [32275f7]
  - @adhd/sox-graph-store@0.6.0
  - @adhd/sox-store-adapter@0.3.0

## 0.3.3

### Patch Changes

- Updated dependencies
  - @adhd/sox-store-adapter@0.2.0
  - @adhd/sox-graph-store@0.5.3

## 0.3.1

### Patch Changes

- @adhd/sox-store-adapter@0.1.1
- @adhd/sox-graph-store@0.5.1

## 0.2.0

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
