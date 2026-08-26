# @adhd/sox-vector-store

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
