#!/usr/bin/env node
/**
 * tools/test-bl457-amend-shared-index.mjs
 *
 * Red->green contract pin for BL-457: `git commit --amend` with no pathspec commits the SHARED
 * INDEX. A live 2026-08-05 incident ran `git commit --amend -F msg.txt` to correct a SUBJECT LINE
 * and turned a reviewed 2-file / +282 commit into 8 files / +727 / -2567, swallowing other agents'
 * staged BACKLOG.md / CHANGELOG.md / PLAN.md / STATE.md work behind an already-approved subject.
 *
 * Arms:
 *   1. BL-457 hazard (the standing failure mode, asserted so it cannot silently change): a
 *      pathspec-less `--amend` really does swallow another agent's staged path.
 *   2. BL-457 guard, RED before `tools/check-amend-shared-index.mjs` existed: with the hook
 *      installed, that same amend is REFUSED and the other agent's path stays out of HEAD.
 *   3. BL-457 guard is narrow: a pathspec-limited amend, an amend against a clean index, and a
 *      normal (non-amend) commit are all allowed through.
 *   4. BL-457 amend mode: `commit-mine.mjs --amend-message` rewrites the subject with the tree,
 *      parents and authorship byte-identical, and never touches the shared index.
 *   5. BL-457 recovery: `git reset --soft <good-sha>` restores the pre-amend HEAD with the index
 *      and every working-tree file left byte-identical — the documented recovery, executed.
 *
 * Usage: node tools/test-bl457-amend-shared-index.mjs
 * Exit 0 iff every assertion holds.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const GUARD = path.join(TOOLS, 'check-amend-shared-index.mjs');
const COMMIT_MINE = path.join(TOOLS, 'commit-mine.mjs');

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

const sh = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });
const tryGit = (args, cwd) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
};

function scratchRepo(label, { withHook } = { withHook: false }) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `bl457-${label}-`)));
  sh(['init', '-q'], dir);
  sh(['config', 'user.email', 'test@test.com'], dir);
  sh(['config', 'user.name', 'test'], dir);
  fs.writeFileSync(path.join(dir, 'mine.txt'), 'v1\n');
  fs.writeFileSync(path.join(dir, 'theirs.txt'), 'v1\n');
  sh(['add', 'mine.txt', 'theirs.txt'], dir);
  sh(['commit', '-q', '-m', 'chore: initial'], dir);

  // Our reviewed commit: one file.
  fs.writeFileSync(path.join(dir, 'mine.txt'), 'v2-reviewed\n');
  sh(['commit', '-q', 'mine.txt', '-m', 'feat: the reviewed commit'], dir);

  // Another agent stages work in the shared index and has not committed.
  fs.writeFileSync(path.join(dir, 'theirs.txt'), 'other-agent-work\n');
  sh(['add', 'theirs.txt'], dir);

  if (withHook) {
    // Exactly the wiring .husky/pre-commit uses, pointed at this repo's guard.
    fs.writeFileSync(
      path.join(dir, '.git', 'hooks', 'pre-commit'),
      `#!/bin/sh\nset -e\nSOX_GIT_PARENT_CMD="$(ps -o args= -p $PPID 2>/dev/null)" ${JSON.stringify(process.execPath)} ${JSON.stringify(GUARD)}\n`,
    );
    fs.chmodSync(path.join(dir, '.git', 'hooks', 'pre-commit'), 0o755);
  }
  return dir;
}

const filesInHead = (dir) =>
  sh(['show', '--stat=200', '--format=', 'HEAD'], dir)
    .split('\n')
    .map((l) => l.split('|')[0].trim())
    .filter((l) => l && !/files? changed/.test(l));

const worktreeSnapshot = (dir) =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.txt'))
    .sort()
    .map((f) => `${f}:${fs.readFileSync(path.join(dir, f), 'utf8')}`)
    .join('|');

// ---------------------------------------------------------------------------
// Arm 1 — the hazard itself. Unguarded, a pathspec-less amend swallows the
// other agent's staged file. This is BL-457's incident, reproduced.
// ---------------------------------------------------------------------------
{
  const dir = scratchRepo('hazard');
  sh(['commit', '-q', '--amend', '-m', 'feat: the reviewed commit (subject corrected)'], dir);
  const files = filesInHead(dir);
  report(
    'BL-457: unguarded, a pathspec-less `--amend` swallows another agent\'s staged path',
    files.includes('theirs.txt'),
    `HEAD touched: ${files.join(', ')}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Arm 2 — the guard. RED before tools/check-amend-shared-index.mjs existed.
// ---------------------------------------------------------------------------
{
  const dir = scratchRepo('guard', { withHook: true });
  const headBefore = sh(['rev-parse', 'HEAD'], dir).trim();
  const r = tryGit(['commit', '--amend', '-m', 'feat: the reviewed commit (subject corrected)'], dir);

  report(
    'BL-457: the guard REFUSES a pathspec-less `--amend` while the shared index diverges from HEAD',
    r.code !== 0 && sh(['rev-parse', 'HEAD'], dir).trim() === headBefore,
    `exit=${r.code}`,
  );
  report(
    "BL-457: the refusal names the divergent path and the `--amend-message` alternative",
    /theirs\.txt/.test(r.err) && /--amend-message/.test(r.err) && /reset --soft/.test(r.err),
    `stderr head: ${JSON.stringify(r.err.split('\n').slice(0, 3).join(' / '))}`,
  );
  report(
    "BL-457: the other agent's staged content is still staged, and never reached HEAD",
    sh(['diff', '--cached', '--name-only'], dir).trim() === 'theirs.txt' &&
      !filesInHead(dir).includes('theirs.txt'),
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Arm 3 — the guard is narrow: it must not block the safe forms.
// ---------------------------------------------------------------------------
{
  // 3a. pathspec-limited amend, dirty index — allowed, and commits only that path.
  const a = scratchRepo('narrow-pathspec', { withHook: true });
  fs.writeFileSync(path.join(a, 'mine.txt'), 'v3\n');
  const ra = tryGit(['commit', '--amend', 'mine.txt', '-m', 'feat: amended with a pathspec'], a);
  report(
    'BL-457: a pathspec-limited `--amend` is allowed and takes only the named path',
    ra.code === 0 && !filesInHead(a).includes('theirs.txt'),
    `exit=${ra.code} HEAD touched: ${filesInHead(a).join(', ')}`,
  );
  fs.rmSync(a, { recursive: true, force: true });

  // 3b. amend with a clean shared index — allowed.
  const b = scratchRepo('narrow-clean', { withHook: true });
  sh(['restore', '--staged', '--', 'theirs.txt'], b);
  const rb = tryGit(['commit', '--amend', '-m', 'feat: amended against a clean index'], b);
  report(
    'BL-457: `--amend` against a clean shared index is allowed',
    rb.code === 0 && sh(['log', '-1', '--format=%s'], b).trim() === 'feat: amended against a clean index',
    `exit=${rb.code} ${rb.err.trim()}`,
  );
  fs.rmSync(b, { recursive: true, force: true });

  // 3c. an ordinary (non-amend) commit with a dirty index — not this guard's business (BL-409 governs it).
  const c = scratchRepo('narrow-normal', { withHook: true });
  fs.writeFileSync(path.join(c, 'mine.txt'), 'v3\n');
  const rc = tryGit(['commit', 'mine.txt', '-m', 'chore: an ordinary pathspec commit'], c);
  report(
    'BL-457: an ordinary commit is untouched by this guard (BL-409 governs that case)',
    rc.code === 0,
    `exit=${rc.code} ${rc.err.trim()}`,
  );
  fs.rmSync(c, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Arm 4 — commit-mine --amend-message: the safe way to do what the incident meant to do.
// ---------------------------------------------------------------------------
{
  const dir = scratchRepo('amend-message');
  const treeBefore = sh(['rev-parse', 'HEAD^{tree}'], dir).trim();
  const parentBefore = sh(['rev-parse', 'HEAD^'], dir).trim();
  const authorBefore = sh(['log', '-1', '--format=%an <%ae> %aI'], dir).trim();
  const stagedBefore = sh(['ls-files', '-s'], dir);
  const wtBefore = worktreeSnapshot(dir);

  const r = spawnSync(process.execPath, [COMMIT_MINE, '--amend-message', '-m', 'feat: the reviewed commit (subject corrected)'], {
    cwd: dir,
    encoding: 'utf8',
  });

  report(
    'BL-457: `--amend-message` rewrites the subject with the tree and parents byte-identical',
    (r.status ?? 1) === 0 &&
      sh(['log', '-1', '--format=%s'], dir).trim() === 'feat: the reviewed commit (subject corrected)' &&
      sh(['rev-parse', 'HEAD^{tree}'], dir).trim() === treeBefore &&
      sh(['rev-parse', 'HEAD^'], dir).trim() === parentBefore,
    `exit=${r.status} ${(r.stderr ?? '').trim().split('\n')[0]}`,
  );
  report(
    'BL-457: `--amend-message` preserves the original authorship',
    sh(['log', '-1', '--format=%an <%ae> %aI'], dir).trim() === authorBefore,
  );
  report(
    "BL-457: `--amend-message` leaves the shared index and working tree byte-identical",
    sh(['ls-files', '-s'], dir) === stagedBefore && worktreeSnapshot(dir) === wtBefore,
  );
  report(
    "BL-457: `--amend-message` cannot swallow the other agent's staged path",
    !filesInHead(dir).includes('theirs.txt'),
    `HEAD touched: ${filesInHead(dir).join(', ')}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Arm 5 — the documented recovery, executed rather than asserted in prose.
// ---------------------------------------------------------------------------
{
  const dir = scratchRepo('recovery');
  const goodSha = sh(['rev-parse', 'HEAD'], dir).trim();
  const stagedBefore = sh(['ls-files', '-s'], dir);
  const wtBefore = worktreeSnapshot(dir);

  sh(['commit', '-q', '--amend', '-m', 'feat: the reviewed commit (subject corrected)'], dir); // the incident
  sh(['reset', '--soft', goodSha], dir); // the recovery

  report(
    'BL-457: `git reset --soft <good-sha>` restores HEAD, index and worktree without loss',
    sh(['rev-parse', 'HEAD'], dir).trim() === goodSha &&
      sh(['ls-files', '-s'], dir) === stagedBefore &&
      worktreeSnapshot(dir) === wtBefore,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(
  failed === 0 ? '\nAll BL-457 assertions passed.' : `\n${failed} BL-457 assertion(s) FAILED.`,
);
process.exit(failed === 0 ? 0 : 1);
