/**
 * apps/sox/scripts/stamp-build.cjs — writes dist/apps/sox/build-info.json.
 *
 * Records the git sha (+ dirty flag) at build time so cmdServe can detect when
 * `soxe serve` is loading a dist built from a dirty or uncommitted tree (the
 * BL-65 dev-dist hazard: in-place WIP builds on the live checkout silently
 * replace the running MCP server's code, breaking all sessions).
 *
 * Written by the `sox:build` nx target (post-build, after rewrite-paths.cjs).
 * Consumed at runtime by cmdServe → warnIfDistSha().
 *
 * Safe in worktrees: runs `git` in `$PWD` (workspace root), which resolves to
 * the WORKTREE's `.git` file (a gitdir pointer), so the sha belongs to the
 * worktree's HEAD, not the main checkout's HEAD.
 */
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const outPath = path.resolve(__dirname, '../../../dist/apps/sox/build-info.json');

let sha = 'unknown';
let dirty = false;

try {
  sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    encoding: 'utf8',
    timeout: 3000,
  }).trim();
} catch {
  // Not a git repo or git not available — leave sha = 'unknown'.
}

try {
  // `git status --porcelain` is empty iff the tree is clean.
  const status = execFileSync('git', ['status', '--porcelain'], {
    encoding: 'utf8',
    timeout: 3000,
  });
  dirty = status.trim().length > 0;
} catch {
  // Unable to determine — conservatively mark dirty.
  dirty = true;
}

const buildInfo = {
  gitSha: sha,
  dirty,
  builtAt: new Date().toISOString(),
};

fs.writeFileSync(outPath, JSON.stringify(buildInfo, null, 2) + '\n', 'utf8');
console.log(`stamp-build: sha=${sha} dirty=${dirty} → dist/apps/sox/build-info.json`);
