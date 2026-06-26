# w2d-analysis — Extract data/analysis/analysis

> **Slug is identity.** `w2d-analysis` is immutable.

**Phase:** extraction · **Depends on:** `w2c-vector-store` · **Guard:** `nx build analysis && nx test analysis`
**Parallel with:** `w2d-ingest`, `w2d-hybrid-search`.

---

## Goal

Extract **batch derivation over a corpus** into `@adhd/sox-analysis`
([def:data-package], data/analysis): clustering / community detection, near-duplicate
detection, importance & link scoring, auto-linking, and the batch-pass orchestrator.
Operates over a corpus (batch), never per-query; similarity outputs must record the
`modelId` they were computed under ([inv:space]).

---

## Semantic Distillation

- **Primitive:** EXTRACT the cross-item derivation from `memory-enrich`.
- **Reference Pattern:** `libs/memory-enrich/src/{cluster.ts (+ cluster-subset),
  neardup.ts, importance.ts, autolink.ts, batch.ts}`. `batch.ts`'s `runBatchEnrich` is
  the corpus orchestrator; `filters.ts`/`types.ts` carry supporting shapes (decide
  whether `filters` is analysis-local or shared — see Notes).
- **Delta Spec:**
  - `clusterStore` / `clusterSubset` / `clusterStats` / `materializeClusters` /
    `dropSubsetLens` / `listSubsetLenses` — moved from `cluster.ts`.
  - `detectNearDup` — from `neardup.ts`.
  - `computeImportance` — from `importance.ts`.
  - `buildAutoLinks` — from `autolink.ts`.
  - `runBatchEnrich` — the batch orchestrator from `batch.ts` (calls cluster/neardup/
    importance/autolink over the corpus).
  - Each similarity-derived output records the `modelId` it was computed under (so a
    re-embed invalidates stale derivations).
  - `analysis` imports `@adhd/sox-vector-store` (cosine) + `@adhd/sox-graph-store`
    (corpus reads); both are data→data (allowed).
- **Invariants added:** [inv:space] (record modelId on outputs), corpus-not-query,
  [inv:nx-targets], [inv:name-decoupled], [inv:boundary].
- **Validation:** `nx test analysis` — clustering determinism on a seeded corpus,
  near-dup threshold, importance scoring.

---

## Acceptance criteria

Checked by `audit-extraction`.

- [ ] **[w2d-analysis.1]** `@adhd/sox-analysis` builds; exports `clusterStore`,
      `clusterSubset`, `detectNearDup`, `computeImportance`, `buildAutoLinks`,
      `runBatchEnrich` from `dist/index.js`.
- [ ] **[w2d-analysis.2]** Clustering is deterministic on a seeded corpus (same input →
      same communities). (vitest.)
- [ ] **[w2d-analysis.3]** Similarity-derived outputs record the `modelId` they were
      computed under. [inv:space] (vitest.)
- [ ] **[w2d-analysis.4]** `analysis` operates batch-only (no per-query entry point);
      imports vector-store + graph-store, not the composer. [inv:boundary]
- [ ] **[w2d-analysis.5]** Subset/filtered clustering (`clusterSubset` +
      `dropSubsetLens`/`listSubsetLenses`) parity with the legacy `cluster-subset` suite.

---

## Reservations

```text
read_only:  ["libs/memory-enrich/src/cluster.ts", "libs/memory-enrich/src/neardup.ts",
             "libs/memory-enrich/src/importance.ts", "libs/memory-enrich/src/autolink.ts",
             "libs/memory-enrich/src/batch.ts", "libs/memory-enrich/src/filters.ts",
             "libs/memory-enrich/src/types.ts"]
mutates:    ["libs/data/analysis/analysis/src/**"]
```

---

## Notes for executor

- `filters.ts` (`buildFiltersClause`/`MemoryFilter`) is used by BOTH recall (hybrid-search)
  and batch (analysis). Decide its home: if both packages need it, it is a `shared`
  candidate — but to avoid creating a new shared package mid-plan, DUPLICATE the tiny SQL
  builder into whichever package uses it, OR keep a single copy in `analysis` and have
  hybrid-search re-derive its own. Flag the orchestrator if it proves load-bearing;
  default: keep `MemoryFilter` types with hybrid-search (the query side) and the batch
  filter clause with analysis.
- `memory-enrich` is fully dissolved across this state + `w2d-ingest`; after both, nothing
  in `memory-enrich/src` lacks a new home. `w2e` deletes the package.
- **Clustering = depend on a JS lib, do NOT hand-roll, NOT a SQLite extension (SCOPE Part A).** Read
  vectors out of vector-store → cluster via an existing JS lib (`density-clustering`/`hdbscanjs`) →
  write labels back. The package's value is the deterministic, zero-LLM, `modelId`-provenance-aware
  *integration*, not reimplementing DBSCAN/HDBSCAN. (No new native code; clustering is a batch/daemon op,
  not on the query hot path — perf is not the driver at Phase-0 <50K.)
- **Packaging (ADR-0006): analysis is PRIVATE** (`private:true`, never published) — thin
  off-the-shelf-algorithm wrapper; it gets bundled (stateless helpers) by whoever needs it.
- Budget: 1-2 sessions.
