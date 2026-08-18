# @adhd/sox-memory-core

## 0.9.0

### Minor Changes

- WAL checkpointing is now owned exclusively by the store adapter (DEBT-004).

  `WriteQueue` previously carried its own debounced idle-checkpoint timer that fired an **ungated** `wal_checkpoint(TRUNCATE)` with no quiescence coordination — a second mechanism competing with the adapter's own flush. That private implementation is deleted rather than coordinated with, so memory and backlog share one underlying flush and only one debounced checkpoint can ever be in flight per store.

  `closeAllForShutdown()` routes its end-of-life flush through `adapter.close()` instead of a second raw PRAGMA.

  `memory_ping.store.last_checkpoint_at` no longer reports null for a server's whole lifetime (BL-572): it is derived from the observed flush via `observedLastCheckpointAt()`, combining the queue's own record with the main db file's mtime.

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - @adhd/sox-graph-store@0.8.5
  - @adhd/sox-embedding-provider@0.4.0
  - @adhd/sox-telemetry@0.2.1
  - @adhd/sox-store-adapter@0.6.0
  - @adhd/sox-hybrid-search@0.3.8

## 0.8.1

### Patch Changes

- Updated dependencies
- Updated dependencies
  - @adhd/sox-graph-store@0.8.3
  - @adhd/sox-store-adapter@0.5.3
  - @adhd/sox-analysis@0.1.8
  - @adhd/sox-hybrid-search@0.3.7

## 0.8.0

### Minor Changes

- 379b03b: Instrument the clustering subsystem, which previously had no observability of any kind.

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

  **The headline metric is deliberately shaped so the <600ms target stays falsifiable.** The
  write→visible distribution is right-censored — ~29% of episodes never join — so a bare percentile
  would be computed over survivors only, and would look BEST exactly when exclusion is worst.
  Percentiles are therefore named `time_to_community_ms_among_joined`, the censored population is
  reported as `never_clustered` and as the terminal `never` bucket of a log-scale histogram, and
  `join_rate` accompanies every percentile. `join_rate` is `null`, never a fabricated `1.0`, when
  nothing has been censused.

  Cluster-quality gauges are reported in the same breath as latency, because the measured path to
  the budget runs through a smaller embedding model that produces 49% more edges at the same τ
  (jaccard 0.498 against the current neighbour graph) — a swap that would pass a latency-only test
  while reshaping every community. `quality` carries coverage, `mean_intra_sim`, `mean_inter_sim`,
  `largest_cluster_size`, `community_count`, and `single_member_clusters`. The last exists because
  `meanIntraSim()` returns 1.0 for a single-member cluster, so adopting singletons would drag the
  store-wide mean toward 1.0 — a quality metric improving because the store got less informative.
  Quality is measured on full passes only (it costs one query per community); coverage and the
  censored census are plain COUNTs and run every pass.

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

- 51fcf05: Fold Phase-A enrichment into the INSERT, eliminating a redundant FTS-index rewrite (PERF-MEMORY-003).

  Before this change `memoryWritePhaseA` INSERTed the node row and then issued a SECOND UPDATE over the
  same row to store enrichment columns (topic, project_path, summary, tags, importance, enrich_ver).
  Because `summary` and `tags` are covered by `idx_fts_node` — a native Turso FTS index maintained inside
  the statement itself, not a trigger — that second write redid FTS maintenance the INSERT had already
  completed, costing ~134ms (~56% of Phase A). The enrichment computation itself is pure (~3.7ms) and
  reorders freely, so the fold is safe.

  - `memoryWritePhaseA` now runs `computeWriteEnrichment()` BEFORE the INSERT and folds its values
    directly into the column list, going from 4→3 SQL calls and 2→1 transactions per write.
  - `computeWriteEnrichment()` (new export) is the pure, zero-DB resolver for E1/E2/E4/E5/E7/E10/E12.
    It is the SINGLE SOURCE OF TRUTH: `enrichOnWrite` delegates to it too, so the folded-INSERT path
    and the legacy UPDATE path cannot drift apart.
  - `detectAndApplyNearDup()` (new export) is E8 near-dup detection + SAME_AS edge persistence, split
    out of `enrichOnWrite` so the folded-INSERT path can run it post-insert without also paying for the
    now-redundant column UPDATE.
  - Measured −50.1% Phase-A wall on a store copy (241ms→120ms p50).

