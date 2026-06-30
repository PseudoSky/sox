# sox-ecosystem

An **LLM-extension ecosystem**: independently-versioned extensions of eight types
(`agent`, `skill`, `mcp-server`, `service`, `prompt`, `hook`, `command`, `bundle`), installed
across four scopes (`org` / `user` / `project` / `local`) and run by a host runtime. Identity is
**content-addressed** (`id + sha256(artifact)`, [ADR-0003]); npm semver resolves the package graph
([ADR-0005]); placement is **tracked and fully reversible** (ownership index + ledger, [ADR-0004]).

The whole ecosystem is **publishable and consumable purely from npm**: `npm i -g @adhd/sox-cli`
works on a fresh machine with no checkout, and `soxe install sox-memory-bundle` resolves a bundle's
members — including native dependencies — straight from the registry.

- **CLI binary:** `soxe` (shipped as `bin/soxe`; the name avoids the system `sox` audio tool)
- **Engine:** `scripts/` + `libs/` · **Extensions:** `extensions/` · **Registry:** `registry/index.json`
- **New here?** Authors start with the [**Authoring Guide**](./docs/guidelines/authoring.md); operators
  start with [**USAGE.md**](./USAGE.md).

---

## What is a soxe extension?

A soxe extension is a small, self-describing unit of LLM capability. Every extension carries an
`extension.json` manifest (validated against the [`@adhd/sox-manifest`](./libs/manifest) schema) and
is one of eight **types**:

| Type | One-liner | Runtime | Builds? |
|------|-----------|---------|---------|
| `agent` | A subagent definition an orchestrator can delegate to. | `declarative` | no |
| `skill` | A reusable `SKILL.md` an agent loads on demand. | `declarative` | no |
| `command` | A deterministic CLI verb / slash-command. | `node` (or `python`) | yes (esbuild) |
| `mcp-server` | A long-lived MCP server exposing tools over stdio/sse/http. | `node` | yes (esbuild) |
| `service` | A supervised background process (HTTP/socket/stdio proxy, daemon). | `node` | yes (esbuild) |
| `hook` | A script fired by the host on a lifecycle event (e.g. `PreToolUse`). | `shell` (or `node`) | no |
| `bundle` | A manifest that expands to a set of independently-installed members. | `declarative` | no |
| `prompt` | A parameterized prompt template. **Parked by design** — no active scaffold. | `declarative` | n/a |

> `prompt` is intentionally not wired into the active authoring path; the other seven are
> first-class. See the [Authoring Guide](./docs/guidelines/authoring.md) for the exact manifest
> shape and golden path of each.

---

## Install (for consumers)

On a fresh machine, with **no repo checkout**:

```bash
npm i -g @adhd/sox-cli          # ships the `soxe` binary

soxe --version
soxe search memory              # find extensions in the registry
soxe install sox-memory-bundle --scope user   # resolve + install a bundle and all its members
soxe list                       # show what's installed and running
```

`soxe install <id|bundle> --scope <org|user|project|local>` is the one command you need. A
**bundle** resolves to its member set and routes each member to the right surface (a `skill`
file-drops to `~/.claude/skills/`, a stdio `mcp-server` config-merges into `~/.claude.json`, and so
on). Native dependencies (e.g. `better-sqlite3` for the memory store) are installed via the
`npm-package:` install mode — a real `npm install` into a per-extension content store, so the
platform binary resolves.

Full install / uninstall / `config` / scopes reference: [**USAGE.md**](./USAGE.md).

### From a checkout (contributors)

```bash
pnpm install                    # packageManager: pnpm@10.11.1
npx nx run-many -t build        # build all projects (never bare tsc — always nx)
node bin/soxe --help
node bin/soxe install sox-memory-bundle --scope user
node bin/soxe list
```

Build, test, lint, and typecheck **always** go through nx targets
(`npx nx build|test|lint|typecheck <project>`), never bare `tsc`/`vitest`/`eslint` — a bare tool
bypasses the project graph and can emit compiled output into `src/`.

---

## Command surface at a glance

| Verb | What it does |
|------|--------------|
| `soxe init <type> <id>` | Scaffold a born-conformant extension (uses `libs/authoring`). |
| `soxe validate [<path>]` | Validate a manifest + entrypoint reachability. |
| `soxe search [<query>]` | Search the registry. |
| `soxe install <id> --scope <scope>` | Resolve + install (writes the lockfile; bundles expand). |
| `soxe start` / `stop [<id>]` | Spawn / tear down supervised process extensions. |
| `soxe list` / `details <id>` | Show installed + **RUNNING** state (scope, pid, source). |
| `soxe enable <id>` / `disable <id>` | Actually (de)activate a running process. |
| `soxe exec <id> <tool> --args=<json>` | Invoke a tool through the running runtime. |
| `soxe update [<id>]` / `upgrade <id> --all` | Re-resolve / sweep all consumers current. |
| `soxe uninstall <id>` | Stop + remove (fully reversible via the ledger). |
| `soxe config <get\|set\|list\|unset\|check> <ext> …` | Per-extension, cascade-resolved config. |
| `soxe migrate-home` | Relocate legacy data roots ([ADR-0004]). |

