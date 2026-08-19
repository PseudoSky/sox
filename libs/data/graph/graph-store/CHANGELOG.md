# @adhd/sox-graph-store

## 0.8.6

### Patch Changes

- Updated dependencies
  - @adhd/sox-store-adapter@0.7.0

## 0.8.5

### Patch Changes

- **graph-store**: `engineIdentity` and `supportsRecursiveCte` now resolve correctly under the adapter's lazy-connect (BL-580/BL-581) — both previously snapshotted at construction, so `engineIdentity` cached `null` permanently and `supportsRecursiveCte` read a value captured before any connection existed. Backup residue is now reclaimed with a bounded sweep. A semicolon inside a SQL comment was being split into a phantom statement. Indexed the predicate the hot queries actually use, across all three DDL surfaces — a 11.9s delete became 15ms.

  **embedding-provider**: fastembed child pooling is concurrency-adaptive with abort plumbing (BL-575/576), breaking embed head-of-line blocking. The pool's grow trigger now has a real time dimension rather than firing on instantaneous depth, and auto-sizing accounts for macOS reclaimable memory — `os.freemem()` excludes inactive/speculative/purgeable pages, so the pool previously sized itself against a number far below the memory actually available.

  **blob-store**: internal workspace dependency ranges float (`workspace:^`) so published consumers are not pinned to an exact internal version.

- Updated dependencies
- Updated dependencies
  - @adhd/sox-telemetry@0.2.1
  - @adhd/sox-store-adapter@0.6.0

## 0.8.4

### Patch Changes

- **BUG-017 (call site B) + BL-563: `dropFts5ResidueBeforeRebuild` defers under live peers and
  never drops on a readonly connection.**

  The FTS5-residue drop opens the store through store-adapter's classic-engine escape hatch — the
  proven BUG-014 poisoner when a live turso multiprocess peer holds the store (writable
  better-sqlite3 open+close checkpoints/deletes the WAL the engine needs). Now the drop is
  deferred (logged `graph_store.heal.fts5_residue_drop_deferred_live_peers`, rebuild proceeds
  without it — the pre-BL-506 degradation, which is safe) whenever `storeQuiescence` reports live
  peers, via the adapter's typed `RepairDeclinedLivePeersError`; the unguarded foreign-adapter
  fallback is deleted. On `readonly: true` connections the drop never runs at all (BL-563).
  Requires `@adhd/sox-store-adapter@^0.5.8`.

## 0.8.3

### Patch Changes

- **FK-heal drops fts5 residue before rebuild — fixes the catalog-abort class (BL-506/507/508).**

  `ensureCheckConstraints`' self-heal rebuilds `edge` via ALTER-RENAME when it detects the
  legacy explicit-rowid FK form (`REFERENCES node(rowid)`) or a missing `'DEPENDS_ON'` CHECK.
  On a store carrying Drizzle-era fts5 residue (`fts_node` VIRTUAL TABLE + shadow tables +
  triggers — the 2026-07-11 `0000_sad_onslaught.sql` shape), the rebuilt `edge` sqlite_master
  row lands AFTER the residue rows; the Turso engine's catalog build aborts silently at the
  first unparseable row (no fts5 module), so `edge` + all indexes never register on the next
  open: `no such table: edge` — the store ends up WORSE than the FK defect it healed (proven
  on the live backlog store 2026-08-11).

  Fix: before any rebuild, `dropFts5ResidueBeforeRebuild()` detects the dead fts5 stack via
  `FTSDialect.legacyResidueNames` and deletes the rows through store-adapter's shared
  `deleteSchemaRowsViaBetterSqlite3` escape hatch under `withConnectionClosedForRepair`
  (close → drop → reopen on the same instance — cross-engine WAL coordination forbids a
  concurrent better-sqlite3 write, BL-508). Name-based delete also removes duplicate
  `fts_node_ai` triggers (BL-507). Turso-only; sqlite stores keep residue (their engine parses
  it). A failed presence probe skips the drop; a failed drop logs loudly and the reopen still
  runs — the heal can never be worse than before.

  New specs: `fk-heal-fts-residue.bl506.spec.ts` (RED→GREEN: healed store opens via the Turso
  driver with edge readable + all 16 indexes registered + zero fts5 residue; sqlite arm pins
  residue preservation) and `schema-row-delete.bl506.spec.ts`.

- Updated dependencies
  - @adhd/sox-store-adapter@0.5.3

## 0.8.2

### Patch Changes

- Fix Turso explicit-rowid FK self-heal (BL-507) + engine-identity guard (BL-508).

  - **FK mismatch (production outage):** live Drizzle-era edge DDL `REFERENCES node(rowid)` fails on Turso with `foreign_keys=ON`. `hasExplicitRowidForeignKey` (index.ts:1012) detects the form; `ensureCheckConstraints` (index.ts:1137-1148) rebuilds the edge constraint gated on turso — stock SQLite resolves the form and stays byte-identical (BL-448 AC-3).
  - **Engine guard (BL-508):** `engineIdentity` getter (lazy per-adapter); guard fails closed on a sqlite marker for a turso adapter; eager touch in `createGraphBackend` — a mismatched-engine open is refused at construction rather than corrupting the store.
  - `createGraphBackend` guard inherits the store-adapter engine marker machinery (`application_id` / `_sox_engine`).

