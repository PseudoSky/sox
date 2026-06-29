# @adhd/sox-hybrid-search

Generic hybrid retrieval ranker — fuses vector similarity + text relevance signals (mechanism-agnostic: textScore / vecScore) via normalized RRF/max-score fusion. SearchBackend interface decouples ranking logic from storage. SqliteSearchBackend wires VectorBackend + GraphBackend via DI. Pure fuse() + normalize() functions are exported for callers with any signal source.

- **area:** data · **group:** search · **publish:** PUBLIC (`private: false`, publish owner-gated)
- **engines:** Node >=22
- **concerns:** SearchBackend interface (mechanism-agnostic: textScore / vecScore, not BM25 / cosine), SqliteSearchBackend — DI constructor (VectorBackend, GraphBackend), hybrid fusion: normalize-before-combine (min_max / L2 / z_score), degrade-to-text when vec signal absent ([def:degrade-to-text-only]), pure fuse() + normalize() exports (no storage dep), explain mode (signal-level breakdown only — not field-level), SchemaAdapter is SQLite-internal (NOT exported — filters wired into SqliteSearchBackend)

## Invariants

- SearchBackend.search() degrades to text-only when query.vec is absent, degrades to vec-only when query.text is absent — never errors on a missing signal
- scores are normalized BEFORE combining (never raw scale-blind additive merge)
- textScore / vecScore are mechanism-agnostic names — BM25 / cosine are implementation details inside backends (never surfaced through SearchBackend interface)
- SchemaAdapter is an internal SQLite concern — NOT exported; MCP handlers pass raw filters via SearchQuery.filters; SqliteSearchBackend resolves them internally
- fuse() weights must be multiplicative (field boosting), never additive (scale-blind)

## Interface spec

See [COMPILED_INTERFACES.md](../../../../docs/plan/memory-refactor/COMPILED_INTERFACES.md) for the authoritative interface contract. `src/index.ts` is a compileable ambient-declaration skeleton;
implementation is extracted from `libs/memory-core` / `libs/memory-enrich` by the memory-refactor plan.
