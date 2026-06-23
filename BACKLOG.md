# Backlog

Project backlog for sox-ecosystem. Each item: what's wrong, where, severity, and a fix sketch.
Observations below were surfaced during the sox-memory real-embedding / MCP-runtime work
(branches `feat/memory-real-embedding` → `fix/tokenguard-workspace-protocol` →
`fix/memory-server-c7-dedupe`, 2026-06-21).

---

> **Status (2026-06-22): BL-1 … BL-22 all resolved.** BL-23/24 are now **folded into the
> memory-enrichment plan** at `docs/plan/memory-enrichment/` (SPEC + DESIGN + CONSUMER-INTERFACES +
> CONTRACTS + IMPLEMENTATION) and tracked there per `IMPLEMENTATION.md §0` — they are resolved by its
> phases (P1–P6), not as loose items. The metadata-drop half of BL-23 is already fixed (`9728f6f`).
> **BL-21 (auto-export) and BL-22 (entity names) resolved by P5 (2026-06-22).**

## Resolved — observability gap + daemon down (2026-06-23, fixed fix/memory-server-bl45-48 1a5f1ed)

### BL-46 — production `serve` (stdio MCP) path captures NO logs — **Resolved**

**Discovered while trying to diagnose BL-45 from server logs.** The logs do not reflect the running version.

- The live memory-server is launched from `.mcp.json` as `soxe serve memory-server` (stdio). `cmdServe`
  (`apps/sox/src/main.ts:4441-4454`) runs `execFileSync(node, [entrypoint], { stdio: 'inherit' })` —
  **no LogManager, no `logDir`, no file logging.** stdout *is* the JSON-RPC channel (consumed by the
  MCP client); stderr is whatever the client does with it (typically not persisted).
- Therefore the running v1.1.0 stdio server writes **nothing** to `~/.sox/logs`. Every file under
  `~/.sox/logs/*/memory-server-*.log` is from a *different* path — the supervisor/e2e LogManager
  (`cmdStart` / loader with `logDir`) — and they are **stale**: all dated 2026-06-22, `serverInfo`
  version **1.0.0** (the live server reports **v1.1.0**, artifact `67c4112f4518` via `memory_ping`).
  Zero logs exist for 2026-06-23 despite heavy use.
- **Consequence:** reading `~/.sox/logs` to debug the live server is a trap — it shows an *older*
  version's behavior. There is effectively no runtime observability for the in-use MCP server: server
  errors, embed warmup failures, hash-fallback warnings, permission denials, and the daemon's
  `[memoryd]` output are not durably captured. The original BL-45 incident has **no logs at all**.
- **Latent footgun:** because `serve` inherits stdout, ANY stray `console.log` in the server's request
  path corrupts the JSON-RPC stream. Server diagnostics must never use stdout.

**Fix sketch:** give `cmdServe` an opt-in durable log sink for stderr (e.g.
`<logDir>/<extId>-serve-<date>.log` via the existing LogManager, stderr only — never stdout), or a
`SOX_SERVE_LOG` env/flag. At minimum, document that `~/.sox/logs` does NOT cover the stdio `serve`
path and stamp the served version into a discoverable place. Affected: `apps/sox/src/main.ts` (`cmdServe`),
`libs/host-runtime/src/log-manager.ts`.

### BL-47 — `memory-daemon` service is INACTIVE; async batch enrichment is not running — **Resolved**

`node bin/soxe list` shows `memory-daemon  user  INACTIVE`. The daemon is a `service` with
`lifecycle.background:true, singleton:true` (`members/memory-daemon/extension.json`) and owns the
async enrichment loop (`runBatchEnrich`: clustering E6, auto-links E9, importance link-score E7,
decay E11). With it down, write-path `nudgeDaemon()` connects to nothing (fails silently — the queue
is durable but never drained), so **clustering / auto-links / importance / decay never run** for the
live `~/.memory` store. The `memory_write` tool description still advertises "Batch enrichments …
run asynchronously in the daemon" — which is currently false at runtime. Fix: ensure the daemon is
started/supervised (and auto-restarted) wherever the memory MCP is used, or fold the batch loop into
the server process on an interval. Relates to BL-45 (the contention there only manifests *when* the
daemon runs).

### BL-48 — `SOX_EMBED_BACKEND` default `auto` silently falls back to hash embedding; the only signal is an uncaptured stderr warning — **Resolved**

Distinct from (but worsened by) BL-46. `embed()` defaults to backend `auto` (`embed.ts:72`): it tries
the real ONNX/BGE worker and, if the worker can't spawn or the model isn't available, **silently
falls back to deterministic hash embedding** (`embed.ts:255-265`) emitting only a `console.warn` to
**stderr** — which the production `serve` path does not persist (BL-46). If a write process used real
embeddings but a recall process falls back to hash (or vice versa), the query vector lives in a
different space and **semantic recall degrades to near-random while still returning non-empty
results** — easy to misdiagnose. NB: this is NOT the same as `provider_call_count` — that counter is
**designed to stay 0** on reads (local inference never increments it; see "agent misdiagnosis" below).
Fix: surface the resolved backend in `memory_stats`/`memory_ping` (already pinned in `memory_scope`),
and emit a durable warning (or hard-fail when `SOX_EMBED_BACKEND=real` is required) on fallback.

> **Agent misdiagnosis recorded (2026-06-23):** another agent claimed "the embedding provider is
> offline (`provider_call_count: 0` on every recall) — semantic recall silently returns empty."
> **Both halves are false.** `provider_call_count: 0` is the *designed* value (embed.ts:49-50: counts
> external HTTP/provider calls only; the local ONNX backend deliberately does not increment it).
> Live test this session: queries returned non-empty, correctly-ranked results with `provenance:["vec"]`
> / `["vec","fts"]` — semantic recall works. The low score magnitudes (~0.01–0.03) are **RRF** fusion
> scores (`recall.ts:212`, `1/(k+rank)`), not cosine — also normal, not weakness.

## Resolved — concurrent-write stall (2026-06-23, fixed fix/memory-server-bl45-48 1a5f1ed)

### BL-45 — concurrent `memory_write` batch stalls for minutes; daemon re-runs full O(n²) enrich on every nudge — **Resolved**

**Symptom (reported):** a single parallel batch of 7 `memory_write` calls appeared to hang ~15 min
(5/7 eventually returned, 2 cancelled); the same writes issued serially returned promptly.

