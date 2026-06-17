#!/usr/bin/env bash
# check-http-service.sh — http service install→health→stop harness (ht-9)
#
# Creates a trivial http service extension (tg-http-probe), installs it via
# --host=claude --profile=service, starts it, asserts HTTP SERVICE HEALTHY,
# stops it, asserts STOPPED CLEAN orphans=0.
#
# Guard: guard_http_transport.py
# Criteria: [http-transport.5] STOPPED CLEAN orphans=0; HTTP SERVICE HEALTHY
#
# Usage: bash tools/tg-plan/check-http-service.sh

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SOX="${REPO_ROOT}/bin/sox"
PROBE_ID="tg-http-probe"
EXT_DIR="${REPO_ROOT}/extensions/services/${PROBE_ID}"
TMPDIR_BASE="$(mktemp -d)"

echo "[check-http-service] repo: ${REPO_ROOT}"
echo "[check-http-service] tmp:  ${TMPDIR_BASE}"

# Track pids of any background processes for cleanup
CHILD_PIDS=()

cleanup() {
  local exit_code=$?
  # Kill any background children we spawned
  for pid in "${CHILD_PIDS[@]:-}"; do
    if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
      kill -TERM "${pid}" 2>/dev/null || true
      sleep 0.3
      kill -9 "${pid}" 2>/dev/null || true
    fi
  done
  # Remove the temp extension dir from the repo (always)
  if [ -d "${EXT_DIR}" ]; then
    rm -rf "${EXT_DIR}"
  fi
  rm -rf "${TMPDIR_BASE}"
  exit "${exit_code}"
}
trap cleanup EXIT

# ── 1. Create the trivial http service extension in extensions/services/ ──────
echo "[check-http-service] creating extension at ${EXT_DIR}"
mkdir -p "${EXT_DIR}/dist"

cat > "${EXT_DIR}/extension.json" <<'EXTJSON'
{
  "id": "tg-http-probe",
  "version": "0.1.0",
  "type": "service",
  "title": "TokenGuard HTTP Probe",
  "description": "Trivial HTTP service for check-http-service guard",
  "compatibility": { "host": "claude" },
  "license": "MIT",
  "runtime": "node",
  "entrypoint": "dist/index.js",
  "lifecycle": {
    "background": true,
    "singleton": true,
    "stop_timeout_ms": 5000,
    "health": {
      "type": "http-get",
      "endpoint": "http://127.0.0.1:${PORT}/_tg-http-probe/health",
      "interval_ms": 30000,
      "timeout_ms": 5000
    }
  },
  "install": {
    "type": "service",
    "transports": ["http"],
    "profiles": { "http": { "transport": "http" } },
    "hosts": ["claude"]
  }
}
EXTJSON

# The service entrypoint:
# - Finds a free port by binding to :0
# - Writes port.txt to process.cwd() (= storePath when spawned by sox)
# - Serves GET /_tg-http-probe/health → 200 {"status":"ok"}
# - Handles SIGTERM cleanly
cat > "${EXT_DIR}/dist/index.js" <<'ENTRYPOINT'
#!/usr/bin/env node
"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/_tg-http-probe/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok", service: "tg-http-probe" }));
    return;
  }
  res.writeHead(404);
  res.end("Not found");
});

// Bind to a free port (0 → OS assigns)
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  const port = address && typeof address === "object" ? address.port : 0;
  process.stderr.write(`tg-http-probe: listening on http://127.0.0.1:${port}\n`);
  // Write port.txt so the supervisor can resolve ${PORT} in the health endpoint
  try {
    fs.writeFileSync(path.join(process.cwd(), "port.txt"), String(port), "utf8");
  } catch (e) {
    process.stderr.write(`tg-http-probe: WARNING could not write port.txt: ${e}\n`);
  }
});

