#!/usr/bin/env bash
# Guard for state type-discovery (legacy P6). Red->green. Captures $? directly.
set -u
ROOT="${ROOT:-/Users/nix/dev/ai/sox-ecosystem}"
cd "$ROOT" || exit 1

pnpm exec nx run sox-nx:born-conformance >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: born-conformance after refinement"; exit 1; }
pnpm exec nx run sox-nx:test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: parity after refinement"; exit 1; }
test -f docs/per-type-shapes.md; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: per-type-shapes doc missing"; exit 1; }
node -e "const {validate}=require('./libs/manifest/dist/index');process.exit(validate(require('./apps/sox/extension.json')).ok?0:1)"; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: schema change not additive (sox manifest broke)"; exit 1; }
echo "type-discovery: PASS"
exit 0
