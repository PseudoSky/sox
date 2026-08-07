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
 * shared `.git/index` is never read for content, and is written only by the narrow post-commit
 * resync described next. The working tree is never modified — another agent's uncommitted edits
 * survive untouched, still uncommitted.
 *
 * THE POST-COMMIT RESYNC [BL-465] — why the shared index is touched at all
 * -----------------------------------------------------------------------
 * `update-ref` moves the branch out from under the shared index, which still holds the OLD HEAD
 * blob for every path just committed. `git diff --cached` then reads as the exact INVERSE of the
 * commit, and the next pathspec-less `git commit` (or `git commit --amend`, BL-457) reverts it —
 * a BL-463 revert bomb, manufactured on every run, on the hottest files in the repo. So after the
 * ref moves, each committed path whose shared-index entry still equals the old HEAD blob (plus
 * intent-to-add placeholders, which hold no content) is reset to HEAD with `git restore --staged`.
 *
 * A path where someone else has staged real content is NEVER reset — it is left byte-identical and
 * named in a warning. A blanket `git read-tree HEAD` would be catastrophic here: it converts this
 * revert bomb into immediate loss of every other agent's staged work.
 *
 * USAGE
 *   node tools/commit-mine.mjs -m "msg" -- CHANGELOG.md docs/foo.md
 *       Commit the full worktree content of those paths, based on HEAD.
 *
 *   node tools/commit-mine.mjs -m "msg" --hunks 'BL-393|TRIGGER IDENTIFIED' -- CHANGELOG.md
 *       Commit ONLY hunks whose text matches the regex. Everything else in the file — including
 *       another agent's half-written section — stays uncommitted in the worktree.
 *
 *   node tools/commit-mine.mjs --dry-run -m "x" --hunks '...' -- CHANGELOG.md
 *       Show which hunks would be taken and which would be left behind. ALWAYS do this first
 *       with --hunks: a regex that matches too much is how you commit someone else's paragraph.
 *
 * This does NOT run hooks (it bypasses `git commit` entirely). Run the guard yourself first:
 *   node tools/plan-status.mjs --check
 *
 * TWO GOTCHAS, both hit on first real use:
 *   - `--hunks` applies to EVERY path in the invocation. A regex chosen for one file will silently
 *     filter out an unrelated file's hunks entirely. Commit a new file in its own invocation
 *     without `--hunks`, or check the reported "N hunk(s) left behind" count against what you meant.
 *   - An UNTRACKED file does not appear in `git diff HEAD` at all, so it cannot be selected here.
 *     Run `git add -N <path>` (intent-to-add — records the path, stages no content) first. Plain
 *     `git add` also works but writes real content into the shared index, which is what this tool
 *     exists to avoid.
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
const amendMessage = argv.includes('--amend-message');
if (sep === -1 && !amendMessage) {
  die('missing `--` separator. Usage: commit-mine.mjs -m "msg" [--hunks RE] -- <paths...>');
}

const flags = sep === -1 ? argv : argv.slice(0, sep);
const paths = sep === -1 ? [] : argv.slice(sep + 1);
if (!amendMessage && paths.length === 0) die('no paths given after `--`.');

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

