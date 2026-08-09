# @adhd/sox-memory-core

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
