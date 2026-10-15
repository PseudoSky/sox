---
"@adhd/sox-extension-memory-server": patch
---

A requested global recluster that memory-core refused (`nodeCap`) or aborted (`budget`) now settles `skipped` with its reason, episode count and cap in `skip_reason`, and `memory_ping` reports it.

- `recluster_status` for such a job reads `status: "skipped"` with `skip_reason` such as `nodeCap: 20000 episodes exceed cap 16000; full pass not run`, never `completed`.
- `memory_ping` gains an additive `cluster.full_pass_degraded` field: `{ reason, episodeCount, nodeCap, budgetMs, since }` while the most recent requested full pass was degraded, `null` otherwise. It clears when a later requested full pass completes un-degraded. It does not change `status`.
- `memory_curate` subset `recluster` results carry the `degraded` marker through when the pass was refused or aborted.
