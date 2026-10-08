// E2E-ONLY: this file spawns real child processes by design; unit.test.mjs spawns nothing.
// 891dbac0 AC3: the engine runs against a fixture table in a temp directory that has no build-tool
// config at all, and a seeded failing command makes the exit non-zero and the report name it.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../cli.mjs');
let root;
const run = (args) => spawnSync(process.execPath, [CLI, ...args, '--root', root], { encoding: 'utf8' });
const writeTable = (gates, extra = {}) => fs.writeFileSync(path.join(root, 'gates.table.json'), JSON.stringify({ gates, ...extra }));
const NODE = JSON.stringify(process.execPath);
const cmd = (code) => `${NODE} -e "process.exit(${code})"`;
const report = () => JSON.parse(fs.readFileSync(path.join(root, 'gate-report.json'), 'utf8'));

before(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'ge-e2e-')); });
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

test('891dbac0 AC3 the fixture directory has no nx.json and a green table exits 0', () => {
  assert.ok(!fs.existsSync(path.join(root, 'nx.json')));
  writeTable([{ id: 'G3', command: cmd(0), stage: 'B', mechanism: 'mechanical' }]);
  const r = run(['run', '--step', 'B']);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(report().summary.passed, 1);
});

test('891dbac0 AC3 a seeded failing command makes the exit non-zero and the report names it', () => {
  writeTable([
    { id: 'G3', command: cmd(0), stage: 'B', mechanism: 'mechanical' },
    { id: 'G9', command: cmd(3), stage: 'B', mechanism: 'mechanical' },
  ]);
  const r = run(['run', '--step', 'B']);
  assert.equal(r.status, 3, r.stderr);
  const rep = report();
  assert.deepEqual(rep.summary.failed, ['G9']);
  assert.equal(rep.exit, 3);
  const g9 = rep.gates.find((g) => g.id === 'G9');
  assert.deepEqual([g9.outcome, g9.exit], ['fail', 3]);
  assert.ok(fs.existsSync(g9.evidence), 'evidence file written');
});

test('891dbac0 AC2 --report - prints the single JSON report on stdout', () => {
  writeTable([{ id: 'G3', command: cmd(0), stage: 'B', mechanism: 'mechanical' }]);
  assert.equal(JSON.parse(run(['run', '--step', 'B', '--report', '-']).stdout).kind, 'gate-report');
});

test('891dbac0 AC1 --changed filters gates with nothing to check, and usage and table errors have named exits', () => {
  writeTable([
    { id: 'G3', command: cmd(1), stage: 'B', mechanism: 'mechanical', paths: ['docs/**'] },
    { id: 'G5', command: cmd(0), stage: 'B', mechanism: 'mechanical' },
  ]);
  assert.equal(run(['run', '--step', 'B', '--changed', 'src/a.ts']).status, 0);
  assert.equal(run(['run', '--step', 'B', '--changed', 'docs/a.md']).status, 1);
  assert.equal(run(['run']).status, 64);
  fs.writeFileSync(path.join(root, 'gates.table.json'), '{bad');
  assert.equal(run(['run', '--step', 'B']).status, 65);
});

test('891dbac0 AC4 the check verb runs through the CLI with a real seeded violation and a baseline', () => {
  writeTable([{ id: 'G3', command: cmd(0), stage: 'B', mechanism: 'mechanical', seeded: { command: cmd(0) } }]);
  assert.equal(run(['check', 'teeth', '--report', 'check.json']).status, 1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'check.json'), 'utf8')).findings[0].key, 'teeth:G3');
  fs.writeFileSync(path.join(root, 'base.json'), JSON.stringify({ 'teeth:G3': true }));
  assert.equal(run(['check', 'teeth', '--baseline', 'base.json']).status, 0);
  writeTable([{ id: 'G3', command: cmd(0), stage: 'B', mechanism: 'mechanical', seeded: { command: cmd(1) } }]);
  assert.equal(run(['check', 'teeth', '--baseline', 'base.json']).status, 1, 'fixed finding leaves a stale baseline entry');
  assert.equal(run(['check', 'bogus']).status, 64);
});
