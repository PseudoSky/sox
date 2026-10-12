// Unit tests for workspace-standards (item 9024e9ac, T14).
// Every test name carries "9024e9ac T14.AC<n>". The units under test are pure functions over
// strings and the filesystem: nothing here spawns a process or touches the network, so there is
// no process-spawning or network library to mock.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SKILL_ROOT, loadRegistry, resolveVerb, reviewAll, reviewAllExit, parseRoles, validateRoles, obligationIds,
  parseStrategy, checkCard, endsInRecord, missingFormatFields, validateDeclaration, reviewRouting, loadAgents,
  readJson, readText, expandRanges, takeOption,
} from '../scripts/lib.mjs';

const std = path.join(SKILL_ROOT, 'standards/testing');
const MINI_STRATEGY = parseStrategy('## 6. X\n### 6.1 Y\n**P3 — a** b\n| G9 | gate |\n| R3 | q |\n## 14. Z\n');

test('9024e9ac T14.AC1 registry lists foundations routing+gates and testing active, others planned', () => {
  const r = loadRegistry();
  assert.deepEqual(r.foundations.map((f) => f.id), ['routing', 'gates']);
  const byId = Object.fromEntries(r.standards.map((s) => [s.id, s.status]));
  assert.equal(byId.testing, 'active');
  for (const id of ['deployment', 'implementation', 'documentation', 'organization', 'styling']) assert.equal(byId[id], 'planned');
  const ids = [...r.foundations, ...r.standards].map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length, 'target ids are unique');
});

test('9024e9ac T14.AC2 the contract document names every required item', () => {
  const c = readText(path.join(SKILL_ROOT, 'CONTRACT.md'));
  for (const needle of ['names no agent', 'obligations', 'tools', 'distinctFrom', 'workClasses', 'gates', 'threshold', 'mechanism', 'stage', 'carrier', 'conformance', '`apply` template', 'routing: own', 'gates: own']) {
    assert.ok(c.includes(needle), `CONTRACT.md lacks "${needle}"`);
  }
});

test('9024e9ac T14.AC2 the testing declaration validates; seeded defects are findings', () => {
  const decl = readJson(path.join(std, 'standard.json'));
  assert.deepEqual(validateDeclaration(decl), []);
  const noGates = { ...decl };
  delete noGates.gates;
  assert.ok(validateDeclaration(noGates).some((f) => f.includes('gates')));
  assert.ok(validateDeclaration({ ...decl, own: ['nothing'] }).length > 0);
  assert.ok(validateDeclaration({ ...decl, carriers: { P1: 'vibes' } }).some((f) => f.includes('vibes')));
  assert.ok(validateDeclaration({ ...decl, gates: [{ id: 'G1', threshold: 't', mechanism: 'mechanical', stage: ['Z'] }] }).some((f) => f.includes('stage')));
  assert.ok(validateDeclaration({ ...decl, own: ['routing', 'gates'] }).length === 0, 'routing: own and gates: own are accepted');
});

test('9024e9ac T14.AC3 resolveVerb loads the playbook for every verb of every active target', () => {
  for (const target of ['routing', 'gates', 'testing']) {
    for (const verb of ['review', 'run', 'apply']) {
      const r = resolveVerb({ verb, target });
      assert.equal(r.ok, true, `${verb} ${target}`);
      assert.ok(fs.existsSync(r.path));
    }
  }
  assert.equal(resolveVerb({ verb: 'run', target: 'testing', mode: 'retention-audit' }).playbook, 'standards/testing/playbooks/retention-audit.md');
  assert.equal(resolveVerb({ verb: 'run', target: 'testing', mode: 'flake-triage' }).playbook, 'standards/testing/playbooks/flake-triage.md');
});

