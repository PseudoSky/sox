---
"@adhd/sox-memory-core": minor
---

Instrument the clustering subsystem, which previously had no observability of any kind.

Before this change `telemetry_self_check` declared two stages (`memory-core.write_queue`,
`memory-core.embed`), and grepping every log file for `cluster_count`, `community`, or
`communities_invalidated` returned zero matches. Four concrete consequences, each addressed by a
specific instrument:

- **A mass community invalidation left no trace.** `buildCommunities` invalidates every
  `level = 0` community in one statement without invalidating their `MEMBER_OF` edges; the only
  evidence would have been the absence of rows. Now `communities_created` /
  `communities_invalidated` / `communities_revived` / `member_edges_invalidated` are recorded per
  materialize pass. `created` climbing while `revived` stays flat is the community-identity-churn
  signature.
- **Time-to-community had to be hand-measured** off `memory_recall`. Now `time_to_community_ms`
  (p50/p99/mean/max). The clock stops at the `MEMBER_OF` insert — the moment
  `memory_get_community` starts returning the community — so it measures user-visible latency, not
  pass duration. It is **wall-clock** (the write happened in an earlier tick/process, so no
  monotonic start stamp survives) and carries the same BL-369 caveats as `heal_lag_ms`.
- **The join rate was only derivable from a defect.** The incremental join does not update
  `meta.member_count`, so the drift accidentally acted as a join ledger. Fixing that defect would
  have made the join rate unobservable again; `joins_joined` now records it directly.
- **"Considered and rejected" was indistinguishable from "never considered."** The new
  `JoinOutcome` taxonomy is deliberately finer than the join loop's two `continue` statements:
  `below_threshold` (compared and rejected — a τ signal) is separated from `no_vector` (no
  embedding, an embed-backlog symptom τ cannot fix), `no_target` (no live community in scope), and
  `degenerate_guard` (cleared τ, refused by the 50% blob guard).

Also adds an unclustered-backlog gauge (count + age of the oldest unclustered episode), measured
off `edge` rows rather than the pass's own return value so a pass that never compared anything
cannot report an empty backlog.

New public exports: `getClusterMetrics`, `_resetClusterMetrics`, and the `ClusterMetrics`,
`JoinOutcome`, `ClusterPassPath` types. The `record*` functions are deliberately NOT exported —
`cluster.ts` is the only writer, and a second one would make the counters unattributable.

`stages_declared` becomes **3**: a `cluster` stage with `full` / `incremental` / `subset` paths,
all three wired at real call sites in this same change per `stages.ts`'s rule against aspirational
declarations.

**Cross-process note, because it would otherwise be rediscovered as a bug:** the periodic tick runs
enrichment in an isolated child process (`runEnrichIsolated`, BL-348), so the in-memory counters
accumulate in that child and `memory_ping`'s `cluster.metrics` will normally read `null` on the
live server. That is expected, not a fault. The authoritative cross-process record is the
`cluster.pass` event written to the durable JSONL log by whichever process runs the pass; the
in-memory surface serves in-process callers (`memory_curate`, tests).

`ClusterStoreOptions`, `ClusterSubsetOptions`, `MaterializeOptions`, and `BatchEnrichOptions` each
gain an optional `storeKey` — the metrics bucket, matching `memory_ping`'s resolved path. Omitting
it is safe: unkeyed callers record into a named `(unkeyed)` bucket rather than merging into an
unrelated store's numbers. No existing signature changed incompatibly and no existing behavior
changed; every added field is additive.
