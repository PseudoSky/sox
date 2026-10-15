---
"@adhd/sox-memory-core": patch
---

A requested full recluster over a corpus above `nodeCap` is no longer reported as a completed pass.

- `clusterStore` returns `degraded: { reason: 'nodeCap', episodeCount, nodeCap }` when it refuses the full pass (it previously fell back to the incremental join, which can never create a community, and looked like success). A full pass that cannot fit its time budget returns `degraded: { reason: 'budget', ... }` before writing anything, leaving the previous partition untouched.
- `runBatchEnrich` reports both cases as `cluster_pass_skipped` with a `nodeCap:` / `budget:` `cluster_skip_reason` and the structured `cluster_degraded`.
- The default full-pass cap is derived from measurement and raised from 10,000 to 16,000 episodes (`DEFAULT_CLUSTER_NODE_CAP`); `budgetMs` and a `now` clock are new optional `clusterStore` options.
- A degraded `clusterSubset` pass no longer persists, so it cannot replace an existing lens with nothing.
