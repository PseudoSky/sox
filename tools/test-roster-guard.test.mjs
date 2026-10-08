#!/usr/bin/env node
/**
 * tools/test-roster-guard.test.mjs — tests for tools/test-roster-guard.mjs (backlog 3fe895f3, T10).
 *
 * Unit tests inject a fake `git` and an in-memory fs, so nothing spawns a process. The AC2 red-proof
 * is driven from a committed snapshot of 27be064c (tools/fixtures/test-roster-guard/) and never
 * depends on repo history. One real-git check re-confirms it against the sha itself and SKIPS with a
 * printed reason when the sha is not in this clone.
 *
 * Run: node tools/test-roster-guard.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DISPATCHER_REL, AGENTS_MD_REL, GuardError, parseDispatcherRoutes, parseAgentsMdTable,
  makeSource, checkRoster, formatReport, main, realGit,
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

// The ONE real-git check. The pinned-snapshot test above is the red-proof; this re-confirms against
// the sha itself and skips (with a printed reason) when the sha is not in this clone.
test('3fe895f3 T10.AC2 (real git): the guard is red on the real 27be064c, matching the snapshot', (t) => {
  try {
    execFileSync('git', ['cat-file', '-e', `${SNAPSHOT_REF}^{commit}`], { cwd: TOOLS_DIR, stdio: 'pipe' });
  } catch (e) {
    const reason = `commit ${SNAPSHOT_REF} not present in this clone (git cat-file -e failed: ${String(e.stderr ?? e.message).trim() || 'no stderr'}); the pinned snapshot test is the AC2 red-proof`;
    console.log(`SKIP: ${reason}`);
    t.skip(reason);
    return;
  }
  const out = [];
  const err = [];
  const code = main(['--ref', SNAPSHOT_REF, '--root', path.resolve(TOOLS_DIR, '..')], { out: (m) => out.push(m), err: (m) => err.push(m) }, realGit);
  const msg = `stdout:\n${out.join('\n')}\nstderr:\n${err.join('\n')}`;
  assert.equal(code, 1, msg);
  const unresolved = [...out.join('\n').matchAll(/^UNRESOLVED: (\S+) /gm)].map((m) => m[1]).sort();
  assert.deepEqual(unresolved, EXPECTED_RED, msg);
});