// ---- [BL-457] --amend-message: rewrite HEAD's message and NOTHING else -------------------------
// `git commit --amend` with no pathspec commits the SHARED index. One live incident turned a
// reviewed 2-file/+282 commit into 8 files/+727/−2567, hiding the swallowed work behind a subject
// line that had already been read and approved. This mode reuses HEAD's tree and parents verbatim,
// so the amended commit is byte-identical in content to the one it replaces — the index is never
// read for content and never written, and the working tree is never touched.
if (amendMessage) {
  if (paths.length) die('--amend-message rewrites only the message; it takes no paths.');
  if (hunkRe) die('--amend-message rewrites only the message; --hunks is meaningless here.');

  const head = git(['rev-parse', 'HEAD']).trim();
  const tree = git(['rev-parse', 'HEAD^{tree}']).trim();
  const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/).slice(1);
  const oldSubject = git(['log', '-1', '--format=%s', 'HEAD']).trim();

  if (dryRun) {
    console.error(`commit-mine: DRY RUN — would rewrite HEAD (${head.slice(0, 9)}) message only.`);
    console.error(`  tree stays ${tree.slice(0, 9)}, parents stay [${parents.map((p) => p.slice(0, 9)).join(', ') || 'none — root commit'}]`);
    console.log(`- ${oldSubject}\n+ ${message.split('\n')[0]}`);
    process.exit(0);
  }

  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  if (branch === 'HEAD') die('detached HEAD — refusing to move a ref you may not own.');

  // Preserve the original authorship; only the message (and committer) may change.
  const [an, ae, ad] = git(['log', '-1', '--format=%an%n%ae%n%aI', 'HEAD']).split('\n');
  const authorEnv = { ...process.env, GIT_AUTHOR_NAME: an, GIT_AUTHOR_EMAIL: ae, GIT_AUTHOR_DATE: ad };

  const parentArgs = parents.flatMap((p) => ['-p', p]);
  const commit = git(['commit-tree', tree, ...parentArgs, '-m', message], { env: authorEnv }).trim();

  if (git(['rev-parse', 'HEAD']).trim() !== head) {
    die('HEAD moved while the message was being rewritten (another agent committed). Nothing was changed — re-run.');
  }
  git(['update-ref', `refs/heads/${branch}`, commit, head, '-m', `commit-mine --amend-message: ${message.split('\n')[0]}`]);

  console.error(`commit-mine: rewrote the message of ${head.slice(0, 9)} as ${commit.slice(0, 9)} on ${branch} [BL-457].`);
  console.error(`commit-mine: tree unchanged (${tree.slice(0, 9)}) — the shared index was neither read nor written.`);
  console.error('commit-mine: hooks did NOT run. Verify with the repo guards if you have not already.');
  process.exit(0);
}

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

  // [BL-465] Decide the shared-index resync BEFORE the ref moves, while HEAD is still the old
  // commit — see the resync block after `update-ref` for why this must happen and why it must be
  // per-path. Paths are read from the private index so they are exactly what this commit touches
  // (a directory argument or a `--hunks` filter means `paths` is not that list).
  const committedPaths = git(['diff-index', '--cached', '--name-only', head], { env })
    .split('\n')
    .filter(Boolean);

  // An intent-to-add entry (`git add -N`, which this tool's own docs mandate for a new file) holds
  // the empty blob and no content of anyone's. `git status --porcelain` is the only reliable
  // discriminator: intent-to-add is " A", a genuinely staged add is "A ". Read it while HEAD is
  // still old, because our own commit changes the reported status.
  const intentToAdd = new Set(
    git(['status', '--porcelain', '-z', '--', ...committedPaths])
      .split('\0')
      .filter((rec) => rec.startsWith(' A '))
      .map((rec) => rec.slice(3)),
  );

  // Safe to resync == the shared-index entry still matches the OLD HEAD blob, i.e. nobody staged
  // real content there. Anything else is another agent's work and is left strictly alone.
  const resyncable = [];
  const contended = [];
  for (const p of committedPaths) {
    let matchesOldHead;
    try {
      git(['diff-index', '--cached', '--quiet', head, '--', p]);
      matchesOldHead = true;
    } catch {
      matchesOldHead = false;
    }
    (matchesOldHead || intentToAdd.has(p) ? resyncable : contended).push(p);
  }

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

  // ---- [BL-465] resync the SHARED index for the paths we just committed ------------------------
  // The branch has moved but the shared index still holds the OLD HEAD blob for every committed
  // path, so `git diff --cached` now reads as the exact INVERSE of this commit and the next
  // pathspec-less `git commit` (or `git commit --amend`, BL-457) would revert it. That is a
  // BL-463 revert bomb manufactured by the very tool mandated for the hottest files.
  //
  // This is deliberately NOT `git read-tree HEAD`: a blanket reseed would erase every other
  // agent's legitimately staged work, converting a revert bomb into immediate data loss. Only the
  // paths classified `resyncable` above — entry still equal to the old HEAD blob, or an
  // intent-to-add placeholder — are touched. `git restore --staged` rewrites index entries only;
  // the working tree is never read or written.
  if (git(['rev-parse', 'HEAD']).trim() !== commit) {
    console.error(
      'commit-mine: WARNING — HEAD moved again immediately after this commit; skipping the ' +
        'shared-index resync rather than acting on a ref state we no longer own. Run ' +
        `\`git restore --staged -- ${committedPaths.join(' ')}\` once the tree settles (BL-465).`,
    );
  } else if (resyncable.length) {
    git(['restore', '--staged', '--', ...resyncable]);
    console.error(`commit-mine: shared index resynced to HEAD for ${resyncable.length} committed path(s) [BL-465].`);
  }
  if (contended.length) {
    console.error(
      `commit-mine: NOT resynced — ${contended.length} committed path(s) hold someone else's staged ` +
        `content in the shared index and were left byte-identical: ${contended.join(', ')}. ` +
        'Their index entries are now behind HEAD; do not run a pathspec-less commit until the ' +
        'owner commits or clears them (BL-465).',
    );
  }
  console.error('commit-mine: hooks did NOT run. Verify with the repo guards if you have not already.');
} finally {
  try { unlinkSync(patchFile); } catch { /* scratch dir is disposable */ }
}
