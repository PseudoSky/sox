/**
 * apps/sox/src/bundle-init.spec.ts — Unit tests for bundle-init helpers.
 *
 * Covers:
 *   [bundle-resolve.1] — resolveBundleDir: registry-first lookup → filesystem fallback
 *   [bundle-register.1] — registerBundleMember: append + idempotency + missing-members init
 */

import { describe, it, expect } from 'vitest';
import { resolveBundleDir, registerBundleMember } from './bundle-init.js';
import * as nodePath from 'node:path';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** A minimal path-module stub (only `join` is required by resolveBundleDir). */
const pathStub: Pick<typeof nodePath, 'join'> = {
  join: (...parts: string[]) => parts.join('/').replace(/\/+/g, '/'),
};

/** Build a registry entry array as JSON string. */
function makeRegistry(
  entries: Array<{ id: string; type: string; source?: string }>,
): string {
  return JSON.stringify(entries);
}

/** Build a bundle extension.json with the given members. */
function makeBundle(id: string, members: Array<{ id: string; version: string }>): string {
  return JSON.stringify({ id, type: 'bundle', title: id, members });
}

// ─── resolveBundleDir ─────────────────────────────────────────────────────────

describe('resolveBundleDir — registry-first resolution', () => {
  it('finds bundle via registry/index.json when source path exists', () => {
    const cwd = '/repo';
    const bundleDir = '/repo/extensions/bundles/my-bundle';

    const fs: Record<string, string> = {
      '/repo/registry/index.json': makeRegistry([
        { id: 'my-bundle', type: 'bundle', source: `file://${bundleDir}` },
      ]),
    };
    const dirs = new Set([bundleDir, '/repo/registry']);

    const existsFn = (p: string): boolean => p in fs || dirs.has(p);
    const readFileFn = (p: string, _enc: 'utf8'): string => {
      const c = fs[p];
      if (c === undefined) throw new Error(`ENOENT: ${p}`);
      return c;
    };
    const readdirFn = (_p: string): string[] => [];

    const result = resolveBundleDir('my-bundle', cwd, pathStub, existsFn, readFileFn, readdirFn);
    expect(result).toBe(bundleDir);
  });

  it('returns undefined when bundle id does not match registry', () => {
    const cwd = '/repo';
    const fs: Record<string, string> = {
      '/repo/registry/index.json': makeRegistry([
        { id: 'other-bundle', type: 'bundle', source: 'file:///repo/extensions/bundles/other-bundle' },
      ]),
    };

    const existsFn = (p: string): boolean => p in fs;
    const readFileFn = (p: string, _enc: 'utf8'): string => {
      const c = fs[p];
      if (c === undefined) throw new Error(`ENOENT: ${p}`);
      return c;
    };
    const readdirFn = (_p: string): string[] => [];

    const result = resolveBundleDir('nope', cwd, pathStub, existsFn, readFileFn, readdirFn);
    expect(result).toBeUndefined();
  });

  it('skips registry entry if source path does not exist on disk', () => {
    const cwd = '/repo';
    const fs: Record<string, string> = {
      '/repo/registry/index.json': makeRegistry([
        { id: 'my-bundle', type: 'bundle', source: 'file:///repo/extensions/bundles/my-bundle' },
      ]),
    };
    // source path NOT in existsFn — simulates stale registry

    const existsFn = (p: string): boolean => p in fs; // bundle dir absent
    const readFileFn = (p: string, _enc: 'utf8'): string => {
      const c = fs[p];
      if (c === undefined) throw new Error(`ENOENT: ${p}`);
      return c;
    };
    const readdirFn = (_p: string): string[] => [];

    const result = resolveBundleDir('my-bundle', cwd, pathStub, existsFn, readFileFn, readdirFn);
    expect(result).toBeUndefined();
  });
});

