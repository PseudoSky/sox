// Unit tests for the gate and check engine (item 891dbac0, T62). Every test name carries
// "891dbac0 AC<n>". The process runner is injected, so nothing here spawns a process; the real
// children live in e2e.test.mjs (AC3).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseTable, selectGates, runGates, runChecks, applyBaseline, shrinkBaseline, registerCheck, CHECKS, globToRegExp, EngineError,
} from '../lib.mjs';
import { parseArgs } from '../cli.mjs';

const ENGINE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const table = (gates, extra = {}) => parseTable(JSON.stringify({ gates, ...extra }));
const G = (id, over = {}) => ({ id, command: `echo ${id}`, stage: 'B', mechanism: 'mechanical', ...over });
const ids = (sel) => sel.filter((s) => s.selected).map((s) => s.gate.id);
const fakeRun = (exits = {}, seen = []) => (command, ctx) => {
  seen.push({ command, cwd: ctx.cwd });
  return { exit: exits[command] ?? 0, stdout: 'out', stderr: 'err' };
};

test('891dbac0 AC1 selects only gates bound to the step', () => {
  const t = table([G('G3', { stage: 'B' }), G('G5', { stage: ['C', 'D'] })]);
  assert.deepEqual(ids(selectGates(t, { step: 'B' })), ['G3']);
  assert.deepEqual(ids(selectGates(t, { step: 'D' })), ['G5']);
  assert.deepEqual(ids(selectGates(t, { step: 'A' })), []);
});

test('891dbac0 AC1 class, rigor, and changed paths decide whether a gate has something to check', () => {
  const t = table([
    G('G3', { classes: ['feature'] }),
    G('G5', { rigors: ['high'] }),
    G('G6', { paths: ['docs/**/*.md'] }),
  ]);
  assert.deepEqual(ids(selectGates(t, { step: 'B', changeClass: 'docs', rigor: 'standard', changed: ['src/a.ts'] })), []);
  assert.deepEqual(ids(selectGates(t, { step: 'B', changeClass: 'feature', rigor: 'high', changed: ['docs/x/y.md'] })), ['G3', 'G5', 'G6']);
  const reasons = selectGates(t, { step: 'B', changeClass: 'docs', changed: ['src/a.ts'] }).map((s) => s.reason);
  assert.ok(reasons.some((r) => /class docs/.test(r)) && reasons.some((r) => /no changed path/.test(r)));
});

test('891dbac0 AC1 no class, rigor, or path relaxes a non-relaxable gate (testing policy 6.7)', () => {
  const t = table([G('G1'), G('G2'), G('G4'), G('G10'), G('G12'), G('X9', { release: true }), G('G3', { classes: ['feature'] })]);
  const sel = ids(selectGates(t, { step: 'B', changeClass: 'docs', rigor: 'low', changed: ['README.md'] }));
  assert.deepEqual(sel, ['G1', 'G2', 'G4', 'G10', 'G12', 'X9']);
});

test('891dbac0 AC1 a table that tries to relax a non-relaxable gate is rejected', () => {
  assert.throws(() => table([G('G1', { classes: ['feature'] })]), (e) => e instanceof EngineError && e.code === 'E_TABLE' && /non-relaxable/.test(e.message));
  assert.throws(() => table([G('G7', { nonRelaxable: true, paths: ['a'] })]), /non-relaxable/);
});

test('891dbac0 AC1 table validation names stage, mechanism, duplicate id, and JSON problems', () => {
  assert.throws(() => table([G('G3', { stage: 'Z' })]), /stage must be drawn from ABCDEFGH/);
  assert.throws(() => table([G('G3', { mechanism: 'magic' })]), /mechanism must be one of/);
  assert.throws(() => table([G('G3'), G('G3')]), /duplicate gate id G3/);
  assert.throws(() => parseTable('{nope'), (e) => e.code === 'E_TABLE' && e.exit === 65);
});

test('891dbac0 AC1 globs: ** crosses directories, * and ? stay in one segment', () => {
  assert.ok(globToRegExp('src/**/*.ts').test('src/a/b/c.ts'));
  assert.ok(globToRegExp('src/**/*.ts').test('src/c.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/a/c.ts'));
  assert.ok(globToRegExp('a?.md').test('ab.md'));
  assert.ok(!globToRegExp('a.md').test('aXmd'));
});

