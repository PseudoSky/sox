#!/usr/bin/env node
/**
 * tools/test-bl407-preflight-scoping.mjs
 *
 * Red->green contract pin for BL-407: `scripts/smoke-test.mjs`'s BL-266
 * exports-contract preflight (publint + attw) used to run unconditionally
 * against the WHOLE workspace, even when `--extension <id>` narrowed the
 * run to a single project. A broken `package.json` anywhere in the other 40
 * workspace projects — including ones the filter explicitly excludes —
 * FATALed a run that never touched them. In a shared, non-worktree checkout
 * with concurrent agents, any one agent's in-flight `workspace:*` edit could
 * wedge every other agent's ability to run even a scoped smoke pass
 * (observed live: PKT-15/BL-259 was blocked exactly this way).
 *
 * The fix is `--only <dir>` (repeatable) on
 * `tools/verify-exports-publint-attw.mjs`, which `smoke-test.mjs` now
 * computes from the filtered extension + its bundle siblings + its
 * transitive nx workspace dependencies (see `computePreflightOnlyDirs` in
 * smoke-test.mjs). This script pins the CORE of that fix — the `--only`
 * filtering itself — against a disposable scratch "workspace" with one
 * intentionally broken package, independent of the real monorepo's nx graph
 * (that end-to-end path was verified live against the real repo; see the
 * BL-407 CHANGELOG entry for the transcript).
 *
 * Both halves of the acceptance are required — a fix that merely stops
 * failing would have removed the gate rather than scoped it:
 *
 *   1. RED (unfiltered): `verify-exports-publint-attw.mjs --root <scratch>`
 *      (no --only) FATALs on the broken package. This is the existing,
 *      never-weakened full-workspace merge gate.
 *   2. GREEN (scoped): the SAME broken package present, but
 *      `--only <scratch>/libs/good-pkg` (the "filtered extension") passes
 *      cleanly — the broken package is out of scope and never touched.
 *
 * Usage: node tools/test-bl407-preflight-scoping.mjs
 * Exit 0 iff both scenarios behave as BL-407 predicts.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERIFY_SCRIPT = path.join(HERE, 'verify-exports-publint-attw.mjs');
const REAL_REPO_ROOT = path.resolve(HERE, '..');

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

function writePkg(dir, pkg) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
}

function makeScratchWorkspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bl407-scratch-'));

  // verify-exports-publint-attw.mjs resolves its publint/attw BINARIES relative
  // to `--root` (repoRoot() feeds BIN()), so a scratch root needs a real
  // node_modules to find them — symlink the real repo's rather than installing
  // a second copy.
  fs.symlinkSync(path.join(REAL_REPO_ROOT, 'node_modules'), path.join(root, 'node_modules'));

  // A genuinely valid package — this is the stand-in for "the extension the
  // filtered smoke run actually targets".
  const goodDir = path.join(root, 'libs', 'good-pkg');
  fs.mkdirSync(path.join(goodDir, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(goodDir, 'dist', 'index.js'), 'module.exports = {};\n');
  writePkg(goodDir, {
    name: '@bl407-fixture/good-pkg',
    version: '0.0.0',
    private: true,
    main: 'dist/index.js',
  });

  // A DELIBERATELY BROKEN package, unrelated to good-pkg (no dependency edge,
  // and outside good-pkg's own dir) — the exact "unrelated project" shape
  // BL-407 describes. `main` points at a file that does not exist, which is
  // publint's own documented RED fixture (see verify-exports-publint-attw.mjs
  // header comment).
  const badDir = path.join(root, 'tools', 'bad-pkg');
  writePkg(badDir, {
    name: '@bl407-fixture/bad-pkg',
    version: '0.0.0',
    private: true,
    main: 'dist/does-not-exist.js',
  });

  return { root, goodDir, badDir };
}

function runVerify(args) {
  try {
    execFileSync('node', [VERIFY_SCRIPT, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, output: '' };
  } catch (e) {
    return { code: e.status ?? 1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const { root, goodDir, badDir } = makeScratchWorkspace();

try {
  // ---------------------------------------------------------------------
  // 1. RED — unfiltered run still FATALs on the broken package. The
  //    full-workspace merge gate must be UNCHANGED by this fix.
  // ---------------------------------------------------------------------
  {
    const r = runVerify(['--root', root]);
    report(
      'unfiltered run FATALs on the broken package (full merge gate unchanged)',
      r.code !== 0 && r.output.includes('bad-pkg'),
      `exit=${r.code}`,
    );
  }

  // ---------------------------------------------------------------------
  // 2. GREEN — a run scoped to ONLY the good package (the "filtered
  //    --extension" case) passes cleanly, despite the broken package still
  //    sitting in the same workspace.
  // ---------------------------------------------------------------------
  {
    const r = runVerify(['--root', root, '--only', goodDir]);
    report(
      'scoped run (--only good-pkg) passes despite the unrelated broken package',
      r.code === 0 && !r.output.includes('bad-pkg'),
      `exit=${r.code}`,
    );
  }

  // ---------------------------------------------------------------------
  // 3. A --only dir scoped to the BAD package itself must still fail — the
  //    filter narrows scope, it does not launder a package that IS in scope.
  // ---------------------------------------------------------------------
  {
    const r = runVerify(['--root', root, '--only', badDir]);
    report(
      'scoped run (--only bad-pkg) still FATALs — scoping never launders an in-scope violation',
      r.code !== 0 && r.output.includes('bad-pkg'),
      `exit=${r.code}`,
    );
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failed === 0 ? '\nAll BL-407 assertions passed.' : `\n${failed} BL-407 assertion(s) FAILED.`);
process.exit(failed === 0 ? 0 : 1);
