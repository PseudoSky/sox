#!/usr/bin/env bash
# Guard for state authoring-lib (legacy P3). Red->green. Captures $? directly.
set -u
ROOT="${ROOT:-/Users/nix/dev/ai/sox-ecosystem}"
cd "$ROOT" || exit 1

pnpm exec nx run authoring:build >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: authoring build"; exit 1; }
pnpm exec nx run sox-nx:build >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: sox-nx build"; exit 1; }
pnpm exec nx run sox-nx:born-conformance >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: born-conformance gate"; exit 1; }
pnpm exec nx run sox-nx:test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: scaffold-parity test"; exit 1; }
out=$(grep -rn '@nx/devkit\|@nx/' libs/authoring/src 2>/dev/null); [ -z "$out" ]; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: libs/authoring is not nx-free"; exit 1; }
out=$(ls extensions/agents/echo-agent extensions/skills/hello-world extensions/mcp-servers/hello-server extensions/hooks/audit-hook extensions/prompts/greeting-prompt extensions/commands/status-command 2>/dev/null); [ -z "$out" ]; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: demo extensions not deleted"; exit 1; }
echo "authoring-lib: PASS"
exit 0