Both `--flag value` and `--flag=value` forms parse. The canonical, status-marked reference (with
the observable each command should produce) is [**USAGE.md**](./USAGE.md).

---

## Quickstart for authors

Build any extension through one golden path — `init → build → validate → install → run`:

```bash
# 1. scaffold (born-conformant; writes into the current directory)
node bin/soxe init skill my-helper --title "My Helper" --description "Use this when…"

# 2. build — declarative types (skill/agent/hook/bundle) need no build;
#    code types (command/mcp-server/service) build a self-contained esbuild bundle:
npx nx build my-helper        # only for node/code types

# 3. validate the manifest + entrypoint
node bin/soxe validate ./my-helper

# 4. install at a scope
node bin/soxe install my-helper --scope user

# 5. run — declarative content is now discoverable by the host; process types start:
node bin/soxe start            # (mcp-server / service)
```

The complete, per-type how-to — exact manifest shapes, build contracts, install placement, and
fully-worked end-to-end examples for `skill`, `command`, `mcp-server`, and `bundle` — lives in the
[**Authoring Guide**](./docs/guidelines/authoring.md).

---

## Identity, versioning, and publishing

Two axes coexist and **never read each other** ([ADR-0005], extending [ADR-0003]):

1. **Content checksum is identity.** An extension is `id + sha256(its built entrypoint)`. The
   checksum is the *sole* integrity authority: the registry source may carry a version in its
   locator (`npm-package:@adhd/sox-extension-memory-server@1.1.0`), but that only **selects which
   bytes to fetch** — the fetcher recomputes the checksum and gates on it. A version bump with
   identical bytes is a no-op to identity; a byte change with the same version still trips
   `CHECKSUM MISMATCH`.
2. **npm semver resolves the package graph.** Extensions ship as **self-contained esbuild bundles**
   (Model A): all `@adhd/sox-*` JS is inlined, so the published artifact has zero `@adhd` runtime
   deps; only native `.node` addons stay external and are declared as real `dependencies`.

Publishing the `@adhd/sox-*` packages, the CLI, and every extension/bundle member to npm is driven
by Changesets. The full playbook — dry-run gates, the clean-room smoke, the owner-gated one-way
publish — is [**PUBLISHING.md**](./PUBLISHING.md); the public API stability tiers for the libs are
in [`docs/publishing/api-stability.md`](./docs/publishing/api-stability.md).

---

## Repository layout

```
apps/sox/            The CLI — all verb logic in apps/sox/src/main.ts (compiled to dist/apps/sox/main.js)
bin/soxe             ~10-line ESM shim that loads the compiled CLI (zero CLI logic)
libs/                Engine + SDK packages (all @adhd/sox-*):
  authoring            scaffold core + per-type templates (what `soxe init` uses)
  manifest             extension.json schema + validator (the cross-tool contract)
  install-engine       resolve / fetch / checksum / lockfile / cascade
  host-runtime         supervisor / runtime / reaper / lifecycle
  host-registry        per-host placement-path resolution
  mcp-runtime          MCP serve + tool-dispatch helpers
  registry             registry index types + helpers
  memory-core/-enrich  sox-memory store + deterministic enrichment internals
  service-proxy        front-shim / backend lifecycle for zero-downtime serves
  tokenguard-core      pseudonymizing-proxy engine
extensions/          The shipped extensions, grouped by type-plural directory:
  agents/  skills/  commands/  services/  bundles/<bundle>/members/<member>/
scripts/             build-index.ts (registry builder) + acceptance harnesses
tools/               bundle-extension.cjs (esbuild self-contained bundler)
registry/index.json  The registry: one entry per extension (id, type, source, checksum, …)
docs/                Guidelines, decisions (ADRs), specs, plans
```

---

## Platform specifics

Sox targets **macOS and Linux** (Node ≥ 20, `pnpm`). The cross-platform gotchas:

- **The CLI is `soxe`, never `sox`.** The bare name `sox` collides with the Homebrew/most-distros
  **`sox` audio tool** — so the shipped binary is **`soxe`** (`bin/soxe`, a ~10-line shim that loads
  `dist/apps/sox/main.js`). A stdio MCP server registered by soxe spawns via the resolved `soxe`
  binary; the install engine resolves the command as `SOX_CLI_BIN` → the running CLI's
  `process.argv[1]` → `'soxe'`, and **never** falls back to `'sox'`. If `~/.claude.json` shows
  `command: "sox"`, re-install at user scope.

- **Data root — `$SOX_ECOSYSTEM_HOME`** (default **`~/.adhd/sox-ecosystem/`**). All user-scope
  bookkeeping lives here: the lockfile, the `config` block (`extensions.json`), the reversal
  `ledger.json`, the `ownership.json` inventory, materialized service stores, and the global
  `install-registry.json`. `SOX_ECOSYSTEM_HOME` governs **data only** — it never redirects host
  placement. Project/local scopes use `<repo>/.adhd/sox-ecosystem/`.

