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
| `json-merge` | set an object key in a shared JSON | remove key | ⚠️ shared file → needs ledger |
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

**Unverified — NOT present on this machine, do not bake in until doc-checked:** `~/.claude/rules/`,
`~/.claude/output-styles/`, `~/.claude/keybindings.json`.

**Scope mapping:** project → `.claude/…` (and repo-root `.mcp.json`); user → `~/.claude/…`; local →
`.claude/settings.local.json`; **managed tier → sox never writes it.**

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

## 8. MCP wrapper — `@sox/mcp-runtime` (the "build the template for them" lever)

Because sox owns the template, dual-transport + dual-profile + enforcement is a property of a **shared
wrapper lib**, not a burden on authors.

- **Author writes only tools:** `serve(defineTool(...))`. No transport/protocol code.
- **Wrapper owns:** both transports from one binary (stdio loop + sse/http listener; chosen by
  `--transport` flag/env set by the install **profile**); MCP protocol + versioning (wrap the official
  `@modelcontextprotocol/sdk`, don't reimplement — *lean, see §9*); health (stdio-ping/socket);
  graceful shutdown; **C6 permission enforcement read from policy-env, applied uniformly whether Claude
  spawns it (stdio) or sox supervises it (sse)** — generalizing memory-server's hand-rolled guard.
- **`serves` becomes derived** ("built on `@sox/mcp-runtime@^1` ⇒ stdio+sse"), and the wrapper ships
  **one generic conformance test** every MCP extension inherits (start in each transport, run
  initialize + tools/list).
- **Profiles** select topology at install:
  - `standalone` (Topology A) — Claude spawns its own stdio copy (`materialize` + `json-merge` stdio entry + project trust flag).
  - `shared` (Topology B) — sox `run-service` (sse, `singleton`) + Claude entry `{type:sse,url}`.
  - One artifact; the profile only changes launch args/target shape.
- **Retires duplication:** memory-server's MCP loop + vendored `compilePolicyFromEnv` collapse into
  `@sox/mcp-runtime` (C7-clean, like `memory-core`).

Constraint kept honest: "supports both" requires the server to *implement* both transports — the wrapper
provides that; the manifest just declares/validates it.

---

## 9. Open decisions (must close before formalizing)

1. **Preset/type breadth (Q6/Q7):** keep the existing names as the only presets (new surfaces = raw
   capabilities), or promote some (e.g. `rules`/`instructions`, `output-style`) to first-class types?
   And **resolve `prompt`** (likely = instruction injection into CLAUDE.md/rules/output-style).
2. **Install descriptor location:** materialized in the manifest at init (explicit/overridable) vs
   resolved from the registry at install (DRY). Leaning materialized-at-init.
3. **Ledger granularity/location:** `.sox/ledger/<host>.<scope>.json` per install root vs centralized.
4. **`@sox/mcp-runtime`:** wrap the official MCP SDK (lean) vs reimplement. Strong lean: **wrap**.
5. **Verify the unconfirmed surfaces** (`rules`, `output-styles`, `keybindings`) and the **project
   `.mcp.json`** path against live docs before encoding them.
6. **Multi-host scope:** Claude first; when do codex/others land (host registry makes them additive)?

---

## 10. Phased implementation (to become the plan-state-machine)

Each phase reality-verified (the project rule: prove against the OS/host, not tests).

- **P0 — Boundary ADR.** Write `docs/decisions/0002-extension-install-model.md`: Role A/B boundary,
  3-layer model, capability set, ledger, host registry. (Cheap, unblocks the rest.)
- **P1 — Schema delta.** Generalize `install-target` → host-keyed `install` descriptor; add `config`,
  `serves`, `profiles`; deprecate vestigial `agent` lifecycle (or implement — tie to §9). `validate`
  enforces `profiles ⊆ serves`, known surfaces, no `managed`.
- **P2 — Capability engine + ledger.** Implement the ~6 capabilities (apply/reverse/diff/verify) +
  provenance ledger + the host registry (claude detector, scope resolver, verified matrix).
- **P3 — Install/update/diff/uninstall wired to capabilities**, scope- and host-aware; host detection.
  *Acc: a markdown agent installs into `.claude/agents/`, shows in `diff`, version bump updates it,
  uninstall removes it — across project + user, verified on disk.*
- **P4 — `@sox/mcp-runtime` wrapper** (wrap MCP SDK + transport selection + policy-env enforcement +
  generic conformance test). Re-home `memory-server` onto it (retire duplication).
- **P5 — Generators (nx-style options).** `init` emits descriptor + profiles from typed options.
- **P6 — Reconcile DoD.** Split B2 "run" into *run (process)* vs *placed+discoverable (declarative)*;
  reality-verify declarative install/update/uninstall; update `CLAUDE.md`/`DOD.md`.
- **P7 — Unblock ingestion.** The `docs/ingestion/` prompts (`strategy`, `workflow-researcher`, …)
  become runnable once P3 lands; remove their "blocked" caveat.

---

## 11. Relationship to other work / DoD impact

- **Builds on:** the nx self-hosting foundation and the completed **C6** runtime-permission engagement
  (its policy-env contract is what `@sox/mcp-runtime` reuses for universal enforcement).
- **Unblocks:** `docs/ingestion/` (declarative agent/skill/command ingestion from Claude plugins —
  the original goal).
- **DoD:** exposes that B2's "run" was only verified for code/process types; P6 corrects the bar and
  delivers the declarative half honestly. This is arguably a **new first-class DoD requirement**
  (declarative-content support across scopes), to be added deliberately, not assumed.
