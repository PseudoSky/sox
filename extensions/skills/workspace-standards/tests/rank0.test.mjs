// 595965cc T47 AC1 rank0 (owner ruling 2026-10-12): a tool-eligible agent with no declared coverage is NOT a holder.
// The role is unbound, follows its roles.md no-holder entry, and lowers the reported level.
// Pure: in-memory manifests and a temp dir; no process is spawned and no model is invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFoundation, composeRouting, loadStandards, EXIT } from '../scripts/foundations.mjs';
import { resolveRole } from '../scripts/lib.mjs';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTING = loadStandards({ skillRoot: SKILL }).find((s) => s.id === 'testing');
const TOOLS = ['read', 'grep', 'glob', 'bash', 'edit', 'backlog'];
const agent = (name, covers = []) => ({
  agent: name,
  manifest: { id: name, agent: { tools: TOOLS }, capabilities: covers.map((c) => `roles-covered:${c}`) },
});
const SR = TESTING.roles.find((r) => r.name === 'static-reviewer');
const srIds = SR.obligations.map((o) => o.id);
const N = (n, s) => `595965cc T47 AC1 rank0-${n}: ${s}`;

test(N(1, 'a tool-eligible agent with no declared coverage never holds a role; a covered agent still does'), () => {
  const bare = resolveRole(SR, [agent('bare')]);
  assert.equal(bare.holder, null, 'zero coverage is not a holder');
  const covered = resolveRole(SR, [agent('bare'), agent('covers', srIds)]);
  assert.equal(covered.holder, 'covers');
  assert.ok(covered.rank > 0);
});

test(N(2, 'routing composition lists zero-coverage roles as unbound and flags no closeness-0 binding'), () => {
  const r = composeRouting({ standards: [TESTING], agents: [agent('reviewer', srIds)] });
  assert.ok(r.unbound.includes('testing/triager'), 'a role no agent covers is unbound');
  assert.ok(!r.unbound.includes('testing/static-reviewer'), 'a covered role is bound');
  assert.deepEqual(r.boundNoCoverage, [], 'no role can be held at closeness 0');
  assert.ok(r.body.includes('| static-reviewer | testing | `reviewer` | SR.1, SR.2, SR.3, SR.4 |'), 'covered row is plain');
});

test(N(3, 'review routing lowers the reported level for unbound roles without changing the exit code'), () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-rank0-'));
  try {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Repo\n');
    const run = (agents) => applyFoundation({ target: 'routing', root: dir, standards: [TESTING], agents, noFile: true });
    const thin = run([agent('reviewer', srIds)]);
    assert.equal(thin.level, 'lowered');
    assert.ok(thin.unbound.length > 0);
    assert.equal(thin.exit, EXIT.OK, 'lowering the level does not fail the run');
    const full = run(TESTING.roles.map((r) => agent(`holder-${r.name}`, r.obligations.map((o) => o.id))));
    assert.deepEqual(full.unbound, []);
    assert.equal(full.level, 'full');
    const check = applyFoundation({ target: 'routing', root: dir, standards: [TESTING], agents: [agent('reviewer', srIds)], check: true, noFile: true });
    assert.equal(check.exit === EXIT.OK || check.exit === EXIT.DRIFT, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
