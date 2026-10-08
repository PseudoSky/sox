#!/usr/bin/env node
/**
 * tools/test-roster-guard.test.mjs — tests for tools/test-roster-guard.mjs (backlog 3fe895f3, T10).
 *
 * Unit tests inject a fake `git` and an in-memory fs, so nothing spawns a process. The AC2 red-proof
 * is driven from a committed snapshot of 27be064c (tools/fixtures/test-roster-guard/) and never
 * depends on repo history. The real-process check lives in test-roster-guard.e2e.test.mjs.
 *
 * Run: node tools/test-roster-guard.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DISPATCHER_REL, AGENTS_MD_REL, GuardError, parseDispatcherRoutes, parseAgentsMdTable,
  makeSource, checkRoster, checkRoles, ROLES_REL, formatReport, main,
} from './test-roster-guard.mjs';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(TOOLS_DIR, 'fixtures', 'test-roster-guard');
const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name), 'utf8');
const SNAPSHOT_REF = '27be064c';
const EXPECTED_RED = ['backend', 'general', 'refactor', 'review', 'test'];

/** Files of the pinned 27be064c snapshot: dispatcher rule, AGENTS.md table, one manifest per agent dir. */
function snapshotFiles() {
  const files = {
    [DISPATCHER_REL]: fixture('dispatcher-rule-27be064c.md'),
    [AGENTS_MD_REL]: fixture('AGENTS-table-27be064c.md'),
  };
  for (const dir of fixture('agents-dirs-27be064c.txt').split('\n').filter(Boolean)) {
    files[`extensions/agents/${dir}/extension.json`] = JSON.stringify({ id: dir });
  }
  return files;
}

const rule = (rows) =>
  `5. **Route each bucket to a named domain specialist.** Work class → executor: ${rows}. **If no row matches, STOP.** Pick the declared tier (\`sonnet\`).`;

/** In-memory repo: files = { relPath: content }. Exposes fs-like and git-like views of it. */
function fakeRepo(files, knownRefs = ['r', 'rr', SNAPSHOT_REF]) {
  const dirs = (rel) => [...new Set(Object.keys(files).filter((f) => f.startsWith(`${rel}/`)).map((f) => f.slice(rel.length + 1).split('/')[0]))]
    .filter((n) => Object.keys(files).some((f) => f.startsWith(`${rel}/${n}/`)));
  const fsApi = {
    existsSync: (p) => Object.hasOwn(files, p.slice(1)) || dirs(p.slice(1)).length > 0,
    readFileSync: (p) => files[p.slice(1)],
    readdirSync: (p) => dirs(p.slice(1)).map((name) => ({ name, isDirectory: () => true })),
  };
  const calls = [];
  const git = (args) => {
    calls.push(args);
    const operands = args.slice(1).filter((x) => !x.startsWith('-'));
    if (args[0] === 'rev-parse') {
      const ref = operands[0].replace(/\^\{commit\}$/, '');
      if (knownRefs.includes(ref)) return `${ref}\n`;
      throw new GuardError(`git rev-parse failed: fatal: Needed a single revision (${ref})`);
    }
    if (args[0] === 'ls-tree' && args.includes('-d')) {
      const dir = operands.at(-1);
      return dirs(dir.replace(/\/$/, '')).map((n) => `${dir}${n}`).join('\n');
    }
    if (args[0] === 'ls-tree') {
      const rel = operands.at(-1);
      return Object.hasOwn(files, rel) ? `${rel}\n` : '';
    }
    if (args[0] === 'show') return files[operands.at(-1).split(':')[1]];
    throw new Error(`unexpected git ${args.join(' ')}`);
  };
  return { fsApi, git, calls };
}

const manifest = (id) => JSON.stringify({ id });
const roster = (ids, dispatcherRows, extra = {}) => ({
  [DISPATCHER_REL]: rule(dispatcherRows),
  ...Object.fromEntries(ids.map((id) => [`extensions/agents/${id}/extension.json`, manifest(id)])),
  ...extra,
});

test('3fe895f3 T10.AC1: parseDispatcherRoutes extracts every backticked agent in the routing rule, not tiers', () => {
  const names = parseDispatcherRoutes(rule('implement → `backend` (types → `typescript`); QA → `qa`')).map((r) => r.name);
  assert.deepEqual(names, ['backend', 'typescript', 'qa']);
});

test('3fe895f3 T10.AC1: no routing rule, or no Work class rows, is a GuardError (never a silent pass)', () => {
  assert.throws(() => parseDispatcherRoutes('nothing here'), GuardError);
  assert.throws(() => parseDispatcherRoutes('Route each bucket to x. If no row matches, stop.'), GuardError);
});

