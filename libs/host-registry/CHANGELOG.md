# @adhd/sox-host-registry

## 0.6.0

### Minor Changes

- 54cc80c: Derive an agent-mcp catalog row's provider from the host surface it serves, never
  from the agent IR's logical Claude tier.

  `@adhd/sox-host-registry` — new `agentMcpHost` surface (`agent-mcp`, capability
  `agent-catalog`). `HostRenderer` gains an optional `providerFrom`, naming a sibling
  `render.<host>` whose `{provider, model}` a row inherits when its own render supplies
  neither — so agent-mcp serves whatever host actually runs the agent instead of
  minting a vendor default. `deriveProvider` no longer reads the agent IR's `model`
  tier, so a row can never silently become `type: 'anthropic'`; with no explicit render
  model/provider it now throws `AgentProviderUnderivableError` rather than defaulting
  to `claude-sonnet-4-5`. Codex drops its `?? ir.model` fallback to match.

  `@adhd/sox-install-engine` — `readAgentRenderInputs` (exported) resolves the host
  render override including `providerFrom` inheritance. New `renderAgentCatalogPayload`
  renders an `agent` into a catalog payload behind a single renderability gate, and new
  `AgentNotRenderableError` names the raw-passthrough case (no `agent` IR, no `render`):
  the apply branch and `--dry-run` both reach the renderer only when it is renderable,
  so a dry run cannot promise a rewrite apply would reject. New `reconcileAgentMcpCatalog`
  one-shot (`soxe reconcile-agent-mcp`) re-renders existing rows through the same
  `declarativeInstall` path — agent-catalog rows are not lockfile consumers, so
  `upgrade --all` cannot reach them — reporting non-renderable rows as
  `skipped: not-renderable` (never a failure) and manifestless rows as
  `skipped: no-local-manifest` (never deleted).

  `@adhd/sox-manifest` — **BREAKING**: `validate()` now requires that an `agent` with
  any entry in `install.hosts` declares a non-null object `render.<host>` for each of
  those hosts; a manifest listing a host it has no render for previously inherited
  another host's model silently and now fails validation. `agent-mcp` is added to the
  known hosts and the manifest schema.

## 0.5.0

### Minor Changes

- ac8bd94: opencode renderer emits `model:` from the per-host render override (`render.opencode.model`, a host model id such as `deepseek/deepseek-v4-flash`). Previously the opencode header never carried a model, so every rendered agent inherited the parent session's model at `task()` time — running the dispatcher on a pro model silently promoted all flash-tier subagents. The IR's logical tier (`sonnet`) is still never emitted for opencode, since opencode cannot resolve it.

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

## 0.3.1

### Patch Changes

- **telemetry**: the emitting role is derived structurally rather than from a literal (BL-577), so a process can no longer mislabel its own population.

  **install-engine**: refuses to overwrite host files it does not own unless `--force` (BL-569), and honors `--dry-run` on the declarative install path.

  **service-proxy**: a dead proxy backend can no longer let the smoke harness report success — the socket path is validated against the macOS `sun_path` 104-byte limit, which a nested scratch path silently exceeded.

  **mcp-runtime**, **host-registry**: path containment hardening and bounded wire buffers, plus floating internal dependency ranges (`workspace:^`).

## 0.3.0

### Minor Changes

- 32275f7: Additive: new opencode host surface.

  New `opencodeHost` export from a new `opencode.d.ts` module. New `McpConfig` interface (`keyPath`,
  `value` methods) re-exported as a type. `Surface` interface gains two optional fields
  (`mcpConfig?: McpConfig`, `postInstallHint?: string`). `CapabilityId` union widened with
  `'object-array-merge'` — treated as additive/minor per the standard ecosystem convention for
  widening a string-literal union that consumers write data into rather than exhaustively switch over;
  verified no in-repo exhaustive switch over `CapabilityId` breaks. `claude.d.ts`/`codex.d.ts`/
  `internal.d.ts` carry only `sox`→`soxe` comment rebrands plus documentation of the
  mcp-trust-sync behavior shipped elsewhere. No removed or narrowed export.

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
