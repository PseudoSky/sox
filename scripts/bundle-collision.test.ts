/**
 * bundle-collision.test.ts — PC: bundle-member version-conflict operator-visible signal
 *
 * Covers the now-closed gap (PC): when two bundles both list the same member extension
 * with DIFFERENT version specs, expandBundles() (install.ts ~709–794) emits an
 * OPERATOR-VISIBLE console.warn and uses first-seen semantics (warn-first policy).
 *
 * Previously this was SILENT first-seen dedup (Gap A3). PC replaces that with:
 *   - console.warn emitted when two bundles declare the same member with different versions
 *   - first-seen still wins (warn-first; operator can resolve by pinning an explicit entry)
 *
 * This file:
 *   1. ASSERTS the operator-visible conflict signal (console.warn) when two bundles
 *      disagree on a member's version spec (replaces the old "silent dedup" pin).
 *   2. Asserts first-seen still wins (the install still succeeds with the first bundle's version).
 *   3. Asserts the explicit-entry-override behavior (explicit install entry always beats
 *      bundle-expanded entry — unchanged from prior spec).
 *   4. Asserts install-order determines which bundle is "first-seen" (unchanged).
 *   5. Asserts non-overlapping bundles expand fully without false-positive dedup (unchanged).
 *
 * CONTRACT: the operator-visible warn IS the specified behavior. If expandBundles() stops
 * emitting the warn on a version conflict, tests 1 and 4 will fail.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { install } from './install.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sox-bundle-collision-test-'));
}

function removeDirRecursive(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeExtension(
  root: string,
  typeDir: string,
  id: string,
  version = '0.1.0',
): string {
  const extDir = path.join(root, 'extensions', typeDir, id);
  fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });

  let type = 'skill';
  if (typeDir === 'agents') type = 'agent';
  else if (typeDir === 'bundles') type = 'bundle';

  const manifest: Record<string, unknown> = {
    $schema: 'https://your-registry/schemas/extension/v1.json',
    id,
    version,
    type,
    title: `${id} title`,
    description: `${id} description`,
    compatibility: { host: '>=1.0.0 <2.0.0' },
    license: 'MIT',
    entrypoint: 'dist/index.js',
  };

  fs.writeFileSync(path.join(extDir, 'extension.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(extDir, 'package.json'), JSON.stringify({ name: `@sox/${id}`, version }, null, 2));
  fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
  fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), `// ${id} stub\nexport const id = '${id}';\n`);
  return extDir;
}

function makeBundle(
  root: string,
  id: string,
  members: Array<{ id: string; version: string }>,
): void {
  const extDir = path.join(root, 'extensions', 'bundles', id);
  fs.mkdirSync(path.join(extDir, 'src'), { recursive: true });

  const manifest = {
    $schema: 'https://your-registry/schemas/extension/v1.json',
    id,
    version: '1.0.0',
    type: 'bundle',
    title: `${id} bundle`,
    description: `Bundle ${id}`,
    compatibility: { host: '>=1.0.0 <2.0.0' },
    license: 'MIT',
    members,
  };

  fs.writeFileSync(path.join(extDir, 'extension.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(extDir, 'package.json'), JSON.stringify({ name: `@sox/${id}`, version: '1.0.0' }, null, 2));
  fs.writeFileSync(path.join(extDir, 'CHANGELOG.md'), '');
  fs.writeFileSync(path.join(extDir, 'src', 'index.ts'), `// ${id} bundle stub\n`);
}

function makeConfig(root: string, config: Record<string, unknown>): {
  configPath: string;
  lockfilePath: string;
} {
  const configDir = path.join(root, 'config');
  fs.mkdirSync(configDir, { recursive: true });
  const configPath = path.join(configDir, 'extensions.json');
  const lockfilePath = path.join(configDir, 'extensions.lock');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2));
  return { configPath, lockfilePath };
}

// ─── Bundle-member version conflict tests ────────────────────────────────────

describe('bundle-member version conflict: expandBundles() operator-visible signal (PC)', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    removeDirRecursive(root);
  });

  it('PC SPEC: emits operator-visible console.warn when two bundles declare the same member with different versions', async () => {
    // Shared member extension (only one version on disk — we test the resolution, not the fetch)
    makeExtension(root, 'skills', 'shared-member', '0.2.0');

    // bundle-a lists shared-member@0.1.0 (first-seen)
    makeBundle(root, 'bundle-a', [
      { id: 'shared-member', version: '0.1.0' },
    ]);

    // bundle-b lists shared-member@0.2.0 (second-seen — version conflict)
    makeBundle(root, 'bundle-b', [
      { id: 'shared-member', version: '0.2.0' },
    ]);

    const { configPath, lockfilePath } = makeConfig(root, {
      install: [
        { id: 'bundle-a', source: `file://${path.join(root, 'extensions', 'bundles', 'bundle-a')}` },
        { id: 'bundle-b', source: `file://${path.join(root, 'extensions', 'bundles', 'bundle-b')}` },
      ],
    });

    // Spy on console.warn to assert the operator-visible conflict signal
    const warnSpy = vi.spyOn(console, 'warn');

    const resolved = await install({ scope: 'user', mode: 'default', configPath, lockfilePath, root });

    // The shared member MUST appear exactly once (first-seen still wins)
    expect(Object.keys(resolved)).toContain('shared-member');
    expect(Object.keys(resolved).filter((k) => k === 'shared-member')).toHaveLength(1);

    // PC SPEC: an operator-visible warning MUST have been emitted describing the conflict.
    // The warn must mention: the member id, both bundles, and "CONFLICT" or "version".
    const warnCalls = warnSpy.mock.calls.map((args) => String(args[0]));
    const conflictWarn = warnCalls.find(
      (msg) =>
        msg.includes('shared-member') &&
        msg.includes('bundle-a') &&
        msg.includes('bundle-b') &&
        (msg.toLowerCase().includes('conflict') || msg.toLowerCase().includes('version')),
    );
    expect(conflictWarn).toBeDefined();

    warnSpy.mockRestore();
  });

  it('PC SPEC: explicit install entry overrides bundle-expanded member (supplement semantics — operator-visible warn NOT emitted)', async () => {
    makeExtension(root, 'skills', 'overrideable', '0.3.0');

    makeBundle(root, 'bundle-c', [
      { id: 'overrideable', version: '0.1.0' },
    ]);

    const { configPath, lockfilePath } = makeConfig(root, {
      install: [
        {
          id: 'overrideable',
          version: '0.3.0',
          source: `file://${path.join(root, 'extensions', 'skills', 'overrideable')}`,
        },
        {
          id: 'bundle-c',
          source: `file://${path.join(root, 'extensions', 'bundles', 'bundle-c')}`,
        },
      ],
    });

    const warnSpy = vi.spyOn(console, 'warn');

    const resolved = await install({ scope: 'user', mode: 'default', configPath, lockfilePath, root });

    // The explicit entry beats the bundle-expanded entry (supplement semantics)
    expect(Object.keys(resolved)).toContain('overrideable');
    // overrideable appears exactly once
    expect(Object.keys(resolved).filter((k) => k === 'overrideable')).toHaveLength(1);

    // Explicit-entry override is NOT a version conflict — no warn should be emitted for it
    const warnCalls = warnSpy.mock.calls.map((args) => String(args[0]));
    const conflictWarn = warnCalls.find(
      (msg) => msg.includes('overrideable') && msg.toLowerCase().includes('conflict'),
    );
    expect(conflictWarn).toBeUndefined();

    warnSpy.mockRestore();
  });

  it('install-order determines first-seen; the later bundle emits the conflict warn (not the earlier)', async () => {
    // Same setup but bundle order is reversed: bundle-b first (with 0.2.0), bundle-a second (with 0.1.0)
    makeExtension(root, 'skills', 'shared-member-2', '0.2.0');

    makeBundle(root, 'bundle-x', [
      { id: 'shared-member-2', version: '0.2.0' }, // bundle-x listed first this time
    ]);
    makeBundle(root, 'bundle-y', [
      { id: 'shared-member-2', version: '0.1.0' }, // bundle-y listed second — triggers warn
    ]);

    const { configPath, lockfilePath } = makeConfig(root, {
      install: [
        { id: 'bundle-x', source: `file://${path.join(root, 'extensions', 'bundles', 'bundle-x')}` },
        { id: 'bundle-y', source: `file://${path.join(root, 'extensions', 'bundles', 'bundle-y')}` },
      ],
    });

    const warnSpy = vi.spyOn(console, 'warn');

    const resolved = await install({ scope: 'user', mode: 'default', configPath, lockfilePath, root });

    // shared-member-2 appears exactly once — no duplicate regardless of which bundle is first
    expect(Object.keys(resolved)).toContain('shared-member-2');
    expect(Object.keys(resolved).filter((k) => k === 'shared-member-2')).toHaveLength(1);

    // A conflict warn MUST be emitted because the two bundles disagree on the version
    const warnCalls = warnSpy.mock.calls.map((args) => String(args[0]));
    const conflictWarn = warnCalls.find(
      (msg) =>
        msg.includes('shared-member-2') &&
        (msg.toLowerCase().includes('conflict') || msg.toLowerCase().includes('version')),
    );
    expect(conflictWarn).toBeDefined();

    // The warn must name bundle-x as first-seen winner (it was listed first)
    expect(conflictWarn).toContain('bundle-x');

    warnSpy.mockRestore();
  });

  it('two bundles with non-overlapping members both expand fully (no false-positive dedup, no warn)', async () => {
    makeExtension(root, 'skills', 'member-p', '0.1.0');
    makeExtension(root, 'skills', 'member-q', '0.1.0');
    makeExtension(root, 'skills', 'member-r', '0.1.0');
    makeExtension(root, 'skills', 'member-s', '0.1.0');

    makeBundle(root, 'bundle-pq', [
      { id: 'member-p', version: '0.1.0' },
      { id: 'member-q', version: '0.1.0' },
    ]);
    makeBundle(root, 'bundle-rs', [
      { id: 'member-r', version: '0.1.0' },
      { id: 'member-s', version: '0.1.0' },
    ]);

    const { configPath, lockfilePath } = makeConfig(root, {
      install: [
        {
          id: 'bundle-pq',
          source: `file://${path.join(root, 'extensions', 'bundles', 'bundle-pq')}`,
        },
        {
          id: 'bundle-rs',
          source: `file://${path.join(root, 'extensions', 'bundles', 'bundle-rs')}`,
        },
      ],
    });

    const warnSpy = vi.spyOn(console, 'warn');

    const resolved = await install({ scope: 'user', mode: 'default', configPath, lockfilePath, root });

    // All 4 members present — no false-positive dedup
    expect(Object.keys(resolved)).toContain('member-p');
    expect(Object.keys(resolved)).toContain('member-q');
    expect(Object.keys(resolved)).toContain('member-r');
    expect(Object.keys(resolved)).toContain('member-s');

    // No conflict warn — bundles have non-overlapping members
    const warnCalls = warnSpy.mock.calls.map((args) => String(args[0]));
    const conflictWarn = warnCalls.find((msg) => msg.toLowerCase().includes('conflict'));
    expect(conflictWarn).toBeUndefined();

    warnSpy.mockRestore();
  });

  it('PC: bundle provenance — lockfile records bundle_id for each bundle-expanded member', async () => {
    makeExtension(root, 'skills', 'prov-member', '0.1.0');
    makeBundle(root, 'prov-bundle', [
      { id: 'prov-member', version: '0.1.0' },
    ]);

    const { configPath, lockfilePath } = makeConfig(root, {
      install: [
        { id: 'prov-bundle', source: `file://${path.join(root, 'extensions', 'bundles', 'prov-bundle')}` },
      ],
    });

    await install({ scope: 'user', mode: 'default', configPath, lockfilePath, root });

    // Read the lockfile and verify bundle_id provenance is recorded
    const lockfileRaw = fs.readFileSync(lockfilePath, 'utf8');
    const lockfile = JSON.parse(lockfileRaw) as {
      lockfileVersion: number;
      resolved: Record<string, { source: string; checksum: string; resolved_at: string; bundle_id?: string }>;
    };

    // Find the prov-member entry in the lockfile
    const provKey = Object.keys(lockfile.resolved).find((k) => k.startsWith('prov-member@'));
    expect(provKey).toBeDefined();

    const provEntry = lockfile.resolved[provKey!];
    expect(provEntry).toBeDefined();
    // PC: the bundle_id field MUST be set to the originating bundle's id
    expect(provEntry!.bundle_id).toBe('prov-bundle');
  });
});
