#!/usr/bin/env node
/**
 * tools/test-bl465-commit-mine-index-resync.mjs
 *
 * Red->green contract pin for BL-465: `tools/commit-mine.mjs` builds its tree in a PRIVATE
 * `GIT_INDEX_FILE` and moves the branch with `commit-tree` + `update-ref`. It never resynced the
 * SHARED index, so the instant HEAD advanced, every path in the commit was left in the shared index
 * holding the OLD HEAD blob — `git diff --cached` reading as the exact inverse of the commit just
 * made. That is a BL-463 revert bomb, manufactured on every run, on the hottest files in the repo
 * (BACKLOG.md / CHANGELOG.md / PLAN.md), by the very tool CLAUDE.md mandates for them.
 *
 * The fix must be NARROW. A blanket `git read-tree HEAD` against the shared index would discard
 * every other agent's legitimately staged work — turning a revert bomb into immediate data loss.
 * So only paths whose shared-index entry still matches the OLD HEAD blob (plus intent-to-add
 * placeholders, which hold no content) may be resynced; anything else is left byte-identical and
 * warned about.
 *
 * Arms:
 *   1. BL-465 core (RED before the fix): clean shared index, commit one tracked file,
 *      `git diff --cached` must be EMPTY afterwards.
 *   2. BL-465 protective: another agent's content staged for a path we commit is left
 *      BYTE-IDENTICAL and the run warns, naming the path.
 *   3. BL-465 bystander: another agent's staged content on a path we do NOT commit is untouched,
 *      while the path we do commit is resynced.
 *   4. BL-465 intent-to-add: a new file staged with `git add -N` (the flow commit-mine's own
 *      docs mandate) leaves no empty-blob bomb behind.
 *   5. BL-465 worktree: no arm may modify any working-tree file.
 *
 * Usage: node tools/test-bl465-commit-mine-index-resync.mjs
 * Exit 0 iff every assertion holds.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT_MINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'commit-mine.mjs');

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

const sh = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });

/** commit-mine reports on stderr; capture both streams without a non-zero exit throwing. */
function runCommitMine(cwd, args) {
  const r = spawnSync(process.execPath, [COMMIT_MINE, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

function scratchRepo(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bl465-${label}-`));
  const real = fs.realpathSync(dir);
  sh(['init', '-q'], real);
  sh(['config', 'user.email', 'test@test.com'], real);
  sh(['config', 'user.name', 'test'], real);
  fs.writeFileSync(path.join(real, 'fileA.txt'), 'orig-A\n');
  fs.writeFileSync(path.join(real, 'fileB.txt'), 'orig-B\n');
  sh(['add', 'fileA.txt', 'fileB.txt'], real);
  sh(['commit', '-q', '-m', 'chore: initial files'], real);
  return real;
}

const indexEntry = (dir, p) => sh(['ls-files', '-s', '--', p], dir).trim();
const cachedDiff = (dir) => sh(['diff', '--cached', '--stat'], dir).trim();
const worktreeSnapshot = (dir) =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.txt'))
    .sort()
    .map((f) => `${f}:${fs.readFileSync(path.join(dir, f), 'utf8')}`)
    .join('|');

// ---------------------------------------------------------------------------
// Arm 1 — BL-465 core. Clean shared index in, clean shared index out.
// ---------------------------------------------------------------------------
{
  const dir = scratchRepo('core');
  const before = cachedDiff(dir);
  fs.writeFileSync(path.join(dir, 'fileB.txt'), 'mine-B\n');
  const wtBefore = worktreeSnapshot(dir);

  runCommitMine(dir, ['-m', 'fix: BL-465 arm 1', '--', 'fileB.txt']);

  const after = cachedDiff(dir);
  report(
    'BL-465: shared index is EMPTY after commit-mine (was the exact inverse of the commit)',
    before === '' && after === '',
    `before=[${before}] after=[${after}]`,
  );
  report(
    'BL-465: committed content is in HEAD and the worktree is untouched',
    sh(['show', 'HEAD:fileB.txt'], dir) === 'mine-B\n' && worktreeSnapshot(dir) === wtBefore,
    `HEAD:fileB.txt=${JSON.stringify(sh(['show', 'HEAD:fileB.txt'], dir))}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Arm 2 — BL-465 protective. Another agent's staged content on a path we commit
// must survive byte-identical, and the run must warn naming that path.
// ---------------------------------------------------------------------------
{
  const dir = scratchRepo('protect');
  // Other agent: stages content for fileB.txt that exists ONLY in the index.
  fs.writeFileSync(path.join(dir, 'fileB.txt'), 'other-agent-staged-B\n');
  sh(['add', 'fileB.txt'], dir);
  const otherEntry = indexEntry(dir, 'fileB.txt');
  // Us: our own content for the same path, in the worktree.
  fs.writeFileSync(path.join(dir, 'fileB.txt'), 'mine-B\n');
  const wtBefore = worktreeSnapshot(dir);

  const r = runCommitMine(dir, ['-m', 'fix: BL-465 arm 2', '--', 'fileB.txt']);

  report(
    "BL-465: another agent's staged entry for a committed path is left BYTE-IDENTICAL",
    indexEntry(dir, 'fileB.txt') === otherEntry,
    `before=[${otherEntry}] after=[${indexEntry(dir, 'fileB.txt')}]`,
  );
  report(
    'BL-465: the run warns, naming the path it refused to resync',
    /fileB\.txt/.test(r.err) && /resync/i.test(r.err),
    `stderr=${JSON.stringify(r.err)}`,
  );
  report(
    'BL-465: the protective arm still commits our content and never touches the worktree',
    sh(['show', 'HEAD:fileB.txt'], dir) === 'mine-B\n' && worktreeSnapshot(dir) === wtBefore,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Arm 3 — BL-465 bystander. A staged path OUTSIDE the commit is never considered.
// This is the arm a blanket `read-tree HEAD` fails: it would erase fileA.txt.
// ---------------------------------------------------------------------------
{
  const dir = scratchRepo('bystander');
  fs.writeFileSync(path.join(dir, 'fileA.txt'), 'other-agent-staged-A\n');
  sh(['add', 'fileA.txt'], dir);
  const otherEntry = indexEntry(dir, 'fileA.txt');
  fs.writeFileSync(path.join(dir, 'fileB.txt'), 'mine-B\n');

  runCommitMine(dir, ['-m', 'fix: BL-465 arm 3', '--', 'fileB.txt']);

  report(
    "BL-465: a staged path outside the commit is untouched (blanket `read-tree HEAD` would erase it)",
    indexEntry(dir, 'fileA.txt') === otherEntry,
    `before=[${otherEntry}] after=[${indexEntry(dir, 'fileA.txt')}]`,
  );
  const cachedNames = sh(['diff', '--cached', '--name-only'], dir).trim().split('\n').filter(Boolean);
  report(
    'BL-465: after the run only the bystander remains staged — the committed path was resynced',
    cachedNames.length === 1 && cachedNames[0] === 'fileA.txt',
    `staged=[${cachedNames.join(', ')}]`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Arm 4 — BL-465 intent-to-add. commit-mine's own docs mandate `git add -N` for a
// new file; the empty-blob placeholder it leaves is a revert bomb of its own once
// the real content lands in HEAD (a bare commit would re-empty the file).
// ---------------------------------------------------------------------------
{
  const dir = scratchRepo('ita');
  fs.writeFileSync(path.join(dir, 'fileC.txt'), 'brand-new-C\n');
  sh(['add', '-N', 'fileC.txt'], dir);
  const wtBefore = worktreeSnapshot(dir);

  runCommitMine(dir, ['-m', 'feat: BL-465 arm 4', '--', 'fileC.txt']);

  report(
    'BL-465: an intent-to-add placeholder leaves no empty-blob bomb in the shared index',
    cachedDiff(dir) === '',
    `git diff --cached --stat=[${cachedDiff(dir)}]`,
  );
  report(
    'BL-465: the new file is committed with real content and the worktree is untouched',
    sh(['show', 'HEAD:fileC.txt'], dir) === 'brand-new-C\n' && worktreeSnapshot(dir) === wtBefore,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(
  failed === 0 ? '\nAll BL-465 assertions passed.' : `\n${failed} BL-465 assertion(s) FAILED.`,
);
process.exit(failed === 0 ? 0 : 1);
