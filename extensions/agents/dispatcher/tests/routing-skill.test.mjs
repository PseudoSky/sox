/**
 * Unit (reads files, spawns nothing): dispatch-direct SKILL.md routes exactly as dispatcher.md Step 2 item 5.
 * 595965cc T12.AC2 / T12.AC4 — dispatcher routing fix. Run: node --test tests/*.test.mjs (from extensions/agents/dispatcher).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSource, readAgentManifests } from '../../../../tools/test-roster-guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const d = fs.readFileSync(path.join(REPO, 'extensions/agents/dispatcher/dispatcher.md'), 'utf8').replace(/\s+/g, ' ');
const s = fs.readFileSync(path.join(REPO, 'extensions/skills/dispatch-direct/SKILL.md'), 'utf8').replace(/\s+/g, ' ');

const slice = (text, from, to) => {
  const a = text.indexOf(from);
  const b = a === -1 ? -1 : text.indexOf(to, a + 1);
  assert.ok(a !== -1 && b !== -1, `region ${JSON.stringify(from)} .. ${JSON.stringify(to)} not found`);
  return text.slice(a, b);
};
const dispatcherRows = () => slice(d, 'Work class → executor:', 'If no row matches');
const dispatcherItem5 = () => slice(d, '5. **Route each bucket', '6. If the order matters');
const directItem6 = () => slice(s, '6. **Route.**', '7. **Brief');
const directRows = () => slice(s, 'Typical matches:', '**Role holders:**');
/** Agent names in a routing region: backticked identifiers, the same filter the roster guard applies. */
const names = (t) => [...new Set([...t.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim())
  .filter((x) => /^[a-z][a-z0-9-]*$/.test(x) && !['sonnet', 'opus', 'haiku'].includes(x)))].sort();
const installed = new Set(readAgentManifests(makeSource({ root: REPO })).agents.map((a) => a.id));
const GENERIC_STOP = 'If no row matches, STOP and surface the roster gap to the user; the generic catch-all is never a route.';

test('595965cc T12.AC2: dispatch-direct names exactly the agents of the dispatcher work-class sentence', () => {
  assert.deepEqual(names(directRows()), names(dispatcherRows()));
});

test('595965cc T12.AC2: every agent dispatch-direct routes to is installed', () => {
  const missing = names(directRows()).filter((n) => !installed.has(n));
  assert.deepEqual(missing, [], `not installed: ${missing.join(', ')}`);
});

test('595965cc T12.AC2: refactor routes to typescript and UI, CI/CD, security route to ui, devops, security in both files', () => {
  for (const [label, t] of [['dispatcher', dispatcherRows()], ['dispatch-direct', directRows()]]) {
    assert.match(t, /refactor[^;]*→ `typescript`/, label);
    assert.match(t, /UI, front-end or styling work → `ui`/, label);
    assert.match(t, /CI\/CD or release-pipeline work → `devops`/, label);
    assert.match(t, /security audit → `security`/, label);
  }
});

test('595965cc T12.AC4: dispatch-direct routes test authoring to test-author and names no backend, refactor-agent or test-agent route', () => {
  assert.match(directRows(), /test authoring[^;]*→ `test-author`/);
  assert.deepEqual(names(directRows()).filter((n) => ['backend', 'refactor', 'test'].includes(n)), []);
  assert.doesNotMatch(s, /→ `(backend|refactor|test)`/);
});

test('595965cc T12.AC4: dispatch-direct states the precedence in three levels: AGENTS.md table, then resolveRole, then work-class rows', () => {
  const item6 = directItem6();
  const at = ['the AGENTS.md task-to-agent table', '`resolveRole`', 'work-class rows'].map((p) => item6.indexOf(p));
  assert.ok(at.every((i) => i >= 0), `positions: ${at.join(',')}`);
  assert.ok(at[0] < at[1] && at[1] < at[2], `out of order: ${at.join(',')}`);
});

test('595965cc T12.AC2: dispatcher and dispatch-direct carry the same stop rule and no last-resort or fallback wording', () => {
  assert.ok(d.includes(GENERIC_STOP), 'dispatcher.md');
  assert.ok(s.includes(GENERIC_STOP), 'dispatch-direct SKILL.md');
  for (const [label, t] of [['dispatcher item 5', dispatcherItem5()], ['dispatch-direct item 6', directItem6()]]) {
    assert.doesNotMatch(t, /last resort|LAST RESORT|never fall back/, label);
    assert.doesNotMatch(t, /`general`/, label);
  }
});
