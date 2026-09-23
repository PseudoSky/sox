#!/usr/bin/env node
/**
 * tools/test-fc2735f0-precommit-lint-scope.mjs
 *
 * Red->green contract pin for fc2735f0: `.husky/pre-commit:69` used to lint
 * `--base=HEAD~1 --head=HEAD` (the PREVIOUS commit's blast radius), never the staged change.
 * `tools/precommit-lint.mjs` fixes this by deriving `nx affected -t lint --files=<staged set>`
 * from `git diff --cached --name-only --no-renames -z`, honoring whatever index git handed the
 * hook (a pathspec commit's private next-index, F10 in the spec).
 *
 * This test can run against EITHER the fix-in-place script (green, default) OR a copy of the
 * pre-fix hook (red) via PRECOMMIT_LINT_SCRIPT_PATH env override, so the same assertions serve
 * as the red->green pin required by BL-225.
 *
 * BL-479 — every git call this fixture makes strips GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE/
 * GIT_COMMON_DIR so it can never resolve against the invoking checkout's real index.
 *
 * Usage: node tools/test-fc2735f0-precommit-lint-scope.mjs
 * Exit 0 iff every assertion holds.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(TOOLS_DIR, '..');
const SCRIPT_UNDER_TEST = process.env.PRECOMMIT_LINT_SCRIPT_PATH
  ? path.resolve(process.env.PRECOMMIT_LINT_SCRIPT_PATH)
  : path.join(TOOLS_DIR, 'precommit-lint.mjs');
const SCRIPT_EXISTS = fs.existsSync(SCRIPT_UNDER_TEST);

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

const SAFE_GIT_ENV = { ...process.env };
delete SAFE_GIT_ENV.GIT_DIR;
delete SAFE_GIT_ENV.GIT_INDEX_FILE;
delete SAFE_GIT_ENV.GIT_WORK_TREE;
delete SAFE_GIT_ENV.GIT_COMMON_DIR;
// `git -c key=val` (as used to invoke this very fixture's own outer commit, e.g.
// `git -c core.hooksPath=...`) propagates via GIT_CONFIG_COUNT/GIT_CONFIG_KEY_N/
// GIT_CONFIG_VALUE_N / GIT_CONFIG_PARAMETERS env vars — inherited by every child git process
// unless stripped. Without this, a scratch repo's own `git commit` here would run the OUTER
// repo's hooksPath against the scratch repo's cwd (discovered while red/green-testing this
// fixture: `git commit -q -m base` failed with `Cannot find module '.../tools/check-amend-
// shared-index.mjs'` because it tried to run the real worktree's hook from inside a scratch
// tmp dir).
for (const key of Object.keys(SAFE_GIT_ENV)) {
  if (/^GIT_CONFIG/.test(key)) delete SAFE_GIT_ENV[key];
}

function sh(args, cwd, env = SAFE_GIT_ENV) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env }).trim();
}

function initRepo(label) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `fc2735f0-${label}-`)));
  sh(['init', '-q'], dir);
  sh(['config', 'user.email', 'test@example.com'], dir);
  sh(['config', 'user.name', 'fc2735f0 test'], dir);
  return dir;
}

function writeFile(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Real hook, real script, a stub `npx` first on PATH that logs its argv. */
function installFixtureHook(dir, npxLogPath) {
  fs.mkdirSync(path.join(dir, '.git', 'hooks'), { recursive: true });
  const npxLogPathJson = JSON.stringify(npxLogPath);
  const stubNpx = path.join(dir, 'bin', 'npx');
  fs.mkdirSync(path.dirname(stubNpx), { recursive: true });
  fs.writeFileSync(
    stubNpx,
    `#!/usr/bin/env node
import * as fs from 'node:fs';
const argv = process.argv.slice(2);
fs.appendFileSync(${npxLogPathJson}, JSON.stringify(argv) + '\\n');
process.exit(0);
`,
  );
  fs.chmodSync(stubNpx, 0o755);

  const toolsDir = path.join(dir, 'tools');
  fs.mkdirSync(toolsDir, { recursive: true });
  fs.copyFileSync(SCRIPT_UNDER_TEST, path.join(toolsDir, 'precommit-lint.mjs'));

  const hookPath = path.join(dir, '.git', 'hooks', 'pre-commit');
  fs.writeFileSync(
    hookPath,
    `#!/bin/sh
set -e
node tools/precommit-lint.mjs
`,
  );
  fs.chmodSync(hookPath, 0o755);
}

