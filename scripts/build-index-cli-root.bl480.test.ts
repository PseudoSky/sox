/**
 * build-index-cli-root.bl480.test.ts — BL-480 regression test.
 *
 * Defect: `scripts/build-index.ts`'s CLI entry point defaulted its `root` to
 * `process.cwd()`. The `registry:sync-index` nx target runs with `cwd: "."`,
 * which nx resolves against whichever checkout the command was invoked from —
 * including a `.worktrees/**` checkout. Run from a worktree with no explicit
 * root arg, this wrote EVERY extension's `source` field (not just the one the
 * invoking branch touched) as a `file://` path rooted inside the worktree —
 * a directory this repo's own convention deletes once the branch merges
 * (see CLAUDE.md's git-worktree section). Discovered in PKT-60/BL-441 review:
 * commit a52d39cf silently rewrote 15 unrelated extensions' `source` fields
 * to `.worktrees/pkt60-memory-ontology-seam/...`.
 *
 * Fix: the CLI default now resolves `root` via `git rev-parse
 * --git-common-dir` + `'..'` (mirroring `tools/check-backlog-markers.mjs`'s
 * BL-416 fix and `scripts/allocate-bl-id.mjs`'s BL-416 fix) — the SAME
 * absolute path regardless of which worktree invoked the build, never a
 * worktree-relative path. `scripts/check-registry-sync.ts` carries the
 * identical fix to preserve its BL-33 "must mirror build-index.ts exactly"
 * invariant — a working build-index.ts paired with an unfixed
 * check-registry-sync.ts would make every worktree-invoked sync look "out of
 * sync" against its own (correct) output.
 *
 * This spawns the REAL `scripts/build-index.ts` (and, for the RED arm, a
 * pinned pre-fix copy materialized via `git show`) as a subprocess with cwd
 * set to a scratch git WORKTREE and no explicit root argument — exercising
 * exactly the invocation shape `npx nx run registry:sync-index` produces
 * inside `.worktrees/**`.
 */

import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..');
const CURRENT_SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-index.ts');
// Resolve tsx's absolute CLI entry once, from THIS repo's node_modules — the scratch
// worktree fixtures below are bare mkdtemp git repos with no node_modules of their own,
// so `npx tsx` invoked with cwd set to one of them would try (and, sandboxed, fail) to
// fetch tsx from the network instead of finding it locally.
const TSX_CLI = require.resolve('tsx/cli');

const sh = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** A minimal, valid, committed extension.json + package.json under extensions/agents/<id>/. */
function seedExtension(dir: string, id: string): void {
  const extDir = path.join(dir, 'extensions', 'agents', id);
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(
    path.join(extDir, 'extension.json'),
    JSON.stringify(
      {
        id,
        version: '0.1.0',
        type: 'agent',
        title: `${id} title`,
        description: `${id} description`,
        compatibility: { host: '>=1.0.0 <2.0.0' },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    path.join(extDir, 'package.json'),
    JSON.stringify({ name: `@adhd/sox-extension-${id}`, version: '0.1.0' }, null, 2),
  );
}

/** Scratch git "main checkout" with one committed extension, and a worktree branching off it. */
function scratchMainRepoAndWorktree(id: string): { mainRepo: string; worktree: string } {
  const mainRepo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bl480-main-')));
  tempDirs.push(mainRepo);
  sh(['init', '-q'], mainRepo);
  sh(['config', 'user.email', 'test@test.com'], mainRepo);
  sh(['config', 'user.name', 'test'], mainRepo);
  seedExtension(mainRepo, id);
  sh(['add', '.'], mainRepo);
  sh(['commit', '-q', '-m', 'chore: seed'], mainRepo);

  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'bl480-wt-'));
  fs.rmSync(worktree, { recursive: true, force: true }); // git worktree add requires a non-existent dir
  sh(['worktree', 'add', worktree, '-b', 'bl480-wt-branch'], mainRepo);
  const realWorktree = fs.realpathSync(worktree);
  tempDirs.push(realWorktree);
  return { mainRepo, worktree: realWorktree };
}

/**
 * Run `<scriptPath>` (tsx) with cwd = worktree and NO explicit root arg — the exact
 * shape `npx nx run registry:sync-index` invokes from inside `.worktrees/**`.
 */
async function runBuildIndexFromWorktree(
  scriptPath: string,
  worktree: string,
): Promise<{ code: number; out: string }> {
  const child = spawn(process.execPath, [TSX_CLI, scriptPath], { cwd: worktree });
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (out += d.toString()));
  const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? -1)));
  return { code, out };
}

