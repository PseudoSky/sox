/**
 * libs/install-engine/src/project-root.spec.ts — BL-73 regression gate.
 *
 * Verifies that install({ scope: 'project', root: <tempDir> }) writes BOTH the
 * extensions.lock lockfile AND reads the extensions.json config from <tempDir>,
 * NOT from the CLI's own REPO_ROOT — even when <tempDir> is NOT a git repository.
 *
 * THE BUG (before the fix): install() called getScopePath(opts.scope) which always
 * resolved paths against the module-level REPO_ROOT constant (derived at import time
 * from __dirname of the built install.js). For project/local scopes, this means:
 *   config  → REPO_ROOT/.adhd/sox-ecosystem/extensions.json  (CLI's repo)
 *   lockfile→ REPO_ROOT/.adhd/sox-ecosystem/extensions.lock  (CLI's repo)
 * regardless of opts.root. A `--scope project` install from any non-git directory
 * silently wrote its bookkeeping to the CLI's own repo, not the target project.
 *
 * THE FIX: install() now calls scopeConfigPaths(opts.scope, root) so both paths
 * derive from root (= opts.root ?? REPO_ROOT). The CLI passes workspaceRoot =
 * process.cwd() (or --root) so project installs co-locate .adhd/ with .claude/.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { install, loadLockfile } from './install.js';
import { DATA_SUBDIR, scopeConfigPaths } from './data-paths.js';

// ─── helpers ─────────────────────────────────────────────────────────────────

function sha256File(p: string): string {
  return 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

interface TempProject {
  projectRoot: string;
  extDir: string;
  artifactPath: string;
  dataDir: string;
  configPath: string;
  lockfilePath: string;
}

/**
 * Build a synthetic project root that deliberately has NO `.git` dir (the BL-73
 * scenario) and contains:
 *   - extensions/skills/<id>/  — extension fixture with built artifact
 *   - registry/index.json      — one-entry registry pointing at the fixture
 *   - .adhd/sox-ecosystem/extensions.json — scope config (the correct root path)
 *
 * The config and lockfile paths are derived via scopeConfigPaths so they match
 * exactly what install() will use after the fix.
 */
