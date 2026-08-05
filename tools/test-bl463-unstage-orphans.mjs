#!/usr/bin/env node
/**
 * tools/test-bl463-unstage-orphans.mjs
 *
 * Red->green contract pin for BL-463: an agent that finishes or is stopped while holding staged
 * files leaves a revert bomb in the shared index. Three occurrences on 2026-08-05, every one found
 * by accident: the working trees were correct and only the index was stale, so `git status` showed
 * nothing alarming while a bare `git commit` by anyone would have reverted committed work in bulk.
 *
 * `tools/unstage-orphans.mjs` is the teardown step. Every arm here asserts the recovery is
 * non-destructive — the property the incidents' recoveries were trusted on three times, never
 * mechanically checked:
 *
 *   1. BL-463 teardown: a seeded divergence is cleared, and EVERY working-tree file is byte-identical
 *      afterwards.
 *   2. BL-463 no-data-loss: a path whose staged content exists ONLY in the index is held back, not
 *      cleared, and is reported with the blob sha that can read it.
 *   3. BL-463 --force: that path is cleared only on request, and its blob is still readable after.
 *   4. BL-463 liveness: --min-idle-min refuses to clear while another agent is actively staging.
 *   5. BL-463 no-op: a clean index reports nothing and changes nothing.
 *   6. BL-463 the bomb itself: without the teardown, a bare `git commit` reverts committed work —
 *      the failure mode, asserted so it cannot silently change.
 *
 * Usage: node tools/test-bl463-unstage-orphans.mjs
 * Exit 0 iff every assertion holds.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'unstage-orphans.mjs');

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

const sh = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8' });
function run(cwd, args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd, encoding: 'utf8' });
  return { code: r.status ?? 1, out: r.stdout ?? '', err: r.stderr ?? '' };
}
const runJson = (cwd, args) => {
  const r = run(cwd, [...args, '--json']);
  try {
    return { ...r, json: JSON.parse(r.out) };
  } catch {
    return { ...r, json: null };
  }
};

/** A checkout where a departed agent left staged entries behind, exactly as the incidents did. */
function scratchRepo(label) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `bl463-${label}-`)));
  sh(['init', '-q'], dir);
  sh(['config', 'user.email', 'test@test.com'], dir);
  sh(['config', 'user.name', 'test'], dir);
  for (const f of ['BACKLOG.md', 'CHANGELOG.md', 'STATE.md']) {
    fs.writeFileSync(path.join(dir, f), `${f} v1\n`);
  }
  sh(['add', '.'], dir);
  sh(['commit', '-q', '-m', 'chore: initial'], dir);
  return dir;
}

const worktreeSnapshot = (dir) =>
  fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => `${f}:${fs.readFileSync(path.join(dir, f), 'utf8')}`)
    .join('|');

const stagedNames = (dir) => sh(['diff', '--cached', '--name-only'], dir).trim().split('\n').filter(Boolean);

