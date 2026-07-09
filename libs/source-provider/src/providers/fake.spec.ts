import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { FileNotFoundError, ProviderAuthenticationError, ProviderRateLimitError } from '../errors.js';
import { SourceRef } from '../source-ref.js';
import { createFakeProvider } from './fake.js';

function gitBlobSha1(content: string): string {
  const buf = Buffer.from(content, 'utf-8');
  const header = Buffer.from(`blob ${buf.length}\0`, 'utf-8');
  return createHash('sha1').update(Buffer.concat([header, buf])).digest('hex');
}

describe('createFakeProvider', () => {
  const ref = SourceRef.parse('github.com/owner/repo@main');

  it('serves a pre-configured tree', async () => {
    const provider = createFakeProvider({
      trees: {
        'github.com/owner/repo@main': [
          { path: 'README.md', content: '# My Project' },
          { path: 'package.json', content: JSON.stringify({ name: 'test' }) },
          { path: 'src/index.ts', content: 'export const x = 42' },
        ],
      },
    });

    const manifest = await provider.fileTree(ref);
    expect(manifest.entries).toHaveLength(3);
    expect(manifest.entries[0]?.path).toBe('README.md');
    expect(manifest.truncated).toBe(false);
    expect(manifest.rootUri).toBe(ref);
  });

  it('serves content for a known path', async () => {
    const provider = createFakeProvider({
      trees: {
        'github.com/owner/repo@main': [{ path: 'README.md', content: '# My Project' }],
      },
    });

    const readme = await provider.content(ref, 'README.md');
    expect(readme).toBe('# My Project');
  });

  it('scopes fileTree(ref, path) to entries under the given subdirectory', async () => {
    const provider = createFakeProvider({
      trees: {
        'github.com/owner/repo@main': [
          { path: 'README.md', content: 'root' },
          { path: 'src/index.ts', content: 'a' },
          { path: 'src/lib/util.ts', content: 'b' },
          { path: 'docs/guide.md', content: 'c' },
        ],
      },
    });

    const manifest = await provider.fileTree(ref, 'src');
    const paths = manifest.entries.map((e) => e.path).sort();
    expect(paths).toEqual(['src/index.ts', 'src/lib/util.ts']);
  });

  it('throws FileNotFoundError for an unconfigured tree ref', async () => {
    const provider = createFakeProvider({ trees: {} });
    await expect(provider.fileTree(ref)).rejects.toThrow(FileNotFoundError);
  });

  it('throws FileNotFoundError for content on a path not in the tree by default', async () => {
    const provider = createFakeProvider({
      trees: { 'github.com/owner/repo@main': [{ path: 'README.md', content: 'x' }] },
    });
    await expect(provider.content(ref, 'missing.txt')).rejects.toThrow(FileNotFoundError);
  });

  it('returns null for a missing path when allowMissingFiles is true', async () => {
    const provider = createFakeProvider({
      trees: { 'github.com/owner/repo@main': [{ path: 'README.md', content: 'x' }] },
      allowMissingFiles: true,
    });
    await expect(provider.content(ref, 'missing.txt')).resolves.toBeNull();
  });

  describe('SHA auto-computation', () => {
    it('computes git-blob SHA-1 for github.com trees when sha is omitted', async () => {
      const provider = createFakeProvider({
        trees: { 'github.com/owner/repo@main': [{ path: 'README.md', content: 'hello world' }] },
      });
      const manifest = await provider.fileTree(ref);
      expect(manifest.entries[0]?.sha).toBe(gitBlobSha1('hello world'));
      expect(manifest.metadata.hashAlgorithm).toBe('sha1');
    });

    it('computes SHA-256 for local trees when sha is omitted', async () => {
      const localRef = SourceRef.parse('/abs/path');
      const provider = createFakeProvider({
        trees: { 'local:/abs/path': [{ path: 'a.txt', content: 'hello world' }] },
      });
      const manifest = await provider.fileTree(localRef);
      expect(manifest.entries[0]?.sha).toBe(
        createHash('sha256').update('hello world', 'utf-8').digest('hex'),
      );
      expect(manifest.metadata.hashAlgorithm).toBe('sha256');
    });

    it('honors an explicitly provided sha instead of computing one', async () => {
      const provider = createFakeProvider({
        trees: {
          'github.com/owner/repo@main': [{ path: 'README.md', content: 'hello', sha: 'deadbeef' }],
        },
      });
      const manifest = await provider.fileTree(ref);
      expect(manifest.entries[0]?.sha).toBe('deadbeef');
    });

    it('produces deterministic SHAs across repeated construction', async () => {
      const build = () =>
        createFakeProvider({
          trees: { 'github.com/owner/repo@main': [{ path: 'README.md', content: 'stable content' }] },
        });
      const m1 = await build().fileTree(ref);
      const m2 = await build().fileTree(ref);
      expect(m1.entries[0]?.sha).toBe(m2.entries[0]?.sha);
      expect(m1.revision).toBe(m2.revision);
    });
  });

  it('simulates truncation once entries exceed truncateAfter', async () => {
    const provider = createFakeProvider({
      trees: {
        'github.com/owner/repo@main': [
          { path: 'a.txt', content: '1' },
          { path: 'b.txt', content: '2' },
          { path: 'c.txt', content: '3' },
        ],
      },
      truncateAfter: 2,
    });
    const manifest = await provider.fileTree(ref);
    expect(manifest.truncated).toBe(true);
    expect(manifest.entries).toHaveLength(2);
    expect(manifest.metadata.entryCount).toBe(3);
  });

  it('does not truncate when entries.length <= truncateAfter', async () => {
    const provider = createFakeProvider({
      trees: { 'github.com/owner/repo@main': [{ path: 'a.txt', content: '1' }] },
      truncateAfter: 5,
    });
    const manifest = await provider.fileTree(ref);
    expect(manifest.truncated).toBe(false);
  });

  describe('simulateErrors', () => {
    it('throws the configured error for fileTree after afterCalls, then recovers', async () => {
      const provider = createFakeProvider({
        trees: { 'github.com/owner/repo@main': [{ path: 'a.txt', content: '1' }] },
        simulateErrors: {
          fileTree: { errorClass: ProviderRateLimitError as never, afterCalls: 1, maxThrows: 2 },
        },
      });

      await expect(provider.fileTree(ref)).resolves.toBeDefined(); // call 1 — succeeds
      await expect(provider.fileTree(ref)).rejects.toThrow(ProviderRateLimitError); // call 2 — throws
      await expect(provider.fileTree(ref)).rejects.toThrow(ProviderRateLimitError); // call 3 — throws
      await expect(provider.fileTree(ref)).resolves.toBeDefined(); // call 4 — recovered
    });

    it('simulates content errors independently of fileTree errors', async () => {
      const provider = createFakeProvider({
        trees: { 'github.com/owner/repo@main': [{ path: 'README.md', content: 'hi' }] },
        simulateErrors: {
          content: { errorClass: ProviderAuthenticationError as never, afterCalls: 0, maxThrows: 1 },
        },
      });

      await expect(provider.content(ref, 'README.md')).rejects.toThrow(ProviderAuthenticationError);
      await expect(provider.content(ref, 'README.md')).resolves.toBe('hi');
    });
  });

  it('isAvailable() is always true', () => {
    const provider = createFakeProvider({ trees: {} });
    expect(provider.isAvailable()).toBe(true);
  });

  it('supportedSchemes() covers all three provider families', () => {
    const provider = createFakeProvider({ trees: {} });
    const schemes = provider.supportedSchemes();
    expect(schemes).toEqual(expect.arrayContaining(['github.com', 'bitbucket.org', 'local']));
  });

  it('contentStream() streams the same bytes as content()', async () => {
    const provider = createFakeProvider({
      trees: { 'github.com/owner/repo@main': [{ path: 'README.md', content: 'streamed content' }] },
    });
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
    const text = Buffer.concat(chunks).toString('utf-8');
    expect(text).toBe('streamed content');
  });

  it('getRevision() returns the tree revision without requiring fileTree() first', async () => {
    const provider = createFakeProvider({
      trees: { 'github.com/owner/repo@main': [{ path: 'a.txt', content: '1' }] },
    });
    const revision = await provider.getRevision?.(ref);
    const manifest = await provider.fileTree(ref);
    expect(revision).toBe(manifest.revision);
  });
});
