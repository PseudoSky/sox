#!/usr/bin/env node
/**
 * commit-mine.mjs — [BL-409] commit YOUR changes from a shared checkout without touching the
 * shared git index, and without sweeping up another agent's in-flight work.
 *
 * THE PROBLEM THIS SOLVES
 * ----------------------
 * `.git/index` is shared by every agent working in the same checkout. That produces two distinct
 * failures, and the repo's existing "commit by pathspec" rule only fixes the first:
 *
 *   1. `git add <path>` + bare `git commit` commits the WHOLE index — including files another
 *      agent staged. This swept 10 files across 3 agents into one commit under a docs subject.
 *      `git commit <path>` fixes this, and remains the right default.
 *
 *   2. The index can hold a STALE copy of a file that has since moved forward in HEAD. Measured
 *      2026-08-03: `BACKLOG.md` sat staged 21 lines behind HEAD while two agents held RESERVED
 *      id placeholders in the worktree. A bare `git commit` at that moment would have silently
 *      REVERTED a just-committed fix. Pathspec does not help — the file is genuinely contended.
 *
 *   3. `git commit <path>` is all-or-nothing per file. When two agents are editing different
 *      sections of the same hot file (BACKLOG.md, CHANGELOG.md, PLAN.md — the files every agent
 *      touches), there is no supported way to commit only your own sections.
 *
 * `git stash` is banned in this repo precisely because it "solves" these by destroying the other
 * agent's work. `git reset --hard` likewise.
 *
 * HOW THIS WORKS
 * --------------
 * It builds a PRIVATE index file (via GIT_INDEX_FILE), seeds it from HEAD, applies only the
 * changes you selected, writes a tree, and moves the branch with commit-tree/update-ref. The
 * shared `.git/index` is never read for content and never written. The working tree is never
 * modified — another agent's uncommitted edits survive untouched, still uncommitted.
 *
 * USAGE
 *   node tools/commit-mine.mjs -m "msg" -- BACKLOG.md docs/foo.md
 *       Commit the full worktree content of those paths, based on HEAD.
 *
 *   node tools/commit-mine.mjs -m "msg" --hunks 'BL-393|TRIGGER IDENTIFIED' -- BACKLOG.md
 *       Commit ONLY hunks whose text matches the regex. Everything else in the file — including
 *       another agent's half-written section — stays uncommitted in the worktree.
 *
 *   node tools/commit-mine.mjs --dry-run -m "x" --hunks '...' -- BACKLOG.md
 *       Show which hunks would be taken and which would be left behind. ALWAYS do this first
 *       with --hunks: a regex that matches too much is how you commit someone else's paragraph.
 *
 * This does NOT run hooks (it bypasses `git commit` entirely). Run the guards yourself first:
 *   node tools/check-backlog-markers.mjs && node tools/plan-status.mjs --check
 */

import { execFileSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const git = (args, opts = {}) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });

const die = (msg) => {
  console.error(`commit-mine: ${msg}`);
  process.exit(1);
};

// ---- argument parsing -------------------------------------------------------------------------
const argv = process.argv.slice(2);
const sep = argv.indexOf('--');
if (sep === -1) die('missing `--` separator. Usage: commit-mine.mjs -m "msg" [--hunks RE] -- <paths...>');

const flags = argv.slice(0, sep);
const paths = argv.slice(sep + 1);
if (paths.length === 0) die('no paths given after `--`.');

const valueOf = (name) => {
  const i = flags.indexOf(name);
  return i === -1 ? undefined : flags[i + 1];
};
const message = valueOf('-m') ?? valueOf('--message');
const hunkRe = valueOf('--hunks');
const dryRun = flags.includes('--dry-run');
if (!message) die('missing -m "commit message".');

// ---- guard: refuse to run outside a clean-enough situation ------------------------------------
const repoRoot = git(['rev-parse', '--show-toplevel']).trim();
process.chdir(repoRoot);

// Report (do not touch) whatever another agent has staged, so the operator sees the contention.
const stagedOther = git(['diff', '--cached', '--name-only']).trim().split('\n').filter(Boolean);
if (stagedOther.length) {
  console.error(
    `commit-mine: NOTE — ${stagedOther.length} path(s) are staged in the SHARED index by someone ` +
      `else: ${stagedOther.join(', ')}. They are being left exactly as they are.`,
  );
}

// ---- build the patch we intend to commit -------------------------------------------------------
// Diff HEAD -> worktree for the requested paths only. Deliberately HEAD, not the index: the index
// may be stale, and committing relative to a stale index is failure mode (2) above.
const fullPatch = git(['diff', 'HEAD', '--', ...paths]);
if (!fullPatch.trim()) die('no changes to commit for the given paths (HEAD already matches the worktree).');

let patch = fullPatch;
let skipped = 0;
if (hunkRe) {
  const re = new RegExp(hunkRe);
  // Split per-file so each kept hunk stays under its own file header.
  const perFile = fullPatch.split(/(?=^diff --git )/m).filter(Boolean);
  const kept = [];
  for (const fileChunk of perFile) {
    const at = fileChunk.indexOf('\n@@');
    if (at === -1) continue;
    const header = fileChunk.slice(0, at + 1);
    const hunks = fileChunk.slice(at + 1).split(/(?=^@@ )/m).filter(Boolean);
    const mine = hunks.filter((h) => re.test(h));
    skipped += hunks.length - mine.length;
    if (mine.length) kept.push(header + mine.join(''));
  }
  if (!kept.length) die(`--hunks /${hunkRe}/ matched no hunks. Nothing to commit.`);
  patch = kept.join('');
}

if (dryRun) {
  console.error(`commit-mine: DRY RUN — would commit the following${hunkRe ? ` (${skipped} hunk(s) left behind)` : ''}:`);
  console.log(patch);
  process.exit(0);
}

// ---- apply to a PRIVATE index and commit --------------------------------------------------------
const scratch = mkdtempSync(path.join(process.env['CLAUDE_JOB_DIR'] ?? tmpdir(), 'commit-mine-'));
const privateIndex = path.join(scratch, 'index');
const patchFile = path.join(scratch, 'mine.patch');
writeFileSync(patchFile, patch.endsWith('\n') ? patch : `${patch}\n`);

const env = { ...process.env, GIT_INDEX_FILE: privateIndex };
try {
  git(['read-tree', 'HEAD'], { env });
  git(['apply', '--cached', patchFile], { env });

  const tree = git(['write-tree'], { env }).trim();
  const head = git(['rev-parse', 'HEAD']).trim();
  const commit = git(['commit-tree', tree, '-p', head, '-m', message]).trim();

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (branch === 'HEAD') die('detached HEAD — refusing to move a ref you may not own.');

  // Re-read HEAD immediately before moving the ref. If another agent committed in the window
  // between our read-tree and now, our tree is based on a stale HEAD and would revert them —
  // the exact failure this tool exists to prevent, so refuse rather than race.
  if (git(['rev-parse', 'HEAD']).trim() !== head) {
    die('HEAD moved while this commit was being built (another agent committed). Nothing was changed — re-run.');
  }

  git(['update-ref', `refs/heads/${branch}`, commit, head, '-m', `commit-mine: ${message.split('\n')[0]}`]);
  console.error(
    `commit-mine: committed ${commit.slice(0, 9)} on ${branch}` +
      (hunkRe ? ` — ${skipped} hunk(s) deliberately left uncommitted in the worktree.` : '.'),
  );
  console.error('commit-mine: hooks did NOT run. Verify with the repo guards if you have not already.');
} finally {
  try { unlinkSync(patchFile); } catch { /* scratch dir is disposable */ }
}
