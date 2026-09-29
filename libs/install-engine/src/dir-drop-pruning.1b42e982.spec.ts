/**
 * libs/install-engine/src/dir-drop-pruning.1b42e982.spec.ts
 *
 * 1b42e982 — a directory file-drop (skill / command / hook) copied the source
 * with `fs.cpSync(src, dest, {recursive:true, force:true})`. `force` overwrites
 * but never deletes, so a file removed from the source survived every re-install
 * (and upgrade), and `hashPathForInstall(dest)` then cemented that stale tree as
 * "current" in the ledger. This is the destination-side half of the
 * silent-staleness class; the staging side was fixed in c206ec5e (e1e98fe0).
 *
 * Fix: `mirrorPathSync` removes the destination directory before copying so the
 * install is a byte-exact image of the source. Drives the REAL declarativeInstall
 * against a sandboxed workspace + scope root, patching the
 * '@adhd/sox-host-registry' specifier to the built sibling dist (same technique
 * as skill-install.spec.ts).
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Module from 'node:module';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';

import { declarativeInstall } from './install.js';

declare const __dirname: string;
const hostRegistryPath = path.resolve(__dirname, '../../host-registry/dist/index.js');

const M = Module as unknown as {
  _resolveFilename: (request: string, parent: unknown, isMain: boolean, options?: unknown) => string;
};
const originalResolveFilename = M._resolveFilename;
M._resolveFilename = function patchedResolveFilename(
  request: string,
  parent: unknown,
  isMain: boolean,
  options?: unknown,
): string {
  if (request === '@adhd/sox-host-registry') return hostRegistryPath;
  return originalResolveFilename.call(this, request, parent, isMain, options);
};

afterAll(() => {
  M._resolveFilename = originalResolveFilename;
});

let base: string;
let workspace: string;
let scopeRoot: string;

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-dir-drop-'));
  workspace = path.join(base, 'ws');
  // ADR-0004 §D2: scopeRoot is the DATA dir (.adhd/sox-ecosystem) for the scope.
  scopeRoot = path.join(workspace, '.adhd', 'sox-ecosystem');
  fs.mkdirSync(workspace, { recursive: true });
});

afterEach(() => {
  try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
});

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function writeExtensionDir(type: string, dirname: string, extraFiles: Record<string, string> = {}): string {
  const dir = path.join(workspace, 'extensions', `${type}s`, dirname);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'extension.json'),
    JSON.stringify({
      id: dirname,
      version: '0.1.0',
      type,
      title: dirname,
      description: `${type} ${dirname}`,
      entrypoint: 'SKILL.md',
    }, null, 2),
    'utf8',
  );
  fs.writeFileSync(path.join(dir, 'SKILL.md'), `# ${dirname}\n`, 'utf8');
  for (const [rel, content] of Object.entries(extraFiles)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

// ─── skill: destination-side pruning through the primary file-drop branch ────

describe('1b42e982 — removed source files are pruned from the destination directory', () => {
  it('skill: a file removed from references/ is absent after re-install', async () => {
    const srcPath = writeExtensionDir('skill', 'prune-skill', {
      'references/gone.md': '# gone\n',
      'references/keep.md': '# keep\n',
    });

    const first = await declarativeInstall(
      { ext: 'prune-skill', type: 'skill', hosts: ['claude'], srcPath },
      'project',
      workspace,
      scopeRoot,
    );
    expect(first[0]?.applied).toBe(true);

    const installedRefs = path.join(workspace, '.claude', 'skills', 'prune-skill', 'references');
    expect(fs.existsSync(path.join(installedRefs, 'gone.md'))).toBe(true);

    fs.rmSync(path.join(srcPath, 'references', 'gone.md'));

    const second = await declarativeInstall(
      { ext: 'prune-skill', type: 'skill', hosts: ['claude'], srcPath },
      'project',
      workspace,
      scopeRoot,
    );
    expect(second[0]?.applied).toBe(true);

    expect(fs.existsSync(path.join(installedRefs, 'gone.md'))).toBe(false);
    expect(fs.readFileSync(path.join(installedRefs, 'keep.md'), 'utf8')).toBe('# keep\n');
  });

  it('command: a file removed from the source is absent after re-install', async () => {
    const srcPath = writeExtensionDir('command', 'prune-command', {
      'docs/gone.md': '# gone\n',
      'docs/keep.md': '# keep\n',
    });

    const first = await declarativeInstall(
      { ext: 'prune-command', type: 'command', hosts: ['claude'], srcPath },
      'project',
      workspace,
      scopeRoot,
    );
    expect(first[0]?.applied).toBe(true);

    const installedDocs = path.join(workspace, '.claude', 'commands', 'prune-command', 'docs');
    expect(fs.existsSync(path.join(installedDocs, 'gone.md'))).toBe(true);

    fs.rmSync(path.join(srcPath, 'docs', 'gone.md'));

    const second = await declarativeInstall(
      { ext: 'prune-command', type: 'command', hosts: ['claude'], srcPath },
      'project',
      workspace,
      scopeRoot,
    );
    expect(second[0]?.applied).toBe(true);

    expect(fs.existsSync(path.join(installedDocs, 'gone.md'))).toBe(false);
    expect(fs.readFileSync(path.join(installedDocs, 'keep.md'), 'utf8')).toBe('# keep\n');
  });

  it('hook: a file removed from the source is absent from ~/.claude/hooks/<id> after re-install', async () => {
    // The hook-script drop is a user-scope secondary surface. SOX_SANDBOX_ROOT
    // reroots the placement (~/.claude → <sandbox>/.claude); the data root is
    // already sandboxed by vitest.setup.ts. Both are restored afterwards.
    const prevHome = process.env['SOX_ECOSYSTEM_HOME'];
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-hook-data-'));
    const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sox-hook-sandbox-'));
    process.env['SOX_ECOSYSTEM_HOME'] = dataDir;
    process.env['SOX_SANDBOX_ROOT'] = sandboxRoot;

    try {
      const srcPath = writeExtensionDir('hook', 'prune-hook', {
        'scripts/gone.sh': '#!/bin/sh\n',
        'scripts/keep.sh': '#!/bin/sh\n',
      });

      const descriptor = {
        ext: 'prune-hook',
        type: 'hook',
        hosts: ['claude'],
        srcPath,
        configEntries: [{ matcher: 'SessionEnd', hooks: [{ type: 'command', command: 'true' }] }],
      };

      const first = await declarativeInstall(descriptor, 'user', workspace, dataDir);
      expect(first.some((r) => r.capability === 'file-drop' && r.applied)).toBe(true);

      const installedScripts = path.join(sandboxRoot, '.claude', 'hooks', 'prune-hook', 'scripts');
      expect(fs.existsSync(path.join(installedScripts, 'gone.sh'))).toBe(true);

      fs.rmSync(path.join(srcPath, 'scripts', 'gone.sh'));

      const second = await declarativeInstall(descriptor, 'user', workspace, dataDir);
      expect(second.some((r) => r.capability === 'file-drop' && r.applied)).toBe(true);

      expect(fs.existsSync(path.join(installedScripts, 'gone.sh'))).toBe(false);
      expect(fs.readFileSync(path.join(installedScripts, 'keep.sh'), 'utf8')).toBe('#!/bin/sh\n');
    } finally {
      if (prevHome === undefined) delete process.env['SOX_ECOSYSTEM_HOME'];
      else process.env['SOX_ECOSYSTEM_HOME'] = prevHome;
      delete process.env['SOX_SANDBOX_ROOT'];
      try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
      try { fs.rmSync(sandboxRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
