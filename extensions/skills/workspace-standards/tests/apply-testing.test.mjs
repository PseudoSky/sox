// 39a21823 T48.AC1 T48.AC2 T48.AC3 T48.AC4 T48.AC5 T48.AC6 T48.AC7 T48.AC8
// apply testing: the marker engine and the testing apply, driven on temp repositories only.
// Never touches this repository's AGENTS.md: AC7 applies to a COPY of it in a temp dir.
// The backlog filer is injected everywhere. Unit-only: nothing here spawns a process (the CLI/git runs are in foundations-e2e.test.mjs).
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { upsertBlock, inspectBlock, unifiedDiff, MarkerError, beginMarker, endMarker } from '../scripts/marker-engine.mjs';
import { applyTesting, EXIT, boundGates, backlogFiler } from '../scripts/apply-testing.mjs';
import { validateDeclaration, ownership, gatesOf, splitRow, escapeCell, ledgerRows, GATE_ID } from '../scripts/lib.mjs';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REAL_AGENTS = process.env.SOX_AGENTS_MD ?? path.resolve(SKILL, '../../../AGENTS.md');
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

  test('39a21823 AC3: a second run changes nothing and calls no filer', () => {
    const dir = repo({ 'AGENTS.md': HEAD });
    const filer = fakeFiler();
    applyTesting({ root: dir, filer });
    const before = read(dir, 'AGENTS.md');
    const again = fakeFiler();
    const r = applyTesting({ root: dir, filer: again });
    assert.deepEqual(r.wrote, []);
    assert.deepEqual(again.calls, []);
    assert.equal(read(dir, 'AGENTS.md'), before, 'byte-identical; the real `git diff --exit-code` check is in foundations-e2e.test.mjs');
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
    assert.match(r.diff, /^\+\+\+ b\/docs\/standards\/testing\.md$/m);
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

describe('39a21823 correction: literal ownership forms, write order, ledger drift, never-applied, capability row', () => {
  test('39a21823 AC2: the literal `gates: own` keeps the gate list (from gateList), renders the rows and files the mechanical gates', () => {
    const decl2 = decl({ gates: 'own', gateList: STD.gates });
    const j = JSON.parse(fs.readFileSync(decl2, 'utf8'));
    assert.equal(j.gates, 'own');
    assert.deepEqual(ownership(j), { routing: false, gates: true });
    assert.equal(gatesOf(j).length, STD.gates.length, 'the list survives the literal');
    const dir = repo({ 'AGENTS.md': HEAD });
    const filer = fakeFiler();
    const r = applyTesting({ root: dir, declarationPath: decl2, filer });
    const body = inspectBlock(read(dir, 'AGENTS.md'), 'testing-gates').body;
    for (const g of STD.gates) assert.match(body, new RegExp(`\\| ${g.id} \\|`), `row for ${g.id}`);
    assert.deepEqual(filer.calls.sort(), [...MECHANICAL].sort(), 'mechanical gates are still filed');
    assert.equal(r.exit, EXIT.OK);
  });
  test('39a21823 AC2: the literal `routing: own` plus `gates: own` writes both blocks; every spelling gives the same gates block', () => {
    const lit = repo({ 'AGENTS.md': HEAD });
    applyTesting({ root: lit, declarationPath: decl({ routing: 'own', gates: 'own', gateList: STD.gates }), noFile: true });
    const nested = repo({ 'AGENTS.md': HEAD });
    applyTesting({ root: nested, declarationPath: decl({ ownership: { routing: 'own', gates: 'own' } }), noFile: true });
    const list = repo({ 'AGENTS.md': HEAD });
    applyTesting({ root: list, declarationPath: decl({ own: ['routing', 'gates'] }), noFile: true });
    for (const t of ['testing-routing', 'testing-gates']) {
      const a = inspectBlock(read(lit, 'AGENTS.md'), t).body;
      assert.equal(inspectBlock(read(nested, 'AGENTS.md'), t).body, a, `${t}: literal equals ownership form`);
      assert.equal(inspectBlock(read(list, 'AGENTS.md'), t).body, a, `${t}: literal equals own[] form`);
    }
  });
  test('39a21823 AC2: `gates: own` without a gateList is rejected by the declaration check, never iterated as a string', () => {
    const base = { ...STD };
    assert.ok(validateDeclaration({ ...base, gates: 'own', gateList: STD.gates }).length === 0, 'literal with a list is valid');
    assert.ok(validateDeclaration({ ...base, gates: 'own' }).some((m) => /gateList/.test(m)), 'literal without a list is named');
    assert.ok(validateDeclaration({ ...base, routing: 'own' }).length === 0);
    assert.ok(validateDeclaration({ ...base, routing: 'yes' }).some((m) => /routing/.test(m)));
    assert.deepEqual(gatesOf({ gates: 'own' }), []);
  });

  test('39a21823 AC5: a write that fails before filing files nothing, so no item is orphaned', () => {
    const dir = repo({ docs: 'a file where the docs directory must go' });
    const filer = fakeFiler();
    assert.throws(() => applyTesting({ root: dir, filer }), /ENOTDIR|EEXIST|not a directory/i);
    assert.deepEqual(filer.calls, [], 'the filer was never reached');
    const after2 = fakeFiler();
    fs.rmSync(path.join(dir, 'docs'));
    applyTesting({ root: dir, filer: after2 });
    assert.deepEqual(after2.calls.sort(), [...MECHANICAL].sort(), 'the next clean run files each gate exactly once');
  });
  test('39a21823 AC5: a ledger write that fails after filing throws an error naming every uid it could not record', () => {
    const dir = repo({});
    const skeleton = path.join(dir, 'docs/standards/testing.md');
    let n2 = 0;
    const sabotage = (item) => {
      if (n2++ === 0) { fs.rmSync(skeleton); fs.mkdirSync(skeleton); } // the ledger write now hits a directory
      return `uid-${item.gate}`;
    };
    let err;
    try { applyTesting({ root: dir, filer: sabotage }); } catch (e) { err = e; }
    assert.ok(err, 'the failed ledger write is thrown, not swallowed');
    assert.equal(err.filed.length, MECHANICAL.length);
    for (const g of MECHANICAL) assert.ok(err.message.includes(`${g}=uid-${g}`), `message names ${g}`);
  });

  test('39a21823 AC4: a hand-edited ledger block is drift: it is not overwritten, nothing is filed, and --force replaces it', () => {
    const dir = repo({});
    applyTesting({ root: dir, filer: fakeFiler() });
    const p = path.join(dir, 'docs/standards/testing.md');
    const edited = fs.readFileSync(p, 'utf8').replace(/\| G2 \| checker for: [^|]*\|/, '| G2 | my own note |');
    assert.notEqual(edited, fs.readFileSync(p, 'utf8'), 'fixture edit applied');
    fs.writeFileSync(p, edited);
    const filer = fakeFiler();
    const r = applyTesting({ root: dir, filer });
    assert.equal(r.exit, EXIT.DRIFT);
    assert.ok(r.drift.some((d) => d.target === 'testing-mechanisms' && d.file === 'docs/standards/testing.md'));
    assert.equal(fs.readFileSync(p, 'utf8'), edited, 'the hand edit survives');
    assert.deepEqual(filer.calls, []);
    // a gate whose row was lost while the block is edited is not refiled either
    fs.writeFileSync(p, edited.replace(/^\| G3 \|.*\n/m, ''));
    const lost = fakeFiler();
    const r2 = applyTesting({ root: dir, filer: lost });
    assert.deepEqual(lost.calls, [], 'nothing filed while the ledger block drifts');
    assert.ok(r2.wouldFile.includes('G3') && r2.warnings.some((w) => /edited by hand/.test(w)));
    const chk = applyTesting({ root: dir, check: true });
    assert.equal(chk.exit, EXIT.DRIFT);
    const forced = applyTesting({ root: dir, force: true, filer: fakeFiler() });
    assert.equal(forced.exit, EXIT.OK);
    assert.ok(!fs.readFileSync(p, 'utf8').includes('my own note'), '--force replaces the ledger block');
  });

  test('39a21823 AC6: --check on a repository the standard was never applied to exits 5 (not 0), applied exits 0, drift still wins', () => {
    const none = repo({});
    const r = applyTesting({ root: none, check: true });
    assert.equal(r.exit, EXIT.NOT_APPLIED);
    assert.equal(EXIT.NOT_APPLIED, 5);
    assert.ok(r.missing.includes('AGENTS.md#testing') && r.missing.includes('docs/standards/testing.md'), `missing: ${r.missing}`);
    assert.match(r.diff, /^\+## Testing$/m, 'the diff is still shown');
    assert.deepEqual(r.wrote, []);
    assert.equal(applyTesting({ root: repo({ 'AGENTS.md': HEAD }), check: true }).exit, EXIT.NOT_APPLIED, 'AGENTS.md without the block');
    assert.equal(applyTesting({ root: none, dryRun: true }).exit, EXIT.OK, 'dry-run is not a review');
    const applied = repo({});
    applyTesting({ root: applied, filer: fakeFiler() });
    const ok = applyTesting({ root: applied, check: true });
    assert.equal(ok.exit, EXIT.OK);
    assert.deepEqual(ok.missing, []);
    fs.writeFileSync(path.join(applied, 'AGENTS.md'), read(applied, 'AGENTS.md').replace('Default test tier is S', 'Default test tier is Z'));
    assert.equal(applyTesting({ root: applied, check: true }).exit, EXIT.DRIFT);
  });

  test('39a21823 AC7: an existing Capabilities table is left byte-identical; the row stays once, inside the block, with a warning', () => {
    const table = '## Capabilities\n\n| capability | tool | usage |\n|---|---|---|\n| backlog | backlog | `backlog` skill |\n';
    const dir = repo({ 'AGENTS.md': `${HEAD}\n${table}` });
    const r = applyTesting({ root: dir, noFile: true });
    const after2 = read(dir, 'AGENTS.md');
    assert.ok(after2.startsWith(`${HEAD}\n${table}`), 'text outside the markers is byte-identical');
    assert.equal((after2.match(/\| test-routing \|/g) ?? []).length, 1, 'exactly one test-routing row');
    assert.match(inspectBlock(after2, 'testing').body, /\| test-routing \| workspace-standards \|/);
    assert.ok(r.warnings.some((w) => /Capabilities table/.test(w)), `warnings: ${r.warnings}`);
    assert.equal(applyTesting({ root: repo({ 'AGENTS.md': HEAD }), noFile: true }).warnings.some((w) => /Capabilities table/.test(w)), false, 'no warning without a table');
    assert.deepEqual(applyTesting({ root: dir, noFile: true }).wrote, [], 'idempotent with the table present');
  });

  test('39a21823 AC8: a repository name containing $& or $1 lands verbatim in the skeleton', () => {
    const dir = path.join(tmp, 'we$&ird$1-repo');
    fs.mkdirSync(dir, { recursive: true });
    applyTesting({ root: dir, noFile: true });
    const skeleton = read(dir, 'docs/standards/testing.md');
    assert.match(skeleton, /Testing IMPLEMENTATION — we\$&ird\$1-repo/);
    assert.ok(!skeleton.includes('<repository>'));
  });
});

describe('39a21823 correction: ledger round trip (escaped pipes, any gate id) and filer line guard', () => {
  const GATE_LIST = [
    { id: 'T1.lint', mechanism: 'mechanical', stage: ['D'], threshold: 'exit 0 | no warnings' },
    { id: 'G2', mechanism: 'mechanical', stage: ['D'], threshold: 'a \\| b and a\\c' },
  ];
  const gatesDecl = () => decl({ gates: 'own', gateList: GATE_LIST });

  test('39a21823 AC4: escapeCell and splitRow are exact inverses over `|`, `\\|` and backslashes', () => {
    for (const v of ['plain', 'a | b', 'a \\| b', 'trail\\', '\\\\|x||', 'a\\\\', '']) {
      assert.deepEqual(splitRow(`| ${escapeCell(v)} | k | u |`), [v.replace(/\s+/g, ' ').trim(), 'k', 'u'], JSON.stringify(v));
    }
    assert.equal(splitRow('not a row'), null);
    assert.equal(splitRow('| unterminated'), null);
  });

  test('39a21823 AC4: a pipe or `\\|` in a gate threshold round-trips through the ledger: the row is read back and a re-run files nothing', () => {
    const dir = repo({});
    const declPath = gatesDecl();
    const first = fakeFiler();
    applyTesting({ root: dir, declarationPath: declPath, filer: first });
    assert.deepEqual(first.calls.sort(), ['G2', 'T1.lint']);
    const skeleton = read(dir, 'docs/standards/testing.md');
    const rows = ledgerRows(skeleton, 'testing-mechanisms');
    assert.deepEqual([...rows].sort(), [['G2', 'uid-G2'], ['T1.lint', 'uid-T1.lint']]);
    assert.ok(skeleton.includes('exit 0 \\| no warnings'), 'the pipe is written escaped');
    const again = fakeFiler();
    const r = applyTesting({ root: dir, declarationPath: declPath, filer: again });
    assert.deepEqual(again.calls, [], 'no duplicate backlog item is filed on re-run');
    assert.deepEqual(r.wrote, []);
    assert.equal(r.exit, EXIT.OK, 'the ledger it wrote is not read as drift');
  });

  test('39a21823 AC4: a gate id outside G\\d+ (T1.lint) is read back from the ledger, never refiled', () => {
    assert.ok(GATE_ID.test('T1.lint') && GATE_ID.test('G12') && !GATE_ID.test('-x') && !GATE_ID.test('a b'));
    const dir = repo({});
    const declPath = gatesDecl();
    applyTesting({ root: dir, declarationPath: declPath, filer: fakeFiler() });
    const again = fakeFiler();
    applyTesting({ root: dir, declarationPath: declPath, filer: again });
    assert.ok(!again.calls.includes('T1.lint'));
  });

  test('39a21823 AC5: backlogFiler skips stdout lines that parse to null, a number or a string, and still finds the uid', () => {
    const f = backlogFiler({ project: 'p', run: () => 'null\n42\n"str"\ntrue\n{"ok":true,"data":{"uid":"u-9"}}\nnull\n' });
    assert.equal(f({ title: 't', body: 'b' }), 'u-9');
    const none = backlogFiler({ project: 'p', run: () => 'null\n7\n' });
    assert.throws(() => none({ title: 't', body: 'b' }), /no uid/);
  });
});
