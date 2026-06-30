#!/usr/bin/env bash
# check-memory-nonregress.sh — [inv:no-regress-mcp] harness
#
# Proves that memory-server's full lifecycle + C6 forbidden-write denial
# hold after mcp-server is folded onto the unified service model (mcp-as-service).
#
# Flow:
#   1. soxe install memory-server -s project  (config/lockfile resolver path)
#   2. runtime-cli start  (full supervisor path with exec socket — matches e2e test)
#   3. soxe exec memory_ping → assert MEMORY OK
#   4. soxe exec memory_write with evil db_path (outside allowlist) → assert C6 DENY OK
#   5. Stop + clean up
#
# Guard: guard_mcp_as_service.py
# Criteria: [mcp-as-service.5] / [inv:no-regress-mcp]
# Required output lines: MEMORY OK  C6 DENY OK
#
# Usage: bash tools/tg-plan/check-memory-nonregress.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOX="${REPO_ROOT}/bin/sox"
NODE="$(command -v node)"
MEM_ID="memory-server"
RUNTIME_CLI="${REPO_ROOT}/libs/host-runtime/dist/runtime-cli.js"

# Isolated temp root (never touches ~/.memory or the real .extensions)
TMPDIR_BASE="$(mktemp -d)"
EXT_DIR="${TMPDIR_BASE}/.extensions"
RUNTIME_FILE="${EXT_DIR}/runtime.json"
CONFIG_PATH="${EXT_DIR}/extensions.json"
LOCKFILE_PATH="${EXT_DIR}/extensions.lock"

# Allowed db_path: inside memory-server's declared fs allowlist (~/.memory/**)
# Use pid-scoped name to avoid collisions with concurrent runs
DB_PATH="${HOME}/.memory/sox-nonregress-${$}.db"

# Evil path: clearly OUTSIDE the allowlist — must be DENIED with no file created
EVIL_DB_PATH="${TMPDIR_BASE}/EVIL_sox-nonregress-${$}.db"

echo "[check-memory-nonregress] repo:         ${REPO_ROOT}"
echo "[check-memory-nonregress] tmp root:     ${TMPDIR_BASE}"
echo "[check-memory-nonregress] db_path:      ${DB_PATH}"
echo "[check-memory-nonregress] evil_path:    ${EVIL_DB_PATH}"
echo "[check-memory-nonregress] runtime_cli:  ${RUNTIME_CLI}"

# ── Track the runtime-cli background child for cleanup ───────────────────────
RUNTIME_CLI_PID=""

cleanup() {
  local exit_code=$?
  # Kill runtime-cli supervisor if still alive
  if [ -n "${RUNTIME_CLI_PID}" ] && kill -0 "${RUNTIME_CLI_PID}" 2>/dev/null; then
    kill -TERM "${RUNTIME_CLI_PID}" 2>/dev/null || true
    sleep 1
    kill -9 "${RUNTIME_CLI_PID}" 2>/dev/null || true
  fi
  # Backstop: kill any memory-server dist/index.js process we may have spawned
  STALE="$(pgrep -f "memory-server/dist/index.js" 2>/dev/null | grep -v "^${$}$" || true)"
  if [ -n "${STALE}" ]; then
    # Only kill pids that don't exist in the baseline (from cleanup trap context we
    # can't easily filter; just attempt, let them fail silently if pre-existing)
    echo "${STALE}" | xargs kill -9 2>/dev/null || true
  fi
  # Remove pid-scoped db if it was created
  rm -f "${DB_PATH}" 2>/dev/null || true
  # Confirm evil file was NOT created (safety net)
  if [ -f "${EVIL_DB_PATH}" ]; then
    echo "[check-memory-nonregress] WARN: evil db file exists — removing (should not have been created)"
    rm -f "${EVIL_DB_PATH}" 2>/dev/null || true
  fi
  rm -rf "${TMPDIR_BASE}" 2>/dev/null || true
  exit "${exit_code}"
}
trap cleanup EXIT

