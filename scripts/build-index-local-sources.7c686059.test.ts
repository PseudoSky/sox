/**
 * build-index-local-sources.7c686059.test.ts — regression test for backlog
 * 7c686059-021d-4fc9-9c3f-e17a59b61b4f ("the pre-merge smoke gate installs
 * npm-published bytes for pinned ids, never this worktree's own rebuilt
 * dist/, because scripts/smoke-test.mjs symlinked the COMMITTED
 * registry/index.json — which correctly carries `npm-package:` pins for
 * memory-server/memory-cli/memory-flush/memory-usage/sox/sox-memory-bundle —
 * straight into its disposable TEST_ROOT").
 *
 * FIX UNDER TEST
 * --------------
 * `scripts/build-index.ts` gains a `--out <path> --local-sources` CLI mode
 * (`buildIndex({ outPath, localSources })`):
 *   - every row's `source` is forced to a checkout-bound `file://<extDir>`
 *     locator, regardless of a committed `npm-package:` pin or
 *     `SOX_REGISTRY_PUBLISH` — via `resolveSource(..., { forceLocal: true })`;
 *   - the checksum is still the EXISTING `resolveChecksum`/`resolveEntrypointPath`
 *     resolver (BL-390's conformance pin with install.ts) — nothing new to hash;
 *   - the published-bytes pin-preservation/pin-loss machinery (loadCommittedPins,
 *     the `PinLossError` refusal) is entirely bypassed — this mode structurally
 *     cannot honor a `npm-package:` pin, so it must never even consult one;
 *   - it refuses (OutPathConflictError) if `outPath` resolves to the repo's own
 *     committed `registry/index.json` — this mode exists to write a DISPOSABLE
 *     index elsewhere and must never be able to clobber the real one;
 *   - `--local-sources` without `--out` also refuses, for the same reason
 *     (its implicit default output IS the committed file);
 *   - a dirty working tree does not refuse in this mode — the output is
 *     provisional by construction (never committed), so entries are stamped
 *     `provisional: true` / `builtFromCommit: "<sha>+dirty"` instead, exactly
 *     like `--allow-dirty` does for the default path.
 */

import { execFileSync, spawn } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildIndex, OutPathConflictError } from './build-index.js';

// ─── In-process fixtures (non-git root — mirrors build-index.test.ts) ─────────

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sox-build-index-local-sources-test-'));
}

