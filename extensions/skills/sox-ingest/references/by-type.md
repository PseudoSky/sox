# sox-ingest references — by extension type

> Delegated from `SKILL.md`. This file answers: "for this source shape, which type does it map
> to, what are the decision heuristics, and what does a born-conformant scaffold look like?"
> One section per type. Consult the per-type guideline in `docs/guidelines/<type>.md` for the
> authoritative contract; this file distills the ingestion-specific decisions.

---

## `hook`

**When to use:** the source fires on a runtime event (SessionEnd, PreToolUse, PostToolUse,
ScopePromotionProposed, etc.) and exits after handling it. No persistent process.

**Reference extension:** `extensions/hooks/memory-flush/` — study its layout, manifest
(`extension.json`), entrypoint, event wiring, and `permissions` block. Mirror it exactly.

**Scaffold:**

```
node bin/soxe init hook <id>
```

**Born-conformant manifest shape** (required fields beyond the base):

- `"runtime": "node"` (or `"shell"` / `"python"`)
- `"order": <number>` — execution order among hooks for the same event
- `"events": ["<EventName>", ...]` — the exact events this hook binds
- `"entrypoint": "dist/index.js"` — the compiled output
- `"permissions": { "fs": { "read": [...], "write": [...] }, "socket": { "paths": [...] } }`

**Permissions minimum:** declare every file glob the hook reads/writes + every socket path it
connects to. Undeclared access is DENIED at runtime — an under-declared hook fails silently.

**Enable:** `node bin/soxe start <id>` — the runtime loads the hook and binds it to the declared
events. Verify with `soxe list` (state = RUNNING / loaded).

**Decision point — hook + CLI:** if the source also has a CLI that provides genuine user-facing
value, ship both as a `command` extension sharing a lib (DoD C7: no duplication), composed into a
`bundle`. If the CLI is only dev tooling, ship the hook only and drop the CLI.

**Pilot:** `swarm-cost` (source: `~/dev/ai/claude-agents/tools/hooks/swarm-cost`) — the smallest
hook in the source; designated per-type pilot for `hook`. Scaffold, port, and reality-verify this
one before batching the rest of `tools/hooks/`.

**policy-enforcer decision:** the source at `~/dev/ai/claude-agents/tools/policy-enforcer/` is
a hook (primary) plus a bundled CLI. Default to hook-only; keep the CLI only if it provides
genuine user-facing value (policy config management, audit UI). If in doubt, stop and confirm
before building the command.

---

## `skill`

**When to use:** the source is a markdown instruction set (SKILL.md + optional resource files)
with no persistent process and no event binding. A declarative unit the host loads and follows.

**Reference extension:** this skill (`extensions/skills/sox-ingest/`) is the first declared skill
extension. Follow its layout, `extension.json` shape (including the `install` block), and
references structure. Until more skills exist, the guideline (`docs/guidelines/skill.md`) is the
authoritative contract.

**Scaffold:**

```
node bin/soxe init skill <id>
```

or, with the `--from` primitive (when available):

```
node bin/soxe init skill <id> --from @<source-dir>
```

**Born-conformant manifest shape:**

- No `entrypoint` field (declarative; no compiled output)
- No `lifecycle` block (`validate` rejects it on `skill` type)
- `"install": { "type": "skill", "hosts": ["claude"], "profiles": {} }` — the install descriptor
- `"permissions": {}` — empty if the skill body implies no direct resource access; populated
  if the instructions tell the model to read/write specific paths

**Enable:** install IS enablement for declarative types. No `start` step. Verify the SKILL.md
is placed at the host-discovery path after install.

**Pilot:** `strategy` (source: `~/dev/ai/claude-agents/tools/skills/strategy/SKILL.md`) — the
smallest declarative skill in the source. If it is the first skill other than `sox-ingest`, flag
it so the founder can confirm the guideline is complete.

---

## `agent` (declarative)

**When to use:** the source is a markdown agent definition (frontmatter with name/description/
tools/model + system prompt). Installs to the host-discovery path and is invocable. No persistent
process; `lifecycle` block is vestigial on agents and ignored at runtime.

**CAUTION — two agent shapes:** CODE agents (`runtime: node`, entrypoint, `function-export`
invocation) and DECLARATIVE agents (frontmatter + system prompt, `runtime: declarative`) are
different shapes. For declarative agents, follow the `agent` guideline's declarative path;
do NOT give the extension a `lifecycle` block.

**Reference extension:** `extensions/agents/org-agent/` — use for manifest conventions
(id, version, compatibility, permissions structure). For the declarative shape, follow
the `agent` guideline.

**Scaffold:**

```
node bin/soxe init agent <id>
```

**Permissions:** map the `tools` list from the frontmatter to the manifest's `capabilities`
field. Add `permissions` only if the agent's prompt implies concrete fs/network resource access.

**Pilot:** `workflow-researcher` (source:
`~/dev/ai/claude-agents/categories/workflow/agents/workflow-researcher.md`) — declarative agent
with frontmatter (name/description/tools/model) + system prompt. Carry the system prompt
verbatim; map frontmatter to manifest fields.

---

## `mcp-server`

**When to use:** the source runs as a long-running server and exposes tools. The `lifecycle`
block is honored ONLY on `mcp-server` at runtime (not `agent`); the supervisor handles
spawning, health-checking, restarting, and stopping.

**Reference extension:** `extensions/mcp-servers/memory-server/` — study its `extension.json`
lifecycle block + health probe, permissions, and runtime field. Mirror exactly.