# ── Verify runtime-cli is built ───────────────────────────────────────────────
if [ ! -f "${RUNTIME_CLI}" ]; then
  echo "[check-memory-nonregress] FAIL: runtime-cli not built at ${RUNTIME_CLI}"
  echo "  Run: npx nx build host-runtime"
  exit 1
fi

# ── 0. Setup: create temp dir + config + ~/.memory dir ───────────────────────
mkdir -p "${EXT_DIR}"
mkdir -p "${HOME}/.memory"

cat > "${CONFIG_PATH}" <<JSON
{
  "install": [
    { "id": "${MEM_ID}", "version": "^0.1.0" }
  ],
  "config": {
    "${MEM_ID}": { "db_path": "${DB_PATH}" }
  }
}
JSON
echo "[check-memory-nonregress] config written: ${CONFIG_PATH}"

# ── 1. Install memory-server via config/lockfile resolver path ────────────────
echo ""
echo "[check-memory-nonregress] Step 1: soxe install memory-server -s project"
if ! "${NODE}" "${SOX}" install \
      --scope=project \
      "--config=${CONFIG_PATH}" \
      "--lockfile=${LOCKFILE_PATH}" \
      2>&1; then
  echo "[check-memory-nonregress] FAIL: soxe install exited non-zero"
  exit 1
fi

if [ ! -f "${LOCKFILE_PATH}" ]; then
  echo "[check-memory-nonregress] FAIL: lockfile not written at ${LOCKFILE_PATH}"
  exit 1
fi
echo "[check-memory-nonregress] lockfile written: ok"

# ── 2. Start via runtime-cli (full supervisor with exec socket) ───────────────
echo ""
echo "[check-memory-nonregress] Step 2: runtime-cli start (full supervisor)"
"${NODE}" "${RUNTIME_CLI}" start \
  --scope=project \
  "--root=${TMPDIR_BASE}" \
  "--lockfile=${LOCKFILE_PATH}" \
  "--config=${CONFIG_PATH}" \
  "--runtime-file=${RUNTIME_FILE}" \
  2>&1 &
RUNTIME_CLI_PID=$!
echo "[check-memory-nonregress] runtime-cli pid: ${RUNTIME_CLI_PID}"

# Poll for runtime.json to appear and show memory-server as running
echo "[check-memory-nonregress] waiting for memory-server to start..."
RUNNING=0
for i in $(seq 1 40); do
  if [ -f "${RUNTIME_FILE}" ]; then
    IS_RUNNING="$("${NODE}" -e "
      try {
        const r = JSON.parse(require('fs').readFileSync('${RUNTIME_FILE}', 'utf8'));
        const e = (r.entries||[]).find(x => x.id === '${MEM_ID}' || x.key === '${MEM_ID}' || (x.key||'').startsWith('${MEM_ID}@'));
        process.stdout.write(e && e.running ? 'yes' : 'no');
      } catch(ex) { process.stdout.write('no'); }
    " 2>/dev/null || echo "no")"
    if [ "${IS_RUNNING}" = "yes" ]; then
      RUNNING=1
      break
    fi
  fi
  sleep 0.5
done

if [ "${RUNNING}" -eq 0 ]; then
  echo "[check-memory-nonregress] FAIL: memory-server not running after 20s"
  if [ -f "${RUNTIME_FILE}" ]; then
    echo "[check-memory-nonregress] runtime.json contents:"
    cat "${RUNTIME_FILE}"
  fi
  exit 1
fi
echo "[check-memory-nonregress] memory-server is RUNNING: ok"

# Give the MCP server a moment to finish initializing
sleep 1

# ── 3. Ping memory-server — assert MEMORY OK ──────────────────────────────────
echo ""
echo "[check-memory-nonregress] Step 3: memory_ping via soxe exec"
PING_OUT=""
PING_EXIT=0
PING_OUT="$("${NODE}" "${SOX}" exec \
  "--id=${MEM_ID}" \
  --tool=memory_ping \
  '--args={}' \
  -s project \
  "--root=${TMPDIR_BASE}" \
  "--runtime-file=${RUNTIME_FILE}" \
  2>&1)" || PING_EXIT=$?