**Investigation (2026-06-23, evidence-backed — original "write-lock/embedding serialization within
the write" hypothesis was DISPROVEN):**

- The MCP server (`memory-server`) uses **synchronous** `better-sqlite3` on a **single cached
  connection** (`getDb`, `index.ts:254-260`). There is no intra-server multi-writer contention, and
  SQLite ops serialize harmlessly on the event loop.
- The embedding path is **concurrency-safe**: probe of 7 concurrent vs serial `embed()` (real BGE/ONNX
  backend, warm) = 2.10s vs 2.11s (slowdown 0.99×). fastembed/onnxruntime serializes `run()`
  internally; no thread oversubscription. The embed worker has no concurrency guard but doesn't need one.
- The in-server write path (`memoryWrite`: `await embed` + sync tx + sync `enrichOnWrite` KNN-21 +
  non-blocking `nudgeDaemon`) is sub-second per call.
- **Root cause (proven):** the separate `memoryd` daemon runs a **full-corpus** `runBatchEnrich` on
  **every nudge** (every write nudges it; after a non-empty drain it immediately `scheduleLoop(0)`,
  `memoryd.ts:148`). `runBatchEnrich` → `clusterStore` is **O(n²)** (pairwise cosine,
  `cluster.ts:231-236`; the degenerate guard can re-run that pass up to 4×) plus a full-corpus
  importance recompute wrapped in one write transaction. **Measured: ~10.5–11.0s per pass at the
  current corpus of 2,209 live episodes** (probe on a copy of `~/.memory/memory.db`), growing
  quadratically.
- **Amplifier:** that batch pass holds the SQLite **write lock**. Because the MCP server's
  better-sqlite3 calls are synchronous, a write that loses the lock race **blocks the entire server
  event loop** up to `busy_timeout=5000ms` (`schema.ts:8`) — stalling *all* in-flight writes and their
  embed-worker response handling, not just the contending one. N concurrent writes serialize behind
  repeated ~11s full passes, each successful write triggering yet another pass → compounds to minutes.

**Confidence caveat (added 2026-06-23):** the daemon contention above is the cause **only when
memoryd is running**. Per BL-47, `memory-daemon` is currently **INACTIVE**, and there are no logs
from the incident (BL-46), so this mechanism is a **proven latent defect** (measured O(n²), ~11s/pass,
per-nudge full re-enrich) but is **not confirmed (unverified)** as the cause of the specific 7-write
stall. If the daemon was down during the incident, the stall was likely client-side (parallel
tool-call approval/queueing) and/or first-call cold model load, not daemon lock contention. Both the
latent defect and the daemon-state question need fixing regardless.

**Fix sketch (in priority order):**
1. **Incremental write-triggered clustering.** `cluster.ts` already has an `incrementalOnly` option
   (local-neighborhood check for new nodes). Route ingest-triggered enrich to incremental; reserve the
   full O(n²) re-cluster for a periodic/time-based trigger or explicit `memory_curate recluster`.
2. **Debounce/coalesce daemon passes.** Don't run one full `runBatchEnrich` per nudge — collapse a
   burst of ingest rows into a single pass and add a cooldown before the next full pass (the immediate
   `scheduleLoop(0)` after a non-empty batch is the back-to-back trigger).
3. **Chunk the importance transaction** so the daemon yields the write lock between chunks instead of
   holding it across all 2,209 episodes.

**Affected:** `libs/memory-enrich/src/{batch,cluster}.ts`, `libs/memory-core/src/memoryd.ts`,
`libs/memory-core/src/schema.ts` (busy_timeout). NB: any code change here triggers the full
build → `registry:sync-index` → `upgrade --all` sequence (CLAUDE.md agent sequence).

## Open — surfaced by the filtered-clustering review (2026-06-22)

> Deferred (non-blocking) findings from the architect + code review of branch
> `memory-enrich/filtered-clustering`. The merge-blocking findings (read-side scoping,
> structured-filter engine boundary, `nx.json` stale organizer, unreachable `'enrich'` op,
> done-on-failure, tags guard) are being fixed in the fix wave, not logged here.
> Full writeups: `docs/plan/filtered-clustering/REVIEW-architecture.md` + `REVIEW-code.md`.

### ~~BL-25~~ — three divergent `memoryd.ts` copies; member copies lack reembed-on-reindex — **Resolved** (`8a5246e`)

**Severity:** Medium (stale vectors) · **Status:** Resolved — converged all three onto `@adhd/sox-memory-core` (members are thin re-exports; single `MemoryDaemon`; reembed-on-reindex on the daemon path; C7-clean; e2e 63/0 proves the bundled daemon still spawns).
After P6, `memory-daemon`, `memory-server`, and `memory-core` each carry a `memoryd.ts`; the
member copies the daemon actually runs **lack the reembed-on-reindex path** that `memory-core`'s
copy has → vectors go stale after an embed-backend change. Fix: converge all three on
`@adhd/sox-memory-core` (the C7 single-source pattern) so there is one daemon implementation.

### ~~BL-26~~ — subset-lens communities have no GC / drop-by-hash reaper — **Resolved** (`8a5246e`)

**Severity:** Medium (unbounded accumulation) · **Status:** Resolved — added `dropSubsetLens`/`listSubsetLenses` in `@adhd/sox-memory-enrich` + `memory_curate` `drop_lens`/`list_lenses` ops (CONTRACTS C2.11); persisted lenses are now GC-able by provenance hash, leaving global + other lenses intact.
Persisting a filtered recluster (`memory_curate recluster` + `filters`, `dry_run:false`) writes a
provenance-scoped community slice keyed on the filter hash. Only an exact re-run of the *same*
filter reaps its prior slice — distinct/one-off filters leave orphaned subset communities that
accumulate with no reaper. Fix: add a `drop-by-hash` curation op (or a TTL/GC pass), or document
subset lenses as ephemeral with the accumulation caveat. Gated behind the persist path being
read-side-scoped first.

### ~~BL-27~~ — filtered-clustering review LOW findings (bundle) — **Resolved** (`8a5246e`)

**Severity:** Low · **Status:** Resolved — (1) empty-filter persist guard added; (2) dead branch removed from `computeClusters`; (3) server persist-path (`dry_run:false`) test added; (4) idempotent `organizer_queue` CHECK migration for `'enrich'`.
From `REVIEW-code.md`: (1) an empty-filter subset duplicates the global partition under a hash;
(2) dead branch at `libs/memory-enrich/src/cluster.ts:507-509`; (3) no server-level persist-path
(`dry_run:false`) test; (4) no migration for the `organizer_queue` CHECK-constraint change on
pre-existing DBs (`'enrich'` op added). Address opportunistically.

### ~~BL-28~~ — near-dup `SAME_AS` edge insert had a 7-col/8-value mismatch — **Resolved** (`06579d4`)

**Severity:** High (write-path crash) · **Status:** Resolved
`libs/memory-enrich/src/enrich.ts` inserted the near-dup `SAME_AS` edge with `INSERT INTO edge
(7 cols) SELECT … 8 values` (a spurious trailing `NULL`), throwing a SQLite column-count error on
**any near-duplicate write** under `enrichOnWrite`. No test exercised the path (the hash-backend
guard requires a shared MENTIONS entity, which `enrichOnWrite` alone never creates), so it slipped.
Fixed (removed the extra `NULL`) + added a real-backend regression test in `enrich.spec.ts` that
drives the `SAME_AS` insert. Found during the filtered-clustering review reconciliation.

### ~~BL-29~~ — intermittent embed-worker path flake under parallel vitest (`nx run-many test`) — **Resolved** (`8a5246e`)

**Severity:** Low (test-infra, intermittent) · **Status:** Resolved — `embedWorker.js` now resolves via a module-anchored absolute path (dist sibling, with a `src→dist` fallback), fork-cwd-independent. A separate pre-existing real-embed timeout flake in `write.spec.ts` (surfaced under the same run-many load) was also fixed by pinning the hash backend for those persistence tests.
Observed once during the `memory_update` engagement: running `memory-core` + `memory-server`
`test` targets together under a single `nx run-many` invocation intermittently fails with the
embed worker unable to resolve `embedWorker.js` (worker-thread path resolution under vitest's
parallel fork pool). **Not reproducible on re-run** (the same `run-many` is green), and all
sequential/CI gates pass. **This is NOT BL-4** (BL-4 is stale-`dist`/composite build hygiene) —
flagging the misattribution. Root-cause: the `new Worker(workerPath)` path in `embed.ts` resolves
relative to the built file; under parallel vitest forks the cwd/resolution can differ. Fix sketch:
resolve `embedWorker.js` via an absolute `import.meta.url`/`__dirname`-anchored path so it is
fork-cwd-independent. Low priority — only the parallel test runner is affected, not runtime.

### ~~BL-30~~ — `memory-server` manifest version stuck at 0.1.0 despite v1.1.0 tool surface — **Resolved** (this commit)

**Severity:** Low (version inconsistency) · **Status:** Resolved
The P4 and `memory_update` "version bumps" only touched the runtime `tool_version` string + the
source header comment — never the extension **manifest** `version`. So `extension.json` /
`package.json` read **0.1.0** while the tool surface + docs claimed **1.0.0 / 1.1.0**, and the
user-scope install resolved `memory-server@0.1.0`. Functionally harmless (upgrades are
checksum-driven, not version-driven), but a three-way inconsistency. Fixed: bumped
`memory-server` `extension.json` + `package.json` to **1.1.0**, the bundle `members[]` constraint
to `^1.1.0` (a `^0.1.0` constraint would have rejected 1.1.0), and the stale `tool_version: "1.0.0"`
line in CLAUDE.md → 1.1.0; resynced the registry. Surfaced when refreshing the user-scope install.

### ~~BL-31~~ — `sox stop` doesn't verify the kill or escalate to SIGKILL; orphaned daemons survive — **Resolved** (`b1d4005`)

**Severity:** High (zombie process can keep hitting a removed dependency) · **Status:** Resolved — `host-runtime/reaper.ts`: `killAndVerify` (SIGTERM → poll `process.kill(pid,0)` → SIGKILL escalation after grace → re-verify) + store-path orphan reaper (PPID-1, identity-matched, whitespace-bounded so unrelated processes are spared); `cmdStop` exits 1 on undead; `cmdStart` dedup-reap guard. e2e Step 7b reproduces the exact incident (real PPID-1 memory-server orphan DEAD after stop, unrelated SPARED). The original Open writeup follows.
During the memory upgrade, the running pre-P6 `memory-daemon` (pid 33079, started before the
store refresh) had been **orphaned (PPID 1 — its supervisor had exited)**. `sox stop
--id=memory-daemon` sent it **SIGTERM, reported "stop complete", and returned** — but the process
**never died** (its old-code shutdown path hung on in-flight LLM/LM-Studio requests, or ignored the
signal). `sox start` then spawned a *second* daemon (pid 43867) from the refreshed deterministic
store, leaving **two daemons** — the orphaned old one kept draining its organizer queue against
LM Studio (`localhost:1234`) until manually `kill -9`'d. Root gaps: (1) `stop` is fire-and-forget
SIGTERM with **no post-signal liveness check and no SIGTERM→SIGKILL escalation/timeout**; (2) the
runtime has **no reaper for orphaned daemons** — once the supervisor link breaks (PPID 1) it can
only signal a tracked pid and never confirms death or matches by store path (`.sox/ext/<id>`).
This is the failure mode the `runtime-productionization` SIGKILL-escalation / stale-state-GC work
targets, but it does not cover an already-orphaned process whose supervisor is gone. Fix: `stop`
must poll-verify exit and escalate to SIGKILL after a grace period; add a store-path-matched reaper
for orphaned daemons. Discovered diagnosing "a ton of requests going to LM Studio."

### ~~BL-32~~ — make per-extension versioning real (single-source propagation) — **Withdrawn** (superseded by ADR-0003)

**Status:** Withdrawn. Investigating BL-30 surfaced that per-extension semver is **vestigial** — the registry holds one build per id (semver never resolves), `semverSatisfies` arrived with the nx migration, and the checksum is the sole integrity authority. **ADR-0003** retires per-extension version entirely (identity = `id + checksum`), so "make versioning real" is moot. See `docs/decisions/0003-extension-identity-is-content-addressed.md`.

### BL-33 — `check-registry-sync.ts` scanner doesn't recurse into bundle members → false drift

**Severity:** Medium (false CI-gate failure) · **Status:** Open
`scripts/check-registry-sync.ts`'s inlined `findExtensionDirs` does **not** scan
`extensions/bundles/<id>/members/`, so it flags `memory-cli/daemon/flush/server/usage` as "in
registry, not on disk." Reproduces identically against HEAD (pre-ADR-0003) — a latent bug in the
`check-registry` gate's scanner, not in the run-many/test/e2e gate. Fix: make its scanner recurse
into `members/`, matching `scripts/build-index.ts`. Surfaced during the ADR-0003 implementation.

### BL-34 — `sox` app entrypoint path is not index-resolvable → checksum hashes `extension.json`

**Severity:** Low · **Status:** Open
The `sox` app declares entrypoint `dist/apps/sox/main.js`, which isn't resolvable relative to
`apps/sox/`, so `resolveChecksum` falls through to hashing the manifest (`extension.json`) instead
of the built artifact. Works (and correctly changed when ADR-0003 removed `version`), but the sox
entrypoint should be index-resolvable so its checksum tracks the *built* artifact like every other
code type. Surfaced during the ADR-0003 implementation.

### BL-35 — `install()` test runs pollute the real install-registry (no path injection)

**Severity:** Medium (test isolation; live ledger pollution) · **Status:** RESOLVED (2026-06-23)
Any spec that calls `install()` (e.g. `integrity.scope.spec.ts`) triggers `upsertInstallRecord`,
which uses `resolveInstallRegistryPath()` → `installRegistryPath()` → `dataRoot('user')` →
`$SOX_ECOSYSTEM_HOME`. The leaky specs (`integrity.scope.spec.ts` — `adr3-scope-*` roots,
`lifecycle.spec.ts`, `verify-integrity.spec.ts`) sandboxed `configPath`/`lockfilePath` but NOT
`SOX_ECOSYSTEM_HOME`, so the registry write escaped to the **real** `~/.adhd/sox-ecosystem/
install-registry.json` (observed grown to ~480 records).

**Permanent fix shipped (2026-06-23):** a suite-wide vitest `setupFiles`
(`libs/install-engine/vitest.setup.ts`) now points `$SOX_ECOSYSTEM_HOME` at a throwaway temp dir
for the whole install-engine test process — isolating the install-registry, ledger AND ownership
writes of every spec (including ones not yet written, so the leak cannot regress). Verified: a full
`nx test install-engine` run leaves the real registry record-count **unchanged (delta 0)**, 151/151
green. The one spec that asserts the genuine DEFAULT data root (`capabilities.spec.ts ›
defaultStoreRoot`) temporarily clears the override (string-only, no I/O). Defense-in-depth from the
same engagement: `knownProjectRoots()` skips any project root under `os.tmpdir()` (regression test
in `mcp-project-sync.spec.ts`), so even a stray leak can never fan `upgrade --force` out again. The
~480 leaked live records + 120 junk `/tmp` `.mcp.json` were purged as a one-off (registry → 6,
`memory-server` ownership → 2). Surfaced building `upgrade --all`; root-caused fixing the
migrate-home untracked-MCP-injection bug.

### BL-36 — runtime record hardcodes `type: 'mcp-server'` for every detached service

**Severity:** Low/Medium (misleading `sox list`/`status`; type unreliable) · **Status:** Open
`cmdStart`'s service-registry start path writes `type: 'mcp-server'` into the runtime record for
**every** detached service, so the runtime entry's `type` can't distinguish a `service` from an
`mcp-server`. `rollingRestartConsumer` works around it by classifying from the manifest, but
`sox list`/`status` may still mislabel services. Fix: record the real manifest `type` at start.
Surfaced building the rolling-restart classifier.

### ~~BL-37~~ — `memory-daemon` service-store copy can't resolve `@adhd/sox-memory-core` → crashes on start — **Resolved** (`b3bf0d8`)

**Severity:** High (the supervised daemon is fully down in service mode) · **Status:** Resolved — dual-output build: `tsc` keeps `dist/index.js` as the registry-checksum anchor + `tools/bundle-extension.cjs --entry src/bin.ts --outdir bundle` produces a self-contained esbuild bundle (native addons external, resolved via an injected `NODE_PATH=<workspaceRoot>/node_modules` in the run-service spec). A **second stacked bug** was found: the manifest entrypoint `dist/index.js` only re-exports — the real `daemon.start()` is `bin.ts`, so spawning `index.js` was a no-op that exited immediately (the "started then gone" symptom); bundling from `bin.ts` fixes it. e2e **Section E** now spawns the daemon from a **copied store** and asserts it starts + stays up. The original Open writeup follows.
BL-25 converged the daemon's `memoryd` onto `@adhd/sox-memory-core` (thin re-export →
`require('@adhd/sox-memory-core')`). The **service-mode copied store** (`.sox/ext/memory-daemon/`) has
no resolvable `@adhd/sox-memory-core` (not self-contained-bundled, no node_modules link), so the daemon
crashes on start: `Error: Cannot find module '@adhd/sox-memory-core'` (exits immediately; `sox list`
shows INACTIVE with a dead pid). **`memory-server` (stdio) is unaffected** — it runs from the repo
where the dep resolves. **Gate gap:** the lifecycle e2e spawns the daemon from the *repo* (deps
resolve), never from a copied service store, so this slipped all gates. Fix: self-contained-bundle
the daemon (esbuild, C7-respecting — the bundled-extension-build-standard) so the copied store has
zero external `@adhd/sox-*` deps, AND strengthen the e2e to spawn the daemon from a copied store.
Discovered starting the daemon during the content-addressed deploy.

