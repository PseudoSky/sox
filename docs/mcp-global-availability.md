# MCP Server Global Availability — How it Works and What Can Break It

This document explains how `memory-server` (and any stdio MCP server installed through sox)
reaches every Claude Code agent session, what gates are in play, and what breaks availability.

## How Claude Code loads MCP servers

Claude Code merges MCP servers from four scopes (lower = higher priority):

| Scope | Storage | Notes |
|-------|---------|-------|
| Managed | org policy | Sox never writes this tier |
| Local | `~/.claude.json` `mcpServers` | User-scope; available in every project/worktree |
| Project | `.mcp.json` at the repo/worktree root | Checked into version control |
| Local-project | `.claude/settings.local.json` | Machine-local, git-ignored |

All scopes are **additive** — a server at user scope is available alongside project-scope servers.
A server at a higher-priority scope only overrides one at a lower scope if they share the **same name**.

## Why stdio MCP servers go to `~/.claude.json`, not `.mcp.json`

Claude's `.mcp.json` accepts stdio-transport entries **for display purposes** but Claude Code
spawns them through the project trust gate (user must approve each project). To avoid the approval
prompt and ensure the server is always available without per-project trust ceremony:

- **stdio → `~/.claude.json` `mcpServers`** (user scope, always trusted, no approval gate)
- **sse/http → `.mcp.json`** (project scope, trust gate applies)

This is `[dod.2]` in the install engine — the denial that prevents stdio from accidentally landing
in `.mcp.json`. Sox enforces it at install time.

## What `sox install sox-memory-bundle --scope=user` actually does

For the `memory-server` member (type `mcp-server`, transport `stdio`):

1. Resolves the user-scope surface: `mcp-server` + user → `~/.claude.json` `mcpServers`
2. Writes `mcpServers.memory-server = { type: "stdio", command: <soxe-path>, args: ["serve", "memory-server"] }`
3. The `command` is resolved: `SOX_CLI_BIN` env var → `process.argv[1]` (the running soxe binary) → `'soxe'`
4. Records the placement in the ownership index and ledger

The `soxe serve memory-server` command is the MCP endpoint: when Claude Code starts a session it
spawns this process, which resolves the lockfile to find the memory-server artifact, exec()s it
with cascade config injected as `SOX_CONFIG_*` env vars, and hands stdin/stdout to the extension.

## The `tools:` allowlist gate in agent frontmatter

Agents with a `tools:` line in their YAML frontmatter have an **explicit allowlist**. Any MCP
tool not in that list is **unavailable to the agent regardless of what servers are running**.

To allow all memory-server tools, add `mcp__memory-server__*` to the tools list:

```yaml
---
name: my-agent
tools: Read, Write, Edit, Bash, mcp__memory-server__*
---
```

The wildcard `mcp__memory-server__*` allows all tools exposed by `memory-server`.
To allow only specific tools: `mcp__memory-server__memory_recall, mcp__memory-server__memory_write`.

If a `tools:` line is present but `mcp__memory-server__*` is absent, the agent will see the tools
as unavailable even though the server is running and trusted.

## The git worktree trap

Git worktrees check out the **committed** `.mcp.json`, not the working-tree version. If a repo's
`.mcp.json` has been modified locally (e.g. `memory-server` was added to the working tree copy
but not committed), git worktrees created from that branch will **not** have the entry.

Symptoms: agents in worktrees say memory tools are unavailable; the root repo's `.mcp.json` has
`memory-server` in it; `git status -- .mcp.json` shows `M .mcp.json`.

Fix: commit `.mcp.json` to the branch that worktrees are created from, or add `memory-server` to
the worktree `.mcp.json` directly.

## The `sox` audio-tool collision bug (BL-mcp-cmd)

Before this fix (2026-06-23), when `sox install ... --scope=user` ran without `SOX_CLI_BIN` set,
the install engine fell back to `'sox'` as the command. On macOS, `sox` resolves to the Homebrew
audio processing tool, not the extension CLI. Every MCP server entry written to `~/.claude.json`
via sox install would point at the wrong binary and fail silently on spawn.

**Fixed in:** `libs/install-engine/src/install.ts` — fallback order is now:
1. `SOX_CLI_BIN` (explicit override)
2. `process.argv[1]` (the actual running CLI binary path)
3. `'soxe'` (requires soxe on PATH; last resort)

**Verification:** e2e test D5 (`tools/test-e2e-lifecycle.js`) asserts both paths.

## Verifying the server is working

Quick protocol probe from the terminal:

```bash
printf '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"0.1"}}}\n{"jsonrpc":"2.0","id":3,"method":"tools/list","params":{}}\n' \
  | node /path/to/sox-ecosystem/bin/soxe serve memory-server 2>/dev/null \
  | python3 -c "import sys,json; [print(list(json.loads(l).get('result',{}).get('tools',[{}])[-1].keys())) for l in sys.stdin if 'tools' in l]"
```

This should print tool names including `memory_ping`, `memory_write`, `memory_recall`, etc.

Check what's in `~/.claude.json`:

```bash
cat ~/.claude.json | python3 -c "import json,sys; d=json.load(sys.stdin); print(json.dumps(d.get('mcpServers',{}), indent=2))"
```

The `memory-server` entry should have `command` pointing at the absolute path to `bin/soxe`
(not `sox`, not `soxe` without a path).

## Correcting a bad install

If `~/.claude.json` has `command: "sox"` or a broken path, re-install at user scope:

```bash
# From the sox-ecosystem directory:
node bin/soxe install sox-memory-bundle --scope=user
```

This is idempotent — it will update the existing entry if the hash differs.

## Reference: `soxe serve` resolution path

When Claude Code spawns `soxe serve memory-server`:

1. `main.ts` parses the verb `serve` and `extId = memory-server`
2. Iterates scopes: project → user → org → local
3. For user scope: loads `~/.adhd/sox-ecosystem/extensions.lock`
4. Finds `memory-server` entry with `source: file:///path/to/dist/index.js`
5. Reads `extension.json` from that dir to get `entrypoint`
6. `execFileSync(node, [entrypointPath], { stdio: 'inherit' })` — replaces this process

The `[serve] real-path: ...` line on stderr is a marker emitted by `libs/mcp-runtime/src/serve.ts`
confirming the genuine mcp-runtime `serve()` function ran (not a stub). It is not an error.
