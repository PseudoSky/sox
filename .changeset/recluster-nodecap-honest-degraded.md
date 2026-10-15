---
"@adhd/sox-memory-core": minor
---

A requested full recluster over a corpus above `nodeCap` is no longer reported as a completed pass, and the default cap changes. This is a behaviour change (hence `minor`), not an additive API.

- `clusterStore` returns `degraded: { reason: 'nodeCap', episodeCount, nodeCap }` when it refuses the full pass. Previously it fell back to the incremental join, which can never create a community, and looked like success.
- A full pass whose time budget is spent returns `degraded: { reason: 'budget', ... }` and writes nothing, leaving the previous partition untouched. The budget is checked before each run of the all-pairs pass, never inside one. In practice it fires in two cases: vector loading and calibration alone consumed the budget, or the degenerate-cluster guard rejected a finished pass and a retry is predicted not to fit. In the second case the rejected pass is discarded (`clusters: []`) and the previous partition stays.
- `runBatchEnrich` reports both cases as `cluster_pass_skipped` with a `nodeCap:` / `budget:` `cluster_skip_reason` and the structured `cluster_degraded`.
- The default full-pass cap is derived from measurement and raised from 10,000 to 16,000 episodes (`DEFAULT_CLUSTER_NODE_CAP`). A store between 10,001 and 16,000 episodes that was previously refused now runs a real full pass.
- `budgetMs` and a `now` clock are new optional `clusterStore` and `clusterSubset` options.
- A budget-aborted pass is no longer counted in `passes_full` or the full-pass quality gauges.

Contract change for `clusterSubset({ persist: true })`: a degraded pass (over `nodeCap` or budget-aborted) no longer persists. Before, it wrote an empty lens plus a marker and returned `persisted: true`, replacing any existing lens for that filter with nothing. Now it leaves the existing lens untouched and returns `persisted: false` together with `degraded`. Callers that treated `persisted: true` as always true on a `persist: true` call must check `degraded`/`persisted`.
