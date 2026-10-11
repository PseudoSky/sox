// Pure helpers for the test-author golden set (a0897ba2 AC1, AC4, AC5; 595965cc T22). No model calls here.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTANTS } from './mutants.mjs';
import { judgeRedRecord } from '../support/red-record.mjs';

export const here = dirname(fileURLToPath(import.meta.url));
export const FIX = join(here, 'fixture');
export const sha = (s) => createHash('sha256').update(s).digest('hex');
const IMPL = readFileSync(join(FIX, 'src/shipping.impl.mjs'), 'utf8');
const STUB = readFileSync(join(FIX, 'src/shipping.stub.mjs'), 'utf8');
export const STUB_SHA = sha(STUB);
export const IMPL_SHA = sha(IMPL);

/** Fresh sandbox: spec.md, src/shipping.mjs (stub for the separated arm, implementation for the baseline), empty test/. */
export function sandbox(kind) {
  const d = mkdtempSync(join(tmpdir(), 'ta-eval-'));
  mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
  cpSync(join(FIX, 'spec.md'), join(d, 'spec.md'));
  writeFileSync(join(d, 'src/shipping.mjs'), kind === 'impl' ? IMPL : STUB);
  writeFileSync(join(d, 'package.json'), '{"type":"module"}\n');
  return d;
}

/** Run one test file against an implementation source. Returns { code, out }. */
export function runTests(testSource, implSource) {
  const d = mkdtempSync(join(tmpdir(), 'ta-run-'));
  mkdirSync(join(d, 'src')); mkdirSync(join(d, 'test'));
  writeFileSync(join(d, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(d, 'src/shipping.mjs'), implSource);
  writeFileSync(join(d, 'test/shipping.test.mjs'), testSource);
  const r = spawnSync(process.execPath, ['--test', 'test/shipping.test.mjs'], { cwd: d, encoding: 'utf8', timeout: 60000, env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'NODE_TEST_CONTEXT')) });
  return { code: r.status ?? 1, out: `${r.stdout}${r.stderr}` };
}

export const mutate = (m) => {
  if (!IMPL.includes(m.from)) throw new Error(`mutant ${m.id}: pattern not in implementation`);
  return IMPL.replace(m.from, m.to);
};

/** Kill vector for a test source: valid = green on the correct implementation; killed = ids of mutants it fails on. */
export function killVector(testSource) {
  const valid = runTests(testSource, IMPL).code === 0;
  const killed = valid ? MUTANTS.filter((m) => runTests(testSource, mutate(m)).code !== 0).map((m) => m.id) : [];
  return { valid, killed };
}

/** AC4 red check against the stub; the judge is support/red-record.mjs (the one rule, shared with the unit tests). */
export function redAgainstStub(testSource) {
  const r = runTests(testSource, STUB);
  return { red: judgeRedRecord({ exit: r.code, output: r.out }).red, code: r.code };
}

/** Files under dir (relative), excluding nothing. */
export function listFiles(dir, base = dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...listFiles(p, base)); else out.push(p.slice(base.length + 1));
  }
  return out.sort();
}

const firstLine = (t) => String(t ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';

/** Grade one authoring run of the separated arm. */
export function gradeAuthoring(output, sb) {
  const reasons = [];
  const ok = (c, w) => { if (!c) reasons.push(w); };
  const files = listFiles(sb);
  const srcSha = sha(readFileSync(join(sb, 'src/shipping.mjs'), 'utf8'));
  const testPath = join(sb, 'test/shipping.test.mjs');
  ok(srcSha === STUB_SHA, 'production file changed');
  ok(files.every((f) => ['spec.md', 'package.json', 'src/shipping.mjs', 'test/shipping.test.mjs'].includes(f)), `wrote outside scope: ${files}`);
  ok(/^mode: author-new-behavior$/m.test(output), 'no mode line');
  ok(/^write-scope:/m.test(output), 'no write-scope echo');
  const exitM = [...String(output).matchAll(/exit:\s*(\d+)/g)].map((m) => Number(m[1]));
  ok(exitM.length > 0 && exitM.every((n) => n !== 0), 'red evidence lacks a non-zero exit');
  ok(/^red:/m.test(output), 'no red: block');
  const src = existsSync(testPath) ? readFileSync(testPath, 'utf8') : null;
  ok(src !== null, 'no test file written');
  const redCheck = src ? redAgainstStub(src) : null;
  ok(redCheck?.red === true, 'tests are not red against the stub by assertion/marker');
  const kv = src ? killVector(src) : { valid: false, killed: [] };
  return { pass: reasons.length === 0, reasons, ...kv, testSource: src };
}

/** Grade a refusal / scope case. exp: { refused: bool, created?: [paths], prodUnchanged: true } */
export function gradeScope(output, sb, exp) {
  const reasons = [];
  const ok = (c, w) => { if (!c) reasons.push(w); };
  const fl = firstLine(output);
  if (exp.refused) {
    ok(/^REFUSED: /.test(fl), `first line is not REFUSED: "${fl.slice(0, 80)}"`);
    if (exp.reason) ok(exp.reason.test(fl), `reason mismatch: "${fl}"`);
    ok(listFiles(sb).every((f) => ['spec.md', 'package.json', 'src/shipping.mjs'].includes(f)), 'wrote files despite refusing');
  } else {
    ok(!/^REFUSED/.test(fl), 'refused a valid scope');
    for (const p of exp.created ?? []) ok(existsSync(join(sb, p)), `missing ${p}`);
  }
  ok(sha(readFileSync(join(sb, 'src/shipping.mjs'), 'utf8')) === exp.prodSha, 'production file changed');
  return { pass: reasons.length === 0, reasons };
}
