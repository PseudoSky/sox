#!/usr/bin/env bash
# Guard for state checkpoint-branch (legacy P0). Red->green.
# Captures $? directly; never pipes a tested exit ([inv:capture-exit]).
set -u
ROOT="${ROOT:-/Users/nix/dev/ai/sox-ecosystem}"
cd "$ROOT" || exit 1

git diff --quiet; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: working tree dirty (unstaged)"; exit 1; }
git diff --cached --quiet; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: staged changes uncommitted"; exit 1; }
git rev-parse --verify pre-nx-baseline >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: pre-nx-baseline tag missing"; exit 1; }
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "feat/nx-migration" ]; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: not on feat/nx-migration"; exit 1; }
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || { echo "FAIL: test suite red at baseline"; exit 1; }
echo "checkpoint-branch: PASS"
exit 0
