/**
 * 595965cc T47 AC4 — the real qa manifest holds the Auditor role (roles.md `auditor`: tools read, search,
 * shell, edit; distinct-from test-author, implementer). Every assertion runs against the REAL manifests under
 * extensions/agents/<id>/extension.json, not a fixture.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { agentToolSet, loadAgents, parseRoles, readText, resolveRole } from '../../skills/workspace-standards/scripts/lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '../../..');
const AGENTS = join(REPO, 'extensions/agents');
const QA = join(AGENTS, 'qa/extension.json');
const manifest = JSON.parse(readFileSync(QA, 'utf8'));
const { roles } = parseRoles(readText(join(REPO, 'extensions/skills/workspace-standards/standards/testing/roles.md')));
const auditor = roles.find((r) => r.name === 'auditor');
const AC = (s) => `595965cc T47 AC4 ${s}`;

test(AC('qa-1 agentToolSet(real qa manifest) maps grep/glob to search, so the Auditor tool set is complete'), () => {
  const have = agentToolSet(manifest);
  assert.ok(have.has('search'), 'search from grep/glob');
  for (const t of auditor.tools) assert.ok(have.has(t), `auditor tool ${t}`);
});

test(AC('qa-1 resolveRole(auditor) over the REAL roster binds a fresh qa at the full AU.1-5 closeness'), () => {
  const agents = loadAgents(AGENTS);
  assert.ok(agents.some((a) => a.agent === 'qa' && !a.loadError && !a.shapeError), 'real qa loads');
  const got = resolveRole(auditor, agents);
  assert.equal(got.holder, 'qa');
  assert.deepEqual([...got.covered].sort(), ['AU.1', 'AU.2', 'AU.3', 'AU.4', 'AU.5']);
});

test(AC('qa-2 a qa session holding test-author is excluded from auditor by distinct-from; a fresh qa stays eligible'), () => {
  const agents = loadAgents(AGENTS);
  const authored = resolveRole(auditor, agents, { session: { agent: 'qa', holds: ['test-author'] } });
  assert.notEqual(authored.holder, 'qa');
  const alsoImpl = resolveRole(auditor, agents, { session: { agent: 'qa', holds: ['implementer'] } });
  assert.notEqual(alsoImpl.holder, 'qa');
  const fresh = resolveRole(auditor, agents, { session: { agent: 'qa', holds: [] } });
  assert.equal(fresh.holder, 'qa');
  assert.equal(resolveRole(auditor, agents, { session: null }).holder, 'qa');
});

test(AC('qa-3 roles-covered declaration is unchanged: exactly AU.1-5 and SO.1-3'), () => {
  const declared = manifest.capabilities.filter((c) => c.startsWith('roles-covered:')).map((c) => c.split(':')[1]);
  assert.deepEqual(declared, ['AU.1', 'AU.2', 'AU.3', 'AU.4', 'AU.5', 'SO.1', 'SO.2', 'SO.3']);
});
