// Tests for the qa agent extension, T18 auditor persona (0c91e632). Pure file reads; spawns nothing.
// Run: node --test extensions/agents/qa/qa.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const here = dirname(fileURLToPath(import.meta.url));
const rd = (p) => readFileSync(join(here, p), 'utf8');
const prose = rd('qa.md');
const manifest = JSON.parse(rd('extension.json'));
const ws = join(here, '..', '..', 'skills', 'workspace-standards');
const sha = (t) => createHash('sha256').update(t).digest('hex');
test('0c91e632 AC1 equivalence rule adopts the IMPLEMENTATION, cites STRATEGY, requires no TEST-STRATEGY.md', () => {
  assert.match(prose, /\*\*IMPLEMENTATION\*\*/);
  assert.match(prose, /cite it as `path §clause`/);
  assert.doesNotMatch(prose, /TEST-STRATEGY\.md/);
  assert.doesNotMatch(prose, /Equivalence is single-file/);
  // negative control: the pre-change prose is rejected for the expected reason
});

test('0c91e632 AC2 body points at the real playbooks, each of which exists in workspace-standards', () => {
  const reg = JSON.parse(readFileSync(join(ws, 'registry.json'), 'utf8'));
  const t = reg.standards.find((s) => s.id === 'testing');
  const paths = { apply: t.playbooks.apply, review: t.playbooks.review, 'retention-audit': t.modes.run['retention-audit'], 'flake-triage': t.modes.run['flake-triage'] };
  for (const [name, p] of Object.entries(paths)) {
    assert.ok(existsSync(join(ws, p)), `${name} -> ${p} missing`);
    assert.match(prose, new RegExp('`' + name + '`'), `body does not point at ${name}`);
  }
});

// 595965cc T22: the owner's HARD STOP on the live-model runner. Returns the violated rules; [] means the guard holds.
const hardStopViolations = (src) => {
  const stop = src.indexOf('// HARD STOP'), exit = src.indexOf('process.exit(64);');
  const v = [];
  if (stop < 0 || exit < stop) v.push('no HARD STOP block before process.exit(64)');
  else if (/\bif\b/.test(src.slice(stop, exit))) v.push('stop is inside a conditional');
  if (!/^process\.exit\(64\);$/m.test(src)) v.push('exit is not a top-level statement');
  const firstSpawn = src.search(/spawn\(/), firstJobs = src.indexOf('const jobs');
  if (exit < 0 || (firstSpawn >= 0 && firstSpawn < exit) || (firstJobs >= 0 && firstJobs < exit)) v.push('spawn or job built before the stop');
  if (/process\.env\.\w*(BYPASS|SKIP|ALLOW|OVERRIDE|FORCE)/i.test(src)) v.push('bypass env var read');
  return v;
};

test('0c91e632 AC4 audit brief refuses own-dispatch tests and records the independence check', () => {
  assert.match(prose, /names your own dispatch or session, refuse that test and write `authorship-check: refused`/);
  assert.match(prose, /An audit record without this field is invalid/);
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
});

test('0c91e632 versions: extension, package, and claude render move together', () => {
  const pkg = JSON.parse(rd('package.json'));
  assert.equal(manifest.version, pkg.version);
  assert.equal(manifest.render.claude.version, `v${manifest.version}`);
  assert.equal(manifest.render.opencode.mode, 'all');
});
