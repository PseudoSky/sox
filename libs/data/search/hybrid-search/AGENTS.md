# CLAUDE.md — data/search/hybrid-search

Rules for working in this package (agent-routing layer; keep authoritative + minimal).

## Interface contract

The authoritative interface spec for this package is:
**[docs/plan/memory-refactor/COMPILED_INTERFACES.md](../../../../docs/plan/memory-refactor/COMPILED_INTERFACES.md)**

`src/index.ts` is a compileable skeleton of the interfaces — all types match that spec.
Do not add implementation code to `src/index.ts` directly; implementation lands via the
memory-refactor plan states.

## Invariants (do not violate)

- SearchBackend.search() degrades to text-only when query.vec is absent, degrades to vec-only when query.text is absent — never errors on a missing signal
- scores are normalized BEFORE combining (never raw scale-blind additive merge)
- textScore / vecScore are mechanism-agnostic names — BM25 / cosine are implementation details inside backends (never surfaced through SearchBackend interface)
- SchemaAdapter is an internal SQLite concern — NOT exported; MCP handlers pass raw filters via SearchQuery.filters; StoreSearchBackend resolves them internally
- fuse() weights must be multiplicative (field boosting), never additive (scale-blind)

## Boundaries

- `area:data` may import `area:data` + `area:shared` only — NEVER `area:platform`
  (enforced by nx module-boundary lint).
- Published npm name (`@adhd/sox-hybrid-search`) is decoupled from this folder path —
  never rename the package name on a folder move.
- Declared deps: `@adhd/sox-vector-store`, `@adhd/sox-graph-store`.
  Do not add undeclared deps without updating package.json + COMPILED_INTERFACES.md.

## Build / test

- `npx nx build hybrid-search` · `npx nx test hybrid-search` · `npx nx lint hybrid-search`
- Build via nx targets only — bare `tsc` emits into `src/` and bypasses project graph.
- This is a data-layer library; it is NOT registered in `registry/index.json` — no registry
  step is needed after changes here.

## Backlog

Findings for this package live in **[`BACKLOG.md`](./BACKLOG.md)** — cross-referenced to the root
[`/BACKLOG.md`](../../../../BACKLOG.md) BL-IDs. **Read it before extending this package.**
- **BL-116 (HIGH):** the cross-encoder worker is a token-overlap heuristic, not a real ONNX model.
- **BL-166 (HIGH):** the cross-encoder is built but UNWIRED (only its spec calls it; recall never uses
  it) and its worker path won't resolve in a bundle — wire a real reranker into recall behind a flag,
  or remove. The vec+BM25+RRF fusion path IS live and real.
