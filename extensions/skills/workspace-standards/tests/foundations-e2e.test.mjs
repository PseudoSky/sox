// 595965cc T49 and 39a21823 T48 e2e: apply routing, apply gates, apply testing, and review drift on one shared scaffold root. The CLI runs as
// real child processes (node only, never a model or the backlog: --no-file), the T10 roster guard is read
// in-process, and the scaffold is a temp directory removed at teardown. Wall-clock is reported with t.diagnostic.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadStandards, EXIT } from '../scripts/foundations.mjs';
import { EXIT as TESTING_EXIT } from '../scripts/apply-testing.mjs';
import { inspectBlock } from '../scripts/marker-engine.mjs';
import { checkRoster, makeSource } from '../../../../tools/test-roster-guard.mjs';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(SKILL, 'scripts', 'foundations.mjs');
const APPLY_TESTING = path.join(SKILL, 'scripts', 'apply-testing.mjs');
const TESTING = loadStandards({ skillRoot: SKILL }).find((s) => s.id === 'testing');
const role = (name) => TESTING.roles.find((r) => r.name === name);
const idsOf = (r) => r.obligations.map((o) => o.id);
const ALL_TOOLS = ['read', 'grep', 'glob', 'bash', 'edit', 'backlog'];
let tmp;
let dir;

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-foundations-e2e-'));
  dir = path.join(tmp, 'repo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Repo\n\nProse outside the managed blocks.\n');
  const agents = [
    ['author-fixture', { type: 'agent', capabilities: idsOf(role('test-author')).map((i) => `roles-covered:${i}`), agent: { tools: ALL_TOOLS } }],
    ['reviewer-fixture', { type: 'agent', capabilities: idsOf(role('static-reviewer')).map((i) => `roles-covered:${i}`), agent: { tools: ALL_TOOLS } }],
  ];
  for (const [id, manifest] of agents) {
    fs.mkdirSync(path.join(dir, 'extensions/agents', id), { recursive: true });
    fs.writeFileSync(path.join(dir, 'extensions/agents', id, 'extension.json'), JSON.stringify({ id, ...manifest }));
  }
  fs.mkdirSync(path.join(dir, 'extensions/agents/dispatcher'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'extensions/agents/dispatcher/dispatcher.md'),
    'Route each bucket by its work class.\n\nWork class → executor:\n- docs → `reviewer-fixture`\n\nIf no row matches, stop and ask.\n');
  fs.writeFileSync(path.join(dir, 'gates.table.json'), JSON.stringify({ gates: [{ id: 'G1', stage: ['D'], mechanism: 'mechanical', command: 'true' }] }));
});

after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

const cli = (...args) => spawnSync(process.execPath, [CLI, ...args, '--root', dir], { encoding: 'utf8' });
/** The JSON summary the CLI prints as its final stdout line. */
const summary = (r) => JSON.parse(r.stdout.trim().split('\n').pop());