- **Placement is the *real* host home, not the data root.** User-scope content lands in the actual
  `~/.claude/` (and `~/.claude.json` for MCP); project-scope lands in `<repo>/.claude/` (and
  `<repo>/.mcp.json`). The two roots are deliberately split ([ADR-0004]) — see the per-scope table
  in [USAGE.md](./USAGE.md).

- **`SOX_HOME` is retired** ([ADR-0004]). If set, the CLI prints a one-time notice. Use
  `SOX_ECOSYSTEM_HOME`, or run `node bin/soxe migrate-home` to relocate legacy `~/.sox` +
  `~/.config/extensions` data.

- **`SOX_SANDBOX_ROOT`** (test-only) reroutes host placement under a sandbox dir so the e2e harness
  never writes your real `~/.claude`. Do not set it in normal use.

## Host integration

Sox places content at each host's discovery path for the target scope. Two hosts are wired today:
**Claude Code** and **Codex**.

### Claude Code

| Type | Project scope | User scope |
|------|---------------|------------|
| agent | `.claude/agents/` | `~/.claude/agents/` |
| skill | `.claude/skills/` | `~/.claude/skills/` |
| command | `.claude/commands/` | `~/.claude/commands/` |
| hook | `.claude/settings.json` (+ script drop) | `~/.claude/hooks/` |
| mcp-server (stdio) | — | `~/.claude.json` `mcpServers` |
| mcp-server (sse/http) | `.mcp.json` (repo root) | — |

stdio MCP servers go to **`~/.claude.json`** (user scope, always trusted — no per-project approval
prompt); sse/http servers go to **`.mcp.json`** (project scope, behind Claude's trust gate). Sox
never auto-writes a trust flag. Full detail + the `#16728` project-override behavior:
[`docs/mcp-global-availability.md`](./docs/mcp-global-availability.md).

#### If you're using pre-built agents — the `tools:` footgun

Claude Code agents declared with a **`tools:` allowlist** in their YAML frontmatter only get the
tools **explicitly listed**. Any MCP tool not in that list is **invisible to the agent — even if the
server is installed, running, and trusted.** Pre-built/third-party agent packs almost always ship a
`tools:` line tuned to their setup, which omits your MCP servers; the symptom is silent.

**Fix — add the server's tools to the agent's `tools:` line** (wildcard allows all of them):

```yaml
---
name: my-agent
tools: Read, Write, Edit, Bash, mcp__memory-server__*
---
```

- `mcp__memory-server__*` — allow every tool the server exposes (names follow `mcp__<server>__<tool>`).
- **Or remove the `tools:` line entirely** to inherit *all* available tools (no allowlist).

> Related worktree trap: git worktrees check out the **committed** `.mcp.json`, not your
> working-tree edits — so a project MCP server added but not committed is missing in worktrees.
> Commit `.mcp.json`, or propagate user-scope servers with `node bin/soxe upgrade --all --force`.

### Codex

- **Skills:** `$CODEX_HOME/skills/<name>` (default `~/.codex/skills/<name>`).
- **Config:** TOML — all Codex config surfaces merge into `config.toml`.
- **Home:** `$CODEX_HOME` (default `~/.codex`).

---

## Documentation map

| Doc | Covers |
|-----|--------|
| [`docs/guidelines/authoring.md`](./docs/guidelines/authoring.md) | **Authoring guide** — golden path + per-type how-to + worked examples |
| [`USAGE.md`](./USAGE.md) | Full CLI surface; install/uninstall/configure at each scope |
| [`PUBLISHING.md`](./PUBLISHING.md) | Versioning + publishing to npm (Changesets, clean-room smoke) |
| [`DOD.md`](./DOD.md) | Definition of Done + status |
| [`docs/publishing/api-stability.md`](./docs/publishing/api-stability.md) | Public API stability tiers for the `@adhd/sox-*` libs |
| [`docs/mcp-global-availability.md`](./docs/mcp-global-availability.md) | How MCP servers reach every session; `tools:` gate; `#16728` |
| [`docs/guidelines/`](./docs/guidelines/) | Per-type framework-contract audits (the *what*; authoring.md is the *how*) |
| [`docs/decisions/`](./docs/decisions/) | ADRs (0003 content-address, 0004 data root + ownership, 0005 npm coexistence) |
| [`CLAUDE.md`](./CLAUDE.md) | Agent build constraints (nx-only, explicit-path staging, `soxe` shim) |

[ADR-0003]: ./docs/decisions/0003-extension-identity-is-content-addressed.md
[ADR-0004]: ./docs/decisions/0004-data-root-placement-and-ownership-index.md
[ADR-0005]: ./docs/decisions/0005-npm-publishing-and-content-address-coexistence.md
</content>
