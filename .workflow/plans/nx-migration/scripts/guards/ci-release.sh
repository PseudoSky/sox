#!/usr/bin/env bash
# Guard for state ci-release (legacy P9). Red->green. Captures $? directly.
set -u
ROOT="${ROOT:-/Users/nix/dev/ai/sox-ecosystem}"
cd "$ROOT" || exit 1

out=$(grep -n 'nx affected' .github/workflows/ci.yml 2>/dev/null); [ -n "$out" ]; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: CI does not use nx affected"; exit 1; }
pnpm exec nx release --dry-run >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: nx release dry-run"; exit 1; }
for t in agent skill mcp-server hook command bundle; do
  test -f "docs/guidelines/$t.md"; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: docs/guidelines/$t.md missing"; exit 1; }
done
out=$(ls scripts/scaffolder.test.ts 2>/dev/null); [ -z "$out" ]; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: scaffolder.test.ts not deleted"; exit 1; }
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: suite green (reality-gates re-homed)"; exit 1; }
echo "ci-release: PASS"
exit 0
