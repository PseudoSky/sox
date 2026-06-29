# ROUTER.md — Intent→Scope Mapping

Hand-curated decision-routing surface for the sox-ecosystem codebase. Use this when you know what
you want to change but need to find the right package. For a full project listing, see
[INDEX.md](./INDEX.md). For data-package guidance, see [`libs/data/CLAUDE.md`](../libs/data/CLAUDE.md).

| If you're doing... | Go to |
|---|---|
| Change embedding model / add a new model | `libs/data/embed/embedding-provider/` |
| Tune recall ranking / scoring / normalization | `libs/data/search/hybrid-search/` |
| Change node/edge schema, add graph columns | `libs/data/graph/graph-store/` + plan a re-embed (modelId mismatch check) |
| Add a write-time transform (new tagging, summary) | `libs/data/ingest/ingest/` |
| Tune clustering / near-dup / importance | `libs/data/analysis/analysis/` |
| Fix the kNN / space invariant / re-embed migration | `libs/data/vectors/vector-store/` |
| Change the 19 `memory_*` tool surface | `extensions/bundles/sox-memory-bundle/members/memory-server/` |
| Change the memory domain policy (scope, promotion, federation) | `libs/memory-core/` |
| Add a new `data/*` package | Run `npx nx g @adhd/sox-nx:library --area data --group <g> <name>`; see [`NX-GENERATOR-HANDOFF.md`](../docs/plan/memory-refactor/NX-GENERATOR-HANDOFF.md) |
| Cross-cutting: new model breaks something | Check `[def:space-invariant]`; run `scripts/space_invariant_check.mjs`; route to `vector-store` + `embedding-provider` |

## Advisory: sox-memory learned lessons

At task time, agents MAY recall learned lessons from sox-memory via `memory_recall` — the memory
system stores durable findings (embeddings, patterns, past decisions tagged by area and topic).
This is **advisory only, never gating.** If recall is down or embeddings are offline, routing still
works via this document and the generated routing index. The advisory degrades gracefully, never
blocks.

To use: `memory_recall({ query: "<your task description>", filters: { topic: "routing" } })`.
Past decisions about package boundaries, cross-cutting concerns, and migration patterns are
indexed with `topic: "routing"` and `project_path: "sox-ecosystem"`.
