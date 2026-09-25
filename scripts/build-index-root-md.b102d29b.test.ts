/**
 * build-index-root-md.b102d29b.test.ts — regression test for backlog b102d29b
 * ("isChecksumRelevant's root-.md exemption was a 7-name allow-list, not the
 * general 'root-level *.md is documentation' rule its own doc comment
 * promised — any OTHER untracked root .md (e.g. another agent's in-flight
 * SPEC-*.md) fell through to 'relevant' and refused the dirty-tree gate,
 * blocking every SOX_REGISTRY_PUBLISH=… build-index run, i.e. every release").
 *
 * FIX UNDER TEST
 * --------------
 * `isChecksumRelevant` (scripts/build-index.ts) now treats ANY path with no
 * `/` (i.e. it lives at the repo root) ending in `.md` as checksum-irrelevant,
 * not just the 7 previously-named files. Nested `.md` (extensions/**, libs/**)
 * stays relevant — those can be packaged extension payload (SKILL.md) or
 * documentation embedded in a published package (README.md).
 *
 * `isChecksumRelevant` itself is not exported, so this drives it indirectly
 * through the same `buildIndex` dirty-tree gate the BL-390 suite in
 * build-index.test.ts already exercises: a dirty tree whose ONLY dirty file
 * is checksum-irrelevant must not throw `DirtyTreeError`; one with a
 * checksum-relevant file must.
 */

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildIndex, DirtyTreeError } from './build-index.js';

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sox-build-index-root-md-test-'));
}

function removeDirRecursive(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function git(root: string, cmd: string): string {
  return execSync(`git ${cmd}`, { cwd: root, encoding: 'utf8' });
}

/** Mirrors build-index.test.ts's makeGitRoot: a real, disposable git repo. */
function makeGitRoot(): string {
  const root = makeTempRoot();
  git(root, 'init -q');
  git(root, 'config user.email "test@example.com"');
  git(root, 'config user.name "Test"');
  fs.writeFileSync(path.join(root, '.gitkeep'), '');
  git(root, 'add .gitkeep');
  git(root, 'commit -q -m "initial"');
  return root;
}

describe('[b102d29b] isChecksumRelevant: root-level *.md is irrelevant for ANY name, not a 7-name allow-list', () => {
  let root: string;

  beforeEach(() => {
    root = makeGitRoot();
  });

  afterEach(() => {
    removeDirRecursive(root);
  });

  it('an untracked root-level .md file with an ARBITRARY name does not dirty the gate', () => {
    // This is the exact driver shape: another agent's untracked
    // SPEC-EMBEDDING-HOST.md sitting at repo root, name not on any allow-list.
    fs.writeFileSync(path.join(root, 'NOTES.md'), '# scratch notes\n');

    expect(() => buildIndex({ root })).not.toThrow();
  });

  it('one of the 7 previously-named root files is still irrelevant (no regression)', () => {
    fs.writeFileSync(path.join(root, 'BACKLOG.md'), '# backlog\n');
    fs.writeFileSync(path.join(root, 'CHANGELOG.md'), '# changelog\n');
    fs.writeFileSync(path.join(root, 'README.md'), '# readme\n');
    fs.writeFileSync(path.join(root, 'AGENTS.md'), '# agents\n');
    fs.writeFileSync(path.join(root, 'CLAUDE.md'), '# claude\n');
    fs.writeFileSync(path.join(root, 'CONTRIBUTING.md'), '# contributing\n');
    fs.writeFileSync(path.join(root, 'DOD.md'), '# dod\n');

    expect(() => buildIndex({ root })).not.toThrow();
  });

  it('a nested extensions/**/SKILL.md IS checksum-relevant (packaged payload) and still dirties the gate', () => {
    fs.mkdirSync(path.join(root, 'extensions', 'skills', 'x'), { recursive: true });
    fs.writeFileSync(path.join(root, 'extensions', 'skills', 'x', 'SKILL.md'), '# skill\n');

    expect(() => buildIndex({ root })).toThrow(DirtyTreeError);
  });

  it('a nested libs/**/README.md IS checksum-relevant and still dirties the gate', () => {
    fs.mkdirSync(path.join(root, 'libs', 'a'), { recursive: true });
    fs.writeFileSync(path.join(root, 'libs', 'a', 'README.md'), '# lib a\n');

    expect(() => buildIndex({ root })).toThrow(DirtyTreeError);
  });

  it('a root .md alongside an unrelated nested dirty file still refuses (only the .md is exempt)', () => {
    fs.writeFileSync(path.join(root, 'SOME-OTHER-SPEC.md'), '# spec\n');
    fs.mkdirSync(path.join(root, 'libs', 'b'), { recursive: true });
    fs.writeFileSync(path.join(root, 'libs', 'b', 'index.ts'), 'export const x = 1;\n');

    expect(() => buildIndex({ root })).toThrow(DirtyTreeError);
  });
});
