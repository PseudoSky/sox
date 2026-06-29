# @adhd/sox-vector-store

Multi-space vector persistence (sqlite-vec vec0) + kNN/cosine search. Enforces the embedding space invariant: one (modelId, dim) pair per vec0 virtual table, rejects any upsert whose vec.length ≠ space.dim. Owns per-record modelId provenance. reembed() migrates vectors between spaces.

- **area:** data · **group:** vectors · **publish:** PUBLIC (`private: false`, publish owner-gated)
- **engines:** Node >=22
- **concerns:** multi-space vec0 persistence (one virtual table per VectorSpace), kNN/cosine search (VectorBackend.knn), space invariant enforcement (SpaceInvariantError on dim mismatch), per-record modelId provenance (VectorSpace.modelId), corpus scan for clustering + reembed (iter), reembed() — cross-space migration (walks old space, re-embeds, writes into target space)

## Invariants

- ensureSpace(space) MUST be called before the first upsert on any new (modelId, dim) pair — idempotent on existing spaces
- upsert() THROWS SpaceInvariantError when vec.length !== space.dim ([def:space-invariant] — all implementations must enforce this)
- a model switch is a re-embed migration (explicit reembed() call), never a hot-swap into the same vec0 table
- reembed() does NOT delete source vectors — caller decides when the old space is safe to drop
- delete(id, modelId) is scoped to a single space — does not delete the node from other spaces

## Interface spec

See [COMPILED_INTERFACES.md](../../../../docs/plan/memory-refactor/COMPILED_INTERFACES.md) for the authoritative interface contract. `src/index.ts` is a compileable ambient-declaration skeleton;
implementation is extracted from `libs/memory-core` / `libs/memory-enrich` by the memory-refactor plan.
