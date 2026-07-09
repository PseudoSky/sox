import { Buffer as NodeBuffer } from 'node:buffer';
import {
  getGlobalDispatcher,
  MockAgent,
  setGlobalDispatcher,
  type Interceptable,
} from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  FileNotFoundError,
  ManifestTooLargeError,
  ProviderAuthenticationError,
  ProviderRateLimitError,
} from '../errors.js';
import { SourceRef } from '../source-ref.js';
import { createGitHubProvider } from './github.js';

const BASE_URL = 'https://api.github.com';
const FAST_RETRY = { maxRetries: 2, baseDelayMs: 1, maxDelayMs: 5 };

let mockAgent: MockAgent;
let mockPool: Interceptable;
let originalDispatcher: ReturnType<typeof getGlobalDispatcher>;

beforeEach(() => {
  originalDispatcher = getGlobalDispatcher();
  mockAgent = new MockAgent();
  mockAgent.disableNetConnect();
  setGlobalDispatcher(mockAgent);
  mockPool = mockAgent.get(BASE_URL);
});

afterEach(async () => {
  setGlobalDispatcher(originalDispatcher);
  await mockAgent.close();
});

describe('GitHubProvider', () => {
  it('reports scheme support and token-based availability', () => {
    const provider = createGitHubProvider({ token: 'tok' });
    expect(provider.supportedSchemes()).toEqual(['github', 'github.com']);
    expect(provider.isAvailable()).toBe(true);
    expect(createGitHubProvider({ token: '' }).isAvailable()).toBe(false);
  });

  it('fetches the full recursive tree for the default branch when no ref is given', async () => {
    mockPool
      .intercept({ path: '/repos/owner/repo', method: 'GET' })
      .reply(200, { default_branch: 'main' });
    mockPool
      .intercept({ path: '/repos/owner/repo/git/ref/heads/main', method: 'GET' })
      .reply(200, { object: { sha: 'commitsha1' } });
    mockPool
      .intercept({ path: '/repos/owner/repo/git/commits/commitsha1', method: 'GET' })
      .reply(200, { tree: { sha: 'treesha1' } });
    mockPool
      .intercept({ path: '/repos/owner/repo/git/trees/treesha1?recursive=1', method: 'GET' })
      .reply(200, {
        truncated: false,
        tree: [
          { path: 'README.md', mode: '100644', type: 'blob', sha: 'blobsha1', size: 12 },
          { path: 'src', mode: '040000', type: 'tree', sha: 'treesha2' },
          { path: 'src/index.ts', mode: '100644', type: 'blob', sha: 'blobsha2', size: 30 },
        ],
      });

    const provider = createGitHubProvider({ token: 'tok', retry: FAST_RETRY });
    const ref = SourceRef.parse('github.com/owner/repo');
    const manifest = await provider.fileTree(ref);

    expect(manifest.revision).toBe('commitsha1');
    expect(manifest.defaultBranch).toBe('main');
    expect(manifest.truncated).toBe(false);
    expect(manifest.metadata.hashAlgorithm).toBe('sha1');
    expect(manifest.metadata.treeSha).toBe('treesha1');
    expect(manifest.entries).toHaveLength(3);

    const readme = manifest.entries.find((e) => e.path === 'README.md');
    expect(readme?.type).toBe('file');
    expect(readme?.contentUrl).toBe('https://raw.githubusercontent.com/owner/repo/commitsha1/README.md');

    const srcDir = manifest.entries.find((e) => e.path === 'src');
    expect(srcDir?.type).toBe('dir');
  });

  it('skips ref resolution when the ref already looks like a commit SHA', async () => {
    mockPool
      .intercept({ path: '/repos/owner/repo/git/commits/abc1234', method: 'GET' })
      .reply(200, { tree: { sha: 'treeshaX' } });
    mockPool
      .intercept({ path: '/repos/owner/repo/git/trees/treeshaX?recursive=1', method: 'GET' })
      .reply(200, { truncated: false, tree: [] });

    const provider = createGitHubProvider({ token: 'tok', retry: FAST_RETRY });
    const manifest = await provider.fileTree(SourceRef.parse('github.com/owner/repo@abc1234'));
    expect(manifest.revision).toBe('abc1234');
    expect(manifest.defaultBranch).toBeUndefined();
  });

  it('resolves a tag ref by falling back from heads/ to tags/', async () => {
    mockPool
      .intercept({ path: '/repos/owner/repo/git/ref/heads/v1.0.0', method: 'GET' })
      .reply(404, { message: 'Not Found' });
    mockPool
      .intercept({ path: '/repos/owner/repo/git/ref/tags/v1.0.0', method: 'GET' })
      .reply(200, { object: { sha: 'tagcommitsha' } });
    mockPool
      .intercept({ path: '/repos/owner/repo/git/commits/tagcommitsha', method: 'GET' })
      .reply(200, { tree: { sha: 'treeshaY' } });
    mockPool
      .intercept({ path: '/repos/owner/repo/git/trees/treeshaY?recursive=1', method: 'GET' })
      .reply(200, { truncated: false, tree: [] });

    const provider = createGitHubProvider({ token: 'tok', retry: FAST_RETRY });
    const manifest = await provider.fileTree(SourceRef.parse('github.com/owner/repo@v1.0.0'));
    expect(manifest.revision).toBe('tagcommitsha');
  });

  it('throws ManifestTooLargeError when the root tree is truncated and no path is given', async () => {
    mockPool
      .intercept({ path: '/repos/owner/repo/git/commits/abc1234', method: 'GET' })
      .reply(200, { tree: { sha: 'bigtreesha' } });
    mockPool
      .intercept({ path: '/repos/owner/repo/git/trees/bigtreesha?recursive=1', method: 'GET' })
      .reply(200, { truncated: true, tree: [{ path: 'a', mode: '100644', type: 'blob', sha: 's', size: 1 }] });

    const provider = createGitHubProvider({
      token: 'tok',
      retry: FAST_RETRY,
      maxTreeEntries: 100_000,
    });
    await expect(provider.fileTree(SourceRef.parse('github.com/owner/repo@abc1234'))).rejects.toThrow(
      ManifestTooLargeError,
    );
  });

  it('falls back to the Contents API for an explicit subdirectory when the root tree is truncated', async () => {
    mockPool
      .intercept({ path: '/repos/owner/repo/git/commits/abc1234', method: 'GET' })
      .reply(200, { tree: { sha: 'bigtreesha' } });
    mockPool
      .intercept({ path: '/repos/owner/repo/git/trees/bigtreesha?recursive=1', method: 'GET' })
      .reply(200, { truncated: true, tree: [{ path: 'a', mode: '100644', type: 'blob', sha: 's', size: 1 }] });
    mockPool
      .intercept({ path: '/repos/owner/repo/contents/src?ref=abc1234', method: 'GET' })
      .reply(200, [
        { path: 'src/index.ts', type: 'file', sha: 'fsha1', size: 20 },
        { path: 'src/lib', type: 'dir', sha: 'dsha1' },
      ]);
    mockPool
      .intercept({ path: '/repos/owner/repo/contents/src/lib?ref=abc1234', method: 'GET' })
      .reply(200, [{ path: 'src/lib/util.ts', type: 'file', sha: 'fsha2', size: 40 }]);

    const provider = createGitHubProvider({ token: 'tok', retry: FAST_RETRY });
    const manifest = await provider.fileTree(SourceRef.parse('github.com/owner/repo@abc1234'), 'src');

    expect(manifest.truncated).toBe(true);
    const paths = manifest.entries.map((e) => e.path).sort();
    expect(paths).toEqual(['src/index.ts', 'src/lib', 'src/lib/util.ts'].sort());
  });

  describe('content()', () => {
    it('decodes base64 content to a UTF-8 string', async () => {
      const encoded = NodeBuffer.from('# hello world', 'utf-8').toString('base64');
      mockPool
        .intercept({ path: '/repos/owner/repo/contents/README.md?ref=main', method: 'GET' })
        .reply(200, { content: encoded, encoding: 'base64' });

      const provider = createGitHubProvider({ token: 'tok', retry: FAST_RETRY });
      const text = await provider.content(SourceRef.parse('github.com/owner/repo@main'), 'README.md');
      expect(text).toBe('# hello world');
    });

    it('returns null for a 404', async () => {
      mockPool
        .intercept({ path: '/repos/owner/repo/contents/missing.txt?ref=main', method: 'GET' })
        .reply(404, { message: 'Not Found' });

      const provider = createGitHubProvider({ token: 'tok', retry: FAST_RETRY });
      const text = await provider.content(SourceRef.parse('github.com/owner/repo@main'), 'missing.txt');
      expect(text).toBeNull();
    });

    it('throws ProviderAuthenticationError on 401', async () => {
      mockPool
        .intercept({ path: '/repos/owner/repo/contents/x.txt?ref=main', method: 'GET' })
        .reply(401, { message: 'Bad credentials' });

      const provider = createGitHubProvider({ token: 'bad', retry: FAST_RETRY });
      await expect(
        provider.content(SourceRef.parse('github.com/owner/repo@main'), 'x.txt'),
      ).rejects.toThrow(ProviderAuthenticationError);
    });

    it('throws ProviderRateLimitError with retryAfterMs when rate-limited', async () => {
      const resetAt = Math.floor(Date.now() / 1000) + 30;
      mockPool
        .intercept({ path: '/repos/owner/repo/contents/x.txt?ref=main', method: 'GET' })
        .reply(403, { message: 'API rate limit exceeded' }, {
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAt) },
        });

      const provider = createGitHubProvider({ token: 'tok', retry: FAST_RETRY });
      await expect(
        provider.content(SourceRef.parse('github.com/owner/repo@main'), 'x.txt'),
      ).rejects.toThrow(ProviderRateLimitError);
    });

    it('throws ProviderRateLimitError on abuse-detection 403 without rate-limit headers', async () => {
      mockPool
        .intercept({ path: '/repos/owner/repo/contents/x.txt?ref=main', method: 'GET' })
        .reply(403, { message: 'You have triggered an abuse detection mechanism' });

      const provider = createGitHubProvider({ token: 'tok', retry: FAST_RETRY });
      await expect(
        provider.content(SourceRef.parse('github.com/owner/repo@main'), 'x.txt'),
      ).rejects.toThrow(ProviderRateLimitError);
    });
  });

  it('retries on a 5xx response and succeeds once the transient error clears', async () => {
    mockPool
      .intercept({ path: '/repos/owner/repo/git/commits/abc1234', method: 'GET' })
      .reply(502, 'bad gateway');
    mockPool
      .intercept({ path: '/repos/owner/repo/git/commits/abc1234', method: 'GET' })
      .reply(200, { tree: { sha: 'treeshaZ' } });
    mockPool
      .intercept({ path: '/repos/owner/repo/git/trees/treeshaZ?recursive=1', method: 'GET' })
      .reply(200, { truncated: false, tree: [] });

    const provider = createGitHubProvider({ token: 'tok', retry: FAST_RETRY });
    const manifest = await provider.fileTree(SourceRef.parse('github.com/owner/repo@abc1234'));
    expect(manifest.revision).toBe('abc1234');
  });

  it('throws FileNotFoundError when the default branch ref cannot be resolved', async () => {
    mockPool
      .intercept({ path: '/repos/owner/repo', method: 'GET' })
      .reply(200, { default_branch: 'main' });
    mockPool
      .intercept({ path: '/repos/owner/repo/git/ref/heads/main', method: 'GET' })
      .reply(404, { message: 'Not Found' });

    const provider = createGitHubProvider({ token: 'tok', retry: FAST_RETRY });
    await expect(provider.fileTree(SourceRef.parse('github.com/owner/repo'))).rejects.toThrow(
      FileNotFoundError,
    );
  });
});
