#!/usr/bin/env node
/**
 * tools/lib/git-index-scope.mjs — shared helper for f1dc4926: decide whether an inherited
 * `GIT_INDEX_FILE` env var may be trusted for git operations rooted at a given repo.
 *
 * A pathspec commit (`git commit -- path`, the mandated form) hands the pre-commit hook process a
 * PRIVATE next-index via `GIT_INDEX_FILE` (F10 in fc2735f0's spec). Consulting it is what makes
 * `git diff --cached` see exactly the committed paths instead of the shared `.git/index`, which
 * can hold another agent's staged entries.
 *
 * But blindly trusting an inherited `GIT_INDEX_FILE` is its own hazard (BL-479's general shape,
 * from the other direction): an ambient env var can be leaked into a child process from an
 * UNRELATED repo — e.g. `git -c core.hooksPath=...` propagates via `GIT_CONFIG_*` env vars to
 * every child git process, and other invocation chains could just as easily leave a stale
 * `GIT_INDEX_FILE` set. So this only re-admits `GIT_INDEX_FILE` when it can be PROVEN to live
 * inside `root`'s own git dir (`git rev-parse --absolute-git-dir`) — never blindly.
 *
 * Consumers: tools/run-guards.mjs, tools/precommit-lint.mjs.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** `git rev-parse --absolute-git-dir` for `root`, or null (traced) on failure. */
export function resolveAbsoluteGitDir(root, env, label = 'git-index-scope') {
  try {
    return execFileSync('git', ['-C', root, 'rev-parse', '--absolute-git-dir'], {
      encoding: 'utf8',
      env,
    }).trim();
  } catch (err) {
    console.error(`${label}: could not resolve the git dir for ${root} — ${err.message}`);
    return null;
  }
}

/**
 * Returns a COPY of `env` with `GIT_INDEX_FILE` set to `indexFile` IFF `indexFile` can be proven
 * to live inside `root`'s own git dir. Otherwise returns a copy of `env` with `GIT_INDEX_FILE`
 * removed (never left dangling with a rejected/unverifiable value) — always a fresh object, so
 * callers never need to worry about the input `env` being mutated or about a stale key surviving
 * a rejection.
 */
export function withVerifiedGitIndex({ root, env, indexFile, label = 'git-index-scope' }) {
  const base = { ...env };
  delete base.GIT_INDEX_FILE;

  if (!indexFile) return base;

  const gitDir = resolveAbsoluteGitDir(root, base, label);
  if (!gitDir) return base;

  let realGitDir;
  let realIndexDir;
  try {
    realGitDir = fs.realpathSync(gitDir);
    // The index file itself may not exist yet (a brand-new next-index); realpath its parent dir
    // instead so a not-yet-created lockfile still resolves.
    realIndexDir = fs.realpathSync(path.dirname(path.resolve(root, indexFile)));
  } catch (err) {
    console.error(`${label}: could not verify GIT_INDEX_FILE ownership — ${err.message}. Ignoring it.`);
    return base;
  }

  const belongsToThisRepo = realIndexDir === realGitDir || realIndexDir.startsWith(realGitDir + path.sep);
  if (!belongsToThisRepo) {
    console.error(`${label}: GIT_INDEX_FILE (${indexFile}) does not belong to ${root}'s git dir — ignoring it.`);
    return base;
  }

  return { ...base, GIT_INDEX_FILE: indexFile };
}
