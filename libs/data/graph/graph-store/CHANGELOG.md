# @adhd/sox-graph-store

## 0.5.3

### Patch Changes

- Updated dependencies
  - @adhd/sox-store-adapter@0.2.0

## 0.5.1

### Patch Changes

- @adhd/sox-store-adapter@0.1.1

## 0.4.0

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

## 0.3.0

### Minor Changes

- `writeNode()`'s `kind` parameter is now actually reachable through the public API: `NodeMeta.kind`, `NodeRecord.kind`, and `NodeFilter.kind` are first-class (previously `kind` was hardcoded to `'episode'` on every write, so a caller could never write `kind:'generic'` even though that value already sat in the `node.kind` CHECK constraint's enum). `kind` defaults to `'episode'` and is validated against the fixed `DEFAULT_NODE_KINDS` enum (`episode`/`entity`/`claim`/`community`/`session`/`generic`) — an out-of-enum kind throws `ConstraintError`. The CHECK constraint itself is never extended per consumer; non-memory reuse (e.g. a component registry) writes `kind:'generic'` and carries its own sub-kind in `tags`/`metadata` (BL-295). `NodeFilter` also gained `projectPath`/`agentId` for filtering on those previously-unfilterable indexed columns.
