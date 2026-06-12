#!/usr/bin/env bash
# Guard for state sox-extension (legacy P5). Red->green. Captures $? directly.
set -u
ROOT="${ROOT:-/Users/nix/dev/ai/sox-ecosystem}"
cd "$ROOT" || exit 1

pnpm exec nx run sox:build >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: sox build"; exit 1; }
node -e "const {validate}=require('./libs/manifest/dist/index');process.exit(validate(require('./apps/sox/extension.json')).ok?0:1)"; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: sox extension.json invalid (D1)"; exit 1; }
node -e "process.exit(require('./apps/sox/extension.json').type==='command'?0:1)"; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: sox type not command (D2)"; exit 1; }
T="$ROOT/.tmp-guard-soxext"; rm -rf "$T"; mkdir -p "$T"
node dist/apps/sox/main.js init hook event-probe --events SessionEnd --runtime shell --out "$T" >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { rm -rf "$T"; echo "FAIL: A1 init"; exit 1; }
node -e "const {validate}=require('./libs/manifest/dist/index');process.exit(validate(require('$T/event-probe/extension.json')).ok?0:1)"; rc=$?; rm -rf "$T"; [ $rc -eq 0 ] || { echo "FAIL: A1 scaffolded manifest invalid"; exit 1; }
node dist/apps/sox/main.js validate --help >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: A12 live CLI --help"; exit 1; }
echo "sox-extension: PASS"
exit 0
