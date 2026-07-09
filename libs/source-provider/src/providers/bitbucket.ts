// @adhd/sox-source-provider — Bitbucket provider
// Authoritative spec: sox-ecosystem/docs/plan/source-provider/SPEC.md §6
//
// Bitbucket has no single recursive-tree endpoint (unlike GitHub's Git Trees
// API) — the provider walks the Source API's per-directory listings
// depth-first (SPEC D-10), following the real Bitbucket v2.0 API's
// `values`/`next` pagination shape (SPEC §14 explicitly leaves "follow
// `next` link vs. compute from page number" to the implementation).

import {
  FileNotFoundError,
  ProviderAuthenticationError,
  ProviderRateLimitError,
  ProviderTransientError,
  SourceProviderError,
} from '../errors.js';
import type { SourceRef } from '../source-ref.js';
import type { FileEntry, Manifest, RetryConfig, SourceProvider } from '../types.js';
import { headerString, httpRequestWithRetry, type HttpResult } from '../util/http.js';
import { encodeContentPath } from '../util/path.js';

export interface BitbucketProviderConfig {
  /** Bitbucket App Password or OAuth token. Needs repository read access. */
  token: string;
  /** Base URL for API calls. Defaults to "https://api.bitbucket.org/2.0". Override for Data Center/Server. */
  baseUrl?: string;
  /** Maximum entries per page in file tree responses. Default: 100 (Bitbucket's API hard limit). */
  maxEntriesPerPage?: number;
  /** Maximum pages to traverse before truncation. Default: 100 (10,000 entries). */
  maxPages?: number;
  /** Retry configuration for transient API errors. */
  retry?: RetryConfig;
}

interface BbSrcItem {
  type: 'commit_file' | 'commit_directory';
  path: string;
  size?: number;
  commit?: { hash: string };
}

interface BbSrcPage {
  values: BbSrcItem[];
  next?: string;
}

function parseWorkspaceRepo(path: string): { workspace: string; repo: string } {
  const [workspace, repo] = path.split('/');
  if (!workspace || !repo) throw new SourceProviderError(`invalid Bitbucket path: ${path}`);
  return { workspace, repo };
}

const COMMIT_HASH_RE = /^[0-9a-f]{7,40}$/i;

export class BitbucketProvider implements SourceProvider {
  private readonly baseUrl: string;

  constructor(private readonly config: BitbucketProviderConfig) {
    this.baseUrl = (config.baseUrl ?? 'https://api.bitbucket.org/2.0').replace(/\/+$/, '');
  }

  supportedSchemes(): string[] {
    return ['bitbucket', 'bitbucket.org'];
  }

  isAvailable(): boolean {
    return typeof this.config.token === 'string' && this.config.token.length > 0;
  }

  async fileTree(ref: SourceRef, path?: string): Promise<Manifest> {
    const { workspace, repo } = parseWorkspaceRepo(ref.path);
    const { hash: commitHash, mainBranch } = await this.resolveCommitHash(workspace, repo, ref.ref);
    const { entries, truncated } = await this.walkDir(workspace, repo, commitHash, path ?? '');

    return {
      revision: commitHash,
      ...(mainBranch !== undefined ? { defaultBranch: mainBranch } : {}),
      rootUri: ref,
      truncated,
      entries,
      metadata: {
        hashAlgorithm: 'sha1',
        entryCount: entries.length,
      },
      fetchedAt: new Date().toISOString(),
    };
  }

  async content(ref: SourceRef, path: string): Promise<string | null> {
    const { workspace, repo } = parseWorkspaceRepo(ref.path);
    // The Source endpoint accepts a branch, tag, or commit hash directly as
    // the revision segment (SPEC §6) — no commit-hash pre-resolution needed
    // unless the ref is unset (default branch), in which case we resolve the
    // repo's main branch name and use that directly as the revision.
    let revision = ref.ref;
    if (revision === undefined) {
      const repoInfo = await this.getJson<{ mainbranch: { name: string } }>(
        `/repositories/${workspace}/${repo}`,
      );
      revision = repoInfo.mainbranch.name;
    }
    const res = await this.requestRaw(
      `/repositories/${workspace}/${repo}/src/${revision}/${encodeContentPath(path)}`,
    );
    if (res.statusCode === 404) return null;
    if (res.statusCode >= 400) {
      throw new ProviderTransientError(`Bitbucket API error ${res.statusCode}: ${res.text}`, 'bitbucket');
    }
    // Bitbucket's Source endpoint returns the raw file body directly (not
    // base64-wrapped JSON) for single-file GETs. Binary detection is a
    // documented spec gap (SPEC §14 #2) — best-effort UTF-8 decode.
    return res.text;
  }

  // ── internals ─────────────────────────────────────────────────────────

