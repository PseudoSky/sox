# Backlog — `@adhd/sox-vector-store`

Package-local backlog. Items cross-reference the root [`/BACKLOG.md`](../../../../BACKLOG.md) BL-IDs.
This is a public data-layer package (the store + vector-search layer of the RAG substrate). The
`sqlite-vec`-backed `SqliteVectorBackend` remains the default production backend consumed by
`memory-core`; `LanceDbVectorBackend` is now a real, real-on-disk alternative (see BL-114 below), not
a test stub.

---

### BL-114 — RESOLVED (2026-07-08, P1 substrate plan): `LanceDbVectorBackend` is now backed by real LanceDB

Previously `src/lancedb.ts` was backed by `InMemoryLanceTable` (an in-memory `Map`); see root
[`/BACKLOG.md`](../../../../BACKLOG.md) BL-114 for the full before/after. A 2026-07-04 owner
directive had withdrawn this item, but the P1 substrate plan's `lancedb-backend` state carried an
explicit founder decision (P-5) superseding that withdrawal: build the real backend. `lancedb.ts` now
bridges to a real `@lancedb/lancedb` connection via a `worker_threads` + `synckit` sync RPC bridge
(`src/lancedb-worker.ts`), with on-disk tables, a persisted `_vector_spaces` metadata table, and real
HNSW (`hnswSq`)/IVF-PQ (`ivfPq`) index construction from `LanceDbVectorBackendConfig.index`.
`InMemoryLanceTable` is deleted.

---

### Notes (resolved / by-design)

- `reembed()` previously created an empty vec space even under `--dry-run`; the dry-run path was fixed
  in the `memory-core` reembed promotion (root BL-160). If adding new `reembed`-style callers, keep
  dry-run strictly read-only (no `ensureSpace`).
- Space invariant is enforced (`upsert` rejects dim/modelId mismatch) — a model switch is a re-embed
  migration, never a hot-swap. Do not weaken this.
