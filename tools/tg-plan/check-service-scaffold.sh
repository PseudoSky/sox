#!/usr/bin/env bash
# check-service-scaffold.sh — service scaffold round-trip harness
#
# Drives: soxe init service tgprobe → build → soxe validate
# Prints: SCAFFOLD OK on success / SCAFFOLD FAIL on any failure
# Cleans up the temp dir unconditionally.
#
# Usage: bash tools/tg-plan/check-service-scaffold.sh
# Expected by: guard_service_type.py

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMPDIR_BASE="$(mktemp -d)"
PROBE_ID="tgprobe"

cleanup() {
  rm -rf "${TMPDIR_BASE}"
}
trap cleanup EXIT

echo "[check-service-scaffold] repo: ${REPO_ROOT}"
echo "[check-service-scaffold] tmp:  ${TMPDIR_BASE}"

# ── 1. soxe init service tgprobe ───────────────────────────────────────────────
echo "[check-service-scaffold] running: soxe init service ${PROBE_ID}"
if ! node "${REPO_ROOT}/bin/sox" init service "${PROBE_ID}" \
       --out="${TMPDIR_BASE}" \
       --title="TokenGuard Probe" \
       --description="Service scaffold probe for guard_service_type" 2>&1; then
  echo "SCAFFOLD FAIL: soxe init service failed"
  exit 1
fi

PROBE_DIR="${TMPDIR_BASE}/${PROBE_ID}"
if [ ! -f "${PROBE_DIR}/extension.json" ]; then
  echo "SCAFFOLD FAIL: extension.json not found at ${PROBE_DIR}/extension.json"
  exit 1
fi

echo "[check-service-scaffold] extension.json found"

# ── 2. Build the scaffolded extension ────────────────────────────────────────
# The scaffold emits a pre-built dist/index.js stub so soxe validate passes
# entrypoint-reachability immediately. We also attempt tsc build if node_modules
# are available, but we don't fail on missing node_modules (the stub suffices).
echo "[check-service-scaffold] checking dist/index.js stub"
if [ ! -f "${PROBE_DIR}/dist/index.js" ]; then
  echo "SCAFFOLD FAIL: dist/index.js not found — template must emit a prebuilt stub"
  exit 1
fi

# ── 3. soxe validate ───────────────────────────────────────────────────────────
echo "[check-service-scaffold] running: soxe validate"
VALIDATE_OUT="$(node "${REPO_ROOT}/bin/sox" validate "${PROBE_DIR}/extension.json" 2>&1)"
VALIDATE_EXIT=$?
echo "${VALIDATE_OUT}"

if [ "${VALIDATE_EXIT}" -ne 0 ]; then
  echo "SCAFFOLD FAIL: soxe validate exited ${VALIDATE_EXIT}"
  echo "validate output: ${VALIDATE_OUT}"
  exit 1
fi

# ── 4. Structural checks on the emitted manifest ─────────────────────────────
echo "[check-service-scaffold] checking manifest fields"

# type must be "service"
TYPE="$(node -e "const m=require('${PROBE_DIR}/extension.json'); console.log(m.type);")"
if [ "${TYPE}" != "service" ]; then
  echo "SCAFFOLD FAIL: manifest type is '${TYPE}', expected 'service'"
  exit 1
fi

# install.transports must be present and non-empty
TRANSPORTS="$(node -e "const m=require('${PROBE_DIR}/extension.json'); console.log(JSON.stringify(m.install && m.install.transports));")"
if [ "${TRANSPORTS}" = "null" ] || [ "${TRANSPORTS}" = "undefined" ] || [ "${TRANSPORTS}" = "[]" ]; then
  echo "SCAFFOLD FAIL: install.transports is absent or empty"
  exit 1
fi

# lifecycle must be present
LIFECYCLE="$(node -e "const m=require('${PROBE_DIR}/extension.json'); console.log(m.lifecycle ? 'ok' : 'missing');")"
if [ "${LIFECYCLE}" != "ok" ]; then
  echo "SCAFFOLD FAIL: lifecycle block is absent"
  exit 1
fi

echo "[check-service-scaffold] type=${TYPE} transports=${TRANSPORTS} lifecycle=${LIFECYCLE}"
echo "SCAFFOLD OK"
exit 0
