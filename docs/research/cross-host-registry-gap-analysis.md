# Cross-Host Agent/Skill/Provider Registry — Gap Analysis

**Date:** 2026-08-11
**Author:** agent-manager (analysis run 2026-08-11)
**Scope:** Evaluate the sox ecosystem as a centralized, versioned repository for
agents / skills / provider plugins — general versioned LLM tools installable
across Claude Code, opencode, and Codex.
**Status:** Research findings. No code changed.

---

## 1. Topology (verified)

The "sox ecosystem" is three repos plus one global CLI. They are *not* one system.

| Repo | Role | Artifact format | Registry mechanism |
|---|---|---|---|
| `~/dev/ai/claude-agents` | The **`sox` CLI** (`/Users/nix/dot/bin/sox` → symlink → `tools/sox.js`) + the live catalog (**88 agents, 36 skills**) | `plugin.json`-based (agents/skills/commands/hooks as plugin assets) | Marketplace index built **on demand from disk** (`tools/cli/index-mgmt.js`); `sox install <repo>` = `git clone` into PLUGINS_DIR; versions via `sox sync` |
| `~/dev/ai/sox-ecosystem` | The **engine** — libs `host-registry`, `install-engine`, `manifest`, `registry`, `source-provider`, `host-runtime` + the **`soxe`** extension CLI (`apps/sox/src/main.ts`, self-described "soxe CLI") | **Manifest v2** (`extension.json`: semver, closed type enum, host `compatibility`, `runtime`, `install.{type,hosts,profiles}`) | `registry/index.json` (17 entries) + `extensions/` (3 agents, 6 skills, 1 bundle, 1 command, 1 service, 0 hooks) with sha256 drift gate |
| `~/dev/ai/sox-protocol` | **Peer-messaging protocol** — channels/threads/presence/ACK-NACK, "speculative-execute-while-awaiting" | `spec/*` + multi-language SDKs (Python shipped; TS/Rust open) | **Orthogonal** to artifact distribution — not a registry concern |

Also: `sox state` (`.cto/` ticket state machine), `sox supervisor/program/watch` (daemon
lifecycle), `sox hooks` (swarm-cost hooks) — all in claude-agents' CLI; and
`~/Library/LaunchAgents/com.sox.user.{memory-server,doctor-tick}.plist` runtimes.

---

## 2. What is implemented (verified from source)

### 2.1 Manifest / versioning — REAL
`libs/manifest/src/schema.json` (`$id …extension/v2.json`) is a genuine extension
manifest: `id` (immutable slug), `version` (semver pattern), closed `type` enum
(`agent, skill, mcp-server, service, prompt, hook, command, bundle`), `compatibility`,
`runtime` (`node|shell|python|declarative|stdio-any`), `entrypoint` (resolved at
install), `install.{type,hosts,profiles,transport,serves}`. `KNOWN_HOSTS =
['claude','codex','opencode']`. 1,013-line lib + 1,326-line spec.

### 2.2 Host abstraction — REAL
`libs/host-registry/src/{claude,codex,opencode}.ts` implement the `HostModule`
contract (detect / scopePaths / surfaces). Scope map:
- **claude** — surfaces: agent, skill, command, rules, hook, plugin, settings,
  service, permissions (`.claude/`, `~/.claude/`, `.claude.json`, settings.json).
- **opencode** — agent/skill/command file-drop (`.opencode/…`, `~/.config/opencode/…`),
  mcp-server config-merge (JSON, `mcp.{id}`, `type:"remote"` verified against real
  traffic), service run-service.
- **codex** — skill file-drop (`~/.codex/skills/`, verified against binary strings of
  `@openai/codex 0.139.0`), agent **config-merge TOML** (`[agents.<name>]` in
  `~/.codex/config.toml`), mcp-server (`mcp_servers`, no `type` field — verified),
  `claude-md` → `AGENTS.md`, and **project-forbidden keys** (`model_providers`,
  `notify`, `profile`, `otel` — `[inv:never-managed]`).

Per-host MCP config builders handle the three incompatible transport schemas
(Claude `http/sse`, opencode `remote`, codex none) — documented "none generalizes."

### 2.3 Install engine — REAL
`libs/install-engine/src/install.ts` (1,933 lines) + lifecycle (update/uninstall),
diff, build-index, cascade (scoped config resolution), lockfile (atomic write),
ownership index (ADR-0004), install-registry records, verify-integrity (content
address), MCP project/trust sync for Claude, `SOX_SANDBOX_ROOT` sandbox isolation,
`npm-package:` install mode (native-addon extensions via real npm install into a
content store).

### 2.4 Registry integrity — REAL
`libs/registry/src/index.ts`: `registry/index.json` + `extensions/` (typed dirs),
sha256 checksums, drift gate (stale / unindexed / mutated), `assertNoDrift` CI gate.

### 2.5 Source fetching — REAL
`libs/source-provider/src/providers/{local,github,bitbucket,fake}.ts`, `source-ref`
parsing, `file://` / remote fetch with concurrency + errors.

### 2.6 Catalog organization (claude-agents) — REAL and strong
88 agents / 36 skills across categories; catalog metadata per agent (version, model,
runtime, tier, path) and per skill (cost-class, plugin, consumers, version); views
by-cost-class / by-runtime / by-tier; `taxonomy.md`, `skill-versioning.md`,
`plugin-index.json`, `plugin-packaging.md`.

---

## 3. Gaps — implemented vs needed

