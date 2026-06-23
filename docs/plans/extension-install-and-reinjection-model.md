<!-- markdownlint-disable MD013 -->
# Plan — Extension Install & Reinjection Model

> **Status:** design agreed in principle (interactive scoping, 2026-06); not yet formalized as a
> plan-state-machine or executed. Builds on the nx foundation (`feat/nx-migration`) and the completed
> C6 runtime-permission work.
> **Author:** workflow-architect + founder (interactive design session).
> **Supersedes/extends:** the `install-target` contract flex (currently declared-unimplemented).

This document is my current understanding of what we're going to build. It is the strategy/context
doc; once the **open decisions** (§9) are closed, it gets rendered into a formal plan-state-machine
directory and executed with reality-verified gates (the way C6 / the nx migration were).

---

## 1. Why — the problem this fixes

Several findings from the design session share one root cause: **the standard/schema ran ahead of the
tooling, and the system's two roles were never named.** Concretely, today:

- **`install-target` is declared but unimplemented** — the schema/generators describe placing
  declarative content (markdown agents/skills, slash-commands) into a host's discovery dirs, but
  nothing consumes it. `sox install` of a declarative extension writes no bytes to the host.
- **`agent` lifecycle is vestigial** — the manifest validator permits a `lifecycle` block on `agent`,
  but the runtime honors it only for `mcp-server`. Schema accepts what the runtime ignores.
- **Versioning / update / diff don't work for declarative content** — versioning is metadata-only;
  `update` is a no-op on disk for declarative types; there is no `diff` for anything.
- **`agent` is overloaded** — it spans declarative prompt-defs *and* code function-exports with no
  agreed invocation protocol.
- **`memory-server` duplicates framework concerns** — a hand-rolled MCP loop + a vendored permission
  guard that should live in shared infra.
- **DoD B2 ("every type init→build→validate→install→run") was only verified for code/process types** —
  the declarative "run" (= placed + discoverable) was never delivered or verified.

The fix is to **name the two roles**, **draw the boundary**, and **build the missing tooling layer**
(materialization, merge-with-provenance, host-aware placement, diff/update, and an MCP wrapper).

---

## 2. The two roles (the boundary)

sox is two systems under one type-system. Naming them is the core decision.

- **Role A — Extension *runtime host*.** sox itself loads, spawns, supervises, enforces, and invokes.
  Applies to `service` / `mcp-server` (sox-run mode) and in-process code. sox owns the whole stack.
- **Role B — Cross-scope *package manager + reinjector* for foreign-host content.** The host (Claude
  Code, Codex, …) executes; **sox only materializes + versions + scopes + diffs** the content into the
  host's own config/discovery locations. **Execution is deferred to the host.**

**Hard boundary for Role B:** sox's reality-check tops out at *"the right bytes are at the host's
discovery path for the right scope"* — never *"the host actually ran it"* (sox cannot verify that, by
design). The runtime already draws this correctly (declarative types are skipped as
"install-time-only"); what's missing is the **install side fulfilling its half — placement.**

---

## 3. The model

### 3.1 Three layers

1. **Extension type (build-time identity)** — *what you author/build.* Small, stable preset set.
2. **Install capabilities (mechanism)** — generic, idempotent operations (below).
3. **Injection targets + install-time config (deploy)** — *where it lands* (host surface × scope) and
   *what config it carries* (permissions/env merged into the host). **Not types** — config layered on a
   built extension.

The manifest = **`type` (L1) + an install descriptor (L3)**; capabilities (L2) are the engine.

### 3.2 Capabilities (the installers to build) — ~5

Each is idempotent and must implement **apply / reverse / update(diff) / verify**, and be **scope- and
host-aware**:

| Capability | Action | Reverse | Clean? |
|---|---|---|---|
| `file-drop` | write file/dir at a discovery path | delete | ✅ |
| `config-merge` (json \| **toml**) | set a key/sub-table in a shared config — JSON (`settings.json`/`.mcp.json`) **or** TOML (codex `config.toml`) | remove key | ⚠️ shared file → needs ledger |
| `array-merge` | append to arrays (permissions/env), deny-wins | remove exact values | ⚠️ shared file → needs ledger |
| `bin-link` | executable on PATH / referenced script | unlink | ✅ |
| `run-service` | sox spawns + supervises (Role A only) | stop | ✅ |
| `materialize` | place built code at a **stable** store path (so host pointers don't break) | delete | ✅ |

(`materialize` is the helper that makes `json-merge` MCP pointers valid; "composite/plugin" = a `bundle`
of the above.)

### 3.3 Presets on both layers (capability composition, not inheritance — *Q5=A*)

- **Build layer:** `type` = a named preset over *capabilities + artifact shape*.
- **Install layer:** `profile` = a named preset over *(capability + transport + host-target + config)*.

`service` is the base sox-run type; `mcp-server` *is a* service that also injects into hosts
(*Q3=C*). Decided model is **capabilities underneath, named presets on top** — so multi-axis combos
(e.g. a CLI that's also a slash-command, or an MCP that's both stdio and a service) compose cleanly.

### 3.4 Provenance ledger (makes merge-types reversible + diffable)

`json-merge` / `array-merge` write into **shared host files** (`settings.json`, `.mcp.json`,
`~/.claude.json`). Clean uninstall and `diff` are impossible without recording what sox wrote:

```jsonc
// .sox/ledger/<host>.<scope>.json   (granularity = open decision §9)
{ "ext": "tokenguard@0.3.0", "host": "claude", "scope": "project",
  "actions": [
    { "cap": "materialize", "path": "~/.sox/ext/tokenguard@0.3.0/" },
    { "cap": "json-merge",  "file": ".mcp.json", "keyPath": "mcpServers.tokenguard", "appliedHash": "sha256:…" },
    { "cap": "array-merge", "file": "~/.claude.json", "keyPath": "projects[<repo>].enabledMcpjsonServers", "values": ["tokenguard"] }
  ], "installedAt": "…" }
```

- **uninstall** = reverse each action (never touch another tool's entries).
- **diff/status** = compare `appliedHash` vs live value → up-to-date / drifted / will-change.

### 3.5 Host registry (where "predefined support" lives)

A pluggable per-host module: `{ host, detect(), scopePaths(scope), surfaces{…} }`. Holds the verified
location matrix (§4), the scope→path resolver, and a **detector** for install-time host defaulting.

---

## 4. Verified facts (Claude host) — real FS on this machine, 2026-06

**Verified present** (high confidence):

| Surface | User `~/.claude/` | Project | Capability |
|---|---|---|---|
| agents | `agents/<id>.md` | `.claude/agents/<id>.md` | file-drop |
| skills | `skills/<id>/` | `.claude/skills/<id>/` | file-drop |
| commands | `commands/<id>.md` | `.claude/commands/<id>.md` | file-drop |
| CLAUDE.md | `CLAUDE.md` | `./CLAUDE.md` | file-drop/append |
| settings | `settings.json` / `settings.local.json` | `.claude/settings.json` / `.local.json` | json-merge |
| permissions | `settings.json → permissions` | same | array-merge |
| hooks | `settings.json → hooks` **+** `~/.claude/hooks/<name>/` | `.claude/settings.json → hooks` | json-merge + file-drop |
| MCP servers | `~/.claude.json → mcpServers` | repo-root `.mcp.json → mcpServers` | json-merge (+ materialize) |
| MCP trust (project) | `~/.claude.json → projects[<repo>].enabledMcpjsonServers` | — | array-merge |
| plugins | `~/.claude/plugins/` (`installed_plugins.json`, `marketplaces/`) + `settings.json → enabledPlugins` | — | registry + json-merge |

**Corrections vs the earlier (agent-recalled) table:** user MCP lives in `~/.claude.json` (not
settings.json); hooks are *also* a directory; plugins register via `installed_plugins.json` + a
marketplace; project `.mcp.json` servers are **trust-gated** via `enabledMcpjsonServers`.

**P0.5 doc-verification results (live Claude docs, 2026-06):**

- **`rules` CONFIRMED** (`.claude/rules/**/*.md`, `paths:` glob frontmatter; Managed > User > Project; unconditional load at launch, path-scoped load on demand) → `prompt --inject rules` valid.
- **`output-styles` is NOT a file surface** — only a `settings.json → outputStyle` *value*. **Drop `output-style` from `prompt --inject`.**
- **`keybindings.json` CONFIRMED but user-only**, plain JSON.
- **Hooks are NOT auto-discovered** from `~/.claude/hooks/` — that dir is a conventional script store; the script is referenced **by absolute path / `${CLAUDE_PROJECT_DIR}`** in `settings.json → hooks`. So a `hook` = **file-drop (script, any path) + config-merge (settings entry → that path)**. Event list is large; handler types `command|http|mcp_tool|prompt|agent`.
- **No `enableAllProjectMcpServers`** — project `.mcp.json` trust is an approval **prompt** (reset: `claude mcp reset-project-choices`). **Do not auto-write a trust flag; default `--trust prompt`.**
- MCP entry richer than noted: `type: stdio|http|sse|ws` + `timeout`, `alwaysLoad`.

**Scope mapping:** project → `.claude/…` (and repo-root `.mcp.json`); user → `~/.claude/…`; local →
`.claude/settings.local.json`; **managed tier → sox never writes it.**

### 4b. Codex host (verified live docs, 2026-06)

Codex validated that the host registry isn't Claude-shaped. Key deltas:

- **Home `$CODEX_HOME` (default `~/.codex`); config is TOML** (`config.toml`). The hub for MCP, hooks,
  agents, permissions, providers, plugin toggles → needs **`config-merge` in TOML mode**.
- **Layers:** CLI flags > profile (`$CODEX_HOME/<name>.config.toml`) > project `.codex/config.toml`
  (**trusted projects only**) > user `~/.codex/config.toml`.
- **Project scope is trust- AND key-restricted:** `model_providers`, `notify`, `profile`, `otel`,
  base-URLs **cannot** be set at project scope; project config no-ops until `trust_level = "trusted"`.
  → the registry encodes per-host *project-forbidden keys* + trust semantics (parallels Claude's
  managed-never).

| Codex surface | Scope → path | Format / key | Capability |
|---|---|---|---|
| main config | user `~/.codex/config.toml` · project `.codex/config.toml` (trusted) | TOML tables | config-merge (toml) |
| MCP servers | config.toml `[mcp_servers.<id>]` (stdio: command/args/env; http: url/…) | TOML sub-table | config-merge (toml) |
| AGENTS.md (= CLAUDE.md) | global `~/.codex/AGENTS.md` · repo `AGENTS.md` root→CWD (closer wins), `*.override.md` beats `*.md`; 32 KiB cap | Markdown | file-drop |
| skills | `.agents/skills/<skill>/SKILL.md` (**[path CONFLICT]** vs community `~/.codex/skills`) | dir + `SKILL.md` (name/description) | file-drop |
| hooks | config.toml `[hooks.<Event>]` (feature-flagged) or `hooks.json` | TOML/JSON | config-merge |
| subagents | config.toml `[agents.<name>]` (+ optional `config_file`) | TOML | config-merge (toml) |
| permissions | `approval_policy` + `sandbox_mode` + `[permissions.<name>]` profiles | TOML | config-merge (toml) |
| statusline/theme | `tui.status_line` / `tui.theme` | TOML | config-merge (toml) |
| plugins | `codex plugin marketplace add …` + config.toml `[plugins."<p>@<m>"]` toggles | CLI + TOML | process-register + config-merge |
| custom prompts | `~/.codex/prompts/*.md` — **DEPRECATED** (migrate to skills) | Markdown | file-drop |
| slash commands | built-in only — **NOT user-extensible** | — | NONE |

**Claude ↔ Codex divergence (why the host-keyed descriptor is right):** the *same* logical extension
maps to *different* capabilities per host — e.g. an **agent** is `file-drop .claude/agents/x.md` on
Claude but `config-merge [agents.x]` on Codex; a **slash command** has **no Codex equivalent**
(deprecated prompts / migrate-to-skill). The TYPE is host-agnostic; capability+target come from the
registry. **Skills are near-1:1** (same `SKILL.md` shape).

**Codex shared-file hazards:** `AGENTS.md` (human-authored — prefer an owned `AGENTS.override.md` or a
`project_doc_fallback_filenames` entry, never clobber) and `config.toml` (ledger-tracked keys).

**Codex open items → P0.6 (verify against installed CLI):** the **skills path** (`.agents/skills` per
official docs vs `~/.codex/skills` community) and the **plugin cache/marketplace paths** are
medium-confidence — verify against the actual installed Codex version before wiring.

---

## 5. Lifecycle (where each layer is defined / consumed)

```
init ─► build ─► validate ─► install(host,scope,profile) ─► [run | inject] ─► update/diff ─► uninstall
```

| Stage | Behavior |
|---|---|
| **init** | nx-style generator (typed options + `x-prompt`). Picks a **type preset** → scaffolds the artifact **and** the host-keyed `install` descriptor (pre-filled from the host registry) **and** any `profiles`. Author edits only `config` + overrides. |
| **build** | compiles code / no-op for declarative; produces the payload. |
| **validate** | L1 type/schema; L3 descriptor references *known capability × known host surface × allowed scope*; payload matches capability; `profiles ⊆ serves`; refuses `managed`. |
| **install `-s <scope> [--host <h>] [--profile <p>]`** | detect host (§6) → resolve target via registry → run capability installers → merge `config` → write ledger entry. |
| **run / inject** | `run-service` → sox supervises; injected → host runs (verify = present+valid at target). |
| **update** | re-resolve version → diff desired-vs-ledger → apply delta only. |
| **diff / status** | ledger vs disk; supports drift + pending-change + cross-scope view. |
| **uninstall** | reverse ledger actions; clean even for shared-file merges. |

### 6. Host detection at install

`install` (esp. project scope) defaults `--host` from a detector: `.claude/` / `.mcp.json` / `CLAUDE.md`
→ claude; `.codex/` → codex; user scope ← `~/.claude/` etc. Detected host wins for host-specific
installs; `--host` overrides; multiple detected → prompt; none → error with guidance; host-agnostic
content skips detection.

### 7. Configurable generators (nx-style)

`init` maps to nx generators with a `schema.json` (typed options + `x-prompt`). Examples:

```bash
sox init mcp-server tokenguard --host claude,sox --transports stdio,sse --profiles standalone,shared
sox init command codereview --with-slash-command --runtime node --bin-scope project
sox init agent reviewer --host claude --runtime declarative
```

`init` materializes the host-keyed `install` descriptor + `profiles` from the chosen options.

---

## 8. MCP wrapper — `@adhd/sox-mcp-runtime` (the "build the template for them" lever)

Because sox owns the template, dual-transport + dual-profile + enforcement is a property of a **shared
wrapper lib**, not a burden on authors.

- **Author writes only tools:** `serve(defineTool(...))`. No transport/protocol code.
- **Wrapper owns:** both transports from one binary (stdio loop + sse/http listener; chosen by
  `--transport` flag/env set by the install **profile**); MCP protocol + versioning (wrap the official
  `@modelcontextprotocol/sdk`, don't reimplement — *lean, see §9*); health (stdio-ping/socket);
  graceful shutdown; **C6 permission enforcement read from policy-env, applied uniformly whether Claude
  spawns it (stdio) or sox supervises it (sse)** — generalizing memory-server's hand-rolled guard.
- **`serves` becomes derived** ("built on `@adhd/sox-mcp-runtime@^1` ⇒ stdio+sse"), and the wrapper ships
  **one generic conformance test** every MCP extension inherits (start in each transport, run
  initialize + tools/list).
- **Profiles** select topology at install:
  - `standalone` (Topology A) — Claude spawns its own stdio copy (`materialize` + `json-merge` stdio entry + project trust flag).
  - `shared` (Topology B) — sox `run-service` (sse, `singleton`) + Claude entry `{type:sse,url}`.
  - One artifact; the profile only changes launch args/target shape.
- **Retires duplication:** memory-server's MCP loop + vendored `compilePolicyFromEnv` collapse into
  `@adhd/sox-mcp-runtime` (C7-clean, like `memory-core`).

Constraint kept honest: "supports both" requires the server to *implement* both transports — the wrapper
provides that; the manifest just declares/validates it.

---

## 9. Decisions (resolved — design session 2026-06; see ADR-0002)

1. **Type/preset breadth → keep 8 presets** (agent, skill, mcp-server, service, command, hook, prompt,
   bundle). `rules`/`output-style` = `prompt --inject` targets; `statusline` = config. `prompt` resolved
   as the content-injection type.
2. **Install descriptor → hybrid** (manifest: `type` + chosen profiles/hosts + overrides; engine fills
   registry defaults at install).
3. **Ledger → one file per scope** (`<scope-root>/.sox/ledger.json`); project ledger **committed +
   portable**; machine-specific actions in the gitignored user ledger (`~/.sox/`).
4. **`@adhd/sox-mcp-runtime` → wrap** the official `@modelcontextprotocol/sdk`.
5. **Verify-before-rely:** Claude `rules`/`output-styles`/`keybindings` + project `.mcp.json`, **and the
   full codex matrix**, are doc/FS-verified before any tooling depends on them.
6. **Multi-host → Claude + codex now** (registry + two host modules), further hosts additive.

---

## 10. Phased implementation (to become the plan-state-machine)

Each phase reality-verified (the project rule: prove against the OS/host, not tests).

- **P0 — Boundary ADR.** ✅ `docs/decisions/0002-extension-install-model.md` (accepted; all decisions resolved).
- **P0.5 — Surface verification.** ✅ Done (2026-06, live docs). Claude corrections + the codex matrix
  are in §4/§4b; headline: **`config-merge` must be format-aware (json | toml)** because codex config
  is TOML. `output-style` dropped as a file surface; hook = file-drop + config-merge; MCP trust =
  prompt (no auto-flag).
- **P0.6 — Verify codex paths against the installed CLI.** Resolve the medium-confidence codex items
  before wiring: the **skills path** (`.agents/skills` vs `~/.codex/skills`) and **plugin
  cache/marketplace paths**. (Carry-over from P0.5; affects the codex host-registry module only.)
- **P1 — Schema delta.** Generalize `install-target` → host-keyed `install` descriptor (**hybrid**: type
  - profiles/hosts + overrides); add `config`, `serves`, `profiles`, `source` provenance, `prompt
  --inject`. Deprecate vestigial `agent` lifecycle. `validate` enforces `profiles ⊆ serves`, known
  surfaces, no `managed`.
- **P2 — Capability engine + ledger + registry.** Implement the ~6 capabilities (apply/reverse/diff/
  verify) + per-scope provenance ledger (committed/portable project ledger; local user ledger) + the
  host registry shipping **two modules: `claude` and `codex`** (detectors, scope resolvers, verified
  matrices).
- **P3 — Install/update/diff/uninstall wired to capabilities**, scope- and host-aware; host detection.
  *Acc: a markdown agent installs into `.claude/agents/`, shows in `diff`, version bump updates it,
  uninstall removes it — across project + user, verified on disk.*
- **P4 — `@adhd/sox-mcp-runtime` wrapper** (wrap MCP SDK + transport selection + policy-env enforcement +
  generic conformance test). Re-home `memory-server` onto it (retire duplication).
- **P5 — Generators (nx-style options).** `init` emits descriptor + profiles from typed options.
- **P6 — Reconcile DoD.** Split B2 "run" into *run (process)* vs *placed+discoverable (declarative)*;
  reality-verify declarative install/update/uninstall; update `CLAUDE.md`/`DOD.md`.
- **P7 — Unblock ingestion.** The `docs/ingestion/` prompts (`strategy`, `workflow-researcher`, …)
  become runnable once P3 lands; remove their "blocked" caveat.

---

## 11. Relationship to other work / DoD impact

- **Builds on:** the nx self-hosting foundation and the completed **C6** runtime-permission engagement
  (its policy-env contract is what `@adhd/sox-mcp-runtime` reuses for universal enforcement).
- **Unblocks:** `docs/ingestion/` (declarative agent/skill/command ingestion from Claude plugins —
  the original goal).
- **DoD:** exposes that B2's "run" was only verified for code/process types; P6 corrects the bar and
  delivers the declarative half honestly. This is arguably a **new first-class DoD requirement**
  (declarative-content support across scopes), to be added deliberately, not assumed.

---

## Appendix A — `init` generator options (the P5 schema)

nx-style generators: each option is `flag` — choices `[default]` → *manifest part it drives*; prompted
(`x-prompt`) when omitted, flaggable for CI. These materialize `type` + the `install` descriptor +
`serves`/`profiles` + `config`.

### Common to every type

```
<id>                       positional, kebab-case        → id
--description "…"           (x-prompt)                    → description
--version 0.1.0            [0.1.0]
--host claude[,codex]      [detected, else claude]       → install.<host>
--scope project|user|local [project]                     → default target scope hint
--bundle <bundle-id>       optional                      → bundle member
--permissions / --fs-read --fs-write --net --socket      → config.permissions (array-merge)
--env KEY1,KEY2            optional                       → config.env
--author / --license
```

### Content convention (declarative/content types — `agent`(declarative), `skill`, `prompt`; also slash `command`, `hook` script, `CLAUDE.md`)

```
--content "<text>"         inline text fills the file
--content @<path>          @ = read body from a path (mirrors Claude @import)
--from   @<dir>            dir-shaped artifacts (skill / agent+resources): copy the whole tree
                           (omitted → template stub). Records `source:` provenance for re-pull.
```

### `mcp-server`

```
--transports stdio,sse,http [stdio]      → serves{}
--profiles standalone,shared [standalone]→ profiles{}   (alias: --mode inject|service|both)
--default-profile <name> · --runtime node|python [node]
--wrapper / --no-wrapper [wrapper]       → depend on @adhd/sox-mcp-runtime
--tools name1,name2                      → tool stubs
--port <n>|auto [auto] · --health stdio-ping|socket|command [stdio-ping]
--singleton [shared] · --stop-timeout <ms> [5000] · --trust prompt|enable [prompt]
```

### `service` (sox-run; no `--host`)

```
--runtime node|python|shell [node] · --background [on] · --singleton [on]
--health stdio-ping|socket|command [socket] · --health-endpoint <path|url>
--stop-timeout <ms> [5000] · --port <n>|auto / --socket <path>
```

### `agent`

```
--shape declarative|code [declarative]   → runtime: declarative|node
declarative: --model <m> · --tools Read,Edit,… · --proactive · --content/--from
code:        --handler <fn> [run] · --runtime node|python
```

### `skill` (declarative → `.claude/skills/<id>/`)

```
--content/--from · --with-resources · --allowed-tools … · --disable-model-invocation · --run-in fresh|current
```

### `command` (CLI and/or slash)

```
--surface cli|slash|both [cli]
cli:   --runtime node|python|shell [node] · --bin-name <n> [<id>] · --bin-scope user|project [project] · --args-schema
slash: --host claude · --argument-hint "…" · --content/--from
```

### `hook`

```
--event PreToolUse|PostToolUse|SessionStart|SessionEnd|UserPromptSubmit|Stop|… (multi)
--matcher "Bash"|"*"|<regex> [*] · --handler-type command|http|mcp_tool|prompt|agent [command]
--runtime node|python|shell [shell] · --blocking|--non-blocking [non-blocking] · --content/--from (script)
--host claude  → settings.hooks + ~/.claude/hooks/<id>/
```

### `prompt` (content-injection — resolved)

```
--content "<text>" | --content @<path>   → body
--inject claude-md|rules|output-style|settings-key [rules]   → injection target
--host claude · --scope … · --paths "src/**" (rules) · --mode append|replace [append] (claude-md) · --key <dot.path> (settings-key)
```

### `bundle`

```
--members id@^1,id2@^0.2,… → members[]
--from-plugin <path>       → extract a Claude plugin dir into member extensions (ingestion)
--host claude[,codex] · --install-mode all|select [all]
```
