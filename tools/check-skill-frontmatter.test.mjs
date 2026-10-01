#!/usr/bin/env node
/**
 * tools/check-skill-frontmatter.test.mjs
 *
 * Red→green for the aace3faa skill-header fix, pinned to the AUTHENTIC pre-fix
 * bytes. Proves the guard's three legs:
 *
 *   1. source-purity REJECTS the pre-fix SKILL.md (a hand-written `---` fence whose
 *      description carried "backlog: product prioritizes" — the 1ceffdbf silent drop)
 *      and ACCEPTS the migrated prose-only source.
 *   2. manifest REJECTS id != dirname, a non-slug id, an over-long description, and a
 *      `render` block on a host-agnostic skill.
 *   3. render IMMUNITY: a manifest whose description is the exact pre-fix colon text
 *      renders through host-registry's renderSkillFile to a quoted scalar that a YAML
 *      reader parses back to the exact input (colon-in-scalar immune).
 *
 * Run: node tools/check-skill-frontmatter.test.mjs
 * (plain node:test; requires `npx nx build host-registry` first so the built renderer
 * is loadable — the same prerequisite the guard itself has.)
 *
 * Runner: wired as the root project's `check-skill-headers-test` nx target, which
 * `lint` depends on — so `npx nx run-many -t lint` runs this suite (the a93f36fc
 * defect: it previously passed 8/8 by hand but was wired to no runner at all).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  checkBody,
  checkManifest,
  checkSourcePurity,
  loadRenderer,
  MAX_DESCRIPTION_LENGTH,
  renderSkill,
  selectSkillFiles,
  SKILL_ID_PATTERN,
} from './check-skill-frontmatter.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Leg 1 delegates to the renderer's own stripFrontmatter (the shared detector), so
// the purity tests load it once here — same prerequisite as the guard itself.
const { stripFrontmatter, renderSkillFile } = loadRenderer();

function preFixBytes() {
  return execFileSync(
    'git',
    ['-C', REPO_ROOT, 'show', '1ceffdbf^:extensions/skills/dispatch-plan/SKILL.md'],
    { encoding: 'utf8' },
  );
}

function migratedBytes() {
  return fs.readFileSync(
    path.join(REPO_ROOT, 'extensions', 'skills', 'dispatch-plan', 'SKILL.md'),
    'utf8',
  );
}

// A minimal single-line scalar unquote, sufficient for the renderer's output shape
// (single-quoted scalars with '' escapes; the workspace has no js-yaml/yaml dep).
function unquoteSingle(raw) {
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1).replace(/''/g, "'");
  }
  return raw;
}

test('RED: source-purity rejects the authentic pre-fix bytes (frontmatter fence)', () => {
  const err = checkSourcePurity(preFixBytes(), 'extensions/skills/dispatch-plan/SKILL.md', stripFrontmatter);
  assert.ok(err !== null, 'pre-fix bytes must be rejected by the source-purity leg');
  assert.match(err, /prose-only/);
});

test('GREEN: source-purity accepts the migrated prose-only source', () => {
  assert.equal(checkSourcePurity(migratedBytes(), 'extensions/skills/dispatch-plan/SKILL.md', stripFrontmatter), null);
});

test('source-purity rejects a fence hidden behind a leading blank line (aligns with stripFrontmatter)', () => {
  // stripFrontmatter is anchored to `^---`; a blank line ahead of the fence defeats
  // stripping, so leg 1 must reject it rather than pass a source that renders broken.
  const err = checkSourcePurity('\n---\nname: x\n---\nbody\n', 'x/SKILL.md', stripFrontmatter);
  assert.ok(err !== null, 'a fence after a leading blank line defeats stripFrontmatter and must be rejected');
  assert.match(err, /prose-only/);
});

test('source-purity rejects a fence hidden behind a BOM', () => {
  const err = checkSourcePurity('\uFEFF\n---\nname: x\n---\nbody\n', 'x/SKILL.md', stripFrontmatter);
  assert.ok(err !== null, 'a fence after a BOM defeats stripFrontmatter and must be rejected');
});

test('source-purity accepts a bare horizontal rule (no closing fence — not frontmatter)', () => {
  // A lone leading `---` is a markdown horizontal rule, not a frontmatter fence —
  // stripFrontmatter does not strip it, so leg 1 (now sharing that detector) does
  // not reject it either.
  assert.equal(checkSourcePurity('---\njust a rule\n', 'x/SKILL.md', stripFrontmatter), null);
});

test('manifest: id must equal the directory basename and be a kebab slug', () => {
  assert.deepEqual(checkManifest({ id: 'dispatch-plan', description: 'd' }, 'dispatch-plan', 'x/extension.json'), []);
  assert.ok(checkManifest({ id: 'other', description: 'd' }, 'dispatch-plan', 'x/extension.json').length > 0);
  assert.ok(checkManifest({ id: 'Dispatch_Plan', description: 'd' }, 'Dispatch_Plan', 'x/extension.json').length > 0);
  assert.ok(checkManifest({ description: 'd' }, 'dispatch-plan', 'x/extension.json').length > 0);
});

test('manifest: description must be present and ≤ MAX_DESCRIPTION_LENGTH', () => {
  const long = 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1);
  assert.ok(checkManifest({ id: 's', description: long }, 's', 'x/extension.json').some((e) => e.includes('chars')));
  assert.ok(checkManifest({ id: 's' }, 's', 'x/extension.json').length > 0);
});

test('manifest: a skill must not carry a host-agnostic render block', () => {
  const errs = checkManifest({ id: 's', description: 'd', render: { claude: {} } }, 's', 'x/extension.json');
  assert.ok(errs.some((e) => e.includes('render')));
});

test('body: empty prose is rejected', () => {
  assert.ok(checkBody('\n', 'x/SKILL.md') !== null);
  assert.equal(checkBody('# s\nbody\n', 'x/SKILL.md'), null);
});

test('IMMUNE: the pre-fix colon description renders to a quoted scalar that round-trips', () => {
  const manifest = {
    id: 'dispatch-plan',
    description: 'The dispatcher plays back plans: product prioritizes, architect returns the items',
  };
  const prose = '# dispatch-plan\n\nbacklog: product prioritizes — colon text in the body\n';
  const content = renderSkill(manifest, prose, renderSkillFile);
  // The ": " is single-quoted so a YAML reader does not read a mapping separator.
  const descLine = content
    .split('\n')
    .find((l) => l.startsWith('description:'));
  assert.ok(descLine !== undefined, 'rendered header must carry a description line');
  const raw = descLine.slice('description:'.length).trim();
  assert.equal(unquoteSingle(raw), manifest.description);
  // And the body survives untouched after the single generated fence.
  assert.match(content, /backlog: product prioritizes — colon text in the body/);
});

test('SKILL_ID_PATTERN accepts kebab slugs and rejects uppercase/underscore', () => {
  assert.ok(SKILL_ID_PATTERN.test('memory-usage'));
  assert.ok(SKILL_ID_PATTERN.test('dispatch-plan'));
  assert.equal(SKILL_ID_PATTERN.test('Dispatch_Plan'), false);
});

// RED→GREEN for the rename crash: a staged rename enumerates the renamed-away
// SKILL.md (a deletion under `--no-renames`, and a `git ls-files` entry for `--all`).
// That path is absent from the worktree, so the guard must skip it before the read
// loop rather than throw ENOENT on readFileSync.
test('RED: a changed SKILL.md absent from the worktree (renamed away) is not selected', () => {
  const renamedAway = 'extensions/skills/opencode-permission-audit/SKILL.md';
  assert.equal(
    fs.existsSync(path.join(REPO_ROOT, renamedAway)),
    false,
    'fixture premise: the renamed-away path must be absent from the worktree',
  );
  assert.equal(selectSkillFiles([renamedAway]).has(renamedAway), false);
});

test('GREEN: a changed SKILL.md present in the worktree is still selected', () => {
  const present = 'extensions/skills/dispatch-plan/SKILL.md';
  assert.equal(selectSkillFiles([present]).has(present), true);
});
