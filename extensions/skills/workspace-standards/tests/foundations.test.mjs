// 595965cc T49: the foundation targets. `apply routing` and `apply gates` write the composed routing and
// gates blocks; `review routing|gates` reports drift. Every test runs on a temp repository. The backlog
// CLI is a recording stub (backlogFiler's injected `run`); no test reaches the real `adhd-backlog`, and
// nothing here spawns a process. The roster is fixture manifests, never the repository's own agents.
import test, { describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFoundation, loadStandards, mechanismFor, EXIT } from '../scripts/foundations.mjs';
import { applyTesting, backlogFiler } from '../scripts/apply-testing.mjs';
import { parseRoles, resolveRole, loadAgents, agentToolSet } from '../scripts/lib.mjs';
import { inspectBlock, unifiedDiff } from '../scripts/marker-engine.mjs';
import { parseTable, runGates } from '../engine/lib.mjs';
// The T10 roster guard (repo-root tools/). Imported for its pure checkRoster; the guard itself never spawns here.
import { checkRoster, makeSource, agentToolSet as guardAgentToolSet } from '../../../../tools/test-roster-guard.mjs';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HEAD = '# Repo\n\nSome prose that is not managed.\n';
const ALL_TOOLS = ['read', 'grep', 'glob', 'bash', 'edit', 'backlog'];
const TESTING = loadStandards({ skillRoot: SKILL }).find((s) => s.id === 'testing');
const ROLE = Object.fromEntries(TESTING.roles.map((r) => [r.name, r]));
const idsOf = (role) => role.obligations.map((o) => o.id);
const MECHANICAL = TESTING.decl.gates.filter((g) => g.mechanism === 'mechanical').map((g) => g.id);

let tmp;
let n = 0;
before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-foundations-')); });
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** Fixture roster: a full-tool author, a full-tool reviewer, and a read-only author that is ineligible. */
const ROSTER = [
  { dir: 'author-fixture', manifest: { id: 'author-fixture', type: 'agent', capabilities: idsOf(ROLE['test-author']).map((i) => `roles-covered:${i}`), agent: { tools: ALL_TOOLS } } },
  { dir: 'reviewer-fixture', manifest: { id: 'reviewer-fixture', type: 'agent', capabilities: idsOf(ROLE['static-reviewer']).map((i) => `roles-covered:${i}`), agent: { tools: ALL_TOOLS } } },
  { dir: 'readonly-fixture', manifest: { id: 'readonly-fixture', type: 'agent', capabilities: idsOf(ROLE['test-author']).map((i) => `roles-covered:${i}`), agent: { tools: ['read'] } } },
];