test('891dbac0 AC1 runs each selected command from the root through the injected runner', () => {
  const seen = [];
  const t = table([G('G3'), G('G5', { stage: 'C' })]);
  runGates(t, { step: 'B', root: '/fixture' }, { run: fakeRun({}, seen) });
  assert.deepEqual(seen, [{ command: 'echo G3', cwd: '/fixture' }]);
});

test('891dbac0 AC2 the report is one JSON document and the exit is the worst gate status', () => {
  const t = table([G('G3'), G('G5'), G('G6')]);
  const r = runGates(t, { step: 'B', root: '.' }, { run: fakeRun({ 'echo G5': 2, 'echo G6': 9 }) });
  assert.equal(r.exit, 9);
  assert.deepEqual(r.summary.failed, ['G5', 'G6']);
  assert.equal(r.summary.passed, 1);
  const row = r.gates.find((g) => g.id === 'G5');
  assert.deepEqual([row.command, row.exit, row.outcome], ['echo G5', 2, 'fail']);
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
});

test('891dbac0 AC2 an all-green run exits 0 and a run never releases', () => {
  const r = runGates(table([G('G3')]), { step: 'B', root: '.' }, { run: fakeRun() });
  assert.equal(r.exit, 0);
  assert.equal(r.released, false);
  const src = ['lib.mjs', 'cli.mjs'].map((f) => fs.readFileSync(path.join(ENGINE, f), 'utf8')).join('\n');
  assert.ok(!/\b(publish|git\s+push|git\s+tag|npm\s+version)\b/.test(src), 'engine source has no release verbs');
});

test('891dbac0 AC2 a gate with no mechanism is an obligation, never a pass', () => {
  const t = table([G('G3', { command: undefined }), G('G5', { mechanism: 'review' })]);
  const r = runGates(t, { step: 'B', root: '.' }, { run: fakeRun() });
  assert.deepEqual(r.summary.obligations, ['G3', 'G5']);
  assert.equal(r.summary.passed, 0);
  assert.equal(r.exit, 0);
  assert.equal(runGates(t, { step: 'B', root: '.', failOnObligation: true }, { run: fakeRun() }).exit, 1);
});

