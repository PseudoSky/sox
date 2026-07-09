// @adhd/sox-source-provider — public API surface
// Authoritative spec: sox-ecosystem/docs/plan/source-provider/SPEC.md
//
// Unified SCM/filesystem abstraction: file tree enumeration + raw content
// retrieval from GitHub, Bitbucket, and the local filesystem, without
// cloning, behind a single SourceProvider interface + scheme registry.
// No search()/discovery — explicit references only (SPEC D-1).

// ── Core types ────────────────────────────────────────────────────────────
export type {
  FileEntry,
  FileType,
  Manifest,
  ManifestMetadata,
  RetryConfig,
  SourceProvider,
} from './types.js';

// ── SourceRef ─────────────────────────────────────────────────────────────
export { SourceRef, normalizeSourceRef } from './source-ref.js';

// ── Provider registry ─────────────────────────────────────────────────────
export { DefaultProviderRegistry } from './registry.js';
export type { ProviderFactory, ProviderRegistry } from './registry.js';

// ── Providers ─────────────────────────────────────────────────────────────
export { GitHubProvider, createGitHubProvider } from './providers/github.js';
export type { GitHubProviderConfig } from './providers/github.js';

export { BitbucketProvider, createBitbucketProvider } from './providers/bitbucket.js';
export type { BitbucketProviderConfig } from './providers/bitbucket.js';

export { LocalProvider, createLocalProvider } from './providers/local.js';
export type { LocalProviderConfig } from './providers/local.js';

export { createFakeProvider } from './providers/fake.js';
export type { ErrorConfig, FakeProviderConfig, FakeProviderEntry } from './providers/fake.js';

// ── Error taxonomy ────────────────────────────────────────────────────────
export {
  SourceProviderError,
  ProviderNotFoundError,
  ProviderAuthenticationError,
  ProviderRateLimitError,
  SchemeAlreadyRegisteredError,
  InvalidSourceRefError,
  FileNotFoundError,
  ManifestTooLargeError,
  ProviderTransientError,
} from './errors.js';
