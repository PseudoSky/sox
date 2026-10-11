// 595965cc T47 AC1 rank0: a role bound at closeness 0 (tools only, no declared coverage) keeps binding
// exactly as before, and is made visible: flagged, warned, and counted toward a lowered reported level.
// Pure: in-memory manifests and a temp dir; no process is spawned and no model is invoked.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyFoundation, composeRouting, loadStandards, BOUND_NO_COVERAGE, EXIT } from '../scripts/foundations.mjs';
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
const noCoverageRoles = (agents) => TESTING.roles
  .filter((r) => { const x = resolveRole(r, agents); return x.holder && x.covered.length === 0; })
  .map((r) => `testing/${r.name}`);

test(N(1, 'resolveRole still binds a tool-eligible zero-coverage agent at closeness 0 when no covered agent is eligible'), () => {
  const got = resolveRole(SR, [agent('bare')]);
  assert.equal(got.holder, 'bare');
  assert.equal(got.rank, 0);
  assert.deepEqual(got.covered, []);
  const both = resolveRole(SR, [agent('bare'), agent('covers', srIds)]);
  assert.equal(both.holder, 'covers', 'a covered agent still wins');
});

test(N(2, 'the routing composition flags every closeness-0 binding, warns, and leaves covered bindings unflagged'), () => {
  const agents = [agent('reviewer', srIds)];
  const expected = noCoverageRoles(agents);
  assert.ok(expected.length > 0, 'fixture must produce at least one closeness-0 binding');
  const r = composeRouting({ standards: [TESTING], agents });
  assert.deepEqual(r.boundNoCoverage, expected);
  assert.ok(!r.boundNoCoverage.includes('testing/static-reviewer'), 'a role bound with coverage > 0 is not flagged');
  for (const id of expected) {
    const role = id.split('/')[1];
    assert.ok(r.warnings.some((w) => w.startsWith(`${BOUND_NO_COVERAGE}:`) && w.includes(`role ${role} `)), `warning for ${role}`);
    assert.match(r.body, new RegExp(`\\| ${role} \\| testing \\| \`reviewer\` \\| none \\(${BOUND_NO_COVERAGE}\\) \\|`), `holder row annotated for ${role}`);
  }
  assert.ok(r.body.includes('| static-reviewer | testing | `reviewer` | SR.1, SR.2, SR.3, SR.4 |'), 'covered row is plain');
});

test(N(2, 'review routing counts closeness-0 bindings toward the lowered level without changing the exit code'), () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-rank0-'));
  try {
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Repo\n');
    const run = (agents) => applyFoundation({ target: 'routing', root: dir, standards: [TESTING], agents, noFile: true });
    const thin = run([agent('reviewer', srIds)]);
    assert.equal(thin.level, 'lowered');
    assert.ok(thin.boundNoCoverage.length > 0);
    const full = run(TESTING.roles.map((r) => agent(`holder-${r.name}`, r.obligations.map((o) => o.id))));
    assert.deepEqual(full.boundNoCoverage, []);
    assert.deepEqual(full.unbound, []);
    assert.equal(full.level, 'full');
    assert.ok(!full.warnings.some((w) => w.startsWith(BOUND_NO_COVERAGE)));
    // exit is decided by drift/filing only: lowering the level must not fail the run
    const check = applyFoundation({ target: 'routing', root: dir, standards: [TESTING], agents: [agent('reviewer', srIds)], check: true, noFile: true });
    assert.equal(check.exit === EXIT.OK || check.exit === EXIT.DRIFT, true);
    assert.equal(thin.exit, EXIT.OK);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
