// @adhd/sox-source-provider — core types
// Authoritative spec: sox-ecosystem/docs/plan/source-provider/SPEC.md §2, §3, §4

import type { SourceRef } from './source-ref.js';

/** Kind of filesystem entry. */
export type FileType = 'file' | 'dir' | 'symlink';

/**
 * A single entry in a {@link Manifest}. `path` is always relative to
 * `Manifest.rootUri` (POSIX separators), never to any subdirectory scope
 * that was passed to `fileTree(ref, path)`.
 */
export interface FileEntry {
  /** Relative path from the tree root, POSIX separators, e.g. "src/index.ts". */
  path: string;
  type: FileType;
  /** Bytes. 0 for directories. */
  size: number;
  /**
   * Content hash. Git SHA-1 for SCM providers (GitHub/Bitbucket); SHA-256 hex
   * for the local filesystem provider. See `Manifest.metadata.hashAlgorithm`.
   */
  sha: string;
  /** Optional direct URL to fetch raw content. Present for SCM providers. */
  contentUrl?: string;
  /** POSIX file mode string (e.g. "100644", "100755"). */
  mode?: string;
  /** Inferred language (extension-based). Populated only if the provider computes it. */
  language?: string;
  /** ISO timestamp. Present for local filesystem; absent for SCM providers. */
  lastModified?: string;
}

/** Provider-specific metadata attached to a {@link Manifest}. */
export interface ManifestMetadata {
  /** Which algorithm `FileEntry.sha` uses. */
  hashAlgorithm: 'sha1' | 'sha256';
  /**
   * Total entries in the tree (may exceed `entries.length` when truncated).
   * When not truncated, `entryCount === entries.length`.
   */
  entryCount: number;
  /** Sum of all file sizes in bytes, when the provider can compute it efficiently. */
  totalSize?: number;
  /**
   * Root tree SHA. Present for the GitHub provider. Enables efficient
   * re-fetch: if `treeSha` hasn't changed, the consumer can skip content re-read.
   */
  treeSha?: string;
}

/** Result of `SourceProvider.fileTree()` — a flat, provider-agnostic file tree snapshot. */
export interface Manifest {
  /**
   * Provider-specific revision identifier: commit SHA (SCM) or filesystem
   * snapshot hash (local). SHA-256 hex for local; git SHA-1 for SCM providers.
   */
  revision: string;
  /** Present for SCM providers; absent for local. */
  defaultBranch?: string;
  /** The source ref this manifest was fetched for. */
  rootUri: SourceRef;
  /**
   * `true` when the provider stopped enumerating due to size limits.
   * Consumer MUST NOT treat the entry list as complete when `truncated === true`.
   */
  truncated: boolean;
  /** Flat array; no nested structure. All entries have `path` relative to `rootUri`. */
  entries: FileEntry[];
  metadata: ManifestMetadata;
  /** ISO timestamp of when this manifest was fetched. */
  fetchedAt: string;
}

/** Retry/backoff configuration shared by the GitHub and Bitbucket providers. */
export interface RetryConfig {
  /** Default: 3 */
  maxRetries?: number;
  /** Default: 1000 (exponential backoff) */
  baseDelayMs?: number;
  /** Default: 60_000 */
  maxDelayMs?: number;
}

/**
 * Primary abstraction — implemented by every concrete provider (GitHub,
 * Bitbucket, local filesystem, fake). Consumers obtain an instance from a
 * {@link ProviderRegistry} and never `instanceof` a concrete class.
 */
export interface SourceProvider {
  /**
   * Which URL schemes this provider handles.
   * GitHub provider → ['github', 'github.com']
   * Bitbucket provider → ['bitbucket', 'bitbucket.org']
   * Local provider → ['local', 'file']
   */
  supportedSchemes(): string[];

  /**
   * Recursive file tree for a given reference. When `path` is provided, the
   * tree is scoped to that subdirectory (and its descendants); `entries[].path`
   * is still relative to `rootUri`, not to `path`.
   *
   * THROWS ProviderAuthenticationError, ProviderRateLimitError,
   *        ManifestTooLargeError, FileNotFoundError
   */
  fileTree(ref: SourceRef, path?: string): Promise<Manifest>;

  /**
   * Raw file content as a UTF-8 string. Returns `null` if the path does not
   * exist in the ref's tree (or, for binary content, when UTF-8 decoding fails).
   *
   * THROWS ProviderAuthenticationError, ProviderRateLimitError
   */
  content(ref: SourceRef, path: string): Promise<string | null>;

  /**
   * Raw file content as a ReadableStream. Optional — not all providers
   * implement streaming. Callers check for this method's presence at runtime:
   * `if ('contentStream' in provider) { ... }`
   *
   * THROWS ProviderAuthenticationError, ProviderRateLimitError
   */
  contentStream?(ref: SourceRef, path: string): Promise<ReadableStream<Uint8Array> | null>;

  /**
   * Returns the current revision of the tree without enumerating entries.
   * Optional — not all providers implement it.
   */
  getRevision?(ref: SourceRef): Promise<string>;

  /**
   * Quick check: is the provider configured and able to make requests?
   * Should not make network calls — only local validation.
   */
  isAvailable(): boolean;
}
