---
"@adhd/sox-graph-store": minor
"@adhd/sox-store-adapter": minor
"@adhd/sox-vector-store": minor
"@adhd/sox-hybrid-search": minor
"@adhd/sox-semantic": minor
"@adhd/sox-memory-core": patch
"@adhd/sox-analysis": patch
---

Backlog-v2 library layer: decoupling, uniqueness policy, surface completion, N-signal ranker.

## Breaking changes (renames — no deprecated aliases)

- **graph-store** — `SqliteGraphBackend` → `StoreGraphBackend`.
- **hybrid-search** — `SqliteSearchBackend` → `StoreSearchBackend`, `SqliteSearchOpts` → `StoreSearchOpts`.

The `Sqlite*` prefix was a misnomer — these backends are `StoreAdapter`-backed (sqlite *or* turso), not SQLite-specific. Update import sites; there are no back-compat re-exports.

- **graph-store** — `NodeUniquenessPolicy` seam (injectable `check(meta, tx)` run inside `writeNode` before the INSERT) replaces the reverted global `(kind,name)` unique index; surface primitives: `transaction`, `invalidateEdge`, `writeEdges`, `getNodesByIds`, `countBy`, edge-metadata filtering, keyset pagination (`NodeFilter.after`); bi-temporal content immutability enforced (supersede is the sole content mutation).
- **store-adapter** — vector dialect no longer joins the graph `node` table; `topKQuery` is a pure WHERE-predicate seam and each dialect owns its own LIMIT.
- **vector-store** — `VecFilter` is now pure `{ids}` (the graph-coupled `nodeFilter`/`liveOnly` are removed); `pruneInvalidatedVectors` → `deleteMany`; the graph-store dependency is dropped.
- **hybrid-search** — N-signal reciprocal-rank fusion (`rrfFuse`, `temporalRescore`, `StoreSearchBackend.searchRanked`) alongside the existing min-max fusion.
- **semantic** — first publish of the RAG composition facade (ADR-0016); delegates search fusion, no longer vector-only.
- **memory-core** — `recall` consumes the shared `rrfScore` from hybrid-search (the hand-rolled duplicate is deleted).
- **analysis** — `await writeEdge` at three call sites (fixes un-awaited writes).