describe('resolveBundleDir — filesystem fallback', () => {
  it('falls back to scanning extensions/bundles/ when registry is absent', () => {
    const cwd = '/repo';
    const bundleDir = '/repo/extensions/bundles/scan-bundle';
    const manifestPath = `${bundleDir}/extension.json`;

    const fs: Record<string, string> = {
      [manifestPath]: makeBundle('scan-bundle', []),
    };
    const dirs = new Set([bundleDir, '/repo/extensions/bundles']);

    const existsFn = (p: string): boolean => p in fs || dirs.has(p);
    const readFileFn = (p: string, _enc: 'utf8'): string => {
      const c = fs[p];
      if (c === undefined) throw new Error(`ENOENT: ${p}`);
      return c;
    };
    const readdirFn = (p: string): string[] => {
      if (p === '/repo/extensions/bundles') return ['scan-bundle'];
      return [];
    };

    const result = resolveBundleDir('scan-bundle', cwd, pathStub, existsFn, readFileFn, readdirFn);
    expect(result).toBe(bundleDir);
  });

  it('skips directories with no extension.json in the filesystem scan', () => {
    const cwd = '/repo';
    const dirs = new Set(['/repo/extensions/bundles', '/repo/extensions/bundles/no-manifest']);

    const existsFn = (p: string): boolean => dirs.has(p);
    const readFileFn = (_p: string, _enc: 'utf8'): string => {
      throw new Error('ENOENT');
    };
    const readdirFn = (p: string): string[] => {
      if (p === '/repo/extensions/bundles') return ['no-manifest'];
      return [];
    };

    const result = resolveBundleDir('no-manifest', cwd, pathStub, existsFn, readFileFn, readdirFn);
    expect(result).toBeUndefined();
  });

  it('skips malformed extension.json files in the filesystem scan', () => {
    const cwd = '/repo';
    const bundleDir = '/repo/extensions/bundles/bad-json';
    const manifestPath = `${bundleDir}/extension.json`;

    const fs: Record<string, string> = {
      [manifestPath]: '{ broken json ',
    };
    const dirs = new Set([bundleDir, '/repo/extensions/bundles']);

    const existsFn = (p: string): boolean => p in fs || dirs.has(p);
    const readFileFn = (p: string, _enc: 'utf8'): string => {
      const c = fs[p];
      if (c === undefined) throw new Error(`ENOENT: ${p}`);
      return c;
    };
    const readdirFn = (p: string): string[] => {
      if (p === '/repo/extensions/bundles') return ['bad-json'];
      return [];
    };

    const result = resolveBundleDir('bad-json', cwd, pathStub, existsFn, readFileFn, readdirFn);
    expect(result).toBeUndefined();
  });

  it('registry takes priority over filesystem scan', () => {
    const cwd = '/repo';
    const registryBundleDir = '/repo/extensions/bundles/reg-bundle';
    const fsBundleDir = '/repo/extensions/bundles/reg-bundle-fs';
    const fsBundleManifest = `${fsBundleDir}/extension.json`;

    const fs: Record<string, string> = {
      '/repo/registry/index.json': makeRegistry([
        { id: 'reg-bundle', type: 'bundle', source: `file://${registryBundleDir}` },
      ]),
      [fsBundleManifest]: makeBundle('reg-bundle', []),
    };
    const dirs = new Set([registryBundleDir, fsBundleDir, '/repo/extensions/bundles']);

    const existsFn = (p: string): boolean => p in fs || dirs.has(p);
    const readFileFn = (p: string, _enc: 'utf8'): string => {
      const c = fs[p];
      if (c === undefined) throw new Error(`ENOENT: ${p}`);
      return c;
    };
    const readdirFn = (p: string): string[] => {
      if (p === '/repo/extensions/bundles') return ['reg-bundle-fs'];
      return [];
    };

    const result = resolveBundleDir('reg-bundle', cwd, pathStub, existsFn, readFileFn, readdirFn);
    expect(result).toBe(registryBundleDir); // registry wins
  });

  it('returns undefined when neither registry nor filesystem scan finds the bundle', () => {
    const cwd = '/repo';
    const existsFn = (_p: string): boolean => false;
    const readFileFn = (_p: string, _enc: 'utf8'): string => {
      throw new Error('ENOENT');
    };
    const readdirFn = (_p: string): string[] => [];

    const result = resolveBundleDir('ghost', cwd, pathStub, existsFn, readFileFn, readdirFn);
    expect(result).toBeUndefined();
  });
});

// ─── registerBundleMember ─────────────────────────────────────────────────────