test('3fe895f3 T10.AC1: parseAgentsMdTable reads the agent column of a task-to-agent table', () => {
  const md = ['# x', '', '| Task | Agent |', '|---|---|', '| write types | `typescript` |', '| review | `review` |', '', 'prose'].join('\n');
  assert.deepEqual(parseAgentsMdTable(md), {
    found: true,
    names: [{ name: 'typescript', source: AGENTS_MD_REL }, { name: 'review', source: AGENTS_MD_REL }],
    warnings: [],
  });
});

test('3fe895f3 T10.AC1: an unrelated table is not a routing table; absence is reported explicitly', () => {
  const md = '| capability | tool |\n|---|---|\n| memory | memory-server |\n';
  assert.equal(parseAgentsMdTable(md).found, false);
  const files = roster(['qa'], 'QA → `qa`', { [AGENTS_MD_REL]: md });
  const r = checkRoster(makeSource({ root: '/', fsApi: fakeRepo(files).fsApi }));
  assert.equal(r.agentsMdTable, 'absent');
  assert.match(formatReport(r), /NO task-to-agent routing table found/);
});

test('3fe895f3 T10.AC1: names routed only by an AGENTS.md table are checked too', () => {
  const files = roster(['qa'], 'QA → `qa`', { [AGENTS_MD_REL]: '| Task | Agent |\n|---|---|\n| x | `ghost` |\n' });
  const r = checkRoster(makeSource({ root: '/', fsApi: fakeRepo(files).fsApi }));
  assert.deepEqual(r.unresolved.map((u) => [u.name, u.source]), [['ghost', AGENTS_MD_REL]]);
});

test('3fe895f3 T10.AC3: negative control, fixture roster with one valid and one invalid name', () => {
  const files = roster(['qa'], 'QA → `qa`; restructure → `refactor`');
  const r = checkRoster(makeSource({ root: '/', fsApi: fakeRepo(files).fsApi }));
  assert.deepEqual(r.unresolved.map((u) => u.name), ['refactor']); // invalid name fails
  assert.ok(!r.unresolved.some((u) => u.name === 'qa'));           // valid name passes
});

test('3fe895f3 T10.AC3: the same fixture goes green once the invalid name is installed', () => {
  const files = roster(['qa', 'refactor'], 'QA → `qa`; restructure → `refactor`');
  const r = checkRoster(makeSource({ root: '/', fsApi: fakeRepo(files).fsApi }));
  assert.equal(r.unresolved.length, 0);
  assert.match(formatReport(r), /^PASS:/m);
});

test('3fe895f3 T10.AC1: main exits 1 on an unresolved name, 0 when clean, 2 when it cannot run', () => {
  const sink = () => ({ out: [], err: [] });
  const run = (files, argv = ['--ref', 'r']) => {
    const s = sink();
    const code = main(argv, { out: (m) => s.out.push(m), err: (m) => s.err.push(m) }, fakeRepo(files).git);
    return { code, ...s };
  };
  assert.equal(run(roster(['qa'], 'QA → `qa`; x → `nope`')).code, 1);
  assert.equal(run(roster(['qa'], 'QA → `qa`')).code, 0);
  const broken = run({});
  assert.equal(broken.code, 2);
  assert.match(broken.err.join('\n'), /cannot run/);
  assert.equal(run({}, ['--ref']).code, 2);
});

test('3fe895f3 T10.AC2: --ref reads dispatcher, AGENTS.md and the listing through git only (no checkout)', () => {
  const repo = fakeRepo(roster(['qa'], 'review → `review`'));
  const r = checkRoster(makeSource({ root: '/repo', ref: '27be064c', git: repo.git }));
  assert.deepEqual(r.unresolved.map((u) => u.name), ['review']);
  assert.ok(repo.calls.length > 0 && repo.calls.every((c) => ['rev-parse', 'ls-tree', 'show'].includes(c[0])));
  assert.ok(repo.calls.every((c) => !['checkout', 'switch', 'reset'].includes(c[0])));
});

test('3fe895f3 T10.AC2: a directory without extension.json is warned about, not counted as installed', () => {
  const files = roster(['qa'], 'QA → `qa`; x → `stray`', { 'extensions/agents/stray/README.md': 'x' });
  const r = checkRoster(makeSource({ root: '/', fsApi: fakeRepo(files).fsApi }));
  assert.deepEqual(r.unresolved.map((u) => u.name), ['stray']);
  assert.match(r.warnings.join('\n'), /stray: no extension\.json/);
});