### Patch Changes

- OpenDb FTS delegation (DEBT-SOXGRAPH-002) + ping-honesty verdict + proactive stale-sidecar reconcile + env-toggle purge + BackupConfig skeleton.

  - **FTS delegation:** `openDb` routes FTS setup through `adapter.ensureFtsIndex` (capability-gated pre-check; sqliteDDL as data) instead of hand-rolled CREATE INDEX — the reference ordering the FTS incident fix adopted (debt-soxgraph-002).
  - **Ping honesty (BL-373 family, owner directive #2):** `computePingHealthVerdict` — status ok/degraded/unhealthy; ok ONLY when store opened AND embed real; store-failed-to-open ⇒ unhealthy + store_error; dimensions never collapse.
  - **Proactive stale-sidecar reconcile (BL-373):** the sidecar is reconciled BEFORE `openOnce()` when mtime-proven stale — the failed-open path is never taken; the catch stays as backstop.
  - **ADR-0013 env purge (owner directive #3):** `SOX_DISABLE_PERIODIC_ENRICH` deleted (periodic enrich already automatic, ADR-0007); `SOX_HEAL_STALE_VECTORS` gate deleted (`memory_curate reheal_stale` is the interface); `SOX_DISABLE_EMBED_HEAL` deleted (dead on arrival, BL-344); `SOX_SYNC_EMBED` converted to typed `embed.sync` config with documented purpose; `SOX_MEMORY_LOG_DISABLE` deleted (rotation caps handle space).
  - **BackupConfig skeleton:** typed `BackupConfig` (`enabled: true` literal — report-only, un-disablable; intervalMs 6h; retentionCount 24; dir precedence config → `SOX_AUTO_BACKUP_DIR` → `~/.memory/backups`) — landing pad for the backup feature.
  - `openDb` FTS pre-check + repair-intent engine recording (BL-508 telemetry).

- Updated dependencies
- Updated dependencies
- Updated dependencies [659a9d7]
  - @adhd/sox-store-adapter@0.5.2
  - @adhd/sox-graph-store@0.8.2
  - @adhd/sox-analysis@0.1.7
  - @adhd/sox-hybrid-search@0.3.6

## 0.7.0

### Minor Changes

- 94929d1: `memoryInvalidate` (`memory_invalidate`) now distinguishes three cases that were previously all collapsed into `E_NOT_FOUND` (BUG-MEMORY-002): a `claim_uid` that never existed still returns `E_NOT_FOUND` (message text corrected: `"No node found for uid: <uid>"`, code unchanged); a `claim_uid` that resolves to an already-invalid node now returns idempotent success (`{ok:true, already_invalid:true, t_invalid}`) instead of an error — the dominant real-world case, since the async near-dup pipeline can auto-invalidate a near-duplicate episode moments after write, racing a caller's own manual invalidate; a `claim_uid` that resolves to a live node of the wrong `kind` (entity/community/session) now returns a new `E_WRONG_KIND` error naming the actual kind, instead of silently mutating a structural node the operation was never meant to touch. `replacement_uid` is intentionally not processed on the already-invalid idempotent path — no `SUPERSEDES` edge is written even if it is itself valid, to keep the idempotency guarantee real. This is additive at the TypeScript level (`InvalidateResult` gains two optional fields, `InvalidateError` gains one new discriminant) but is a runtime behavior change: some previously-error calls now succeed.

### Patch Changes

- d5131db: `memoryRecall()` no longer pads results with null-content entity/community/session/generic nodes
  (BUG-MEMORY-003).

  Previously two of the four SQL candidate-admission points had no `node.kind` predicate: the temporal
  channel (`recall.ts` §1a) and the depth-1 graph-expansion neighbor fetch (`recall.ts` §1b, which runs
  on every default-parameter call since `DEFAULT_DEPTH = 1` and every tagged episode has a live
  `MENTIONS` edge to its own tag-created entity nodes). Every live node in the store — not just
  episodes — was therefore eligible to be returned, and entity/community/session/generic nodes carry
  no readable `content`, so callers silently received `content: null` rows counted against `limit` and
  `token_budget`.

  `memoryRecall()` now defaults to `kind = 'episode'` at all four candidate-admission SQL statements
  (temporal, vec KNN, FTS — both SQLite-shadow-table and Turso branches — and the graph-expansion
  neighbor fetch).

  Additive: `RecallParams.filters` accepts an optional `kinds: string[]` key (e.g.
  `filters: { kinds: ['episode', 'entity'] }`) for callers who explicitly want non-episode nodes back.
  Unrecognized kind strings simply match nothing — no validation error, same trust level as `tags`/
  `topic`. This is a bug fix, not a new capability being widened — the previous unfiltered behavior was
  defective, and the `filters.kinds` opt-in exists to make the fix non-breaking for the (structurally
  impossible, since those channels never populated non-episode rows) case of a caller who somehow
  depended on it.

- Updated dependencies [62c72a9]
- Updated dependencies [0a588bf]
- Updated dependencies [d0644be]
- Updated dependencies
  - @adhd/sox-store-adapter@0.4.0
  - @adhd/sox-embedding-provider@0.3.0
  - @adhd/sox-graph-store@0.7.0
  - @adhd/sox-analysis@0.1.6
  - @adhd/sox-hybrid-search@0.3.5

## 0.6.0

### Minor Changes

- Additive: memory-core takes ownership of its own ontology through one composition point (BL-441).

  New `ontology.js` module, re-exported from `index.d.ts`: `MemoryOntologyPolicy` (a `TypePolicy`
  implementation constructed from memory's own six node kinds / ten edge rels, with an optional
  `OntologyExtension` for consumer-registered kinds/rels), `MEMORY_NODE_KINDS`, `MEMORY_EDGE_RELS`,
  and `translateStoreVocabularyError` (rewrites a raw SQLite CHECK-constraint failure into an
  operator-facing message naming the BL-442 migration command). New `graph-backend.js` module,
  also re-exported: `getMemoryGraphBackend`, `registerOntologyExtension`, `getOntologySnapshot` — the
  single composition point through which all nine of memory-core's `createGraphBackend` call sites
  now route (`d64175f5`), replacing nine independent injections with one, so a tenth call site added
  later cannot silently skip the policy.

  No removed or narrowed export. Every existing export in `index.d.ts` is untouched — this changeset
  adds three new export lines and nothing else changes shape. Treated as additive/minor per the
  standard ecosystem convention used elsewhere in this same release train (see
  `bl460-sox-host-registry-opencode.md`, `bl460-sox-service-proxy-sa3-sa4.md`).

  Filed by PKT-63 (BL-444) after `scripts/check-changeset-surface.ts` (BL-460) correctly FAILed the
  gate: memory-core's built `dist/*.d.ts` differs from the published `0.5.0` tarball (verified via
  `npm pack @adhd/sox-memory-core@0.5.0` and a direct diff against `libs/memory-core/dist/index.d.ts`
  in this worktree — `ontology.d.ts` and `graph-backend.d.ts` do not exist in the published tarball at
  all) and no `.changeset/*.md` in the tree named this package — this was previously covered only by
  the `updateInternalDependencies: "patch"` cascade from the `@adhd/sox-graph-store` bump, which is
  correct for the _dependency_ pin but does not account for memory-core's _own_ new surface. This
  changeset closes that gap; memory-core now bumps `0.5.0` → `0.6.0` (minor, its own additive surface)
  rather than `0.5.1` (patch, cascade-only).

### Patch Changes

- Updated dependencies [32275f7]
- Updated dependencies [7f46e96]
- Updated dependencies [32275f7]
  - @adhd/sox-embedding-provider@0.2.0
  - @adhd/sox-graph-store@0.6.0
  - @adhd/sox-store-adapter@0.3.0
  - @adhd/sox-hybrid-search@0.3.4
  - @adhd/sox-analysis@0.1.5

## 0.5.0

### Minor Changes

- `WriteQueueMetrics` tells the truth about the path it is reporting on (BL-445, BL-394).

  Turso handles concurrent writes natively, so `WriteQueue` bypasses its own FIFO on that adapter — and the bypass returned before either admission check, while `memory_ping` went on reporting `queue_max_size: 100`, `deadline_budget_ms: 20000` and `deadline_guard_enabled: true`. Guards that structurally cannot fire were being advertised as active, and eight metric fields were structurally unreachable zeros that read as "nothing has gone wrong".

  - New `mode: 'fifo' | 'bypass'` discriminator, and `admission_control: 'active' | 'inactive — adapter handles concurrency natively'`.
  - On the bypass path `queue_depth`, `queue_high_watermark`, `saturated`, `queue_max_size` and `deadline_budget_ms` are **`null`**, and `deadline_guard_enabled` is `false`. "There is no queue" is not "the queue is empty".
  - `in_flight` becomes a **real** concurrent-operation count on the bypass path, and completions there now feed the latency ring and the task counters at all four settle points, including both error branches.

  **No admission control was added.** The owner's ruling was honest reporting only: the live store shows `queue_depth: 0` with zero rejections and no evidence a bound is warranted. If one is ever needed it will be sized from measurement, and `in_flight` is now the instrument that would size it.

  Breaking for anyone reading those five fields as `number`; additive for everyone else. Nothing in-repo outside tests consumed them.

### Patch Changes

- Updated dependencies
  - @adhd/sox-store-adapter@0.2.0
  - @adhd/sox-analysis@0.1.4
  - @adhd/sox-graph-store@0.5.3
  - @adhd/sox-hybrid-search@0.3.3

## 0.4.1

### Patch Changes

- Updated dependencies [1291af4]
  - @adhd/sox-telemetry@0.2.0
  - @adhd/sox-store-adapter@0.1.1
  - @adhd/sox-analysis@0.1.2
  - @adhd/sox-graph-store@0.5.1
  - @adhd/sox-hybrid-search@0.3.1

## 0.3.1

### Patch Changes

- Updated dependencies [0f63dfe]
  - @adhd/sox-graph-store@0.4.0
  - @adhd/sox-hybrid-search@0.3.0
  - @adhd/sox-analysis@0.1.1

## 0.3.0

### Minor Changes

- Two-phase update (BL-189): `memoryUpdatePhaseA` splits `memory_update` like the write path —
  Phase A is fully synchronous (columns + FTS + stale `vec_node` delete in one transaction) and
  returns a `PendingEmbed`; `memoryUpdate` remains the synchronous-embed composition (Phase A +
  inline `embed` + `applyEmbedding`). A crashed Phase B leaves the node vectorless and
  heal-eligible. Side-effect delta: the re-embed now flows through `applyEmbedding`, so an
  updated node participates in deferred near-dup detection (it previously did not).

- Ingestion consolidation (S11/BL-165): the SHA-256 dedup fingerprint is routed through
  `@adhd/sox-ingest`'s `hexSha256` (normalization unchanged — byte-identical fingerprints), and
  `splitIntoChunksSentence` (byte-identical to memory-server's deleted local chunker) lives in
  ingest; both re-exported here. Permanent parity regression spec: `ingest-parity.spec.ts`.

- BL-183 closeout: deleted the never-wired outbox consumer surface (`createMemoryOutboxQueue`,
  `memoryFlush`, `migrateOutboxQueueSchema` + types). The wired producers (`enqueueIngest`,
  `enqueueEnrichFull`, `hasPendingFullEnrich`) are unchanged and now directly spec'd.

- Two-phase write observability (follow-on to the split below): `embed-pipeline.ts` now keeps
  per-store metrics (`getEmbedPipelineMetrics(storeKey)`, keyed identically to
  `WriteQueue.metricsForPath`) — `time_to_vector_ms` (Phase-A commit → vec_node applied, from a
  monotonic `PendingEmbed.startedAtMs` stamp minted by `memoryWritePhaseA`; the user-facing
  eventual-consistency window), `embed_duration_ms` (the embed call itself), wall-clock
  `heal_lag_ms` for heal-path applies (which are deliberately EXCLUDED from time_to_vector —
  no in-process stamp survives a crash), and monotonic counters
  (`embeds_completed/failed`, `applies_applied/exists/gone`, `heals_applied/failed`).
  `WriteQueue.enqueue` gains an optional task `kind` (`'write'` default | `'apply'`); Phase-B
  apply tasks are labeled `'apply'`. **Refinement:** `write_latency_ms` in `WriteQueueMetrics`
  now summarizes WRITE-kind tasks only (previously it blended Phase-B applies in); a new
  additive `apply_latency_ms` block covers apply-kind, and counters gain
  `write_tasks_completed`/`apply_tasks_completed` (`tasks_completed` keeps the all-kind
  semantic). The deadline-admission estimator input is UNCHANGED (blended all-kind ring + raw
  depth — apply tasks occupy the slot too); the E_BUSY contract is untouched.

- Two-phase write split (2026-07-04 incident: "expensive compute must not block writes").
  `memoryWritePhaseA`/`memoryWriteBatchPhaseA` run the entire write EXCEPT the embedding as a
  synchronous, ONNX-free body for the serial WriteQueue slot; the new `embed-pipeline.ts`
  (`schedulePendingEmbeds`, `applyEmbedding`) computes embeddings off-slot (worker thread) and
  applies `vec_node` + the deferred E8 near-dup in short follow-up queue tasks. Crash between
  phases is detected (`embedBacklogStats`) and healed (`healMissingVectors`, consumed by the
  memory-server periodic tick). `memoryWrite`/`memoryWriteBatch` remain as the synchronous
  composition (kill-switch `SOX_SYNC_EMBED=1`, read per call via `syncEmbedEnabled`).
  `enrichOnWrite.embedding` is now optional — when absent, near-dup is deferred and
  `near_dup: null` is returned. BL-186: `memoryCurate` global recluster now enqueues a full-pass
  `enrich` trigger row (`enqueueEnrichFull`/`hasPendingFullEnrich`) instead of running the full
  cluster pass synchronously on the queue slot; the return `{enqueued: true, seq}` is honest.
  Outbox producers/consumers (`enqueueIngest` et al.) and the BL-161 deterministic test provider
  are now exported from the package index.

## 0.2.1

### Patch Changes

- Real embeddings repair (BL-87/89): ship `fastembed`+`onnxruntime-node` as real runtime deps and bundle the embed worker (`embedWorker.js` was never emitted by esbuild — the root cause of the silent hash fallback). Adds loud-fail observability (`getEmbedHealth`/`warmupEmbed`/`last_embed_error` in `memory_ping`/`memory_stats`; FATAL on real-backend failure). Fresh installs now resolve real `bge-base-en-v1.5` embeddings (`embed_on_hash_fallback:false`).

## 0.2.0

### Minor Changes

- 05430d9: Publishing & distribution refactor — the system is now publishable, consumable, and reusable purely
  from `npm install`, and new bundles install the same way (BL-42/BL-43/BL-65/BL-34/BL-33/BL-38).

  - **All 12 `@adhd/sox-*` libs publish public** (`private:false` + `publishConfig.access:public`,
    `engines.node>=20`, `files:["dist"]`) so third parties can `npm i` and import the engine SDK (G3).
    API stability tiers documented in `docs/publishing/api-stability.md` (ADR-0005 / Q2).
  - **CLI is a self-contained esbuild bundle** with an in-package `bin` (`@adhd/sox-cli` →
    `soxe`), in-package `dist`/`files`/`engines`/`publishConfig`, and a bundled registry copy, so
    `npm i -g @adhd/sox-cli` works on a fresh machine with no checkout (G1; fixes BL-34).
  - **Extensions are self-contained bundles (Model A)** carrying zero `@adhd/sox-*` runtime deps;
    `memory-server`/`memory-cli`/`memory-flush`/`memory-daemon` migrated off bare `tsc` to esbuild
    (closes BL-38). Native addons (`better-sqlite3`, `sqlite-vec`) are declared as real runtime
    `dependencies` and installed via a new `npm-package:` install mode (tarball + `npm install`),
    the only path that can deliver transitive native deps to a fresh machine (G2).
  - **Registry portability:** `build-index` emits portable `npm-package:` locators under the
    `SOX_REGISTRY_PUBLISH` signal (was a dormant CDN branch); `check-registry-sync` mirrors it
    (BL-33). The content checksum remains the sole extension identity/integrity authority — the npm
    version only selects which bytes to fetch (ADR-0003 intact; ADR-0005 ratifies the coexistence).
  - **Born-publishable golden path:** `soxe init` scaffolds publish + fresh-machine-install-ready
    packages; a `check-publishable` gate forbids the `workspace:*`/`@adhd`-runtime-dep 404 class.

### Patch Changes

- Updated dependencies [05430d9]
  - @adhd/sox-memory-enrich@1.1.0
