// 595965cc T41.AC6 name independence, T41.AC7 unbound roles. Fixtures are temp dirs; nothing is spawned except the CLI.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadAgents, parseRoles } from '../scripts/lib.mjs';
import { purposeTags, nameIndependence, unboundRoles } from '../scripts/testing-review.mjs';

const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(SKILL_ROOT, 'scripts/testing-review.mjs');
const REAL_ROLES = path.join(SKILL_ROOT, 'standards/testing/roles.md');
// Fixture copy of the §2.3 table shape (tags as STRATEGY lists them); the real section lives in the adhd repo.
const STRATEGY = [
  '# Strategy', '', '## 2. Vocabulary', '', '### 2.3 Purpose tags — why the test exists', '',
  '| Tag | Meaning |', '|---|---|',
  '| `smoke` | Minimal proof |', '| `regression:<id>` | Guards one fixed defect |',
  '| `concurrency`, `durability` | Multi-actor safety |', '| `security`, `performance`, `accessibility` | Non-functional |',
  '', '### 2.4 Next section', '| `qa` | not a tag, in a later section |', '',
].join('\n');

function tmp(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'));
  for (const [rel, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  return dir;
}

test('595965cc T41.AC6 purposeTags reads every §2.3 tag and no later section', () => {
  const tags = purposeTags(STRATEGY);
  for (const t of ['smoke', 'regression', 'concurrency', 'durability', 'security', 'performance', 'accessibility']) assert.ok(tags.has(t), t);
  assert.equal(tags.has('qa'), false, 'a table in §2.4 is not a purpose tag');
  assert.equal(purposeTags('# no section'), null);
});

test('595965cc T41.AC6 a seeded backticked agent name fails at its line; a purpose tag that is also an agent name does not', () => {
  const agentNames = new Set(['qa', 'security']);
  const exempt = purposeTags(STRATEGY);
  const seeded = nameIndependence({ text: 'line one\nAssign to `qa` here\nthe `security` tag\n', agentNames, exempt });
  assert.deepEqual(seeded, [{ line: 2, name: 'qa' }], 'security is an exempt tag; qa is a violation');
  assert.deepEqual(nameIndependence({ text: 'clean `regression:x` and `smoke`\n', agentNames, exempt }), []);
});

test('595965cc T41.AC7 unboundRoles lists unbound and closeness-0 roles, and omits fully covered ones', () => {
  const roles = parseRoles(fs.readFileSync(REAL_ROLES, 'utf8')).roles;
  const tools = ['read', 'grep', 'bash', 'edit', 'backlog']; // logical names agentToolSet maps to read/search/shell/edit/backlog
  const agents = [
    { agent: 'covers-au', manifest: { id: 'covers-au', agent: { tools }, capabilities: ['roles-covered:AU.1', 'roles-covered:AU.2', 'roles-covered:AU.3', 'roles-covered:AU.4', 'roles-covered:AU.5'] } },
    { agent: 'plain', manifest: { id: 'plain', agent: { tools }, capabilities: ['roles-covered:none'] } },
  ];
  const debt = unboundRoles({ roles, agents });
  const auditor = debt.find((d) => d.role === 'auditor');
  assert.equal(auditor, undefined, 'the auditor is fully covered by covers-au');
  const triager = debt.find((d) => d.role === 'triager');
  assert.equal(triager.status, 'no-declared-coverage', 'plain is eligible at closeness 0');
  // Closeness-0 eligibility is the existing rule (resolveRole); the tie goes to the first name. Recorded as review debt, not a block.
  assert.equal(triager.holder, 'covers-au');
  assert.equal(debt.find((d) => d.role === 'risk-owner').status, 'no-declared-coverage');
});

test('595965cc T41.AC6 CLI exits 1 on a seeded violation and 0 on a clean document; a missing strategy is E_USAGE', () => {
  const agentsDir = tmp({ 'qa/extension.json': JSON.stringify({ id: 'qa', agent: { tools: ['read'] }, capabilities: [] }), 'x/.keep': '' });
  const strategy = path.join(agentsDir, 'STRATEGY.md');
  fs.writeFileSync(strategy, STRATEGY);
  const bad = path.join(agentsDir, 'bad.md');
  fs.writeFileSync(bad, 'Use `qa` for this.\n');
  const good = path.join(agentsDir, 'good.md');
  fs.writeFileSync(good, 'Only `smoke` here.\n');
  const common = ['--agents-dir', agentsDir, '--roles', REAL_ROLES, '--strategy', strategy];
  const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8' });
  const v = run([...common, '--doc', bad]);
  assert.equal(v.status, 1);
  assert.equal(JSON.parse(v.stdout).nameIndependence[0].name, 'qa');
  assert.equal(run([...common, '--doc', good]).status, 0);
  const usage = run(['--agents-dir', agentsDir, '--roles', REAL_ROLES]);
  assert.equal(usage.status, 64);
  assert.equal(JSON.parse(usage.stderr).error.code, 'E_USAGE');
  assert.equal(loadAgents(agentsDir).length, 1);
});
