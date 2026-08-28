# ADR-0016 — The semantic RAG facade is a new composition package, not an extension of a storage/rank primitive

**Status:** Accepted · 2026-08-28
**Relates to:** ADR-0006 (DI for live objects), ADR-0010 (open node/edge typing); FEAT-018..021; DEBT-011 (vector-store graph-coupling decoupling).

## Context

The semantic RAG surface ("embed, index, search, rank" over graph nodes) is currently hand-wired in hosts
(the adhd backlog's `bootstrapSemanticBackend`, ~200 lines of glue). It composes three primitives —
`@adhd/sox-graph-store` (nodes/edges), `@adhd/sox-vector-store` (embeddings + kNN), and
`@adhd/sox-embedding-provider` (text→vector) — plus, eventually, ranking. DEBT-011 decouples the vector
store from graph-store, making it a pure `(id → vec)` primitive, which makes the composition layer the
sole owner of the node-join and the embedding lifecycle (embed-on-write, delete-on-invalidate).

The question: should that composition layer be a **new package**, or extend an existing one?

Verified facts:
- `@adhd/sox-vector-store` is a *persistence* primitive (group `vectors`; its concerns are strictly
  "multi-space vector persistence"). It depends on `graph-store` but **not** on `embedding-provider`.
  Extending it would force a storage tier to gain orchestration deps — inverting the graph.
- `@adhd/sox-hybrid-search` already depends on all three primitives and is the closest home, but its
  invariant surface is **read-path only** (`SearchBackend.search()` fuse/normalize). The facade adds
  **write-path lifecycle** (embed-on-write, delete-on-invalidate observer) — a distinct orchestration
  concern that would broaden the ranker's single responsibility.

## Decision

1. **Create a new package `@adhd/sox-semantic`** under `libs/data/search/`, sibling to
   `@adhd/sox-hybrid-search`. It is the ADR-0006 "composer": it DI-wires the embedding-provider instance,
   the open DB/vector buffer, and (optionally) a hybrid-search ranker across package boundaries.

2. **Do not extend `@adhd/sox-vector-store`** — it stays a storage primitive (and, per DEBT-011, becomes
   pure `(id → vec)` with no `node`-table knowledge).

3. **Do not extend `@adhd/sox-hybrid-search`** — the facade's write-path lifecycle is a different concern
   from the ranker's read-path fuse/normalize; coupling them would violate the ranker's single
   responsibility.

4. **Publishability follows ADR-0006** — the facade is public only if a third party gains standalone
   reuse value from "embed, index, search, rank" alone; otherwise `private:true`. Either way, live objects
   (open DB, provider, vector backend) cross via constructor DI, never via duplicated stateful bundles.

   **Resolved 2026-08-28: publish APPROVED.** "embed, index, search, rank" over a StoreAdapter has
   standalone third-party reuse value (the backlog and memory are both consumers, and a fresh host opts
   in with one call). The package ships `private:false` + `publishConfig.access:public`.

## Consequences

- New `libs/data/search/sox-semantic` package, depending on graph-store + vector-store + embedding-provider
  (+ optional hybrid-search). No base package gains a dependency on it.
- `createSemanticBackend()` is the wiring seam; the facade is the sole owner of the node-join (FEAT-019)
  and the embedding-lifecycle observer (FEAT-021), which is the natural home for DEBT-011's decoupled
  join.
- `semanticSearchNodes` / batch-first embeddings / lifecycle observer all live on the facade, leaving
  graph-store (base) and vector-store (storage) at their own tiers.