### BL-38 — `memory-server` shares the daemon's latent `tsc`-bare-`@adhd/sox-*`-requires shape + a stale tracked `bundle/`

**Severity:** Low (latent; not on a copied-store path today) · **Status:** Open
Surfaced during the BL-37 fix. (1) `memory-server` builds with `tsc` and its `dist` carries bare
`require("@adhd/sox-memory-core")` etc. — it only resolves because it runs **stdio from the repo**
(`sox serve`), never from a copied store. If an `mcp-server` is ever materialized to a `.sox/ext/`
store it will crash exactly like the daemon did — give it the same self-contained `bundle-extension`
treatment then. (2) `memory-server` ships a **stale, orphaned tracked `bundle/`** dir from a one-off
bundler run; its `project.json` build uses `tsc` and nothing references the dir — dead tracked
output to delete + gitignore. Neither blocks anything today. **(2) RESOLVED** (`2867b4f`): the orphaned `bundle/` was untracked + gitignored (it was a 2.4MB dead artifact; runtime uses `dist` via `sox serve`); the BL-41 probe now builds a self-contained bundle on-demand. **(1) still open** — the latent `tsc`-bare-`@adhd/sox-*` shape (only matters if an mcp-server is ever materialized to a copied store).

### ~~BL-39~~ — `upgrade --all` / `install(mode:update)` re-pins the lockfile but does NOT re-materialize the copied service store — **Resolved** (`ca20ecf`, ADR-0004)

