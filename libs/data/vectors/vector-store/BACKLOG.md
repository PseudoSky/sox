# Backlog — `@adhd/sox-vector-store`

Package-local backlog. Items cross-reference the root [`/BACKLOG.md`](../../../../BACKLOG.md) BL-IDs.
This is a public data-layer package (the store + vector-search layer of the RAG substrate). The
`sqlite-vec`-backed `SqliteVectorBackend` is the real, production backend consumed by `memory-core`.

---

### BL-114 — HIGH: `LanceDbVectorBackend` is in-memory only, not backed by real LanceDB

`src/lancedb.ts` implements `VectorBackend` but is backed by an `InMemoryLanceTable`
(`Map<number, Float32Array>`). The real `@lancedb/lancedb` dependency is **not** in `package.json`;
HNSW/IVF-PQ index config is parsed but **never applied**; ANN search falls back to brute-force cosine.
It compiles and passes tests but delivers **none** of the ANN/disk-persistence a LanceDB backend
implies — a correctness/capability gap for anyone selecting it as a production RAG vector store.

**Fix:** either (a) add `@lancedb/lancedb` and wire the real API + index build, or (b) rename to
`InMemoryVectorBackend` and document it as a test/prototype adapter so it can't be mistaken for a
production ANN store. Root: BL-114.

---

### Notes (resolved / by-design)

- `reembed()` previously created an empty vec space even under `--dry-run`; the dry-run path was fixed
  in the `memory-core` reembed promotion (root BL-160). If adding new `reembed`-style callers, keep
  dry-run strictly read-only (no `ensureSpace`).
- Space invariant is enforced (`upsert` rejects dim/modelId mismatch) — a model switch is a re-embed
  migration, never a hot-swap. Do not weaken this.