  private async resolveCommitHash(
    workspace: string,
    repo: string,
    ref: string | undefined,
  ): Promise<{ hash: string; mainBranch?: string }> {
    if (ref === undefined) {
      const repoInfo = await this.getJson<{ mainbranch: { name: string } }>(
        `/repositories/${workspace}/${repo}`,
      );
      const mainBranch = repoInfo.mainbranch.name;
      const hash = await this.getBranchHash(workspace, repo, mainBranch);
      if (hash === null) throw new FileNotFoundError(`${workspace}/${repo}`, mainBranch);
      return { hash, mainBranch };
    }

    if (COMMIT_HASH_RE.test(ref)) {
      return { hash: ref };
    }

    let hash = await this.getBranchHash(workspace, repo, ref);
    if (hash === null) hash = await this.getTagHash(workspace, repo, ref);
    if (hash === null) throw new FileNotFoundError(`${workspace}/${repo}`, ref);
    return { hash };
  }

  private async getBranchHash(workspace: string, repo: string, branch: string): Promise<string | null> {
    const json = await this.getJsonOrNull<{ target: { hash: string } }>(
      `/repositories/${workspace}/${repo}/refs/branches/${encodeURIComponent(branch)}`,
    );
    return json ? json.target.hash : null;
  }

  private async getTagHash(workspace: string, repo: string, tag: string): Promise<string | null> {
    const json = await this.getJsonOrNull<{ target: { hash: string } }>(
      `/repositories/${workspace}/${repo}/refs/tags/${encodeURIComponent(tag)}`,
    );
    return json ? json.target.hash : null;
  }

  private buildSrcUrl(workspace: string, repo: string, commitHash: string, dirPath: string): string {
    const pagelen = this.config.maxEntriesPerPage ?? 100;
    const suffix = dirPath ? `/${encodeContentPath(dirPath)}` : '';
    return `${this.baseUrl}/repositories/${workspace}/${repo}/src/${commitHash}${suffix}?pagelen=${pagelen}`;
  }

  /** Depth-first directory walk (SPEC D-10) with a global page budget (SPEC D-12). */
  private async walkDir(
    workspace: string,
    repo: string,
    commitHash: string,
    rootPath: string,
  ): Promise<{ entries: FileEntry[]; truncated: boolean }> {
    const entries: FileEntry[] = [];
    const stack: string[] = [rootPath];
    const maxPages = this.config.maxPages ?? 100;
    let pagesUsed = 0;
    let truncated = false;

    outer: while (stack.length > 0) {
      const dirPath = stack.pop() as string;
      let url: string | undefined = this.buildSrcUrl(workspace, repo, commitHash, dirPath);

      while (url) {
        if (pagesUsed >= maxPages) {
          truncated = true;
          break outer;
        }
        pagesUsed += 1;
        const page: BbSrcPage = await this.getJson<BbSrcPage>(url);

        for (const item of page.values) {
          if (item.type === 'commit_directory') {
            entries.push({ path: item.path, type: 'dir', size: 0, sha: item.commit?.hash ?? '' });
            stack.push(item.path);
          } else {
            entries.push({
              path: item.path,
              type: 'file',
              size: item.size ?? 0,
              sha: item.commit?.hash ?? '',
              contentUrl: `https://bitbucket.org/${workspace}/${repo}/raw/${commitHash}/${item.path}`,
            });
          }
        }
        url = page.next;
      }
    }

    return { entries, truncated };
  }

  private async requestRaw(path: string): Promise<HttpResult> {
    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.config.token}`,
      Accept: 'application/json',
    };
    const res = await httpRequestWithRetry(url, { method: 'GET', headers }, this.config.retry);
    this.checkErrors(res);
    return res;
  }

  private checkErrors(res: HttpResult): void {
    if (res.statusCode === 401 || res.statusCode === 403) {
      throw new ProviderAuthenticationError(
        'Bitbucket API authentication failed — check token/permissions',
        'bitbucket',
      );
    }
    if (res.statusCode === 429) {
      const retryAfterHeader = headerString(res.headers, 'retry-after');
      const retryAfterMs = retryAfterHeader ? Number(retryAfterHeader) * 1000 : 60_000;
      throw new ProviderRateLimitError('Bitbucket API rate limit exceeded', 'bitbucket', retryAfterMs);
    }
  }

  private async getJson<T>(path: string): Promise<T> {
    const res = await this.requestRaw(path);
    if (res.statusCode === 404) throw new FileNotFoundError(path, '');
    if (res.statusCode >= 400) {
      throw new ProviderTransientError(`Bitbucket API error ${res.statusCode}: ${res.text}`, 'bitbucket');
    }
    return JSON.parse(res.text) as T;
  }

  private async getJsonOrNull<T>(path: string): Promise<T | null> {
    const res = await this.requestRaw(path);
    if (res.statusCode === 404) return null;
    if (res.statusCode >= 400) {
      throw new ProviderTransientError(`Bitbucket API error ${res.statusCode}: ${res.text}`, 'bitbucket');
    }
    return JSON.parse(res.text) as T;
  }
}

export function createBitbucketProvider(config: BitbucketProviderConfig): SourceProvider {
  return new BitbucketProvider(config);
}
