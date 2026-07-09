import {
  getGlobalDispatcher,
  MockAgent,
  setGlobalDispatcher,
  type Interceptable,
} from 'undici';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileNotFoundError, ProviderAuthenticationError, ProviderRateLimitError } from '../errors.js';
import { SourceRef } from '../source-ref.js';
import { createBitbucketProvider } from './bitbucket.js';

const BASE_URL = 'https://api.bitbucket.org';
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

describe('BitbucketProvider', () => {
  it('reports scheme support and token-based availability', () => {
    const provider = createBitbucketProvider({ token: 'tok' });
    expect(provider.supportedSchemes()).toEqual(['bitbucket', 'bitbucket.org']);
    expect(provider.isAvailable()).toBe(true);
    expect(createBitbucketProvider({ token: '' }).isAvailable()).toBe(false);
  });

  it('walks the default branch recursively via the Source API', async () => {
    mockPool
      .intercept({ path: '/2.0/repositories/ws/repo', method: 'GET' })
      .reply(200, { mainbranch: { name: 'main' } });
    mockPool
      .intercept({ path: '/2.0/repositories/ws/repo/refs/branches/main', method: 'GET' })
      .reply(200, { target: { hash: 'commithash1' } });
    mockPool
      .intercept({ path: '/2.0/repositories/ws/repo/src/commithash1?pagelen=100', method: 'GET' })
      .reply(200, {
        values: [
          { type: 'commit_file', path: 'README.md', size: 12, commit: { hash: 'filehash1' } },
          { type: 'commit_directory', path: 'src', commit: { hash: 'dirhash1' } },
        ],
      });
    mockPool
      .intercept({ path: '/2.0/repositories/ws/repo/src/commithash1/src?pagelen=100', method: 'GET' })
      .reply(200, {
        values: [{ type: 'commit_file', path: 'src/index.ts', size: 30, commit: { hash: 'filehash2' } }],
      });

    const provider = createBitbucketProvider({ token: 'tok', retry: FAST_RETRY });
    const manifest = await provider.fileTree(SourceRef.parse('bitbucket.org/ws/repo'));

    expect(manifest.revision).toBe('commithash1');
    expect(manifest.defaultBranch).toBe('main');
    expect(manifest.truncated).toBe(false);
    expect(manifest.metadata.hashAlgorithm).toBe('sha1');

    const paths = manifest.entries.map((e) => e.path).sort();
    expect(paths).toEqual(['README.md', 'src', 'src/index.ts'].sort());

    const readme = manifest.entries.find((e) => e.path === 'README.md');
    expect(readme?.type).toBe('file');
    expect(readme?.contentUrl).toBe('https://bitbucket.org/ws/repo/raw/commithash1/README.md');

    const srcDir = manifest.entries.find((e) => e.path === 'src');
    expect(srcDir?.type).toBe('dir');
  });

  it('skips ref resolution when the ref already looks like a commit hash', async () => {
    mockPool
      .intercept({ path: '/2.0/repositories/ws/repo/src/abc1234?pagelen=100', method: 'GET' })
      .reply(200, { values: [] });

    const provider = createBitbucketProvider({ token: 'tok', retry: FAST_RETRY });
    const manifest = await provider.fileTree(SourceRef.parse('bitbucket.org/ws/repo@abc1234'));
    expect(manifest.revision).toBe('abc1234');
    expect(manifest.defaultBranch).toBeUndefined();
  });

  it('resolves a tag ref by falling back from refs/branches to refs/tags', async () => {
    mockPool
      .intercept({ path: '/2.0/repositories/ws/repo/refs/branches/v1.0.0', method: 'GET' })
      .reply(404, { error: { message: 'not found' } });
    mockPool
      .intercept({ path: '/2.0/repositories/ws/repo/refs/tags/v1.0.0', method: 'GET' })
      .reply(200, { target: { hash: 'tagcommithash' } });
    mockPool
      .intercept({ path: '/2.0/repositories/ws/repo/src/tagcommithash?pagelen=100', method: 'GET' })
      .reply(200, { values: [] });

    const provider = createBitbucketProvider({ token: 'tok', retry: FAST_RETRY });
    const manifest = await provider.fileTree(SourceRef.parse('bitbucket.org/ws/repo@v1.0.0'));
    expect(manifest.revision).toBe('tagcommithash');
  });

  it('follows the `next` pagination link within a single directory', async () => {
    mockPool
      .intercept({ path: '/2.0/repositories/ws/repo/src/abc1234?pagelen=100', method: 'GET' })
      .reply(200, {
        values: [{ type: 'commit_file', path: 'a.txt', size: 1, commit: { hash: 'h1' } }],
        next: `${BASE_URL}/2.0/repositories/ws/repo/src/abc1234?pagelen=100&page=2`,
      });
    mockPool
      .intercept({ path: '/2.0/repositories/ws/repo/src/abc1234?pagelen=100&page=2', method: 'GET' })
      .reply(200, {
        values: [{ type: 'commit_file', path: 'b.txt', size: 2, commit: { hash: 'h2' } }],
      });

    const provider = createBitbucketProvider({ token: 'tok', retry: FAST_RETRY });
    const manifest = await provider.fileTree(SourceRef.parse('bitbucket.org/ws/repo@abc1234'));
    expect(manifest.entries.map((e) => e.path).sort()).toEqual(['a.txt', 'b.txt']);
    expect(manifest.truncated).toBe(false);
  });

  it('marks the manifest truncated once maxPages is exhausted', async () => {
    mockPool
      .intercept({ path: '/2.0/repositories/ws/repo/src/abc1234?pagelen=100', method: 'GET' })
      .reply(200, {
        values: [
          { type: 'commit_directory', path: 'dir1', commit: { hash: 'd1' } },
          { type: 'commit_directory', path: 'dir2', commit: { hash: 'd2' } },
        ],
      });

    const provider = createBitbucketProvider({ token: 'tok', retry: FAST_RETRY, maxPages: 1 });
    const manifest = await provider.fileTree(SourceRef.parse('bitbucket.org/ws/repo@abc1234'));

    expect(manifest.truncated).toBe(true);
    expect(manifest.entries.map((e) => e.path).sort()).toEqual(['dir1', 'dir2']);
  });

  describe('content()', () => {
    it('returns the raw file body as-is (no base64 wrapping)', async () => {
      mockPool
        .intercept({ path: '/2.0/repositories/ws/repo/src/main/README.md', method: 'GET' })
        .reply(200, '# hello world');

      const provider = createBitbucketProvider({ token: 'tok', retry: FAST_RETRY });
      const text = await provider.content(SourceRef.parse('bitbucket.org/ws/repo@main'), 'README.md');
      expect(text).toBe('# hello world');
    });

    it('returns null for a 404', async () => {
      mockPool
        .intercept({ path: '/2.0/repositories/ws/repo/src/main/missing.txt', method: 'GET' })
        .reply(404, { error: { message: 'not found' } });

      const provider = createBitbucketProvider({ token: 'tok', retry: FAST_RETRY });
      const text = await provider.content(SourceRef.parse('bitbucket.org/ws/repo@main'), 'missing.txt');
      expect(text).toBeNull();
    });

    it('throws ProviderAuthenticationError on 401/403', async () => {
      mockPool
        .intercept({ path: '/2.0/repositories/ws/repo/src/main/x.txt', method: 'GET' })
        .reply(401, { error: { message: 'unauthorized' } });

      const provider = createBitbucketProvider({ token: 'bad', retry: FAST_RETRY });
      await expect(
        provider.content(SourceRef.parse('bitbucket.org/ws/repo@main'), 'x.txt'),
      ).rejects.toThrow(ProviderAuthenticationError);
    });

    it('throws ProviderRateLimitError on 429 honoring Retry-After', async () => {
      mockPool
        .intercept({ path: '/2.0/repositories/ws/repo/src/main/x.txt', method: 'GET' })
        .reply(429, { error: { message: 'rate limited' } }, { headers: { 'retry-after': '42' } });

      const provider = createBitbucketProvider({ token: 'tok', retry: FAST_RETRY });
      await expect(
        provider.content(SourceRef.parse('bitbucket.org/ws/repo@main'), 'x.txt'),
      ).rejects.toThrow(ProviderRateLimitError);
    });
  });

  it('throws FileNotFoundError when the default branch cannot be resolved', async () => {
    mockPool
      .intercept({ path: '/2.0/repositories/ws/repo', method: 'GET' })
      .reply(200, { mainbranch: { name: 'main' } });
    mockPool
      .intercept({ path: '/2.0/repositories/ws/repo/refs/branches/main', method: 'GET' })
      .reply(404, { error: { message: 'not found' } });

    const provider = createBitbucketProvider({ token: 'tok', retry: FAST_RETRY });
    await expect(provider.fileTree(SourceRef.parse('bitbucket.org/ws/repo'))).rejects.toThrow(
      FileNotFoundError,
    );
  });

  it('retries on a 5xx response and succeeds once the transient error clears', async () => {
    mockPool
      .intercept({ path: '/2.0/repositories/ws/repo/src/abc1234?pagelen=100', method: 'GET' })
      .reply(503, 'service unavailable');
    mockPool
      .intercept({ path: '/2.0/repositories/ws/repo/src/abc1234?pagelen=100', method: 'GET' })
      .reply(200, { values: [] });

    const provider = createBitbucketProvider({ token: 'tok', retry: FAST_RETRY });
    const manifest = await provider.fileTree(SourceRef.parse('bitbucket.org/ws/repo@abc1234'));
    expect(manifest.revision).toBe('abc1234');
  });
});
