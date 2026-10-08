// Eval driver: baseline vs variant, N reps, cheapest tier (haiku). Not a unit test; spawns `claude -p`.
// usage: node run.mjs [reps=3] > results.json      2f81569f T11.AC3
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CASES } from './cases.mjs';
import { grade } from './grade.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const VARIANT = readFileSync(join(here, '..', 'review.md'), 'utf8');
const BASELINE = 'You are a code reviewer. Review what the user sends you.';
const reps = Number(process.argv[2] ?? 3);
const MODEL = process.env.REVIEW_EVAL_MODEL ?? 'haiku';

const ask = (system, brief) =>
  new Promise((resolve) => {
    const p = spawn('claude', ['-p', '--model', MODEL, '--system-prompt', system, '--tools', '', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence'], { cwd: process.env.TMPDIR ?? '/tmp' });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('close', () => resolve(out));
    p.stdin.end(brief);
  });

const jobs = [];
for (const arm of ['baseline', 'variant']) for (const c of CASES) for (let r = 0; r < reps; r++) jobs.push({ arm, c, r });
const results = [];
let next = 0;
await Promise.all(Array.from({ length: 6 }, async () => {
  while (next < jobs.length) {
    const { arm, c, r } = jobs[next++];
    const out = await ask(arm === 'variant' ? VARIANT : BASELINE, c.brief);
    const g = grade(out, c.expect);
    results.push({ arm, case: c.id, rep: r, pass: g.pass, reasons: g.reasons, detected: c.detectLine ? c.detectLine.test(out) : null, output: out });
  }
}));
const rate = (arm, f = () => true) => { const rs = results.filter((x) => x.arm === arm && f(x)); return rs.filter((x) => x.pass).length / rs.length; };
const summary = {
  reps, model: MODEL, cases: CASES.length,
  baseline: { passRate: rate('baseline'), staticRate: rate('baseline', (x) => x.case.startsWith('S')), blindRate: rate('baseline', (x) => x.case.startsWith('B')) },
  variant: { passRate: rate('variant'), staticRate: rate('variant', (x) => x.case.startsWith('S')), blindRate: rate('variant', (x) => x.case.startsWith('B')) },
};
console.log(JSON.stringify({ summary, results: results.sort((a, b) => (a.arm + a.case + a.rep).localeCompare(b.arm + b.case + b.rep)) }, null, 2));
