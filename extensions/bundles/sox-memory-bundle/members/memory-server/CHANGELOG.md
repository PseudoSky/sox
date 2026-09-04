# Changelog

## 1.3.3

### Patch Changes

- 884e3e7: Rewrite the package README against real, executed behaviour.

  These packages published to npm with READMEs that were missing, wrong, or unusable:
  no install line, no runnable example, and in several cases relative links pointing
  outside the package directory — dead for every npm reader, since a tarball carries
  only the package's own directory plus a force-included README and LICENSE.

  Every README now has an install line and at least one example that was actually run
  against the built artifact, with real output. Every documented symbol is verified to
  exist in that package's own declarations.

  Packages built on `@adhd/sox-store-adapter` now state the concurrency properties they
  inherit from it: the default Turso backend mandates `multiprocess-wal`, so multiple
  processes hold concurrent write connections to one store file. The claim is scoped
  per package rather than asserted blanket-wide — packages whose default path is
  single-writer by construction say so.

  Corrections found by reading and running the code rather than trusting the prose:
  `sox-graph-store` described itself as a store "over SQLite" when it has no
  better-sqlite3 dependency and is built on StoreAdapter; `sox-hybrid-search` described
  itself as an unimplemented skeleton when its implementation is complete;
  `sox-embedding-provider` advertised a hash provider that exists in no factory branch;
  and `sox-tokenguard-core` documented `detectFqdn` as returning `<FQDN_1>` when it
  returns `<HOST_1>`.

## 1.3.1

### Patch Changes

- `memory_recall` no longer pads results with null-content entity/community/session/generic node
  rows (BUG-MEMORY-003). Two SQL candidate-admission points in `@adhd/sox-memory-core`'s
  `memoryRecall()` had no `node.kind` predicate — the temporal channel, and the depth-1
  graph-expansion neighbor fetch that runs on every default-parameter call (tagged episodes have
  live `MENTIONS` edges to their own tag-created entity nodes). Results now default to
  `kind = 'episode'` only. Additive opt-in: `filters.kinds` (e.g.
  `filters: { kinds: ["episode", "entity"] }`) restores non-episode rows for callers that want
  them — both the tool schema (`filters.kinds`, array of strings) and `handleToolCall`'s filter-
  forwarding loop now thread the field through to `memoryRecall()`.

## 1.3.0

### Minor Changes

- `memory_update` two-phase by default (BL-189/BL-191): content/summary updates commit columns +
  FTS and delete the stale vector inside the queue slot, then re-embed OFF-slot via the
  instrumented Phase-B pipeline (`time_to_vector_ms`/`embed_duration_ms` now cover updates too).
  Response shape unchanged (`reembedded: true` = vector refresh triggered; it lands async —
  same eventual-consistency window as `memory_write`). `SOX_SYNC_EMBED=1` restores the fully
  synchronous behaviour. Behavioural delta: updated nodes now participate in deferred near-dup
  detection.

- `memory_write` chunking routed through the canonical `@adhd/sox-ingest` sentence chunker
  (S11/BL-165) — chunk boundaries byte-identical to the deleted local implementation
  (parity-spec'd in memory-core).

- Two-phase write observability (follow-on): `memory_ping.store` gains an additive
  `embed_pipeline` block — `{ backlog, backlog_oldest_at, metrics }` where `metrics` carries
  `time_to_vector_ms` (Phase-A commit → vec applied; how long a fresh write is BM25-only),
  `embed_duration_ms`, wall-clock `heal_lag_ms`, and monotonic Phase-B counters
  (`embeds_completed/failed`, `applies_applied/exists/gone`, `heals_applied/failed`);
  `metrics` is `null` until the first Phase-B activity for the store in this process. The
  existing top-level `embed_backlog`/`embed_backlog_oldest_at` fields are kept as-is and
  mirrored into the block (HF-3 additive rule). `store.write_queue` gains an additive
  `apply_latency_ms` block plus `write_tasks_completed`/`apply_tasks_completed` counters;
  `write_latency_ms` is now write-kind only (Phase-B apply tasks no longer dilute it — more
  honest, refinement noted per the WRITEQ metrics conventions).

- Two-phase write (2026-07-04 incident fix): `memory_write`/`memory_write_batch` hold the serial
  WriteQueue slot only for a synchronous, embedding-free Phase A; the ONNX embedding + vec insert
  - near-dup run asynchronously off-slot moments later. Caller-visible: `enrichment.near_dup` is
    `null` in write responses (SAME_AS edges land async); fresh episodes are keyword/temporal-
    recallable immediately and vector-recallable once Phase B lands; `memory_ping.store` gains
    additive `embed_backlog`/`embed_backlog_oldest_at` folded into the `enrichment` verdict
    (dead Phase-B pipeline reads `stalled`). The periodic enrich tick heals missing vectors
    (crash-between-phases recovery). Kill-switch: `SOX_SYNC_EMBED=1` restores the fully
    synchronous pre-split behaviour. BL-186: `memory_curate recluster` (global) now enqueues a
    full-pass trigger row consumed by the tick — `{enqueued: true, seq}` is honest and the tool
    call no longer blocks writes for the whole cluster pass. BL-188: `memory_write` now forwards
    `client_request_id` (WP-4 replay worked only through `memory_write_batch` before).

## 1.2.1

### Patch Changes

- Real embeddings repair (BL-87/89): ship `fastembed`+`onnxruntime-node` as real runtime deps and bundle the embed worker (`embedWorker.js` was never emitted by esbuild — the root cause of the silent hash fallback). Adds loud-fail observability (`getEmbedHealth`/`warmupEmbed`/`last_embed_error` in `memory_ping`/`memory_stats`; FATAL on real-backend failure). Fresh installs now resolve real `bge-base-en-v1.5` embeddings (`embed_on_hash_fallback:false`).

## 1.2.0

### Minor Changes

- de48db2: Slice 1.6 — M3→M4 default flip: front-shim proxy is now the DEFAULT for `mcp-server`
  services, and memory-server is flipped onto it with an auto-managed, singleton-guarded
  UDS backend.

  - `service-proxy`: new `ensureBackend` primitive — probe-then-spawn the backend detached,
    serialized by an O_EXCL spawn lock keyed on `[def:singleton-key]` (one backend per store,
    single-writer across many sessions' shims). `runFrontShim` gains an `ensure` hook (called
    on start + re-called on a dropped backend connection); `dialBackend` gains `onDisconnect`.
  - `memory-server`: runs as a persistent UDS backend under `SOX_PROXY_BACKEND=1` (`runBackend`
    wrapping the existing `TOOLS`+`handleToolCall` with `serveBackend`); publishes
    `dist/schema.json` (generated postbuild) so the shim serves `initialize`/`tools/list`
    instantly during a backend restart. Direct-stdio `serve()` stays as the opt-out hatch.
  - `cmdServe`: proxy default for `type: mcp-server`; explicit opt-out via `--no-proxy` /
    `lifecycle.serve_mode:"direct"` / `lifecycle.proxy:false` (CLI flag overrides manifest).
  - Upgrade: a proxy-mode `mcp-server` upgrade rolling-restarts the BACKEND (verified-stop +
    re-ensure on new code) and reports `backend-restarted` — the shims re-dial, NO client
    reconnect. Migration: exactly ONE final reconnect to swap the direct server for the shim.

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

## 0.1.0

- Initial release
