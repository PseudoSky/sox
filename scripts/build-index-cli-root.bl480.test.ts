/**
 * build-index-cli-root.bl480.test.ts — CLI default-root regression test
 * (BL-480, inverted by 761c3f21).
 *
 * History: BL-480 moved the CLI default root from `process.cwd()` to the SHARED
 * (primary) checkout via `git rev-parse --git-common-dir`, to keep worktree-rooted
 * `file://` locators out of the registry. That rationale no longer applies: every
 * write-capable mode now emits `npm-package:` locators or refuses. The shared-root
 * default meant a run from a git worktree hashed, dirty-gated, read pins from and
 * WROTE the primary checkout's registry/index.json while every other release step
 * (embed-registry, release-consumers, clean-room-smoke) rooted at its own checkout.
 *
 * Current contract: with no explicit root argument the CLI roots at the INVOKING
 * checkout's own toplevel (`git rev-parse --show-toplevel`). A worktree run reads and
 * writes only the worktree; the primary checkout's registry is never touched.
 *
 * This spawns the REAL `scripts/build-index.ts` as a subprocess with cwd set to a
 * scratch git WORKTREE (temp repo + `git worktree add` in os.tmpdir()) and no
 * explicit root — exactly the invocation shape `npx nx run registry:sync-index`
 * produces inside `.worktrees/**`.
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
  // A committed registry in the primary checkout: the sentinel a mis-rooted run would clobber.
  fs.mkdirSync(path.join(mainRepo, 'registry'), { recursive: true });
  fs.writeFileSync(path.join(mainRepo, 'registry', 'index.json'), '[]\n');
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

describe('[BL-480 / 761c3f21] build-index.ts CLI: default root is the invoking checkout, never the primary checkout', () => {
  it('761c3f21 AC2: run from a worktree with no explicit root, the PRIMARY registry/index.json is byte-unchanged and the worktree is the one rooted/written', async () => {
    const id = 'bl480-fixture-agent';
    const { mainRepo, worktree } = scratchMainRepoAndWorktree(id);

    const mainRegistryPath = path.join(mainRepo, 'registry', 'index.json');
    const before = fs.readFileSync(mainRegistryPath);

    const { code, out } = await runBuildIndexFromWorktree(CURRENT_SCRIPT, worktree);
    expect(code, out).toBe(0);

    expect(
      fs.readFileSync(mainRegistryPath).equals(before),
      'primary registry/index.json must be byte-unchanged',
    ).toBe(true);

    const worktreeRegistryPath = path.join(worktree, 'registry', 'index.json');
    expect(fs.realpathSync(worktreeRegistryPath)).not.toBe(fs.realpathSync(mainRegistryPath));
    const entries = JSON.parse(fs.readFileSync(worktreeRegistryPath, 'utf8')) as Array<{
      id: string;
      source: string;
    }>;
    const entry = entries.find((e) => e.id === id);
    expect(entry, `fixture extension "${id}" must appear in the worktree registry`).toBeDefined();
    expect(entry!.source).toContain(worktree);
    expect(entry!.source).not.toContain(mainRepo);
  }, 60_000);

  it('761c3f21 AC2: run from a subdirectory of a checkout, the root is that checkout toplevel (not the subdirectory, not the primary)', async () => {
    const id = 'bl480-fixture-agent-sub';
    const { mainRepo, worktree } = scratchMainRepoAndWorktree(id);
    const mainRegistryPath = path.join(mainRepo, 'registry', 'index.json');
    const before = fs.readFileSync(mainRegistryPath);
    const subdir = path.join(worktree, 'extensions');

    const { code, out } = await runBuildIndexFromWorktree(CURRENT_SCRIPT, subdir);
    expect(code, out).toBe(0);

    expect(fs.readFileSync(mainRegistryPath).equals(before)).toBe(true);
    expect(fs.existsSync(path.join(subdir, 'registry', 'index.json'))).toBe(false);
    const entries = JSON.parse(
      fs.readFileSync(path.join(worktree, 'registry', 'index.json'), 'utf8'),
    ) as Array<{ id: string }>;
    expect(entries.some((e) => e.id === id)).toBe(true);
  }, 60_000);

  it('761c3f21 AC2: outside any git repo the default root falls back to process.cwd()', async () => {
    const id = 'bl480-fixture-agent-nogit';
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'bl480-nogit-')));
    tempDirs.push(dir);
    seedExtension(dir, id);

    const { code, out } = await runBuildIndexFromWorktree(CURRENT_SCRIPT, dir);
    expect(code, out).toBe(0);
    expect(fs.existsSync(path.join(dir, 'registry', 'index.json'))).toBe(true);
  }, 60_000);
});
