#!/usr/bin/env bash
# mcp-install-modes guard — [dod.4]: mcp-server installs as sse/http into
# .mcp.json, stdio into .claude.json, and SERVICE (bundle + supervisor record),
# selected by --profile. run-service is wired into the install dispatch.
# Sources [def:probe-harness].

set -uo pipefail
source "$(dirname "$0")/../sox-probe.sh"
probe_init

ID="test-mcp"
sox init mcp-server "$ID"
assert_exit0 "init mcp-server"
sox build "$ID"
assert_exit0 "build mcp-server"

# --- 1. --profile sse → $SBX/.mcp.json has the server entry -----------------
sox install "$ID" --host claude --scope project --profile sse
assert_exit0 "install mcp --profile sse"
assert_file "$SBX/.mcp.json"
assert_in_file "$SBX/.mcp.json" "$ID"

# --- 2. --profile stdio → $SBX/.claude.json has the entry -------------------
sox install "$ID" --host claude --scope user --profile stdio
assert_exit0 "install mcp --profile stdio"
assert_file "$SBX/.claude.json"
assert_in_file "$SBX/.claude.json" "$ID"

# --- 3. --profile service → materialized bundle + supervisor service record --
sox install "$ID" --host claude --scope project --profile service
assert_exit0 "install mcp --profile service"
# The materialized store dir exists under $SBX.
assert_dir "$SBX/.sox/ext"
# A supervisor service record (registry entry) must exist.
assert_file "$SBX/.sox/registry.json"
assert_in_file "$SBX/.sox/registry.json" "$ID"

probe_done
