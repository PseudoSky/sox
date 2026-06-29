# CLAUDE.md — data/graph/graph-store

Rules for working in this package (agent-routing layer; keep authoritative + minimal).

## Interface contract

The authoritative interface spec for this package is:
**[docs/plan/memory-refactor/COMPILED_INTERFACES.md](../../../../docs/plan/memory-refactor/COMPILED_INTERFACES.md)**

`src/index.ts` is a compileable skeleton of the interfaces — all types match that spec.
Do not add implementation code to `src/index.ts` directly; implementation lands via the
memory-refactor plan states.

## Invariants (do not violate)

- records are NEVER deleted — invalidate() sets t_invalid (audit-preserving), supersede() mints a new node linked by SUPERSEDES
- touch() updates mutable metadata (tExpires, confidence, name, tags) without minting a new node or SUPERSEDES edge — THROWS if nodeId is invalidated or missing
- writeEdge() is upsert-idempotent on (src, dst, rel) — safe to call on re-projection
- writeGraph() / writeNodeBatch() are atomic (single SQLite transaction) — all or nothing
- searchNodes() returns [] (not an error) when capabilities.fullTextSearch === false
- NodeFilter.validAt is honored only when capabilities.bitemporal === true, ignored silently otherwise
- namespace is a hard isolation field (not a tag/filter convention) — absent → "global"

## Boundaries

- `area:data` may import `area:data` + `area:shared` only — NEVER `area:platform`
  (enforced by nx module-boundary lint).
- Published npm name (`@adhd/sox-graph-store`) is decoupled from this folder path —
  never rename the package name on a folder move.
- Declared deps: `better-sqlite3`, `drizzle-orm`.
  Do not add undeclared deps without updating package.json + COMPILED_INTERFACES.md.

## Build / test

- `npx nx build graph-store` · `npx nx test graph-store` · `npx nx lint graph-store`
- Build via nx targets only — bare `tsc` emits into `src/` and bypasses project graph.
- This is a data-layer library; it is NOT registered in `registry/index.json` —
  skip `npx nx run registry:sync-index` after changes here.