const runMain = (files, argv, env = {}) => {
  const out = [];
  const err = [];
  const code = main(argv, { out: (m) => out.push(m), err: (m) => err.push(m) }, fakeRepo(files).git, env);
  return { code, out: out.join('\n'), err: err.join('\n') };
};

test('3fe895f3 T10.AC2: red on the pinned 27be064c snapshot, naming review, backend, refactor, test, general', () => {
  const r = runMain(snapshotFiles(), ['--ref', SNAPSHOT_REF]);
  const msg = `stdout:\n${r.out}\nstderr:\n${r.err}`;
  assert.equal(r.code, 1, msg);
  for (const n of EXPECTED_RED) assert.match(r.out, new RegExp(`UNRESOLVED: ${n} `), `missing ${n}\n${msg}`);
  const unresolved = [...r.out.matchAll(/^UNRESOLVED: (\S+) /gm)].map((m) => m[1]).sort();
  assert.deepEqual(unresolved, EXPECTED_RED, msg);
  assert.match(r.out, /NO task-to-agent routing table found/, msg);
});

test('3fe895f3 T10.AC2: the snapshot parses to exactly the routed names of the dispatcher rule', () => {
  const names = parseDispatcherRoutes(fixture('dispatcher-rule-27be064c.md')).map((x) => x.name);
  assert.deepEqual(names, [
    'general', 'backend', 'typescript', 'review', 'test', 'debug', 'qa', 'architect-decision', 'architect',
    'refactor', 'performance', 'backlog-operator', 'doc-steward', 'git-manager', 'product', 'researcher',
  ]);
});

test('3fe895f3 T10.AC1: a backticked non-agent word inside a routing row is not flagged', () => {
  const text = 'Route each bucket. Work class → executor: implement → `backend` (see `docs` and `--flag`, run `npm`); QA → `qa`. If no row matches, stop.';
  assert.deepEqual(parseDispatcherRoutes(text).map((x) => x.name), ['backend', 'qa']);
  const files = roster(['backend', 'qa'], 'implement → `backend` (see `docs`, `--flag`); QA → `qa`');
  assert.equal(checkRoster(makeSource({ root: '/', fsApi: fakeRepo(files).fsApi })).unresolved.length, 0);
});

test('3fe895f3 T10.AC1: parseAgentsMdTable warns on agent cells that are neither backticked nor bare identifiers', () => {
  const md = ['| Task | Agent |', '|---|---|', '| a | `ok` |', '| b | the QA team |', '| c | `Bad Name` |', '| d | bare-id |', '| e |  |'].join('\n');
  const t = parseAgentsMdTable(md);
  assert.deepEqual(t.names.map((n) => n.name), ['ok', 'bare-id']);
  assert.equal(t.warnings.length, 3);
  assert.match(t.warnings[0], /AGENTS\.md:4: .*the QA team.*neither a backticked nor a bare/);
});

test('3fe895f3 T10.AC1: main prints AGENTS.md cell warnings to stderr and still checks the rest', () => {
  const files = roster(['qa'], 'QA → `qa`', { [AGENTS_MD_REL]: '| Task | Agent |\n|---|---|\n| x | the QA team |\n' });
  const r = runMain(files, ['--ref', 'r']);
  assert.equal(r.code, 0, `${r.out}\n${r.err}`);
  assert.match(r.err, /warning: AGENTS\.md:3: .*the QA team/);
});

test('3fe895f3 T10.AC1: AGENTS.md absent from the repo is reported as "file not present", not a pass-through', () => {
  const r = checkRoster(makeSource({ root: '/', fsApi: fakeRepo(roster(['qa'], 'QA → `qa`')).fsApi }));
  assert.equal(r.agentsMdTable, 'no-file');
  assert.match(formatReport(r), /AGENTS\.md: file not present/);
});

test('3fe895f3 T10.AC1: an unknown --ref exits 2 with a one-line message including git stderr, no stack', () => {
  const r = runMain(roster(['qa'], 'QA → `qa`'), ['--ref', 'nope']);
  assert.equal(r.code, 2);
  assert.equal(r.err.split('\n').length, 1, r.err);
  assert.match(r.err, /unknown --ref "nope".*fatal: Needed a single revision/);
  assert.doesNotMatch(r.err, /\n\s+at /);
  assert.equal(runMain(roster(['qa'], 'QA → `qa`'), ['--ref', '--evil']).code, 2);
});