function removeDirRecursive(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function makeExtension(
  root: string,
  typeDir: string,
  id: string,
  extra: Record<string, unknown> = {},
  pkgExtra: Record<string, unknown> = {},
): string {
  const extDir = path.join(root, 'extensions', typeDir, id);
  fs.mkdirSync(extDir, { recursive: true });
  const typeDirToType: Record<string, string> = {
    agents: 'agent', skills: 'skill', 'mcp-servers': 'mcp-server',
    services: 'service', prompts: 'prompt', hooks: 'hook', commands: 'command', bundles: 'bundle',
  };
  const type = typeDirToType[typeDir] ?? typeDir;
  const manifest: Record<string, unknown> = {
    $schema: 'https://your-registry/schemas/extension/v2.json',
    id, type,
    title: `${id} title`, description: `${id} description`,
    compatibility: { host: '>=1.0.0 <2.0.0' }, license: 'MIT',
    ...extra,
  };
  fs.writeFileSync(path.join(extDir, 'extension.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(extDir, 'package.json'),
    JSON.stringify({ name: `@adhd/sox-extension-${id}`, version: '0.1.0', ...pkgExtra }, null, 2),
  );
  return extDir;
}

describe('[7c686059] buildIndex --local-sources forces file:// + local checksums', () => {
  let root: string;
  let outDir: string;

  beforeEach(() => {
    root = makeTempRoot();
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-build-index-local-sources-out-'));
  });

  afterEach(() => {
    removeDirRecursive(root);
    removeDirRecursive(outDir);
  });

  it('an npm-package-eligible row (private:false pkg) is forced to file:// with a locally computed checksum', () => {
    const extDir = makeExtension(root, 'mcp-servers', 'local-src-server', { entrypoint: 'dist/index.js' }, { private: false });
    fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
    fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), 'module.exports = "LOCAL BYTES";\n');

    const outPath = path.join(outDir, 'registry', 'index.json');
    const entries = buildIndex({ root, localSources: true, outPath });

    const row = entries.find((e) => e.id === 'local-src-server');
    expect(row).toBeDefined();
    expect(row!.source).toBe(`file://${extDir}`);
    expect(row!.checksum).toBe(
      `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(extDir, 'dist', 'index.js'))).digest('hex')}`,
    );

    // Written to outPath, not <root>/registry/index.json.
    expect(fs.existsSync(outPath)).toBe(true);
    expect(fs.existsSync(path.join(root, 'registry', 'index.json'))).toBe(false);
    const written = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    expect(written.find((e: { id: string }) => e.id === 'local-src-server').source).toBe(`file://${extDir}`);
  });

  it('SOX_REGISTRY_PUBLISH set has no effect under --local-sources — source is still forced to file://', () => {
    const extDir = makeExtension(root, 'commands', 'local-src-cmd', {}, { private: false });
    const prev = process.env['SOX_REGISTRY_PUBLISH'];
    process.env['SOX_REGISTRY_PUBLISH'] = 'npm';
    try {
      const outPath = path.join(outDir, 'registry', 'index.json');
      const entries = buildIndex({ root, localSources: true, outPath });
      const row = entries.find((e) => e.id === 'local-src-cmd');
      expect(row).toBeDefined();
      expect(row!.source).toBe(`file://${extDir}`);
    } finally {
      if (prev === undefined) delete process.env['SOX_REGISTRY_PUBLISH'];
      else process.env['SOX_REGISTRY_PUBLISH'] = prev;
    }
  });

  it('refuses when --out resolves to the repo\'s own registry/index.json', () => {
    makeExtension(root, 'skills', 'irrelevant');
    const collidingOutPath = path.join(root, 'registry', 'index.json');
    expect(() => buildIndex({ root, localSources: true, outPath: collidingOutPath })).toThrow(OutPathConflictError);
    expect(() => buildIndex({ root, localSources: true, outPath: collidingOutPath })).toThrow(/7c686059/);
    // Nothing written — the refusal fires before any fs write.
    expect(fs.existsSync(collidingOutPath)).toBe(false);
  });

  it('refuses when --out is a SYMLINK that ultimately points at the committed registry/index.json', () => {
    makeExtension(root, 'skills', 'irrelevant');
    // Pre-create the committed file so the symlink target actually exists.
    fs.mkdirSync(path.join(root, 'registry'), { recursive: true });
    fs.writeFileSync(path.join(root, 'registry', 'index.json'), '[]\n');
    const symlinkOutPath = path.join(outDir, 'sneaky-out.json');
    fs.symlinkSync(path.join(root, 'registry', 'index.json'), symlinkOutPath);
    const before = fs.readFileSync(path.join(root, 'registry', 'index.json'), 'utf8');

    expect(() => buildIndex({ root, localSources: true, outPath: symlinkOutPath })).toThrow(OutPathConflictError);
    expect(() => buildIndex({ root, localSources: true, outPath: symlinkOutPath })).toThrow(/7c686059/);
    // The committed file (reached THROUGH the symlink) must be byte-identical.
    expect(fs.readFileSync(path.join(root, 'registry', 'index.json'), 'utf8')).toBe(before);
  });

  it('refuses when --out\'s PARENT DIRECTORY is a symlink that ultimately resolves under the committed registry/', () => {
    makeExtension(root, 'skills', 'irrelevant');
    fs.mkdirSync(path.join(root, 'registry'), { recursive: true });
    fs.writeFileSync(path.join(root, 'registry', 'index.json'), '[]\n');
    const symlinkedDir = path.join(outDir, 'sneaky-dir');
    fs.symlinkSync(path.join(root, 'registry'), symlinkedDir);
    const outPathThroughSymlinkedDir = path.join(symlinkedDir, 'index.json');
    const before = fs.readFileSync(path.join(root, 'registry', 'index.json'), 'utf8');

    expect(() => buildIndex({ root, localSources: true, outPath: outPathThroughSymlinkedDir })).toThrow(OutPathConflictError);
    expect(fs.readFileSync(path.join(root, 'registry', 'index.json'), 'utf8')).toBe(before);
  });

  it('refuses --local-sources without --out (its implicit default IS the committed file)', () => {
    makeExtension(root, 'skills', 'irrelevant');
    expect(() => buildIndex({ root, localSources: true })).toThrow(OutPathConflictError);
    expect(() => buildIndex({ root, localSources: true })).toThrow(/7c686059/);
    expect(fs.existsSync(path.join(root, 'registry', 'index.json'))).toBe(false);
  });

  it('--out alone (no --local-sources) is unaffected by the collision guard\'s sibling checks — normal default-path behavior when --out is simply omitted', () => {
    makeExtension(root, 'skills', 'plain-skill', {}, { private: false });
    // No outPath at all — default path, default (non-local) source resolution.
    const entries = buildIndex({ root });
    expect(entries.find((e) => e.id === 'plain-skill')).toBeDefined();
    expect(fs.existsSync(path.join(root, 'registry', 'index.json'))).toBe(true);
  });
});