/** A temp repository with the fixture roster, optionally a dispatcher routing rule and a gate command table. */
function scaffold({ dispatcher = false, roster = ROSTER, gateTable = null } = {}) {
  const dir = path.join(tmp, `repo-${n++}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), HEAD);
  for (const a of roster) {
    fs.mkdirSync(path.join(dir, 'extensions/agents', a.dir), { recursive: true });
    fs.writeFileSync(path.join(dir, 'extensions/agents', a.dir, 'extension.json'), JSON.stringify(a.manifest));
  }
  if (dispatcher) {
    fs.mkdirSync(path.join(dir, 'extensions/agents/dispatcher'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'extensions/agents/dispatcher/dispatcher.md'),
      'Route each bucket by its work class.\n\nWork class → executor:\n- docs → `reviewer-fixture`\n\nIf no row matches, stop and ask.\n');
  }
  if (gateTable !== null) fs.writeFileSync(path.join(dir, 'gates.table.json'), JSON.stringify(gateTable));
  return dir;
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const managed = (text, target) => {
  const at = inspectBlock(text, target);
  assert.ok(at.found, `block ${target} is present`);
  return at.body;
};
const rosterAgents = (dir) => loadAgents(path.join(dir, 'extensions/agents'));
/** A recording filer for the injected-filer path: one uid per item, every item remembered. */
function recordingFiler() {
  const items = [];
  const f = (item) => { items.push(item); return `uid-${items.length}`; };
  f.items = items;
  return f;
}
const TASK_ROW = (w, holder) => `| ${w.id} | testing | ${w.role ?? 'none'} | ${holder} |`;

describe('T49 routing composition', () => {
  test('595965cc T49 AC1: the routing block maps every testing task to a roster agent by name and composes roles.md from every role', () => {
    const dir = scaffold();
    const r = applyFoundation({ target: 'routing', root: dir, standards: [TESTING], agents: rosterAgents(dir), noFile: true });
    assert.equal(r.exit, EXIT.OK);
    const body = managed(read(dir, 'AGENTS.md'), 'routing');
    assert.match(body, /This table wins over the dispatcher's own default rows/, 'precedence statement');
    for (const w of TESTING.decl.workClasses) {
      const holder = w.role ? '`author-fixture`' : '_no role_';
      assert.ok(body.includes(TASK_ROW(w, holder)), `task row for ${w.id}`);
    }
    assert.ok(body.includes('| static-reviewer | testing | `reviewer-fixture` | SR.1, SR.2, SR.3, SR.4 |'), 'role holder named by the roster');
    assert.ok(body.includes('| role-routing | workspace-standards |'), 'role-resolution capability row');
    const roles = read(dir, 'docs/standards/roles.md');
    for (const role of TESTING.roles) assert.ok(roles.includes(`## role: ${role.name}\n`), `roles.md defines ${role.name}`);
    assert.deepEqual(r.unbound, TESTING.roles.map((x) => x.name).filter((x) => !['test-author', 'static-reviewer'].includes(x)).map((x) => `testing/${x}`), 'every role with no eligible agent is listed as unbound');
  });

  test('595965cc T49 AC1: the skill agentToolSet maps every tool entry exactly as the T10 guard does', () => {
    const manifests = [
      { agent: { tools: ['read', 'grep', 'glob', 'bash', 'edit', 'write', 'backlog', 'code-intel', { logical: 'search' }, 'unknown-tool'] } },
      { agent: { tools: [{ logical: 'read' }, { logical: 'bash' }] } },
      { agent: {} },
      {},
    ];
    for (const m of manifests) assert.deepEqual([...agentToolSet(m)].sort(), [...guardAgentToolSet(m)].sort(), JSON.stringify(m));
  });

  test('595965cc T49 AC1: resolveRole picks the closest eligible agent and never an agent that lacks a required tool', () => {
    const agents = [
      { agent: 'a-readonly', manifest: { id: 'a-readonly', capabilities: idsOf(ROLE['test-author']).map((i) => `roles-covered:${i}`), agent: { tools: ['read'] } } },
      { agent: 'b-partial', manifest: { id: 'b-partial', capabilities: [`roles-covered:${idsOf(ROLE['test-author'])[0]}`], agent: { tools: ALL_TOOLS } } },
      { agent: 'c-full', manifest: { id: 'c-full', capabilities: idsOf(ROLE['test-author']).map((i) => `roles-covered:${i}`), agent: { tools: ALL_TOOLS } } },
    ];
    const got = resolveRole(ROLE['test-author'], agents);
    assert.equal(got.holder, 'c-full', 'the agent covering every obligation wins; the read-only agent is ineligible');
    assert.equal(got.rank, idsOf(ROLE['test-author']).length);
    assert.equal(resolveRole(ROLE['test-author'], [agents[0]]).holder, null, 'a read-only agent cannot hold a role that needs edit');
  });

  test('595965cc T49 AC4: a standard declaring routing: own is skipped by apply routing and reported, and writes no roles.md', () => {
    const owned = { ...TESTING, own: { routing: true, gates: false } };
    const dir = scaffold();
    const r = applyFoundation({ target: 'routing', root: dir, standards: [owned], agents: rosterAgents(dir), noFile: true });
    assert.ok(r.skipped.some((s) => /testing: declares routing: own/.test(s)), `skipped reported: ${r.skipped}`);
    assert.ok(!managed(read(dir, 'AGENTS.md'), 'routing').includes('| new-behavior |'), 'no testing task rows written by the foundation');
    assert.equal(fs.existsSync(path.join(dir, 'docs/standards/roles.md')), false, 'no composed roles.md for an owned standard');
  });

  test('595965cc T49 AC4: the same own:[routing] declaration makes apply testing write the testing-routing block instead', () => {
    const dir = scaffold();
    const decl = path.join(tmp, `own-routing-${n++}.json`);
    fs.writeFileSync(decl, JSON.stringify({ ...TESTING.decl, own: ['routing'] }));
    const r = applyTesting({ root: dir, declarationPath: decl, filer: recordingFiler() });
    assert.ok(r.blocks.some((b) => b.target === 'testing-routing'), 'apply testing wrote testing-routing for own:[routing]');
  });
});

