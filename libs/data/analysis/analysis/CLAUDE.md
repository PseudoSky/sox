# CLAUDE.md — data/analysis/analysis

Rules for working in this package (agent-routing layer; keep authoritative + minimal).

## Interface contract

The authoritative interface spec for this package is:
**[docs/plan/memory-refactor/COMPILED_INTERFACES.md](../../../../docs/plan/memory-refactor/COMPILED_INTERFACES.md)**

`src/index.ts` is a compileable skeleton of the interfaces — all types match that spec.
Do not add implementation code to `src/index.ts` directly; implementation lands via the
memory-refactor plan states.

## Invariants (do not violate)

- operates over a corpus (batch), never per-query — analysis functions are not on the hot query path
- clustering uses an existing JS lib (density-clustering / hdbscanjs) — NOT hand-rolled DBSCAN/HDBSCAN
- all DB-integrated functions take (VectorBackend, GraphBackend) directly — no CorpusBackend wrapper
- similarity-based outputs (clusters, near-dup pairs, link scores) MUST record the modelId they were computed under — re-clustering after a model migration is required
- computeImportance / buildAutoLinks are incremental by default ([def:deterministic-first] — processes only un-scored nodes)
- topoSort / criticalPath / detectCycles accept a caller-supplied adjacency function (getEdges) so they work over any graph representation, not just graph-store
- packBatches shared resource cost is submodular (union cost) — shared resources are paid once per batch; callers must not compute additive per-item resource cost

## Boundaries

- `area:data` may import `area:data` + `area:shared` only — NEVER `area:platform`
  (enforced by nx module-boundary lint).
- Published npm name (`@adhd/sox-analysis`) is decoupled from this folder path —
  never rename the package name on a folder move.
- Declared deps: `@adhd/sox-vector-store`, `@adhd/sox-graph-store`, `density-clustering`.
  Do not add undeclared deps without updating package.json + COMPILED_INTERFACES.md.

## Build / test

- `npx nx build analysis` · `npx nx test analysis` · `npx nx lint analysis`
- Build via nx targets only — bare `tsc` emits into `src/` and bypasses project graph.
- This is a data-layer library; it is NOT registered in `registry/index.json` —
  skip `npx nx run registry:sync-index` after changes here.