describe('[BL-480] build-index.ts CLI: default root must resolve to the shared git-common-dir root, not process.cwd()', () => {
  it('GREEN (current build-index.ts): running from a worktree with no explicit root writes registry/index.json to the MAIN checkout, with source paths rooted there — never the worktree', async () => {
    const id = 'bl480-fixture-agent';
    const { mainRepo, worktree } = scratchMainRepoAndWorktree(id);

    const { code, out } = await runBuildIndexFromWorktree(CURRENT_SCRIPT, worktree);
    expect(code, out).toBe(0);

    const mainRegistryPath = path.join(mainRepo, 'registry', 'index.json');
    expect(fs.existsSync(mainRegistryPath), 'registry/index.json must land in the MAIN checkout').toBe(
      true,
    );
    const entries = JSON.parse(fs.readFileSync(mainRegistryPath, 'utf8')) as Array<{
      id: string;
      source: string;
    }>;
    const entry = entries.find((e) => e.id === id);
    expect(entry, `fixture extension "${id}" must appear in the registry`).toBeDefined();
    expect(entry!.source).toBe(`file://${path.join(mainRepo, 'extensions', 'agents', id)}`);
    expect(entry!.source).not.toContain(worktree);

    // The worktree's OWN copy (it has none — extensions/ isn't committed there, it's the
    // same working tree content via git worktree, but registry/ should not be written there).
    const worktreeRegistryPath = path.join(worktree, 'registry', 'index.json');
    // git worktree shares the same tracked files; registry/index.json isn't tracked in the
    // fixture, so if build-index had written into `worktree` instead of `mainRepo`, this
    // path (not `mainRepo`'s) would exist as a SEPARATE, un-committed file.
    if (fs.existsSync(worktreeRegistryPath)) {
      const wtRealpath = fs.realpathSync(worktreeRegistryPath);
      const mainRealpath = fs.realpathSync(mainRegistryPath);
      expect(wtRealpath, 'a registry/index.json under the worktree path must be the SAME file as the main checkout copy (git worktree tracked-file sharing), not an independently-written one').toBe(
        mainRealpath,
      );
    }
  }, 60_000);

  it('RED (pre-BL-480 build-index.ts): the same invocation writes source paths rooted inside the worktree', async () => {
    // Materialize the pre-fix revision of build-index.ts (the immediate parent commit,
    // before the BL-480 fix landed) into a scratch file and run THAT under the same harness.
    const preFixSource = execFileSync(
      'git',
      ['show', 'HEAD:scripts/build-index.ts'],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    // Guard: if HEAD already lacks the pre-fix default-root pattern (e.g. this test is run
    // post-fix-commit against a HEAD that already has the fix), fall back to reconstructing
    // the pre-fix CLI tail directly rather than silently passing.
    const hadBug = /const root = args\.find\(\(a\) => !a\.startsWith\('--'\)\) \?\? process\.cwd\(\);/.test(
      preFixSource,
    );
    // realpathSync the scratch dir: on macOS, os.tmpdir() is under `/tmp`, a symlink to
    // `/private/tmp`. `import.meta.url` resolves through the symlink; a bare
    // `process.argv[1]` does not — the CLI's `isMainModule` string-equality check would
    // silently mismatch and the whole CLI tail would no-op (discovered running this test).
    const scratchScriptDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'bl480-prefix-script-')),
    );
    tempDirs.push(scratchScriptDir);
    const scratchScriptPath = path.join(scratchScriptDir, 'build-index-prefix.ts');
    const prefixContent = hadBug
      ? preFixSource
      : preFixSource.replace(
          /const explicitRoot[\s\S]*?const root = explicitRoot \?\? defaultRoot;/,
          `const root = args.find((a) => !a.startsWith('--')) ?? process.cwd();`,
        );
    fs.writeFileSync(scratchScriptPath, prefixContent);

    const id = 'bl480-fixture-agent-red';
    const { worktree } = scratchMainRepoAndWorktree(id);

    const { code, out } = await runBuildIndexFromWorktree(scratchScriptPath, worktree);
    expect(code, out).toBe(0);

    // Pre-fix: root defaults to process.cwd() = worktree, so registry/index.json (and the
    // extension source it records) is rooted in the WORKTREE, not the main checkout.
    const worktreeRegistryPath = path.join(worktree, 'registry', 'index.json');
    expect(fs.existsSync(worktreeRegistryPath), out).toBe(true);
    const entries = JSON.parse(fs.readFileSync(worktreeRegistryPath, 'utf8')) as Array<{
      id: string;
      source: string;
    }>;
    const entry = entries.find((e) => e.id === id);
    expect(entry).toBeDefined();
    expect(entry!.source).toBe(`file://${path.join(worktree, 'extensions', 'agents', id)}`);
    expect(entry!.source).toContain(worktree);
  }, 60_000);
});