// ---------------------------------------------------------------------------
// Arm 1 — the teardown, on a divergence of the shape the incidents had.
// ---------------------------------------------------------------------------
{
  const dir = scratchRepo('teardown');
  // Departed agent: edited and staged two files, then stopped. HEAD then moved on without them.
  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), 'BACKLOG.md v2-staged-by-departed-agent\n');
  fs.writeFileSync(path.join(dir, 'STATE.md'), 'STATE.md v2-staged-by-departed-agent\n');
  sh(['add', 'BACKLOG.md', 'STATE.md'], dir);
  const wtBefore = worktreeSnapshot(dir);

  const before = stagedNames(dir);
  const r = runJson(dir, ['--apply']);

  report(
    'BL-463: the teardown clears every orphaned index entry to HEAD',
    before.length === 2 && stagedNames(dir).length === 0,
    `before=[${before.join(', ')}] after=[${stagedNames(dir).join(', ')}]`,
  );
  report(
    'BL-463: every working-tree file is BYTE-IDENTICAL after the teardown',
    worktreeSnapshot(dir) === wtBefore,
  );
  report(
    'BL-463: the teardown reports what it cleared, for the orchestrator that ran it',
    r.json?.applied?.length === 2 && r.json.held.length === 0,
    `applied=${JSON.stringify(r.json?.applied)}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Arm 2 — index-only content must NOT be cleared by default. Clearing it would
// discard the only copy of those bytes: a revert bomb turned into data loss.
// ---------------------------------------------------------------------------
{
  const dir = scratchRepo('no-data-loss');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), 'CHANGELOG.md content that exists ONLY in the index\n');
  sh(['add', 'CHANGELOG.md'], dir);
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), 'CHANGELOG.md v1\n'); // worktree rolled back
  const entryBefore = sh(['ls-files', '-s', '--', 'CHANGELOG.md'], dir).trim();

  const r = runJson(dir, ['--apply']);

  report(
    'BL-463: an index-only entry is HELD BACK, not cleared, and stays byte-identical',
    sh(['ls-files', '-s', '--', 'CHANGELOG.md'], dir).trim() === entryBefore &&
      r.json?.applied?.length === 0 &&
      r.json.held.length === 1,
    `held=${JSON.stringify(r.json?.held?.map((h) => h.path))}`,
  );
  report(
    'BL-463: the held path is reported with the blob sha that reads its content back',
    typeof r.json?.held?.[0]?.blob === 'string' &&
      sh(['cat-file', 'blob', r.json.held[0].blob], dir) ===
        'CHANGELOG.md content that exists ONLY in the index\n',
    `blob=${r.json?.held?.[0]?.blob}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Arm 3 — --force clears it, and the content is still recoverable afterwards.
// ---------------------------------------------------------------------------
{
  const dir = scratchRepo('force');
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), 'index-only\n');
  sh(['add', 'CHANGELOG.md'], dir);
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), 'CHANGELOG.md v1\n');
  const blob = sh(['ls-files', '-s', '--', 'CHANGELOG.md'], dir).trim().split(/\s+/)[1];
  const wtBefore = worktreeSnapshot(dir);

  run(dir, ['--apply', '--force']);

  report(
    'BL-463: --force clears the index-only entry, leaves the worktree untouched, and the blob survives',
    stagedNames(dir).length === 0 &&
      worktreeSnapshot(dir) === wtBefore &&
      sh(['cat-file', 'blob', blob], dir) === 'index-only\n',
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Arm 4 — liveness. A live agent's index is being written right now; teardown
// must not race it.
// ---------------------------------------------------------------------------
{
  const dir = scratchRepo('liveness');
  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), 'BACKLOG.md v2\n');
  sh(['add', 'BACKLOG.md'], dir); // just written — the index mtime is now

  const r = runJson(dir, ['--apply', '--min-idle-min', '10']);

  report(
    'BL-463: --min-idle-min refuses to clear while another agent is actively staging',
    stagedNames(dir).length === 1 && /index-active/.test(r.json?.skippedReason ?? ''),
    `skippedReason=${r.json?.skippedReason}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Arm 5 — a clean index is a no-op, and reporting mode never writes.
// ---------------------------------------------------------------------------
{
  const dir = scratchRepo('noop');
  const r = runJson(dir, ['--apply']);
  report(
    'BL-463: a clean shared index is a no-op',
    r.code === 0 && r.json?.divergent.length === 0 && r.json.applied.length === 0,
  );

  fs.writeFileSync(path.join(dir, 'STATE.md'), 'STATE.md v2\n');
  sh(['add', 'STATE.md'], dir);
  const r2 = runJson(dir, []); // no --apply
  report(
    'BL-463: report mode changes nothing',
    r2.json?.divergent.length === 1 && r2.json.applied.length === 0 && stagedNames(dir).length === 1,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Arm 6 — the bomb itself. Without the teardown, the next agent's bare commit
// reverts committed work. This is the incident, reproduced.
// ---------------------------------------------------------------------------
{
  const dir = scratchRepo('bomb');
  // Departed agent stages a version of BACKLOG.md, then stops without committing.
  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), 'BACKLOG.md v1-stale-staged\n');
  sh(['add', 'BACKLOG.md'], dir);

  // HEAD then moves on WITHOUT that entry — committed through a private index, which is how every
  // commit in this repo is made on a contended file (tools/commit-mine.mjs). The shared index is
  // left holding the stale blob: it is now behind HEAD, and nothing says so.
  fs.writeFileSync(path.join(dir, 'BACKLOG.md'), 'BACKLOG.md v2-committed-work\n');
  const privIndex = path.join(dir, '.git', 'bl463-private-index');
  const privEnv = { ...process.env, GIT_INDEX_FILE: privIndex };
  execFileSync('git', ['read-tree', 'HEAD'], { cwd: dir, env: privEnv });
  execFileSync('git', ['add', 'BACKLOG.md'], { cwd: dir, env: privEnv });
  const tree = execFileSync('git', ['write-tree'], { cwd: dir, env: privEnv, encoding: 'utf8' }).trim();
  const commit = execFileSync(
    'git',
    ['commit-tree', tree, '-p', sh(['rev-parse', 'HEAD'], dir).trim(), '-m', 'docs: real work'],
    { cwd: dir, encoding: 'utf8' },
  ).trim();
  sh(['update-ref', 'refs/heads/' + sh(['rev-parse', '--abbrev-ref', 'HEAD'], dir).trim(), commit], dir);
  fs.rmSync(privIndex, { force: true });

  // The next agent, who has never seen any of this, stages its own file and bare-commits.
  fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), 'CHANGELOG.md v2\n');
  sh(['add', 'CHANGELOG.md'], dir);
  sh(['commit', '-q', '-m', 'docs: the next agent bare-commits'], dir); // the detonation

  report(
    'BL-463: without the teardown, a bare `git commit` reverts committed work (the failure mode)',
    sh(["show", "HEAD:BACKLOG.md"], dir) === "BACKLOG.md v1-stale-staged\n",
    `HEAD:BACKLOG.md=${JSON.stringify(sh(['show', 'HEAD:BACKLOG.md'], dir))}`,
  );
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(
  failed === 0 ? '\nAll BL-463 assertions passed.' : `\n${failed} BL-463 assertion(s) FAILED.`,
);
process.exit(failed === 0 ? 0 : 1);
