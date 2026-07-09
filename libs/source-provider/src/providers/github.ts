// @adhd/sox-source-provider — GitHub provider
// Authoritative spec: sox-ecosystem/docs/plan/source-provider/SPEC.md §5
//
// HTTP transport: `undici` (see util/http.ts doc comment for rationale —
// this is an explicitly sanctioned deviation from the SPEC Dispatch note's
// "@octokit/rest" suggestion; SPEC §14 states HTTP client choice is an
// implementation detail, and undici is named there as an acceptable choice).

import {
  FileNotFoundError,
  ManifestTooLargeError,
  ProviderAuthenticationError,
  ProviderRateLimitError,
  ProviderTransientError,
  SourceProviderError,
} from '../errors.js';
import type { SourceRef } from '../source-ref.js';
import type { FileEntry, FileType, Manifest, RetryConfig, SourceProvider } from '../types.js';
import { headerString, httpRequestWithRetry, type HttpResult } from '../util/http.js';
import { encodeContentPath, filterByPathPrefix } from '../util/path.js';

export interface GitHubProviderConfig {
  /** GitHub Personal Access Token (classic or fine-grained). Needs Contents permission. */
  token: string;
  /** Base URL for API calls. Defaults to "https://api.github.com". Override for GHES. */
  baseUrl?: string;
  /** Maximum entries in a single fileTree response before truncation. Default: 100_000. */
  maxTreeEntries?: number;
  /** User-Agent header value. Defaults to "sox-source-provider/1.0". */
  userAgent?: string;
  /** Retry configuration for transient API errors (rate limits, 5xx). */
  retry?: RetryConfig;
}

interface GhTreeItem {
  path: string;
  mode: string;
  type: 'blob' | 'tree' | 'commit';
  sha: string;
  size?: number;
}

interface GhContentItem {
  path: string;
  type: 'file' | 'dir' | 'symlink' | 'submodule';
  sha: string;
  size?: number;
}

function parseOwnerRepo(path: string): { owner: string; repo: string } {
  const [owner, repo] = path.split('/');
  if (!owner || !repo) throw new SourceProviderError(`invalid GitHub path: ${path}`);
  return { owner, repo };
}

const COMMIT_SHA_RE = /^[0-9a-f]{7,40}$/i;

export class GitHubProvider implements SourceProvider {
  private readonly baseUrl: string;

  constructor(private readonly config: GitHubProviderConfig) {
    this.baseUrl = (config.baseUrl ?? 'https://api.github.com').replace(/\/+$/, '');
  }

  supportedSchemes(): string[] {
    return ['github', 'github.com'];
  }

  isAvailable(): boolean {
    return typeof this.config.token === 'string' && this.config.token.length > 0;
  }

  async fileTree(ref: SourceRef, path?: string): Promise<Manifest> {
    const { owner, repo } = parseOwnerRepo(ref.path);
    const { sha: commitSha, defaultBranch } = await this.resolveCommitSha(owner, repo, ref.ref);
    const treeSha = await this.resolveTreeSha(owner, repo, commitSha);
    const { tree, truncated: rawTruncated } = await this.getTreeData(owner, repo, treeSha);

    if (!rawTruncated) {
      let entries = tree.map((item) => this.mapTreeEntry(owner, repo, commitSha, item));
      if (path) entries = filterByPathPrefix(entries, path);
      return this.buildManifest(ref, commitSha, treeSha, entries, false, tree.length, defaultBranch);
    }

    if (!path) {
      throw new ManifestTooLargeError(
        ref.toString(),
        this.config.maxTreeEntries ?? 100_000,
        tree.length,
      );
    }

    // Explicit subdirectory scope — fall back to the Contents API (not
    // subject to the Git Trees API's 100K recursive-entry ceiling).
    const walked = await this.walkContentsApi(owner, repo, commitSha, path);
    return this.buildManifest(ref, commitSha, treeSha, walked, true, walked.length, defaultBranch);
  }

  async content(ref: SourceRef, path: string): Promise<string | null> {
    const { owner, repo } = parseOwnerRepo(ref.path);
    const refName = ref.ref ?? 'HEAD';
    const res = await this.requestRaw(
      `/repos/${owner}/${repo}/contents/${encodeContentPath(path)}?ref=${encodeURIComponent(refName)}`,
    );
    if (res.statusCode === 404) return null;
    if (res.statusCode >= 400) {
      throw new ProviderTransientError(`GitHub API error ${res.statusCode}: ${res.text}`, 'github');
    }
    const json = JSON.parse(res.text) as { content?: string; encoding?: string };
    if (json.content === undefined) return null;
    const encoding = (json.encoding ?? 'base64') as BufferEncoding;
    const buf = Buffer.from(json.content.replace(/\n/g, ''), encoding);
    return buf.toString('utf-8');
  }

  // ── internals ─────────────────────────────────────────────────────────

  private buildManifest(
    ref: SourceRef,
    commitSha: string,
    treeSha: string,
    entries: FileEntry[],
    truncated: boolean,
    entryCount: number,
    defaultBranch: string | undefined,
  ): Manifest {
    return {
      revision: commitSha,
      ...(defaultBranch !== undefined ? { defaultBranch } : {}),
      rootUri: ref,
      truncated,
      entries,
      metadata: {
        hashAlgorithm: 'sha1',
        entryCount,
        treeSha,
      },
      fetchedAt: new Date().toISOString(),
    };
  }