**Scaffold:**

```
node bin/soxe init mcp-server <id>
```

**Born-conformant manifest shape:**

- `"runtime": "node"` | `"shell"` | `"python"` | `"stdio-any"`
- `"lifecycle": { "background": true, "singleton": <bool>, "stop_timeout_ms": <ms>, "health": { "type": "stdio-ping" | "socket" | "command", ... } }`
- `"entrypoint": "dist/index.js"`
- `"permissions"` — declare ALL socket paths, network outbound, fs access; this is load-bearing

**Protocol fork (for tokenguard and similar):**

- Source already speaks MCP (stdio JSON-RPC: initialize + tools/list + tools/call) → direct port;
  health type `stdio-ping`; callable via `soxe exec`.
- Source is a non-MCP server (HTTP / socket / custom RPC) → supervised via lifecycle + socket or
  command health; for a tool surface, add a thin MCP front (tools that call the core via a shared
  lib). Report whether it is a direct port, supervised-only, or server + MCP wrap.
- If `mcp-server` is conceptually wrong for the source → stop and report; a `service` / `daemon`
  type is a founder decision.

**Enable:** `node bin/soxe start <id>` → RUNNING state in `soxe list`; verify pid.

**Pilot:** `tokenguard` (source: `~/dev/security/wop/scripts/tokenguard/`) — decision point:
type is TBD (mcp-server | command | both). Run Step 0 (resolve type mapping) before scaffolding.
If both a server and a genuine CLI ship, extract shared core into `libs/`; compose into a `bundle`.

---

## `command`

**When to use:** the source is a one-shot CLI (argv in, result/exit-code out, exits). No
persistent process, no event binding.

**Reference extension:** `extensions/commands/memory-cli/` — study its layout, manifest,
entrypoint, and permissions.

**Scaffold:**

```
node bin/soxe init command <id>
```

**Enable:** `soxe install <id>` makes it invocable. No `start` step.

---

## `bundle`

**When to use:** the source groups assets that belong together — a shared subsystem with a
server + organizer + hook + CLI. A bundle installs all members as one unit.

**Reference extension:** `extensions/bundles/sox-memory-bundle/` — study how it lists `members`
(id + version constraints) and has no entrypoint.

**Scaffold:**

```
node bin/soxe init bundle <id>
```

**Born-conformant manifest shape:** `"members": [{ "id": "<ext-id>", "version": "^<semver>" }, ...]`

**Enable:** `soxe install <id>` expands to installing all members; `soxe start <id>` runs them.
`soxe uninstall <id>` removes all members.

---

## Decision heuristics

| Source shape | First-pass type | Decision needed? |
|---|---|---|
| Fires on an event, exits after | `hook` | Only if it also has a valuable CLI (hook vs hook+command+bundle) |
| Markdown instructions + no process | `skill` (declarative) or `agent` (declarative) | Distinguish by whether it is a reusable skill unit or an agent persona |
| Long-running server with tools | `mcp-server` | Protocol: MCP direct / non-MCP supervised / non-MCP + MCP wrap |
| One-shot CLI, exits with code | `command` | Only if it shares a core with another type (extract lib) |
| Group of assets that install together | `bundle` | Always compose from already-typed members |
| `prompt` type | Unresolved | Founder: "idk what this is" — resolve or exclude before ingesting |

**When to stop and confirm:** any source that doesn't cleanly map to one type, or where the
composition has product-level implications (e.g. a supervised-only server vs a full MCP server,
or whether a CLI earns its own extension), should be stopped and confirmed with the founder
before building.

---

## Batch sequencing (multi-extension ingests)

1. One type at a time, in waves of 3-5 extensions.
2. After each wave: register the new extensions — see
   [AGENTS.md § registry is release-only](../../../AGENTS.md#registry-is-release-only) — then
   `./node_modules/.bin/nx run-many -t build,lint,test` + `nx run host-runtime:test-e2e` must all
   be green. A red wave blocks the next until fixed.
3. Track per-extension status in a catalog table (pending / done / excluded / deferred + reason).

**Source catalogs (earmarked for ingestion):**

| Type | Source | Pilot? | Notes |
|---|---|---|---|
| hook | `~/dev/ai/claude-agents/tools/hooks/swarm-cost` | yes | per-type pilot for hook |
| skill | `~/dev/ai/claude-agents/tools/skills/strategy/SKILL.md` | yes | may be first skill after sox-ingest |
| agent | `~/dev/ai/claude-agents/categories/workflow/agents/workflow-researcher.md` | yes | declarative agent |
| mcp-server / command / both | `~/dev/security/wop/scripts/tokenguard/` | yes (decision point) | type TBD — run Step 0 first |
| hook (+ optional command) | `~/dev/ai/claude-agents/tools/policy-enforcer/` | yes (decision point) | hook primary; CLI fate TBD |
| mcp-server | `/Users/nix/dev/node/adhd/packages/ai/agent-mcp` | no | not yet prompted |
| command | `~/dev/ai/sox-protocol/packages/python` | no | not yet prompted |
| hook (dir) | `~/dev/ai/claude-agents/tools/hooks/` (remaining) | no | batch after swarm-cost pilot |
| skill (dir) | `~/dev/ai/claude-agents/categories/workflow/skills/` (remaining) | no | batch after strategy pilot |
| agent (dir) | `~/dev/ai/claude-agents/categories/00-active/agents/` (remaining) | no | batch after workflow-researcher pilot |
| prompt | unresolved | no | resolve the prompt use case before ingesting |
