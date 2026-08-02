#!/usr/bin/env node
/**
 * install-git-hooks — [BL-359] activate the versioned hooks under .husky/.
 *
 * `.husky/pre-commit` and `.husky/commit-msg` exist in the repo but were
 * never actually wired up: there is no `husky` devDependency, no `prepare`
 * script, and `core.hooksPath` is unset (verified 2026-08-01) — so git has
 * been running its default, untracked `.git/hooks/`, which contains only
 * the stock `.sample` files. Every `.husky/*` hook has therefore been
 * silently inert since it was added.
 *
 * This installer does NOT touch git config (`core.hooksPath`) — plain file
 * copies into the default `.git/hooks/` location are sufficient and avoid
 * mutating repo-wide git configuration. It is idempotent: safe to re-run
 * after editing a `.husky/*` file to pick up the change.
 *
 * Usage: node tools/install-git-hooks.mjs
 */

import { readdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(
  execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
);
const GIT_DIR = execFileSync('git', ['rev-parse', '--git-dir'], {
  encoding: 'utf8',
  cwd: REPO_ROOT,
}).trim();
const HOOKS_SRC = path.join(REPO_ROOT, '.husky');
const HOOKS_DEST = path.isAbsolute(GIT_DIR) ? path.join(GIT_DIR, 'hooks') : path.join(REPO_ROOT, GIT_DIR, 'hooks');

let installed = 0;
for (const name of readdirSync(HOOKS_SRC)) {
  const src = path.join(HOOKS_SRC, name);
  if (!statSync(src).isFile()) continue;
  const dest = path.join(HOOKS_DEST, name);
  writeFileSync(dest, readFileSync(src));
  chmodSync(dest, 0o755);
  installed++;
  console.log(`installed  ${dest}`);
}

console.log(`install-git-hooks: ${installed} hook(s) installed into ${HOOKS_DEST}.`);
