---
title: Filtered clustering for synthesis — Phase 0
status: implemented (on branch `memory-enrich/filtered-clustering`, not yet merged)
date: 2026-06-22
author: workflow-agent-builder (on behalf of the reflection→memory refactor)
commits:
  - dc30ee81c37f66505bb410ca9d3c75cd282f0b82  # feat(memory-enrich): filtered clustering + shared scoped community materializer
  - c003bbc0a6b7bdd107b4f01725f9704ee099e59f  # feat(memory-server): filtered recluster via memory_curate (generic, no new tool)
---

## Why this exists (context)

A separate project (`claude-agents`) is migrating its bespoke
reflection/lesson/note/fix capture system **into this memory system**, so agents
store notes directly as memory nodes (via `memory_*` MCP tools) instead of
shelling out to a custom CLI, and graph-enrichment creates the linkages.

The single biggest "run code / discover linkage" cost in the old system was a
**curator's manual cross-agent semantic clustering pass** — an LLM deciding which
notes across many authors describe the same observation, keyed on a subject
(e.g. a skill). The refactor replaces that pass with an **on-demand query**:

> restrict the node set by a metadata filter (e.g. `kind=lesson`,
> `tags=[skill:plan-state-machine]`), cluster *within that subset* by similarity,
> and return the groups as **synthesis candidates** — optionally persisting the
> revised communities back to the graph.

The memory system already did global clustering (`clusterStore` →
`runBatchEnrich` → `community` nodes + `MEMBER_OF` edges), but had **no
filtered/subset clustering** and **no way for a caller to persist a revised
community set scoped to a subset**. Phase 0 adds exactly that, while keeping the
server domain-agnostic.

## Design constraints (decided with the requester)

1. **DRY persistence.** Persisting subset communities must reuse the *same*
   community-materialization code the global batch pass uses — not a fork.
