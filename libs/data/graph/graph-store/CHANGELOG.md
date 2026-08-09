# @adhd/sox-graph-store

## 0.7.0

### Minor Changes

- Add `NodeFilter.tUpdatedAfter` / `tUpdatedBefore` range predicates (over the `t_updated` column), `searchNodes` `offset` parameter (pushed into FTS LIMIT/OFFSET), and `countNodesFts(query, filter?)` for counting FTS matches. All additive — existing callers and signatures are unaffected.

### Patch Changes

- Updated dependencies [62c72a9]
- Updated dependencies [0a588bf]
  - @adhd/sox-store-adapter@0.4.0

## 0.6.0

### Minor Changes

- 7f46e96: Breaking: `EdgeRel` widened to accept arbitrary strings; the SQL `rel` CHECK constraint is gone
  from fresh-store DDL.

  `dist/index.d.ts`'s `EdgeRel` declaration (BL-448/PKT-74) changed from a closed 10-member union to
  a branded-string widening:

  ```
  -export type EdgeRel = 'MENTIONS' | 'SUPPORTS' | 'RELATES_TO' | 'DERIVED_FROM' | 'SUPERSEDES' | 'SAME_AS' | 'ASSIGNED_TO' | 'MEMBER_OF' | 'PART_OF' | 'DEPENDS_ON';
  +export type EdgeRel = 'MENTIONS' | 'SUPPORTS' | 'RELATES_TO' | 'DERIVED_FROM' | 'SUPERSEDES' | 'SAME_AS' | 'ASSIGNED_TO' | 'MEMBER_OF' | 'PART_OF' | 'DEPENDS_ON' | (string & {});
  ```

  The package's own in-tree JSDoc directly above this declaration states this is "source-breaking
  in RETURN position, not additive: a consumer that exhaustively `switch`es on `EdgeRecord.rel` (or
  otherwise narrows `EdgeRel` to `never` in a default arm) stops compiling once this widens, because
  the `default` arm's type is no longer `never` — it is `string & {}`" and cites
  `open-rel-check.bl448.spec.ts`'s `AC-Type` as having demonstrated the compile break, not merely
  asserted it. A consumer exhaustively switching on `EdgeRecord.rel`'s ten known members with a
  `default: assertNever(rel)` idiom will no longer compile against this release.

  Additive, not independently bump-worthy (subsumed by the major above): `GraphBackendOpts` (new
  optional interface, `typePolicy?: TypePolicy`), and both `constructor(adapter: StoreAdapter, opts?:
GraphBackendOpts)` and `createGraphBackend(adapter, opts?)` gaining an optional trailing parameter
  — existing single-argument call sites still compile.

  Not reflected in this bump, named for changelog completeness: the inline SQL
  `CHECK ("rel" IN (...))` / `CHECK ("kind" IN (...))` constraints were dropped from
  `INLINE_MIGRATION_DDL` (BL-439/BL-448's DDL-open work). Fresh stores no longer enforce the closed
  vocabulary at the SQL layer — a `TypePolicy` (see `DEFAULT_TYPE_POLICY`'s new docstring) is the
  sole remaining gate. This is a real behavioral change but is invisible to a `.d.ts` diff:
  `INLINE_MIGRATION_DDL`'s declared type stays `string` before and after (only its literal value
  changed), and the DDL is inline SQL text, not a TS type.

### Patch Changes

- Updated dependencies [32275f7]
  - @adhd/sox-store-adapter@0.3.0

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
