#!/usr/bin/env node
/**
 * tools/test-9303b749-embed-isolation-prefix-control.mjs
 *
 * Red->green pin for backlog 9303b749 ("test-26121495 Part A's pre-fix control
 * is a stub"). Part A's red demo used `PRE_FIX_AUDIT = (procs) => ({ smoke: [],
 * foreign: procs, violations: [] })` — a hand-written function that flags
 * nothing by construction, while the header called the controls "authentic".
 * A stub cannot fail for the reason the real pre-fix code failed, so its red
 * proves nothing about that code.
 *
 * There is no pre-fix embed-host audit to load: 0bb5b497:scripts/smoke-test.mjs
 * contains no embedding-host check at all (B1 re-verifies that from git). The
 * pre-fix harness's only isolation verdict was evaluateIsolation() in
 * scripts/lib/isolation-guard.mjs, so that is what the control must run.
 *
 * Invariants pinned (on the guard at --code-root):
 *   A1 no stubbed PRE_FIX_AUDIT that ignores its input;
 *   A2 the control is loaded from `git show 0bb5b497:scripts/lib/isolation-guard.mjs`;
 *   A3 the header describes that control truthfully;
 *   B1 0bb5b497's harness really has no embed-host audit (the header's claim);
 *   B2 behavioural: the guard's --pre-fix run goes red on Part A BECAUSE the real
 *      pre-fix evaluateIsolation returns "ok" for a leaking host.
 *
 * Usage:
 *   node tools/test-9303b749-embed-isolation-prefix-control.mjs                      # green
 *   node tools/test-9303b749-embed-isolation-prefix-control.mjs --code-root <dir>   # red demo: <dir> holds 82ef7b9d's tools/
 */
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crIdx = process.argv.indexOf('--code-root');
const CODE_ROOT = crIdx !== -1 ? path.resolve(process.argv[crIdx + 1]) : REPO_ROOT;
const GUARD = path.join(CODE_ROOT, 'tools/test-26121495-smoke-embed-host-isolation.mjs');
const src = fs.readFileSync(GUARD, 'utf8');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
console.log(`9303b749 — guard under test: ${GUARD}`);

console.log('A. the Part A pre-fix control is real pre-fix code');
check('A1 9303b749: no hand-written PRE_FIX_AUDIT that returns smoke: [] regardless of input',
  !/PRE_FIX_AUDIT\s*=\s*\(procs\)\s*=>\s*\(\{\s*smoke:\s*\[\]/.test(src));
check('A2 9303b749: the control is loaded from git at the pre-fix revision',
  /'show', `\$\{PRE_FIX_REV\}:scripts\/lib\/isolation-guard\.mjs`/.test(src) && /const PRE_FIX_REV = '0bb5b497'/.test(src));
check('A3 9303b749: the header names that control (no "no audit existed" stub claim)',
  /Pre-fix control \(9303b749\)/.test(src) && !/Pre-fix: no embed-host audit existed; the run's only check was data-root file hashes/.test(src));

console.log('B. the header claim and the red are both real');
{
  const pre = execFileSync('git', ['-C', REPO_ROOT, 'show', '0bb5b497:scripts/smoke-test.mjs'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  check('B1 9303b749: 0bb5b497\'s harness has no embedding-host audit to load (so evaluateIsolation IS the pre-fix check)',
    !/embedHostMain|auditEmbedHosts|parsePsLines/.test(pre) && /evaluateIsolation\(/.test(pre));
  // Run the guard's own pre-fix mode against THIS checkout's libs (only the control differs
  // between variants). In place for the normal run; only a --code-root guard (red demo) is
  // copied beside this checkout's tools/ so its REPO_ROOT resolves here.
  let out = '';
  const inPlace = CODE_ROOT === REPO_ROOT;
  const probe = inPlace ? GUARD : path.join(REPO_ROOT, 'tools', `.9303b749-probe-${process.pid}.mjs`);
  if (!inPlace) fs.writeFileSync(probe, src);
  try {
    const r = spawnSync(process.execPath, [probe, '--pre-fix'], { encoding: 'utf8' });
    out = `${r.stdout}${r.stderr}`;
  } finally {
    if (!inPlace) fs.rmSync(probe, { force: true });
  }
  check('B2 9303b749: --pre-fix is red on Part A, driven by the real evaluateIsolation verdict',
    /FAIL A1 reported shape/.test(out) && /pre-fix evaluateIsolation verdict: ok/.test(out), out.split('\n').filter((l) => /A1|verdict|Error/.test(l)).slice(0, 4).join(' | '));
}

console.log(failed === 0 ? 'PASS 9303b749: all cases pass' : `FAIL 9303b749: ${failed} case(s) failed`);
process.exit(failed === 0 ? 0 : 1);
