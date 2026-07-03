# opencode Configuration — Schemas & Semantics

> Authoritative schema: <https://opencode.ai/config.json>
> Issue tracker: <https://github.com/anomalyco/opencode/issues>

## Table of Contents

1. [Config file locations](#config-file-locations)
2. [Agent mode semantics](#agent-mode-semantics)
3. [Agent definition forms](#agent-definition-forms)
4. [CLI launch patterns](#cli-launch-patterns)
5. [Agent config schema](#agent-config-schema)
6. [Top-level config schema](#top-level-config-schema)
7. [Permission system](#permission-system)
8. [MCP server config](#mcp-server-config)
9. [Provider config](#provider-config)
10. [sox-ecosystem agent catalog](#sox-ecosystem-agent-catalog)
11. [Escape hatches](#escape-hatches)

---

## Config file locations

```
opencode.json              # Project root (ignored if .opencode/opencode.json exists)
opencode.jsonc             # Project root (JSONC variant)
.opencode/opencode.json    # Inside .opencode/ directory (highest project priority)
~/.config/opencode/opencode.json  # Global/user config
```

Merge order: global → project. Project overrides global. `$schema` field should always point to `https://opencode.ai/config.json`.

Config is read once at startup. Changes require restart (`opencode` exit, then relaunch).

---

## Agent mode semantics

| Mode | `--agent <name>` CLI | `task` tool dispatch | `default_agent` | Hidden? |
|------|---------------------|---------------------|-----------------|---------|
| `primary` | Yes | No | Eligible | No |
| `subagent` | **No — silently falls back to default** | Yes | Not eligible | Optional (`hidden: true`) |
| `all` | Yes | Yes | Eligible | No |

### The silent fallback trap

When you run `opencode --agent my-agent` and the agent has `mode: subagent`, opencode **does not error** — it silently falls back to the `default_agent` (or the built-in `build` agent if no default is set). The model from your agent config is **not** used. The fallback agent's model is used instead.

**Fix**: Set `mode: all` for agents you want to use both interactively and as dispatched subagents.

### `hidden: true`

Hides the agent from `@` autocomplete in the TUI. Only applicable when `mode: subagent`. Hidden agents can still be dispatched by name via the `task` tool.

---

## Agent definition forms

### Form A: Inline in `opencode.json`

```json
{
  "agent": {
    "my-agent": {
      "description": "What it does and when to use it",
      "mode": "all",
      "model": "provider/model-id",
      "prompt": "You are a...",
      "temperature": 0.1,
      "steps": 30,
      "permission": {
        "edit": "allow",
        "bash": "allow"
      }
    }
  }
}
```

`prompt` supports `{file:relative/path.md}` syntax to load the system prompt from a file.

### Form B: File (`.opencode/agents/<name>.md`)

```markdown
---
description: What it does and when to use it
mode: all
model: provider/model-id
temperature: 0.1
steps: 30
permission:
  edit: allow
  bash: allow
---

You are a... (markdown body becomes the system prompt)
```

The file body (below `---`) is the agent's system prompt. Do **not** put `prompt:` in the frontmatter of a file-based agent.

### Precedence

Both forms may coexist. The config merge rules:

- `opencode.json` `agent.<name>` fields override the `.md` file's frontmatter of the same name.
- Config is **deep-merged**, not replaced wholesale. For example, `permission` is merged key-by-key.
- If you define `prompt` in `opencode.json`, it replaces the `.md` file's body as the system prompt.

**sox-ecosystem convention**: All three agents (pro, implement, flash) have both forms. The `opencode.json` inline form uses `{file:.opencode/prompts/<agent>-system.md}` for the prompt, which overrides the `.md` file body. The `.md` files exist as reference documentation for the agent's personality and conventions.

### Built-in agents (names reserved)

`build`, `plan`, `general`, `explore`, `title`, `summary`, `compaction`

To override a built-in's fields, use the same key in `agent: { build: { ... } }`. To disable: `agent: { build: { disable: true } }`.

---

## CLI launch patterns

```bash
# Default agent (default_agent setting, or built-in 'build')
opencode

# Specific agent by name
opencode --agent flash
opencode --agent implement
opencode --agent pro

# Agent must have mode: primary or mode: all

# With explicit model override
opencode --model deepseek/deepseek-v4-flash
opencode --agent flash --model deepseek/deepseek-v4-pro

# Command mode (runs a command agent)
opencode /my-command

# Pass a one-shot prompt
opencode "fix the compile error in src/foo.ts"
```

### The `default_agent` field

```json
{
  "default_agent": "pro"
}
```

Must point to a non-hidden, `primary` or `all` mode agent. Falls back to `build` if the specified agent is invalid or missing.

---

## Agent config schema

All fields are optional.

| Field | Type | Description |
|-------|------|-------------|
| `model` | `string` | Provider/model ID, e.g. `deepseek/deepseek-v4-flash` |
| `variant` | `string` | Model variant override |
| `mode` | `"primary"` \| `"subagent"` \| `"all"` | Agent availability |
| `description` | `string` | Shown in `@` autocomplete; required for discoverability |
| `prompt` | `string` | System prompt (inline form) or `{file:path.md}` |
| `temperature` | `number` | 0–1 sampling temperature |
| `top_p` | `number` | Nucleus sampling |
| `steps` | `integer` | Max agentic iterations before forcing text-only |
| `hidden` | `boolean` | Hide from `@` autocomplete (subagent only) |
| `disable` | `boolean` | Disable this agent entirely |
| `color` | `string` | Hex `#FF5733` or theme color name |
| `options` | `object` | Arbitrary provider options passed through |
| `permission` | `object` | Agent-specific permission rules |

### Deprecated fields

| Field | Replacement |
|-------|------------|
| `maxSteps` | Use `steps` |
| `tools` | Use `permission` |

---

## Top-level config schema

Complete schema at <https://opencode.ai/config.json>. Key fields:

| Field | Type | Description |
|-------|------|-------------|
| `$schema` | `string` | `"https://opencode.ai/config.json"` for editor validation |
| `model` | `string` | Default model: `provider/model-id` |
| `small_model` | `string` | Fast model for title/summary generation |
| `default_agent` | `string` | Default agent for interactive sessions |
| `username` | `string` | Display name override |
| `shell` | `string` | Default shell: `/bin/zsh`, `/bin/bash` |
| `logLevel` | `"DEBUG"` \| `"INFO"` \| `"WARN"` \| `"ERROR"` | |
| `agent` | `object` | Agent definitions keyed by name |
| `command` | `object` | Command definitions keyed by name |
| `skills` | `object` | `{ paths: string[], urls: string[] }` |
| `references` | `object` | Named git/local directory references |
| `plugin` | `array` | Plugin entries: strings or `[name, opts]` tuples |
| `provider` | `object` | Provider configs keyed by provider name |
| `disabled_providers` | `string[]` | Providers to disable |
| `enabled_providers` | `string[]` | If set, ONLY these providers are enabled |
| `mcp` | `object` | MCP server configs keyed by server name |
| `permission` | `object` | Global permission rules |
| `formatter` | `boolean` \| `object` | Enable/configure code formatters |
| `lsp` | `boolean` \| `object` | Enable/configure LSP servers |
| `instructions` | `string[]` | Additional instruction files to load |
| `share` | `"manual"` \| `"auto"` \| `"disabled"` | Session sharing |
| `autoupdate` | `boolean` \| `"notify"` | Auto-update behavior |
| `snapshot` | `boolean` | Enable filesystem undo/redo (default: true) |
| `compaction` | `object` | Auto-compaction settings |
| `tool_output` | `object` | `{ max_lines, max_bytes }` truncation thresholds |
| `experimental` | `object` | Experimental features |
| `attachment` | `object` | Image attachment limits |
| `server` | `object` | Server mode config |
| `watcher` | `object` | `{ ignore: string[] }` file watch exclusions |

---

## Permission system

### Action values: `"allow"`, `"ask"`, `"deny"`

### Top-level shorthand

```json
"permission": "allow"   // Allow everything — rarely what you want
```

### Object form

```json
"permission": {
  "edit": "deny",
  "bash": { "git *": "allow", "rm *": "deny", "*": "ask" },
  "external_directory": { "~/secrets/**": "deny", "*": "allow" },
  "webfetch": "allow",
  "task": "ask"
}
```

### Per-tool config types

**Pattern-based** (object with glob patterns): `read`, `edit`, `glob`, `grep`, `list`, `bash`, `task`, `external_directory`, `lsp`, `skill`

**Flat action only**: `todowrite`, `question`, `webfetch`, `websearch`, `doom_loop`

### Rule evaluation order

Rules are evaluated **insertion order** with **last-match wins**. Put broad rules first, narrow overrides last:

```json
"bash": {
  "*": "allow",          // First: broad allow
  "rm *": "deny",       // Last: narrow deny — this wins
  "git rm *": "allow"    // Last: even narrower allow — this wins
}
```

### Per-agent permissions

Agent-level `permission` overrides the top-level `permission`. Useful patterns:

- Plan mode agent: `{ "edit": "deny", "bash": "deny" }`
- Code review agent: `{ "edit": "deny", "bash": "ask" }`
- Implementation agent: `{ "edit": "allow", "bash": "allow" }`

---

## MCP server config

### Local (stdio)

```json
"mcp": {
  "my-server": {
    "type": "local",
    "command": ["node", "server.js", "--port", "3000"],
    "cwd": "./my-server",
    "environment": { "NODE_ENV": "production" },
    "enabled": true,
    "timeout": 5000
  }
}
```

### Remote (SSE/HTTP)

```json
"mcp": {
  "github": {
    "type": "remote",
    "url": "https://api.github.com/mcp",
    "headers": { "Authorization": "Bearer {env:GITHUB_TOKEN}" },
    "enabled": true,
    "timeout": 5000
  }
}
```

String values support `{env:VAR}` and `{file:path}` interpolation.

### Disabling inherited servers

```json
"mcp": {
  "inherited-server": { "enabled": false }
}
```

---

## Provider config

```json
"provider": {
  "deepseek": {
    "options": {
      "apiKey": "{env:DEEPSEEK_API_KEY}",
      "baseURL": "https://api.deepseek.com/v1",
      "timeout": 120000
    }
  }
}
```

Provider options: `apiKey`, `baseURL`, `enterpriseUrl` (for GitHub Enterprise copilot), `setCacheKey`, `timeout`, `headerTimeout`, `chunkTimeout`.

### Provider-model syntax

Model names always use the `provider/model-id` format:

```
anthropic/claude-sonnet-4-6
deepseek/deepseek-v4-pro
deepseek/deepseek-v4-flash
openai/gpt-4o
google/gemini-2.5-pro
```

---

## sox-ecosystem agent catalog

Three custom agents built for the soxe monorepo workflow:

| Agent | Model | Mode | Steps | Temperature | Permissions |
|-------|-------|------|-------|-------------|-------------|
| **pro** | `deepseek/deepseek-v4-pro` | `all` | 20 | 0 | Read/glob/grep/web, task dispatch, no edits |
| **implement** | `deepseek/deepseek-v4-pro` | `all` | 40 | 0.1 | Full read/edit/bash, no task dispatch, no websearch |
| **flash** | `deepseek/deepseek-v4-flash` | `all` | 30 | 0.1 | Full read/edit/bash, no task dispatch, no webfetch/search |

### Agent roles

**pro** — Architect + orchestrator. Plans features, decomposes into dispatchable segments, researches tool choices, dispatches implement/flash agents. Never writes code directly.

**implement** — Complex implementation. Multi-file changes, interface design, cross-package refactors, debugging unknown root cause, algorithm changes. Uses `gitnexus_impact` before modifying symbols.

**flash** — Fast implementation. Single-file changes, manifest edits, well-specified boilerplate, exact-code-from-spec tasks. No refactoring, no interface design, no unknown-bug debugging.

### Launch examples

```bash
opencode --agent pro        # Architect mode — plan and decompose
opencode --agent implement  # Complex implementation mode
opencode --agent flash      # Fast implementation mode
```

---

## Escape hatches

When config is broken and opencode won't start:

```bash
# Skip project config, load globals only
OPENCODE_DISABLE_PROJECT_CONFIG=1 opencode

# Load an additional config file
OPENCODE_CONFIG=/path/to/extra.json opencode

# Inject inline JSON config
OPENCODE_CONFIG_CONTENT='{"model":"anthropic/claude-sonnet-4-6"}' opencode

# Skip default plugins
OPENCODE_DISABLE_DEFAULT_PLUGINS=1 opencode

# Skip all external plugins
OPENCODE_PURE=1 opencode

# Skip external skill scans
OPENCODE_DISABLE_EXTERNAL_SKILLS=1 opencode
OPENCODE_DISABLE_CLAUDE_CODE_SKILLS=1 opencode
```
