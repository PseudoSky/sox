# Authoring Guide — building sox extensions

This is the **how-to** for building, validating, installing, and publishing a sox extension of any
type, written for someone with **no prior repo context**. It is the practical companion to the
per-type **framework-contract audits** in this directory (`agent.md`, `skill.md`, `mcp-server.md`,
`service.md`, `hook.md`, `command.md`, `bundle.md`, `prompt.md`) — those grade *what the framework
guarantees*; this guide tells you *what to type and what to expect*.

- New to the ecosystem? Read the [top-level README](../../README.md) first.
- Operating (install / uninstall / config at each scope)? See [USAGE.md](../../USAGE.md).
- Publishing to npm? See [PUBLISHING.md](../../PUBLISHING.md).

> **Command names.** This guide uses `soxe` (the installed binary). From a checkout, the equivalent
> is `node bin/soxe`. They are the same CLI.

---

## 1. The golden path

Every buildable type goes through the same five steps. **Born-conformance** ([DOD.md](../../DOD.md))
means a freshly-scaffolded extension passes `build → validate → install` with **zero hand-edits**.

```
init  →  build  →  validate  →  install  →  run
```

| Step | Command | Applies to |
|------|---------|-----------|
| **init** | `soxe init <type> <id>` | all active types |
| **build** | `npx nx build <id>` (code types) / *nothing* (declarative) | code types only |
| **validate** | `soxe validate <path>` | all types |
| **install** | `soxe install <id> --scope <scope>` | all types |
| **run** | `soxe start` + `soxe exec` (process) / host discovery (declarative) | depends on type |

