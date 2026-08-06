#!/usr/bin/env node
/**
 * tools/test-bl416-shared-registry-lock.mjs
 *
 * Red->green contract pin for BL-416: `tools/allocate-bl-id.mjs` must resolve its
 * BACKLOG.md/CHANGELOG.md/lock-dir root via `git rev-parse --git-common-dir` + `'..'` — the
 * SAME absolute path regardless of which worktree (or the main checkout) invokes it — not via
 * `git rev-parse --show-toplevel`, which returns a DIFFERENT path per worktree and reopens
 * BL-359's id-collision race: two worktrees allocating concurrently would take different locks
 * and could independently compute the same "next" id.
 *
 * Arms:
 *   1. Targeting — a real allocation run from a worktree lands its placeholder in the MAIN
 *      checkout's BACKLOG.md, never the invoking worktree's own copy.
 *   2. Committable — the placeholder, wherever it actually lands, is well-formed enough to
 *      `git add && git commit` cleanly.
 *   3. Same lock, deterministically — the echoed lock-dir path is byte-identical whether the
 *      script is invoked from a worktree or from the main checkout itself.
 *   4. Corroborating (not load-bearing) — an 8-way concurrent cross-worktree race produces 8
 *      unique ids. Documented as non-deterministically red against the pre-fix code (a timing
 *      race, not a guaranteed collision on every run); arm 3 is the acceptance-defining check.
 *
 * Usage: node tools/test-bl416-shared-registry-lock.mjs [--target <path-to-allocate-bl-id.mjs>]
 * Exit 0 iff every assertion holds. Defaults to the sibling allocate-bl-id.mjs in this directory;
 * pass --target to run the assertions against a different revision (e.g. a pre-fix copy
 * materialized via `git show HEAD:tools/allocate-bl-id.mjs`) for the red-before-green check.
 */
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const targetIdx = argv.indexOf('--target');
const ALLOCATE = targetIdx === -1
  ? path.join(HERE, 'allocate-bl-id.mjs')
  : path.resolve(argv[targetIdx + 1]);

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

const sh = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });

function runAllocate(cwd, args = []) {
  const r = execFileSync(process.execPath, [ALLOCATE, ...args], {
    cwd,
    encoding: 'utf8',
    // allocate-bl-id.mjs never fails on a clean fixture in these arms; let a genuine failure
    // throw so it surfaces as a hard test-runner error rather than a silently-empty result.
  });
  return r;
}

function runAllocateCaptureStderr(cwd, args = []) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [ALLOCATE, ...args], { cwd });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

/** A minimal, valid BACKLOG.md/CHANGELOG.md pair matching the real corpus's grammar. */
function seedBacklogFiles(dir) {
  fs.writeFileSync(
    path.join(dir, 'BACKLOG.md'),
    '# BACKLOG\n\n**Total open: 0.**\n\n---\n',
  );
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), '# CHANGELOG\n');
}

function scratchMainRepo() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bl416-main-')));
  sh(['init', '-q'], dir);
  sh(['config', 'user.email', 'test@test.com'], dir);
  sh(['config', 'user.name', 'test'], dir);
  seedBacklogFiles(dir);
  sh(['add', 'BACKLOG.md', 'CHANGELOG.md'], dir);
  sh(['commit', '-q', '-m', 'chore: seed'], dir);
  return dir;
}

function addWorktree(mainRepo, branch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `bl416-wt-${branch}-`));
  fs.rmSync(dir, { recursive: true, force: true }); // git worktree add requires a non-existent dir
  sh(['worktree', 'add', dir, '-b', branch], mainRepo);
  return fs.realpathSync(dir);
}

const mainRepo = scratchMainRepo();
const wtRepoA = addWorktree(mainRepo, 'wt-a');
const wtRepoB = addWorktree(mainRepo, 'wt-b');

