#!/usr/bin/env bash
# service-runtime guard — [dod.5] THE HEADLINE: supervisor spawns the
# materialized SERVICE bundle with cwd = its store dir (no monorepo).
# The hand-rolled stdio fallback is DELETED; serve() emits [shape:serve-marker].
# Guard: install → start → exec a tool; assert tool output + real-path marker
# + NO Cannot find module '@adhd.
# Sources [def:probe-harness].

set -uo pipefail
source "$(dirname "$0")/../sox-probe.sh"
probe_init

ID="memory-server"

# --- 1. Install as service ---------------------------------------------------
soxe install "$ID" --host claude --scope project --profile service
assert_exit0 "install memory-server as service"
assert_dir "$SBX/.sox/ext"
assert_file "$SBX/.sox/registry.json"

# --- 2. Start the supervisor -------------------------------------------------
soxe start
assert_exit0 "soxe start"

# Give the supervisor a moment to spawn the child process.
sleep 2

# --- 3. Exec a tool from the running service ---------------------------------
# memory_ping requires no database — fastest path to verify exec works end-to-end.
soxe exec "$ID" memory_ping '{}'
assert_exit0 "soxe exec memory_ping"

# --- 4. Assert the REAL serve() path ran (not the deleted fallback) ----------
# [shape:serve-marker]: serve() writes "[serve] real-path" to stderr on startup.
assert_serve_real_path "memory-server from store dir"

# --- 5. Assert no @adhd import errors (self-contained bundle) -----------------
assert_stderr_clean "memory-server bundle has no MODULE_NOT_FOUND"

probe_done