test('595965cc T49 AC1 AC2 AC5 AC7 e2e: apply routing, apply gates, review drift, and the T10 guard on one scaffold', (t) => {
  const t0 = Date.now();

  const routing = cli('apply', 'routing', '--no-file');
  assert.equal(routing.status, EXIT.OK, routing.stderr);
  assert.deepEqual(summary(routing).wrote.sort(), ['AGENTS.md', 'docs/standards/roles.md'], 'apply routing writes the block and roles.md');

  const gates = cli('apply', 'gates', '--no-file');
  assert.equal(gates.status, EXIT.OK, gates.stderr);
  assert.equal(summary(gates).wouldFile.length, 9, 'the nine mechanical gates without a command are listed, not filed');

  assert.equal(cli('review', 'routing').status, EXIT.OK, 'review routing is clean after apply');
  assert.equal(cli('review', 'gates').status, EXIT.OK, 'review gates is clean after apply');
  assert.equal(cli('apply', 'gates', '--no-file').status, EXIT.OK, 'a second gates run exits clean');
  assert.deepEqual(summary(cli('apply', 'routing', '--no-file')).wrote, [], 'a second routing run writes nothing');

  const agentsPath = path.join(dir, 'AGENTS.md');
  const text = fs.readFileSync(agentsPath, 'utf8');
  fs.writeFileSync(agentsPath, text.replace('| new-behavior | testing | test-author | `author-fixture` |', '| new-behavior | testing | test-author | `hand-edited` |'));
  const drift = cli('review', 'routing');
  assert.equal(drift.status, EXIT.DRIFT, 'a hand edit inside the routing block is drift');
  assert.match(drift.stderr, /DRIFT AGENTS\.md \[routing\]/);
  assert.equal(cli('review', 'gates').status, EXIT.OK, 'review gates is not affected by the routing edit');
  assert.equal(cli('apply', 'routing', '--no-file').status, EXIT.DRIFT, 'apply refuses to overwrite a drifted block without --force');
  assert.equal(cli('apply', 'routing', '--no-file', '--force').status, EXIT.OK, '--force restores the block');
  assert.equal(cli('review', 'routing').status, EXIT.OK, 'review routing is clean again');

  const body = inspectBlock(fs.readFileSync(agentsPath, 'utf8'), 'routing').body;
  assert.match(body, /wins over the dispatcher's own default rows/, 'precedence statement in the applied block');
  const result = checkRoster(makeSource({ root: dir }));
  assert.equal(result.agentsMdTable, 'found');
  assert.deepEqual(result.unresolved, [], 'the T10 guard resolves every routed name');
  assert.ok(fs.readFileSync(agentsPath, 'utf8').includes('Prose outside the managed blocks.'), 'prose outside the markers survives every run');

  const ms = Date.now() - t0;
  t.diagnostic(`595965cc T49 e2e wall-clock: ${ms} ms (real CLI child processes, one scaffold)`);
  assert.ok(ms < 60_000, `e2e stays a fast lane (${ms} ms)`);
});

// 39a21823 T48 e2e: the apply-testing CLI against a real git repository (the unit suite is in-process only).
test('39a21823 AC3 AC4 AC6 e2e: apply testing twice leaves git diff --exit-code at 0, drift exits 3 via --check, --dry-run writes nothing', (t) => {
  const t0 = Date.now();
  const repo = path.join(tmp, 'repo-t48');
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# My repo\n\nSome prose.\n');
  const apply = (...args) => spawnSync(process.execPath, [APPLY_TESTING, '--root', repo, ...args], { encoding: 'utf8' });
  const git = (...args) => spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, encoding: 'utf8' });

  const dry = apply('--dry-run');
  assert.equal(dry.status, 0, dry.stderr);
  assert.match(dry.stdout, /^\+## Testing$/m);
  assert.match(dry.stdout, /^\+\+\+ b\/docs\/standards\/testing\.md$/m);
  assert.deepEqual(fs.readdirSync(repo), ['AGENTS.md'], '--dry-run writes nothing');

  assert.equal(apply('--no-file').status, 0);
  assert.equal(git('init', '-q').status, 0);
  assert.equal(git('add', '-A').status, 0);
  assert.equal(git('commit', '-q', '-m', 'first').status, 0);
  assert.equal(apply('--no-file').status, 0, 'second run');
  assert.equal(git('diff', '--exit-code').status, 0, 'second run changes nothing');
  assert.equal(git('status', '--porcelain').stdout, '');

  const agentsPath = path.join(repo, 'AGENTS.md');
  fs.writeFileSync(agentsPath, fs.readFileSync(agentsPath, 'utf8').replace('Default test tier is S', 'Default test tier is Z'));
  const chk = apply('--check');
  assert.equal(chk.status, TESTING_EXIT.DRIFT);
  assert.match(chk.stderr, /DRIFT AGENTS\.md \[testing\]/);

  const ms = Date.now() - t0;
  t.diagnostic(`39a21823 T48 e2e wall-clock: ${ms} ms (real CLI and git child processes)`);
  assert.ok(ms < 60_000, `e2e stays a fast lane (${ms} ms)`);
});