**Severity:** High (upgrade leaves a running service on stale code) · **Status:** Resolved — ADR-0004's ownership index drives `rematerializeServiceStores`: `update`/`upgrade` now clear the old store and re-copy the new artifact (previously only fresh install re-materialized). The original Open writeup follows.
A `type:service` extension runs from a **copied store** (`.sox/ext/<id>/`). `upgrade --all` (via
`install({mode:'update'})`) re-pins the lockfile checksum but **never re-copies the store**, so after
an upgrade the daemon keeps running the store copy from its **original** install. Observed live: post
`@sox`→`@adhd` rename + BL-37 fix, `upgrade --all` reported `memory-daemon user → upgraded` yet
`.sox/ext/memory-daemon/` still held the pre-rename `@sox` `dist` copy (`require("@sox/memory-core")`)
→ crash on start. Only a **fresh** install (`mode:default` — `uninstall`+`install`, or `install
sox-memory-bundle`) re-materialized the store (with the self-contained `bundle/`) → daemon then
started and stayed up. Root: the daemon's lockfile `source` is the **repo `dist/index.js`**
(checksum-current), so `verifyIntegrity` sees "current" and re-pins without re-copying; and the
checksum anchor tracks the repo `dist/`, not the materialized `bundle/` that's actually deployed.
This directly undermines the upgrade tooling's promise (refresh running code + rolling restart). Fix:
`install(mode:update)` must **re-materialize the service store** when the artifact changed, and the
service checksum anchor should track the materialized `bundle/`. Discovered deploying the daemon
post-rename. (Workaround applied for this deploy: `install sox-memory-bundle --scope=user`.)

### ~~BL-40~~ — `soxe install <mcp-server>` wrote `command: "sox"` (Homebrew audio-tool collision) — **Resolved** (`00e7f9e`)

**Severity:** High (silent MCP spawn failure) · **Status:** Resolved
`libs/install-engine/src/install.ts` fell back to `command: 'sox'` when `SOX_CLI_BIN` was unset, so
`soxe install <mcp-server> --scope=user` registered a spawn command of `sox` — which on macOS is the
Homebrew **audio** tool, not the extension CLI → the MCP server failed to spawn silently. Fixed:
`SOX_CLI_BIN ?? process.argv[1] ?? 'soxe'` (explicitly never `'sox'`), proven by e2e D5. Surfaced
diagnosing MCP global-availability.

### ~~BL-41~~ — `db_path` with a literal `~` is not expanded → creates a literal `~/` directory — **Resolved** (`2867b4f`)

**Severity:** Low/Medium (stray dirs; allowlist confusion) · **Status:** Resolved — single `expandDbPath()` applied at every memory-core sink (`openDb`/`openDbReadOnly`/daemon ctor) + once at memory-server dispatch, so guard + cache + sink agree; e2e Section BL41 proves `~/.memory/x.db` writes under `$HOME` with no literal `~` dir. The original Open writeup follows.
A `memory_*` call with `db_path: "~/.memory/memory.db"` (the literal string the skill docs show) is
**not tilde-expanded** by the server before `openDb` — so a literal `~` directory is created relative
to the server's cwd (observed: `extensions/.../memory-server/~/.memory/memory.db`). The server must
expand `~`→`$HOME` (consistently for the allowlist check AND the file open), or reject an unexpanded
`~`. Surfaced cleaning a stray artifact during the MCP-availability work.

### BL-42 — install model is checkout-bound: cannot publish packages or install on a fresh machine

**Severity:** High (distribution blocker — nothing installs off this one working copy) · **Status:** Open