function makeTempProject(id: string, artifactBody: string): TempProject {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bl73-'));

  // Explicitly NO .git directory — confirms non-git project works.

  const extDir = path.join(projectRoot, 'extensions', 'skills', id);
  fs.mkdirSync(path.join(extDir, 'dist'), { recursive: true });

  const artifactPath = path.join(extDir, 'dist', 'index.js');
  fs.writeFileSync(artifactPath, artifactBody, 'utf8');

  fs.writeFileSync(
    path.join(extDir, 'extension.json'),
    JSON.stringify(
      {
        id,
        type: 'skill',
        title: `BL-73 fixture ${id}`,
        description: 'BL-73 regression fixture — non-git project root',
        compatibility: { host: '>=1.0.0 <2.0.0' },
        license: 'MIT',
        entrypoint: 'dist/index.js',
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  const registryDir = path.join(projectRoot, 'registry');
  fs.mkdirSync(registryDir, { recursive: true });
  const checksum = sha256File(artifactPath);
  fs.writeFileSync(
    path.join(registryDir, 'index.json'),
    JSON.stringify(
      [
        {
          id,
          type: 'skill',
          title: `BL-73 fixture ${id}`,
          description: 'BL-73 regression fixture — non-git project root',
          source: `file://${extDir}`,
          checksum,
          compatibility: { host: '>=1.0.0 <2.0.0' },
        },
      ],
      null,
      2,
    ) + '\n',
    'utf8',
  );

  // Derive the data dir exactly as install() will after the fix, so we write
  // the config to the path install() will look for it.
  const dataDir = path.join(projectRoot, DATA_SUBDIR);
  fs.mkdirSync(dataDir, { recursive: true });
  const configPath = scopeConfigPaths('project', projectRoot).config;
  const lockfilePath = scopeConfigPaths('project', projectRoot).lockfile;

  // Sanity: derived paths must be under projectRoot, not anywhere else.
  if (!configPath.startsWith(projectRoot)) {
    throw new Error(`[test] configPath not under projectRoot: ${configPath}`);
  }

  fs.writeFileSync(
    configPath,
    JSON.stringify({ install: [{ id, enabled: true }] }, null, 2) + '\n',
    'utf8',
  );

  return { projectRoot, extDir, artifactPath, dataDir, configPath, lockfilePath };
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('BL-73: project-scope install root resolution (non-git directory)', () => {
  const roots: string[] = [];
  let originalSoxHome: string | undefined;

  beforeEach(() => {
    roots.length = 0;
    // Silence the install client's console chatter.
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // Redirect the user data root so cascade's user-scope load never touches the
    // real ~/.adhd and the install-registry writes go to a throwaway dir.
    originalSoxHome = process.env['SOX_ECOSYSTEM_HOME'];
    const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'bl73-home-'));
    roots.push(fakeHome);
    process.env['SOX_ECOSYSTEM_HOME'] = fakeHome;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalSoxHome === undefined) {
      delete process.env['SOX_ECOSYSTEM_HOME'];
    } else {
      process.env['SOX_ECOSYSTEM_HOME'] = originalSoxHome;
    }
    for (const r of roots) {
      try { fs.rmSync(r, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('writes the lockfile under the target project root, not under REPO_ROOT', async () => {
    const id = 'bl73-fixture-lockfile';
    const proj = makeTempProject(id, `module.exports = { v: "bl73-1" };\n`);
    roots.push(proj.projectRoot);

    // Call install() with root=projectRoot but WITHOUT explicit configPath/lockfilePath.
    // After the fix, install() derives both paths from root. Before the fix, it used
    // the module-level REPO_ROOT → extensions.lock landed in the CLI's repo, not here.
    await install({
      scope: 'project',
      mode: 'default',
      root: proj.projectRoot,
      // No configPath / lockfilePath — the fix must derive them from root.
    });

    // The lockfile MUST exist under the project root (.adhd/sox-ecosystem/extensions.lock).
    expect(
      fs.existsSync(proj.lockfilePath),
      `lockfile missing at ${proj.lockfilePath} — path was mis-rooted to REPO_ROOT`,
    ).toBe(true);

    const lock = loadLockfile(proj.lockfilePath);
    expect(lock, 'loaded lockfile must be non-null').not.toBeNull();
    expect(lock!.lockfileVersion).toBe(2);
    expect(lock!.resolved[id], `lockfile entry for ${id} must be present`).toBeDefined();
  });

  it('lockfile source path references an artifact under the project root', async () => {
    const id = 'bl73-fixture-source';
    const proj = makeTempProject(id, `module.exports = { v: "bl73-2" };\n`);
    roots.push(proj.projectRoot);

    await install({
      scope: 'project',
      mode: 'default',
      root: proj.projectRoot,
    });

    const lock = loadLockfile(proj.lockfilePath);
    const entry = lock!.resolved[id];
    expect(entry, 'lockfile entry must be present').toBeDefined();
    // The pinned source must point into our project dir, not somewhere else.
    expect(
      entry!.source,
      'lockfile source must reference the project fixture',
    ).toContain(proj.projectRoot);
  });

  it('config and lockfile co-locate under the same project .adhd/sox-ecosystem/ dir', async () => {
    const id = 'bl73-fixture-colocate';
    const proj = makeTempProject(id, `module.exports = { v: "bl73-3" };\n`);
    roots.push(proj.projectRoot);

    // Verify the paths derived by scopeConfigPaths share a common parent.
    const { config: cfgPath, lockfile: lkPath } = scopeConfigPaths('project', proj.projectRoot);
    expect(path.dirname(cfgPath)).toBe(path.dirname(lkPath));
    expect(path.dirname(cfgPath)).toContain(proj.projectRoot);

    await install({
      scope: 'project',
      mode: 'default',
      root: proj.projectRoot,
    });

    // Both files must exist under the project root after install.
    expect(fs.existsSync(proj.configPath), 'extensions.json missing').toBe(true);
    expect(fs.existsSync(proj.lockfilePath), 'extensions.lock missing').toBe(true);

    // And both must be in the same directory.
    expect(path.dirname(proj.configPath)).toBe(path.dirname(proj.lockfilePath));
  });

  it('no git repo is needed — projectRoot without .git works identically', async () => {
    const id = 'bl73-fixture-nogit';
    const proj = makeTempProject(id, `module.exports = { v: "bl73-4" };\n`);
    roots.push(proj.projectRoot);

    // Confirm there is no .git in the project root (the core BL-73 precondition).
    expect(fs.existsSync(path.join(proj.projectRoot, '.git'))).toBe(false);

    // Install must succeed and write to the correct location regardless.
    await expect(
      install({ scope: 'project', mode: 'default', root: proj.projectRoot }),
    ).resolves.not.toThrow();

    expect(fs.existsSync(proj.lockfilePath)).toBe(true);
  });
});