test('891dbac0 AC2 evidence is written per gate when an evidence directory is given', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-ev-'));
  const r = runGates(table([G('G3')]), { step: 'B', root: '.' }, { run: fakeRun({ 'echo G3': 1 }), evidenceDir: dir });
  assert.match(fs.readFileSync(r.gates[0].evidence, 'utf8'), /exit 1/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('891dbac0 AC3 the engine sources carry no build-tool knowledge and no dependency', () => {
  for (const f of ['lib.mjs', 'cli.mjs']) {
    const src = fs.readFileSync(path.join(ENGINE, f), 'utf8');
    assert.ok(!/\bnx\b|nx\.json|@nx|\btsc\b|\bwebpack\b|\bvitest\b/i.test(src), `${f} names a build tool`);
    assert.ok(!/^import .*from '(?!node:|\.)/m.test(src), `${f} imports a dependency`);
  }
});

test('891dbac0 AC3 cli parsing rejects unknown flags and missing values', () => {
  const a = parseArgs(['run', '--step', 'B', '--changed', 'a', '--changed', 'b', '--fail-on-obligation']);
  assert.deepEqual([a.positional, a.flags['--step'], a.changed, a.flags['--fail-on-obligation']], [['run'], 'B', ['a', 'b'], true]);
  assert.throws(() => parseArgs(['run', '--bogus']), (e) => e.exit === 64);
  assert.throws(() => parseArgs(['run', '--step']), (e) => e.exit === 64);
});

test('891dbac0 AC4 exposes completeness, liveness, reachability, and teeth', () => {
  assert.deepEqual(['completeness', 'liveness', 'reachability', 'teeth'].filter((n) => typeof CHECKS[n] !== 'function'), []);
});

test('891dbac0 AC4 completeness: each clause has exactly one binding row', () => {
  const t = table([G('G3'), G('G5', { clauses: ['P1'] }), G('G6', { clauses: ['P1'] })]);
  const f = CHECKS.completeness({ table: t, clauses: ['G3', 'P1', 'P2'] });
  assert.deepEqual(f.map((x) => x.key).sort(), ['completeness:P1', 'completeness:P2']);
});

test('891dbac0 AC4 liveness: missing commands and referenced paths are findings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-live-'));
  fs.writeFileSync(path.join(root, 'ok.sh'), '');
  const t = table([
    G('G3', { command: './ok.sh', references: ['ok.sh'] }),
    G('G5', { command: './absent.sh' }),
    G('G6', { command: 'definitely-not-a-binary-xyz' }),
    G('G7', { references: ['gone.md'] }),
  ]);
  assert.deepEqual(CHECKS.liveness({ table: t, root }).map((x) => x.id).sort(), ['G5', 'G6', 'G7']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('891dbac0 AC4 reachability: a stage must invoke every gate bound to it, and unbound gates are findings', () => {
  const t = table([G('G3', { stage: 'B' }), G('G5', { stage: 'C' }), G('G6', { stage: [] })], { stages: { B: { invokes: ['G3'] }, C: { invokes: [] } } });
  assert.deepEqual(CHECKS.reachability({ table: t }).map((x) => x.id).sort(), ['G5@C', 'G6']);
});

test('891dbac0 AC4 teeth: the seeded violation must fail, and a gate without one is a finding', () => {
  const t = table([G('G3', { seeded: { command: 'seed-ok' } }), G('G5', { seeded: { command: 'seed-toothless' } }), G('G6')]);
  const f = CHECKS.teeth({ table: t, root: '.', run: fakeRun({ 'seed-ok': 1 }) });
  assert.deepEqual(f.map((x) => x.id).sort(), ['G5', 'G6']);
});

test('891dbac0 AC4 the ratchet baseline only shrinks: new findings and stale entries both fail', () => {
  const r = applyBaseline([{ key: 'liveness:G5' }, { key: 'liveness:G6' }], ['liveness:G5', 'liveness:GONE']);
  assert.deepEqual([r.newFindings.map((f) => f.key), r.tolerated.map((f) => f.key), r.stale], [['liveness:G6'], ['liveness:G5'], ['liveness:GONE']]);
  const t = table([G('G5', { references: ['x'] })]);
  assert.equal(runChecks(['liveness'], { table: t, root: os.tmpdir() }, ['liveness:G5']).exit, 0);
  assert.equal(runChecks(['liveness'], { table: t, root: os.tmpdir() }, []).exit, 1);
  assert.equal(runChecks(['liveness'], { table: table([G('G5')]), root: os.tmpdir() }, ['liveness:G5']).exit, 1, 'stale baseline entry fails');
});

test('891dbac0 AC4 shrinkBaseline refuses to grow the baseline', () => {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ge-bl-')), 'b.json');
  shrinkBaseline(f, [{ key: 'a:1' }, { key: 'a:2' }]);
  shrinkBaseline(f, [{ key: 'a:1' }]);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(f, 'utf8'))), ['a:1']);
  assert.throws(() => shrinkBaseline(f, [{ key: 'a:1' }, { key: 'a:9' }]), (e) => e.code === 'E_BASELINE_GROWS');
});

test('891dbac0 AC4 T41 can register a domain check and runChecks runs it; unknown checks are named', () => {
  registerCheck('domain-x', () => [{ check: 'domain-x', id: 'Q', key: 'domain-x:Q', evidence: 'e' }]);
  const r = runChecks(['domain-x'], { table: table([]), root: '.' });
  assert.deepEqual([r.exit, r.findings.length], [1, 1]);
  delete CHECKS['domain-x'];
  assert.throws(() => runChecks(['nope'], { table: table([]), root: '.' }), /unknown check: nope/);
});

test('891dbac0 AC5 the README states what is reused and what is replaced', () => {
  const readme = fs.readFileSync(path.join(ENGINE, 'README.md'), 'utf8');
  const line = readme.split('\n').find((l) => l.startsWith('Reuses:'));
  assert.ok(line, 'README has a "Reuses: ...; replaces: ..." sentence');
  assert.match(line, /; replaces: /);
  for (const name of ['lane-gate.mjs', 'check-lane-reachability.mjs']) assert.ok(line.includes(name), `names ${name}`);
  assert.ok(readme.includes('decisions/reuse-decision.md'));
});

test('891dbac0 AC1 selection itself never relaxes a non-relaxable gate, even from a hand-built table', () => {
  const hand = { gates: [{ ...G('G1'), stage: ['B'], classes: ['feature'], paths: ['x/**'], rigors: ['high'] }], stages: {} };
  assert.deepEqual(ids(selectGates(hand, { step: 'B', changeClass: 'docs', rigor: 'low', changed: ['README.md'] })), ['G1']);
});
