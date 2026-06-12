#!/usr/bin/env bash
# Guard for state migrate-rest (legacy P8). Red->green. Captures $? directly.
set -u
ROOT="${ROOT:-/Users/nix/dev/ai/sox-ecosystem}"
cd "$ROOT" || exit 1

pnpm exec nx run-many -t build >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: full graph build"; exit 1; }
pnpm exec nx run-many -t lint >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: full graph lint"; exit 1; }
pnpm exec nx run manifest:test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: 44 conformance tests (thin-wrap)"; exit 1; }
out=$(grep -ni 'manifest' scripts/validate-manifests.ts 2>/dev/null); [ -n "$out" ]; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: validate-manifests does not import libs/manifest"; exit 1; }
echo "migrate-rest: PASS"
exit 0
