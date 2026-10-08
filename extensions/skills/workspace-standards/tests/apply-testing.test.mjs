// 39a21823 T48.AC1 T48.AC2 T48.AC3 T48.AC4 T48.AC5 T48.AC6 T48.AC7 T48.AC8
// apply testing: the marker engine and the testing apply, driven on temp repositories only.
// Never touches this repository's AGENTS.md: AC7 applies to a COPY of it in a temp dir.
// The backlog filer is injected everywhere except the CLI runs, which pass --no-file.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { upsertBlock, inspectBlock, unifiedDiff, MarkerError, beginMarker, endMarker } from '../scripts/marker-engine.mjs';
import { applyTesting, EXIT, boundGates, backlogFiler } from '../scripts/apply-testing.mjs';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_AGENTS = process.env.SOX_AGENTS_MD ?? path.resolve(SKILL, '../../../AGENTS.md');
const CLI = path.join(SKILL, 'scripts', 'apply-testing.mjs');
const STD = JSON.parse(fs.readFileSync(path.join(SKILL, 'standards/testing/standard.json'), 'utf8'));
let tmp;
let n = 0;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-apply-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const repo = (files = {}) => {
  const dir = path.join(tmp, `repo-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  }
  return dir;
};
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));
const decl = (extra) => {
  const p = path.join(tmp, `decl-${n++}.json`);
  fs.writeFileSync(p, JSON.stringify({ ...STD, ...extra }));
  return p;
};
const fakeFiler = () => {
  const calls = [];
  const f = (item) => { calls.push(item.gate); return `uid-${item.gate}`; };
  f.calls = calls;
  return f;
};
const MECHANICAL = STD.gates.filter((g) => g.mechanism === 'mechanical').map((g) => g.id);
const cli = (dir, ...args) => spawnSync(process.execPath, [CLI, '--root', dir, ...args], { encoding: 'utf8' });
const git = (dir, ...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, encoding: 'utf8' });
const HEAD = '# My repo\n\nSome prose.\n';

describe('marker engine', () => {
  test('39a21823 AC1: creates the pair when absent, appending after the existing text', () => {
    const r = upsertBlock(HEAD, 'testing', 'body');
    assert.equal(r.action, 'created');
    assert.equal(r.text, `${HEAD}\n${beginMarker('testing')}\nbody\n${endMarker('testing')}\n`);
    assert.equal(upsertBlock('', 'x', 'b').text, `${beginMarker('x')}\nb\n${endMarker('x')}\n`);
  });
  test('39a21823 AC3: an equal block is unchanged byte for byte', () => {
    const once = upsertBlock(HEAD, 'testing', 'body').text;
    const twice = upsertBlock(once, 'testing', 'body');
    assert.equal(twice.action, 'unchanged');
    assert.equal(twice.text, once);
  });
  test('39a21823 AC4: a differing block is drift and the text is returned untouched; force replaces only the block', () => {
    const once = upsertBlock(`${HEAD}`, 'testing', 'body').text;
    const edited = once.replace('body', 'body HAND EDIT') + 'tail\n';
    const d = upsertBlock(edited, 'testing', 'body');
    assert.equal(d.action, 'drift');
    assert.equal(d.text, edited);
    assert.match(d.current, /HAND EDIT/);
    const f = upsertBlock(edited, 'testing', 'body', { force: true });
    assert.equal(f.action, 'replaced');
    assert.equal(f.text, once + 'tail\n');
  });
  test('39a21823 AC1: unpaired, duplicated, reversed markers and bad targets are refused', () => {
    const b = beginMarker('testing');
    const e = endMarker('testing');
    for (const bad of [`${b}\nx`, `${e}\n${b}`, `${b}\n${e}\n${b}\n${e}`]) {
      assert.throws(() => inspectBlock(bad, 'testing'), MarkerError);
    }
    assert.throws(() => beginMarker('Bad:Target'), MarkerError);
  });
  test('39a21823 AC6: unifiedDiff is empty for equal text and marks added and removed lines', () => {
    assert.equal(unifiedDiff('f', 'a\nb', 'a\nb'), '');
    const d = unifiedDiff('f', 'a\nb', 'a\nc');
    assert.match(d, /^-b$/m);
    assert.match(d, /^\+c$/m);
  });
  test('39a21823 AC1: markers of different targets do not collide (testing vs testing-routing vs hand-maintained)', () => {
    let t = upsertBlock('', 'testing', 'A').text;
    t = upsertBlock(t, 'testing-routing', 'B').text;
    assert.equal(inspectBlock(t, 'testing').body, 'A');
    assert.equal(inspectBlock(t, 'testing-routing').body, 'B');
  });
});

describe('apply testing', () => {
  test('39a21823 AC1: writes the testing block, capability row and class table between the markers; skeleton to the binding path; touches nothing else', () => {
    const dir = repo({ 'AGENTS.md': HEAD, 'docs/testing/STRATEGY.md': 'policy' });
    const r = applyTesting({ root: dir, filer: fakeFiler() });
    assert.equal(r.exit, EXIT.OK);
    const agents = read(dir, 'AGENTS.md');
    assert.ok(agents.startsWith(HEAD), 'text outside the markers is preserved');
    const body = inspectBlock(agents, 'testing').body;
    const narrative = body.split('\n').slice(0, body.split('\n').findIndex((l) => l.startsWith('|'))).filter((l) => l.trim() !== '');
    assert.ok(narrative.length <= 12 && narrative.length >= 3, `testing block is ${narrative.length} lines`);
    assert.match(body, /\| test-routing \| workspace-standards \|/);
    for (const c of STD.workClasses) assert.match(body, new RegExp(`\\| ${c.id} \\| ${c.defaultRigor} \\|`));
    assert.ok(!/\{\{/.test(agents), 'no unfilled placeholder');
    const skeleton = read(dir, 'docs/standards/testing.md');
    assert.match(skeleton, /## Binding table/);
    assert.match(skeleton, /Testing IMPLEMENTATION — repo-/);
    assert.ok(!exists(dir, 'docs/standards/testing-roles.md'));
    assert.equal(inspectBlock(agents, 'testing-routing').found, false);
    assert.equal(inspectBlock(agents, 'testing-gates').found, false);
  });

  describe('AC2 routing and gates only when the declaration owns them', () => {
    const outcomes = [
      ['neither', {}, false, false],
      ['routing: own', { routing: 'own' }, true, false],
      ['gates: own', { ownership: { gates: 'own' } }, false, true],
      ['both own', { ownership: { routing: 'own', gates: 'own' } }, true, true],
    ];
    for (const [name, extra, routing, gates] of outcomes) {
      test(`39a21823 AC2: ${name}`, () => {
        const dir = repo({ 'AGENTS.md': HEAD });
        const r = applyTesting({ root: dir, declarationPath: decl(extra), filer: fakeFiler() });
        const agents = read(dir, 'AGENTS.md');
        assert.equal(inspectBlock(agents, 'testing-routing').found, routing);
        assert.equal(exists(dir, 'docs/standards/testing-roles.md'), routing);
        assert.equal(inspectBlock(agents, 'testing-gates').found, gates);
        assert.equal(r.skipped.length, (routing ? 0 : 1) + (gates ? 0 : 1));
        if (routing) assert.match(inspectBlock(agents, 'testing-routing').body, /\| classifier \|/);
        if (gates) assert.match(inspectBlock(agents, 'testing-gates').body, /\| G12 \|/);
      });
    }
  });

  test('39a21823 AC3: a second run changes nothing, calls no filer, and git diff --exit-code exits 0', () => {
    const dir = repo({ 'AGENTS.md': HEAD });
    const filer = fakeFiler();
    applyTesting({ root: dir, filer });
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'first');
    const again = fakeFiler();
    const r = applyTesting({ root: dir, filer: again });
    assert.deepEqual(r.wrote, []);
    assert.deepEqual(again.calls, []);
    assert.equal(git(dir, 'diff', '--exit-code').status, 0);
    assert.equal(git(dir, 'status', '--porcelain').stdout, '');
  });

  test('39a21823 AC3: the CLI twice leaves git diff --exit-code at 0', () => {
    const dir = repo({ 'AGENTS.md': HEAD });
    assert.equal(cli(dir, '--no-file').status, 0);
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'first');
    assert.equal(cli(dir, '--no-file').status, 0);
    assert.equal(git(dir, 'diff', '--exit-code').status, 0);
  });

  test('39a21823 AC4: a hand edit inside the block is drift (check and apply), not overwritten, until --force', () => {
    const dir = repo({ 'AGENTS.md': HEAD });
    applyTesting({ root: dir, filer: fakeFiler() });
    const edited = read(dir, 'AGENTS.md').replace('Default test tier is S', 'Default test tier is Z');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), edited);
    const chk = applyTesting({ root: dir, check: true });
    assert.equal(chk.exit, EXIT.DRIFT);
    assert.equal(chk.drift[0].target, 'testing');
    assert.match(chk.drift[0].diff, /^-.*tier is Z/m);
    const run = applyTesting({ root: dir, filer: fakeFiler() });
    assert.equal(run.exit, EXIT.DRIFT);
    assert.equal(read(dir, 'AGENTS.md'), edited, 'not overwritten');
    const viaCli = cli(dir, '--check');
    assert.equal(viaCli.status, EXIT.DRIFT);
    assert.match(viaCli.stderr, /DRIFT AGENTS\.md \[testing\]/);
    const forced = applyTesting({ root: dir, force: true, filer: fakeFiler() });
    assert.equal(forced.exit, EXIT.OK);
    assert.match(read(dir, 'AGENTS.md'), /tier is S/);
  });

  describe('AC5 mechanisms it cannot write become backlog items', () => {
    test('39a21823 AC5: one item per mechanical gate with no binding, recorded in the ledger; review gates are not filed', () => {
      const dir = repo({});
      const filer = fakeFiler();
      const r = applyTesting({ root: dir, filer });
      assert.deepEqual(filer.calls, MECHANICAL);
      assert.ok(!filer.calls.includes('G6') && !filer.calls.includes('G11'));
      assert.equal(r.filed.length, MECHANICAL.length);
      const skeleton = read(dir, 'docs/standards/testing.md');
      assert.equal(inspectBlock(skeleton, 'testing-mechanisms').body.split('\n').filter((l) => /^\| G\d+ /.test(l)).length, MECHANICAL.length);
      assert.match(skeleton, /\| G1 \| checker for: .* \| uid-G1 \|/);
      const second = fakeFiler();
      applyTesting({ root: dir, filer: second });
      assert.deepEqual(second.calls, [], 'a filed gate is never filed twice');
    });
    test('39a21823 AC5: a gate bound in the filled table is not filed', () => {
      const dir = repo({});
      applyTesting({ root: dir, noFile: true });
      const p = path.join(dir, 'docs/standards/testing.md');
      fs.writeFileSync(p, fs.readFileSync(p, 'utf8').replace('| G1 | <tool or script> |', '| G1 | scripts/check-g1.sh |'));
      assert.ok(boundGates(read(dir, 'docs/standards/testing.md')).has('G1'));
      const filer = fakeFiler();
      applyTesting({ root: dir, filer });
      assert.ok(!filer.calls.includes('G1'));
      assert.equal(filer.calls.length, MECHANICAL.length - 1);
    });
    test('39a21823 AC5: a filer failure is reported (exit 4), not recorded, and retried on the next run', () => {
      const dir = repo({});
      const flaky = (item) => { if (item.gate === 'G2') throw new Error('backlog down'); return `uid-${item.gate}`; };
      const r = applyTesting({ root: dir, filer: flaky });
      assert.equal(r.exit, EXIT.FILING);
      assert.equal(r.failed[0].gate, 'G2');
      assert.ok(!/\| G2 \| checker/.test(read(dir, 'docs/standards/testing.md')));
      const retry = fakeFiler();
      applyTesting({ root: dir, filer: retry });
      assert.deepEqual(retry.calls, ['G2']);
    });
    test('39a21823 AC5: the default filer calls the backlog CLI create verb and reads the uid; a refusal throws', () => {
    const seen = [];
    const ok = backlogFiler({ project: 'p', run: (args) => { seen.push(args); return '{"level":30,"msg":"x"}\n{"ok":true,"data":{"uid":"abc-123"}}\n'; } });
    assert.equal(ok({ title: 't', body: 'b' }), 'abc-123');
    assert.deepEqual(seen[0].slice(0, 3), ['backlog', 'create', '--input']);
    assert.deepEqual(JSON.parse(seen[0][3]), { title: 't', body: 'b', project: 'p', by: 'workspace-standards-apply' });
    const refused = backlogFiler({ project: 'p', run: () => '{"ok":false,"error":{"code":"duplicate"}}\n' });
    assert.throws(() => refused({ title: 't', body: 'b' }), /refused/);
    const empty = backlogFiler({ project: 'p', run: () => 'noise\n' });
    assert.throws(() => empty({ title: 't', body: 'b' }), /no uid/);
  });
  test('39a21823 AC5: the item carries a title naming the gate and a Citations block', () => {
      const dir = repo({});
      const items = [];
      applyTesting({ root: dir, filer: (i) => { items.push(i); return 'u'; } });
      assert.match(items[0].title, /G1/);
      assert.match(items[0].body, /Citations: \[/);
    });
  });

  test('39a21823 AC6: dry-run prints the diff and writes nothing (library and CLI)', () => {
    const dir = repo({ 'AGENTS.md': HEAD });
    const filer = fakeFiler();
    const r = applyTesting({ root: dir, dryRun: true, filer });
    assert.deepEqual(r.wrote, []);
    assert.deepEqual(filer.calls, []);
    assert.match(r.diff, /^\+## Testing$/m);
    assert.equal(read(dir, 'AGENTS.md'), HEAD);
    assert.ok(!exists(dir, 'docs'));
    const fresh = repo({});
    const out = cli(fresh, '--dry-run');
    assert.equal(out.status, 0, out.stderr);
    assert.match(out.stdout, /^\+## Testing$/m);
    assert.match(out.stdout, /^\+\+\+ b\/docs\/standards\/testing\.md$/m);
    assert.deepEqual(fs.readdirSync(fresh), [], 'nothing written');
  });

  test('39a21823 AC7: runs unchanged on a fixture repository with no AGENTS.md', () => {
    const dir = repo({});
    const r = applyTesting({ root: dir, filer: fakeFiler() });
    assert.equal(r.exit, EXIT.OK);
    assert.equal(inspectBlock(read(dir, 'AGENTS.md'), 'testing').found, true);
    assert.deepEqual(applyTesting({ root: dir, filer: fakeFiler() }).wrote, []);
  });

  test('39a21823 AC7: runs unchanged on a copy of sox-ecosystem AGENTS.md and leaves everything outside the block identical', () => {
    const original = fs.readFileSync(REAL_AGENTS, 'utf8');
    assert.match(original, /gitnexus:start/, 'fixture is the real sox-ecosystem AGENTS.md');
    const dir = repo({ 'AGENTS.md': original });
    const r = applyTesting({ root: dir, filer: fakeFiler() });
    assert.equal(r.exit, EXIT.OK);
    const after = read(dir, 'AGENTS.md');
    assert.ok(after.startsWith(original), 'every original byte kept in place');
    assert.equal(after.slice(original.length).trim().split('\n')[0], beginMarker('testing'));
    assert.equal(inspectBlock(after, 'testing').found, true);
    const again = applyTesting({ root: dir, filer: fakeFiler() });
    assert.deepEqual(again.wrote, []);
    assert.equal(read(dir, 'AGENTS.md'), after);
    assert.equal(fs.readFileSync(REAL_AGENTS, 'utf8'), original, 'the real file is never rewritten');
  });

  test('39a21823 AC8: a filled-in binding table and every hand edit outside the ledger survive a second run untouched', () => {
    const dir = repo({});
    applyTesting({ root: dir, filer: fakeFiler() });
    const p = path.join(dir, 'docs/standards/testing.md');
    const filled = fs.readFileSync(p, 'utf8')
      .replace('| G1 | <tool or script> | <value> | <stage> | <owner> | gate / obligation, not yet a gate |', '| G1 | scripts/g1.sh | 100% | D | qa | gate |\n| G2 | scripts/g2.sh | 100% | D | qa | gate |')
      .replace('1. Tier mapping: <mechanism per tier S, P, H, X; budgets; source of truth for tier membership>', '1. Tier mapping: S runs in node --test.');
    assert.ok(filled.includes('scripts/g1.sh') && filled.includes('S runs in node'), 'fixture edit applied');
    fs.writeFileSync(p, filled);
    const r = applyTesting({ root: dir, filer: fakeFiler() });
    assert.deepEqual(r.wrote, []);
    assert.equal(fs.readFileSync(p, 'utf8'), filled);
    const viaForce = applyTesting({ root: dir, force: true, filer: fakeFiler() });
    assert.equal(fs.readFileSync(p, 'utf8'), filled, 'even --force never overwrites the skeleton');
    assert.deepEqual(viaForce.created, []);
  });

  test('39a21823 AC8: an existing skeleton that has the table but no ledger gains only the ledger block', () => {
    const dir = repo({});
    applyTesting({ root: dir, noFile: true });
    const p = path.join(dir, 'docs/standards/testing.md');
    const before = fs.readFileSync(p, 'utf8');
    applyTesting({ root: dir, filer: fakeFiler() });
    const after = fs.readFileSync(p, 'utf8');
    assert.ok(after.startsWith(before.replace(/\n+$/, '')), 'original content kept in place');
    assert.equal(inspectBlock(after, 'testing-mechanisms').found, true);
  });
});
