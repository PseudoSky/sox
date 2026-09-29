# @adhd/sox-install-engine

## 0.5.0

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

### Patch Changes

- fdd0566: Backend Unix sockets are only bound or dialed inside a verified-private directory
  (BL-4041c6e0). The tier-3 socket path for an over-long socket directory is now
  `/tmp/sox-<uid>/p-<16hex>.sock` — fixed and TMPDIR-independent, so every peer
  derives the same path — instead of `$TMPDIR/sox-uds/…` or `/tmp/s-<hex>.sock`.
  `serveBackend` creates the directory 0700 and refuses (`E_UDS_DIR_UNSAFE`, no
  bind) when it is a symlink, not a directory, owned by another uid, group/other
  writable, or — for the `/tmp/sox-<uid>` root — not exactly 0700. `dialBackend`,
  `probeSocketLive`, `handshakeBackend` and `ensureBackend` refuse to connect into
  such a directory; the refusal is non-retryable (no re-dial, `ensureBackend`
  returns `errorCode: 'E_UDS_DIR_UNSAFE'`, the embedding funnel raises a
  `PermanentEmbeddingError`). New exports: `udsFallbackRoot`,
  `ensurePrivateSocketDir`, `assertPrivateSocketDir`, `isUdsDirUnsafeError`.

  Data-root directories are now created 0700 (`mkdirDataDir`), so they are private
  even under umask 002. `soxe` and the embedding funnel repair their own run dirs
  at start with the new `tightenOwnedSocketDir`: it removes group/other write
  through a single O_NOFOLLOW descriptor and skips anything it cannot prove is
  yours. An `E_UDS_DIR_UNSAFE` refusal now carries a `reason` (`foreign`,
  `own-writable`, `fallback-mode`) with a matching remediation, and no message
  suggests a recursive delete (BL-6233c1c2).

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

- 32275f7: Additive: mcp-trust-sync, object-array-merge capability, and lockfile/ownership extensions.

  New module `mcp-trust-sync.d.ts` (`syncMcpTrustToProjects`, `reverseMcpTrustFromProjects`, types
  `TrustSyncResult`, `SyncTrustOptions`) re-exported from `index.d.ts`. New capability module
  `capabilities/object-array-merge.d.ts` (entirely new file). `install.d.ts` gains `SCOPES: Scope[]`,
  `writeLockfileAtomic(lockPath, lockfile): void`, and `InstallDescriptor` gains four new optional
  fields (`configValues?`, `configEntries?`, `configIdentityField?`, `configIdentityValue?`);
  `DeclarativeInstallResult` gains optional `hints?: string[]`. `ledger.d.ts`'s `CapabilityId` union
  widened with `'object-array-merge'` (same union-widening treatment as `sox-host-registry`, ruled
  minor — verified no in-repo exhaustive switch breaks) and `LedgerAction` gains optional `meta?:
Record<string, unknown>`. `ownership.d.ts`'s `OwnedEntry` discriminated union gains two new tagged
  variants (`kind: 'object-array-values'`, `kind: 'os-unit'`) — additive, same reasoning — plus two new
  methods on the ownership index class (`static dedupeEntries`, `compact()`), both new, nothing
  removed. No removed or narrowed export found — minor.

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