// ─── Git-repo fixture (subprocess spawn — mirrors build-index-pin-guard.4d1a3bf9.test.ts) ─

const REPO_ROOT = path.resolve(__dirname, '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'build-index.ts');
const TSX_CLI = require.resolve('tsx/cli');
const PUBLISHED_SENTINEL = 'sha256:' + 'a'.repeat(64);
const FIXTURE_ID = 'localsrc-fixture-server';
const FIXTURE_PKG = `@adhd/sox-extension-${FIXTURE_ID}`;

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

function extDirOf(root: string): string {
  return path.join(root, 'extensions', 'mcp-servers', FIXTURE_ID);
}

/**
 * A scratch repo carrying one committed, PUBLISHED extension — a
 * `registry/index.json` row pinned `npm-package:` with the sentinel checksum
 * — and local `dist/index.js` bytes that do NOT hash to that checksum. Same
 * shape as build-index-pin-guard.4d1a3bf9.test.ts's scratchRepo: exactly the
 * repo state the pin-loss guard exists to protect at the DEFAULT path.
 */
function scratchRepo(version: string, distBody: string): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'localsrc-')));
  tempDirs.push(root);
  git(['init', '-q'], root);
  git(['config', 'user.email', 'test@test.com'], root);
  git(['config', 'user.name', 'test'], root);
  fs.writeFileSync(path.join(root, '.gitignore'), 'dist/\n');

  const extDir = extDirOf(root);
  fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });
  fs.writeFileSync(
    path.join(extDir, 'extension.json'),
    JSON.stringify(
      {
        id: FIXTURE_ID, type: 'mcp-server', title: 'local-sources fixture',
        description: 'local-sources fixture description', entrypoint: 'dist/index.js',
        compatibility: { host: '>=1.0.0 <2.0.0' },
      },
      null, 2,
    ),
  );
  fs.writeFileSync(
    path.join(extDir, 'package.json'),
    JSON.stringify({ name: FIXTURE_PKG, version, private: false }, null, 2),
  );
  fs.writeFileSync(path.join(extDir, 'dist', 'index.js'), distBody);

  fs.mkdirSync(path.join(root, 'registry'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'registry', 'index.json'),
    JSON.stringify(
      [
        {
          id: FIXTURE_ID, type: 'mcp-server', version, title: 'local-sources fixture',
          description: 'local-sources fixture description',
          source: `npm-package:${FIXTURE_PKG}@${version}`,
          checksum: PUBLISHED_SENTINEL,
          compatibility: { host: '>=1.0.0 <2.0.0' },
        },
      ],
      null, 2,
    ) + '\n',
  );

  git(['add', '.'], root);
  git(['commit', '-q', '-m', 'chore: seed published state'], root);
  return root;
}

