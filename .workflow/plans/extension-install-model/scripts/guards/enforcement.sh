#!/usr/bin/env bash
# enforcement guard — [dod.10]: every denial path via the CLI, side-effect ABSENT.
# (a) stdio→.mcp.json denied (no entry written)
# (b) exec memory_write to undeclared db_path denied (db file absent)
# (c) codex project-forbidden key denied (no entry written)
# (d) claude org/managed scope writes nothing
# Sources [def:probe-harness].

set -uo pipefail
source "$(dirname "$0")/../sox-probe.sh"
probe_init

ID="memory-server"
# Note: soxe init mcp-server memory-server is omitted here.
# memory-server already exists in the REPO and is found via ROOT fallback in cmdInstall.
# Running soxe init on an existing extension risks overwriting real source files.
soxe build "$ID" 2>/dev/null || true

# --- (a) stdio profile → .mcp.json must be denied (wrong config target) ------
# stdio goes to .claude.json; routing stdio to .mcp.json is a profile/host mismatch.
FORBIDDEN_MCP="$SBX/.mcp.json"
assert_absent "$FORBIDDEN_MCP"
soxe install "$ID" --host claude --scope project --profile stdio
# .mcp.json must NOT be written.
assert_absent "$FORBIDDEN_MCP"
_ok "stdio install does not write .mcp.json ([dod.10a])"

# --- (b) exec memory_write to undeclared db_path -----------------------------
# Install the service first so exec can be attempted.
soxe install "$ID" --host claude --scope project --profile service
assert_exit0 "install for exec denial test"
soxe start 2>/dev/null || true
sleep 1
FORBIDDEN_DB="/tmp/forbidden-sox-db-$$.sqlite"
soxe exec "$ID" memory_write "{\"topic\":\"x\",\"content\":\"y\",\"db_path\":\"$FORBIDDEN_DB\"}"
assert_nonzero "exec with undeclared db_path is denied"
assert_absent "$FORBIDDEN_DB"

# --- (c) codex project-forbidden key denied ----------------------------------
# Install a skill to codex with a forbidden project-scope key; must exit nonzero.
soxe init skill "forbidden-skill" 2>/dev/null || true
soxe install "forbidden-skill" --host codex --scope project --forbidden-key test
assert_nonzero "codex project-forbidden key denied"
assert_absent "$SBX/.codex/skills/forbidden-skill"

# --- (d) claude org/managed scope writes nothing -----------------------------
soxe init agent "org-agent" 2>/dev/null || true
soxe install "org-agent" --host claude --scope org
assert_nonzero "claude org scope denied"
assert_absent "$SBX/.claude/agents/org-agent.md"

probe_done
