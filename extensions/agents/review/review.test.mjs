// Tests for the review agent extension. Pure parsing/grading: nothing here spawns a process,
// touches the network, or installs anything (the install check is recorded in CHANGELOG evidence).
// Run: node --test extensions/agents/review/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { checkReadOnly } from './check-readonly.mjs';
import { grade } from './eval/grade.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rd = (p) => readFileSync(join(here, p), 'utf8');
const manifest = JSON.parse(rd('extension.json'));
const prose = rd('review.md');

const placeholders = (t) => [...t.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]);
const residue = (t) => t.replace(/\{\{\w+\}\}/g, '').trim();

// ---- AC1 -------------------------------------------------------------------------------
test('2f81569f T11.AC1 shipped manifest is read-only', () => {
  assert.deepEqual(checkReadOnly(manifest), []);
});

for (const [label, mutate] of [
  ['edit tool added', (m) => m.agent.tools.push('edit')],
  ['write tool added', (m) => m.agent.tools.push('write')],
  ['bash tool added', (m) => m.agent.tools.push('bash')],
  ['apply_patch added', (m) => m.agent.tools.push('apply_patch')],
  ['claude Write added', (m) => m.render.claude.tools.push('Write')],
  ['claude NotebookEdit added', (m) => m.render.claude.tools.push('NotebookEdit')],
  ['edit permission loosened', (m) => { m.agent.permission.edit = 'allow'; }],
  ['bash permission loosened', (m) => { m.agent.permission.bash = { '*': 'allow' }; }],
  ['memory server tool added', (m) => m.agent.tools.push({ logical: 'memory', server: 'memory-server' })],
]) {
  test(`2f81569f T11.AC1 negative control: ${label} is rejected`, () => {
    const m = structuredClone(manifest);
    mutate(m);
    assert.notDeepEqual(checkReadOnly(m), []);
  });
}

test('2f81569f T11.AC1 prose contract states the agent cannot edit or run', () => {
  assert.match(prose, /no edit, write, or shell tools/);
});

// ---- AC2 -------------------------------------------------------------------------------
test('2f81569f T11.AC2 blind template carries only the diff placeholder and the word Review', () => {
  const t = rd('templates/blind.tmpl');
  assert.deepEqual(placeholders(t), ['diff']);
  assert.equal(residue(t), 'Review');
});

test('2f81569f T11.AC2 blind-deep template adds only specification and tests, never reasoning/rationale/AC/prior state', () => {
  const t = rd('templates/blind-deep.tmpl');
  assert.deepEqual(placeholders(t).sort(), ['diff', 'specification', 'tests']);
  assert.equal(residue(t), 'Review');
  assert.doesNotMatch(t, /reason|rationale|previous|prior|notes|criteria/i);
});

test('2f81569f T11.AC2 output contract names severities, file:line form, and verdict', () => {
  for (const s of ['blocker', 'major', 'minor', 'nit']) assert.match(prose, new RegExp(s));
  assert.match(prose, /<file>:<line>/);
  assert.match(prose, /verdict: approve/);
  assert.match(prose, /REFUSED: blind brief carries/);
});

test('2f81569f T11.AC2 grader accepts a conforming static review and rejects free-form prose', () => {
  const good = 'mode: static\n[major] src/a.js:7 — off by one — evidence: "i <= end" (clause: none)\nverdict: changes-requested\n';
  const exp = { mode: 'static', anchor: /src\/a\.js:7/, severity: /\[(blocker|major)\]/, verdict: 'changes-requested' };
  assert.equal(grade(good, exp).pass, true);
  assert.equal(grade('This diff adds a function. Looks wrong on line 7.', exp).pass, false);
});

test('2f81569f T11.AC2 grader requires REFUSED and no review for a contaminated blind brief', () => {
  assert.equal(grade('REFUSED: blind brief carries rationale', { refused: true }).pass, true);
  assert.equal(grade('REFUSED: x\n[major] a.js:1 — y', { refused: true }).pass, false);
  assert.equal(grade('mode: blind\n[minor] a.js:1 — y', { refused: true }).pass, false);
});

// ---- AC3 -------------------------------------------------------------------------------
test('2f81569f T11.AC3 recorded golden-set A/B meets thresholds and beats baseline', () => {
  const { summary } = JSON.parse(rd('eval/results.json'));
  assert.equal(summary.model, 'haiku');
  assert.ok(summary.reps >= 3);
  assert.ok(summary.variant.passRate >= 0.8, `variant ${summary.variant.passRate}`);
  assert.ok(summary.variant.passRate - summary.baseline.passRate >= 0.5);
});

test('2f81569f T11.AC3 golden set covers both modes and the refusal path', async () => {
  const { CASES } = await import('./eval/cases.mjs');
  assert.ok(CASES.length >= 5 && CASES.length <= 20);
  assert.ok(CASES.some((c) => c.mode === 'static'));
  assert.ok(CASES.some((c) => c.mode === 'blind'));
  assert.ok(CASES.some((c) => c.mode === 'blind-deep'));
  assert.ok(CASES.some((c) => c.expect.refused));
});

// ---- AC4 -------------------------------------------------------------------------------
test('2f81569f T11.AC4 manifest declares claude, opencode and agent-mcp with matching versions and concrete model pin', () => {
  assert.deepEqual([...manifest.install.hosts].sort(), ['agent-mcp', 'claude', 'opencode']);
  assert.equal(manifest.render.opencode.mode, 'all');
  assert.match(manifest.render.opencode.model, /^[\w-]+\/[\w.-]+$/);
  assert.equal(manifest.render.claude.version, `v${manifest.version}`);
  assert.equal(JSON.parse(rd('package.json')).version, manifest.version);
  assert.equal(manifest.entrypoint, 'review.md');
  assert.doesNotMatch(prose.slice(0, 4), /^---/); // prose only: host header is generated
  assert.deepEqual(manifest.dependencies ?? [], []);
});

// ---- AC5 -------------------------------------------------------------------------------
test('2f81569f T11.AC5 declares roles-covered as machine-readable static-reviewer obligation ids', () => {
  const rc = manifest.agent['roles-covered'];
  assert.ok(Array.isArray(rc) && rc.length > 0);
  for (const id of rc) assert.match(id, /^static-reviewer:[A-Za-z0-9.§]+$/);
  assert.equal(new Set(rc).size, rc.length);
  for (const required of ['G9', 'R3', 'R4', 'G12']) assert.ok(rc.includes(`static-reviewer:${required}`));
});

test('2f81569f T11.AC5 blind-deep receives specification and tests and refuses implementer reasoning (D22)', () => {
  assert.match(prose, /blind-deep/);
  assert.match(prose, /specification and tests/);
  assert.match(prose, /implementer's reasoning/);
});
