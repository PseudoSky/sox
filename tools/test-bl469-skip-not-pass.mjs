#!/usr/bin/env node
/**
 * tools/test-bl469-skip-not-pass.mjs
 *
 * Red->green contract pin for BL-469: `tools/test-bl266-bundle-invariants.mjs` gates its (c)
 * atomicity, (d) typecheck and (e) checksum-stability arms on --build-cmd/--source/--rebuild-cmd.
 * When those flags are absent the old script called report(name, true, '(skipped — ...)') — i.e.
 * it printed [PASS] for an invariant it never executed — and then printed
 * "ALL 5 INVARIANTS PASS" having actually verified only 2 of them. This is the BL-167 shape: a
 * guard whose skipped case is silently counted as verified.
 *
 * This test spawns the real tool (tools/test-bl266-bundle-invariants.mjs) against a synthetic
 * fixture dist/ directory WITHOUT the gating flags, and asserts:
 *   1. Arms (c), (d), (e) are printed as [SKIP], never [PASS].
 *   2. The summary line never claims "ALL 5 INVARIANTS PASS" when any arm was skipped.
 *   3. The exit code is non-zero by default (a skip is not a tolerated outcome — BL-466's
 *      "a guard the harness does not execute must fail the run").
 *   4. --allow-skip flips the exit code to 0 without changing what was printed (skip is still
 *      reported honestly; only the caller's tolerance changes).
 *
 * Usage: node tools/test-bl469-skip-not-pass.mjs
 * Exit 0 iff every assertion holds.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = path.dirname(fileURLToPath(import.meta.url));
const TOOL = path.join(TOOLS, 'test-bl266-bundle-invariants.mjs');

let failed = 0;
function report(name, ok, detail) {
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failed++;
}

// ---------------------------------------------------------------------------
// Fixture: a minimal self-contained "dist/" that (a) and (b) will pass against,
// so any failure/skip signal we observe below is attributable to the (c)/(d)/(e)
// gating logic under test, not to unrelated fixture noise.
// ---------------------------------------------------------------------------
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bl469-fixture-'));
try {
  fs.writeFileSync(path.join(fixtureDir, 'index.js'), 'module.exports = {};\n');

  function run(extraArgs) {
    try {
      const stdout = execFileSync(
        process.execPath,
        [TOOL, '--outdir', fixtureDir, '--externals', '', ...extraArgs],
        { encoding: 'utf8' },
      );
      return { stdout, status: 0 };
    } catch (err) {
      return { stdout: err.stdout ?? '', status: err.status ?? 1 };
    }
  }

  // -------------------------------------------------------------------------
  // Arm 1 — without gating flags, (c)/(d)/(e) print [SKIP], never [PASS].
  // -------------------------------------------------------------------------
  const noFlags = run([]);
  const skipLines = ['(c) atomic never-destroy', '(d) typecheck gate', '(e) checksum stability'];
  for (const name of skipLines) {
    const skipRe = new RegExp(`\\[SKIP\\] ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    const passRe = new RegExp(`\\[PASS\\] ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    report(
      `BL-469: "${name}" is reported [SKIP] (not [PASS]) when its gating flags are absent`,
      skipRe.test(noFlags.stdout) && !passRe.test(noFlags.stdout),
      skipRe.test(noFlags.stdout) ? 'found [SKIP] line, no [PASS] line' : `stdout=${JSON.stringify(noFlags.stdout)}`,
    );
  }

  // -------------------------------------------------------------------------
  // Arm 2 — the summary line never claims all 5 passed when some were skipped.
  // -------------------------------------------------------------------------
  const claimsAllPass = /ALL 5 INVARIANTS PASS/.test(noFlags.stdout);
  report(
    'BL-469: summary does NOT print "ALL 5 INVARIANTS PASS" when 3 invariants were skipped',
    !claimsAllPass,
    claimsAllPass ? 'REGRESSION: summary line falsely claims all 5 passed' : 'summary correctly reports partial verification',
  );
  const summaryReflectsReality = /2\/5 INVARIANTS VERIFIED PASS, 3\/5 SKIPPED/.test(noFlags.stdout);
  report(
    'BL-469: summary states exactly what was verified (2/5 pass, 3/5 skipped)',
    summaryReflectsReality,
    `stdout tail=${JSON.stringify(noFlags.stdout.split('\n').slice(-3).join('\n'))}`,
  );

  // -------------------------------------------------------------------------
  // Arm 3 — exit code is non-zero by default when arms were skipped (loud by default).
  // -------------------------------------------------------------------------
  report(
    'BL-469: exit code is non-zero by default when invariants were skipped (skip is not a free pass)',
    noFlags.status !== 0,
    `exit=${noFlags.status}`,
  );

  // -------------------------------------------------------------------------
  // Arm 4 — --allow-skip opts into exit 0 without changing what was printed.
  // -------------------------------------------------------------------------
  const withAllowSkip = run(['--allow-skip']);
  report(
    'BL-469: --allow-skip flips exit code to 0 when nothing actually failed',
    withAllowSkip.status === 0,
    `exit=${withAllowSkip.status}`,
  );
  const allowSkipStillHonest = skipLines.every((name) => {
    const skipRe = new RegExp(`\\[SKIP\\] ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
    return skipRe.test(withAllowSkip.stdout);
  }) && !/ALL 5 INVARIANTS PASS/.test(withAllowSkip.stdout);
  report(
    'BL-469: --allow-skip does not change what was reported — still [SKIP], still no false "ALL 5" claim',
    allowSkipStillHonest,
    allowSkipStillHonest ? 'reporting unchanged by --allow-skip' : `stdout=${JSON.stringify(withAllowSkip.stdout)}`,
  );
} finally {
  fs.rmSync(fixtureDir, { recursive: true, force: true });
}

console.log('');
console.log(failed === 0 ? 'ALL BL-469 ASSERTIONS PASS' : `${failed} BL-469 ASSERTION(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
