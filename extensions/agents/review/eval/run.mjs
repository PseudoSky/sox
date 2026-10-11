// Eval driver: baseline vs variant, N reps. Spawns `claude -p` (not a unit test).
// usage: [REVIEW_EVAL_MODEL=sonnet] node eval/run.mjs [reps=3]   -> writes eval/results.json (the only writer; never hand-edit)
// 2f81569f T11.AC3
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CASES } from './cases.mjs';
import { grade, GRADER_VERSION } from './grade.mjs';
import { summarize } from './summary.mjs';

// HARD STOP (owner directive, 595965cc T22): unconditional. No env var, no argv, no condition.
// This eval spawns `claude -p`; a run of it exhausted the owner's whole usage quota, and live-model runs are barred.
// Only a human editing this file by hand, with explicit owner approval at the later testing run, may delete this block.
console.error('This eval spawns `claude -p`; a run of it exhausted the owner\'s whole usage quota. Live-model runs are barred. Remove this HARD STOP by hand only with explicit owner approval at the later testing run.');
process.exit(64);

const here = dirname(fileURLToPath(import.meta.url));
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const PROMPT = join(here, '..', 'review.md');
const VARIANT = readFileSync(PROMPT, 'utf8');
const BASELINE = 'You are a code reviewer. Review what the user sends you.';
const reps = Number(process.argv[2] ?? 3);
const MODEL = process.env.REVIEW_EVAL_MODEL ?? 'sonnet';

const ask = (system, brief) =>
  new Promise((resolve) => {
    const p = spawn('claude', ['-p', '--model', MODEL, '--system-prompt', system, '--tools', '', '--setting-sources', '', '--disable-slash-commands', '--no-session-persistence'], { cwd: process.env.TMPDIR ?? '/tmp' });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve(''));
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
results.sort((a, b) => (a.arm + a.case + a.rep).localeCompare(b.arm + b.case + b.rep));
const summary = {
  reps, model: MODEL, cases: CASES.length, heldOutCases: CASES.filter((c) => c.heldOut).length,
  graderVersion: GRADER_VERSION, promptSha256: sha(PROMPT), casesSha256: sha(join(here, 'cases.mjs')),
  command: `REVIEW_EVAL_MODEL=${MODEL} node eval/run.mjs ${reps}`, recordedAt: new Date().toISOString(),
  method: 'one variable (system prompt: baseline one-liner vs review.md); briefs rendered from templates/; code-based grader, no LLM judge; tools disabled in the eval harness (--tools ""), so tool-use rules are not exercised; held-out cases (heldOut:true) were not used for tuning',
  ...summarize(results, CASES),
};
writeFileSync(join(here, 'results.json'), JSON.stringify({ summary, results }, null, 2) + '\n');
console.log(JSON.stringify({ model: summary.model, baseline: { ...summary.baseline, perCase: undefined }, variant: { ...summary.variant, perCase: undefined }, perCase: summary.variant.perCase }, null, 1));
