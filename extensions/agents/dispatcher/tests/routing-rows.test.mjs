/**
 * Unit (no process, no network): the dispatcher's Step 2 routing rows resolve to installed agents.
 * 595965cc T12 — dispatcher routing fix. Run: node --test tests/*.test.mjs (from extensions/agents/dispatcher).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRoster, makeSource, parseDispatcherRoutes, readAgentManifests } from '../../../../tools/test-roster-guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const DISPATCHER = path.join(REPO, 'extensions/agents/dispatcher/dispatcher.md');
const text = fs.readFileSync(DISPATCHER, 'utf8');
const routed = parseDispatcherRoutes(text).map((r) => r.name);
const installed = new Set(readAgentManifests(makeSource({ root: REPO })).agents.map((a) => a.id));
const flat = text.replace(/\s+/g, ' ');

test('595965cc T12.AC1: every routed name in dispatcher.md is an installed agent extension', () => {
  const missing = routed.filter((n) => !installed.has(n));
  assert.deepEqual(missing, [], `routed names with no installed extension: ${missing.join(', ')}`);
});

test('595965cc T12.AC2: test running/audit routes to qa, static and blind review to review, implement and refactor to typescript', () => {
  assert.match(flat, /QA, test runs and test audit → `qa`/);
  assert.match(flat, /static and blind review → `review`/);
  assert.match(flat, /implement, restructure, refactor or type-system work → `typescript`/);
  assert.ok(installed.has('typescript'));
});

test('595965cc T12.AC2: UI, CI/CD and security work route to installed specialists, not typescript', () => {
  assert.match(flat, /UI, front-end or styling work → `ui`/);
  assert.match(flat, /CI\/CD or release-pipeline work → `devops`/);
  assert.match(flat, /security audit → `security`/);
  for (const n of ['ui', 'devops', 'security']) assert.ok(installed.has(n), n);
});

test('595965cc T12.AC2: no routing row names general', () => {
  assert.ok(!routed.includes('general'), `routed: ${routed.join(', ')}`);
  const rows = flat.slice(flat.indexOf('Work class → executor'), flat.indexOf('If no row matches'));
  assert.doesNotMatch(rows, /→ `general`/);
});

test('595965cc T12.AC4: no routing row names the undefined test agent; test authoring resolves to test-author', () => {
  assert.ok(!routed.includes('test'), `routed: ${routed.join(', ')}`);
  assert.match(flat, /test planning and test authoring → `test-author`/);
  assert.ok(installed.has('test-author'));
});

test('595965cc T12.AC4: the precedence is the AGENTS.md table, then the resolveRole role binding, then the work-class rows', () => {
  const item5 = flat.slice(flat.indexOf('5. **Route each bucket'), flat.indexOf('6. If the order matters'));
  const at = ['task-to-agent table in AGENTS.md (T49)', '`resolveRole`', 'work-class rows below'].map((p) => item5.indexOf(p));
  assert.ok(at.every((i) => i >= 0), `positions: ${at.join(',')}`);
  assert.ok(at[0] < at[1] && at[1] < at[2], `out of order: ${at.join(',')}`);
});

test('595965cc T12.AC2: the guard reports every routed name as bound to an installed agent', () => {
  const r = checkRoster(makeSource({ root: REPO }));
  assert.deepEqual(r.unresolved, [], JSON.stringify(r.unresolved));
});