Today every resolution path points at **this checkout on this machine**. A fresh machine
(or any consumer that didn't build the repo locally) cannot install or run a single extension.
Evidence (2026-06-23):

- **`registry/index.json` sources are absolute local `file://` URLs** —
  `file:///Users/nix/dev/ai/sox-ecosystem/extensions/...` for all 14 entries. The registry is
  not a portable/publishable artifact; on another machine those paths don't exist.
- **Lockfiles pin absolute local dist paths** —
  `~/.adhd/sox-ecosystem/extensions.lock` resolves `memory-server` →
  `file:///Users/nix/dev/ai/sox-ecosystem/.../dist/index.js`. Content-addressed identity
  (ADR-0003) is computed against locally-built `dist`, so a fresh machine has neither the
  artifact nor a way to fetch it.
- **MCP spawn command is an absolute repo path** — `~/.claude.json` →
  `mcpServers.memory-server.command = /Users/nix/dev/ai/sox-ecosystem/bin/soxe`. Won't exist
  on a fresh machine; there is no globally-installed `soxe` to fall back to.
- **Shipped extensions depend on `@adhd/sox-*` via `workspace:*`** (memory-server/cli/flush
  package.json). `workspace:*` only resolves inside the pnpm workspace; a published package
  carrying it 404s on `npm/pnpm install` (this exact failure already hit `@adhd/sox-tokenguard-core`
  — see the protocol fix `dabe9ea`). Self-contained esbuild bundling (BL-37/BL-38) inlines these
  for the *service* members, but the dependency-graph publish story is unsolved.
- **Root `package.json` is `"private": true`** and no `@adhd/sox-*` lib is actually published; the
  scope is owned but empty on npm.

**What "publishable + fresh-machine-installable" requires (fix sketch):**
1. **Decide the distribution substrate** — publish `@adhd/sox-*` libs + the `soxe` CLI to npm
   (changesets is already wired: `version-packages`/`release` scripts), OR ship fully self-contained
   bundles addressed by a fetchable URL/tarball, not `file://`.
2. **Make the registry portable** — `build-index` should emit relative or resolvable
   (registry-URL/tarball) sources, not absolute `file://` paths; add a publish step that uploads
   artifacts and rewrites sources.
3. **Rewrite `workspace:*` → real versions on publish** (changesets does this for libs; the
   extension members need the same, or must bundle their deps).
4. **Resolve the CLI command portably** — a globally-installed `soxe` (npm bin) or a per-install
   shim, so `mcpServers.*.command` is `soxe`/`npx soxe`, not an absolute repo path.
5. **Fresh-machine acceptance test** — `npm i -g @adhd/soxe` (or equivalent) → `soxe install
   sox-memory-bundle --scope user` → `memory_ping` green, in a container with **no repo checkout**.
   This is the reality gate; nothing is "publishable" until that passes.

**Versioning-system findings (2026-06-23, confirmed while writing `PUBLISHING.md`).** The publish
pipeline is Changesets (canonical — `.changeset/` + `@changesets/action` in `release.yml`, which
DOES rewrite `registry/index.json` sources to npm-CDN URLs post-publish, i.e. the fix for blocker
#1 above). The **safe, unambiguous defects are now fixed** (this turn):

- ✅ **Changeset tooling was non-functional** — `pnpm-workspace.yaml`'s `libs/**`/`apps/**`/
  `packages/**` recursed into gitignored `dist/` dirs whose build-emitted `package.json` (no `name`)
  made `@manypkg`/`changeset status` error out. Fixed by excluding `!**/dist/**` + `!**/node_modules/**`;
  `changeset status` now lists the 4 valid members.
- ✅ **Dual versioning systems** — removed the conflicting, CI-unused `nx.json` `release` block;
  Changesets is now the single source of truth.
- ✅ **Stale changesets** — removed the deleted `@adhd/sox-extension-memory-organizer` refs from
  `sox-memory-p0/p5.md`; deleted `hello-world-minor.md` (referenced non-existent
  `@adhd/sox-extension-hello-world`).

The remaining items are **strategy decisions**, split into **BL-43**.

Playbook + full confirmation: [`PUBLISHING.md`](./PUBLISHING.md) → *Current state*.

Surfaced answering "is there a backlog item about publishing for a fresh machine?" — there was not.

### BL-43 — publish-strategy decisions for `@adhd/sox-*` (libs, CLI, bundle members, first release)

**Severity:** High (gates BL-42 — nothing publishes until these are decided) · **Status:** Open

The mechanical publish defects are fixed (see BL-42). What remains are **decisions** that only the
owner can make, because they put code on the public `@adhd` npm scope:

1. **Libs: publish vs. bundle.** `@adhd/sox-authoring|-host-runtime|-install-engine|-manifest|
   -registry|-memory-core` are `private: true`, yet the public extensions depend on them via
   `workspace:*` → those deps **404 on publish**. Pick one, consistently:
   - **(a) Publish the libs** — flip `private:false` + add `publishConfig.access=public`; changesets
     rewrites `workspace:*` → the real version at publish. Exposes the engine internals on npm.
   - **(b) Bundle them** — esbuild-inline every `@adhd/sox-*` dep into each published extension (as
     BL-37/38 already do for the service members) so published artifacts carry **no** `@adhd/sox-*`
     runtime deps. Keeps libs private.
2. **CLI publishability.** `@adhd/sox-cli` (apps/sox) is `private: true` with no published `bin`. The
   fresh-machine entry point (`npm i -g @adhd/sox-cli` → `soxe …`) requires it published with a
   `bin: { soxe }` and an `engines.node` pin.
3. **Bundle-member publish model.** `memory-daemon` is `private: true` (internal to the bundle, no
   independent publish). Confirm this is intentional for ALL non-server members, and that the bundle
   artifact carries them — *then* no per-member changeset is needed (a daemon changeset was
   deliberately NOT added for this reason). Document the rule in `PUBLISHING.md`.
4. **First-release planning.** The surviving `sox-memory-p0/p5.md` changesets describe historical
   "stubs only / Phase N" churn and would bump `memory-server` (already manually at 1.1.0) with a
   misleading changelog. Before the first real publish, consolidate them into one coherent
   first-release changeset reflecting the CURRENT shipped state, not the phase history.

Acceptance: BL-42's fresh-machine container smoke passes.

### ~~BL-44~~ — `nx test` caching was dependency-blind: an upstream source change did NOT invalidate a dependent's test cache — **Resolved** (this turn)

**Severity:** High (cache lies — CI/local could report a stale green against changed upstream code) ·
**Status:** Resolved 2026-06-23.

All 15 `test` targets overrode `inputs` in their `project.json` with only their own
`{projectRoot}/src/**/*.ts` (+ a couple of hardcodes). Project-level `inputs` **replace** (do not
merge with) the `nx.json` targetDefaults `["default", "^production"]`, so every test target **dropped
`^production`** and had **no `dependsOn`** → the test cache was keyed on the project's own files only.
**Proven** (before fix): changed `libs/memory-core/src/index.ts` → `nx test memory-server` still served
a **cache hit**, although nx knows the `memory-server → memory-core` edge. The exact "cache lies"
hazard (cf. BL-4, MEMORY `eim-plan-cache-lies-reality-gates`). A change to `vitest.config.ts`/
`vitest.setup.ts` also didn't invalidate (those files weren't in the narrowed inputs).

**Fix (verified):**
- Set every test target's `inputs` to `["default", "^production"]` — `default` tracks the project's
  own files incl. vitest config/setup; `^production` tracks **upstream** sources. (install-engine keeps
  its extra `{workspaceRoot}/libs/host-runtime/src/data-paths.ts` parity reach-in — it has no nx graph
  edge to host-runtime.)
- Added `dependsOn: ["^build"]` to the `test` targetDefault so a test runs against **freshly-built**
  dependency `dist` (tests resolve `@adhd/sox-*` via a static `dist/index.js` alias — without this the
  invalidation was hollow: the re-run would execute stale dist). This also closes the BL-4 stale-dist
  hazard for tests.

Verified by reality probes: upstream src change → test re-runs (was a hit); `nx test memory-server`
now runs "test … and 4 tasks it depends on" (builds `memory-core` first); no-change → still a hit.

**Across-the-board hardening (follow-up, same turn).** A conformance audit found the same class of
defect in **`build`** targets: several declared a *hand-listed* `dependsOn: ["X:build"]` that
**replaces** the inherited graph-resolved `^build` and had **drifted incomplete** — e.g.
`memory-server` build listed only `memory-core:build` but the graph shows it also depends on
`memory-enrich`. Normalized **every** `build`/`test` target to the graph-resolved `^build`
(`nx build sox` now builds 6 dep tasks, not the 4 the hand-list named; `memory-server` 4). Fixed two
genuinely dep-blind tests the first pass missed (`manifest` — local `dependsOn: ["test-scripts"]`
shadowed `^build`; `packages/sox-nx` — outside the first sweep). Shipped the durable guards so it
cannot regress:
- **`docs/nx-cache-conformance.md`** — the principle (policy lives in `nx.json` targetDefaults;
  per-project `inputs`/`dependsOn` *replace* not merge; prefer `^build` over hand-listed deps).
- **`libs/authoring` bundle generator** — emits no narrowing per-target `inputs` (members inherit the
  dep-aware defaults); so new extensions are born conformant.
- **`tools/check-nx-cache.cjs`** (+ `pnpm check-nx-cache`, wired into `validate.yml`) — fails CI if any
  cacheable `build`/`test` target's **effective** (defaults-merged) config is dependency-blind. Now
  green: 19 project.json, all dependency-aware.
- Generalized finding stored to memory (`nx-cache-dependency-awareness`, episode `01KVVAJKNYEKSDJ…`).

> **BL-21, BL-22, BL-23, BL-24 are owned by `docs/plan/memory-enrichment/IMPLEMENTATION.md` (§0).**
> Each is resolved by a plan phase: BL-23 metadata = done (`9728f6f`); BL-23 project-path + BL-24
> tags/topic = P1; BL-24 clustering = P3; BL-22 entity-names + BL-21 auto-refresh = P5 (both done 2026-06-22).
> The detailed entries below remain as the original discovery context.

### BL-23 — `memory_write` drops `metadata` and records no caller provenance (project path)

**Severity:** Medium (provenance / data loss) · **Status:** Folded → memory-enrichment plan (metadata done `9728f6f`; project-path = P1)
`memory_write` accepts a `metadata?: Record<string, unknown>` param but **never persists it** —
it's referenced only in the `WriteParams` type, not in the node INSERT, so any caller-supplied
metadata (e.g. a project path) is silently discarded. The `node` table has `agent_id` +
`session_id` but **no column for the caller's project/repo path or cwd** — so there is no record
of *where* a memory came from. Fix: (a) stop silently dropping `metadata` (persist it, e.g. a
`meta` JSON column, or reject unknown fields loudly); (b) add a first-class caller provenance
field (project path / repo) captured at write time. Surfaced auditing DB vs the export docs.

### BL-24 — tags and the `[<topic>]` cluster are not first-class structured fields

**Severity:** Low/Medium (queryability) · **Status:** Folded → memory-enrichment plan (tags/topic = P1; clustering = P3)
Two related modelling gaps surfaced comparing DB vs docs:

- **Tags are lossy:** an agent's `tags[]` are converted to `entity` nodes + `MENTIONS` edges; the
  raw tag list is not retained on the episode and there is no `tags` column — so you can't query
  "episodes the author tagged X" distinct from organizer-extracted entities.
- **Topic/cluster is unstructured:** the `[<topic>]` prefix lives only inside `content`; there is
  no topic/cluster column. The BL-20 export parses it from text at export time (fragile,
  format-dependent) and the DB can't be queried/grouped by topic. Consider a structured
  `topic`/`cluster` field (or a `TOPIC`/`MEMBER_OF` edge to a topic node) set at write time from
  the `[<topic>]` prefix and/or tags, so clustering is durable and queryable, not derived.

### ~~BL-22~~ — memory export frontmatter lists entities by opaque uid, not name — **Resolved**

**Severity:** Low (export usability) · **Status:** Resolved — P5 (2026-06-22)
`collectMentionedEntities` now returns entity `name` fields (not uids). Entities without a name
are silently omitted. The topic derivation chain also uses entity names at every level. Verified
by real-store proof: `entities: typescript, strict-mode` (not `01KVRS4Q1S...`). Gates: `nx run-many
-t build lint test --projects=memory-core,memory-flush` 65/65 green.

### ~~BL-21~~ — memory markdown export is on-demand; not auto-refreshed as new memory is written — **Resolved**

**Severity:** Low (auditability / DX) · **Status:** Resolved — P5 (2026-06-22)
`memory-flush` `handleSessionEnd` now calls `tryAutoExport` after the flush+nudge, gated on
`export_enabled=true` AND `export_dir` being configured (default OFF — explicitly opt-in). The
export is throttled (default 60s, configurable via `export_throttle_secs`) and fully
failure-isolated (any export error is caught + logged; flush never breaks). Config injected via
`setExportConfig()` (module override for tests/startup) or `payload.export_config` from host.
Gates: 14 new tests in `index.spec.ts` covering gate/throttle/failure-isolation; `nx run-many
-t build lint test --projects=memory-core,memory-flush` 65/65 green.

### ~~BL-19~~ — `install` hard-fails on a single unresolvable config `install[]` entry — **Resolved**

**Severity:** Medium (install robustness / DX) · **Status:** Resolved (2026-06-22)
Both gaps fixed + tested: **(1) read-side resilience** — `install()` now **skips + warns** on an
unresolvable `install[]` entry and continues (both `libs/install-engine/src/install.ts` and the
legacy `scripts/install.ts` mirror); a single bad config line no longer aborts the whole install.
**(2) source guard** — `cmdInstall` rejects a reserved scope name (`user`/`project`/`local`/`org`)
as a positional id before writing it to the config, so the cruft can't be re-created. Regression
tests added: `cli-adapter.test.ts` (`install user` → exit≠0, "scope name") and `install.test.ts`
(valid+bogus config → valid installs, bogus skipped). Verified: scripts 257/257, e2e 63/63,
build+lint+typecheck. The live stray `{ "id": "user" }` was cleaned from `~/.config/...` during the
upgrade.

**Original (for history):**
Discovered while upgrading the user-scope install (2026-06-22): `~/.config/extensions/extensions.json`
contained a stray `{ "id": "user" }` in `install[]` (cruft from an older CLI version that captured
a scope value as a positional id). The result: `soxe install --scope=user` resolved all valid
entries (the whole `sox-memory-bundle`) and then **errored out entirely** on `cannot resolve
extension "user"`, so **none** of the valid upgrade was written until the bad entry was removed by
hand. A single bad config line blocks the entire install.

The **write-side is already fixed** — verified the current CLI does NOT add a scope value as an id
(`install --scope user`, `install -s user`, and `install <id> --scope user` all leave `install[]`
correct). The remaining gaps:

1. **Read-side resilience:** `install` should **skip + warn** on an unresolvable `install[]` entry
   (continue with the valid ones), not abort the whole operation.
2. **Defense in depth:** reject reserved scope names (`user`/`project`/`local`) as extension ids at
   config-write time, so this class of cruft can't be created.

(The stray `{ "id": "user" }` was cleaned from the live config as part of the upgrade.)

## Resolved (formerly Open)

### ~~BL-1~~ — `pnpm typecheck` exits 2 on latent tokenguard + scripts errors — **Resolved**

**Severity:** Low (code hygiene; no runtime impact) · **Status:** Resolved (2026-06-21)
Surfaced after the `@adhd/sox-tokenguard-core` workspace-protocol fix (`dabe9ea`) unmasked them.
**Verified fixed:** `pnpm typecheck` (root `tsc --noEmit`) now exits **0**; all nine cited
files are inside the compilation (`--listFilesOnly` confirms) and every cited error is gone
(e.g. `proxy.ts:309` now reads `(vs[0] ?? '')` — the prescribed `undefined` guard). The
mechanical fixes are realized in the working tree (tokenguard `cli.ts`/`mapstore.ts`/`proxy.ts`,
`scripts/new-extension.ts`, `scripts/check-registry-sync.ts) — **committed in`7a30ea5`.**

9 errors (historical):

*tokenguard source:*

- `extensions/services/tokenguard/src/cli.ts(23,1)` — TS6133 `'readline'` unused
- `extensions/services/tokenguard/src/mapstore.ts(32,10)` — TS6133 `'now'` unused
- `extensions/services/tokenguard/src/proxy.ts(170,19)` — TS6133 `'mapper'` unused
- `extensions/services/tokenguard/src/proxy.ts(170,27)` — TS6133 `'adapter'` unused
- `extensions/services/tokenguard/src/proxy.ts(309,19)` — TS2322 `string | string[] | undefined` not assignable to `string | string[]` (needs an undefined guard)

*repo scripts (unrelated to tokenguard):*

- `scripts/check-registry-sync.ts(35,7)` — TS6133 `'tmpRoot'` unused
- `scripts/check-registry-sync.ts(162,7)` — TS6133 `'liveJson'` unused
- `scripts/new-extension.ts(82,96)` — TS2366 function lacks ending return
- `scripts/new-extension.ts(281,91)` — TS2366 function lacks ending return

**Fix sketch:** remove unused declarations; add an `undefined` guard at `proxy.ts:309`;
add explicit returns (or `: void`/`undefined` return types) in `new-extension.ts`. All
mechanical, no behavior change. After: `pnpm typecheck` exits 0.

### ~~BL-2~~ — `embed.ts` real backend uses `bge-base-en-v1.5`, not the nominal nomic model — **Resolved**

**Severity:** Low (works; naming/quality) · **Status:** Resolved (2026-06-22)
`embed.ts` now carries an explicit comment at `EMBED_MODEL` clarifying it is the *hash-backend*
identifier and that `getActiveEmbedModel()` returns `bge-base-en-v1.5` for the real backend;
the module header documents the real model. The constant is retained for back-compat. Callers
must use `getActiveEmbedModel()`, not `EMBED_MODEL`, as the active-backend proxy.
The `EMBED_MODEL` constant historically read `nomic-embed-text-v1.5-hash`. The real backend
actually loads **bge-base-en-v1.5** (768-dim) because `fastembed` 2.x does not ship
nomic-v1.5. Verified semantically correct (cos(query,relevant)≈0.74–0.82 vs cos(query,unrelated)≈0.50).
If nomic is desired, swap to a lib/runtime that ships it at 768-dim and re-embed (the
`memory_scope.embed_model` pin already forces a clean reindex on model change).

### ~~BL-3~~ — `memory_recall` RRF temporal-recency can outrank semantic similarity for closely-timed writes — **Resolved**

**Severity:** Low (tuning) · **Status:** Resolved (2026-06-22)
`recall.ts` now applies per-signal RRF weights (`VEC_WEIGHT=1.0`, `FTS_WEIGHT=0.8`,
`TEMPORAL_WEIGHT=0.4`) instead of the implicit 1:1:1 — temporal is now a tiebreaker, not a
primary signal. Weights are overridable per-call via optional `vec_weight`/`fts_weight`/
`temporal_weight` params, so a caller can re-boost recency when desired.
Observed: with three docs written seconds apart, the most-recently-written (less relevant)
doc out-ranked an older, more-relevant doc, because the temporal component of the RRF fusion
dominated the tiny rank-based score deltas. Embeddings are correct; this is a fusion-weight
tuning question. Consider down-weighting recency relative to semantic rank, or widening the
score spread, when corpus writes cluster in time.

### ~~BL-4~~ — Local build hygiene: composite `tsc` leaves stale `dist`; trust `nx build`, not vitest aliases — **Resolved**

**Severity:** Low (dev ergonomics) · **Status:** Resolved (2026-06-22)
Documented in `CLAUDE.md` under "BUILD VIA NX TARGETS" → "Build vs. test hygiene (BL-4)":
composite `tsc` can leave a stale `dist`; vitest resolves `@adhd/sox-memory-core` to a static
`dist` alias so "tests pass" does not prove the runtime/MCP path; always `nx build memory-core
&& nx build memory-server` before memory tests. The nx-targets constraint also bans bare `tsc`.
`libs/memory-core` and the memory-server bundle use `composite: true`. A bare `tsc` after a
source change (or after `rm -rf dist`) can emit nothing because the `.tsbuildinfo` thinks
outputs are current — leaving a **stale `dist`**. `dist` is gitignored and the nx graph wires
`memory-server:build → dependsOn memory-core:build`, so a clean `nx build memory-server`
is correct. But: a vitest run (which transforms TS source, or uses a `resolve.alias` to
source) can PASS while the built `dist` is stale — so "tests pass" does **not** prove the
runtime/MCP path. Always verify runtime behavior against `nx build` output, not vitest.

### ~~BL-5~~ — `@adhd/sox-mcp-runtime` consolidation — **Resolved**

**Status:** Resolved. `memory-server` now uses `serve()` + `defineTool()` from `@adhd/sox-mcp-runtime`;
hand-rolled readline loop removed. Vendored `compilePolicyFromEnv` kept (standalone child process
cannot reach `@adhd/sox-host-runtime` at runtime). Type escape hatches removed; `handleToolCall`
returns `Promise<ToolResult>`, `TOOLS` typed as `Array<Omit<ToolDefinition, 'handler'>>`.

### ~~BL-6~~ — Verify the other sox-memory-bundle members build/run post workspace-glob widening — **Resolved**

**Severity:** Low · **Status:** Resolved (2026-06-22)
Verified cache-busted: `memory-daemon`, `memory-cli`, `memory-flush`, `memory-organizer` all
build clean and resolve `@adhd/sox-memory-core` (`nx run-many build --skip-nx-cache`, 6/6 incl.
core+server). Each member's `project.json` carries a `description` noting the verification.
The workspace-glob widening (`bec9914`) now links `@adhd/sox-memory-core` into all five members
(server/cli/flush/daemon/organizer). Only `memory-server` was deep-tested (build + real MCP
recall). Confirm `memory-cli`, `memory-flush`, `memory-daemon`, `memory-organizer` build and
resolve `@adhd/sox-memory-core` at runtime too.

### ~~BL-7~~ — `install` should persist the resolved scope so `serve` needs no `--scope` flag — **Resolved**

**Severity:** Medium (DX / correctness footgun) · **Status:** Resolved (2026-06-22)
`cmdServe` (`apps/sox/src/main.ts`, committed in `f4d3e48`) now resolves across scopes by
precedence — `SERVE_SCOPE_ORDER = project → user → org → local`, innermost wins — when no
`--scope` is given; an explicit `--scope` restricts to that scope. A user-scope install is
found by `sox serve <id>` with no flag; help text updated. Build+lint verified cache-busted.
**Remaining follow-up below is a manual config cleanup, not code.**
`soxe install --scope=user` writes the user-scope lockfile (`~/.config/extensions/extensions.lock`),
but `soxe serve <id>` defaults to `--scope=project` (cwd-rooted). So a user-scope-installed
extension is invisible to `serve` unless the caller *also* passes `--scope=user` — which means
the scope decision has to be re-stated at every invocation site (the `~/.claude.json` MCP
entry, `.mcp.json`, etc.). That conditional handling at install-time/launch files is exactly
what we want to avoid.

**Desired:** install should make the resolved scope self-describing so `serve` finds the
extension without a flag. Options to evaluate:

- `serve` resolves across scopes by precedence (project → user → org) instead of a single
  default scope, so a user-scope install is found automatically.
- and/or install records the scope in a stable, cwd-independent index (e.g. the
  `~/.sox`/`SOX_HOME` install-registry) that `serve` consults regardless of cwd.
- and/or install stamps the chosen scope into the generated launch/config artifact so no
  caller has to pass `--scope`.

**Follow-up — DONE (2026-06-22):** the `--scope=user` argument was removed from the global
MCP entry in `~/.claude.json` (`mcpServers."memory-server".args`) now that `soxe serve`
cascades scopes. BL-7 is fully closed (code + the manual config cleanup).

## Memory subsystem (`@adhd/sox-memory-core` + sox-memory-bundle)

Surfaced while migrating a 95-document research corpus into `~/.memory/memory.db` and exercising `memory_recall` via the live MCP (2026-06-21).

### ~~BL-8~~ — `memory_recall` default `token_budget` is far too small for document-scale nodes — **Resolved**

**Severity:** Medium (recall correctness) · **Status:** Resolved (2026-06-22)
`DEFAULT_TOKEN_BUDGET` raised 4000 → 32000 in `recall.ts`; the `memory_recall` schema default
in `memory-server/extension.json` updated to 32000. The budget guard is unchanged, so an
explicit small `token_budget` still stops early. Document-scale nodes no longer cap `limit:10`
recall at 1 result.
`memoryRecall` defaults `token_budget` to ~4000 (`recall.ts`), and `federatedRecall` to 4000. The assembler stops adding results once the budget is exceeded (`recall.ts:279`), so with document-sized nodes a single result fills the budget and recall returns **1 hit even when `limit` is 10**. Confirmed empirically: same query returned 1 result at default, 10 at `token_budget: 50000`. Fix: raise the default to a sane multi-result value, make it scale with `limit`, and/or document that callers must pass `token_budget`. The `limit` parameter is misleading while the budget silently caps below it.

### ~~BL-9~~ — No edge/link MCP tool; relationships require the organizer or raw SQL — **Resolved**

**Severity:** Medium (graph completeness) · **Status:** Resolved (2026-06-21)
A `memory_link` tool now exists (memory-server `src/index.ts:294` definition, `:620` handler),
creating directed edges between existing nodes (`DERIVED_FROM`, `SUPERSEDES`, `RELATES_TO`,
`SUPPORTS`, `MENTIONS`). Bulk importers can link chunks to their source document via the MCP
without the organizer or raw SQL. **Committed in `7a30ea5`.**

### ~~BL-10~~ — `initScope` records the `EMBED_MODEL` constant, not the active model — **Resolved**

**Severity:** Medium (bug — embed-model pin is wrong) · **Status:** Resolved (2026-06-22)
`initScope` (`db.ts`, committed in `7a30ea5`) now records `getActiveEmbedModel()` in both the
`memory_scope` INSERT and the returned object, so the scope pins the real active model
(`bge-base-en-v1.5`) instead of the frozen hash constant — restoring the re-embed-on-model-change
mechanism. (Caveat per the plan: if `initScope` runs before the first `embed()` resolves, the
pin is the hash value until the daemon's reindex updates it.)

### ~~BL-11~~ — In-process `embed()` + `better-sqlite3` crashes ("mutex lock failed") — **Resolved**

**Severity:** High (blocks programmatic/bulk ingest) · **Status:** Resolved (2026-06-21)
ONNX inference is now isolated in a worker thread (`libs/memory-core/src/embedWorker.ts`,
referenced from `embed.ts:92` and `index.ts:9-10` with explicit "resolves BL-11" notes), so
onnxruntime-node and better-sqlite3 no longer share the libpthread mutex that was corrupted
across the async boundary. The library is safe to call in-process (openDb → embed → memoryWrite).
**Committed in `7a30ea5`.**

### ~~BL-12~~ — `reembedNodes` is defined but not re-exported from the package index — **Resolved**

**Severity:** Low (API consistency) · **Status:** Resolved (2026-06-22)
`reembedNodes` added to the embedding export block in `libs/memory-core/src/index.ts`. Verified
from built dist: `typeof require('@adhd/sox-memory-core').reembedNodes === 'function'` (was `undefined`).

### ~~BL-13~~ — `memory_write` stores whole content as one node; no chunking + embedding truncation — **Resolved**

**Severity:** Medium (recall quality) · **Status:** Resolved (2026-06-21)
`memory_write` now chunks large content server-side: `splitIntoChunks()` (memory-server
`src/index.ts:360`) splits content exceeding `chunk_size` (param at `:198`, default ~500
tokens) at sentence boundaries, storing each chunk as a separate episode with a `DERIVED_FROM`
edge to the parent. Callers no longer need to pre-chunk document-sized input for usable
default-budget recall. **Committed in `7a30ea5`.**

### ~~BL-14~~ — `memory_recall` lacks result diversity (one verbose source crowds top-N) — **Resolved**

**Severity:** Medium (recall quality) · **Status:** Resolved (2026-06-22)
`recall.ts` result assembly now enforces a per-source diversity cap of
`max(2, ceil(limit/5))`, keyed on a stable per-source key, so one verbose document cannot fill
top-N — remaining slots fill from other sources. Documented as a diversity proxy (not full MMR,
which would need inter-candidate embedding distances).
After chunked ingest, a single long finding (`work-order-compiler`, many sections) had enough chunks that 3–4 of them filled the top-5 for unrelated queries, burying the genuinely most-relevant finding from another source (e.g. `plan-scheduling/dag-merging` ranked #4 for "parallel scheduling of dependent plan tasks", under work-order-compiler chunks). Add per-source diversity to recall — cap chunks-per-`original_path`/document, or apply MMR — so top-N spans distinct sources.

### ~~BL-15~~ — `serve` permission guard `db_path` allowlist is `~/.memory/**` only — **Resolved**

**Severity:** Low (note) · **Status:** Resolved (2026-06-22)
The `db_path` allowlist constraint is now documented for tool callers: `memory_write`/
`memory_recall` `db_path` properties in `memory-server/extension.json` carry a `description`
stating paths must be within `~/.memory/**` (else denied by the host guard, no side effects),
and `memory-server/CLAUDE.md` gains a "Permissions and db_path constraint" section with the
two escape hatches (reconfigure allowlist / symlink into `~/.memory/`).

## Authoring / CLI

### ~~BL-16~~ — `soxe init` accepts ids that `soxe validate` rejects; naming rules undocumented; re-evaluate the rule — **Resolved**

**Severity:** Medium (authoring DX / correctness) · **Status:** Resolved (2026-06-22)

1. **init/validate agreement (bug):** both init surfaces now fail fast on a non-conformant id,
   matching `soxe validate`. `cmdInit` (`apps/sox/src/main.ts`, the `soxe` path) uses the
   canonical `validateId` from `@adhd/sox-authoring` (pattern **and** no-type-suffix), exit 1 with a
   clear message; the legacy `scripts/new-extension.ts` (`bin/sox` path) suffix check was
   promoted from warn-only to a hard error (`idSuffixError`). Verified: `soxe init skill
   memory-skill` and `sox init skill memory-skill` both exit 1; `memory-usage` scaffolds.
2. **Documented:** id rules now appear in `init` usage + `--help` and in `docs/guidelines/bundle.md`.
3. **Decision (re-evaluate):** the no-type-suffix rule is **kept globally** (not relaxed for
   bundle members) — one uniform contract; member type is already explicit in `extension.json`
   and the `members/<id>/` path; the `memory-<function>` convention is more informative.
   Rationale recorded in `docs/guidelines/bundle.md`.
Three related problems, surfaced authoring the memory-usage skill as a bundle member:

4. **init/validate inconsistency (bug).** `soxe init skill memory-skill` **scaffolds
   successfully**, but `soxe validate` then **rejects** the result:
   `id "memory-skill" must not end with the type name "skill"`
   (`libs/authoring/src/index.ts:156`). `init` and `validate` must agree — `init` should
   reject (or auto-fix) a non-conformant id at scaffold time, not produce a born-INVALID
   extension. Today the author only learns the id is illegal after a full scaffold.

5. **Naming rules are undocumented.** The id contract (`^[a-z][a-z0-9-]*$` **and** must not
   end with the type name) lives only in code + a test; there is no author-facing doc, and
   `soxe init --help` shows only `init <type> <id>`. Document the id rules — and the bundle
   convention that members are named by **function** (`memory-server`/`memory-cli`), not by
   type — in the init help and an authoring guide, with examples + the rejection reason.

6. **Re-evaluate whether the "no type-name suffix" rule still makes sense under bundling.**
   The rule predates the bundle layout. Inside a bundle, members already live under
   `members/<id>/` with the type explicit in `extension.json`, so a suffix like `-skill` is
   arguably informative (it disambiguates a member's role in a mixed bundle), not redundant.
   Decide: keep globally, relax for bundle members, or drop. (Complied for now by naming the
   skill `memory-usage`, matching the `memory-<function>` sibling convention.)

### ~~BL-17~~ — bundle/config install does not host-place skill members (only the `--host` path does) — **Resolved**

**Severity:** Medium (install correctness) · **Status:** Resolved (2026-06-22)
Fixed in `d874926`: after `install()` writes the lockfile, the config/no-`--host` path now
host-places every resolved extension whose manifest declares `install.hosts` (skill/agent/
command members), via a shared `hostPlaceExtension()` helper also used by the `--host` path
(single placement implementation). Runtime types (service/bundle) are skipped. Net:
`soxe install --scope=user` of a bundle now deploys its skill members per `install.hosts`,
not just the lockfile. Verified: nx build sox + lint + typecheck; the no-`--host` path stays
green in `host-runtime:test-e2e` (63/63).
`soxe install --scope=user --update` (the config/lockfile path used to "upgrade a bundle")
**resolves** a bundle's skill member into the lockfile but does **not** host-place it — after
upgrading `sox-memory-bundle` with the new `memory-usage` skill member, the skill was written
to the lockfile (`memory-usage/SKILL.md`) but **not** dropped into `~/.claude/skills/`, so it
was not loadable. Host file-drop only happens on the **declarative `--host` path**
(`sox install <id> --host=claude --scope=user`, `main.ts:631`). Net: upgrading a bundle does
not deploy its skill members; a separate per-member `--host` install is required (the workaround
used here). Fix: the config/bundle install should host-place every member per its
`install.hosts` (so `install --update` of a bundle deploys skills/agents/commands too), or this
two-step requirement must be documented. Closely related to BL-7 (scope/placement semantics).

### ~~BL-18~~ — `memory-organizer` is a member dir + install-registry record but absent from the bundle manifest `members[]` — **Resolved**

**Severity:** Low (manifest/registry consistency) · **Status:** Resolved (2026-06-22)
Resolved by **including** the organizer in the bundle (intent confirmed: the daemon calls it and
BL-9/BL-13 graph work depends on its extract-link-consolidate pass). Added
`{ "id": "memory-organizer", "version": "^0.1.0" }` to `members[]` (now 6 members) and rewrote the
bundle `description` to list all six (organizer + the previously-omitted memory-usage). The
organizer's manifest already passes strict validate (author/keywords/invocation present, no
lifecycle). v2-e2e member-count assertion updated 5→6. `install sox-memory-bundle` now deploys
the organizer, reconciling the manifest with the install-registry record.

**Original (for history):**
**Severity:** Low (manifest/registry consistency) · **Status:** ~~Open / needs-decision~~
`extensions/bundles/sox-memory-bundle/members/memory-organizer/` exists on disk and appears in
`~/.sox`-side `install-registry.json`, but the bundle manifest's `members[]` lists only
`memory-daemon`, `memory-server`, `memory-flush`, `memory-cli` (and now `memory-usage`) — **not**
`memory-organizer`. The bundle `description` likewise omits it. So `install sox-memory-bundle`
does not deploy the organizer, yet a stale/older install path left it in the install-registry.
**Decide intent:**

- If the organizer **should** ship with the bundle (it builds the graph / does extract-link-
  consolidate, which BL-9/BL-13 rely on), add `{ "id": "memory-organizer", "version": "^0.1.0" }`
  to `members[]` and update the description — note this makes every bundle install also deploy/run
  the organizer daemon (a behavior change, hence not done unilaterally here).
- If it is intentionally **out** of the bundle (optional/experimental, installed separately),
  document why, and reconcile the stale `install-registry.json` record so the registry stops
  advertising a member the manifest doesn't ship.

Either way, manifest ↔ member-dirs ↔ install-registry should be made consistent (a
`check-registry-sync`-style assertion could enforce it).

### ~~BL-20~~ — no DB→markdown export mirror for memory written directly via `memory_write` — **Resolved**

**Severity:** Low (auditability) · **Status:** Resolved (2026-06-22)
*(Renumbered from a duplicate BL-19 — the install-resilience BL-19 below has code/test references.)*

**Resolved:** added a DB→markdown export mirror — `exportMarkdown()` in
`libs/memory-core/src/export.ts`, surfaced as `memory export` in memory-cli.

- **Enable/disable:** `export_enabled` config (default **on**).
- **Configurable dir:** `export_dir` config — default scope-relative (`~/.memory/export` for
  user scope), overridable; the **user-scope install is set to `/Users/nix/dev/ai/memory`**.
- **Topic-based, indexed layout:** `<dir>/topics/<slug>/<uid>.md` (YAML frontmatter + content),
  a root `INDEX.md` (topics + counts + links) and per-topic `INDEX.md`. Topic precedence:
  explicit `[<topic>]` content prefix (the corpus convention — moved the real db from 871/919
  "general" → 96, across 32 topics) > organizer `community` > `MENTIONS` entity > `general`.
  Idempotent, with **move-aware pruning** (a re-categorised node's stale copy is removed, not
  just dead uids). Verified live against `~/.memory/memory.db` (919 nodes → 32 topics);
  `principles/` left untouched. Tests in `export.spec.ts` (26 memory-core tests green).

**Original (for history):**
The research-corpus migration ingested 95 markdown findings into `~/.memory/memory.db` (823
chunked nodes). The original markdown files remain as the human-readable/git-reviewable mirror,
but they are now a **snapshot**: any finding written *directly* via `memory_write` going forward
(e.g. by `workflow-researcher`) has **no** markdown representation — so the DB silently diverges
from the mirror, and there is no git-reviewable record of new knowledge. Add a `memory-export`
step (a `memory-cli` subcommand or organizer pass) that renders MCP-written nodes back to
markdown keyed by `uid`, so the mirror stays current and memory changes remain auditable in git.
Deferred from the migration (DB-as-truth was chosen; the export-back half was not built).
**Verified fixed:** `exportMarkdown` added to `libs/memory-core/src/export.ts`; `memory export`
subcommand added to `memory-cli`; user-scope `~/.config/extensions/extensions.json` sets
`export_dir: /Users/nix/dev/ai/memory`; real export of 919 nodes across 48 topics confirmed;
`principles/` folder untouched; build/lint/test/typecheck/registry-sync all green.

---

## Resolved (this engagement)

- **Embedding was a hash stub (ADR audit A6)** → configurable backend (`auto|real|hash`),
  real = in-process fastembed bge-base-768 auto-downloaded to a global cache. (`f7ba7c4`, `ccff191`)
- **`pnpm install` 404 on `@adhd/sox-tokenguard-core`** → `workspace:*` protocol. (`dabe9ea`)
- **memory-server MCP fell back to hash at runtime** → workspace-glob widening links the
  bundle members so `@adhd/sox-memory-core` resolves; verified real semantic recall over the
  MCP stdio path. (`bec9914`, C7 dedupe `8c96865`)
