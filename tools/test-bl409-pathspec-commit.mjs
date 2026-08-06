#!/usr/bin/env node
/**
 * tools/test-bl409-pathspec-commit.mjs
 *
 * Red->green contract pin for BL-409: "stage by explicit path" does not
 * protect a shared checkout, because `git add <path>` controls only what
 * *this* agent adds to the index — a bare `git commit` afterward commits
 * the *entire* index, sweeping in anything another agent already staged.
 * The fix is a pathspec-limited commit (`git commit <path> -m ...`), which
 * commits exactly those paths regardless of what else is staged.
 *
 * This script builds a disposable scratch repo, simulates a second agent
 * having already staged fileA.txt, then asserts:
 *   - the OLD documented procedure (`git add B && git commit`) sweeps
 *     fileA.txt into the commit (this assertion is expected to hold —
 *     it is the failure mode BL-409 describes, i.e. "red" against the
 *     new AGENTS.md guidance)
 *   - the NEW documented procedure (`git commit B -m ...`) does NOT
 *     (this is "green" — the fix)
 *
 * Usage: node tools/test-bl409-pathspec-commit.mjs
 * Exit 0 iff both scenarios behave as BL-409 predicts.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// BL-479 — strip inherited GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE/GIT_COMMON_DIR so this scratch
// repo's git commands can never resolve against the invoking checkout's real index (git prefers
// these env vars over cwd-based repo discovery). Confirmed root cause of BL-479: this file's
// scratch fixture is literally named `fileA.txt`/`fileB.txt`, which turned up as corrupted stage-0
// entries in the real repo's index after a session ran with GIT_INDEX_FILE set ambiently.
const SAFE_GIT_ENV = { ...process.env };
delete SAFE_GIT_ENV.GIT_DIR;
delete SAFE_GIT_ENV.GIT_INDEX_FILE;
delete SAFE_GIT_ENV.GIT_WORK_TREE;
delete SAFE_GIT_ENV.GIT_COMMON_DIR;

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

function sh(cmd, args, cwd) {
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', env: SAFE_GIT_ENV });
}

function makeScratchRepo(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bl409-${label}-`));
  sh('git', ['init', '-q'], dir);
  sh('git', ['config', 'user.email', 'test@test.com'], dir);
  sh('git', ['config', 'user.name', 'test'], dir);
  fs.writeFileSync(path.join(dir, 'fileA.txt'), 'orig\n');
  fs.writeFileSync(path.join(dir, 'fileB.txt'), 'orig\n');
  sh('git', ['add', 'fileA.txt', 'fileB.txt'], dir);
  sh('git', ['commit', '-q', '-m', 'chore: initial files'], dir);

  // Simulate a second, concurrent agent that has already staged an
  // in-flight edit to fileA.txt and has NOT committed yet.
  fs.writeFileSync(path.join(dir, 'fileA.txt'), 'other-agent-edit\n');
  sh('git', ['add', 'fileA.txt'], dir);

  // Our own task: edit fileB.txt only.
  fs.writeFileSync(path.join(dir, 'fileB.txt'), 'our-edit\n');

  return dir;
}

function filesInHead(dir) {
  return sh('git', ['show', '--stat=200', '--format=', 'HEAD'], dir)
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split('|')[0].trim());
}

// ---------------------------------------------------------------------------
// Scenario 1 (OLD, documented-but-broken procedure): `git add <path>` then a
// bare `git commit`. BL-409's claim is that this sweeps in fileA.txt.
// ---------------------------------------------------------------------------
{
  const dir = makeScratchRepo('old');
  sh('git', ['add', 'fileB.txt'], dir);
  sh('git', ['commit', '-q', '-m', 'fix: update fileB'], dir);
  const files = filesInHead(dir);
  const sweptA = files.includes('fileA.txt');
  report(
    '(old) `git add B && git commit` sweeps in fileA.txt (expected failure mode)',
    sweptA,
    `HEAD touched: ${files.join(', ')}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Scenario 2 (NEW, fixed procedure): pathspec-limited `git commit <path>`.
// This must commit ONLY fileB.txt, leaving fileA.txt staged-but-uncommitted.
// ---------------------------------------------------------------------------
{
  const dir = makeScratchRepo('new');
  sh('git', ['commit', 'fileB.txt', '-m', 'fix: update fileB'], dir);
  const files = filesInHead(dir);
  const sweptA = files.includes('fileA.txt');
  const gotB = files.includes('fileB.txt');
  report(
    '(new) `git commit B -m ...` does NOT sweep in fileA.txt',
    !sweptA && gotB,
    `HEAD touched: ${files.join(', ')}`,
  );
  // fileA.txt must still be staged (index untouched), not lost.
  const status = sh('git', ['status', '--porcelain'], dir);
  const aStillStagedOnly = /^M {2}fileA\.txt$/m.test(status);
  report(
    '(new) fileA.txt remains staged, untouched, for the other agent to commit',
    aStillStagedOnly,
    `git status --porcelain:\n${status}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(failed === 0 ? '\nAll BL-409 assertions passed.' : `\n${failed} BL-409 assertion(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
