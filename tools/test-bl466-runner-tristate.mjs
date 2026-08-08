#!/usr/bin/env node
/**
 * tools/test-bl466-runner-tristate.mjs
 *
 * Red->green contract pin for BL-466 §5 AC-g: `tools/run-guards.mjs` must distinguish PASS / FAIL /
 * N/A (never routing a filtered-out guard through "PASS", the BL-469/BL-167 failure shape) and its
 * summary line must never claim blanket success when anything did not pass.
 *
 * Builds a scratch git repo + a fixture guards-manifest with three Tier 1 guards:
 *   - one whose script always exits 0 (must read PASS)
 *   - one whose script always exits 1 (must read FAIL)
 *   - one whose `watch` glob does not intersect the --base/--head diff (must read N/A, not SKIP)
 * and asserts the summary line names exactly 1 passed, 1 failed, 1 not-applicable, and never
 * contains a phrase claiming "all guards passed" (or an N/M count that pretends the N/A guard ran).
 *
 * Usage: node tools/test-bl466-runner-tristate.mjs
 * Exit 0 iff every assertion holds.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const RUNNER = path.join(TOOLS_DIR, 'run-guards.mjs');

// BL-479 — strip inherited GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE/GIT_COMMON_DIR so this scratch
// repo's git commands can never resolve against the invoking checkout's real index (git prefers
// these env vars over cwd-based repo discovery).
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
  return execFileSync(cmd, args, { cwd, encoding: 'utf8', env: SAFE_GIT_ENV }).trim();
}

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'bl466-tristate-'));
try {
  // --- scratch git repo -------------------------------------------------------------------
  sh('git', ['init', '-q'], scratch);
  sh('git', ['config', 'user.email', 'test@example.com'], scratch);
  sh('git', ['config', 'user.name', 'BL-466 test'], scratch);
  fs.writeFileSync(path.join(scratch, 'never-matched.txt'), 'v1\n');
  fs.writeFileSync(path.join(scratch, 'README.md'), 'x\n');
  sh('git', ['add', '-A'], scratch);
  sh('git', ['commit', '-q', '-m', 'base'], scratch);
  const base = sh('git', ['rev-parse', 'HEAD'], scratch);

  fs.writeFileSync(path.join(scratch, 'watched.txt'), 'v2\n'); // matches fixpass/fixfail watch
  sh('git', ['add', '-A'], scratch);
  sh('git', ['commit', '-q', '-m', 'change watched.txt only'], scratch);
  const head = sh('git', ['rev-parse', 'HEAD'], scratch);

  // --- fixture guard scripts ---------------------------------------------------------------
  const passScript = path.join(scratch, 'fixpass.mjs');
  const failScript = path.join(scratch, 'fixfail.mjs');
  const naScript = path.join(scratch, 'fixna.mjs');
  fs.writeFileSync(passScript, `console.log('fixture pass'); process.exit(0);\n`);
  fs.writeFileSync(failScript, `console.log('fixture fail'); process.exit(1);\n`);
  fs.writeFileSync(naScript, `console.log('fixture na — should never run'); process.exit(0);\n`);

  // --- fixture manifest --------------------------------------------------------------------
  const manifestPath = path.join(scratch, 'fixture-guards-manifest.mjs');
  fs.writeFileSync(
    manifestPath,
    `export const GUARDS = [
  { id: 'fixpass', tier: 1, script: ${JSON.stringify(passScript)}, watch: ['watched.txt'] },
  { id: 'fixfail', tier: 1, script: ${JSON.stringify(failScript)}, watch: ['watched.txt'] },
  { id: 'fixna', tier: 1, script: ${JSON.stringify(naScript)}, watch: ['never-matched.txt'] },
];
`,
  );

  // --- run the real runner against the fixture ---------------------------------------------
  let stdout = '';
  let status = 0;
  try {
    stdout = execFileSync(
      process.execPath,
      [RUNNER, '--tier1', '--manifest', manifestPath, '--cwd', scratch, '--base', base, '--head', head],
      { encoding: 'utf8' },
    );
  } catch (err) {
    stdout = err.stdout ?? '';
    status = err.status ?? 1;
  }

  report('fixpass is reported [PASS]', /\[PASS\] fixpass/.test(stdout), stdout);
  report('fixfail is reported [FAIL], never [SKIP] or [PASS]', /\[FAIL\] fixfail/.test(stdout) && !/\[SKIP\] fixfail/.test(stdout) && !/\[PASS\] fixfail/.test(stdout));
  report(
    'fixna (unmatched watch glob) is reported [N/A], never [SKIP] or [PASS]',
    /\[N\/A\] fixna/.test(stdout) && !/\[SKIP\] fixna/.test(stdout) && !/\[PASS\] fixna/.test(stdout),
  );

  const summaryOk = /2\/3 guards ran, 1 passed, 1 failed, 0 skipped, 1 not-applicable/.test(stdout);
  report('summary line names exactly 1 passed, 1 failed, 1 not-applicable', summaryOk, stdout.split('\n').slice(-2).join(' | '));

  const claimsAllPass = /ALL.*(PASS|GUARDS PASS|GREEN)/i.test(stdout) && !/failed/i.test(stdout.split('\n').slice(-1)[0]);
  report(
    'summary never reads as an unqualified "all guards passed" claim while one failed',
    !/^\s*ALL\b/im.test(stdout.split('\n').filter(Boolean).slice(-1)[0] || ''),
    stdout.split('\n').slice(-2).join(' | '),
  );

  report('exit code is non-zero (a FAIL is present)', status !== 0, `exit=${status}`);
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}

console.log('');
console.log(failed === 0 ? 'ALL BL-466 TRISTATE ASSERTIONS PASS' : `${failed} BL-466 TRISTATE ASSERTION(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