test('3fe895f3 T10.AC1: an unexpected internal error prints a stack only when GUARD_DEBUG is set', () => {
  const boom = (args) => { if (args[0] === 'rev-parse') return 'ok\n'; throw new TypeError('boom'); };
  const run = (env) => {
    const err = [];
    const code = main(['--ref', 'r'], { out: () => {}, err: (m) => err.push(m) }, boom, env);
    return { code, err: err.join('\n') };
  };
  const quiet = run({});
  assert.equal(quiet.code, 2);
  assert.doesNotMatch(quiet.err, /\n\s+at /);
  assert.match(quiet.err, /GUARD_DEBUG/);
  assert.match(run({ GUARD_DEBUG: '1' }).err, /\n\s+at /);
});

test('3fe895f3 T10.AC4: the suite is registered as an nx target that the default lint run depends on', () => {
  const project = JSON.parse(fs.readFileSync(path.join(TOOLS_DIR, '..', 'project.json'), 'utf8'));
  assert.equal(project.targets['roster-guard-test']?.options?.command, 'node tools/test-roster-guard.test.mjs');
  assert.ok(project.targets.lint.dependsOn.includes('roster-guard-test'), 'lint must depend on roster-guard-test');
});

// ---------- ff15d348 (T10b): role-resolution guard ----------

const roleBlock = ({ name, prefix, tools, noHolder }) => [
  `## role: ${name}`,
  `- prefix: ${prefix}`,
  `- ${prefix}.1: Do the ${name} thing [§1]`,
  `- ${prefix}.2: Do the other ${name} thing [§2]`,
  `- tools: ${tools}`,
  '- distinct-from:',
  '- hints:',
  '- independence: none stated.',
  `- no-holder: ${noHolder}`,
  '',
].join('\n');
const UNBOUND = 'unbound; review debt on the affected tests; deep-blocks: no';
const rolesMd = (...blocks) => `# Roles\n\n${blocks.join('\n')}`;
const agentManifest = (id, tools, covered) => JSON.stringify({
  id, type: 'agent', agent: { tools }, capabilities: covered.map((c) => `roles-covered:${c}`),
});
const rolesRepo = (roles, agents) => ({
  [ROLES_REL]: roles,
  ...Object.fromEntries(Object.entries(agents).map(([id, [tools, covered]]) => [`extensions/agents/${id}/extension.json`, agentManifest(id, tools, covered)])),
});
const rolesOf = (files) => checkRoles(makeSource({ root: '/', fsApi: fakeRepo(files).fsApi }));
const outcomes = (r) => Object.fromEntries(r.results.map((x) => [x.role, x.outcome]));

test('ff15d348 AC1: a role with a closest eligible agent by roles-covered resolves and names the holder', () => {
  const files = rolesRepo(rolesMd(roleBlock({ name: 'alpha', prefix: 'AA', tools: 'read, search', noHolder: 'escalate; deep-blocks: no' })), { aud: [['read', 'grep'], ['AA.1']] });
  const r = rolesOf(files);
  assert.equal(r.state, 'checked');
  assert.deepEqual(r.results.map((x) => [x.role, x.outcome, x.holder, x.covered]), [['alpha', 'resolved', 'aud', ['AA.1']]]);
  assert.deepEqual(r.unresolved, []);
});

test('ff15d348 AC1: a role no agent resolves but that declares itself unbound is accepted', () => {
  const files = rolesRepo(rolesMd(roleBlock({ name: 'beta', prefix: 'BB', tools: 'read', noHolder: UNBOUND })), { aud: [['read'], ['AA.1']] });
  const r = rolesOf(files);
  assert.deepEqual(outcomes(r), { beta: 'unbound' });
  assert.deepEqual(r.unresolved, []);
});

test('ff15d348 AC1: a role that resolves to no agent and is not declared unbound is unresolved, and main exits 1', () => {
  const files = {
    ...roster(['aud'], 'QA → `aud`'),
    ...rolesRepo(rolesMd(roleBlock({ name: 'gamma', prefix: 'GG', tools: 'read', noHolder: 'escalate to the owner; deep-blocks: no' })), { aud: [['read'], ['AA.1']] }),
  };
  files['extensions/agents/aud/extension.json'] = agentManifest('aud', ['read'], ['AA.1']);
  assert.deepEqual(rolesOf(files).unresolved.map((x) => x.role), ['gamma']);
  const r = runMain(files, ['--ref', 'r']);
  assert.equal(r.code, 1, `${r.out}\n${r.err}`);
  assert.match(r.out, /UNRESOLVED ROLE: gamma /);
  assert.match(r.out, /FAIL: 1 role\(s\)/);
});