echo "[check-memory-nonregress] memory_ping output: ${PING_OUT}"
echo "[check-memory-nonregress] memory_ping exit:   ${PING_EXIT}"

# memory_ping returns {ok:true}; accept exit-0 and/or JSON containing ok:true
PING_OK=0
if echo "${PING_OUT}" | grep -q '"ok":true\|"ok": true'; then
  PING_OK=1
elif [ "${PING_EXIT}" -eq 0 ] && [ -n "${PING_OUT}" ]; then
  PING_OK=1
fi

if [ "${PING_OK}" -eq 0 ]; then
  echo "[check-memory-nonregress] FAIL: memory_ping did not return ok:true (exit=${PING_EXIT})"
  exit 1
fi

echo "MEMORY OK"

# ── 4. C6 denial: evil db_path MUST be denied + file must NOT be created ──────
echo ""
echo "[check-memory-nonregress] Step 4: C6 denial — evil db_path outside allowlist"

# Ensure no stale evil file
rm -f "${EVIL_DB_PATH}" 2>/dev/null || true

EVIL_OUT=""
EVIL_EXIT=0
EVIL_OUT="$("${NODE}" "${SOX}" exec \
  "--id=${MEM_ID}" \
  --tool=memory_write \
  "--args={\"content\":\"C6 test write MUST be denied\",\"db_path\":\"${EVIL_DB_PATH}\"}" \
  -s project \
  "--root=${TMPDIR_BASE}" \
  "--runtime-file=${RUNTIME_FILE}" \
  2>&1)" || EVIL_EXIT=$?

echo "[check-memory-nonregress] evil write output: ${EVIL_OUT}"
echo "[check-memory-nonregress] evil write exit:   ${EVIL_EXIT}"

# Determine if the write was denied:
# (a) soxe exec exited non-zero (enforcement at exec level / MCP isError→exit 1), OR
# (b) the MCP result contains isError:true or "permission denied" text
EVIL_DENIED=0
if [ "${EVIL_EXIT}" -ne 0 ]; then
  echo "[check-memory-nonregress] denied at exec level (exit=${EVIL_EXIT})"
  EVIL_DENIED=1
elif echo "${EVIL_OUT}" | grep -qi '"isError":true\|permission denied\|outside declared\|fs allowlist'; then
  echo "[check-memory-nonregress] denied in tool result (isError:true or denial text)"
  EVIL_DENIED=1
fi

# The evil file MUST NOT exist (zero side-effect)
if [ -f "${EVIL_DB_PATH}" ]; then
  echo "[check-memory-nonregress] FAIL: evil db file was created despite denial — C6 hole"
  exit 1
fi
echo "[check-memory-nonregress] evil db file absent: ok (no side-effect)"

if [ "${EVIL_DENIED}" -eq 0 ]; then
  echo "[check-memory-nonregress] FAIL: evil write was NOT denied (C6 enforcement missing)"
  exit 1
fi

echo "C6 DENY OK"

# ── 5. Stop ───────────────────────────────────────────────────────────────────
echo ""
echo "[check-memory-nonregress] Step 5: stop (SIGTERM to runtime-cli supervisor)"
if [ -n "${RUNTIME_CLI_PID}" ] && kill -0 "${RUNTIME_CLI_PID}" 2>/dev/null; then
  kill -TERM "${RUNTIME_CLI_PID}" 2>/dev/null || true
  STOPPED=0
  for i in $(seq 1 25); do
    if ! kill -0 "${RUNTIME_CLI_PID}" 2>/dev/null; then
      STOPPED=1
      break
    fi
    sleep 0.2
  done
  RUNTIME_CLI_PID=""
  if [ "${STOPPED}" -eq 0 ]; then
    echo "[check-memory-nonregress] SIGKILL escalation for runtime-cli"
    kill -9 "${RUNTIME_CLI_PID:-0}" 2>/dev/null || true
  fi
fi

echo "[check-memory-nonregress] PASS: memory-server lifecycle + C6 non-regression verified"
exit 0
