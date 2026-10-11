// Golden-set A/B driver (a0897ba2 AC1/AC4/AC5). Spawns `claude -p` with tools in a throwaway sandbox; code-based grading, no LLM judge.
// usage: [TA_EVAL_MODEL=sonnet] node eval/run.mjs [reps=3]  -> writes eval/results.json (the only writer)
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTHORING, BASELINE_AUTHORING, BASELINE_SYSTEM, SCOPE_CASES } from './cases.mjs';
import { gradeAuthoring, gradeScope, here, sandbox, sha, STUB_SHA } from './lib.mjs';
import { MUTANTS } from './mutants.mjs';

const PROMPT = join(here, '..', 'test-author.md');
const VARIANT = readFileSync(PROMPT, 'utf8');
const reps = Number(process.argv[2] ?? 3);
const MODEL = process.env.TA_EVAL_MODEL ?? 'sonnet';
const TOOLS = 'Read,Write,Edit,Bash,Glob,Grep';

const ask = (system, brief, cwd) => new Promise((resolve) =>
{
  const p = spawn('claude', ['-p', '--model', MODEL, '--system-prompt', system, '--tools', TOOLS, '--allowedTools', TOOLS, '--permission-mode', 'bypassPermissions', '--setting-sources', '', '--disable-slash-commands', /*'--no-session-persistence'*/], { cwd });
  let out = ''; p.stdout.on('data', (d) => (out += d)); p.on('error', () => resolve('')); p.on('close', () => { if (/session limit|rate limit/i.test(out.slice(0, 200))) { console.error('ABORT: model quota hit; nothing recorded'); process.exit(2); } resolve(out); }); p.stdin.end(brief);
});
process.abort()
const jobs = [];
for (let r = 0; r < reps; r++) {
  jobs.push({ kind: 'authoring', arm: 'variant', id: 'A1-author-new-behavior', r });
  jobs.push({ kind: 'authoring', arm: 'baseline', id: 'A1-implementer-writes-tests', r });
  for (const c of SCOPE_CASES) { jobs.push({ kind: 'scope', arm: 'variant', id: c.id, r, c }); jobs.push({ kind: 'scope', arm: 'baseline', id: c.id, r, c }); }
}
const results = []; let next = 0;
await Promise.all(Array.from({ length: 4 }, async () =>
{
  while (next < jobs.length) {
    const j = jobs[next++];
    if (j.kind === 'authoring') {
      const sb = sandbox(j.arm === 'variant' ? 'stub' : 'impl');
      const out = await ask(j.arm === 'variant' ? VARIANT : BASELINE_SYSTEM, j.arm === 'variant' ? AUTHORING : BASELINE_AUTHORING, sb);
      let g;
      if (j.arm === 'variant') g = gradeAuthoring(out, sb);
      else {
        const { readFileSync: rf, existsSync } = await import('node:fs');
        const tp = join(sb, 'test/shipping.test.mjs');
        const src = existsSync(tp) ? rf(tp, 'utf8') : null;
        const { killVector } = await import('./lib.mjs');
        g = { ...(src ? killVector(src) : { valid: false, killed: [] }), testSource: src, pass: !!src, reasons: src ? [] : ['no test file'] };
      }
      results.push({ arm: j.arm, case: j.id, rep: j.r, kind: 'authoring', pass: g.pass, reasons: g.reasons, valid: g.valid, killed: g.killed, testSource: g.testSource, output: out });
    } else {
      const sb = sandbox('stub');
      const out = await ask(j.arm === 'variant' ? VARIANT : BASELINE_SYSTEM, j.c.brief, sb);
      const g = gradeScope(out, sb, { ...j.c.expect, prodSha: STUB_SHA });
      results.push({ arm: j.arm, case: j.id, rep: j.r, kind: 'scope', ac: j.c.ac, pass: g.pass, reasons: g.reasons, output: out });
    }
  }
}));
results.sort((a, b) => (a.arm + a.case + a.rep).localeCompare(b.arm + b.case + b.rep));
const summary = {
  reps, model: MODEL, mutants: MUTANTS.map((m) => m.id), promptSha256: sha(VARIANT),
  casesSha256: sha(readFileSync(join(here, 'cases.mjs'), 'utf8')), mutantsSha256: sha(readFileSync(join(here, 'mutants.mjs'), 'utf8')),
  command: `TA_EVAL_MODEL=${MODEL} node eval/run.mjs ${reps}`, recordedAt: new Date().toISOString(),
  method: 'one variable: separated test-author (test-author.md, spec + stub only, card inlined) vs implementer-writes-tests baseline (implementation in view); real tools in a throwaway sandbox; tests graded by executing them against the correct implementation and 7 seeded-fault mutants; scope cases graded on first line and file/sha state; no LLM judge',
};
writeFileSync(join(here, 'results.json'), JSON.stringify({ summary, results }, null, 2) + '\n');
for (const arm of ['baseline', 'variant']) {
  const a = results.filter((r) => r.arm === arm && r.kind === 'authoring');
  console.log(arm, 'authoring valid', a.filter((r) => r.valid).length + '/' + a.length, 'kills', a.map((r) => r.killed.length).join(','));
  const s = results.filter((r) => r.arm === arm && r.kind === 'scope');
  console.log(arm, 'scope pass', s.filter((r) => r.pass).length + '/' + s.length);
}
