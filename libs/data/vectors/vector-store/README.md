# @adhd/sox-vector-store

Multi-space vector persistence with two real, swappable `VectorBackend` implementations —
`SqliteVectorBackend` (sqlite-vec `vec0`, brute-force kNN, the production default consumed by
`memory-core`) and `LanceDbVectorBackend` (real `@lancedb/lancedb` on-disk tables + HNSW/IVF-PQ ANN
indexes). Both enforce the embedding space invariant: one `(modelId, dim)` pair per table, rejects
any upsert whose `vec.length ≠ space.dim`. Both own per-record modelId provenance. `reembed()`
migrates vectors between spaces (and between backends, since both implement the same interface).

`LanceDbVectorBackend`'s `@lancedb/lancedb` client is async (napi/tokio); the public `VectorBackend`
interface is synchronous. `src/lancedb-worker.ts` runs the real LanceDB calls in a
`worker_threads.Worker`; `src/lancedb.ts` blocks on `Atomics.wait` via `synckit`'s `createSyncFn`
until each call resolves — a real synchronous call into a real on-disk table, not a cache.

- **area:** data · **group:** vectors · **publish:** PUBLIC (`private: false`, publish owner-gated)
- **engines:** Node >=22
- **concerns:** multi-space persistence for both backends (one table per VectorSpace), real HNSW/IVF-PQ ANN index construction (LanceDB), kNN/cosine search (VectorBackend.knn), space invariant enforcement (SpaceInvariantError on dim mismatch), per-record modelId provenance (VectorSpace.modelId), corpus scan for clustering + reembed (iter), reembed() — cross-space/cross-backend migration (walks old space, re-embeds, writes into target space)

## Invariants

- ensureSpace(space) MUST be called before the first upsert on any new (modelId, dim) pair — idempotent on existing spaces
- upsert() THROWS SpaceInvariantError when vec.length !== space.dim ([def:space-invariant] — all implementations must enforce this)
- a model switch is a re-embed migration (explicit reembed() call), never a hot-swap into the same vec0 table
- reembed() does NOT delete source vectors — caller decides when the old space is safe to drop
- delete(id, modelId) is scoped to a single space — does not delete the node from other spaces

## Interface spec

See [COMPILED_INTERFACES.md](../../../../docs/plan/memory-refactor/COMPILED_INTERFACES.md) for the authoritative interface contract. `src/index.ts` is a compileable ambient-declaration skeleton;
implementation is extracted from `libs/memory-core` / `libs/memory-enrich` by the memory-refactor plan.
