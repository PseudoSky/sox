# @adhd/sox-service-proxy

## 0.4.2

### Patch Changes

- fix(embedding-provider): the funnel host survives an `embedding.reset` and never reaps over in-flight work; the idle bound is typed config.

  `embedHostMain` now resolves `getPrivateFastembedProcess()` at **every** use — a captured reference was terminated by `embedding.reset`, so every later request failed with `shared fastembed process terminated`. The self-reap now gates on the host's own request depth (incremented before the first `await`, decremented in `finally`) instead of the private pool's `pendingCount`, which misses the cold-start fork prefix. `EmbeddingProviderConfig.idleGraceMs` is now the typed surface for the idle bound (default 30 s); the spawner forwards the resolved value to the spawned host via the internal `SOX_EMBED_HOST_IDLE_GRACE_MS` transport.

  `@adhd/sox-service-proxy` guards the optional `onClientCountChange` hook so a throwing observer cannot crash the connection callback.

  Teeth (`embed-funnel.spec.ts`): reset→init+embed (shared + private), mid-work reap survival, a non-default typed grace taking effect, and `terminate()`-is-a-no-op.

## 0.4.1

### Patch Changes

- ce4e16d: feat(embedding-provider): peer-spawned, self-reaping embedding funnel — N consumer processes share ONE
  ONNX host per `(model, execution-provider, cacheDir)`, with no supervised daemon (ADR-0020).

  `getSharedFastembedProcess()` is now host-aware. By default (`host: 'shared'`) it returns a
  `FunneledFastembedClient` that lazily dials — and, when absent, peer-spawns via `ensureBackend()`'s
  O_EXCL singleton spawn-lock — one detached `embedHostMain` process. The host forwards `embedding.*`
  payloads to its private pool and **reaps itself**: a debounced, ref-counted teardown keyed on live UDS
  client connections (`serveBackend`'s new `onClientCountChange` hook) plus in-flight `pendingCount`
  exits the host `IDLE_GRACE_MS` after the last client leaves. It is compute-only (ADR-0012) — no store
  connection — and never supervised.

  Honest failure: under `host: 'shared'` a failed ensure throws a typed `TransientEmbeddingError` and
  forks **zero** hosts; it never silently falls back to a private host. `terminate()` is a no-op for a
  shared host; `resetSharedFastembedHost()` is the heal path. Host selection is the typed
  `EmbeddingProviderConfig.host` closed union (default `'shared'`, reported in `health().host`), never an
  env toggle (ADR-0013).

  The eager factory warmup is removed, so `createEmbeddingProvider()` is inert — it loads no model and
  spawns no host until the first real embed. A read-only verb therefore spawns zero hosts. The
  25–50× Neural-Engine contention claim is reworded to hypothesis framing (it was never proven; the
  measured cause of the live slowdown was scheduling QoS).

  Teeth (`embed-funnel.spec.ts`): 5 concurrent consumer processes collapse to exactly one host (negative
  control: the pre-fix/private path forks 5 — the headline test goes RED against it); debounce-reuse of
  the same host pid; rendezvous race; crash + stale-socket recovery; no-silent-re-fork; `lsof` proves the
  host holds no store-db handle; provider construction spawns zero hosts.

  `@adhd/sox-service-proxy` gains the optional `ServeBackendOptions.onClientCountChange` lifecycle hook
  (the live client-connection count on every connect/disconnect). Additive and observational — every
  existing caller is unchanged.

## 0.4.0

### Minor Changes

- 884e3e7: Public API surface changed since the last publish.

  Each of these packages has `dist/*.d.ts` differing from the version currently on
  npm, with no changeset recording it — the drift the `check-changeset-surface` gate
  exists to catch. This changeset records it and ships the accumulated surface.

  The READMEs shipped alongside are rewritten and verified: every documented symbol
  is checked against that package's own built declarations, and every example is one
  that was executed against the built artifact.

  `@adhd/sox-memory-core` also corrects three source comments that asserted ADR-0007's
  single-writer architecture as current fact. ADR-0012 supersedes it — the default
  Turso backend runs `multiprocess-wal`, where multiple processes hold concurrent
  write connections to one store file, serialized through a `-tshm` coordinator, with
  no opt-out. Because those comments are emitted into the shipped `.d.ts`, the false
  claim was visible in consumers' editor tooltips.

### Patch Changes

- Updated dependencies [884e3e7]
  - @adhd/sox-listen-guard@0.1.1

## 0.3.1

### Patch Changes

- **telemetry**: the emitting role is derived structurally rather than from a literal (BL-577), so a process can no longer mislabel its own population.

  **install-engine**: refuses to overwrite host files it does not own unless `--force` (BL-569), and honors `--dry-run` on the declarative install path.

  **service-proxy**: a dead proxy backend can no longer let the smoke harness report success — the socket path is validated against the macOS `sun_path` 104-byte limit, which a nested scratch path silently exceeded.

  **mcp-runtime**, **host-registry**: path containment hardening and bounded wire buffers, plus floating internal dependency ranges (`workspace:^`).

## 0.3.0

### Minor Changes

- 32275f7: Additive: client-context propagation, socket activation, and handshake helper (BL-62, SA-3, SA-4).

  New `ClientContext` interface (`{ project_path: string }`, BL-62) re-exported from `index.d.ts`.
  `ServeBackendOptions` gains optional `inheritFd?: number` (SA-3, socket activation). New `handshakeBackend(socketPath,
timeoutMs?): Promise<boolean>` export (SA-4). `FrontShimOptions` gains optional `httpPort?: number`
  and `clientProjectPath?: string`. No removed or narrowed export.

  **Behavior note, does not change the bump:** `serveBackend`'s stale-socket handling changed from
  "always unlink a stale socket file before bind" to "probe-connect first; refuse with a structured
  `E_LIVE_SOCKET` error if the socket answers" (SA-4 hardening) — a real new failure mode for any
  caller not already going through `ensureBackend()`, which the docstring now says is the required
  entry point. This is invisible to a `.d.ts` diff (still `Promise<BackendHandle>`, just may now reject
  with a new error shape at runtime) and is out of this gate's detection scope. Flagged here so callers
  bypassing `ensureBackend()` know to check for the new `E_LIVE_SOCKET` rejection path.

## 0.2.0

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
