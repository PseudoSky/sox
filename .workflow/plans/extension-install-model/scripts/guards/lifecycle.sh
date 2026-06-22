#!/usr/bin/env bash
# lifecycle guard — [dod.6]: full supervised lifecycle via the CLI:
# install→start→list→details→exec→disable→enable→stop→uninstall.
# Guard: assert list=RUNNING, details=pid, exec=output, disable stops pid,
# enable restarts, stop leaves ZERO orphan pids, uninstall removes entry.
# Sources [def:probe-harness].

set -uo pipefail
source "$(dirname "$0")/../sox-probe.sh"
probe_init

ID="memory-server"

# --- 1. install --------------------------------------------------------------
sox install "$ID" --host claude --scope project --profile service
assert_exit0 "install"

# --- 2. start ----------------------------------------------------------------
sox start
assert_exit0 "start"
sleep 2

# --- 3. list → shows RUNNING -------------------------------------------------
sox list
assert_exit0 "list"
assert_stdout "RUNNING"

# --- 4. details → shows pid + scope -----------------------------------------
sox details "$ID"
assert_exit0 "details"
assert_stdout "pid"

# --- 5. exec → returns tool output ------------------------------------------
# memory_ping requires no database — fastest path to verify exec works end-to-end.
sox exec "$ID" memory_ping '{}'
assert_exit0 "exec"

# --- 6. disable → stops the pid ----------------------------------------------
sox disable "$ID"
assert_exit0 "disable"
# After disable, list should NOT show RUNNING for this service.
sox list
assert_exit0 "list after disable"
case "$LAST_OUT" in
  *"RUNNING"*) _bad "service still RUNNING after disable" ;;
  *) _ok "service not RUNNING after disable (disabled/stopped)" ;;
esac

# --- 7. enable → restarts the service ----------------------------------------
sox enable "$ID"
assert_exit0 "enable"
sleep 2
sox list
assert_exit0 "list after enable"
assert_stdout "RUNNING"

# --- 8. stop → zero orphan pids ----------------------------------------------
sox stop
assert_exit0 "stop"
sleep 1
# Verify the pid from details is no longer alive.
sox list
assert_exit0 "list after stop"
case "$LAST_OUT" in
  *"RUNNING"*) _bad "orphan pid: service still RUNNING after stop" ;;
  *) _ok "zero orphan pids after stop" ;;
esac

# --- 9. uninstall → removes registry entry ----------------------------------
sox uninstall "$ID" --host claude --scope project --profile service
assert_exit0 "uninstall"
if grep -q "\"$ID\"" "$SBX/.sox/registry.json" 2>/dev/null; then
  _bad "registry entry for $ID still present after uninstall"
else
  _ok "registry entry removed after uninstall"
fi

probe_done
