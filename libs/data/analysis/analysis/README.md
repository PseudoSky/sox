# @adhd/sox-analysis

Batch derivation over a corpus — clustering (density-clustering, in-process JS), near-dup detection, importance + link scoring, and a suite of pure graph algorithms (topoSort, criticalPath, detectCycles, packBatches). No CorpusBackend wrapper: DB-integrated functions take VectorBackend + GraphBackend directly.

- **area:** data · **group:** analysis · **publish:** PUBLIC (`private: false`, publish owner-gated)
- **engines:** Node >=22
- **concerns:** clustering / community detection (density-clustering, in-process JS — NOT a SQLite extension), near-dup detection (NearDupPair with near_dup / candidate / distinct status), importance scoring (inDegree, outDegree, recencyMs, nearDupCount), auto-linking (similarity-threshold edge creation, RELATES_TO by default), batch enrichment orchestration (runBatchEnrich — incremental, skip-list), pure topoSort + wave assignment (Kahn BFS, cycle detection + recovery), criticalPath (longest-path DP for dispatch/scheduling prioritization), detectCycles (all cycles, not just first — for user-facing error messages), packBatches (bin-packing with submodular shared cost; algorithm auto-selects by N + DAG structure), detectDAGStructure (forest / series-parallel / general — determines packBatches algorithm), setOverlapMatrix (pairwise intersection; MinHash for |S| > 500)

## Invariants

- operates over a corpus (batch), never per-query — analysis functions are not on the hot query path
- clustering uses an existing JS lib (density-clustering / hdbscanjs) — NOT hand-rolled DBSCAN/HDBSCAN
- all DB-integrated functions take (VectorBackend, GraphBackend) directly — no CorpusBackend wrapper
- similarity-based outputs (clusters, near-dup pairs, link scores) MUST record the modelId they were computed under — re-clustering after a model migration is required
- computeImportance / buildAutoLinks are incremental by default ([def:deterministic-first] — processes only un-scored nodes)
- topoSort / criticalPath / detectCycles accept a caller-supplied adjacency function (getEdges) so they work over any graph representation, not just graph-store
- packBatches shared resource cost is submodular (union cost) — shared resources are paid once per batch; callers must not compute additive per-item resource cost

## Interface spec

See [COMPILED_INTERFACES.md](../../../../docs/plan/memory-refactor/COMPILED_INTERFACES.md) for the authoritative interface contract. `src/index.ts` is a compileable ambient-declaration skeleton;
implementation is extracted from `libs/memory-core` / `libs/memory-enrich` by the memory-refactor plan.