2. **Coexistence, no clobber.** A filtered recluster must not destroy the global
   community partition (or other filters' communities), and vice-versa.
3. **The server stays generic.** `memory-server` / `@sox/memory-enrich` must carry
   **zero** claude-agent semantics. They know `node`/`episode`/`community`/`tag`/
   `filter` — never `lesson`, `reflection`, `subject:skill`, `curator`. All domain
   meaning lives client-side, in how the caller builds the filter and reads the
   clusters. Tags like `skill:X` are **opaque strings** the engine filters on.
4. **No new MCP tool.** Expose the capability through the existing surface.

## What changed

### 1. `@sox/memory-enrich` — the capability  (commit `dc30ee8`)

`libs/memory-enrich/src/cluster.ts`, `index.ts`, `cluster-subset.spec.ts`.

- **`materializeClusters(db, clusters, opts)`** — *exported*. The single community
  writer, extracted from the former private `persistClusters` (which did an
  unconditional global wipe). Now **scope-aware**:
  - `scope:'global'` (default) — replaces only global-scoped (and legacy
    untagged) communities. Used by `clusterStore`/`runBatchEnrich`.
  - `scope:'subset'` + `provenanceHash` — replaces only communities tagged with
    that provenance hash. Leaves the global partition and every other filter's
    communities intact.
  - Each community records its provenance in `meta.cluster_scope`
    (`{kind:'global'}` or `{kind:'subset', hash, filter}`), which is what scoping
    keys on. An episode may legitimately be `MEMBER_OF` both a global and a
    subset community — different lenses, not duplicates.
- **`clusterSubset(db, opts)`** — *exported, new*. Selects episodes matching an
  additive `restrict` predicate (`{sql, params}` over alias `n`), clusters them
  via the shared core, and (when `persist:true`) writes a provenance-scoped slice
  through `materializeClusters`. Default `persist:false` → a **read-only synthesis
  query** with no side effects. Returns clusters + `provenance_hash` +
  `candidate_count`.
- **Salted community UIDs.** `communityUid(rowids, salt)` — subset communities are
  salted with the filter provenance hash, so a subset community **never collides**
  with a same-membership global community. Empty salt reproduces the historical
  global UID byte-for-byte (back-compat).
- **Shared internals.** `selectEpisodes(db, restrict?)` and `computeClusters(db,
  episodes, opts)` now back *both* `clusterStore` (global) and `clusterSubset`
  (filtered). One selection path, one clustering core, one writer.
- **Determinism.** `filterProvenanceHash` uses a stable (sorted-key) JSON encoding
  so the same filter always hashes the same → re-running a filter idempotently
  replaces its own slice.

### 2. `memory-server` — the generic exposure  (commit `c003bbc`)

`extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`,
`memory-tools.spec.ts`.

- Extended the **existing `memory_curate` `recluster` op** (no new tool) with an
  optional generic `filters` object (same vocabulary as `memory_recall`:
  `project_path`, `topic`, `tags`, `tags_match_all`, `importance_min`,
  `t_created_after/before`) and an optional `threshold`.
- **Reuses the existing `dry_run` flag** for read-vs-persist: with `filters`
  present, `recluster` runs `clusterSubset` synchronously; `dry_run:true` returns
  the communities without writing, `dry_run:false` persists a provenance-scoped
  slice. With **no** `filters`, behaviour is unchanged (global async daemon
  enqueue).
- Reuses `buildFiltersClause` (the same predicate builder `memory_recall` uses) so
  subset selection and recall share one filter vocabulary. Added `rowidsToUids`
  to shape the response.
- The server passes `filters` to the engine as an **opaque predicate**; it has no
  knowledge of tag meanings.

## Why each decision

| Decision | Why |
|---|---|
| Extract `materializeClusters` (exported, scoped) | Constraint 1 (DRY) + 2 (coexistence). One writer, parameterized invalidation. |
| Provenance in `meta.cluster_scope` | Lets a global pass and N filtered passes coexist; scoping keys on it. |
| Salt the subset UID | Prevents a subset community from overwriting a same-membership global community via the `uid` upsert. |
| `persist` defaults false | A synthesis query should be side-effect-free to explore; persistence is an explicit opt-in. |
| Extend `recluster`, no new tool | Constraint 4. `recluster` already owns "trigger a re-cluster pass"; filtered is the same family. Avoids surface sprawl + duplicated db-open/guard/dispatch. |
| Reuse `dry_run` for read/persist | Existing generic flag already means "don't commit". No new concept. |
| Server treats `filters` as opaque | Constraint 3. Keeps the engine domain-agnostic; claude-agent semantics stay client-side. |

## API

```ts
// @sox/memory-enrich
clusterSubset(db, {
  restrict?: { sql: string; params: unknown[] }, // additive WHERE over alias `n`
  filter?: unknown,        // opaque; drives provenance hash + stored in meta
  threshold?: number,
  persist?: boolean,       // default false (read-only)
}): {
  clusters: ClusterResult[];
  persisted: boolean;
  provenance_hash: string;
  candidate_count: number;
  full_pass: boolean;
  unclustered_count: number;
};

materializeClusters(db, clusters, {
  scope?: 'global' | 'subset',     // default 'global'
  provenanceHash?: string,         // required for subset
  filter?: unknown,
}): void;
```

```jsonc
// MCP — read synthesis candidates over a subset (no writes)
{ "tool": "memory_curate", "arguments": {
    "db_path": "~/.memory/memory.db", "op": "recluster",
    "filters": { "tags": ["kind:lesson", "skill:plan-state-machine"], "tags_match_all": true },
    "dry_run": true } }

// MCP — persist the revised communities (provenance-scoped; global partition untouched)
{ "tool": "memory_curate", "arguments": {
    "db_path": "~/.memory/memory.db", "op": "recluster",
    "filters": { "tags": ["kind:lesson", "skill:plan-state-machine"], "tags_match_all": true },
    "dry_run": false } }
```

## Tests

- `libs/memory-enrich/src/cluster-subset.spec.ts` — 9 tests: filtered selection,
  read-only no-writes, deterministic provenance/UIDs, **scoped persist leaves the
  global partition intact**, salted-UID no-collision, idempotent re-persist, and a
  later global re-cluster leaving subset communities intact. (`nx test
  memory-enrich` → 47 pass.)
- `memory-tools.spec.ts` — 4 wiring tests: filtered subset selection +
  read-only-under-dry_run, opaque/non-matching filter → empty subset, stable
  provenance hash, and no-filters → unchanged global enqueue. (`nx test
  memory-server` → 55 pass.)

## Not in this phase / follow-ups

- **Auto-trigger of global `RELATES_TO`/communities.** Hands-off automatic
  enrichment still depends on the memory-enrichment plan repurposing the daemon
  drain to call `runBatchEnrich` (their P3/P6). Phase 0 is on-demand.
- **Chunking** (`memory-system` BL-13) — unrelated; only matters for long
  multi-section notes.
- **Client-side migration** (claude-agents): the reflection→memory write
  convention, corpus import, and consumer repointing are later phases in the
  `claude-agents` repo — out of scope here by design (keeps this repo generic).

## Status

Implemented on branch `memory-enrich/filtered-clustering` in two commits
(`dc30ee8`, `c003bbc`). Not merged to `main` and not synced — awaiting review.
