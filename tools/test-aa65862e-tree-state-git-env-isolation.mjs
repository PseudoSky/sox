#!/usr/bin/env node
/**
 * tools/test-aa65862e-tree-state-git-env-isolation.mjs
 *
 * Red->green contract pin for aa65862e: `git status --porcelain` always reads
 * `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_WORK_TREE`/`GIT_COMMON_DIR` over `cwd`-based repo discovery
 * whenever any of them is set. `tools/check-suite-tree-state.mjs` commonly runs from
 * `.husky/pre-commit`, which has already set `GIT_INDEX_FILE` to the in-progress commit's
 * `next-index-<pid>.lock` (and, transitively via nested tool invocations, `GIT_DIR`/
 * `GIT_COMMON_DIR` can be inherited too) — silently redirecting `git status` away from `cwd`
 * entirely and onto the ENCLOSING process's repo/index instead of the one this tool was asked to
 * report on. `porcelainOver()`'s own `gitEnv()` helper strips all four unconditionally before
 * every spawned `git` call specifically to close this hole.
 *
 * This guard does NOT depend on any pinned git revision as its negative control (a commit hash
 * pin ages — the object can eventually go unreachable and get pruned). Instead it reproduces the
 * "stripping disabled" condition directly: Arm 1 shells out to `git status --porcelain` itself,
 * WITHOUT stripping the polluted env, to show raw git's behavior under inheritance is wrong for
 * this tool's purposes. Arms 2-3 then exercise the actual shipped `porcelainOver()`/`buildReport()`
 * under the exact same polluted environment and show they are unaffected — the mechanism gitEnv()
 * is supposed to guarantee.
 *
 * The "different repo" GIT_DIR/GIT_INDEX_FILE pollution is a SECOND throwaway scratch repo, never
 * this checkout's own live `.git`. `git status` can rewrite its target index with refreshed stat
 * cache data even in read paths, and this checkout's real `.git/index` is the SAME shared index
 * every other guard, the pre-commit hook, and concurrent agents write through — Tier 1's whole
 * promise is that it is safe to run in the invoking checkout. Pointing at it (even read-mostly)
 * would violate that promise for no reason: a second scratch repo reproduces the exact bug shape
 * (GIT_DIR/GIT_INDEX_FILE resolving to a repo other than `cwd`'s) with zero shared-state risk.
 *
 * Arms:
 *   1. RED — a raw `git status --porcelain` call that inherits `GIT_DIR`/`GIT_INDEX_FILE` pointed
 *      at a DIFFERENT real (scratch) repo does NOT correctly report a dirty file in the repo under
 *      test. This is the failure `gitEnv()` exists to prevent, and confirms the polluted env
 *      fixture actually reproduces the bug rather than being a no-op.
 *   2. GREEN — `porcelainOver()` under the SAME polluted `process.env` correctly reports the dirty
 *      file anyway (its internal `gitEnv()` strips the inherited vars before spawning `git`).
 *   3. GREEN — `buildReport()` (the function `main()` actually calls) shows the same, end to end.
 *
 * Uses two throwaway scratch git repos (fs.mkdtempSync) — never the invoking checkout's real tree
 * — wrapped in try/finally so both temp dirs and any env mutation are always restored, including
 * on assertion or git-command failure.
 *
 * Usage: node tools/test-aa65862e-tree-state-git-env-isolation.mjs
 * Exit 0 iff every assertion holds.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(TOOLS, 'check-suite-tree-state.mjs');

// Strip inherited GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE/GIT_COMMON_DIR before any SETUP git call
// this guard itself makes (it may be invoked from the real pre-commit hook) — same rationale as
// every other guard in this family (BL-479).
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

const mod = await import(`file://${TOOL}`);

const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa65862e-')));
// A SECOND throwaway scratch repo to be the "different repo" GIT_DIR/GIT_INDEX_FILE points at —
// never this checkout's own live `.git` (see the file-header note on why).
const foreignDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aa65862e-foreign-')));
const savedEnv = { ...process.env };
try {
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', env: SAFE_GIT_ENV });
  git(['init', '-q']);
  git(['config', 'user.email', 'test@test.com']);
  git(['config', 'user.name', 'test']);
  fs.mkdirSync(path.join(dir, 'lib/src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'lib/src/index.ts'), 'export const x = 1;\n');
  git(['add', '.']);
  git(['commit', '-q', '-m', 'chore: initial']);
  fs.writeFileSync(path.join(dir, 'lib/src/index.ts'), 'export const x = 2;\n');

  const foreignGit = (args) =>
    execFileSync('git', args, { cwd: foreignDir, encoding: 'utf8', env: SAFE_GIT_ENV });
  foreignGit(['init', '-q']);
  foreignGit(['config', 'user.email', 'test@test.com']);
  foreignGit(['config', 'user.name', 'test']);
  fs.writeFileSync(path.join(foreignDir, 'unrelated.txt'), 'nothing to do with the repo under test\n');
  foreignGit(['add', '.']);
  foreignGit(['commit', '-q', '-m', 'chore: unrelated foreign repo']);

  const foreignGitDir = path
    .resolve(foreignDir, foreignGit(['rev-parse', '--git-common-dir']).trim());
  const foreignIndexFile = path.join(foreignGitDir, 'index');
  if (!fs.existsSync(foreignIndexFile)) {
    report(
      'aa65862e: setup — a foreign scratch repo GIT_DIR/index is available to pollute the environment with',
      false,
      `expected an index file at ${foreignIndexFile}`,
    );
  }

  const graph = {
    nodes: { app: { data: { sourceRoot: 'lib/src', root: 'lib' } } },
    dependencies: { app: [] },
  };

  // Pollute process.env with the foreign scratch repo's GIT_DIR/GIT_INDEX_FILE — simulating the
  // real aa65862e scenario (an enclosing git process, e.g. the pre-commit hook, having already
  // set these before this tool's own `git` subprocesses run).
  for (const k of ['GIT_DIR', 'GIT_INDEX_FILE', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete process.env[k];
  process.env.GIT_DIR = foreignGitDir;
  process.env.GIT_INDEX_FILE = foreignIndexFile;

  try {
    // Arm 1 [RED] — raw git, no gitEnv() stripping: inherits the polluted env as-is.
    let rawOut;
    let rawThrew = null;
    try {
      rawOut = execFileSync('git', ['status', '--porcelain', '--', 'lib'], {
        cwd: dir,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        // deliberately NOT passing an `env` override here — this is the exact shape
        // `porcelainOver()` had before gitEnv() existed (see the historical fix at
        // tools/check-suite-tree-state.mjs's `[28f22e8d]` gitEnv() comment).
      }).split('\n').filter(Boolean);
    } catch (e) {
      rawThrew = e;
      rawOut = [];
    }
    const rawCorrect = !rawThrew && rawOut.some((l) => l.includes('lib/src/index.ts'));
    report(
      'aa65862e RED: raw `git status` WITHOUT gitEnv() stripping does NOT correctly report the ' +
        'scratch repo dirty file when GIT_DIR/GIT_INDEX_FILE are inherited from a different repo',
      !rawCorrect,
      rawThrew ? `threw: ${rawThrew.message.split('\n')[0]}` : `dirty=${JSON.stringify(rawOut)}`,
    );

    // Arm 2 [GREEN] — the shipped porcelainOver(), same polluted process.env, gitEnv() strips it.
    const fixedDirty = mod.porcelainOver(['lib'], dir);
    const fixedCorrect = fixedDirty.some((l) => l.includes('lib/src/index.ts'));
    report(
      'aa65862e GREEN: porcelainOver() (gitEnv() stripping restored) correctly reports the ' +
        'scratch repo dirty file under the SAME inherited GIT_DIR/GIT_INDEX_FILE pollution',
      fixedCorrect,
      `dirty=${JSON.stringify(fixedDirty)}`,
    );

    // Arm 3 [GREEN] — buildReport(), the exact function main() calls, end to end.
    const rep = mod.buildReport(graph, 'app', dir);
    const repCorrect = rep.dirty.some((l) => l.includes('lib/src/index.ts'));
    report(
      'aa65862e GREEN: buildReport() (the function main() uses) also correctly reports the ' +
        'scratch repo dirty file under the SAME inherited GIT_DIR/GIT_INDEX_FILE pollution',
      repCorrect,
      `dirty=${JSON.stringify(rep.dirty)}`,
    );
  } finally {
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(foreignDir, { recursive: true, force: true });
}

console.log(
  failed === 0
    ? '\nAll aa65862e assertions passed.'
    : `\n${failed} aa65862e assertion(s) FAILED.`,
);
process.exit(failed === 0 ? 0 : 1);