describe('T49 gates composition', () => {
  test('595965cc T49 AC2: the gates block has the gate registry, the stage bindings, and exactly one runner row that names the engine', () => {
    const dir = scaffold();
    const r = applyFoundation({ target: 'gates', root: dir, standards: [TESTING], noFile: true });
    assert.equal(r.exit, EXIT.OK);
    const body = managed(read(dir, 'AGENTS.md'), 'gates');
    assert.ok(body.includes('| test-gates | G1 | mechanical | D, E, G | obligation |'), 'registry row under the gate set test-gates');
    assert.ok(body.includes('| D | test-gates/G1, test-gates/G2'), 'stage D binds the testing gates');
    const runnerRows = body.split('\n').filter((l) => l.startsWith('| gate-runner |'));
    assert.equal(runnerRows.length, 1, 'exactly one runner row');
    assert.match(runnerRows[0], /engine\/cli\.mjs run --step <A-H>/);
  });

  test('595965cc T49 AC2: the testing gate set runs through the engine as one report that contains every gate bound to the step', () => {
    const table = { gates: TESTING.decl.gates.map((g) => ({ id: g.id, stage: [].concat(g.stage), mechanism: g.mechanism, command: g.mechanism === 'mechanical' ? `run-${g.id}` : undefined })) };
    const parsed = parseTable(JSON.stringify(table), 'test-gates');
    const calls = [];
    const report = runGates(parsed, { step: 'D', changeClass: 'new-behavior', rigor: 'standard', changed: [], root: tmp }, {
      run: (command) => { calls.push(command); return { exit: 0, stdout: '', stderr: '' }; },
      now: () => 0,
    });
    const inD = TESTING.decl.gates.filter((g) => [].concat(g.stage).includes('D')).map((g) => g.id);
    assert.deepEqual(report.gates.filter((g) => g.selected).map((g) => g.id), inD, 'every stage-D gate of the testing set is in the single report');
    assert.deepEqual(report.summary.obligations.sort(), ['G11', 'G6'], 'review gates are obligations, never passes');
    assert.equal(report.exit, 0);
    assert.equal(calls.length, inD.filter((id) => MECHANICAL.includes(id)).length, 'each mechanical stage-D gate ran once through the engine');
  });

  test('595965cc T49 AC4: a standard declaring gates: own is skipped by apply gates and reported, and writes no gate rows', () => {
    const owned = { ...TESTING, own: { routing: false, gates: true } };
    const dir = scaffold();
    const r = applyFoundation({ target: 'gates', root: dir, standards: [owned], noFile: true });
    assert.ok(r.skipped.some((s) => /testing: declares gates: own/.test(s)), `skipped reported: ${r.skipped}`);
    assert.ok(!managed(read(dir, 'AGENTS.md'), 'gates').includes('| test-gates | G1 |'), 'no testing gate rows written by the foundation');
  });
});

