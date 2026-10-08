#!/usr/bin/env node
/**
 * tools/test-roster-guard.test.mjs — tests for tools/test-roster-guard.mjs (backlog 3fe895f3, T10).
 *
 * Unit tests inject a fake `git` and an in-memory fs, so nothing spawns a process. The single e2e
 * test runs the real CLI against the real sha 27be064c (3fe895f3 T10.AC2).
 *
 * Run: node tools/test-roster-guard.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DISPATCHER_REL, AGENTS_MD_REL, GuardError, parseDispatcherRoutes, parseAgentsMdTable,
  makeSource, checkRoster, formatReport, main,
} from './test-roster-guard.mjs';

const TOOLS_DIR = path.dirname(fileURLToPath(import.meta.url));

const rule = (rows) =>
  `5. **Route each bucket to a named domain specialist.** Work class → executor: ${rows}. **If no row matches, STOP.** Pick the declared tier (\`sonnet\`).`;

/** In-memory repo: files = { relPath: content }. Exposes fs-like and git-like views of it. */
function fakeRepo(files) {
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
    if (args[0] === 'ls-tree' && args[1] === '-d') return dirs(args[4].replace(/\/$/, '')).map((n) => `${args[4]}${n}`).join('\n');
    if (args[0] === 'ls-tree') return Object.hasOwn(files, args[4]) ? `${args[4]}\n` : '';
    if (args[0] === 'show') return files[args[1].split(':')[1]];
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
  assert.ok(repo.calls.length > 0 && repo.calls.every((c) => c[0] === 'ls-tree' || c[0] === 'show'));
  assert.ok(repo.calls.every((c) => !['checkout', 'switch', 'reset'].includes(c[0])));
});

test('3fe895f3 T10.AC2: a directory without extension.json is warned about, not counted as installed', () => {
  const files = roster(['qa'], 'QA → `qa`; x → `stray`', { 'extensions/agents/stray/README.md': 'x' });
  const r = checkRoster(makeSource({ root: '/', fsApi: fakeRepo(files).fsApi }));
  assert.deepEqual(r.unresolved.map((u) => u.name), ['stray']);
  assert.match(r.warnings.join('\n'), /stray: no extension\.json/);
});

test('3fe895f3 T10.AC2 (e2e, real git): the guard is red on 27be064c and names review, backend, refactor, test, general', () => {
  let code = 0;
  let stdout = '';
  try {
    stdout = execFileSync('node', [path.join(TOOLS_DIR, 'test-roster-guard.mjs'), '--ref', '27be064c'], { encoding: 'utf8' });
  } catch (e) {
    code = e.status ?? -1;
    stdout = String(e.stdout);
  }
  assert.equal(code, 1, stdout);
  for (const n of ['review', 'backend', 'refactor', 'test', 'general']) {
    assert.match(stdout, new RegExp(`UNRESOLVED: ${n} `), `missing ${n}`);
  }
});