// ---------------------------------------------------------------------------
// Arm 1 — Targeting: the placeholder lands in mainRepo's BACKLOG.md, not wtRepoA's.
// RED (today, --show-toplevel): the placeholder lands in wtRepoA's own BACKLOG.md and
// mainRepo's is untouched — this assertion set fails in exactly the way that inverts.
// ---------------------------------------------------------------------------
let allocatedId;
{
  const wtBacklogBefore = fs.readFileSync(path.join(wtRepoA, 'BACKLOG.md'), 'utf8');
  const stdout = runAllocate(wtRepoA);
  const lines = stdout.split('\n').filter(Boolean);
  report(
    'BL-416 arm1: stdout is exactly one line matching /^BL-\\d+$/',
    lines.length === 1 && /^BL-\d+$/.test(lines[0]),
    `stdout=${JSON.stringify(stdout)}`,
  );
  allocatedId = lines[0];

  const mainBacklog = fs.readFileSync(path.join(mainRepo, 'BACKLOG.md'), 'utf8');
  report(
    'BL-416 arm1: the MAIN checkout BACKLOG.md contains the RESERVED heading for the printed id',
    mainBacklog.includes(`### ${allocatedId} — RESERVED`),
    `mainBacklog tail=${JSON.stringify(mainBacklog.slice(-200))}`,
  );

  const wtBacklogAfter = fs.readFileSync(path.join(wtRepoA, 'BACKLOG.md'), 'utf8');
  report(
    "BL-416 arm1: the invoking worktree's own BACKLOG.md is byte-identical to before the run",
    wtBacklogAfter === wtBacklogBefore,
    `before.length=${wtBacklogBefore.length} after.length=${wtBacklogAfter.length}`,
  );
}

// ---------------------------------------------------------------------------
// Arm 2 — Committable at its actual location.
// ---------------------------------------------------------------------------
{
  sh(['add', 'BACKLOG.md'], mainRepo);
  let commitOk = true;
  let detail = '';
  try {
    sh(['commit', '-q', '-m', 'test-bl416'], mainRepo);
  } catch (err) {
    commitOk = false;
    detail = err.message;
  }
  report('BL-416 arm2: `git add && git commit` of the reservation exits 0', commitOk, detail);
}

// ---------------------------------------------------------------------------
// Arm 3 — Same lock, deterministically. Sequential (non-racy) runs from wtRepoA and mainRepo
// must echo the identical resolved lock-dir path.
// RED (today): wtRepoA's echoed lock dir is <wtRepoA>/.bl-id.lock; mainRepo's is
// <mainRepo>/.bl-id.lock — different strings, deterministically.
// ---------------------------------------------------------------------------
{
  const runA = await runAllocateCaptureStderr(wtRepoA);
  const runMain = await runAllocateCaptureStderr(mainRepo);

  // LOCK_DIR itself no longer exists once the run completes (mkdir'd then rmdir'd within the
  // same process) — realpath its still-existing PARENT and rejoin, per §4's /tmp-vs-/private/tmp
  // guidance, rather than realpath-ing the (by-then-gone) lock dir itself.
  const extractLockDir = (stderr) => {
    const m = stderr.match(/lock dir\s*-> (.+)$/m);
    if (!m) return null;
    const raw = m[1].trim();
    return path.join(fs.realpathSync(path.dirname(raw)), path.basename(raw));
  };
  const lockDirA = extractLockDir(runA.err);
  const lockDirMain = extractLockDir(runMain.err);

  report(
    'BL-416 arm3: resolved lock dir echoed from a worktree equals the one echoed from the main checkout',
    lockDirA !== null && lockDirA === lockDirMain,
    `wtRepoA -> ${lockDirA} ; mainRepo -> ${lockDirMain} ; raw wtRepoA stderr=${JSON.stringify(runA.err)}`,
  );
}

// ---------------------------------------------------------------------------
// Arm 4 — Corroborating, not load-bearing: 8-way cross-worktree race, 8 unique ids.
// Not guaranteed deterministically red against the pre-fix code (timing-dependent);
// corroborates arm 3, does not replace it.
// ---------------------------------------------------------------------------
{
  const spawns = [];
  for (let i = 0; i < 4; i++) spawns.push(runAllocateCaptureStderr(wtRepoA));
  for (let i = 0; i < 4; i++) spawns.push(runAllocateCaptureStderr(wtRepoB));
  const results = await Promise.all(spawns);
  const ids = results.map((r) => r.out.trim()).filter((s) => /^BL-\d+$/.test(s));
  const uniqueIds = new Set(ids);
  report(
    'BL-416 arm4 (corroborating): 8 concurrent cross-worktree allocations produce 8 unique ids',
    ids.length === 8 && uniqueIds.size === 8,
    `ids=${JSON.stringify(ids)}`,
  );
}

for (const dir of [wtRepoA, wtRepoB]) {
  try {
    sh(['worktree', 'remove', '--force', dir], mainRepo);
  } catch {
    // best-effort cleanup
  }
  fs.rmSync(dir, { recursive: true, force: true });
}
fs.rmSync(mainRepo, { recursive: true, force: true });

console.log(failed === 0 ? '\nAll BL-416 assertions passed.' : `\n${failed} BL-416 assertion(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
