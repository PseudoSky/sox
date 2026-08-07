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
 * [Discovered during ADR-0011 Stage 3 / SPEC-DELETE-FILES.md AC-precommit-live verification]
 * `git rev-parse --git-dir`, run from inside a worktree, returns the WORKTREE-PRIVATE gitdir
 * (`.git/worktrees/<name>`) — but git's actual hook lookup for `pre-commit`/`commit-msg` always
 * uses the COMMON gitdir's `hooks/` (the main checkout's `.git/hooks/`), which every worktree
 * shares. Hooks are not one of the per-worktree files (unlike `HEAD`/`index`). Installing via
 * `--git-dir` therefore silently wrote into a directory git never reads when run from any
 * worktree — the hook appeared "installed" (files present, correct content, correct mode) while
 * the actually-invoked hook stayed whatever was last installed from the main checkout. Fixed to
 * `--git-common-dir`, the same shared-registry resolution `check-backlog-markers.mjs`/
 * `allocate-bl-id.mjs` already used for `BACKLOG.md` (BL-416) — hooks are exactly the same kind of
 * "shared, not per-worktree" resource.
 *
 * Usage: node tools/install-git-hooks.mjs
 */

import { readdirSync, readFileSync, writeFileSync, chmodSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const REPO_ROOT = path.resolve(
  execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim(),
);
const GIT_COMMON_DIR = execFileSync('git', ['rev-parse', '--git-common-dir'], {
  encoding: 'utf8',
  cwd: REPO_ROOT,
}).trim();
const HOOKS_SRC = path.join(REPO_ROOT, '.husky');
const HOOKS_DEST = path.isAbsolute(GIT_COMMON_DIR) ? path.join(GIT_COMMON_DIR, 'hooks') : path.join(REPO_ROOT, GIT_COMMON_DIR, 'hooks');

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
