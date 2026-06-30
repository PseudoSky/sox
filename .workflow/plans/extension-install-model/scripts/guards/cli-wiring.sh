#!/usr/bin/env bash
# cli-wiring guard — every documented verb is wired and parses its flags.
# Covers: install, build, diff (new verb), update, --flag=value parsing.
# Sources [def:probe-harness].

set -uo pipefail
source "$(dirname "$0")/../sox-probe.sh"
probe_init

# --- 1. `soxe install` parses all flags (--host, --scope, --root, --profile) --
ID="test-cli-agent"
soxe init agent "$ID"
assert_exit0 "init agent for cli-wiring"

soxe install "$ID" --host claude --scope project
assert_exit0 "install with --host --scope flags"
assert_file "$SBX/.claude/agents/${ID}.md"

# --- 2. --flag=value parsing (install with equals syntax) --------------------
ID2="test-cli-agent-eq"
soxe init agent "$ID2"
assert_exit0 "init agent for equals-flag test"

soxe install "$ID2" --host=claude --scope=project
assert_exit0 "install with --host=value --scope=value (equals syntax)"
assert_file "$SBX/.claude/agents/${ID2}.md"

# --- 3. `soxe build` verb wired -----------------------------------------------
ID_MCP="test-cli-mcp"
soxe init mcp-server "$ID_MCP"
assert_exit0 "init mcp-server"
soxe build "$ID_MCP"
assert_exit0 "soxe build mcp-server"

# --- 4. `soxe diff` verb wired (new verb) ------------------------------------
ID_DIFF="test-cli-diff-agent"
soxe init agent "$ID_DIFF"
assert_exit0 "init agent for diff test"
soxe install "$ID_DIFF" --host claude --scope project
assert_exit0 "install agent for diff"
# diff on a clean install should exit 0 and report no drift.
soxe diff "$ID_DIFF"
assert_exit0 "soxe diff (clean install, no drift)"

# --- 5. `soxe update` verb wired ----------------------------------------------
soxe update "$ID" --host claude --scope project
assert_exit0 "soxe update"

probe_done
