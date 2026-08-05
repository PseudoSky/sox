#!/usr/bin/env node
/**
 * check-amend-shared-index — [BL-457] refuse a pathspec-less `git commit --amend` while the
 * SHARED index diverges from HEAD.
 *
 * THE INCIDENT THIS EXISTS FOR
 * ----------------------------
 * 2026-08-05: an agent ran `git commit --amend -F msg.txt` for the sole purpose of correcting a
 * commit SUBJECT LINE. `--amend` with no pathspec commits whatever is in the shared index, so a
 * clean 2-file / +282 commit became 8 files / +727 / −2567, swallowing and partially reverting
 * BACKLOG.md, CHANGELOG.md, PLAN.md and STATE.md work staged by other agents. It is quieter than a
 * bare `git commit` — the result is a REPLACEMENT for a commit that was already reviewed and
 * reported, so the swallowed work hides behind a subject line someone has already approved.
 * Recovered with `git reset --soft <good-sha>`, which moves HEAD only and leaves the index and
 * working tree untouched.
 *
 * WHY THE DETECTION LOOKS LIKE THIS
 * ---------------------------------
 * Measured 2026-08-05, git 2.51: a hook's environment is BYTE-IDENTICAL between a normal commit
 * and an `--amend` (`env | sort` diff is empty), and `prepare-commit-msg`'s source argument is
 * `message` — not `commit` — whenever `-m`/`-F` is used, which is exactly how the incident was
 * invoked. So there is no env or argument signal for `--amend`; the parent command line is the
 * only one available, and the hook passes it in via SOX_GIT_PARENT_CMD.
 *
 * Pathspec detection, by contrast, IS reliable: git runs hooks with GIT_INDEX_FILE pointed at a
 * temporary `.git/next-index-<pid>.lock` when a pathspec was given, and at the shared `.git/index`
 * when it was not. A pathspec-limited amend commits only those paths and is therefore safe.
 *
 * CONTRACT
 *   exit 0  — not an amend, OR a pathspec was given, OR the shared index matches HEAD.
 *   exit 1  — pathspec-less amend while the shared index diverges from HEAD. Refuses, and prints
 *             both the safe alternatives and the recovery for an amend that already happened.
 *
 * Usage (from .husky/pre-commit):
 *   SOX_GIT_PARENT_CMD="$(ps -o args= -p $PPID 2>/dev/null)" node tools/check-amend-shared-index.mjs
 *
 * Overrides, for the case where the detection is wrong rather than the operator:
 *   SOX_ALLOW_DIRTY_AMEND=1   skip this guard entirely (records itself on stderr).
 */
import { execFileSync } from 'node:child_process';

const git = (args) => execFileSync('git', args, { encoding: 'utf8' });

/** The parent command line, from the hook if it supplied one, else read directly from ps. */
export function parentCommandLine(env = process.env) {
  if (env['SOX_GIT_PARENT_CMD']) return env['SOX_GIT_PARENT_CMD'];
  try {
    // node's parent is the hook shell; the shell's parent is git itself. Walk one level up.
    const shellPpid = execFileSync('ps', ['-o', 'ppid=', '-p', String(process.ppid)], {
      encoding: 'utf8',
    }).trim();
    return execFileSync('ps', ['-o', 'args=', '-p', shellPpid], { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** `--amend` anywhere in the parent command line, as a whole word. */
export function isAmend(cmdline) {
  return /(^|\s)--amend(\s|=|$)/.test(cmdline ?? '');
}

/**
 * True when git was given a pathspec. GIT_INDEX_FILE is a temporary `next-index-*` file in that
 * case, and the shared `.git/index` otherwise. `commit -a` uses `index.lock`, which is NOT a
 * pathspec — it commits every tracked modification and stays subject to this guard.
 */
export function hasPathspec(env = process.env) {
  const idx = env['GIT_INDEX_FILE'] ?? '';
  return /(^|[\\/])next-index-[0-9]+/.test(idx);
}

/** Paths where the shared index differs from HEAD — the content a pathspec-less amend would take. */
export function divergentPaths(cwd = process.cwd()) {
  const out = execFileSync('git', ['diff-index', '--cached', '--name-only', 'HEAD'], {
    cwd,
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

export function evaluate({ env = process.env, cmdline = parentCommandLine(env) } = {}) {
  if (env['SOX_ALLOW_DIRTY_AMEND'] === '1') {
    return { refuse: false, reason: 'override', paths: [] };
  }
  if (!isAmend(cmdline)) return { refuse: false, reason: 'not-an-amend', paths: [] };
  if (hasPathspec(env)) return { refuse: false, reason: 'pathspec-limited', paths: [] };
  const paths = divergentPaths();
  if (!paths.length) return { refuse: false, reason: 'index-matches-head', paths: [] };
  return { refuse: true, reason: 'dirty-index-amend', paths };
}

function main() {
  const verdict = evaluate();
  if (verdict.reason === 'override') {
    console.error('check-amend-shared-index: SKIPPED via SOX_ALLOW_DIRTY_AMEND=1 [BL-457].');
    return 0;
  }
  if (!verdict.refuse) return 0;

  const head = git(['rev-parse', '--short', 'HEAD']).trim();
  console.error(
    [
      '',
      'check-amend-shared-index: REFUSING a pathspec-less `git commit --amend` [BL-457].',
      '',
      `  The shared index diverges from HEAD (${head}) on ${verdict.paths.length} path(s):`,
      ...verdict.paths.map((p) => `    ${p}`),
      '',
      '  `--amend` with no pathspec commits the SHARED INDEX, so this amend would swallow those',
      '  paths into a commit that has already been reviewed under its existing subject line.',
      '  That is BL-457: a 2-file/+282 commit became 8 files/+727/-2567 this way.',
      '',
      '  If you only meant to fix the message:',
      '    node tools/commit-mine.mjs --amend-message -m "corrected subject"',
      '        Rewrites the message via commit-tree, reusing HEAD\'s tree and parents. The index is',
      '        neither read nor written.',
      '',
      '  If you meant to amend specific files, name them:',
      '    git commit --amend path/one path/two',
      '',
      '  If those staged paths are stale leftovers (BL-463/BL-465):',
      `    git restore --staged -- ${verdict.paths.join(' ')}`,
      '        Resets index entries to HEAD. Working-tree files are untouched — verified.',
      '',
      '  If an amend has ALREADY swallowed work, the recovery is:',
      '    git reset --soft <good-sha>',
      '        Moves HEAD only; index and working tree are left exactly as they are.',
      '',
      '  To override this guard: SOX_ALLOW_DIRTY_AMEND=1 git commit --amend …',
      '',
    ].join('\n'),
  );
  return 1;
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main());
}
