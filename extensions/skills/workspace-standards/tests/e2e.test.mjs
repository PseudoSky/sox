// E2E-ONLY: this file spawns child processes by design; the unit suite (unit.test.mjs) spawns nothing.
// End-to-end test for workspace-standards (item 9024e9ac, T14).
// One run, one shared scaffold: the skill directory is copied once into a temp dir and every
// surface (ws.mjs verbs and errors, review-all, review-routing, conformance, card sizes) is driven
// from that copy as a consumer runs it, through real child processes. Nothing is mocked here: this
// is the layer that proves the scripts work as installed. Duration is printed at the end and
// asserted under a ceiling. The policy document is a required input: STRATEGY_PATH (default
// /Users/nix/dev/node/adhd/docs/testing/STRATEGY.md). A missing policy FAILS the run; it never skips.
import test, { before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STRATEGY = process.env.STRATEGY_PATH ?? '/Users/nix/dev/node/adhd/docs/testing/STRATEGY.md';
const CEILING_MS = 30_000;
const started = Date.now();
let scaffold;
let n = 0;

const run = (script, args = [], root = scaffold) =>
  spawnSync(process.execPath, [path.join(root, 'scripts', script), ...args], { encoding: 'utf8' });
const clone = () => {
  const dir = path.join(scaffold, '..', `scaffold-mut-${n++}`);
  fs.cpSync(scaffold, dir, { recursive: true });
  return dir;
};

before(() => {
  assert.ok(fs.existsSync(STRATEGY), `policy input missing: set STRATEGY_PATH (looked for ${STRATEGY})`);
  scaffold = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-e2e-')) + '/skill';
  fs.cpSync(SRC, scaffold, { recursive: true });
});
after(() => {
  const ms = Date.now() - started;
  fs.rmSync(path.dirname(scaffold), { recursive: true, force: true });
  for (let i = 0; i < n; i++) fs.rmSync(path.join(path.dirname(scaffold), `scaffold-mut-${i}`), { recursive: true, force: true });
  console.log(`e2e duration_ms=${ms} (ceiling ${CEILING_MS})`);
  assert.ok(ms < CEILING_MS, `e2e took ${ms} ms, ceiling ${CEILING_MS}`);
});

describe('9024e9ac T14 e2e on one scaffold', () => {
  test('9024e9ac T14.AC3 ws.mjs resolves every verb and names every error with its exit code', () => {
    const ok = run('ws.mjs', ['review', 'testing']);
    assert.equal(ok.status, 0);
    assert.ok(fs.existsSync(JSON.parse(ok.stdout).path));
    assert.equal(JSON.parse(run('ws.mjs', ['run', 'testing', '--mode', 'retention-audit']).stdout).playbook, 'standards/testing/playbooks/retention-audit.md');
    const cases = [
      [['run', 'nope'], 2, 'E_UNKNOWN_TARGET'],
      [['run', 'all'], 3, 'E_UNSUPPORTED_VERB'],
      [['frob', 'testing'], 4, 'E_UNKNOWN_VERB'],
      [['apply', 'styling'], 5, 'E_PLANNED_TARGET'],
      [['run', 'gates', '--mode', 'x'], 6, 'E_UNSUPPORTED_MODE'],
      [['run'], 64, 'E_USAGE'],
      [['run', 'testing', '--mode'], 64, 'E_USAGE'],
      [['run', 'testing', '--root'], 64, 'E_USAGE'],
      [['review', 'all', '--mode', 'retention-audit'], 64, 'E_USAGE'],
    ];
    for (const [args, status, code] of cases) {
      const r = run('ws.mjs', args);
      assert.equal(r.status, status, args.join(' '));
      assert.equal(JSON.parse(r.stderr).error.code, code);
      assert.equal(r.stdout, '', 'an error never prints a playbook');
    }
  });

  test('9024e9ac T14.AC1 T14.AC8 review all: real registry exits 1 on its planned standards, --allow-planned exits 0', () => {
    const strict = run('review-all.mjs');
    assert.equal(strict.status, 1);
    const targets = new Set(JSON.parse(strict.stdout).findings.map((f) => f.target));
    assert.deepEqual([...targets].sort(), ['deployment', 'documentation', 'implementation', 'organization', 'styling']);
    assert.equal(run('review-all.mjs', ['--allow-planned']).status, 0);
  });

  test('9024e9ac T14.AC8 negative controls: complete=0, seeded planned standard=1, incomplete=1 even with --allow-planned', () => {
    const fx = (name) => path.join(scaffold, 'fixtures/review-all', name);
    assert.equal(run('review-all.mjs', ['--root', fx('complete')]).status, 0);
    const seeded = run('review-all.mjs', ['--root', fx('seeded-planned')]);
    assert.equal(seeded.status, 1);
    assert.ok(JSON.parse(seeded.stdout).findings.some((f) => f.target === 'seeded-planned-standard' && f.id === 'planned-standard'));
    const inc = run('review-all.mjs', ['--root', fx('incomplete'), '--allow-planned']);
    assert.equal(inc.status, 1);
    assert.deepEqual(JSON.parse(inc.stdout).findings.map((f) => f.id).sort(), ['missing-apply-template', 'missing-conformance-spec', 'missing-playbook']);
  });

  test('9024e9ac T14.AC10 review-routing: ok fixture 0, missing/unknown fixture 1, real agents 1 naming every agent', () => {
    const roles = path.join(scaffold, 'fixtures/routing/roles-no-hints.md');
    const realRoles = path.join(scaffold, 'standards/testing/roles.md');
    const fx = (name) => path.join(scaffold, 'fixtures/routing', name);
    const ghost = run('review-routing.mjs', ['--agents-dir', fx('agents-ok'), '--roles', fx('roles-ghost-hint.md')]);
    assert.equal(ghost.status, 1);
    assert.ok(JSON.parse(ghost.stdout).findings.some((f) => f.id === 'unresolved-hint'));
    assert.equal(run('review-routing.mjs', ['--agents-dir', fx('agents-ok'), '--roles', roles]).status, 0);
    const bad = run('review-routing.mjs', ['--agents-dir', fx('agents-missing'), '--roles', roles]);
    assert.equal(bad.status, 1);
    const rep = JSON.parse(bad.stdout);
    assert.deepEqual(rep.findings.filter((f) => f.id === 'no-roles-covered-declaration').map((f) => f.agent).sort(), ['nocaps', 'nodecl']);
    assert.deepEqual(rep.findings.filter((f) => f.id === 'unknown-obligation-id').map((f) => f.agent), ['badid']);
    const realDir = path.resolve(SRC, '..', '..', 'agents');
    if (fs.existsSync(realDir)) {
      const real = run('review-routing.mjs', ['--agents-dir', realDir, '--roles', realRoles]);
      const dirs = fs.readdirSync(realDir, { withFileTypes: true }).filter((d) => d.isDirectory() && fs.existsSync(path.join(realDir, d.name, 'extension.json'))).length;
      const missing = JSON.parse(real.stdout).findings.filter((f) => f.id === 'no-roles-covered-declaration').length;
      assert.equal(real.status, missing === 0 ? 0 : 1);
      assert.equal(missing, dirs - JSON.parse(real.stdout).agents.filter((a) => a.covered.length > 0).length);
    }
    assert.equal(run('review-routing.mjs', ['--agents-dir', fx('agents-ok')]).status, 64);
    // A flag whose value is missing must not swallow the next flag as its value.
    for (const argv of [['--agents-dir', '--roles', roles], ['--agents-dir', fx('agents-ok'), '--roles'], ['--roles', '--agents-dir', fx('agents-ok')]]) {
      const r = run('review-routing.mjs', argv);
      assert.equal(r.status, 64, argv.join(' '));
      assert.equal(JSON.parse(r.stderr).error.code, 'E_USAGE');
      assert.equal(r.stdout, '');
    }
  });

  test('9024e9ac T14.AC10 review-routing: a null / non-object manifest is a named per-file finding, never E_INTERNAL', () => {
    const dir = path.join(scaffold, '..', 'agents-nonobject');
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, body] of [['nullmf', 'null'], ['arrmf', '[]'], ['strmf', '"x"'], ['good', JSON.stringify({ id: 'good', type: 'agent', capabilities: ['roles-covered:AU.1'] })]]) {
      fs.mkdirSync(path.join(dir, name), { recursive: true });
      fs.writeFileSync(path.join(dir, name, 'extension.json'), body);
    }
    const roles = path.join(scaffold, 'fixtures/routing/roles-no-hints.md');
    const r = run('review-routing.mjs', ['--agents-dir', dir, '--roles', roles]);
    assert.equal(r.status, 1, r.stderr);
    assert.equal(r.stderr.includes('E_INTERNAL'), false);
    const rep = JSON.parse(r.stdout);
    assert.deepEqual(rep.findings.filter((f) => f.id === 'malformed-manifest').map((f) => f.agent).sort(), ['arrmf', 'nullmf', 'strmf']);
  });

  test('9024e9ac T14.AC4 T14.AC5 T14.AC6 T14.AC7 conformance against the real policy exits 0', () => {
    const r = run('conformance.mjs', ['testing', '--strategy', STRATEGY]);
    assert.equal(r.status, 0, r.stdout);
    const rep = JSON.parse(r.stdout);
    assert.equal(rep.checks.length, 7);
    assert.match(rep.strategy, /checked against the provided policy/);
    const noPolicy = JSON.parse(run('conformance.mjs', ['testing']).stdout);
    assert.match(noPolicy.strategy, /not provided/);
  });

  test('9024e9ac T14.AC4 T14.AC5 T14.AC6 T14.AC7 conformance has teeth: each seeded defect turns its check red', () => {
    const mutate = (rel, fn) => {
      const root = clone();
      const file = path.join(root, 'standards/testing', rel);
      const before = fs.readFileSync(file, 'utf8');
      const after = fn(before);
      assert.notEqual(after, before, `mutation of ${rel} changed nothing`);
      fs.writeFileSync(file, after);
      return root;
    };
    const cases = [
      ['C5', 'cards/role/auditor.md', (t) => t + 'x'.repeat(4200)],
      ['C5', 'cards/role/triager.md', (t) => t + '\nSee D23.\n'],
      ['C5', 'cards/role/classifier.md', (t) => t.replace('§6.1.1', '§99.9')],
      ['C5', 'cards/test-author/maintain.md', (t) => t.replace('TA.', 'ZZ.')],
      ['C6', 'playbooks/flake-triage.md', (t) => t + '\n## Notes\nx\n'],
      ['C7', 'formats/escape-record.md', (t) => t.replaceAll('`lowest-tier`', 'lowest tier')],
      ['C2', 'roles.md', (t) => t.replace('- tools: read, backlog\n', '- tools: read, telepathy\n')],
      ['C3', 'standard.json', (t) => t.replace('"G7": "check",', '')],
      ['C1', 'standard.json', (t) => t.replace('"workClasses"', '"workKlasses"')],
    ];
    for (const [check, rel, fn] of cases) {
      const root = mutate(rel, fn);
      const r = run('conformance.mjs', ['testing', '--strategy', STRATEGY, '--root', root], root);
      assert.equal(r.status, 1, `${rel} should fail`);
      const failed = JSON.parse(r.stdout).checks.filter((c) => !c.ok).map((c) => c.id);
      assert.ok(failed.includes(check), `${rel}: expected ${check} red, got ${failed}`);
    }
  });
});