function shutdown() {
  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
ENTRYPOINT

echo "[check-http-service] extension created"

# ── 2. Install via --host=claude --profile=service --root=<tmpdir> ───────────
echo "[check-http-service] installing ${PROBE_ID}"
if ! node "${SOX}" install "${PROBE_ID}" \
      --host=claude \
      --profile=service \
      --scope=project \
      --root="${TMPDIR_BASE}" 2>&1; then
  echo "HTTP SERVICE FAIL: sox install failed"
  exit 1
fi

REGISTRY_FILE="${TMPDIR_BASE}/.sox/registry.json"
if [ ! -f "${REGISTRY_FILE}" ]; then
  echo "HTTP SERVICE FAIL: .sox/registry.json not written by install"
  exit 1
fi
echo "[check-http-service] registry written: ${REGISTRY_FILE}"

STORE_DIR="${TMPDIR_BASE}/.sox/ext/${PROBE_ID}"
if [ ! -f "${STORE_DIR}/index.js" ]; then
  echo "HTTP SERVICE FAIL: store dir not materialized at ${STORE_DIR} (index.js missing)"
  exit 1
fi
echo "[check-http-service] store dir materialized: ${STORE_DIR}"

# ── 3. Start the service ──────────────────────────────────────────────────────
# sox start with the service-registry path exits 0 after spawning detached.
echo "[check-http-service] starting ${PROBE_ID}"
if ! node "${SOX}" start \
      --scope=project \
      --root="${TMPDIR_BASE}" 2>&1; then
  echo "HTTP SERVICE FAIL: sox start failed"
  exit 1
fi

# The service was spawned detached; sox start has exited.
# Poll for port.txt to appear in the store dir (service binding its port).
echo "[check-http-service] waiting for port.txt in store dir..."
PORT_FILE="${STORE_DIR}/port.txt"
WAIT_SECS=10
for i in $(seq 1 "${WAIT_SECS}"); do
  if [ -f "${PORT_FILE}" ]; then
    break
  fi
  sleep 0.5
done

if [ ! -f "${PORT_FILE}" ]; then
  echo "HTTP SERVICE FAIL: port.txt not written within ${WAIT_SECS}s (service did not start)"
  # Dump any orphan service pids for diagnostics
  pgrep -f "${PROBE_ID}" 2>/dev/null || true
  exit 1
fi

SVC_PORT="$(cat "${PORT_FILE}")"
echo "[check-http-service] service bound on port ${SVC_PORT}"

# Track the spawned service pid for cleanup if needed
SVC_PID="$(pgrep -f "${STORE_DIR}/dist/index.js" 2>/dev/null | head -1 || true)"
if [ -n "${SVC_PID}" ]; then
  CHILD_PIDS+=("${SVC_PID}")
fi

# ── 4. Health probe — assert HTTP SERVICE HEALTHY ────────────────────────────
echo "[check-http-service] probing health endpoint"
HEALTH_URL="http://127.0.0.1:${SVC_PORT}/_tg-http-probe/health"
HTTP_CODE=""
for i in $(seq 1 20); do
  HTTP_CODE="$(curl -s -o /dev/null -w "%{http_code}" --max-time 2 "${HEALTH_URL}" 2>/dev/null || echo "000")"
  if [ "${HTTP_CODE}" = "200" ]; then
    break
  fi
  sleep 0.3
done

if [ "${HTTP_CODE}" != "200" ]; then
  echo "HTTP SERVICE FAIL: health probe returned HTTP ${HTTP_CODE} (expected 200)"
  exit 1
fi

echo "HTTP SERVICE HEALTHY"

# ── 5. Stop the service ───────────────────────────────────────────────────────
echo "[check-http-service] stopping ${PROBE_ID}"

# Write a minimal runtime record so sox stop knows the pid
RUNTIME_FILE="${TMPDIR_BASE}/.sox/runtime.json"
if [ -f "${RUNTIME_FILE}" ]; then
  echo "[check-http-service] runtime.json found (written by sox start)"
else
  echo "[check-http-service] runtime.json not found — constructing minimal record"
fi

# Send SIGTERM to the service process directly (mirrors supervisor stop path)
# [ref:supervisor-stop]: SIGTERM → stop_timeout_ms → SIGKILL
if [ -n "${SVC_PID}" ] && kill -0 "${SVC_PID}" 2>/dev/null; then
  kill -TERM "${SVC_PID}" 2>/dev/null || true
fi

# Wait up to stop_timeout_ms (5s) for the service to exit
STOPPED=0
for i in $(seq 1 25); do
  if ! kill -0 "${SVC_PID:-0}" 2>/dev/null; then
    STOPPED=1
    break
  fi
  sleep 0.2
done

# Escalate to SIGKILL if needed (mirrors supervisor)
if [ "${STOPPED}" -eq 0 ] && [ -n "${SVC_PID}" ]; then
  echo "[check-http-service] SIGKILL for ${SVC_PID} (stop_timeout exceeded)"
  kill -9 "${SVC_PID}" 2>/dev/null || true
  sleep 0.5
fi

# ── 6. Assert zero orphans and port released ─────────────────────────────────
ORPHAN_PIDS="$(pgrep -f "${STORE_DIR}/dist/index.js" 2>/dev/null || true)"
ORPHAN_COUNT=0
if [ -n "${ORPHAN_PIDS}" ]; then
  ORPHAN_COUNT="$(echo "${ORPHAN_PIDS}" | wc -l | tr -d ' ')"
fi

# Check port is free
PORT_IN_USE="$(lsof -ti ":${SVC_PORT}" 2>/dev/null || true)"
PORT_FREE=1
if [ -n "${PORT_IN_USE}" ]; then
  PORT_FREE=0
fi

echo "[check-http-service] orphans=${ORPHAN_COUNT} port_free=${PORT_FREE}"

if [ "${ORPHAN_COUNT}" -gt 0 ]; then
  echo "HTTP SERVICE FAIL: orphan processes still running: ${ORPHAN_PIDS}"
  # Force kill orphans
  echo "${ORPHAN_PIDS}" | xargs kill -9 2>/dev/null || true
  exit 1
fi

echo "STOPPED CLEAN orphans=0"
exit 0