test('9024e9ac T14.AC3 unknown target, unknown verb, missing verb, planned target, bad mode are named errors', () => {
  assert.equal(resolveVerb({ verb: 'run', target: 'nope' }).error.code, 'E_UNKNOWN_TARGET');
  assert.equal(resolveVerb({ verb: 'frob', target: 'testing' }).error.code, 'E_UNKNOWN_VERB');
  assert.equal(resolveVerb({ verb: 'run', target: 'all' }).error.code, 'E_UNSUPPORTED_VERB');
  assert.equal(resolveVerb({ verb: 'apply', target: 'deployment' }).error.code, 'E_PLANNED_TARGET');
  assert.equal(resolveVerb({ verb: 'run', target: 'routing', mode: 'retention-audit' }).error.code, 'E_UNSUPPORTED_MODE');
  assert.equal(resolveVerb({ verb: 'run' }).error.code, 'E_USAGE');
  const all = resolveVerb({ verb: 'review', target: 'all' });
  assert.deepEqual(all.items.slice(0, 3).map((i) => i.target), ['routing', 'gates', 'testing'], 'foundations first');
});

test('9024e9ac T14.AC3 a registry entry that lacks the verb is E_UNSUPPORTED_VERB, not a default', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-unit-'));
  try {
    fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({ foundations: [], standards: [{ id: 'x', status: 'active', playbooks: { review: 'r.md' } }] }));
    fs.writeFileSync(path.join(root, 'r.md'), '# r\n');
    assert.equal(resolveVerb({ root, verb: 'apply', target: 'x' }).error.code, 'E_UNSUPPORTED_VERB');
    assert.equal(resolveVerb({ root, verb: 'review', target: 'x' }).ok, true);
    fs.rmSync(path.join(root, 'r.md'));
    assert.equal(resolveVerb({ root, verb: 'review', target: 'x' }).error.code, 'E_PLAYBOOK_MISSING');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('9024e9ac T14.AC4 checkCard accepts a clean card and rejects each seeded defect', () => {
  const ok = 'Clauses: §6.1, G9, R3, P3. Obligations: AU.1.\n';
  const bytes = (t) => Buffer.byteLength(t);
  assert.deepEqual(checkCard({ name: 'c', text: ok, bytes: bytes(ok), strategy: MINI_STRATEGY }), []);
  const big = ok + 'x'.repeat(5000);
  assert.ok(checkCard({ name: 'c', text: big, bytes: bytes(big) }).some((f) => f.includes('exceeds 4096')));
  for (const bad of ['§1E', 'D23', 'T14', 'F1', 'BL-12', 'STRATEGY_MAP']) {
    const t = ok + `see ${bad}\n`;
    assert.ok(checkCard({ name: 'c', text: t, bytes: bytes(t) }).some((f) => f.includes('non-STRATEGY')), bad);
  }
  const unknown = 'Clauses: G99. Obligations: AU.1.\n';
  assert.ok(checkCard({ name: 'c', text: unknown, bytes: 10, strategy: MINI_STRATEGY }).some((f) => f.includes('G99')));
  const unknownSection = 'Clauses: §9.9. Obligations: AU.1.\n';
  assert.ok(checkCard({ name: 'c', text: unknownSection, bytes: 10, strategy: MINI_STRATEGY }).some((f) => f.includes('§9.9')));
  assert.ok(checkCard({ name: 'c', text: 'no citations here\n', bytes: 10 }).some((f) => f.includes('cites no STRATEGY clause')));
});

test('9024e9ac T14.AC4 all twelve shipped cards are at most 4096 bytes and cite only clause ids', () => {
  const spec = readJson(path.join(std, 'conformance.spec.json'));
  const cards = spec.checks.find((c) => c.kind === 'cards');
  assert.equal(cards.required.length, 12);
  const oblig = obligationIds(parseRoles(readText(path.join(std, 'roles.md'))));
  for (const name of cards.required) {
    const file = path.join(std, 'cards', name);
    const size = fs.statSync(file).size;
    assert.deepEqual(checkCard({ name, text: readText(file), bytes: size, obligations: oblig }), [], name);
  }
  const names = cards.required.map((n) => path.basename(n, '.md'));
  for (const n of ['classifier', 'implementer-light', 'static-reviewer', 'auditor', 'triager', 'plan-bucket', 'author-new-behavior', 'author-regression', 'author-contract', 'characterize', 'select-checks', 'maintain']) {
    assert.ok(names.includes(n), n);
  }
});

test('9024e9ac T14.AC5 endsInRecord is true only when the last section is Record', () => {
  assert.equal(endsInRecord('# a\n## Steps\nx\n## Record\ny\n').ok, true);
  assert.equal(endsInRecord('# a\n## Record\ny\n## Notes\nz\n').ok, false);
  assert.equal(endsInRecord('# a\nno sections\n').ok, false);
  for (const [name, rel] of Object.entries({ run: 'run', apply: 'apply', review: 'review', 'retention-audit': 'retention-audit', 'flake-triage': 'flake-triage' })) {
    assert.equal(endsInRecord(readText(path.join(std, 'playbooks', `${rel}.md`))).ok, true, name);
  }
  for (const f of ['routing', 'gates']) for (const v of ['review', 'run', 'apply']) {
    assert.equal(endsInRecord(readText(path.join(SKILL_ROOT, 'foundations', f, `${v}.md`))).ok, true, `${f} ${v}`);
  }
});

test('9024e9ac T14.AC6 each of the five formats documents its fields', () => {
  const spec = readJson(path.join(std, 'conformance.spec.json')).checks.find((c) => c.kind === 'formats');
  assert.deepEqual(Object.keys(spec.formats).sort(), ['audit-record.md', 'escape-record.md', 'removal-record.md', 'test-header.md', 'testing-record.md']);
  for (const [name, fields] of Object.entries(spec.formats)) {
    assert.deepEqual(missingFormatFields(readText(path.join(std, 'formats', name)), fields), [], name);
  }
  assert.deepEqual(missingFormatFields('`a` `b`', ['a', 'c']), ['c']);
  const record = readText(path.join(std, 'formats/testing-record.md'));
  for (const line of ['change-class:', 'rigor:', 'triggers:', 'ac:', 'not-testing:', 'plan:', 'expires:']) assert.ok(record.includes(line), line);
});

test('9024e9ac T14.AC7 roles.md parses to 13 roles with ids, tools, independence, hints, no-holder', () => {
  const parsed = parseRoles(readText(path.join(std, 'roles.md')));
  assert.deepEqual(validateRoles(parsed), []);
  assert.equal(parsed.roles.length, 13);
  for (const r of parsed.roles) {
    assert.ok(r.obligations.length >= 1 && r.tools.length >= 1 && r.independence && r.noHolder, r.name);
    assert.ok(Array.isArray(r.hints) && typeof r.deepBlocks === 'boolean', r.name);
  }
  const deep = parsed.roles.filter((r) => r.deepBlocks).map((r) => r.name).sort();
  assert.deepEqual(deep, ['auditor', 'static-reviewer', 'test-author']);
  const declared = readJson(path.join(std, 'standard.json')).roles.sort();
  assert.deepEqual(parsed.roles.map((r) => r.name).sort(), declared);
});

test('9024e9ac T14.AC7 validateRoles flags seeded defects in roles.md', () => {
  const good = readText(path.join(std, 'roles.md'));
  const errs = (t) => validateRoles(parseRoles(t));
  assert.ok(errs(good.replace('- AU.2:', '- AU.1:')).some((e) => e.includes('duplicate obligation id AU.1')));
  assert.ok(errs(good.replace('- tools: read, backlog', '- tools: read, telepathy')).some((e) => e.includes('telepathy')));
  assert.ok(errs(good.replace('- distinct-from: auditor\n', '- distinct-from: ghost\n')).some((e) => e.includes('ghost')));
  assert.ok(errs(good.replace(/- no-holder: unbound; no release; deep-blocks: no/, '- no-holder: unbound')).some((e) => e.includes('deep-blocks')));
  assert.ok(errs(good.replace('- prefix: RO\n', '- prefix: RO\n- bogus: x\n')).some((e) => e.includes('bogus')));
  assert.ok(errs('# nothing\n').includes('no roles found'));
});

const fx = (n) => path.join(SKILL_ROOT, 'fixtures/review-all', n);
test('9024e9ac T14.AC8 reviewAll: complete fixture clean, seeded planned standard is a finding, incomplete fails', () => {
  const complete = reviewAll({ root: fx('complete') });
  assert.deepEqual(complete.findings, []);
  assert.equal(reviewAllExit(complete.findings), 0);

  const seeded = reviewAll({ root: fx('seeded-planned') });
  const ids = seeded.findings.filter((f) => f.target === 'seeded-planned-standard').map((f) => f.id);
  for (const id of ['planned-standard', 'missing-playbook', 'missing-conformance-spec', 'missing-apply-template']) assert.ok(ids.includes(id), id);
  assert.equal(reviewAllExit(seeded.findings), 1);
  assert.equal(reviewAllExit(seeded.findings, { allowPlanned: true }), 0, 'only planned findings: demoted by the flag');

  const incomplete = reviewAll({ root: fx('incomplete') });
  const got = incomplete.findings.map((f) => f.id).sort();
  assert.deepEqual(got, ['missing-apply-template', 'missing-conformance-spec', 'missing-playbook']);
  assert.equal(reviewAllExit(incomplete.findings, { allowPlanned: true }), 1, 'a real gap is never demoted');
});

test('9024e9ac T14.AC8 the real registry reports its five planned standards and nothing else', () => {
  const r = reviewAll();
  assert.ok(r.findings.every((f) => f.severity === 'planned'));
  assert.deepEqual([...new Set(r.findings.map((f) => f.target))].sort(), ['deployment', 'documentation', 'implementation', 'organization', 'styling']);
  assert.equal(reviewAllExit(r.findings), 1);
  assert.equal(reviewAllExit(r.findings, { allowPlanned: true }), 0);
});

test('9024e9ac T14.AC9 the manifest installs on claude and opencode with matching versions', () => {
  const m = readJson(path.join(SKILL_ROOT, 'extension.json'));
  const p = readJson(path.join(SKILL_ROOT, 'package.json'));
  assert.deepEqual(m.install.hosts.sort(), ['claude', 'opencode']);
  assert.equal(m.type, 'skill');
  assert.equal(m.entrypoint, 'SKILL.md');
  assert.equal(m.version, p.version);
  assert.match(m.description, /^Use this when/);
  assert.ok(!readText(path.join(SKILL_ROOT, 'SKILL.md')).startsWith('---'), 'SKILL.md body is prose only: no frontmatter');
});

test('9024e9ac T14.AC10 reviewRouting reports agents with no declaration and unknown ids', () => {
  const oblig = obligationIds(parseRoles(readText(path.join(std, 'roles.md'))));
  const ok = reviewRouting({ agents: loadAgents(path.join(SKILL_ROOT, 'fixtures/routing/agents-ok')), obligations: oblig });
  assert.deepEqual(ok.findings, []);
  const bad = reviewRouting({ agents: loadAgents(path.join(SKILL_ROOT, 'fixtures/routing/agents-missing')), obligations: oblig });
  const by = (id) => bad.findings.filter((f) => f.id === id).map((f) => f.agent).sort();
  assert.deepEqual(by('no-roles-covered-declaration'), ['nocaps', 'nodecl']);
  assert.deepEqual(by('unknown-obligation-id'), ['badid']);
  assert.equal(bad.findings.some((f) => f.agent === 'aud'), false, 'a valid declaration is not a finding');
});

test('9024e9ac T14.AC10 reviewRouting flags a misplaced roles-covered list and hints naming no installed agent', () => {
  const roles = parseRoles(readText(path.join(SKILL_ROOT, 'fixtures/routing/roles-ghost-hint.md')));
  const oblig = obligationIds(roles);
  const agents = [{ agent: 'rev', manifest: { agent: { 'roles-covered': ['static-reviewer:G9'] } } }];
  const r = reviewRouting({ agents, obligations: oblig, roles });
  const decl = r.findings.find((f) => f.id === 'no-roles-covered-declaration');
  assert.ok(decl && decl.detail.includes('is not the declaration'));
  assert.deepEqual(r.findings.filter((f) => f.id === 'unresolved-hint').map((f) => f.detail), ['role auditor hints "ghost-agent", which matches no installed agent']);
  const clean = reviewRouting({ agents, obligations: oblig, roles: parseRoles(readText(path.join(SKILL_ROOT, 'fixtures/routing/roles-no-hints.md'))) });
  assert.equal(clean.findings.some((f) => f.id === 'unresolved-hint'), false);
});

test('595965cc T19a.AC3 roles-covered:none is an explicit zero-coverage declaration, never a finding', () => {
  const oblig = obligationIds(parseRoles(readText(path.join(std, 'roles.md'))));
  const agents = [
    { agent: 'none-only', manifest: { id: 'none-only', capabilities: ['roles-covered:none'] } },
    { agent: 'none-mixed', manifest: { id: 'none-mixed', capabilities: ['roles-covered:none', 'roles-covered:AU.1'] } },
    { agent: 'missing', manifest: { id: 'missing', capabilities: [] } },
  ];
  const r = reviewRouting({ agents, obligations: oblig });
  const by = (id) => r.findings.filter((f) => f.id === id).map((f) => f.agent);
  assert.deepEqual(by('none-with-obligations'), ['none-mixed']);
  assert.deepEqual(by('no-roles-covered-declaration'), ['missing'], 'a bare absence is still a finding; none is not an absence');
  assert.deepEqual(r.agents.find((a) => a.agent === 'none-only').covered, [], 'none resolves no obligation');
  assert.equal(r.findings.some((f) => f.agent === 'none-only'), false);
});

test('9024e9ac T14.AC10 the roles-covered schema pins the obligation-id shape', () => {
  const s = readJson(path.join(SKILL_ROOT, 'schemas/roles-covered.schema.json'));
  const idPattern = new RegExp(s.properties['roles-covered'].items.pattern);
  const entry = new RegExp(s.$defs.capabilityEntry.pattern);
  assert.ok(idPattern.test('AU.2') && !idPattern.test('au.2') && !idPattern.test('AUD.2'));
  assert.ok(entry.test('roles-covered:AU.2') && !entry.test('roles-covered:'));
  assert.deepEqual(s.required, ['agent', 'roles-covered']);
});

test('9024e9ac T14.AC11 the recorded reuse decision names the three existing tools and a third-party option', () => {
  const d = readText(path.join(SKILL_ROOT, 'decisions/reuse-decision.md'));
  for (const needle of ['tools/gate/lane-gate.mjs', 'check-lane-reachability.mjs', 'Nx target orchestration', 'markdown-magic', 'Memory check', 'Search check', 'Decision', 'T62', 'T48']) {
    assert.ok(d.includes(needle), `reuse-decision.md lacks "${needle}"`);
  }
});

test('expandRanges expands letter-number ranges', () => {
  assert.deepEqual(expandRanges(['G1-G3', 'X9']), ['G1', 'G2', 'G3', 'X9']);
});

test('9024e9ac T14.AC3 a value-taking flag with no value is E_USAGE (exit 64), never a default playbook', () => {
  for (const flag of ['--mode', '--root']) {
    for (const argv of [[flag], [flag, '--other']]) {
      const o = takeOption(['run', 'testing', ...argv], flag);
      assert.ok(o.error && o.error.includes(flag), `${flag} without a value is reported: ${JSON.stringify(argv)}`);
    }
  }
  const a = ['run', 'testing', '--mode', 'x'];
  assert.deepEqual(takeOption(a, '--mode'), { value: 'x' });
  assert.deepEqual(a, ['run', 'testing'], 'flag and value are consumed');
  assert.deepEqual(takeOption(['run'], '--mode'), { value: undefined });
});

test('9024e9ac T14.AC8 a malformed conformance spec or unreadable playbook yields a finding carrying the real cause', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-unit-'));
  const stderr = process.stderr.write.bind(process.stderr);
  const traced = [];
  process.stderr.write = (c) => (traced.push(String(c)), true);
  try {
    fs.writeFileSync(path.join(root, 'registry.json'), JSON.stringify({
      foundations: [],
      standards: [{ id: 'x', status: 'active', playbooks: { review: 'r.md', run: 'gone.md', apply: 'r.md' }, conformance: 'spec.json', applyTemplate: 'r.md', declaration: 'r.md' }],
    }));
    fs.writeFileSync(path.join(root, 'r.md'), '# r\n');
    fs.writeFileSync(path.join(root, 'spec.json'), '{ "checks": [');
    const { findings } = reviewAll({ root });
    const spec = findings.find((f) => f.id === 'missing-conformance-spec');
    assert.ok(spec && /malformed/.test(spec.detail) && /JSON/i.test(spec.detail), spec?.detail);
    const pb = findings.find((f) => f.id === 'missing-playbook');
    assert.ok(pb && pb.detail.includes('"run"') && pb.detail.includes('gone.md') && /ENOENT/.test(pb.detail), pb?.detail);
    assert.ok(traced.some((t) => t.includes('spec.json')) && traced.some((t) => t.includes('gone.md')), 'causes are traced to stderr');
  } finally {
    process.stderr.write = stderr;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('9024e9ac T14.AC10 one malformed agent extension.json is a per-agent finding, not an abort', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-unit-'));
  const stderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    for (const [name, body] of [['good', { id: 'good', type: 'agent', capabilities: ['roles-covered:AU.1'] }], ['broken', null]]) {
      fs.mkdirSync(path.join(dir, name));
      fs.writeFileSync(path.join(dir, name, 'extension.json'), body ? JSON.stringify(body) : '{ not json');
    }
    const r = reviewRouting({ agents: loadAgents(dir), obligations: new Set(['AU.1']) });
    assert.deepEqual(r.findings.map((f) => [f.agent, f.id]), [['broken', 'unreadable-manifest']]);
    assert.ok(r.findings[0].detail.includes('not valid JSON'));
    assert.deepEqual(r.agents.map((a) => a.agent), ['broken', 'good']);
  } finally {
    process.stderr.write = stderr;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('validate-fixtures AC1 no synthetic extension.json under the skill fixtures (repo-wide soxe validate walk would flag it)', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.name === 'extension.json') offenders.push(path.relative(SKILL_ROOT, full));
    }
  };
  walk(path.join(SKILL_ROOT, 'fixtures'));
  assert.deepEqual(offenders, [], 'fixture manifests must be named extension.fixture.json so soxe validate does not discover them');
  const agents = loadAgents(path.join(SKILL_ROOT, 'fixtures/routing/agents-ok'));
  assert.ok(agents.length > 0, 'fixture readers still load extension.fixture.json');
});