test('ff15d348 AC1: one fixture roster proves all three outcomes (resolved, unbound, neither) and exit 0 once the missing agent is added', () => {
  const roles = rolesMd(
    roleBlock({ name: 'alpha', prefix: 'AA', tools: 'read', noHolder: 'escalate; deep-blocks: no' }),
    roleBlock({ name: 'beta', prefix: 'BB', tools: 'read', noHolder: UNBOUND }),
    roleBlock({ name: 'gamma', prefix: 'GG', tools: 'read', noHolder: 'escalate; deep-blocks: no' }),
  );
  const base = { ...roster(['one'], 'x → `one`'), ...rolesRepo(roles, { one: [['read'], ['AA.1']] }) };
  assert.deepEqual(outcomes(rolesOf(base)), { alpha: 'resolved', beta: 'unbound', gamma: 'unresolved' });
  assert.equal(runMain(base, ['--ref', 'r']).code, 1);
  const fixed = {
    ...base,
    'extensions/agents/gm/extension.json': agentManifest('gm', ['read'], ['GG.2']),
  };
  assert.deepEqual(outcomes(rolesOf(fixed)), { alpha: 'resolved', beta: 'unbound', gamma: 'resolved' });
  const ok = runMain({ ...fixed, ...roster(['one', 'gm'], 'x → `one`; y → `gm`') , ...rolesRepo(roles, { one: [['read'], ['AA.1']], gm: [['read'], ['GG.2']] }) }, ['--ref', 'r']);
  assert.equal(ok.code, 0, `${ok.out}\n${ok.err}`);
  assert.match(ok.out, /role alpha: resolved -> one/);
});

test('ff15d348 AC1: an agent that covers the role but lacks a required tool is ineligible; an agent covering nothing is not a holder', () => {
  const roles = rolesMd(roleBlock({ name: 'shelly', prefix: 'SH', tools: 'read, shell, edit, backlog', noHolder: 'escalate; deep-blocks: no' }));
  const noTool = rolesRepo(roles, { weak: [['read', 'bash', 'edit'], ['SH.1']], idle: [['read', 'bash', 'edit', { logical: 'backlog', server: 'backlog' }], []] });
  assert.deepEqual(outcomes(rolesOf(noTool)), { shelly: 'unresolved' });
  const full = rolesRepo(roles, { weak: [['read', 'bash', 'edit'], ['SH.1']], strong: [['read', 'bash', 'write', { logical: 'backlog', server: 'backlog' }], ['SH.2']] });
  const r = rolesOf(full);
  assert.deepEqual(r.results.map((x) => [x.holder, x.covered]), [['strong', ['SH.2']]]);
});

test('ff15d348 AC1: closeness is the count of the role obligation ids covered; hints, then name, break ties only', () => {
  const roles = rolesMd(roleBlock({ name: 'alpha', prefix: 'AA', tools: 'read', noHolder: UNBOUND })).replace('- hints:', '- hints: zed');
  const files = rolesRepo(roles, { aaa: [['read'], ['AA.1']], bbb: [['read'], ['AA.1', 'AA.2']], zed: [['read'], ['AA.1']] });
  assert.equal(rolesOf(files).results[0].holder, 'bbb');
  const tie = rolesRepo(roles, { aaa: [['read'], ['AA.1']], zed: [['read'], ['AA.1']] });
  assert.equal(rolesOf(tie).results[0].holder, 'zed');
  const plain = rolesRepo(rolesMd(roleBlock({ name: 'alpha', prefix: 'AA', tools: 'read', noHolder: UNBOUND })), { zzz: [['read'], ['AA.1']], aaa: [['read'], ['AA.1']] });
  assert.equal(rolesOf(plain).results[0].holder, 'aaa');
});

test('ff15d348 AC1: a repo/ref with no roles.md says so and checks no roles; invalid roles.md cannot run (exit 2)', () => {
  const none = rolesOf(roster(['qa'], 'QA → `qa`'));
  assert.equal(none.state, 'absent');
  assert.deepEqual(none.unresolved, []);
  assert.match(formatReport({ ...checkRoster(makeSource({ root: '/', fsApi: fakeRepo(roster(['qa'], 'QA → `qa`')).fsApi })) }), /roles: .*not present/);
  const bad = { ...roster(['qa'], 'QA → `qa`'), [ROLES_REL]: '# Roles\n\nno sections\n' };
  const r = runMain(bad, ['--ref', 'r']);
  assert.equal(r.code, 2);
  assert.match(r.err, /roles\.md/);
});

test('ff15d348 AC2: the real roster (working tree) has no unresolved role', () => {
  const root = path.resolve(TOOLS_DIR, '..');
  const r = checkRoles(makeSource({ root }));
  assert.equal(r.state, 'checked');
  assert.ok(r.results.length >= 13, `expected the 13 testing-standard roles, got ${r.results.length}`);
  assert.deepEqual(r.unresolved.map((x) => x.role), []);
});
