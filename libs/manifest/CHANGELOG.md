# @adhd/sox-manifest

## 1.1.0

### Minor Changes

- 93371ce: agent-mcp renderer fidelity (ticket 7ef0ee2c; `docs/spec/agent-mcp-renderer-fidelity.md`): the catalog row now carries what the agent IR actually declares instead of a bare `{provider, mcpServers: {}, permissions: {}}`.

  **host-registry** — the agent-mcp renderer emits `nativeTooling.{fs,shell,dispatch,hitl}` explicitly (least privilege: a built-in the IR `tools` omit is disabled; IR `permission` read/edit/write/glob/grep rules become server-qualified `fs.<tool>` gate rules; `task` -> `dispatch`/`allowedAgents`; `question` -> `hitl`), selects `mcpServers` from the IR `tools` via `render.agent-mcp.toolMap` (a stdio entry that launches agent-mcp is dropped; literal secrets fail the render; `~/` and `${HOME}` expand), replaces the substring provider heuristic with a typed `deepseek|openai|anthropic` profile table (unknown vendor throws, `provider: null` = unbound row, `claudecli` gets `allowedBuiltinTools`, `temperature` is emitted, env values must be `ADHD_AGENT_` pointers), and returns an `AgentRenderReport` (`lost[]`, `warnings`) alongside the payload. **Behavior change:** a bash `permission` map with command-pattern rules cannot be enforced (the gate matches tool names only, ADR-0008 D5), so shell is disabled fail-closed unless the manifest sets `render.agent-mcp.nativeTooling.shell` or `acceptLoss: true`. New exports: `AgentRenderError`, `PROVIDER_PROFILES`, `CatalogProvider`, `CatalogNativeTooling`, `AgentRenderReport`, `AgentRenderLoss`.

  **install-engine** — one agent-mcp server per command (`AgentMcpSession` / `withAgentMcpSession`; previously one spawn per tool call), `fullDefinition` reads, `catalogUpsert` returns `{outcome: created|updated|unchanged, row, nulledMcpKeys}` and makes **no write call** when the stored managed fields already equal the render, nulls owned `mcpServers` keys the render no longer carries (and the welded `agent` launcher on pre-existing rows), and the ledger records `ownedMcpKeys`/`managedFields`/`rowDigest`. `reconcile-agent-mcp` compares every managed field of every row with a local manifest (the anthropic-only default is retired) from a single `agent_list fullDefinition:true`; `--dry-run` lists the changed fields and loss report, apply over a lossy row needs `--accept-loss`, `--include-missing` creates absent local agents, pre-apply row snapshots are written, and the resolved catalog DB path is printed first. New exports: `renderAgentCatalogRow`, `renderAgentMcpRow`, `listLocalAgentMcpExtensions`, `describeAgentMcpCatalog`.

  **manifest** — `validate` checks `render.agent-mcp` against a closed key set: provider shape (per-type keys, `ADHD_AGENT_` env pointers, temperature in [0,1]), native-tooling root hints (absolute fs/shell roots rejected), `mcpServers` hygiene (no literal secrets, no absolute host paths, no welded catalog DB env, no stdio entry that launches agent-mcp).

  The 21 `extensions/agents/*` manifests are migrated to the new `render.agent-mcp` shape (portable launch configs, `toolMap`, no welded `agent` server or absolute `/Users/` path).

- 50c2c65: Install/uninstall safety, host-attributed uninstall, and fail-closed agent-mcp web-tool rendering (tickets 6fd94192, 6c9fbf52, e46db6ed, e00c47bb).

  **manifest** — `validate` now rejects unknown keys in the `agent` block (closed key set `AGENT_IR_KEYS`, plus `AGENT_IR_TOOL_REF_KEYS` for symbolic tool refs); the JSON-schema `additionalProperties: false` was never executed before. `agent.steps` must be a positive integer. New exports: `AGENT_IR_KEYS`, `AGENT_IR_TOOL_REF_KEYS`.

  **install-engine** — install refuses an existing destination that no ledger entry owns, before any write (agent, skill and hook; BUG-028), and `--force` adopts it with a warning. Uninstall is host-attributed: `uninstall --host X` reverses only that host, shared targets survive until the last claiming host is removed (order-independent), and an unsafe uninstall raises `UninstallAbortedError`; project-scope ledger resolution is fixed. `ownership.json` saves are serialized with an O_EXCL lock file (`withFileLockSync`, `OwnershipLockTimeoutError`), fixing a lost-update race.

  **host-registry** — the agent-mcp renderer treats an explicit single web-tool deny with the sibling allowed as `nativeWebTools: false` (fail-closed) and records a `dropped` loss; an explicit `render.agent-mcp.nativeWebTools` override records `covered-by-override`. Both web tools denied with unspecified `tools` is closed too. Migration note: `docs/spec/agent-mcp-renderer-fidelity.md`.

  **cli** — `uninstall --host <h>` takes exactly one host; MCP project-sync and trust reversals use the host(s) actually being removed instead of the record's last writer; previously untraced catches now log, and `uninstall` reports aborts and any reversals already completed.

## 1.0.0

### Major Changes

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

## 0.3.0

### Minor Changes

- 32275f7: Additive: opencode host support in manifests, plus new validation-set exports.

  `ExtensionManifest.hosts?: Array<'claude' | 'codex'>` widened to `Array<'claude' | 'codex' |
'opencode'>` — an array-of-union widening on a field consumers write into when authoring a manifest,
  not one they narrow-match against; old manifests remain valid, new manifests may now legally include
  `'opencode'`. Four new top-level exports: `VALID_TYPES`, `VALID_RUNTIMES`, `VALID_HOOK_EVENTS` (all
  `Set<string>`), and `KNOWN_HOSTS: Set<string>`. No removed or narrowed export — minor.

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