describe('T49 idempotence and drift', () => {
  test('595965cc T49 AC5: a second apply changes nothing; a hand edit inside a block is drift for review routing and not for review gates', () => {
    const dir = scaffold();
    const agents = rosterAgents(dir);
    const pre = applyFoundation({ target: 'routing', root: dir, standards: [TESTING], agents, check: true });
    assert.equal(pre.exit, EXIT.DRIFT, 'review before any apply: the block is not applied yet, which counts as drift');
    applyFoundation({ target: 'routing', root: dir, standards: [TESTING], agents, noFile: true });
    applyFoundation({ target: 'gates', root: dir, standards: [TESTING], noFile: true });
    const again = applyFoundation({ target: 'routing', root: dir, standards: [TESTING], agents, noFile: true });
    assert.deepEqual(again.wrote, [], 'the second routing run writes no file');
    assert.ok(again.blocks.every((b) => b.action === 'unchanged'), `second run: every block unchanged (${JSON.stringify(again.blocks)})`);
    assert.equal(applyFoundation({ target: 'routing', root: dir, standards: [TESTING], agents, check: true }).exit, EXIT.OK, 'review routing clean after apply');
    assert.equal(applyFoundation({ target: 'gates', root: dir, standards: [TESTING], check: true }).exit, EXIT.OK, 'review gates clean after apply');

    const agentsPath = path.join(dir, 'AGENTS.md');
    const good = '| new-behavior | testing | test-author | `author-fixture` |';
    fs.writeFileSync(agentsPath, fs.readFileSync(agentsPath, 'utf8').replace(good, '| new-behavior | testing | test-author | `hand-edited` |'));
    const drifted = applyFoundation({ target: 'routing', root: dir, standards: [TESTING], agents, check: true });
    assert.equal(drifted.exit, EXIT.DRIFT, 'review routing reports the hand edit');
    assert.ok(drifted.drift.some((d) => d.target === 'routing'), 'the drift names the routing block');
    assert.equal(applyFoundation({ target: 'gates', root: dir, standards: [TESTING], check: true }).exit, EXIT.OK, 'a routing edit is not gates drift');

    fs.writeFileSync(agentsPath, fs.readFileSync(agentsPath, 'utf8').replace('| new-behavior | testing | test-author | `hand-edited` |', good));
    fs.writeFileSync(agentsPath, fs.readFileSync(agentsPath, 'utf8').replace('Some prose that is not managed.', 'Prose edited outside the block.'));
    assert.equal(applyFoundation({ target: 'routing', root: dir, standards: [TESTING], agents, check: true }).exit, EXIT.OK, 'prose outside the markers is never block drift');
  });
});

describe('T49 second standard', () => {
  const FIXTURE_ROLE_TEXT = [
    '## role: fx-reviewer',
    '- prefix: FX',
    '- FX.1: Review the fixture change [§1]',
    '- tools: read',
    '- distinct-from:',
    '- hints:',
    '- independence: none stated.',
    '- no-holder: unbound; deep-blocks: no',
    '',
  ].join('\n');
  const FIXTURE = {
    id: 'fixture-std',
    gateSet: 'fixture-gates',
    binding: null,
    own: { routing: false, gates: false },
    decl: {
      workClasses: [{ id: 'fixture-task', defaultRigor: 'light', role: 'fx-reviewer', card: null }],
      gates: [{ id: 'D1', threshold: 'fixture threshold', mechanism: 'review', stage: ['B'] }],
    },
    rolesText: FIXTURE_ROLE_TEXT,
    roles: parseRoles(FIXTURE_ROLE_TEXT).roles,
  };

  test('595965cc T49 AC3: adding a second standard with its own roles and gates changes only the routing and gates blocks, and only with fixture text', () => {
    const base = scaffold();
    applyFoundation({ target: 'routing', root: base, standards: [TESTING], agents: rosterAgents(base), noFile: true });
    applyFoundation({ target: 'gates', root: base, standards: [TESTING], noFile: true });
    const withFixture = scaffold();
    applyFoundation({ target: 'routing', root: withFixture, standards: [TESTING, FIXTURE], agents: rosterAgents(withFixture), noFile: true });
    applyFoundation({ target: 'gates', root: withFixture, standards: [TESTING, FIXTURE], noFile: true });

    const strip = (text) => text.replace(/<!-- workspace-standards:(routing|gates|foundations-filed):begin -->[\s\S]*?<!-- workspace-standards:\1:end -->/g, '<<BLOCK>>');
    assert.equal(strip(read(withFixture, 'AGENTS.md')), strip(read(base, 'AGENTS.md')), 'everything outside the managed blocks is identical');

    const changed = unifiedDiff('AGENTS.md', read(base, 'AGENTS.md'), read(withFixture, 'AGENTS.md')).split('\n').filter((l) => /^[+-](?![+-])/.test(l));
    const added = changed.filter((l) => l.startsWith('+'));
    assert.ok(added.length > 0, 'the blocks changed');
    for (const line of added) assert.match(line, /fixture|fx-|FX\.1|D1/, `added line is fixture-specific: ${line}`);
    for (const line of changed) assert.doesNotMatch(line, /testing|test-author|test-gates/, `no testing-specific text changes: ${line}`);
  });
});

