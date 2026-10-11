// Tests for the typescript agent extension, 595965cc T13 (change-scoped efficacy standard).
// Pure file reads (including the committed pre-change snapshot under fixtures/) and roster parsing: spawns no host and no model.
// Run: node --test extensions/agents/typescript/typescript.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { parseRoles, validateRoles, obligationIds, coveredIds } from '../../skills/workspace-standards/scripts/lib.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const rd = (p) => readFileSync(join(here, p), 'utf8');
const prose = rd('typescript.md');
const manifest = JSON.parse(rd('extension.json'));
// Committed snapshot of the plan branch tip before T13 (commit 1f0568c6): the authentic pre-change shape, used as the
// negative control. A fixture, not `git show`, so the test holds in shallow clones, after squashes, and in installed copies.
const baseProse = rd('fixtures/base-1f0568c6.typescript.md.txt');
const baseManifest = JSON.parse(rd('fixtures/base-1f0568c6.extension.json'));
const testingSection = (t) => (t.match(/^## Testing standard\n([\s\S]*?)(?=^## )/m) ?? [null, ''])[1];
const CARD = 'extensions/skills/workspace-standards/standards/testing/cards/role/implementer-light.md';
const rolesPath = join(here, '..', '..', 'skills', 'workspace-standards', 'standards', 'testing', 'roles.md');

test('595965cc T13 AC1 no repository-wide coverage target remains in typescript.md', () => {
  assert.doesNotMatch(prose, /coverage exceeding/);
  assert.match(baseProse, /coverage exceeding/); // negative control: the base shape carries the target
});

test('595965cc T13 AC2 testing section states the change-scoped efficacy standard with no percentage target', () => {
  const sec = testingSection(prose);
  assert.ok(sec.length > 0, 'Testing standard section missing');
  assert.match(sec, /every behavior a change adds or alters/i);
  assert.match(sec, /deliberately broken/);
  assert.match(sec, /seeded fault or a diff-based mutation run/);
  assert.match(sec, /changed lines no test covers/);
  assert.match(sec, /mutants that survive/);
  assert.doesNotMatch(sec, /\d+\s*%/);
  assert.equal(testingSection(baseProse), '', 'negative control: base shape has no Testing standard section');
});

test('595965cc T13 AC3 body states tier S, header duties by card reference, and the never-edit-others rule', () => {
  const sec = testingSection(prose);
  assert.match(sec, /Default tier S/);
  assert.ok(sec.includes(CARD), 'body does not reference the Light-rigor implementer card by path');
  assert.ok(existsSync(join(here, '..', '..', '..', CARD)), `referenced card missing: ${CARD}`);
  assert.match(sec, /header \(failure mode, tier, gap statement, cited item and criterion\)/);
  assert.match(sec, /Never edit, skip, delete, or loosen a test you did not author/);
  assert.doesNotMatch(baseProse, /Never edit, skip, delete, or loosen a test you did not author/); // negative control
});

test('595965cc T13 AC4 description keeps its base-commit scope byte-identical (live A/B half is NOT MET, see report)', () => {
  assert.ok(baseManifest.agent.description.length > 100, 'the committed base snapshot carries the real description');
  assert.equal(manifest.agent.description, baseManifest.agent.description);
  assert.equal(manifest.description, baseManifest.description);
  const broadened = baseManifest.agent.description + ' Also implements features and refactors.';
  assert.notEqual(broadened, manifest.agent.description); // negative control: a broadened description is detectable
});

test('595965cc T13 AC5 declares roles-covered IM.1-IM.3, all defined in roles.md under the implementer role', () => {
  const parsed = parseRoles(readFileSync(rolesPath, 'utf8'));
  assert.deepEqual(validateRoles(parsed), []);
  const ids = coveredIds(manifest).sort();
  assert.deepEqual(ids, ['IM.1', 'IM.2', 'IM.3']);
  const defined = obligationIds(parsed);
  for (const id of ids) assert.ok(defined.has(id), `${id} not defined in roles.md`);
  const impl = parsed.roles.find((r) => r.name === 'implementer');
  assert.deepEqual(impl.obligations.map((o) => o.id).sort(), ids);
  assert.deepEqual(coveredIds(baseManifest), []); // negative control: base shape declares nothing
});
