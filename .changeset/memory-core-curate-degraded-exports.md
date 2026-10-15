---
"@adhd/sox-memory-core": minor
---

`memoryCurate({ op: 'recluster', filters })` and the package root now carry the degradation surface through.

- The result of a subset recluster includes `degraded` (`{ reason: 'nodeCap' | 'budget', ... }`) when `clusterSubset` refused or aborted the pass, instead of reading as an ordinary empty result. Un-degraded results are unchanged and have no `degraded` key.
- `DEFAULT_CLUSTER_NODE_CAP` and the `ClusterDegradation` type are exported from the package root so consumers branch on the same shape and cap memory-core uses rather than redeclaring them.
- Together with the `clusterSubset` contract change in the nodecap entry, a degraded `persist: true` subset recluster now reports `persisted: false` and leaves the previous lens in place.
