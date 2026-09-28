#!/usr/bin/env node
/**
 * tools/test-8c3f8f87-smoke-log-reflects-exit.mjs
 *
 * Red->green pin for backlog 8c3f8f87 ("smoke: log.json says 0 failed on a run
 * that exits 2"). The harness wrote log.json and its `done — N failed` line
 * BEFORE the embedding-host final sweep and the live data-root isolation
 * verdict, and a breach seen by a runCmd step's audit never failed that step.
 * A run could exit 2 (FATAL) with `summary.failed === 0` in its own report.
 *
 * Invariants pinned:
 *   A. (behavioural) for EVERY combination of post-run failure — live data-root
 *      breach, embed breach, undead host, unverifiable audit, failed final sweep,
 *      ordinary step failure — exit code 2 implies summary.failed > 0 and a failed
 *      log entry naming the cause (finalEmbedVerdict + finalizeRun);
 *   B. harness wiring: log.json is written after evaluateIsolation, after the
 *      final sweep and after finalizeRun; runCmd fails the step whose audit saw a
 *      breach; the exit code comes from finalizeRun.
 *
 * Usage:
 *   node tools/test-8c3f8f87-smoke-log-reflects-exit.mjs                      # green
 *   node tools/test-8c3f8f87-smoke-log-reflects-exit.mjs --code-root <dir>   # red demo: <dir> holds 82ef7b9d's scripts/
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const crIdx = process.argv.indexOf('--code-root');
const CODE_ROOT = crIdx !== -1 ? path.resolve(process.argv[crIdx + 1]) : REPO_ROOT;
async function load(rel) {
  const p = path.join(CODE_ROOT, rel);
  return fs.existsSync(p) ? import(pathToFileURL(p).href) : {};
}
const embedLib = await load('scripts/lib/embed-host-isolation.mjs');
const teardown = await load('scripts/lib/smoke-teardown.mjs');
const src = fs.readFileSync(path.join(CODE_ROOT, 'scripts/smoke-test.mjs'), 'utf8');

let failed = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}`);
  else { failed++; console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`); }
}
console.log(`8c3f8f87 — code under test: ${CODE_ROOT}`);

console.log('A. exit 2 ⇒ summary.failed > 0, for every post-run failure combination');
{
  const have = typeof embedLib.finalEmbedVerdict === 'function' && typeof teardown.finalizeRun === 'function';
  check('A0 8c3f8f87: finalEmbedVerdict and finalizeRun are exported', have);
  if (have) {
    let combos = 0;
    let bad = [];
    for (let mask = 0; mask < 64; mask++) {
      const liveFatal = !!(mask & 1); const breach = !!(mask & 2); const undead = !!(mask & 4);
      const auditFail = !!(mask & 8); const sweepFail = !!(mask & 16); const stepFail = !!(mask & 32);
      const summary = { passed: 3, failed: stepFail ? 1 : 0, skipped: 0 };
      const log = [];
      const embed = embedLib.finalEmbedVerdict({
        breaches: breach ? ['svc-enable: pid=1 host — HOME=/Users/op is outside the smoke root'] : [],
        undead: undead ? [4242] : [],
        auditFailures: auditFail ? ['svc-status: embed-host audit could not run (ps capture failed)'] : [],
        finalSweep: sweepFail ? { ok: false, detail: 'embed-host ps capture failed — reap unverifiable', attributed: 0 } : { ok: true, detail: '', attributed: 2 },
        attributed: [7, 8],
      });
      const exit = teardown.finalizeRun({
        summary, log,
        steps: [{ test_id: 'live-data-root-isolation', passed: !liveFatal, verdict: 'live-data-root-isolation-breach', detail: 'x', fatal: true },
          ...embed.steps.map((s) => ({ ...s, fatal: true }))],
      });
      combos++;
      const expectFatal = liveFatal || breach || undead || auditFail || sweepFail;
      if ((exit === 2) !== expectFatal) bad.push(`mask ${mask}: exit ${exit}, expected ${expectFatal ? 2 : 'not 2'}`);
      if (exit === 2 && !(summary.failed > 0 && log.some((e) => e.passed === false))) bad.push(`mask ${mask}: exit 2 with summary.failed=${summary.failed}`);
      if (exit === 0 && summary.failed !== 0) bad.push(`mask ${mask}: exit 0 with failures`);
      if (embed.ok !== !(breach || undead || auditFail || sweepFail)) bad.push(`mask ${mask}: embed.ok=${embed.ok}`);
      if (log.some((e) => e.passed !== (e.verdict === 'verified'))) bad.push(`mask ${mask}: a log entry's verdict disagrees with passed`);
    }
    check(`A1 8c3f8f87: all ${combos} combinations — exit 2 ⇔ a fatal step failed, and then summary.failed > 0 with a failed log entry`, bad.length === 0, bad.slice(0, 5).join('; '));
    const e = embedLib.finalEmbedVerdict({ breaches: ['b1'], undead: [99], auditFailures: [], finalSweep: { ok: true, detail: '' }, attributed: [] });
    const names = e.steps.filter((s) => !s.passed).map((s) => s.test_id).sort().join(',');
    check('A2 8c3f8f87: each category is its own failed step entry (breaches + undead both recorded)', names === 'embed-host-isolation-breaches,embed-host-undead', names);
    const clean = embedLib.finalEmbedVerdict({ breaches: [], undead: [], auditFailures: [], finalSweep: { ok: true, detail: '', attributed: 1 }, attributed: [5] });
    check('A3 8c3f8f87: a clean run still records the sweep as a (passing) step', clean.ok && clean.steps.some((s) => s.test_id === 'embed-host-final-sweep' && s.passed));
  }
}

console.log('B. harness wiring');
{
  const a = src.indexOf('async function main()');
  const main = src.slice(a, src.indexOf('\n}\n', a));
  const iWrite = main.indexOf('fsp.writeFile(LOG_PATH');
  const iSweep = main.indexOf("reapSmokeEmbedHosts('final-sweep')");
  const iIso = main.indexOf('evaluateIsolation(');
  const iFinal = main.indexOf('finalizeRun(');
  check('B1 8c3f8f87: log.json is written after the final embed sweep', iWrite !== -1 && iSweep !== -1 && iWrite > iSweep, `write@${iWrite} sweep@${iSweep}`);
  check('B2 8c3f8f87: log.json is written after the live data-root isolation verdict', iWrite > iIso && iIso !== -1, `write@${iWrite} iso@${iIso}`);
  check('B3 8c3f8f87: post-run checks are folded into the log (finalizeRun) before the write', iFinal !== -1 && iFinal < iWrite);
  check('B4 8c3f8f87: the live data-root verdict and every embed category are fatal steps',
    /test_id: 'live-data-root-isolation'[\s\S]{0,200}fatal: true/.test(main) && /embed\.steps\.map\(\(st\) => \(\{ \.\.\.st, fatal: true \}\)\)/.test(main));
  check('B5 8c3f8f87: the exit code is finalizeRun\'s', /process\.exit\(exitCode\)/.test(main));
  const rc = src.slice(src.indexOf('async function runCmd('), src.indexOf('const PROJECT_LOCKFILE'));
  check('B6 8c3f8f87: a runCmd step whose embed audit saw a breach fails that step',
    /const embedAudit = auditSmokeEmbedHosts\(/.test(rc) && /embedAudit\.problems\.length > 0[\s\S]{0,80}passed = false/.test(rc));
}

console.log(failed === 0 ? 'PASS 8c3f8f87: all cases pass' : `FAIL 8c3f8f87: ${failed} case(s) failed`);
process.exit(failed === 0 ? 0 : 1);
