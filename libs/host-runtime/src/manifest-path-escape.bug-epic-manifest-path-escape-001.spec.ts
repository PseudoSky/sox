/**
 * libs/host-runtime/src/manifest-path-escape.bug-epic-manifest-path-escape-001.spec.ts
 *
 * BUG-EPIC-MANIFEST-PATH-ESCAPE-001 — loader.ts:~275: manifest.entrypoint is
 * untrusted and, absent a containment check, gets resolved and handed to the
 * activation/spawn path for EVERY extension loaded at host startup — the
 * single most exposed site in the epic, since it runs automatically.
 *
 * RED (pre-fix): the escaping entry would activate/spawn against a path
 * outside its extension dir. GREEN (post-fix): loadFromLockfile SKIPS the
 * entry with a clear reason and never activates it.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadFromLockfile } from './loader.js';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'loader-path-escape-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeLockfile(root: string, entries: Record<string, { source: string }>): string {
  const lockfilePath = path.join(root, 'lockfile.json');
  fs.writeFileSync(
    lockfilePath,
    JSON.stringify({ lockfileVersion: 1, resolved: entries }, null, 2),
  );
  return lockfilePath;
}

describe('loadFromLockfile — manifest.entrypoint escape (loader.ts:~275)', () => {
  it('SKIPS an entry whose manifest.entrypoint resolves outside the extension dir (literal ../ escape)', async () => {
    const extDir = path.join(tmp, 'extensions', 'evil-loader');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({ id: 'evil-loader', type: 'mcp-server', entrypoint: '../../evil.js' }),
    );
    fs.writeFileSync(path.join(tmp, 'evil.js'), 'module.exports = {};');

    const lockfilePath = writeLockfile(tmp, { 'evil-loader': { source: `file://${extDir}/dist/index.js` } });

    const result = await loadFromLockfile({ lockfilePath, root: tmp });

    expect(result.activated).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/escapes extension dir/i);
  });

  it('SKIPS an entry whose manifest.entrypoint is a symlink pointing outside the extension dir', async () => {
    const extDir = path.join(tmp, 'extensions', 'evil-loader-symlink');
    const outside = path.join(tmp, 'outside');
    fs.mkdirSync(extDir, { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(outside, 'secret.js'), 'module.exports = {};');
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({ id: 'evil-loader-symlink', type: 'mcp-server', entrypoint: 'link-out.js' }),
    );
    fs.symlinkSync(path.join(outside, 'secret.js'), path.join(extDir, 'link-out.js'));

    const lockfilePath = writeLockfile(tmp, {
      'evil-loader-symlink': { source: `file://${extDir}/dist/index.js` },
    });

    const result = await loadFromLockfile({ lockfilePath, root: tmp });

    expect(result.activated).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).toMatch(/escapes extension dir/i);
  });

  it('does NOT skip (for escape reasons) an mcp-server entry whose entrypoint stays inside the extension dir', async () => {
    const extDir = path.join(tmp, 'extensions', 'good-loader');
    fs.mkdirSync(extDir, { recursive: true });
    fs.writeFileSync(
      path.join(extDir, 'extension.json'),
      JSON.stringify({ id: 'good-loader', type: 'mcp-server', entrypoint: 'dist/index.js' }),
    );
    // No dist/index.js on disk — expect a DIFFERENT skip reason ("built
    // entrypoint not found"), proving the fix isn't a blanket regression.
    const lockfilePath = writeLockfile(tmp, { 'good-loader': { source: `file://${extDir}/dist/index.js` } });

    const result = await loadFromLockfile({ lockfilePath, root: tmp });

    expect(result.activated).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.reason).not.toMatch(/escapes extension dir/i);
    expect(result.skipped[0]!.reason).toMatch(/built entrypoint not found/i);
  });
});