function envWithStubNpx(dir) {
  const stubBinDir = path.join(dir, 'bin');
  return { ...SAFE_GIT_ENV, PATH: `${stubBinDir}${path.delimiter}${SAFE_GIT_ENV.PATH || ''}` };
}

function commitAllowVerify(dir, msg, pathspec) {
  const args = ['commit', '-m', msg];
  if (pathspec) args.push('--', ...pathspec);
  return spawnSync('git', args, { cwd: dir, encoding: 'utf8', env: envWithStubNpx(dir) });
}

function commitNoVerify(dir, msg) {
  sh(['commit', '-q', '--no-verify', '-m', msg], dir);
}

function readLog(logPath) {
  if (!fs.existsSync(logPath)) return [];
  return fs
    .readFileSync(logPath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

if (!SCRIPT_EXISTS) {
  report(
    'fc2735f0: tools/precommit-lint.mjs exists',
    false,
    `not found at ${SCRIPT_UNDER_TEST} — this is the expected RED state before the fix lands`,
  );
} else {
  // -------------------------------------------------------------------------------------------
  // Case A — normal commit: only the staged file is linted, never HEAD's prior commit's files.
  // -------------------------------------------------------------------------------------------
  {
    const dir = initRepo('a');
    const npxLog = path.join(dir, 'npx.log');
    writeFile(dir, 'libs/x/a.ts', 'export const a = 1;\n');
    sh(['add', '-A'], dir);
    commitNoVerify(dir, 'commit 1: libs/x/a.ts');
    installFixtureHook(dir, npxLog);
    writeFile(dir, 'libs/y/b.ts', 'export const b = 1;\n');
    sh(['add', 'libs/y/b.ts'], dir);
    fs.writeFileSync(npxLog, '');
    const res = commitAllowVerify(dir, 'commit 2: libs/y/b.ts', null);
    const entries = readLog(npxLog);
    report('fc2735f0 Case A: exactly one nx invocation', entries.length === 1, JSON.stringify(entries));
    const argv = entries[0] || [];
    const joined = argv.join(' ');
    report('fc2735f0 Case A: argv includes --files=libs/y/b.ts', joined.includes('--files=libs/y/b.ts'), joined);
    report('fc2735f0 Case A: argv contains no --base', !joined.includes('--base'), joined);
    report('fc2735f0 Case A: argv contains no HEAD~1', !joined.includes('HEAD~1'), joined);
    report('fc2735f0 Case A: argv contains no libs/x (prior commit)', !joined.includes('libs/x'), joined);
    report('fc2735f0 Case A: hook commit itself succeeded', res.status === 0, `exit=${res.status} stderr=${res.stderr}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------------------------
  // Case B — pathspec commit: only the committed path is linted, not another agent's staged entry.
  // -------------------------------------------------------------------------------------------
  {
    const dir = initRepo('b');
    const npxLog = path.join(dir, 'npx.log');
    writeFile(dir, 'libs/y/d.ts', 'export const d = 1;\n');
    sh(['add', '-A'], dir);
    commitNoVerify(dir, 'commit 1: libs/y/d.ts');
    installFixtureHook(dir, npxLog);
    writeFile(dir, 'libs/y/d.ts', 'export const d = 2;\n');
    writeFile(dir, 'libs/x/c.ts', 'export const c = 1;\n'); // "another agent's" staged entry
    sh(['add', 'libs/x/c.ts', 'libs/y/d.ts'], dir);
    fs.writeFileSync(npxLog, '');
    const res = commitAllowVerify(dir, 'pathspec commit: libs/y/d.ts only', ['libs/y/d.ts']);
    const entries = readLog(npxLog);
    report('fc2735f0 Case B: exactly one nx invocation', entries.length === 1, JSON.stringify(entries));
    const joined = (entries[0] || []).join(' ');
    report('fc2735f0 Case B: argv is --files=libs/y/d.ts only', joined.includes('--files=libs/y/d.ts'), joined);
    report('fc2735f0 Case B: argv excludes libs/x/c.ts (other agent)', !joined.includes('libs/x/c.ts'), joined);
    report('fc2735f0 Case B: hook commit itself succeeded', res.status === 0, `exit=${res.status} stderr=${res.stderr}`);
    // c.ts must still be staged after the pathspec commit landed.
    const stillStaged = sh(['diff', '--cached', '--name-only'], dir);
    report('fc2735f0 Case B: libs/x/c.ts remains staged after commit', stillStaged.includes('libs/x/c.ts'), stillStaged);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------------------------
  // Case C — empty commit: no nx invocation at all.
  // -------------------------------------------------------------------------------------------
  {
    const dir = initRepo('c');
    const npxLog = path.join(dir, 'npx.log');
    writeFile(dir, 'README.md', 'x\n');
    sh(['add', '-A'], dir);
    commitNoVerify(dir, 'commit 1');
    installFixtureHook(dir, npxLog);
    fs.writeFileSync(npxLog, '');
    const res = commitAllowVerify(dir, 'empty commit', null);
    // --allow-empty needs the flag; retry properly.
    const res2 = spawnSync('git', ['commit', '--allow-empty', '-m', 'empty commit 2'], {
      cwd: dir,
      encoding: 'utf8',
      env: envWithStubNpx(dir),
    });
    const entries = readLog(npxLog);
    report('fc2735f0 Case C: --allow-empty commit produces no nx invocation', entries.length === 0, JSON.stringify(entries));
    report('fc2735f0 Case C: --allow-empty commit itself succeeded', res2.status === 0, `exit=${res2.status} stderr=${res2.stderr}`);
    void res;
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------------------------
  // Case D — rename: both old and new paths appear in --files (--no-renames).
  // -------------------------------------------------------------------------------------------
  {
    const dir = initRepo('d');
    const npxLog = path.join(dir, 'npx.log');
    writeFile(dir, 'libs/y/b.ts', 'export const b = 1;\n'.repeat(20));
    sh(['add', '-A'], dir);
    commitNoVerify(dir, 'commit 1: libs/y/b.ts');
    installFixtureHook(dir, npxLog);
    fs.mkdirSync(path.join(dir, 'libs', 'z'), { recursive: true });
    fs.renameSync(path.join(dir, 'libs', 'y', 'b.ts'), path.join(dir, 'libs', 'z', 'b.ts'));
    sh(['add', '-A'], dir);
    fs.writeFileSync(npxLog, '');
    const res = commitAllowVerify(dir, 'rename libs/y/b.ts -> libs/z/b.ts', null);
    const entries = readLog(npxLog);
    const joined = (entries[0] || []).join(' ');
    report('fc2735f0 Case D: rename commit produced one nx invocation', entries.length === 1, JSON.stringify(entries));
    report('fc2735f0 Case D: --files includes old path libs/y/b.ts', joined.includes('libs/y/b.ts'), joined);
    report('fc2735f0 Case D: --files includes new path libs/z/b.ts', joined.includes('libs/z/b.ts'), joined);
    report('fc2735f0 Case D: hook commit itself succeeded', res.status === 0, `exit=${res.status} stderr=${res.stderr}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------------------------
  // Case E — fresh repo's first commit succeeds (no HEAD~1 to diff against).
  // -------------------------------------------------------------------------------------------
  {
    const dir = initRepo('e');
    const npxLog = path.join(dir, 'npx.log');
    installFixtureHook(dir, npxLog);
    writeFile(dir, 'README.md', 'x\n');
    sh(['add', '-A'], dir);
    fs.writeFileSync(npxLog, '');
    const res = commitAllowVerify(dir, 'first commit ever', null);
    report('fc2735f0 Case E: first commit of a fresh repo succeeds', res.status === 0, `exit=${res.status} stderr=${res.stderr}`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

console.log('');
console.log(failed === 0 ? 'ALL fc2735f0 ASSERTIONS PASS' : `${failed} fc2735f0 ASSERTION(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
