#!/usr/bin/env bash
# Guard for state nx-init (legacy P1). Red->green. Captures $? directly.
set -u
ROOT="${ROOT:-/Users/nix/dev/ai/sox-ecosystem}"
cd "$ROOT" || exit 1

git diff --quiet; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: tree dirty"; exit 1; }
branch=$(git rev-parse --abbrev-ref HEAD); [ "$branch" = "feat/nx-migration" ]; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: wrong branch"; exit 1; }
pnpm exec nx show projects >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: nx graph does not resolve"; exit 1; }
node -e "const fs=require('fs');const cfgs=['eslint.config.js','.eslintrc.json','.eslintrc.js'];const f=cfgs.find(c=>fs.existsSync(c));if(!f)process.exit(1);process.exit(fs.readFileSync(f,'utf8').includes('enforce-module-boundaries')?0:1)"; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: boundary lint rule missing"; exit 1; }
node -e "process.exit(require('./nx.json').release?0:1)"; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: nx release not configured"; exit 1; }
node -e "const y=require('fs').readFileSync('pnpm-workspace.yaml','utf8');process.exit((y.includes('libs/**')&&y.includes('apps/**'))?0:1)"; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: workspace globs missing"; exit 1; }
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: existing suite regressed"; exit 1; }
echo "nx-init: PASS"
exit 0
