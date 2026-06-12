# Per-type shapes — discovery findings

**State:** type-discovery (P6)
**Date:** 2026-06-11
**Sources read:** `~/dev/ai/claude-agents/tools/hooks/` (shell hooks), `~/dev/node/adhd/packages/ai/agent-mcp` (MCP server), `~/dev/ai/sox-protocol/packages/python/` (Python command), `~/dev/ai/claude-agents/tools/cli/` (Node command), `~/dev/ai/claude-agents/categories/workflow/skills/` (skills), `~/dev/ai/claude-agents/categories/00-active/agents/` (agents).

---

## hook

**Entrypoint form:** Shell script (`hook.sh`) with `#!/usr/bin/env bash` shebang. The dominant real pattern (`agent-tool-logger.sh`, `budget-gate.sh`, `validate-plans.sh`, `lint-feedback.sh`) is a standalone Bash script. Node CJS hooks also exist (`gitnexus-hook.cjs`, `agent-touch.js`) for more complex logic requiring npm modules — these set `runtime: node`. **Template default changed to `runtime: shell` to match the dominant pattern.**

**Runtime:** `shell` (default). `node` for Node-based hooks.

**Entrypoint:** `hook.sh` (the script file). Shell hooks need no build step.

**Install-target:** N/A — hooks are registered via the host's settings.json `hooks.<event>` array, not placed at a discovery path.

**Payload protocol:** JSON payload arrives on **stdin** (`cat`/`jq -r`). Output: JSON to stdout (`systemMessage`, `permissionDecision`) or exit 0 for no-op. The `events` array in the manifest declares which lifecycle events trigger the hook (`PreToolUse`, `PostToolUse`, etc.).

**Key refinements made:** Template changed from `runtime: node` + `src/index.ts` to `runtime: shell` + `hook.sh` with bash shebang. Removed tsconfig/package build scripts (no build step for shell hooks). Added output protocol docs to README.

---

## mcp-server

**Entrypoint form:** `src/index.ts` with `#!/usr/bin/env node` shebang. Real production server (`@adhd/agent-mcp`) uses `@modelcontextprotocol/sdk` with `StdioServerTransport` and `server.setRequestHandler(ListToolsRequestSchema, ...)` / `server.setRequestHandler(CallToolRequestSchema, ...)`. The raw-readline approach in the previous template was a non-standard stub.

**Runtime:** `node`. Background singleton process.

**Entrypoint:** `dist/index.js` (compiled from `src/index.ts`).

**Install-target:** N/A — the host discovers MCP servers via registered stdio processes; `sox start` launches the process.

**SDK dependency:** `@modelcontextprotocol/sdk` (`>=1.0.0`) is a real runtime dependency. Added to the generated `package.json`.

**Key refinements made:** Replaced raw `readline` JSON-RPC stub with proper `@modelcontextprotocol/sdk` `Server` + `StdioServerTransport` pattern. Added `#!/usr/bin/env node` to entry. Added `@modelcontextprotocol/sdk` to generated `package.json` dependencies. Pattern matches the real production `@adhd/agent-mcp` shape.

---

## command

**Entrypoint form:** `src/index.ts` with `#!/usr/bin/env node` shebang (Node variant). Real Node commands (`briefing.js`, `program.js`) are ES modules importing from `node:fs`, `node:path`, and Commander. Python variant uses `pyproject.toml` + `[project.scripts]` entry (`sox-protocol = "sox_protocol.cli:main"`). **Template defaults to Node; Python variant documented in README.**

**Runtime:** `node` (default). `python` for Python-based commands ([flex:runtime-expanded] already in schema).

**Entrypoint:** `dist/index.js` (compiled). Python: the package entry from `[project.scripts]`.

**Install-target:** N/A for node commands. Python commands install via pip/uv.

**invocation.protocol:** Changed from `function-export` to `stdio` — real CLI commands receive args via `process.argv`, not via an imported function call from the host.

**package.json:** Added `bin` field pointing to `dist/index.js` so the command is directly invocable after install.

