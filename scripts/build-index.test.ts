/**
 * build-index.test.ts — BL-80 registry walk coverage
 *
 * Asserts that `service`-type extensions under extensions/services/ are scanned
 * into the registry index by buildIndex(). This regression was introduced by
 * DIR_TO_TYPE lacking a `services` key, which caused the entire extensions/services/
 * directory to be silently skipped — leaving `tokenguard` (and any future service
 * extension) absent from registry/index.json and uninstallable by id.
 *
 * BL-33 mirror invariant: the same `services: 'service'` entry MUST exist in
 * check-registry-sync.ts; this test verifies the build-index side only.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildIndex, type IndexEntry } from './build-index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sox-build-index-test-'));
}

function removeDirRecursive(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Write a minimal extension.json + package.json under extensions/<typeDir>/<id>/.
 * Returns the extension directory path.
 */
function makeExtension(
  root: string,
  typeDir: string,
  id: string,
  extra: Record<string, unknown> = {},
): string {
  const extDir = path.join(root, 'extensions', typeDir, id);
  fs.mkdirSync(extDir, { recursive: true });

  // Determine type from typeDir
  const typeDirToType: Record<string, string> = {
    agents: 'agent',
    skills: 'skill',
    'mcp-servers': 'mcp-server',
    services: 'service',
    prompts: 'prompt',
    hooks: 'hook',
    commands: 'command',
    bundles: 'bundle',
  };
  const type = typeDirToType[typeDir] ?? typeDir;

  const manifest: Record<string, unknown> = {
    $schema: 'https://your-registry/schemas/extension/v2.json',
    id,
    version: '0.1.0',
    type,
    title: `${id} title`,
    description: `${id} description`,
    compatibility: { host: '>=1.0.0 <2.0.0' },
    license: 'MIT',
    ...extra,
  };

  fs.writeFileSync(path.join(extDir, 'extension.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(
    path.join(extDir, 'package.json'),
    JSON.stringify({ name: `@adhd/sox-extension-${id}`, version: '0.1.0' }, null, 2),
  );
  return extDir;
}

// ─── BL-80: service directory walk ───────────────────────────────────────────

describe('[BL-80] buildIndex: service-type extensions are scanned from extensions/services/', () => {
  let root: string;

  beforeEach(() => {
    root = makeTempRoot();
  });

  afterEach(() => {
    removeDirRecursive(root);
  });

  it('includes a service-type extension from extensions/services/', () => {
    makeExtension(root, 'services', 'my-proxy', {
      entrypoint: 'dist/index.js',
      install: { type: 'service', transports: ['http'] },
    });

    const entries = buildIndex({ root });

    const serviceEntry = entries.find((e) => e.id === 'my-proxy');
    expect(serviceEntry).toBeDefined();
    expect(serviceEntry!.type).toBe('service');
    expect(serviceEntry!.source).toBe(`file://${path.join(root, 'extensions', 'services', 'my-proxy')}`);
  });

  it('includes service extensions alongside other types in the same index', () => {
    makeExtension(root, 'skills', 'some-skill');
    makeExtension(root, 'services', 'my-service', {
      install: { type: 'service', transports: ['stdio'] },
    });
    makeExtension(root, 'agents', 'my-agent', { entrypoint: 'dist/index.js' });

    const entries = buildIndex({ root });
    const ids = entries.map((e) => e.id);

    expect(ids).toContain('some-skill');
    expect(ids).toContain('my-service');
    expect(ids).toContain('my-agent');

    const svc = entries.find((e) => e.id === 'my-service')!;
    expect(svc.type).toBe('service');
  });

  it('skips a service extension whose extension.json has private:true', () => {
    makeExtension(root, 'services', 'private-svc', {
      private: true,
      install: { type: 'service', transports: ['http'] },
    });

    const entries = buildIndex({ root });
    expect(entries.find((e) => e.id === 'private-svc')).toBeUndefined();
  });

  it('multiple service extensions all appear in the index', () => {
    makeExtension(root, 'services', 'svc-alpha', { install: { type: 'service', transports: ['http'] } });
    makeExtension(root, 'services', 'svc-beta', { install: { type: 'service', transports: ['stdio'] } });

    const entries = buildIndex({ root });
    const ids = entries.map((e) => e.id);

    expect(ids).toContain('svc-alpha');
    expect(ids).toContain('svc-beta');
    expect(entries.find((e) => e.id === 'svc-alpha')!.type).toBe('service');
    expect(entries.find((e) => e.id === 'svc-beta')!.type).toBe('service');
  });

  it('a service dir with no extension.json is silently skipped (no crash)', () => {
    // A directory without extension.json (e.g. a stray folder)
    const strayDir = path.join(root, 'extensions', 'services', 'stray-dir');
    fs.mkdirSync(strayDir, { recursive: true });
    // Place a valid service alongside it
    makeExtension(root, 'services', 'valid-svc', {
      install: { type: 'service', transports: ['http'] },
    });

    // Should not throw; stray-dir is skipped, valid-svc is present
    const entries = buildIndex({ root });
    expect(entries.find((e) => e.id === 'valid-svc')).toBeDefined();
    expect(entries.find((e) => e.id === 'stray-dir')).toBeUndefined();
  });

  it('[BL-33 mirror] check-registry-sync DIR_TO_TYPE contains services:service matching build-index', () => {
    // Verify the BL-33 invariant: both files must carry identical DIR_TO_TYPE.
    // We import the raw source text of check-registry-sync and assert 'services' appears
    // in its DIR_TO_TYPE block — catching any future edit that adds to one file but not both.
    const syncPath = path.join(__dirname, 'check-registry-sync.ts');
    const syncSource = fs.readFileSync(syncPath, 'utf8');

    // Extract the DIR_TO_TYPE block by looking for the object literal
    const dirToTypeMatch = syncSource.match(/const DIR_TO_TYPE[\s\S]*?};/);
    expect(dirToTypeMatch).toBeTruthy();
    const dirToTypeBlock = dirToTypeMatch![0];

    expect(dirToTypeBlock).toContain("services: 'service'");
  });
});
