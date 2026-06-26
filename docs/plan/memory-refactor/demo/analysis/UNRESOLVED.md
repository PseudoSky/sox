# UNRESOLVED — `@adhd/sox-analysis` Demo

Interfaces this demo had to guess, and scope gaps found while authoring.
Resolve each before treating the corresponding DEMO.md step as authoritative.

## Unresolved interfaces

| ID | Guessed interface | Used in | Basis | What would confirm it |
|---|---|---|---|---|
| U1 | `node` table INSERT columns — `(uid, content, source, importance, t_created, t_valid)` used in `insertItem` helper | §2.4 (db-setup.mjs), all beats that call `insertItem` | Inferred from `neardup.ts` SELECT columns (`uid`, `content`, `t_invalid`); `source` and `importance` columns inferred from batch.ts BatchEnrichResult field `importance_updated` | Read `libs/memory-core/src/` or `@adhd/sox-graph-store` `applyGraphSchema` source to get the authoritative DDL; confirm NOT NULL constraints and defaults |
| U2 | `clusterSubset` second-argument filter shape — guessed as `{ uid_prefix: 'ep-00' }` (a MemoryFilter-like object) | §3.3 (beat 3.3) | `cluster.ts` line 589 declares `clusterSubset(db, filter, opts?)` and imports `type { MemoryFilter } from './filters.js'`; `filters.ts` not read | Read `libs/memory-enrich/src/filters.ts` for the `MemoryFilter` interface fields; adjust the demo's filter object in beat 3.3 accordingly |
| U3 | modelId stored on community nodes in `node.meta` as `$.model_id` — SQL query `json_extract(meta, '$.model_id')` used in §5.4 | §5.4 (resilience beat) | `docs/plan/memory-refactor/contexts/w2d-analysis.md` [w2d-analysis.3] states "similarity-derived outputs record the modelId they were computed under"; ClusterResult struct in `cluster.ts` has no `modelId` field on the return value, so storage must be in the DB community node's metadata | Confirm where `clusterStore` writes the `modelId` — check the community node upsert in `libs/memory-enrich/src/cluster.ts` `materializeClusters` (line 323); confirm the exact column/JSON key used |

## Scope gaps & open questions

- **`dropSubsetLens` and `listSubsetLenses`** — both are listed in REQ-009 / [w2d-analysis.5] and in the exports list of [w2d-analysis.1], but only `clusterSubset` is exercised in §3.3. Full beats for `listSubsetLenses` (list all active subset lenses) and `dropSubsetLens` (remove a lens by provenance hash) are deferred until ⟦U2⟧ is resolved so the filter shape is confirmed and the subset lens round-trip can be shown correctly.
- **`runBatchEnrich` return value — `relates_to_edges` and `topics_backfilled`** — `BatchEnrichResult` in `batch.ts` includes `relates_to_edges` and `topics_backfilled` (read to line 60; file truncated). These fields are not asserted in the climax beat. Once the full `BatchEnrichResult` type is confirmed, add assertions for all stable fields.
- **TypeScript types** — REQ-010 requires bundled `.d.ts`; beat §2.4 confirms the runtime exports resolve but does not formally validate the type declarations. A TypeScript-strict consumer check (`tsc --noEmit` against a `.ts` snippet importing the package) would give a stronger guarantee.
