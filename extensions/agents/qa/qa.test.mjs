// Tests for the qa agent extension, T18 auditor persona (0c91e632). Pure file reads; spawns nothing.
// Run: node --test extensions/agents/qa/qa.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { grade } from './eval/grade.mjs';
import { CASES } from './eval/cases.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rd = (p) => readFileSync(join(here, p), 'utf8');
const prose = rd('qa.md');
const baseline = rd('eval/baseline-qa-v0.1.1.md'); // authentic pre-change shape (git HEAD before T18): the negative control
const manifest = JSON.parse(rd('extension.json'));
const results = JSON.parse(rd('eval/results.json'));
const ws = join(here, '..', '..', 'skills', 'workspace-standards');
const sha = (t) => createHash('sha256').update(t).digest('hex');
const rate = (arm, ac) => results.summary.perAc[ac][arm].rate;

test('0c91e632 AC1 equivalence rule adopts the IMPLEMENTATION, cites STRATEGY, requires no TEST-STRATEGY.md', () => {
  assert.match(prose, /\*\*IMPLEMENTATION\*\*/);
  assert.match(prose, /cite it as `path §clause`/);
  assert.doesNotMatch(prose, /TEST-STRATEGY\.md/);
  assert.doesNotMatch(prose, /Equivalence is single-file/);
  // negative control: the pre-change prose is rejected for the expected reason
  assert.match(baseline, /Create `<project>\/docs\/TEST-STRATEGY\.md`/);
});

test('0c91e632 AC2 body points at the real playbooks, each of which exists in workspace-standards', () => {
  const reg = JSON.parse(readFileSync(join(ws, 'registry.json'), 'utf8'));
  const t = reg.standards.find((s) => s.id === 'testing');
  const paths = { apply: t.playbooks.apply, review: t.playbooks.review, 'retention-audit': t.modes.run['retention-audit'], 'flake-triage': t.modes.run['flake-triage'] };
  for (const [name, p] of Object.entries(paths)) {
    assert.ok(existsSync(join(ws, p)), `${name} -> ${p} missing`);
    assert.match(prose, new RegExp('`' + name + '`'), `body does not point at ${name}`);
  }
  assert.doesNotMatch(baseline, /`retention-audit`/); // negative control
});

test('0c91e632 AC3 golden-set: variant still refuses unmeasured claims (no regression vs baseline)', () => {
  assert.equal(results.summary.variantSha256, sha(prose), 'results.json is stale against qa.md; re-run eval/run.mjs');
  assert.equal(results.summary.casesSha256, sha(rd('eval/cases.mjs')), 'results.json is stale against cases.mjs');
  assert.ok(results.summary.perAc.AC3.variant.n >= 9);
  assert.ok(rate('variant', 'AC3') >= rate('baseline', 'AC3'), 'regression on refusing unmeasured claims');
  assert.equal(rate('variant', 'AC3'), 1);
});

test('0c91e632 AC3 grader negative controls: an invented figure and a missing refusal fail', () => {
  const c = CASES.find((x) => x.id === 'unmeasured-coverage');
  assert.equal(grade('Coverage is 87% with 412 tests passed.', c.expect).pass, false);
  assert.equal(grade('I refuse: coverage not measured; I did not run the suite.', c.expect).pass, true);
});

test('0c91e632 AC4 audit brief refuses own-dispatch tests and records the independence check', () => {
  assert.match(prose, /names your own dispatch or session, refuse that test and write `authorship-check: refused`/);
  assert.match(prose, /An audit record without this field is invalid/);
  assert.doesNotMatch(baseline, /authorship-check/);
  assert.equal(rate('variant', 'AC4'), 1);
  assert.ok(rate('baseline', 'AC4') < rate('variant', 'AC4'));
});

test('0c91e632 AC5 confirm mode takes three inputs, declines own-session edits; roles-covered declared', () => {
  assert.match(prose, /the audit record, the parity evidence, and the test-file diff/);
  assert.match(prose, /Decline to confirm any edit made by your own session/);
  const roles = readFileSync(join(ws, 'standards/testing/roles.md'), 'utf8');
  const schema = JSON.parse(readFileSync(join(ws, 'schemas/roles-covered.schema.json'), 'utf8'));
  const cap = new RegExp(schema.$defs.capabilityEntry.pattern);
  const declared = manifest.capabilities.filter((c) => c.startsWith('roles-covered:'));
  assert.ok(declared.length >= 1);
  assert.equal(new Set(declared).size, declared.length);
  for (const c of declared) {
    assert.match(c, cap);
    assert.ok(roles.includes(`- ${c.split(':')[1]}:`), `${c} is not an obligation in roles.md`);
  }
  for (let i = 1; i <= 5; i++) assert.ok(declared.includes(`roles-covered:AU.${i}`));
  assert.equal(rate('variant', 'AC5'), 1);
  // The declared auditor (AU.*) set must equal the auditor obligations roles.md defines (every `- AU.n:` line); the loop above
  // already proves every declared id of any role (e.g. SO.*) is defined in roles.md.
  const defined = [...roles.matchAll(/^- (AU\.\d+):/gm)].map((m) => m[1]).sort();
  const declaredIds = (m) => m.capabilities.filter((c) => c.startsWith('roles-covered:')).map((c) => c.split(':')[1]).filter((id) => id.startsWith('AU.')).sort();
  assert.ok(defined.length >= 5);
  assert.deepEqual(declaredIds(manifest), defined);
  // negative control: a manifest dropping one obligation, or declaring an undefined one, is detected
  assert.notDeepEqual(declaredIds({ capabilities: declared.slice(1) }), defined);
  assert.notDeepEqual(declaredIds({ capabilities: [...declared, 'roles-covered:AU.99'] }), defined);
});

test('0c91e632 AC6 dispute adjudicated once, outcome recorded for the risk owner', () => {
  assert.match(prose, /decide it once, with evidence \(D21\)/);
  assert.match(prose, /Record the outcome on the work item where the risk owner reads it/);
  assert.equal(rate('variant', 'AC6'), 1);
  assert.ok(rate('baseline', 'AC6') < 1);
});

test('0c91e632 versions: extension, package, and claude render move together', () => {
  const pkg = JSON.parse(rd('package.json'));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.render.claude.version, `v${manifest.version}`);
  assert.equal(manifest.render.opencode.mode, 'all');
});
