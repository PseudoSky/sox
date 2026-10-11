/**
 * Unit (no process, no network): the dispatcher's Step 2 routing rows resolve to installed agents.
 * 595965cc T12 — dispatcher routing fix. Run: node --test tests/*.test.mjs (from extensions/agents/dispatcher).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDispatcherRoutes } from '../../../../tools/test-roster-guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const DISPATCHER = path.join(REPO, 'extensions/agents/dispatcher/dispatcher.md');
const text = fs.readFileSync(DISPATCHER, 'utf8');
const routed = parseDispatcherRoutes(text).map((r) => r.name);
const installed = (name) => {
  const manifest = path.join(REPO, 'extensions/agents', name, 'extension.json');
  return fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).id === name;
};
const flat = text.replace(/\s+/g, ' ');

test('595965cc T12.AC1: every routed name in dispatcher.md is an installed agent extension', () => {
  const missing = routed.filter((n) => !installed(n));
  assert.deepEqual(missing, [], `routed names with no installed extension: ${missing.join(', ')}`);
});

test('595965cc T12.AC2: test running/audit routes to qa, static and blind review to review, implement and refactor to an installed specialist', () => {
  assert.match(flat, /QA, test runs and test audit → `qa`/);
  assert.match(flat, /static and blind review → `review`/);
  assert.match(flat, /implement, restructure or type-system work → `typescript`/);
  assert.ok(installed('typescript'));
});

test('595965cc T12.AC2: no routing row names general', () => {
  assert.ok(!routed.includes('general'), `routed: ${routed.join(', ')}`);
  const rows = flat.slice(flat.indexOf('Work class → executor'), flat.indexOf('If no row matches'));
  assert.doesNotMatch(rows, /→ `general`/);
});

test('595965cc T12.AC4: no routing row names the undefined test agent; test authoring resolves to test-author', () => {
  assert.ok(!routed.includes('test'), `routed: ${routed.join(', ')}`);
  assert.match(flat, /test planning and test authoring → `test-author`/);
  assert.ok(installed('test-author'));
});

test('595965cc T12.AC4: the precedence statement puts the AGENTS.md task-to-agent table first and the rows second', () => {
  assert.match(flat, /task-to-agent table in AGENTS\.md \(T49\) wins when one exists; the rows below are defaults used only when it does not/);
});
