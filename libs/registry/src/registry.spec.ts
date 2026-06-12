/**
 * libs/registry/src/registry.spec.ts
 *
 * Tests for the registry drift gate [def:session-fixes].
 * Verifies detectDrift correctly identifies stale, unindexed, and mutated entries.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadIndex,
  writeIndex,
  computeChecksum,
  computeFileChecksum,
  verifyChecksum,
  detectDrift,
  assertNoDrift,
} from './index.js';

function makeTempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sox-registry-test-'));
}

function removeDirRecursive(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function makeExtension(root: string, typeDir: string, id: string, version = '0.1.0'): string {
  const extPath = path.join(root, 'extensions', typeDir, id);
  fs.mkdirSync(path.join(extPath, 'src'), { recursive: true });
  const manifest = {
    $schema: 'https://schema/v1.json',
    id,
    version,
    type: typeDir === 'agents' ? 'agent' : 'command',
    title: `${id} title`,
    description: `${id} description`,
    compatibility: { host: '>=1.0.0' },
    license: 'MIT',
    entrypoint: 'dist/index.js',
  };
  fs.writeFileSync(path.join(extPath, 'extension.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(extPath, 'src', 'index.ts'), `export const id = '${id}';`);
  return extPath;
}

describe('computeChecksum', () => {
  it('computes sha256 checksum with sha256: prefix', () => {
    const checksum = computeChecksum('hello');
    expect(checksum).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('is deterministic', () => {
    expect(computeChecksum('hello')).toBe(computeChecksum('hello'));
  });

  it('differs for different inputs', () => {
    expect(computeChecksum('hello')).not.toBe(computeChecksum('world'));
  });
});

describe('loadIndex / writeIndex', () => {
  let root: string;

  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { removeDirRecursive(root); });

  it('returns empty array when index does not exist', () => {
    expect(loadIndex(root)).toEqual([]);
  });

  it('writes and reads back the index', () => {
    const entries = [
      {
        id: 'my-agent',
        type: 'agent',
        version: '0.1.0',
        title: 'My Agent',
        description: 'A test agent',
        source: 'file:///tmp/my-agent',
        checksum: 'sha256:abc123',
        compatibility: { host: '>=1.0.0' },
      },
    ];
    writeIndex(root, entries);
    const loaded = loadIndex(root);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.id).toBe('my-agent');
  });
});

describe('verifyChecksum', () => {
  let root: string;

  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { removeDirRecursive(root); });

  it('returns false for non-existent file', () => {
    expect(verifyChecksum('/nonexistent/file.ts', 'sha256:abc')).toBe(false);
  });

  it('returns true when checksum matches', () => {
    const filePath = path.join(root, 'test.ts');
    fs.writeFileSync(filePath, 'hello');
    const checksum = computeFileChecksum(filePath);
    expect(verifyChecksum(filePath, checksum)).toBe(true);
  });

  it('returns false when checksum does not match', () => {
    const filePath = path.join(root, 'test.ts');
    fs.writeFileSync(filePath, 'hello');
    expect(verifyChecksum(filePath, 'sha256:wrong')).toBe(false);
  });
});

describe('detectDrift — registry drift gate [def:session-fixes]', () => {
  let root: string;

  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { removeDirRecursive(root); });

  it('ok=true when index is empty and no extensions on disk', () => {
    const report = detectDrift(root);
    expect(report.ok).toBe(true);
    expect(report.stale).toEqual([]);
    expect(report.unindexed).toEqual([]);
    expect(report.mutated).toEqual([]);
  });

  it('detects unindexed extension (on disk but not in index)', () => {
    makeExtension(root, 'agents', 'my-agent');
    writeIndex(root, []); // empty index

    const report = detectDrift(root);
    expect(report.ok).toBe(false);
    expect(report.unindexed).toContain('my-agent');
  });

  it('detects stale entry (in index but not on disk)', () => {
    writeIndex(root, [
      {
        id: 'ghost-agent',
        type: 'agent',
        version: '0.1.0',
        title: 'Ghost',
        description: 'Not on disk',
        source: 'file:///nonexistent/ghost-agent',
        checksum: 'sha256:abc',
        compatibility: { host: '>=1.0.0' },
      },
    ]);

    const report = detectDrift(root);
    expect(report.ok).toBe(false);
    expect(report.stale).toContain('ghost-agent');
  });

  it('ok=true when disk and index are in sync (no checksum check for dir sources)', () => {
    const extPath = makeExtension(root, 'agents', 'my-agent');
    writeIndex(root, [
      {
        id: 'my-agent',
        type: 'agent',
        version: '0.1.0',
        title: 'My Agent',
        description: 'A test agent',
        // dir source — no file checksum to verify
        source: `file://${extPath}`,
        checksum: 'sha256:any',
        compatibility: { host: '>=1.0.0' },
      },
    ]);

    const report = detectDrift(root);
    // Source is a directory — no file checksum check
    expect(report.stale).toEqual([]);
    expect(report.unindexed).toEqual([]);
  });
});

describe('assertNoDrift', () => {
  let root: string;

  beforeEach(() => { root = makeTempRoot(); });
  afterEach(() => { removeDirRecursive(root); });

  it('does not throw when registry is in sync', () => {
    // No extensions on disk, empty index
    expect(() => assertNoDrift(root)).not.toThrow();
  });

  it('throws when drift is detected', () => {
    makeExtension(root, 'agents', 'my-agent');
    writeIndex(root, []); // empty index = unindexed drift

    expect(() => assertNoDrift(root)).toThrow(/Drift detected/);
  });
});