describe('registerBundleMember — append and idempotency', () => {
  it('appends a new member to members[] and writes the file', () => {
    const initial = makeBundle('test-bundle', [{ id: 'existing-member', version: '^0.1.0' }]);
    let written = '';

    const readFileFn = (_p: string, _enc: 'utf8'): string => initial;
    const writeFileFn = (_p: string, data: string, _enc: 'utf8'): void => {
      written = data;
    };

    registerBundleMember('/fake/extension.json', 'new-member', readFileFn, writeFileFn);

    const result = JSON.parse(written) as { members: Array<{ id: string; version: string }> };
    expect(result.members).toHaveLength(2);
    expect(result.members[1]).toEqual({ id: 'new-member', version: '^0.1.0' });
  });

  it('is idempotent: does not duplicate if member id already present', () => {
    const initial = makeBundle('test-bundle', [{ id: 'already-there', version: '^0.1.0' }]);
    let written = '';

    const readFileFn = (_p: string, _enc: 'utf8'): string => initial;
    const writeFileFn = (_p: string, data: string, _enc: 'utf8'): void => {
      written = data;
    };

    registerBundleMember('/fake/extension.json', 'already-there', readFileFn, writeFileFn);

    // writeFileFn should NOT have been called (early return before write)
    expect(written).toBe('');
  });

  it('initializes members[] when bundle manifest has no members key', () => {
    const noMembers = JSON.stringify({ id: 'b', type: 'bundle', title: 'b' });
    let written = '';

    const readFileFn = (_p: string, _enc: 'utf8'): string => noMembers;
    const writeFileFn = (_p: string, data: string, _enc: 'utf8'): void => {
      written = data;
    };

    registerBundleMember('/fake/extension.json', 'first-member', readFileFn, writeFileFn);

    const result = JSON.parse(written) as { members: Array<{ id: string; version: string }> };
    expect(result.members).toHaveLength(1);
    expect(result.members[0]).toEqual({ id: 'first-member', version: '^0.1.0' });
  });

  it('uses version ^0.1.0 for newly registered members', () => {
    const initial = makeBundle('test-bundle', []);
    let written = '';

    const readFileFn = (_p: string, _enc: 'utf8'): string => initial;
    const writeFileFn = (_p: string, data: string, _enc: 'utf8'): void => {
      written = data;
    };

    registerBundleMember('/fake/extension.json', 'versioned-member', readFileFn, writeFileFn);

    const result = JSON.parse(written) as { members: Array<{ id: string; version: string }> };
    const member = result.members.find((m) => m.id === 'versioned-member');
    expect(member?.version).toBe('^0.1.0');
  });

  it('writes 2-space indented JSON with trailing newline', () => {
    const initial = makeBundle('test-bundle', []);
    let written = '';

    const readFileFn = (_p: string, _enc: 'utf8'): string => initial;
    const writeFileFn = (_p: string, data: string, _enc: 'utf8'): void => {
      written = data;
    };

    registerBundleMember('/fake/extension.json', 'fmt-member', readFileFn, writeFileFn);

    expect(written).toMatch(/^\{/); // valid JSON object
    expect(written.endsWith('\n')).toBe(true); // trailing newline
    // 2-space indent: members array line is indented with 2 spaces
    expect(written).toContain('  "members"');
  });

  it('throws on unreadable manifest', () => {
    const readFileFn = (_p: string, _enc: 'utf8'): string => {
      throw new Error('EACCES: permission denied');
    };
    const writeFileFn = (_p: string, _data: string, _enc: 'utf8'): void => { /* noop */ };

    expect(() =>
      registerBundleMember('/fake/extension.json', 'member', readFileFn, writeFileFn),
    ).toThrow('cannot read');
  });

  it('throws on malformed manifest JSON', () => {
    const readFileFn = (_p: string, _enc: 'utf8'): string => '{ bad json }}}';
    const writeFileFn = (_p: string, _data: string, _enc: 'utf8'): void => { /* noop */ };

    expect(() =>
      registerBundleMember('/fake/extension.json', 'member', readFileFn, writeFileFn),
    ).toThrow('malformed JSON');
  });
});
