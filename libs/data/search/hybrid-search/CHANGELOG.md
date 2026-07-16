# @adhd/sox-hybrid-search

## 0.2.0

### Minor Changes

- Fixed a namespace/tenant data leak in `SqliteSearchBackend.search()`: the vector (kNN) channel previously ran with no filtering applied at all, so a namespace-scoped (or otherwise filtered) hybrid or vector-only query could return another namespace's nodes fused into the results. The vector channel now resolves the same `NodeFilter` used by the text channel through `graph.queryNodes()` and constrains `vec.knn()` to the matching node-id set; a filter matching zero nodes now correctly yields zero vector candidates instead of silently falling back to unfiltered search (BL-294).

  `SearchBackend.search()` results (and the top-level `search()` function's `SearchResult[]`) gained an additive `degraded?: { unsupportedFilters: string[] }` field, set whenever a caller's `filters` included a key with no mapping onto `NodeFilter` — surfaced unconditionally, not gated behind `explain: true`.

  `buildFilterClause()`'s `project_path`/`agent_id`/`kind` filter keys now route to first-class `NodeFilter` fields instead of being silently dropped into an `extraClauses` value that was never actually applied to either search channel.

### Patch Changes

- Updated dependencies
  - @adhd/sox-graph-store@0.3.0