describe('T49 gate filing through the injected backlog CLI', () => {
  test('595965cc T49 AC6: a mechanical gate with no mechanism is filed once through the backlog CLI; bound and review gates are not', () => {
    const dir = scaffold({ gateTable: { gates: [{ id: 'G1', stage: ['D'], mechanism: 'mechanical', command: 'true' }] } });
    const calls = [];
    const filer = backlogFiler({ project: 'fixture', run: (args) => { calls.push(args); return `${JSON.stringify({ ok: true, data: { uid: `BL-${calls.length}` } })}\n`; } });
    const r = applyFoundation({ target: 'gates', root: dir, standards: [TESTING], filer });
    const expected = MECHANICAL.filter((id) => id !== 'G1').map((id) => `test-gates/${id}`);
    assert.deepEqual(r.filed.map((f) => f.key), expected, 'one item per mechanical gate without a command');
    assert.equal(calls.length, expected.length, 'the backlog CLI stub was called once per filed item');
    assert.ok(calls.every((a) => a[0] === 'backlog' && a[1] === 'create'), 'the stub received backlog create calls only');
    assert.ok(r.filed.every((f) => /^BL-\d+$/.test(f.uid)), 'uids are read back from the CLI output');
    assert.ok(!r.filed.some((f) => /G6|G11/.test(f.key)), 'review-mechanism gates are obligations, never filed');
    const again = applyFoundation({ target: 'gates', root: dir, standards: [TESTING], filer });
    assert.equal(again.filed.length, 0, 'a second run files nothing');
    assert.equal(calls.length, expected.length, 'the stub was not called again');
    assert.equal(mechanismFor({ standard: TESTING, gate: TESTING.decl.gates.find((g) => g.id === 'G1'), commanded: new Set(['G1']), testingBound: new Set() }), true);
  });

  test('595965cc T49 AC6: a repository with no roster guard files one routing item through the backlog CLI, and nothing on the next run', () => {
    const dir = scaffold();
    const filed = recordingFiler();
    const r = applyFoundation({ target: 'routing', root: dir, standards: [TESTING], agents: rosterAgents(dir), filer: filed });
    assert.deepEqual(r.filed.map((f) => f.key), ['routing/roster-guard'], 'the missing roster guard is filed once');
    assert.equal(filed.items[0].gate, 'routing/roster-guard');
    assert.match(filed.items[0].title, /build the roster guard/);
    const again = applyFoundation({ target: 'routing', root: dir, standards: [TESTING], agents: rosterAgents(dir), filer: filed });
    assert.equal(again.filed.length, 0, 'the second routing run files nothing');
    assert.equal(filed.items.length, 1, 'the filer was called once in total');
  });

  test('595965cc T49 AC6: apply gates and apply testing, in either order, file each mechanical gate exactly once in total', () => {
    const gateTable = { gates: [{ id: 'G1', stage: ['D'], mechanism: 'mechanical', command: 'true' }] };
    const expected = MECHANICAL.filter((id) => id !== 'G1').sort();

    const gatesFirst = scaffold({ gateTable });
    const g1 = recordingFiler();
    applyFoundation({ target: 'gates', root: gatesFirst, standards: [TESTING], filer: g1 });
    const t1 = recordingFiler();
    applyTesting({ root: gatesFirst, filer: t1 });
    assert.equal(t1.items.length, 0, 'apply testing does not refile what apply gates filed');
    assert.deepEqual(g1.items.map((i) => i.gate).sort(), expected);

    const testingFirst = scaffold({ gateTable });
    const t2 = recordingFiler();
    applyTesting({ root: testingFirst, filer: t2 });
    const g2 = recordingFiler();
    applyFoundation({ target: 'gates', root: testingFirst, standards: [TESTING], filer: g2 });
    assert.equal(g2.items.length, 0, 'apply gates does not refile what apply testing filed');
    assert.deepEqual(t2.items.map((i) => i.gate).sort(), expected, 'apply testing filed each mechanical gate with no command');
  });

  test('595965cc T49 AC6: a filing that fails exits 4 and is not written to the ledger, so the next run retries it', () => {
    const dir = scaffold();
    let attempts = 0;
    let failOnce = true;
    const flaky = (item) => {
      attempts++;
      if (item.gate === 'G2' && failOnce) { failOnce = false; throw new Error('backlog unavailable'); }
      return `uid-${item.gate}`;
    };
    const r = applyFoundation({ target: 'gates', root: dir, standards: [TESTING], filer: flaky });
    assert.equal(r.exit, EXIT.FILING);
    assert.deepEqual(r.failed.map((f) => f.key), ['test-gates/G2']);
    assert.ok(!read(dir, 'AGENTS.md').includes('| test-gates/G2 |'), 'the failed gate is not in the ledger');
    const retry = applyFoundation({ target: 'gates', root: dir, standards: [TESTING], filer: flaky });
    assert.equal(retry.exit, EXIT.OK);
    assert.equal(attempts, MECHANICAL.length + 1, 'only the failed gate was attempted again');
  });
});

