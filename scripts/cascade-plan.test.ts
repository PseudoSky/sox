/**
 * cascade-plan.test.ts — regression test for the BL-452 republish-cascade
 * planner + changeset-status cross-check.
 *
 * Fixture workspace (Decision B: cross-check the static package.json graph
 * against `changeset status`, never reimplement its bump algorithm):
 *   A  <- B <- C     (B has workspace:* dep on A; C has workspace:* dep on B —
 *                      B, C transitively depend on A)
 *   D                (unrelated — no edge to A)
 *   E                (workspace:* dep on A, placed several directories deep
 *                      under `libs/`, to prove the reused roots/depth walk
 *                      from check-publishable.ts actually covers deep nesting)
 *   F                (depends on A via a dist-TAG range ("latest"), NOT a
 *                      version/workspace: range — must be excluded from both
 *                      the graph closure and the changesets closure)
 *   G                (depends on A ONLY via `devDependencies` with
 *                      `workspace:*` — must be INCLUDED. This is not a
 *                      contrived case: `libs/data/analysis/analysis/
 *                      package.json` reaches `@adhd/sox-store-adapter` only
 *                      through `devDependencies`, verified 2026-08-06 — a
 *                      walker scoped to `dependencies` alone silently drops a
 *                      real, already-published consumer.)
 *
 * NOTE on F: SPEC-PKT-79's own AC-452-1 text describes the exclusion case as
 * "a package depends on A via a non-workspace: range (e.g. a hand-pinned
 * exact version)". Verified against `@changesets/get-dependents-graph@2.1.4`'s
 * `getDependencyGraph` (the exact function `changeset status` calls): an
 * EXACT version pin that matches the dependency's current version DOES
 * cascade in real changesets (confirmed empirically — `changeset status`
 * bumped a fixture package pinned via `"1.0.0"` when `@fx/a`'s current
 * version was `"1.0.0"`). The one case changesets' own source explicitly
 * documents as excluded is a dist-tag reference ("the depRange could have
 * been a tag ... we should not count this as a local monorepo dependant") —
 * that is what F uses here, which both correctly-implemented closures agree
 * excludes. See cascade-plan.ts's module docstring "Edge scope" section for
 * the full citation.
 *
 * A real `changeset` binary (from this repo's own node_modules, per
 * cascade-plan.ts's own resolution strategy) is shelled out to against each
 * fixture — never mocked — because the whole point of the cross-check is that
 * it is validated against the real tool, not a stand-in for it. Each fixture
 * is a real (tiny) git repo, since `changeset status` needs to diff against a
 * `main` branch to compute changed packages.
 */

import { spawn, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'cascade-plan.ts');

const tempRoots: string[] = [];

