# @adhd/sox-mcp-runtime

## 0.3.1

### Patch Changes

- **telemetry**: the emitting role is derived structurally rather than from a literal (BL-577), so a process can no longer mislabel its own population.

  **install-engine**: refuses to overwrite host files it does not own unless `--force` (BL-569), and honors `--dry-run` on the declarative install path.

  **service-proxy**: a dead proxy backend can no longer let the smoke harness report success — the socket path is validated against the macOS `sun_path` 104-byte limit, which a nested scratch path silently exceeded.

  **mcp-runtime**, **host-registry**: path containment hardening and bounded wire buffers, plus floating internal dependency ranges (`workspace:^`).

- Updated dependencies
- Updated dependencies
  - @adhd/sox-host-runtime@0.4.0
  - @adhd/sox-telemetry@0.2.1
  - @adhd/sox-service-proxy@0.3.1

## 0.3.0

### Minor Changes

- 32275f7: Additive: multi-transport support (stdio/uds/http/sse).

  `serves` tuple widened `readonly ["stdio", "sse"]` → `readonly ["stdio", "sse", "http"]`.
  `TransportMode` union widened `'stdio' | 'sse'` → `'stdio' | 'uds' | 'http' | 'sse'`.
  `TransportOptions` gains 4 optional fields (`transports?`, `bindAddress?`, `socketPath?`,
  `authToken?`); `mode?`/`port?`/`host?` retained unchanged. `TransportHandle` gains optional
  `socketPath?`. New exports: `buildToolDispatch`, `connectStreamableHttp`, `connectUds`,
  `connectStdioTransport`, `resolveTransports`, `validateBindAuth`, `authMiddleware`, `isLoopback`,
  `resolveBindHost`, new type `ToolDispatch`.

  `connectSse` changes from `export declare function connectSse(server: Server, opts?:
TransportOptions): Promise<TransportHandle>;` to `export declare const connectSse: typeof
connectStreamableHttp;` — `connectStreamableHttp`'s own declared signature is structurally
  identical (`(server: Server, opts?: TransportOptions): Promise<TransportHandle>`), so `import {
connectSse } from '@adhd/sox-mcp-runtime'; connectSse(server, opts)` compiles unchanged before and
  after. Not a breaking change; correctly marked `@deprecated` in the new JSDoc rather than removed.

  **Behavior note, does not change the bump:** the documented default HTTP port changed ("then 0
  (random)" → "then 3000") and the wire protocol served on that port changed from raw SSE (`GET /sse`,
  `POST /message`) to StreamableHTTP session framing. This is a real runtime behavior change for
  anything depending on the old literal SSE endpoint shape, but it is invisible to a `.d.ts` diff (same
  declared function signature, different implementation) and is out of this gate's detection scope.
  Flagged here so dependents on the old SSE endpoint shape know to check before upgrading.

### Patch Changes

- Updated dependencies [32275f7]
- Updated dependencies [32275f7]
  - @adhd/sox-host-runtime@0.3.0
  - @adhd/sox-service-proxy@0.3.0

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
  - @adhd/sox-host-runtime@0.2.0