describe('T49 precedence and the T10 roster guard', () => {
  test('595965cc T49 AC7: the routing table states that it wins over the dispatcher rows, and the T10 guard resolves every name it routes', () => {
    const dir = scaffold({ dispatcher: true });
    const r = applyFoundation({ target: 'routing', root: dir, standards: [TESTING], agents: rosterAgents(dir), noFile: true });
    assert.equal(r.exit, EXIT.OK);
    assert.match(managed(read(dir, 'AGENTS.md'), 'routing'), /wins over the dispatcher's own default rows/);
    const result = checkRoster(makeSource({ root: dir }));
    assert.equal(result.agentsMdTable, 'found', 'the guard parses the routing table');
    assert.ok(result.routed.some((x) => x.name === 'author-fixture' && x.source === 'AGENTS.md'), 'the guard reads the table agent');
    assert.deepEqual(result.unresolved, [], 'every routed name resolves to an installed agent');
  });

  test('595965cc T49 AC7: a routed name that no installed agent matches fails the T10 guard', () => {
    const dir = scaffold({ dispatcher: true });
    applyFoundation({ target: 'routing', root: dir, standards: [TESTING], agents: rosterAgents(dir), noFile: true });
    const agentsPath = path.join(dir, 'AGENTS.md');
    fs.writeFileSync(agentsPath, fs.readFileSync(agentsPath, 'utf8').replace('| new-behavior | testing | test-author | `author-fixture` |', '| new-behavior | testing | test-author | `ghost-agent` |'));
    const result = checkRoster(makeSource({ root: dir }));
    assert.ok(result.unresolved.some((x) => x.name === 'ghost-agent'), 'the guard reports the unresolved name');
  });

  test('595965cc T49 AC7: unbound rows are warnings for the guard, not failures, so an unstaffed roster still passes', () => {
    const dir = scaffold({ dispatcher: true, roster: ROSTER.filter((a) => a.dir === 'reviewer-fixture') });
    applyFoundation({ target: 'routing', root: dir, standards: [TESTING], agents: rosterAgents(dir), noFile: true });
    const result = checkRoster(makeSource({ root: dir }));
    assert.equal(result.agentsMdTable, 'found');
    assert.deepEqual(result.unresolved, [], 'an unbound row names no agent and the dispatcher names only installed agents');
    assert.ok(read(dir, 'AGENTS.md').includes('| new-behavior | testing | test-author | _unbound_ |'), 'the test-author rows are unbound');
    assert.ok(result.tableWarnings.length > 0, 'the unbound cells are reported as not checked');
  });
});
