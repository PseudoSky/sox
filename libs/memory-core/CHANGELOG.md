# @adhd/sox-memory-core

## 0.3.0

### Minor Changes

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