test('9024e9ac T14.AC10 loadAgents reports a null / non-object manifest as a named finding instead of throwing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-unit-'));
  const stderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = () => true;
  try {
    for (const [name, body] of [['nul', 'null'], ['arr', '[1]'], ['num', '7']]) {
      fs.mkdirSync(path.join(dir, name));
      fs.writeFileSync(path.join(dir, name, 'extension.json'), body);
    }
    const agents = loadAgents(dir);
    assert.deepEqual(agents.map((a) => a.agent), ['arr', 'nul', 'num']);
    const r = reviewRouting({ agents, obligations: new Set(['AU.1']) });
    assert.deepEqual(r.findings.map((f) => [f.agent, f.id]), [['arr', 'malformed-manifest'], ['nul', 'malformed-manifest'], ['num', 'malformed-manifest']]);
    assert.ok(r.findings.find((f) => f.agent === 'nul').detail.includes('null'));
  } finally {
    process.stderr.write = stderr;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('9024e9ac T14.AC3 --mode combined with target "all" is E_USAGE, not silently ignored', () => {
  const r = resolveVerb({ verb: 'review', target: 'all', mode: 'retention-audit' });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'E_USAGE');
  assert.equal(r.error.exit, 64);
  assert.equal(resolveVerb({ verb: 'review', target: 'all' }).ok, true, 'no mode: unchanged');
});