- 659a9d7: Fix `getSupersessionChain` iterative head-selection divergence on multi-root components (reviewer finding, 0.8.1 patch).

  The recursive `head` CTE is `LIMIT 1` over the connected scan, which SQLite produces in BFS discovery order from the seed — the FIRST no-outbound node in that order. The iterative fallback selected the LOWEST-ROWID no-outbound node instead. On a component with two roots — chain v1←v2←v3 plus `writeEdge(v2, v9, 'SUPERSEDES')` — `getSupersessionChain(v9)` returned `[v1, v2, v3]` on the iterative path (Turso Database Rust < 0.8.0, `capabilities.recursiveCte: false`) versus `[v9, v2, v3]` on the recursive SQL path.

  - `getSupersessionChainIterative` now discovers `connected` FIFO (BFS), expanding the incoming arm (`e.dst = current`) before the outgoing arm (`e.src = current`) to mirror the CTE's two UNION arms, and selects the head as the first no-outbound node in that discovery order (Set insertion order) instead of rowid-sorting.
  - New two-root parity test (v9 case) on both real paths (sqlite recursive SQL + turso iterative fallback) and a forced-fallback variant on sqlite — asserting the same set AND order (`[v9, v2, v3]`) on both paths. Red→green proven: both iterative tests failed with `[v1, v2, v3]` before the fix and pass after.
  - The now-refuted "SQLite scans connected in rowid order" comment (and the stale `lowest-rowid` test name) updated to describe BFS-scan-order semantics.

- Updated dependencies
  - @adhd/sox-store-adapter@0.5.2

## 0.8.1

### Patch Changes

- Fix `getSupersessionChain` iterative head-selection divergence on multi-root
  components. The recursive `head` CTE (`LIMIT 1` over the connected scan)
  picks the FIRST no-outbound node in BFS discovery order from the seed; the
  iterative fallback picked the LOWEST-ROWID no-outbound node. On a component
  with two roots (e.g. chain v1←v2←v3 plus `writeEdge(v2, v9, 'SUPERSEDES')`),
  `getSupersessionChain(v9)` returned `[v1, v2, v3]` on the iterative path
  (Turso Database Rust < 0.8.0) versus `[v9, v2, v3]` on the recursive SQL
  path. The fallback now discovers `connected` FIFO (BFS, incoming arm before
  outgoing arm — mirroring the CTE's UNION arm order) and selects the head as
  the first no-outbound node in that discovery order, matching the recursive
  scan on both linear chains and multi-root components. Pinned by a two-root
  parity test on both real paths (sqlite + turso) and a forced-fallback test.

## 0.8.0

### Minor Changes

- Iterative fallbacks for the five recursive-graph methods + A2 FTS delegation + two capability bugs.

  ## Recursive-CTE iterative fallback (SOXGRAPH-001)

  `WITH RECURSIVE` is rejected at prepare by Turso Database Rust < 0.8.0, so the
  five methods that used it now switch per-call to iterative BFS fallbacks when
  the adapter reports `capabilities.recursiveCte: false` (SQLite and Turso

  > = 0.8.0 keep the byte-identical recursive SQL):

  - `getSupersessionChain` — connected-set BFS, lowest-rowid no-outbound head,
    level-tracked chain walk, (depth, rowid) sort. Same oldest-first ordering on
    linear chains ([v1, v2, v3] pinned by tests).
  - `getNeighborsRecursive` (depth >= 2) — budgeted BFS. Empirically, the
    recursive `LIMIT depth*100` is a TOTAL row budget INCLUDING the seed row
    (not per-step), and the walk is depth-UNBOUNDED — the iterative counter
    mirrors exactly (verified: budget 200 over a 15×15 fan-out → 199 live
    neighbors on both paths).
  - `isReachable` — unbounded BFS with early exit, no node-liveness filter.
  - `getSubgraph` — level-by-level BFS; `maxDepth >= 0` stops at depth ===
    maxDepth, `-1` unbounded; edges via the same non-recursive query as the
    recursive path; no node-liveness filter (invalidated node behind a live edge
    is part of the subgraph — pinned).
  - `getNeighborsWithEdges` inherits the fallback through `getNeighbors`.

  ## A2 delegation (FEAT-SOXGRAPH-001)

  - `searchNodes` / `countNodesFts` delegate to `adapter.ftsSearch` /
    `adapter.ftsCount` — the adapter owns the per-backend SQL, the BL-367
    `"tok1" OR "tok2"` normalization, and the empty-query guards. The A1
    `buildFtsSearchSql` shape is deleted (AC-6: zero `MATCH`/`fts_match`/
    `fts_score`/`.rank` hits remain in graph-store source).
  - `applyFtsSchema` delegates to `adapter.ensureFtsIndex('node',
['content','name','summary'], { weights, sqliteDDL: [FTS_DDL, FTS_TRIGGERS],
backfill: true })` — the adapter owns BL-461 index adoption, per-dialect DDL,
    and residue cleanup. `reapplyFtsInTx` is unchanged.

  ## Bugs

  - **BUG-SOXGRAPH-001:** `capabilities.fullTextSearch` now derives from
    `adapter.capabilities.fts` instead of being hardcoded `true` — an fts:false
    adapter no longer advertises an FTS surface that would throw.
  - **BUG-SOXGRAPH-002:** `PRAGMA busy_timeout = 5000` removed from graph-store's
    PRAGMAS. The write-contention contract is adapter-owned: `SqliteAdapter`
    sets `busy_timeout = 3000` at connect; Turso no-ops unknown PRAGMAs and the
    driver default applies. A graph-store-level busy_timeout split the knob
    between two owners and clobbered the adapter's value on every applySchema.

### Patch Changes

- Updated dependencies
  - @adhd/sox-store-adapter@0.5.0

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
