#!/usr/bin/env bash
# Guard for state manifest-lib (legacy P2). Red->green. Captures $? directly.
set -u
ROOT="${ROOT:-/Users/nix/dev/ai/sox-ecosystem}"
cd "$ROOT" || exit 1

pnpm exec nx run manifest:build >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: manifest build"; exit 1; }
pnpm exec nx run manifest:test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: manifest tests"; exit 1; }
node -e "const {validate}=require('./libs/manifest/dist/index');process.exit(validate({id:'x',version:'0.1.0',type:'hook',title:'X',description:'D',compatibility:{sox:'^0'},license:'MIT',runtime:'shell'}).ok?0:1)"; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: entrypoint-optional/shell-runtime flex"; exit 1; }
node -e "const {validate}=require('./libs/manifest/dist/index');process.exit(validate({id:'y',version:'0.1.0',type:'bundle',title:'Y',description:'D',compatibility:{sox:'^0'},license:'MIT',runtime:'declarative'}).ok?0:1)"; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: declarative/no-entrypoint flex"; exit 1; }
node -e "const {validate}=require('./libs/manifest/dist/index');process.exit(validate({id:'z',version:'0.1.0',type:'skill',title:'Z',description:'D',compatibility:{sox:'^0'},license:'MIT',runtime:'declarative','install-target':'~/.claude/commands/'}).ok?0:1)"; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: install-target flex"; exit 1; }
out=$(grep -rn '@nx/devkit' libs/manifest/src 2>/dev/null); [ -z "$out" ]; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: libs/manifest has @nx/devkit dep"; exit 1; }
echo "manifest-lib: PASS"
exit 0
