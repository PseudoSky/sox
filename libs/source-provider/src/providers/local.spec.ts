import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileNotFoundError, SourceProviderError } from '../errors.js';
import { SourceRef } from '../source-ref.js';
import { createLocalProvider } from './local.js';

let fixtureRoot: string;

async function writeFixture(relativePath: string, content: string): Promise<void> {
  const full = join(fixtureRoot, relativePath);
  await mkdir(join(full, '..'), { recursive: true });
  await writeFile(full, content, 'utf-8');
}

beforeEach(async () => {
  fixtureRoot = await mkdtemp(join(tmpdir(), 'sox-source-provider-'));
});

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe('LocalProvider', () => {
  it('enumerates a simple tree with sha256 hashes and no truncation', async () => {
    await writeFixture('README.md', '# hello');
    await writeFixture('src/index.ts', 'export const x = 1;');

    const provider = createLocalProvider();
    const ref = SourceRef.parse(fixtureRoot);
    const manifest = await provider.fileTree(ref);

    expect(manifest.truncated).toBe(false);
    expect(manifest.metadata.hashAlgorithm).toBe('sha256');
    expect(manifest.defaultBranch).toBeUndefined();

    const readme = manifest.entries.find((e) => e.path === 'README.md');
    expect(readme).toBeDefined();
    expect(readme?.type).toBe('file');
    expect(readme?.sha).toBe(createHash('sha256').update('# hello').digest('hex'));

    const srcDir = manifest.entries.find((e) => e.path === 'src');
    expect(srcDir?.type).toBe('dir');
    expect(srcDir?.size).toBe(0);

    const indexTs = manifest.entries.find((e) => e.path === 'src/index.ts');
    expect(indexTs?.type).toBe('file');
    expect(indexTs?.size).toBe(Buffer.byteLength('export const x = 1;'));
  });

  it('computes a stable revision hash across repeated scans of unchanged content', async () => {
    await writeFixture('a.txt', 'stable');
    const provider = createLocalProvider();
    const ref = SourceRef.parse(fixtureRoot);

    const first = await provider.fileTree(ref);
    const second = await provider.fileTree(ref);
    expect(second.revision).toBe(first.revision);
  });

  it('changes the revision hash when file content changes', async () => {
    await writeFixture('a.txt', 'version-1');
    const provider = createLocalProvider();
    const ref = SourceRef.parse(fixtureRoot);
    const before = await provider.fileTree(ref);

    await writeFixture('a.txt', 'version-2');
    const after = await provider.fileTree(ref);

    expect(after.revision).not.toBe(before.revision);
  });

  it('supports sha1 as the configured hash algorithm', async () => {
    await writeFixture('a.txt', 'hello');
    const provider = createLocalProvider({ hashAlgorithm: 'sha1' });
    const manifest = await provider.fileTree(SourceRef.parse(fixtureRoot));
    const entry = manifest.entries.find((e) => e.path === 'a.txt');
    expect(entry?.sha).toBe(createHash('sha1').update('hello').digest('hex'));
    expect(manifest.metadata.hashAlgorithm).toBe('sha1');
  });

  it('respects a root .gitignore file by default', async () => {
    await writeFixture('.gitignore', 'ignored.txt\n*.log\n');
    await writeFixture('kept.txt', 'kept');
    await writeFixture('ignored.txt', 'ignored');
    await writeFixture('debug.log', 'log');

    const provider = createLocalProvider();
    const manifest = await provider.fileTree(SourceRef.parse(fixtureRoot));
    const paths = manifest.entries.map((e) => e.path);

    expect(paths).toContain('kept.txt');
    expect(paths).not.toContain('ignored.txt');
    expect(paths).not.toContain('debug.log');
  });

  it('respects a nested .gitignore scoped to its own subdirectory', async () => {
    await writeFixture('src/.gitignore', 'build/\n');
    await writeFixture('src/index.ts', 'ok');
    await writeFixture('src/build/output.js', 'generated');
    await writeFixture('build/output.js', 'this one is NOT ignored (outside src/)');

    const provider = createLocalProvider();
    const manifest = await provider.fileTree(SourceRef.parse(fixtureRoot));
    const paths = manifest.entries.map((e) => e.path);

    expect(paths).toContain('src/index.ts');
    expect(paths).not.toContain('src/build/output.js');
    expect(paths).toContain('build/output.js');
  });

  it('never respects .git/ even without a .gitignore entry for it', async () => {
    await writeFixture('.git/HEAD', 'ref: refs/heads/main');
    await writeFixture('a.txt', 'x');

    const provider = createLocalProvider({ respectGitignore: false });
    const manifest = await provider.fileTree(SourceRef.parse(fixtureRoot));
    const paths = manifest.entries.map((e) => e.path);
    expect(paths.some((p) => p.startsWith('.git/'))).toBe(false);
  });

  it('respectGitignore: false disables .gitignore filtering', async () => {
    await writeFixture('.gitignore', 'ignored.txt\n');
    await writeFixture('ignored.txt', 'now included');

    const provider = createLocalProvider({ respectGitignore: false });
    const manifest = await provider.fileTree(SourceRef.parse(fixtureRoot));
    expect(manifest.entries.map((e) => e.path)).toContain('ignored.txt');
  });

  it('applies additional ignorePatterns merged with .gitignore', async () => {
    await writeFixture('keep.txt', 'x');
    await writeFixture('secret.env', 'x');

    const provider = createLocalProvider({ ignorePatterns: ['*.env'] });
    const manifest = await provider.fileTree(SourceRef.parse(fixtureRoot));
    const paths = manifest.entries.map((e) => e.path);
    expect(paths).toContain('keep.txt');
    expect(paths).not.toContain('secret.env');
  });

  it('scopes fileTree(ref, path) to a subdirectory while keeping paths relative to rootUri', async () => {
    await writeFixture('README.md', 'root');
    await writeFixture('src/index.ts', 'a');
    await writeFixture('src/lib/util.ts', 'b');

    const provider = createLocalProvider();
    const ref = SourceRef.parse(fixtureRoot);
    const manifest = await provider.fileTree(ref, 'src');

    // Scoping to 'src' scans src/'s *contents* (fast-glob's cwd is the
    // scanned directory itself, which is not re-listed as an entry of
    // itself) — 'src' is the scope, not a returned entry.
    const paths = manifest.entries.map((e) => e.path).sort();
    expect(paths).toEqual(['src/index.ts', 'src/lib', 'src/lib/util.ts'].sort());
  });

  it('throws FileNotFoundError when the root path does not exist', async () => {
    const provider = createLocalProvider();
    const ref = SourceRef.parse(join(fixtureRoot, 'does-not-exist'));
    await expect(provider.fileTree(ref)).rejects.toThrow(FileNotFoundError);
  });

  it('throws FileNotFoundError when the scoped subdirectory does not exist', async () => {
    await writeFixture('a.txt', 'x');
    const provider = createLocalProvider();
    await expect(provider.fileTree(SourceRef.parse(fixtureRoot), 'no-such-dir')).rejects.toThrow(
      FileNotFoundError,
    );
  });

  it('enforces allowedBasePath — throws for a ref outside the allowed base', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'sox-source-provider-outside-'));
    try {
      const provider = createLocalProvider({ allowedBasePath: fixtureRoot });
      await expect(provider.fileTree(SourceRef.parse(outside))).rejects.toThrow(SourceProviderError);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  describe('content()', () => {
    it('reads file content as UTF-8', async () => {
      await writeFixture('README.md', '# hello world');
      const provider = createLocalProvider();
      const text = await provider.content(SourceRef.parse(fixtureRoot), 'README.md');
      expect(text).toBe('# hello world');
    });

    it('returns null for a missing file', async () => {
      const provider = createLocalProvider();
      const text = await provider.content(SourceRef.parse(fixtureRoot), 'missing.txt');
      expect(text).toBeNull();
    });

    it('returns null when the path is a directory', async () => {
      await writeFixture('src/index.ts', 'x');
      const provider = createLocalProvider();
      const text = await provider.content(SourceRef.parse(fixtureRoot), 'src');
      expect(text).toBeNull();
    });

    it('returns null when content exceeds maxContentSize', async () => {
      await writeFixture('big.txt', 'x'.repeat(1000));
      const provider = createLocalProvider({ maxContentSize: 10 });
      const text = await provider.content(SourceRef.parse(fixtureRoot), 'big.txt');
      expect(text).toBeNull();
    });

    it('throws FileNotFoundError on a path-traversal attempt', async () => {
      await writeFixture('a.txt', 'x');
      const provider = createLocalProvider();
      await expect(
        provider.content(SourceRef.parse(fixtureRoot), '../../../../etc/passwd'),
      ).rejects.toThrow(FileNotFoundError);
    });
  });

  describe('contentStream()', () => {
    it('streams the same bytes as content()', async () => {
      await writeFixture('README.md', 'streamed content here');
      const provider = createLocalProvider();
      const ref = SourceRef.parse(fixtureRoot);

      expect(provider.contentStream).toBeDefined();
      const stream = await provider.contentStream?.(ref, 'README.md');
      expect(stream).not.toBeNull();

      const chunks: Uint8Array[] = [];
      const reader = stream!.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
      }
      expect(Buffer.concat(chunks).toString('utf-8')).toBe('streamed content here');
    });

    it('returns null for a missing file', async () => {
      const provider = createLocalProvider();
      const stream = await provider.contentStream?.(SourceRef.parse(fixtureRoot), 'missing.txt');
      expect(stream).toBeNull();
    });
  });

  describe('getRevision()', () => {
    it('returns the same revision as fileTree()', async () => {
      await writeFixture('a.txt', 'x');
      const provider = createLocalProvider();
      const ref = SourceRef.parse(fixtureRoot);
      const manifest = await provider.fileTree(ref);
      const revision = await provider.getRevision?.(ref);
      expect(revision).toBe(manifest.revision);
    });
  });

  describe('isAvailable()', () => {
    it('is true when no allowedBasePath is configured', () => {
      expect(createLocalProvider().isAvailable()).toBe(true);
    });

    it('is true when allowedBasePath exists', () => {
      expect(createLocalProvider({ allowedBasePath: fixtureRoot }).isAvailable()).toBe(true);
    });

    it('is false when allowedBasePath does not exist', () => {
      expect(
        createLocalProvider({ allowedBasePath: join(fixtureRoot, 'nope') }).isAvailable(),
      ).toBe(false);
    });
  });

  it('supportedSchemes() returns local and file', () => {
    expect(createLocalProvider().supportedSchemes()).toEqual(['local', 'file']);
  });
});
