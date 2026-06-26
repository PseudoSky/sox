/**
 * apps/sox/scripts/stamp-build.cjs — writes build-info.json to both output locations.
 *
 * Records the git sha (+ dirty flag) at build time so cmdServe can detect when
 * `soxe serve` is loading a dist built from a dirty or uncommitted tree (the
 * BL-65 dev-dist hazard: in-place WIP builds on the live checkout silently
 * replace the running MCP server's code, breaking all sessions).
 *
 * Writes to BOTH:
 *   - dist/apps/sox/build-info.json (DEV: read by main.js when __dirname is dist/apps/sox)
 *   - apps/sox/dist/build-info.json (PUBLISHED: read by bundle when __dirname is apps/sox/dist)
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

const outPaths = [
  path.resolve(__dirname, '../../../dist/apps/sox/build-info.json'),
  path.resolve(__dirname, '../dist/build-info.json'),
];

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
  // `git status --porcelain --untracked-files=no` is empty iff there are no
  // tracked changes (staged or unstaged). Untracked files are intentionally
  // excluded: a freshly cloned or worktree-checked-out repo always has some
  // untracked editor/tooling files present; including them would stamp
  // dirty=true on every otherwise-clean build (BL-68 false-positive).
  const status = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
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

for (const outPath of outPaths) {
  const outDir = path.dirname(outPath);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(buildInfo, null, 2) + '\n', 'utf8');
}
console.log(`stamp-build: sha=${sha} dirty=${dirty} → dist/apps/sox/build-info.json + apps/sox/dist/build-info.json`);