| # | Need (for "centralized versioned LLM tools across claude/opencode/codex") | Status | Evidence |
|---|---|---|---|
| G1 | **Per-host artifact rendering** — one authored artifact → claude/opencode/codex formats | ❌ **MISSING** | Manifest lib is validate-only; `install.ts` file-drops the artifact as-is (SKILL.md / prompt.md / dist/index.js). Per-host rendering exists **only** for MCP config values. Codex agents require TOML `[agents.<name>]` config-merge; claude/opencode agents are file-drop `.md` — no translator. Zero `render|translate` hits across install-engine + host-runtime adapters. |
| G2 | **`provider` artifact type** (provider plugins) | ❌ **MISSING** | Manifest `type` enum has no `provider`. No provider surface on any host. Codex **forbids** `model_providers` at project scope (`CODEX_PROJECT_FORBIDDEN_KEYS`, `[inv:never-managed]`). `provider-capabilities.ts` only *checks* a model against a vendored capability table — it installs nothing. |
| G3 | **Public / pullable distribution** | ❌ **MISSING** | `npx soxe` → 404 (never published to npm). Registry is a local file. claude-agents marketplace = `git clone` into a local dir. No central index host; nothing installable by name from a remote registry via the engine. |
| G4 | **Unified registry** (plugin.json ↔ extension.json) | ❌ **MISSING** | Two parallel registries, different schemas, no cross-walk: `sox list` (356 entries, claude-agents) vs `registry/index.json` (17 entries, sox-ecosystem). |
| G5 | **Codex agent/skill parity** | ⚠️ Partial | codex.ts is real (paths verified), but no renderer turns an md/frontmatter artifact into codex TOML config; skill drop unvalidated against codex skill frontmatter schema. |
| G6 | **Prompts type in practice** | ⚠️ Partial | Type exists in enum; `extensions/prompts` dir absent. |
| G7 | Skill format compatibility | ⚠️ Partial | Shared SKILL.md spec is the best-compatible type (file-drop works for claude/opencode/codex skill dirs), but no host-schema validation at drop time. |
| G8 | Versioned catalog in claude-agents | ⚠️ Partial | Versions live in catalog INDEX/RATIONALE text; `agent-index.json` has no version field; the engine-side registry does version via manifest. |

---

## 4. Renderer gap deep-dive (G1 — highest leverage)

**Observation.** The three hosts encode *agents* three different ways:
- Claude Code: file-drop `.md` (frontmatter + body) into `~/.claude/agents/`
- opencode: file-drop `.md` with opencode frontmatter (`description`, `mode`, `model`,
  `permission`, `tools`) into `.opencode/agents/` / `~/.config/opencode/agents/`
- Codex: **config entry** `[agents.<name>]` in `config.toml` (config-merge)

The engine's `install.ts` resolves one entrypoint file per artifact and either
copies it (file-drop) or writes a caller-provided value (config-merge). For
`mcp-server` it auto-derives the value via the host's `mcpConfig` builder — that is
the *only* per-host rendering in the codebase. For `agent` (and `skill`), no
renderer exists: a claude-authored agent `.md` installed to codex would require a
manually supplied TOML value (config-merge without a builder), and an opencode
frontmatter file dropped into `~/.claude/agents/` would not be a valid Claude agent.

**Consequence.** "Author once, install everywhere" is not achievable today. Each
host needs its own artifact shape, and nothing synthesizes them.

**Design sketch for the fix (for future work, not implemented here).**
A per-host renderer layer keyed by `(type, host)`:
- `agent` → claude: md with claude frontmatter; opencode: md with opencode
  frontmatter; codex: TOML `[agents.<name>]` fragment
- `skill` → shared SKILL.md file-drop + per-host frontmatter validation
- `provider` (new type) → opencode.json provider block / claude settings / codex
  `model_providers` (user scope only — respect `CODEX_PROJECT_FORBIDDEN_KEYS`)
- renderers live behind the `HostModule` interface (new optional `render(type,
  manifest, content)` surface), so the install engine's dispatch stays host-agnostic

---

## 5. Recommendations (priority order)

1. **Build the renderer layer (G1)** — unblocks "author once, install everywhere,"
   the core of the centralized-registry value proposition.
2. **Add `provider` as a first-class manifest type (G2)** with host surfaces
   (opencode JSON, codex user-scope TOML only, claude settings) — respecting the
   codex project-scope prohibition.
3. **Publish the CLIs** (`soxe` to npm; `sox` CLI packaging) + a pullable remote
   index so `install <name>@<version>` works from anywhere (G3).
4. **Reconcile the two registries (G4)** — build a one-way importer from
   claude-agents `plugin.json` → `extension.json` manifests, or adopt manifest v2
   as the single source and render plugin.json for backward compat.
5. **Validate skill drops per-host (G7)** at install time (frontmatter schema per
   host), rather than blind file-drop.

---

## 6. Evidence & confidence

All claims read from source on 2026-08-11; live CLI behavior verified (`sox list`,
`sox diff`). Key files:
- `libs/host-registry/src/{index,internal,claude,codex,opencode}.ts`
- `libs/install-engine/src/{install,index,provider-capabilities,ownership}.ts`
- `libs/manifest/src/{schema.json,index.ts}`
- `libs/registry/src/index.ts`
- `libs/source-provider/src/providers/*.ts`
- `~/dev/ai/claude-agents/tools/{sox.js,cli/marketplace.js,cli/index-mgmt.js}`
- `~/dev/ai/claude-agents/docs/catalog/INDEX.md`, `agent-index.json`,
  `docs/catalog/plugin-index.json`
- `~/dev/ai/sox-protocol/README.md`, `TODO.md`

Confidence: **HIGH** on every "implemented" claim (source-read, live-verified).
**HIGH** on G1/G2/G3/G4 (directly observed: no render/translate code, no provider
type, `npx soxe` 404, two registries). No claims inferred from memory.
