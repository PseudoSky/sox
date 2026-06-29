# CLAUDE.md — data/vectors/vector-store

Rules for working in this package (agent-routing layer; keep authoritative + minimal).

## Interface contract

The authoritative interface spec for this package is:
**[docs/plan/memory-refactor/COMPILED_INTERFACES.md](../../../../docs/plan/memory-refactor/COMPILED_INTERFACES.md)**

`src/index.ts` is a compileable skeleton of the interfaces — all types match that spec.
Do not add implementation code to `src/index.ts` directly; implementation lands via the
memory-refactor plan states.

## Invariants (do not violate)

- ensureSpace(space) MUST be called before the first upsert on any new (modelId, dim) pair — idempotent on existing spaces
- upsert() THROWS SpaceInvariantError when vec.length !== space.dim ([def:space-invariant] — all implementations must enforce this)
- a model switch is a re-embed migration (explicit reembed() call), never a hot-swap into the same vec0 table
- reembed() does NOT delete source vectors — caller decides when the old space is safe to drop
- delete(id, modelId) is scoped to a single space — does not delete the node from other spaces

## Boundaries

- `area:data` may import `area:data` + `area:shared` only — NEVER `area:platform`
  (enforced by nx module-boundary lint).
- Published npm name (`@adhd/sox-vector-store`) is decoupled from this folder path —
  never rename the package name on a folder move.
- Declared deps: `better-sqlite3`, `sqlite-vec`.
  Do not add undeclared deps without updating package.json + COMPILED_INTERFACES.md.

## Build / test

- `npx nx build vector-store` · `npx nx test vector-store` · `npx nx lint vector-store`
- Build via nx targets only — bare `tsc` emits into `src/` and bypasses project graph.
- This is a data-layer library; it is NOT registered in `registry/index.json` —
  skip `npx nx run registry:sync-index` after changes here.
