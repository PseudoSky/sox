#!/usr/bin/env bash
# Guard for state engine-libs (legacy P4). Red->green. Captures $? directly.
set -u
ROOT="${ROOT:-/Users/nix/dev/ai/sox-ecosystem}"
cd "$ROOT" || exit 1

pnpm exec nx run-many -t build --projects=install-engine,host-runtime,registry,sox >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: engine libs + apps/sox build"; exit 1; }
pnpm exec nx run host-runtime:test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: host-runtime tests (fixes carried forward)"; exit 1; }
pnpm exec nx run install-engine:test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: install-engine tests (drift gate)"; exit 1; }
node -e "const {parseArgs}=require('./libs/install-engine/dist/index');const a=parseArgs(['--scope','user']);const b=parseArgs(['--scope=user']);process.exit((a.scope==='user'&&b.scope==='user')?0:1)"; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: A12 dual flag forms"; exit 1; }
pnpm exec nx run-many -t lint --projects=install-engine,host-runtime,registry >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: boundary lint"; exit 1; }
echo "engine-libs: PASS"
exit 0