  private mapTreeEntry(owner: string, repo: string, ref: string, item: GhTreeItem): FileEntry {
    const type: FileType = item.type === 'tree' ? 'dir' : 'file';
    const entry: FileEntry = {
      path: item.path,
      type,
      size: item.size ?? 0,
      sha: item.sha,
      contentUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${item.path}`,
    };
    if (item.mode) entry.mode = item.mode;
    return entry;
  }

  private async resolveCommitSha(
    owner: string,
    repo: string,
    ref: string | undefined,
  ): Promise<{ sha: string; defaultBranch?: string }> {
    if (ref === undefined) {
      const repoInfo = await this.getJson<{ default_branch: string }>(`/repos/${owner}/${repo}`);
      const defaultBranch = repoInfo.default_branch;
      const sha = await this.getRefSha(owner, repo, `heads/${defaultBranch}`);
      if (sha === null) throw new FileNotFoundError(`${owner}/${repo}`, defaultBranch);
      return { sha, defaultBranch };
    }

    if (COMMIT_SHA_RE.test(ref)) {
      return { sha: ref };
    }

    const refPath = ref.startsWith('refs/') ? ref.slice('refs/'.length) : `heads/${ref}`;
    let sha = await this.getRefSha(owner, repo, refPath);
    if (sha === null && !ref.startsWith('refs/')) {
      sha = await this.getRefSha(owner, repo, `tags/${ref}`);
    }
    if (sha === null) throw new FileNotFoundError(`${owner}/${repo}`, ref);
    return { sha };
  }

  private async resolveTreeSha(owner: string, repo: string, commitSha: string): Promise<string> {
    const json = await this.getJson<{ tree: { sha: string } }>(
      `/repos/${owner}/${repo}/git/commits/${commitSha}`,
    );
    return json.tree.sha;
  }

  private async getTreeData(
    owner: string,
    repo: string,
    treeSha: string,
  ): Promise<{ tree: GhTreeItem[]; truncated: boolean }> {
    return this.getJson<{ tree: GhTreeItem[]; truncated: boolean }>(
      `/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`,
    );
  }

  private async getRefSha(owner: string, repo: string, refPath: string): Promise<string | null> {
    const json = await this.getJsonOrNull<{ object: { sha: string } }>(
      `/repos/${owner}/${repo}/git/ref/${refPath}`,
    );
    return json ? json.object.sha : null;
  }

  private async walkContentsApi(
    owner: string,
    repo: string,
    ref: string,
    rootPath: string,
  ): Promise<FileEntry[]> {
    const results: FileEntry[] = [];
    const stack: string[] = [rootPath];

    // Depth-first (SPEC D-10): minimizes memory for wide repos and reaches
    // leaf files fastest, the common case for content() calls that follow.
    while (stack.length > 0) {
      const dirPath = stack.pop() as string;
      const items = await this.getJson<GhContentItem[]>(
        `/repos/${owner}/${repo}/contents/${encodeContentPath(dirPath)}?ref=${encodeURIComponent(ref)}`,
      );
      for (const item of items) {
        if (item.type === 'dir') {
          results.push({ path: item.path, type: 'dir', size: 0, sha: item.sha });
          stack.push(item.path);
        } else {
          results.push({
            path: item.path,
            type: item.type === 'symlink' ? 'symlink' : 'file',
            size: item.size ?? 0,
            sha: item.sha,
            contentUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${item.path}`,
          });
        }
      }
    }
    return results;
  }

  private async requestRaw(path: string): Promise<HttpResult> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': this.config.userAgent ?? 'sox-source-provider/1.0',
    };
    const res = await httpRequestWithRetry(url, { method: 'GET', headers }, this.config.retry);
    this.checkRateLimitAndAuth(res);
    return res;
  }

  private checkRateLimitAndAuth(res: HttpResult): void {
    if (res.statusCode === 401) {
      throw new ProviderAuthenticationError('GitHub API authentication failed — check token', 'github');
    }
    if (res.statusCode === 403) {
      const remaining = headerString(res.headers, 'x-ratelimit-remaining');
      if (remaining === '0') {
        const resetHeader = headerString(res.headers, 'x-ratelimit-reset');
        const resetAtMs = resetHeader ? Number(resetHeader) * 1000 : undefined;
        const retryAfterMs = resetAtMs ? Math.max(0, resetAtMs - Date.now()) + 1000 : 60_000;
        throw new ProviderRateLimitError(
          'GitHub API rate limit exceeded',
          'github',
          retryAfterMs,
          resetAtMs ? new Date(resetAtMs).toISOString() : undefined,
        );
      }
      // 403 with no rate-limit headers → abuse detection.
      throw new ProviderRateLimitError('GitHub API abuse detection triggered', 'github', 60_000);
    }
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.requestRaw(path);
    if (res.statusCode === 404) throw new FileNotFoundError(path, '');
    if (res.statusCode >= 400) {
      throw new ProviderTransientError(`GitHub API error ${res.statusCode}: ${res.text}`, 'github');
    }
    return JSON.parse(res.text) as T;
  }

  private async getJsonOrNull<T>(path: string): Promise<T | null> {
    const res = await this.requestRaw(path);
    if (res.statusCode === 404) return null;
    if (res.statusCode >= 400) {
      throw new ProviderTransientError(`GitHub API error ${res.statusCode}: ${res.text}`, 'github');
    }
    return JSON.parse(res.text) as T;
  }
}

export function createGitHubProvider(config: GitHubProviderConfig): SourceProvider {
  return new GitHubProvider(config);
}