**Active types:** `agent`, `skill`, `mcp-server`, `service`, `hook`, `command`, `bundle`.
**Parked:** `prompt` (see [§11](#11-prompt-parked-by-design)).

### init

```bash
soxe init <type> <id> [--out=<dir>] [--bundle=<bundle-name>] \
                      [--title=<str>] [--description=<str>] \
                      [--author=<str>] [--keywords=<k1,k2>] \
                      [--transport=<t> | --transports=<a,b>]   # service / mcp-server only
```

- **Output location.** `init` writes the scaffold to **`<cwd>/<id>/`** by default. Pass `--out=<dir>`
  to target a different parent directory, or `--bundle=<name>` to scaffold a **member** into that
  bundle's `members/` directory (and auto-register it in the bundle manifest). When contributing to
  *this* repo, `cd` into the matching `extensions/<type-plural>/` directory first (or pass
  `--out extensions/<type-plural>`) so the extension lands where the registry builder scans (see
  [§7](#7-the-registry-build-index)).
- **Id rules.** `^[a-z][a-z0-9-]*$`, and the id **must not end with the type name**. Name by
  *function*, not type: `memory-usage`, not `memory-skill`; `dep-inject`, not `inject-command`.
- Extra flags (`--events`, `--runtime`, `--force`) are accepted; `--force` reinitializes over an
  existing directory.

Scaffolding is performed by [`libs/authoring`](../../libs/authoring) — the same code path whether you
call it through `soxe init` or the `@adhd/sox-authoring` `scaffold()` API. Every template emits a
born-conformant `extension.json`, a born-publishable `package.json`, a `README.md`, a `CHANGELOG.md`,
and — for code types — a `src/` plus a pre-built `dist/index.js` **stub** so `validate` passes
immediately, before you have built anything real.

### build

- **Declarative types** (`agent`, `skill`, `hook`, `bundle`) have **no build step** — the source
  *is* the artifact (`SKILL.md`, `agent.md`, `hook.sh`, or the bundle manifest).
- **Code types** (`command`, `mcp-server`, `service`) compile TypeScript to a runnable
  `dist/index.js`. There are two build shapes (see [§6](#6-the-build-model-declarative-vs-code)):
  - **Self-contained esbuild bundle (Model A)** — the standard for anything that imports
    `@adhd/sox-*` or needs a native addon. Built by `tools/bundle-extension.cjs` via an nx target:
    `npx nx build <id>`. This is how every bundle member ships.
  - **Plain `tsc`** — the default `package.json` `build` script (`tsc --project tsconfig.json`) for a
    simple standalone code extension with no `@adhd/sox-*` or native dependency. Run `npm run build`
    in the extension directory.

> In **this monorepo**, always build through nx targets (`npx nx build <project>`), never bare `tsc`
> — a bare tool bypasses the project graph and can emit compiled output into `src/` (CLAUDE.md C3).

### validate

```bash
soxe validate <path-to-extension-dir-or-extension.json>
```

Runs the [`@adhd/sox-manifest`](../../libs/manifest) validator: required fields, id pattern, type
enum, runtime/entrypoint coupling, the `profiles ⊆ {serves ∪ transports}` invariant for
mcp-server/service, lifecycle/health coherence, and **entrypoint reachability** (the declared
entrypoint file must exist and, for code types, pass `node --check`).

### install

```bash
soxe install <id> --scope <org|user|project|local>
```

Resolves the extension from the registry (or local checkout), verifies the content checksum, places
it at the host discovery path for the scope, and records the placement in the ownership index +
ledger so `soxe uninstall <id>` reverses it exactly. See [§4](#4-scopes) and
[USAGE.md](../../USAGE.md) for the full per-scope behavior.

### run

- **Process types** (`mcp-server`, `service`) are spawned + supervised: `soxe start`, then
  `soxe list` shows them `RUNNING`; `soxe exec <id> <tool> <json>` invokes a tool through the live
  runtime; `soxe stop` tears down with zero orphans.
- **Declarative types** (`agent`, `skill`, `command`, `hook`) are *placed* at the host's discovery
  path — the host (Claude Code / Codex) discovers and runs them; sox does not spawn them.

---

## 2. The manifest (`extension.json`)

Every extension is described by an `extension.json` validated against the v2 schema
([`libs/manifest/src/schema.json`](../../libs/manifest/src/schema.json)). Fields common to all types:

| Field | Required | Meaning |
|-------|----------|---------|
| `id` | yes | Stable slug, `^[a-z][a-z0-9-]*$`. Primary registry key; immutable. |
| `type` | yes | One of the eight types (closed enum). |
| `title` | yes | Human-readable title. |
| `description` | yes | One-line "Use this when…" description. |
| `compatibility` | yes | Host compatibility, e.g. `{ "host": ">=1.0.0 <2.0.0" }`. |
| `license` | yes | SPDX id, e.g. `MIT`. |
| `version` | scaffolded | semver. **Display-only** ([ADR-0003]); not an identity/integrity input. `soxe init` emits `0.1.0`. |
| `runtime` | typed | `node` \| `shell` \| `python` \| `declarative` \| `stdio-any`. Absent ⇒ `node`. |
| `entrypoint` | type-dependent | The artifact file. Required for code types; the `.md`/`.sh` file for declarative types; **absent for `bundle`**. |
| `install` | recommended | The install descriptor — `{ type, hosts?, serves?, transports?, profiles?, source? }`. |
| `keywords`, `author` | optional | Discovery metadata. |
| `config_schema` | optional | Install-time config (with `x-sox-prompt` / `x-sox-default`); injected at spawn as `SOX_CONFIG_<KEY>`. |
| `permissions` | optional | `{ fs:{read,write}, network:{outbound}, socket:{paths} }` — enforced at runtime for spawned types ([§9](#9-permissions)). |

Type-specific fields (`lifecycle`, `tools`, `members`, `events`, `order`, `invocation`,
`run_interface`, `visibility`, `bundle_id`, …) are covered in each per-type section below.

> **`version` is display-only.** Under [ADR-0003], identity is `id + sha256(entrypoint)`. The
> registry's `version` is derived from `package.json` for display; the registry builder does **not**
> require `version` in `extension.json`. Some older shipped examples (e.g.
> `extensions/skills/di-skill`) omit it entirely and still validate.

---

## 3. Identity and versioning (read once)

Two axes coexist and never read each other ([ADR-0005], extending [ADR-0003]):

- **Content checksum = identity + integrity.** `sha256` of the built entrypoint. The registry source
  may carry a version (`npm-package:@adhd/sox-extension-foo@1.2.0`) — that version only **selects
  which bytes to fetch**; the fetcher recomputes the checksum and gates on it. Same bytes, new
  version → no-op. Different bytes, same version → `CHECKSUM MISMATCH` (the gate working).
- **npm semver = package-graph resolution.** Only relevant at publish/install-from-npm time.

Practical consequence for you: **after you change a code extension's source, you must rebuild and
re-sync the registry checksum** (see [§7](#7-the-registry-build-index)), or installs will refuse the
stale artifact.

---

## 4. Scopes

Four scopes, cascade-resolved **org → user → project → local** (narrowest wins). Each scope splits
two roots ([ADR-0004]):

- **Data root** — bookkeeping only (lockfile, `config` block, `ledger.json`, `ownership.json`).
  User scope: `$SOX_ECOSYSTEM_HOME` (default `~/.adhd/sox-ecosystem/`). Project/local:
  `<repo>/.adhd/sox-ecosystem/`.
- **Placement root** — where content lands so the **host** discovers it: the real `~/.claude/` (+
  `~/.claude.json`) at user scope; `<repo>/.claude/` (+ `<repo>/.mcp.json`) at project scope.

| Scope | Use it for |
|-------|-----------|
| `user` | This machine, available to every project & agent. |
| `project` | This repo only (default for `--host` installs). |
| `local` | Machine-local override for this repo (git-ignored). |
| `org` | Managed/read-only policy tier — writes `org.extensions.*` data, **no host placement**. |

The full per-scope path table is in [USAGE.md](../../USAGE.md#scopes--the-dataplacement-split-adr-0004).

---

## 5. Per-type quick reference

| Type | `runtime` | `entrypoint` | Builds | Host placement (Claude) |
|------|-----------|--------------|--------|--------------------------|
| [agent](#agent) | `declarative` | `agent.md` | no | `.claude/agents/` |
| [skill](#skill) | `declarative` | `SKILL.md` | no | `.claude/skills/<id>/` |
| [command](#command) | `node` | `dist/index.js` | yes | `.claude/commands/` |
| [mcp-server](#mcp-server) | `node` | `dist/index.js` | yes | `~/.claude.json` (stdio) / `.mcp.json` (sse/http) |
| [service](#service) | `node` | `dist/index.js` | yes | sox-supervised process (no host file-drop) |
| [hook](#hook) | `shell` | `hook.sh` | no | `.claude/hooks/` + `settings.json` merge |
| [bundle](#bundle) | `declarative` | *(none)* | no | expands to members |
| [prompt](#11-prompt-parked-by-design) | `declarative` | — | parked | — |

---

## 6. The build model: declarative vs code

### Declarative (`agent`, `skill`, `hook`, `bundle`)

No build. The source file *is* the published artifact and the checksum target:

- `agent` → `agent.md` (YAML frontmatter + body)
- `skill` → `SKILL.md` (YAML frontmatter + body)
- `hook` → `hook.sh` (bash; or a `.cjs`/`.js` node hook)
- `bundle` → `extension.json` itself (it has **no entrypoint**)

### Code (`command`, `mcp-server`, `service`)

Compile TypeScript in `src/` to a runnable `dist/index.js`. Two shapes:

**(a) Self-contained esbuild bundle (Model A) — the standard for the monorepo and anything with
deps.** `tools/bundle-extension.cjs` inlines every `@adhd/sox-*` import (resolved from each lib's
pre-built `dist/`) so the published artifact carries **zero `@adhd` runtime deps**. Native addons
(`better-sqlite3`, `sqlite-vec`) stay **external** (`--external <pkg>`) and are declared as real
`dependencies`; they are loaded lazily via `createRequire` at first use. This is wired through an nx
`project.json` build target:

```jsonc
// project.json — build target (as used by every bundle member)
"build": {
  "executor": "nx:run-commands",
  "outputs": ["{workspaceRoot}/<path>/dist"],
  "options": {
    "commands": [
      "rm -rf <path>/dist",
      "node tools/bundle-extension.cjs --entry <path>/src/index.ts --outdir <path>/dist --tsconfig <path>/tsconfig.json --external better-sqlite3 --external sqlite-vec"
    ],
    "parallel": false, "cwd": "."
  },
  "cache": true
}
```

Build it with `npx nx build <project-name>`.

**(b) Plain `tsc`.** The default `package.json` emitted by `soxe init` for a *standalone* code
extension uses `"build": "tsc --project tsconfig.json"`. Suitable for a simple command/server with no
`@adhd/sox-*` and no native addon. Run `npm run build` in the extension directory. (The scaffold also
drops a pre-built `dist/index.js` stub so `soxe validate` passes before your first build.)

> **Which do I use?** If your code imports any `@adhd/sox-*` package, ships inside a bundle, or needs
> a native addon — use **Model A** (esbuild + an nx `project.json`). Otherwise the plain `tsc` script
> is enough. Bundle members scaffolded with `soxe init <type> <id> --bundle <name>` get a Model-A
> `project.json` automatically.

### Born-publishable `package.json`

`soxe init` emits a `package.json` that is publish + fresh-machine-install ready
([PUBLISHING.md](../../PUBLISHING.md)): `name: @adhd/sox-extension-<id>`, `publishConfig.access:
public`, `engines.node: >=20`, `files: ["dist","extension.json"]`, `main: dist/index.js`. Any
`@adhd/sox-*` you import belongs in **devDependencies** (inlined by the bundler); only native addons
go in `dependencies`.

---

## 7. The registry (`build-index`)

The registry ([`registry/index.json`](../../registry/index.json)) is one entry per extension —
`{ id, type, version, title, description, source, checksum, compatibility, members?, visibility? }`.
It is generated by [`scripts/build-index.ts`](../../scripts/build-index.ts), which scans
`extensions/<type-plural>/<id>/extension.json` (plus bundle `members/`) and `apps/<name>/`.

**After any change to a code extension's artifact**, regenerate the registry so the checksum matches:

```bash
npx nx run registry:sync-index   # rebuilds (cached) + regenerates registry/index.json checksums
```

Never hand-edit `registry/index.json`. The CI drift gate (C2) fails if the registry lags the
artifacts. `source` is a checkout-bound `file://` path in local development; at publish time, with
`SOX_REGISTRY_PUBLISH=npm`, it is rewritten to a portable `npm-package:` locator (see
[PUBLISHING.md](../../PUBLISHING.md)).

> **Directory naming matters.** `build-index` maps directories by name:
> `agents → agent`, `skills → skill`, `mcp-servers → mcp-server`, `commands → command`,
> `hooks → hook`, `prompts → prompt`, `bundles → bundle`. Place a standalone extension under the
> matching `extensions/<type-plural>/` directory or it will not be indexed.
> **Known gap:** the indexer does **not** currently scan `extensions/services/`, so a `service`-type
> extension placed there (e.g. `tokenguard`) is not in the registry — see [§10](#10-service).

---

## 8. Worked examples

Four fully-worked, end-to-end examples. Replace ids/paths as needed.

### 8.1 Skill (declarative)

A skill is a `SKILL.md` an agent loads on demand. No build.

```bash
# 1. scaffold (run from extensions/skills/ in this repo, or use --out)
cd extensions/skills
soxe init skill commit-helper \
  --title "Commit Helper" \
  --description "Use this when you need to write a conventional-commit message from a staged diff." \
  --keywords "git,commit,conventional-commits"
```

This produces `commit-helper/{extension.json, SKILL.md, package.json, README.md, CHANGELOG.md}`. The
manifest:

```jsonc
{
  "$schema": "https://your-registry/schemas/extension/v2.json",
  "id": "commit-helper",
  "version": "0.1.0",
  "type": "skill",
  "title": "Commit Helper",
  "description": "Use this when you need to write a conventional-commit message from a staged diff.",
  "compatibility": { "host": ">=1.0.0 <2.0.0" },
  "license": "MIT",
  "runtime": "declarative",
  "entrypoint": "SKILL.md",
  "install": { "type": "skill" }
}
```

Edit `SKILL.md` — the YAML frontmatter `name`/`description` are what the host indexes; the body is
the instruction set (sections: *When to use*, *When NOT to use*, *Input/Output contract*,
*Examples*). Then:

```bash
# 2. (no build — declarative)
# 3. validate
soxe validate ./commit-helper

# 4. install for this machine; lands at ~/.claude/skills/commit-helper/SKILL.md
soxe install commit-helper --scope user

# 5. (run) — the host discovers it; an agent loads it on demand. Verify placement:
ls ~/.claude/skills/commit-helper/
```

Real reference: [`extensions/skills/di-skill`](../../extensions/skills/di-skill),
[`extensions/skills/demo-creator`](../../extensions/skills/demo-creator). For Codex placement
(`~/.codex/skills/<id>/`), add `"hosts": ["codex"]` to `install` and install with `--host codex`.

### 8.2 Command (code)

A command is a deterministic CLI verb / slash-command. It builds to `dist/index.js` and exports a
`run()` function.

```bash
cd extensions/commands
soxe init command changelog-bump \
  --title "Changelog Bump" \
  --description "Use this to append a new version section to a CHANGELOG.md."
```

Manifest highlights (real shape — see [`extensions/commands/di-command`](../../extensions/commands/di-command)):

```jsonc
{
  "id": "changelog-bump",
  "type": "command",
  "runtime": "node",
  "entrypoint": "dist/index.js",
  "invocation": { "protocol": "stdio", "handler": "run" },
  "install": { "type": "command", "hosts": ["claude"] }
}
```

Implement `src/index.ts` (it ships a `run(input): CommandOutput` stub + a direct-CLI entry), then:

```bash
# 2. build
npm run build                 # standalone: tsc → dist/index.js
#   …or, if wired as an nx project / inside the monorepo:
# npx nx build changelog-bump

# 3. validate (entrypoint reachability: dist/index.js must node --check)
soxe validate ./changelog-bump

# 4. install (project scope → <repo>/.claude/commands/changelog-bump.md)
soxe install changelog-bump --scope project

# 5. run — the host exposes it as a slash-command; it is also directly runnable:
ls .claude/commands/changelog-bump.md     # verify placement
node ./changelog-bump/dist/index.js 1.2.0 # direct CLI (run() handler)
```

Constraints: commands are **deterministic** — no LLM calls inside the handler; exit non-zero on
failure; output to stdout. For a Python command, set `runtime: python` and replace `src/` +
`tsconfig.json` with a `pyproject.toml` + `[project.scripts]` entry.

### 8.3 MCP server (code, supervised)

An mcp-server is a long-lived process exposing tools over stdio (the default). It builds to
`dist/index.js`, declares its `tools`, and is supervised by sox.

```bash
cd extensions/mcp-servers       # create this dir if absent; it is the indexed location
soxe init mcp-server weather-mcp \
  --title "Weather MCP" \
  --description "Use this when an agent needs current weather for a city." \
  --transports stdio
```

Manifest highlights (real shape — see the memory-server member,
[`extensions/bundles/sox-memory-bundle/members/memory-server/extension.json`](../../extensions/bundles/sox-memory-bundle/members/memory-server/extension.json)):

```jsonc
{
  "id": "weather-mcp",
  "type": "mcp-server",
  "runtime": "node",
  "entrypoint": "dist/index.js",
  "lifecycle": {
    "background": true,
    "singleton": true,
    "stop_timeout_ms": 5000,
    "health": { "type": "stdio-ping", "interval_ms": 30000, "timeout_ms": 5000 }
  },
  "install": {
    "type": "mcp-server",
    "serves": ["stdio"],
    "profiles": { "stdio": { "transport": "stdio" } }
  },
  "tools": [
    { "name": "get_weather", "description": "Current weather for a city.",
      "inputSchema": { "type": "object", "properties": { "city": { "type": "string" } }, "required": ["city"] } }
  ],
  "config_schema": {
    "type": "object", "additionalProperties": false, "required": [],
    "properties": {
      "api_key": { "type": "string", "description": "Weather API key.",
        "x-sox-prompt": "Weather API key:", "x-sox-default": "" }
    }
  }
}
```

The `src/index.ts` stub uses `@modelcontextprotocol/sdk` `StdioServerTransport`, registers
`ListTools` / `CallTool` handlers, and includes a `SIGTERM` handler (sox guarantees `SIGKILL` after
`stop_timeout_ms`). Then:

```bash
# 2. build — esbuild Model A if you import @adhd/sox-*; otherwise tsc
npx nx build weather-mcp        # (with a Model-A project.json) — or: npm run build

# 3. validate
soxe validate ./weather-mcp

# 4. install — stdio servers config-merge into ~/.claude.json (user) — always trusted
soxe install weather-mcp --scope user

# 5. run + invoke through the runtime
soxe start
soxe list                       # weather-mcp RUNNING
soxe exec --list                # show executable tools on running extensions
soxe exec weather-mcp get_weather --args='{"city":"Berlin"}'
```

`config set` injects config at spawn as `SOX_CONFIG_<KEY>`:

```bash
soxe config set weather-mcp api_key '${WEATHER_API_KEY}' --scope user   # env-ref, never a literal secret
```

stdio vs sse/http placement: stdio → `~/.claude.json` (user, trusted, no per-project prompt);
sse/http → `.mcp.json` (project, behind Claude's trust gate). See
[`docs/mcp-global-availability.md`](../mcp-global-availability.md).

### 8.4 Bundle (declarative, expands to members)

A **bundle** is a declarative manifest with **no entrypoint** that expands to a set of independently
-installed **members**. Each member is a normal extension (its own `extension.json`, own checksum,
own npm package) living under `members/<id>/` with `visibility: "internal"` and `bundle_id` set.

```bash
# 1a. scaffold the bundle shell (it starts with two placeholder member refs):
cd extensions/bundles
soxe init bundle weather-suite \
  --title "Weather Suite" \
  --description "Use this to install the full weather toolkit in one command."

# 1b. add real members one at a time — each scaffolds into weather-suite/members/<id>/
#     AND auto-registers in the bundle's extension.json members[] array:
soxe init mcp-server weather-mcp   --bundle weather-suite
soxe init skill      weather-usage --bundle weather-suite
soxe init command    weather-cli   --bundle weather-suite
```

> The bundle shell is born with two placeholder member refs (`example-member-a`,
> `example-member-b`). Remove them from `weather-suite/extension.json` once you have added your real
> members. The CLI adds members only via `--bundle` (one per `init`); there is no `--member` flag on
> `soxe init` today — co-scaffolding multiple members in one call is available only through the
> `@adhd/sox-authoring` `scaffold()` API.

Bundle manifest (real shape — see
[`extensions/bundles/sox-memory-bundle/extension.json`](../../extensions/bundles/sox-memory-bundle/extension.json)):

```jsonc
{
  "id": "weather-suite",
  "type": "bundle",
  "title": "Weather Suite",
  "description": "Use this to install the full weather toolkit in one command.",
  "compatibility": { "host": ">=1.0.0 <2.0.0" },
  "license": "MIT",
  "members": [ { "id": "weather-mcp" }, { "id": "weather-usage" }, { "id": "weather-cli" } ],
  "permissions": {}
}
```

Build the **code members** (declarative members need nothing), validate, sync the registry, install
the whole set:

```bash
# 2. build each code member (esbuild Model A)
npx nx build weather-mcp
npx nx build weather-cli

# 3. validate the bundle and members
soxe validate ./weather-suite
soxe validate ./weather-suite/members/weather-mcp

# 3b. regenerate registry checksums (members are indexed individually + as bundle members)
npx nx run registry:sync-index

# 4. install — expands to ALL members; each routes to its own surface
soxe install weather-suite --scope user

# 5. verify
soxe list                       # weather-mcp RUNNING; skill/command placed
```

`soxe install weather-suite` **reconciles the whole member set**: a stdio member config-merges into
`~/.claude.json`, a skill file-drops to `~/.claude/skills/`, a command to `~/.claude/commands/`.
`soxe uninstall weather-suite` reverses every member placement via the ledger. Members publish as
**their own npm packages** (`@adhd/sox-extension-weather-mcp`, …); the bundle publishes as a tiny
manifest-only package whose `members[]` is fetchable on a fresh machine.

---

## 9. Permissions

Declare a least-privilege `permissions` block; the host enforces it **at runtime** for spawned types
([DOD.md](../../DOD.md) C6 — not merely validated):

```jsonc
"permissions": {
  "fs":      { "read": ["~/.memory/**"], "write": ["~/.memory/**"] },
  "network": { "outbound": ["api.example.com"] },
  "socket":  { "paths": ["~/.memory/memoryd.sock"] }
}
```

At spawn the supervisor scrubs the environment and installs an in-process allowlist guard at the
resource sink. A path outside the `fs` allowlist is **denied with no file created** — verified for
real (e.g. a memory-server write to `/tmp/evil.db` is refused and the file is absent). Use the
narrowest globs that work. OS-kernel sandboxing is an explicit non-goal; enforcement is in-process.

---

## 10. Per-type details

### agent

- **Runtime:** `declarative`. **Entrypoint:** `agent.md`. **Build:** none.
- The `agent.md` is YAML frontmatter (`name`, `description`, `tools`, `model`) + a markdown body.
  The host reads it as a subagent definition; sox does not spawn it.
- **`tools:` footgun** — if the frontmatter lists a `tools:` allowlist, MCP tools not listed are
  invisible to the agent. Add `mcp__<server>__*` or omit `tools:` to inherit all. See the
  [README](../../README.md#if-youre-using-pre-built-agents--the-tools-footgun).
- `config_schema` is supported but **not injected as env** (agents are declarative); it is reachable
  via `soxe config get/set/list`.
- Real: [`extensions/agents/test-agent`](../../extensions/agents/test-agent). Contract audit:
  [`agent.md`](./agent.md).

### skill

- **Runtime:** `declarative`. **Entrypoint:** `SKILL.md`. **Build:** none.
- Worked example: [§8.1](#81-skill-declarative). Real:
  [`extensions/skills/di-skill`](../../extensions/skills/di-skill),
  [`sox-ingest`](../../extensions/skills/sox-ingest),
  [`demo-creator`](../../extensions/skills/demo-creator). Contract audit: [`skill.md`](./skill.md).

### command

- **Runtime:** `node` (or `python`). **Entrypoint:** `dist/index.js`. **Build:** yes.
- `invocation: { protocol: "stdio", handler: "run" }`. Deterministic; no LLM calls.
- Worked example: [§8.2](#82-command-code). Real:
  [`extensions/commands/di-command`](../../extensions/commands/di-command). Contract audit:
  [`command.md`](./command.md).

### mcp-server

- **Runtime:** `node`. **Entrypoint:** `dist/index.js`. **Build:** yes (esbuild Model A for deps).
- `lifecycle` (`background`, `singleton`, `health.type: stdio-ping`, `stop_timeout_ms`); `install`
  (`serves` + `profiles`, `profiles ⊆ serves`); `tools[]`; optional `config_schema`, `permissions`.
- A bundle member can set `visibility: "internal"` + `bundle_id` so it is not independently
  listed/installable. The memory-server member uses `lifecycle.serve_mode: "proxy"` (a
  zero-downtime front-shim from [`libs/service-proxy`](../../libs/service-proxy)) — optional.
- Worked example: [§8.3](#83-mcp-server-code-supervised). Real: the memory-server member. Contract
  audits: [`mcp-server.md`](./mcp-server.md), [`mcp.md`](./mcp.md).

### service

- **Runtime:** `node`. **Entrypoint:** `dist/index.js`. **Build:** yes (esbuild Model A).
- A `service` is a supervised background process that need **not** speak the MCP wire protocol — its
  transport vocabulary adds `http` and `socket` to `{stdio, sse}`. The install descriptor uses
  **`transports`** (with `serves` as a back-compat alias for `{stdio,sse,http}` overlap) and
  `profiles ⊆ {serves ∪ transports}`. Lifecycle health is typically `http-get` against a health
  endpoint.
- Real: [`extensions/services/tokenguard`](../../extensions/services/tokenguard) — an HTTP
  pseudonymizing proxy with `lifecycle.health.type: "http-get"`, `install.transports: ["http"]`, and
  a rich `config_schema` (`x-sox-prompt`/`x-sox-default` per key). Scaffold one with
  `soxe init service my-proxy --transports http`. Contract audit: [`service.md`](./service.md).
- **Known gap (flag for maintainers):** [`scripts/build-index.ts`](../../scripts/build-index.ts) does
  not scan `extensions/services/`, so a service placed there is **not added to the registry** and
  cannot be `soxe install`ed by id from the registry today. Until that is fixed, a service ships
  most reliably **as a bundle member** (which *is* indexed) or via a direct local install. This is a
  documentation-surfaced engine gap, not author error.

### hook

- **Runtime:** `shell` (or `node`). **Entrypoint:** `hook.sh`. **Build:** none.
- `events: ["PreToolUse"]` (or another lifecycle event), `order: 100` (ascending; ties broken by id).
  The hook reads the JSON payload on **stdin** and writes a JSON response to **stdout** (or exits 0
  for a no-op/allow).
- Install is two-part: a **file-drop** of the script *and* a **config-merge** into the host's
  `settings.json` hooks entry. Deterministic; idempotent side effects.
- Scaffold: `soxe init hook my-guard`. Contract audit: [`hook.md`](./hook.md).
- Output protocol: `{}`/exit 0 = allow; `{"systemMessage":"…"}` = inject; `{"hookSpecificOutput":
  {"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}` = deny.

### bundle

- **Runtime:** `declarative`. **Entrypoint:** none (a bundle that declares `entrypoint` fails
  validation). **Build:** none (members build individually).
- `members: [{ id }]` — referenced by **id only** (identity is id + checksum). Members live at
  `members/<id>/` with `visibility: "internal"` + `bundle_id`.
- Worked example: [§8.4](#84-bundle-declarative-expands-to-members). Real:
  [`extensions/bundles/sox-memory-bundle`](../../extensions/bundles/sox-memory-bundle) (members:
  `memory-daemon` (service-like), `memory-server` (mcp-server), `memory-flush` (hook), `memory-cli`
  (command), `memory-usage` (skill)). Contract audit: [`bundle.md`](./bundle.md).

---

## 11. prompt (parked by design)

The `prompt` type is **not wired into the active authoring path**. `soxe init` rejects it (it is not
in the active type list), and the framework provides no runtime for it. A minimal template stub
exists only to keep the schema surface complete. Do not author `prompt` extensions until it is
unparked. Contract audit: [`prompt.md`](./prompt.md).

---

## 12. Publishing your extension

The full playbook is [PUBLISHING.md](../../PUBLISHING.md). In short:

1. Your `soxe init`-scaffolded `package.json` is already born-publishable (public access, `engines`,
   `files`, zero `@adhd` runtime deps via esbuild inlining).
2. Add a changeset for the version bump; `pnpm run check-publishable` gates the structural 404 class
   (no `workspace:*` runtime dep onto an unpublished target; no `@adhd/sox-*` runtime dep on an
   extension).
3. Publish flows through Changesets (`pnpm release:prepared`), then the registry is rewritten to
   portable `npm-package:` locators (`SOX_REGISTRY_PUBLISH=npm`). The owner-gated step is the
   one-way door — do not run it without the owner.
4. The canonical acceptance gate is the **clean-room smoke**: on a machine with no checkout,
   `npm i -g @adhd/sox-cli` then `soxe install <your-bundle>` resolving every member with native
   deps. "Tests pass" ≠ "publishable."

Stability tiers for the libraries you might depend on:
[`docs/publishing/api-stability.md`](../publishing/api-stability.md).

---

## 13. Troubleshooting

| Symptom | Cause / fix |
|---------|-------------|
| `soxe init` writes to the wrong place | It writes to `<cwd>/<id>/`. `cd` into `extensions/<type-plural>/` or pass `--out`. |
| `init` rejects the id | Id must be `^[a-z][a-z0-9-]*$` **and not end with the type name**. Name by function. |
| `validate` fails on entrypoint | The declared `entrypoint` file must exist and (code types) pass `node --check`. Build first. |
| `CHECKSUM MISMATCH` on install | The artifact changed but the registry checksum is stale. Run `npx nx run registry:sync-index`. |
| Extension not found in registry | It is under the wrong directory (must be `extensions/<type-plural>/`), or it is a `service` (indexer gap — [§10](#service)), or `private: true`. |
| MCP server invisible to a pre-built agent | The agent's `tools:` allowlist omits `mcp__<server>__*`. Add it or remove the `tools:` line. |
| `command: "sox"` in `~/.claude.json` | Re-install at user scope; the CLI must resolve to `soxe`, never the system `sox` audio tool. |
| stdio MCP server in `.mcp.json` not loading in a worktree | Worktrees use the committed `.mcp.json`. Commit it, or `soxe upgrade --all --force`. |

---

## See also

- [README](../../README.md) — ecosystem overview, consumer install, repo layout.
- [USAGE.md](../../USAGE.md) — full CLI surface; install/uninstall/config at each scope.
- [PUBLISHING.md](../../PUBLISHING.md) — npm publishing playbook.
- [DOD.md](../../DOD.md) — born-conformance Definition of Done.
- Per-type contract audits: [`agent.md`](./agent.md) · [`skill.md`](./skill.md) ·
  [`command.md`](./command.md) · [`mcp-server.md`](./mcp-server.md) · [`service.md`](./service.md) ·
  [`hook.md`](./hook.md) · [`bundle.md`](./bundle.md) · [`prompt.md`](./prompt.md).
- ADRs: [0003 content-address](../decisions/0003-extension-identity-is-content-addressed.md) ·
  [0004 data root + ownership](../decisions/0004-data-root-placement-and-ownership-index.md) ·
  [0005 npm coexistence](../decisions/0005-npm-publishing-and-content-address-coexistence.md).

[ADR-0003]: ../decisions/0003-extension-identity-is-content-addressed.md
[ADR-0004]: ../decisions/0004-data-root-placement-and-ownership-index.md
[ADR-0005]: ../decisions/0005-npm-publishing-and-content-address-coexistence.md
</content>