async function runBuildIndex(
  root: string,
  extraArgs: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; out: string }> {
  const child = spawn(process.execPath, [TSX_CLI, SCRIPT, root, ...extraArgs], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
  });
  let out = '';
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (out += d.toString()));
  const code = await new Promise<number>((resolve) => child.on('close', (c) => resolve(c ?? -1)));
  return { code, out };
}

describe('[7c686059] --local-sources never fires the 4d1a3bf9 pin-loss guard, and tolerates a dirty tree', () => {
  it('a committed npm-package: pin is silently overridden to file:// — no PinLossError, no "4d1a3bf9" in output', async () => {
    const root = scratchRepo('2.0.0', 'module.exports = "REBUILT LOCALLY";\n');
    const outPath = path.join(root, 'scratch-out', 'index.json');
    const committedBefore = fs.readFileSync(path.join(root, 'registry', 'index.json'), 'utf8');

    const { code, out } = await runBuildIndex(root, ['--local-sources', '--out', outPath], {
      SOX_REGISTRY_PUBLISH: '',
    });

    expect(code, out).toBe(0);
    expect(out).not.toMatch(/4d1a3bf9/);
    expect(out).not.toMatch(/PinLossError/);

    const entries = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Array<{ id: string; source: string; checksum: string }>;
    const row = entries.find((e) => e.id === FIXTURE_ID);
    expect(row, 'fixture row must be present').toBeDefined();
    expect(row!.source).toBe(`file://${extDirOf(root)}`);
    const expectedChecksum = `sha256:${crypto
      .createHash('sha256')
      .update(fs.readFileSync(path.join(extDirOf(root), 'dist', 'index.js')))
      .digest('hex')}`;
    expect(row!.checksum).toBe(expectedChecksum);
    expect(row!.checksum).not.toBe(PUBLISHED_SENTINEL);

    // The committed file is byte-identical — --local-sources never touches it.
    expect(fs.readFileSync(path.join(root, 'registry', 'index.json'), 'utf8')).toBe(committedBefore);
  }, 60_000);

  it('a dirty working tree does not refuse under --local-sources — output is stamped provisional/+dirty instead', async () => {
    const root = scratchRepo('2.0.0', 'module.exports = "REBUILT LOCALLY";\n');
    // Dirty the tree with a checksum-relevant, TRACKED change — dist/ is
    // gitignored by scratchRepo (mirrors the real repo, and BL-390's own
    // fixtures), so editing it alone would never show up in `git status` at
    // all. Edit the committed extension.json instead — that's a real
    // checksum-irrelevant-prefix-exempt, tracked file (see
    // CHECKSUM_IRRELEVANT_PREFIXES: extensions/** markdown/json is NOT
    // exempt), so it genuinely dirties the tree the same way an agent's WIP
    // manifest edit would.
    const manifestPath = path.join(extDirOf(root), 'extension.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    manifest['title'] = 'local-sources fixture (WIP edit)';
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    const outPath = path.join(root, 'scratch-out', 'index.json');

    const { code, out } = await runBuildIndex(root, ['--local-sources', '--out', outPath]);

    expect(code, out).toBe(0);
    expect(out).not.toMatch(/DirtyTreeError/);
    expect(out).not.toMatch(/REFUSING to run against a dirty working tree/);

    const entries = JSON.parse(fs.readFileSync(outPath, 'utf8')) as Array<{
      id: string; provisional?: boolean; builtFromCommit?: string;
    }>;
    const row = entries.find((e) => e.id === FIXTURE_ID);
    expect(row).toBeDefined();
    expect(row!.provisional).toBe(true);
    expect(row!.builtFromCommit).toMatch(/\+dirty$/);
  }, 60_000);
});