afterEach(() => {
  for (const d of tempRoots.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

function writeJson(root: string, rel: string, json: unknown): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, JSON.stringify(json, null, 2));
}

function writeText(root: string, rel: string, text: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

function git(root: string, args: string[]): void {
  const res = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${res.stderr || res.stdout}`);
  }
}

/**
 * A <- B <- C chain, unrelated D, deep-nested E (workspace:* on A), F
 * (dist-tag ref on A — must be excluded), G (devDependencies-only workspace:*
 * on A — must be included). One pending changeset on A.
 */
function makeFixtureWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cascade-plan-'));
  tempRoots.push(root);

  writeJson(root, 'package.json', {
    name: 'cascade-plan-fixture-root',
    private: true,
    version: '0.0.0',
  });
  writeText(
    root,
    'pnpm-workspace.yaml',
    "packages:\n  - 'libs/**'\n  - '!**/dist/**'\n  - '!**/node_modules/**'\n",
  );
  writeJson(root, '.changeset/config.json', {
    $schema: 'https://unpkg.com/@changesets/config@3.0.0/schema.json',
    changelog: '@changesets/cli/changelog',
    commit: false,
    fixed: [],
    linked: [],
    access: 'restricted',
    baseBranch: 'main',
    updateInternalDependencies: 'patch',
    ignore: [],
  });
  writeJson(root, 'libs/a/package.json', { name: '@fx/a', version: '1.0.0', private: false });
  writeJson(root, 'libs/b/package.json', {
    name: '@fx/b',
    version: '1.0.0',
    private: false,
    dependencies: { '@fx/a': 'workspace:*' },
  });
  writeJson(root, 'libs/c/package.json', {
    name: '@fx/c',
    version: '1.0.0',
    private: false,
    dependencies: { '@fx/b': 'workspace:*' },
  });
  writeJson(root, 'libs/d/package.json', { name: '@fx/d', version: '1.0.0', private: false });
  writeJson(root, 'libs/deep/nested/under/here/e/package.json', {
    name: '@fx/e',
    version: '1.0.0',
    private: false,
    dependencies: { '@fx/a': 'workspace:*' },
  });
  writeJson(root, 'libs/f/package.json', {
    name: '@fx/f',
    version: '1.0.0',
    private: false,
    dependencies: { '@fx/a': 'latest' }, // dist-tag ref, NOT a version/workspace: range — must be excluded
  });
  writeJson(root, 'libs/g/package.json', {
    name: '@fx/g',
    version: '1.0.0',
    private: false,
    devDependencies: { '@fx/a': 'workspace:*' }, // devDependency-only edge — must be INCLUDED (mirrors analysis/store-adapter)
  });
  writeText(root, '.changeset/pkt79-fixture.md', '---\n"@fx/a": patch\n---\n\nfixture bump\n');

  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'add', '-A']);
  git(root, ['-c', 'user.email=t@t.com', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);

  return root;
}

const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');

/**
 * Spawns the real `tsx` binary directly (not `npx tsx`) — `npx` can emit its
 * own advisory warnings on stdout/stderr (e.g. "npm warn Unknown ..."), which
 * would corrupt `--json` output parsing. `out` is stdout+stderr combined for
 * human-readable-message assertions; `stdout` alone is used for `--json`
 * parsing.
 */
async function run(
  root: string,
  extraArgs: string[],
): Promise<{ code: number; out: string; stdout: string }> {
  const child = spawn(TSX_BIN, [SCRIPT, root, ...extraArgs], { cwd: REPO_ROOT });
  let out = '';
  let stdout = '';
  child.stdout.on('data', (d: Buffer) => {
    out += d.toString();
    stdout += d.toString();
  });
  child.stderr.on('data', (d: Buffer) => (out += d.toString()));
  const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? -1)));
  return { code, out, stdout };
}

describe('cascade-plan — BL-452 republish-cascade planner + cross-check', () => {
  it('computes the closure {A,B,C} for a changeset on A, excludes D, orders A before B before C', async () => {
    const root = makeFixtureWorkspace();

    const { code, stdout } = await run(root, ['--json']);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { plan: string[]; graphClosure: string[]; changesetClosure: string[] };
    expect(new Set(parsed.graphClosure)).toEqual(new Set(['@fx/a', '@fx/b', '@fx/c', '@fx/e', '@fx/g']));
    expect(parsed.graphClosure).not.toContain('@fx/d');
    expect(parsed.graphClosure).not.toContain('@fx/f');

    expect(parsed.plan.indexOf('@fx/a')).toBeLessThan(parsed.plan.indexOf('@fx/b'));
    expect(parsed.plan.indexOf('@fx/b')).toBeLessThan(parsed.plan.indexOf('@fx/c'));
  }, 60_000);

  it('includes a workspace:* consumer nested several directories deep under libs/ (roots/depth reuse check)', async () => {
    const root = makeFixtureWorkspace();

    const { code, stdout } = await run(root, ['--json']);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { graphClosure: string[] };
    expect(parsed.graphClosure).toContain('@fx/e');
  }, 60_000);

  it('includes a devDependencies-only workspace:* consumer (mirrors analysis/store-adapter)', async () => {
    const root = makeFixtureWorkspace();

    const { code, stdout } = await run(root, ['--json']);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { graphClosure: string[]; changesetClosure: string[] };
    expect(parsed.graphClosure).toContain('@fx/g');
    expect(parsed.changesetClosure).toContain('@fx/g');
  }, 60_000);

  it('excludes a dist-tag-referenced (non-version, non-workspace:*) dependent from both closures — no disagreement', async () => {
    const root = makeFixtureWorkspace();

    const { code, stdout } = await run(root, ['--json']);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { graphClosure: string[]; changesetClosure: string[] };
    expect(parsed.graphClosure).not.toContain('@fx/f');
    expect(parsed.changesetClosure).not.toContain('@fx/f');
  }, 60_000);

  it('cross-checks the graph closure against `changeset status --output` and asserts they are equal', async () => {
    const root = makeFixtureWorkspace();

    const { code, stdout } = await run(root, ['--json']);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { graphClosure: string[]; changesetClosure: string[] };
    expect(new Set(parsed.graphClosure)).toEqual(new Set(parsed.changesetClosure));
  }, 60_000);

  it('FAILS with no target and no pending changesets', async () => {
    const root = makeFixtureWorkspace();
    fs.rmSync(path.join(root, '.changeset', 'pkt79-fixture.md'));

    const { code, out } = await run(root, ['--json']);

    expect(code).toBe(1);
    expect(out).toContain('no target');
  }, 60_000);

  it('auto-detects the target from --package explicitly and produces the same closure', async () => {
    const root = makeFixtureWorkspace();

    const { code, stdout } = await run(root, ['--package', '@fx/a', '--json']);

    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as { graphClosure: string[] };
    expect(new Set(parsed.graphClosure)).toEqual(new Set(['@fx/a', '@fx/b', '@fx/c', '@fx/e', '@fx/g']));
  }, 60_000);
});
