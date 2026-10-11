// Golden-set A/B: baseline (qa v0.1.1 prose) vs variant (qa.md), one variable. Spawns `claude -p`; tools disabled.
// usage: [QA_EVAL_MODEL=sonnet] node eval/run.mjs [reps=3]  -> writes eval/results.json (only writer)
// 0c91e632 AC3-AC6
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CASES } from './cases.mjs';
import { grade, GRADER_VERSION } from './grade.mjs';

// HARD STOP (owner directive, 595965cc T22): unconditional. No env var, no argv, no condition.
// This eval spawns `claude -p`; a run of it exhausted the owner's whole usage quota. Live-model runs are barred.
// Only a human editing this file by hand, with explicit owner approval at the later testing run, may delete this block.
console.error('This eval spawns `claude -p`; a run of it exhausted the owner\'s whole usage quota. Live-model runs are barred. Remove this HARD STOP by hand only with explicit owner approval at the later testing run.');
process.exit(64);

const here = dirname(fileURLToPath(import.meta.url));
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const VARIANT_P = join(here, '..', 'qa.md'), BASE_P = join(here, 'baseline-qa-v0.1.1.md');
const reps = Number(process.argv[2] ?? 3);
const MODEL = process.env.QA_EVAL_MODEL ?? 'sonnet';
const ask = (system, brief) => new Promise((resolve) => {
  const p = spawn('claude', ['-p', '--model', MODEL, '--system-prompt', system, '--tools', '', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence'], { cwd: process.env.TMPDIR ?? '/tmp' });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.on('error', () => resolve('')); p.on('close', () => resolve(out)); p.stdin.end(brief);
});
const prompts = { baseline: readFileSync(BASE_P, 'utf8'), variant: readFileSync(VARIANT_P, 'utf8') };
const jobs = [];
for (const arm of ['baseline', 'variant']) for (const c of CASES) for (let r = 0; r < reps; r++) jobs.push({ arm, c, r });
const results = []; let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < jobs.length) {
    const { arm, c, r } = jobs[next++];
    const out = await ask(prompts[arm], c.brief);
    const g = grade(out, c.expect);
    results.push({ arm, case: c.id, ac: c.ac, rep: r, pass: g.pass, reasons: g.reasons, output: out });
  }
}));
results.sort((a, b) => (a.arm + a.case + a.rep).localeCompare(b.arm + b.case + b.rep));
const rate = (arm, f) => { const rs = results.filter((x) => x.arm === arm && f(x)); return { n: rs.length, passed: rs.filter((x) => x.pass).length, rate: rs.length ? rs.filter((x) => x.pass).length / rs.length : null }; };
const perAc = {};
for (const ac of ['AC1', 'AC3', 'AC4', 'AC5', 'AC6']) perAc[ac] = { baseline: rate('baseline', (x) => x.ac === ac), variant: rate('variant', (x) => x.ac === ac) };
const summary = { reps, model: MODEL, cases: CASES.length, graderVersion: GRADER_VERSION, variantSha256: sha(VARIANT_P), baselineSha256: sha(BASE_P), casesSha256: sha(join(here, 'cases.mjs')),
  command: `QA_EVAL_MODEL=${MODEL} node eval/run.mjs ${reps}`, recordedAt: new Date().toISOString(),
  method: 'one variable (system prompt: qa v0.1.1 vs qa.md); code-based grader, no LLM judge; tools disabled so only stated behavior is exercised; briefs carry no measured numbers so any figure in an answer is invented; cases with arms:"variant" test behavior the baseline does not describe',
  perAc, baseline: rate('baseline', () => true), variant: rate('variant', () => true) };
writeFileSync(join(here, 'results.json'), JSON.stringify({ summary, results }, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 1));
