# Changelog

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
