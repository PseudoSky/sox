# @adhd/sox-graph-store

Bi-temporal graph store — nodes + edges over SQLite with t_valid/t_invalid correctness, tExpires TTL, content-hash dedup, FTS5 sync, namespace isolation, and supersession chains. Uses drizzle-orm + drizzle-kit for schema migration. GraphBackendCapabilities flags prevent silent misuse of bitemporal / FTS / metadata-filter features.

- **area:** data · **group:** graph · **publish:** PUBLIC (`private: false`, publish owner-gated)
- **engines:** Node >=22
- **concerns:** schema migration via drizzle-orm + drizzle-kit (generated offline, applied idempotently at runtime), bi-temporal nodes (t_valid / t_invalid) + tExpires TTL + isStale derived field, namespace isolation (NodeMeta.namespace — hard graph partition, default: "global"), content-hash dedup (writeGraph / writeNodeBatch atomic transactions), FTS5 sync triggers (searchNodes scored by mechanism-agnostic score field), supersession chains (supersede / touch / getSupersessionChain), edge upsert idempotency (writeEdge — safe for re-projection), graph traversal (getNeighbors / getNeighborsWithEdges / isReachable / getSubgraph), GraphBackendCapabilities (bitemporal / fullTextSearch / metadataFilter flags), confidence as first-class epistemic field (distinct from importance ranking weight), DEPENDS_ON edge rel for typed dependency graphs (plan DAGs, tool dep trees)

## Invariants

- records are NEVER deleted — invalidate() sets t_invalid (audit-preserving), supersede() mints a new node linked by SUPERSEDES
- touch() updates mutable metadata (tExpires, confidence, name, tags) without minting a new node or SUPERSEDES edge — THROWS if nodeId is invalidated or missing
- writeEdge() is upsert-idempotent on (src, dst, rel) — safe to call on re-projection
- writeGraph() / writeNodeBatch() are atomic (single SQLite transaction) — all or nothing
- searchNodes() returns [] (not an error) when capabilities.fullTextSearch === false
- NodeFilter.validAt is honored only when capabilities.bitemporal === true, ignored silently otherwise
- namespace is a hard isolation field (not a tag/filter convention) — absent → "global"

## Interface spec

See [COMPILED_INTERFACES.md](../../../../docs/plan/memory-refactor/COMPILED_INTERFACES.md) for the authoritative interface contract. `src/index.ts` is a compileable ambient-declaration skeleton;
implementation is extracted from `libs/memory-core` / `libs/memory-enrich` by the memory-refactor plan.