**Key refinements made:** Added `#!/usr/bin/env node` shebang. Changed `invocation.protocol` from `function-export` to `stdio`. Added `bin` field to `package.json`. Updated README with Python alternative path.

---

## skill

**Entrypoint form:** `SKILL.md` — a markdown file with YAML frontmatter (`name`, `description`). The real shape (`plan-state-machine/SKILL.md`, `workflow-memory/SKILL.md`) is a pure markdown document with frontmatter. No source code, no build step. The previous template generated `src/index.ts` + `tsconfig.json` + build scripts, which does not match reality.

**Runtime:** `declarative` — no process is spawned. The host injects the `SKILL.md` content at invocation time. **Template changed from `runtime: node` to `runtime: declarative`.**

**Entrypoint:** `SKILL.md` (the markdown definition). [flex:entrypoint-optional] — present but points to the markdown file.

**Install-target:** `~/.claude/skills/<id>/` — the host discovers skills at this path. [flex:install-target] applied.

**Key refinements made:** Replaced `src/index.ts` + `tsconfig.json` + `run_interface` with `SKILL.md` frontmatter + markdown body. Changed `runtime: node` to `runtime: declarative`. Added `entrypoint: SKILL.md`. Added `install-target`. Removed build scripts from `package.json` (minimal identity-only `package.json`).

---

## agent

**Entrypoint form:** `agent.md` — a markdown file with YAML frontmatter (`name`, `description`, `tools`, `model`). The real shape (`cto-agent.md`, `architect-reviewer.md`, `typescript-pro.md`) is a frontmatter-gated markdown document defining the agent's system prompt and capabilities. No `src/index.ts`, no build step. The previous template generated node source code with an `AgentDefinition` struct, which does not match reality.

**Runtime:** `declarative` — no process is spawned. The host reads `agent.md`, parses the frontmatter, and injects the markdown body as the agent's system prompt when delegating. **Template changed from `runtime: node` to `runtime: declarative`.**

**Entrypoint:** `agent.md`. [flex:entrypoint-optional] — present but points to the `.md` definition.

**Install-target:** `~/.claude/agents/` — the host discovers subagent definitions at this path. [flex:install-target] applied.

**Frontmatter fields:** `name` (stable id), `description` (one-liner for routing), `tools` (comma-separated list of permitted tools), `model` (e.g. `sonnet`, `opus`).

**Key refinements made:** Replaced `src/index.ts` + `tsconfig.json` + `CLAUDE.md` + node `AgentDefinition` struct with `agent.md` markdown + YAML frontmatter. Changed `runtime: node` to `runtime: declarative`. Added `entrypoint: agent.md`. Added `install-target: ~/.claude/agents/`. Removed build scripts from `package.json` (minimal identity-only `package.json`).

---

## bundle

**Entrypoint form:** None. Bundles have no entrypoint and no source code. They are manifest-only: `extension.json` with a `members` array listing member extension ids and version constraints.

**Runtime:** Absent — bundles have no runtime. `sox install <bundle>` expands to its members at the consumer's machine.

**Install-target:** N/A — bundles are expanded by the install engine, not placed at a host discovery path.

**Key refinements made:** None required. The existing template already matches the real shape (manifest-only, no entrypoint, members array, no tsconfig). [flex:entrypoint-optional] already applied.

---

## Schema changes

No schema changes were required. All three contract flexes ([flex:entrypoint-optional], [flex:runtime-expanded], [flex:install-target]) were already present in `libs/manifest/src/schema.json` and cover the shapes above:

- `runtime: "shell"` and `runtime: "declarative"` are in the existing enum.
- `install-target` is already an optional string field.
- `entrypoint` is already optional (not in `required[]`).

`apps/sox/extension.json` (type: command) continues to validate against the schema — [type-discovery.4] satisfied additively.

---

## Contract flex confirmation

| Flex | Used by | Confirmed |
|---|---|---|
| `entrypoint` optional | bundle (absent), agent (.md), skill (.md), hook (.sh) | yes |
| `runtime: shell` | hook | yes |
| `runtime: declarative` | agent, skill | yes |
| `install-target` | agent (`~/.claude/agents/`), skill (`~/.claude/skills/<id>/`) | yes |
