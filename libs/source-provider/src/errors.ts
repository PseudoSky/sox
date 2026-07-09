// @adhd/sox-source-provider — error taxonomy
// Authoritative spec: sox-ecosystem/docs/plan/source-provider/SPEC.md §11
//
// Error hierarchy:
//   Error
//    └── SourceProviderError (abstract base)
//         ├── ProviderNotFoundError
//         ├── ProviderAuthenticationError
//         ├── ProviderRateLimitError
//         ├── SchemeAlreadyRegisteredError
//         ├── InvalidSourceRefError
//         ├── FileNotFoundError
//         ├── ManifestTooLargeError
//         └── ProviderTransientError

/** Base class for every error thrown by this package. */
export class SourceProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceProviderError';
  }
}

/**
 * Thrown when no provider is registered for a given URL scheme.
 * Example: `getProvider()` called with a "gitlab.com" ref when no
 * GitLab provider is registered.
 */
export class ProviderNotFoundError extends SourceProviderError {
  public readonly scheme: string;
  constructor(scheme: string) {
    super(`no provider registered for scheme: ${scheme}`);
    this.name = 'ProviderNotFoundError';
    this.scheme = scheme;
  }
}

/**
 * Thrown when a provider cannot authenticate (invalid/missing token,
 * expired token, 401 response from API).
 */
export class ProviderAuthenticationError extends SourceProviderError {
  public readonly scheme: string;
  constructor(message: string, scheme: string) {
    super(message);
    this.name = 'ProviderAuthenticationError';
    this.scheme = scheme;
  }
}

/**
 * Thrown when the provider's API rate limit is exhausted. The caller
 * should wait `retryAfterMs` before retrying.
 */
export class ProviderRateLimitError extends SourceProviderError {
  public readonly scheme: string;
  public readonly retryAfterMs: number;
  public readonly resetAt: string | undefined;
  constructor(message: string, scheme: string, retryAfterMs: number, resetAt?: string) {
    super(message);
    this.name = 'ProviderRateLimitError';
    this.scheme = scheme;
    this.retryAfterMs = retryAfterMs;
    this.resetAt = resetAt;
  }
}

/** Thrown when a scheme already has a registered provider (`registry.register`). */
export class SchemeAlreadyRegisteredError extends SourceProviderError {
  public readonly scheme: string;
  constructor(scheme: string) {
    super(`scheme already registered: ${scheme}`);
    this.name = 'SchemeAlreadyRegisteredError';
    this.scheme = scheme;
  }
}

/** Thrown when a raw `SourceRef` string cannot be parsed. */
export class InvalidSourceRefError extends SourceProviderError {
  public readonly raw: string;
  constructor(raw: string, reason: string) {
    super(`invalid source ref "${raw}": ${reason}`);
    this.name = 'InvalidSourceRefError';
    this.raw = raw;
  }
}

/**
 * Thrown when a file or directory does not exist in the source tree.
 * Thrown by `fileTree()` for non-existent directories. `content()` instead
 * returns `null` for missing files (never throws for a missing file).
 */
export class FileNotFoundError extends SourceProviderError {
  public readonly ref: string;
  public readonly path: string;
  constructor(ref: string, path: string) {
    super(`file not found: ${path} in ${ref}`);
    this.name = 'FileNotFoundError';
    this.ref = ref;
    this.path = path;
  }
}

/**
 * Thrown when the file tree is too large to enumerate in a single call.
 * The consumer should retry with subdirectory-scoped `fileTree()` calls.
 */
export class ManifestTooLargeError extends SourceProviderError {
  public readonly ref: string;
  public readonly maxEntries: number;
  public readonly estimatedTotal: number;
  constructor(ref: string, maxEntries: number, estimatedTotal: number) {
    super(
      `manifest too large: ${estimatedTotal}+ entries exceeds ` +
        `max ${maxEntries}. Use fileTree() with a subdirectory path.`,
    );
    this.name = 'ManifestTooLargeError';
    this.ref = ref;
    this.maxEntries = maxEntries;
    this.estimatedTotal = estimatedTotal;
  }
}

/**
 * Thrown on transient provider errors: network timeouts, DNS failures,
 * 5xx responses, connection resets. The caller SHOULD retry with backoff.
 */
export class ProviderTransientError extends SourceProviderError {
  public readonly scheme: string;
  public readonly retryAfterMs: number | undefined;
  constructor(message: string, scheme: string, retryAfterMs?: number) {
    super(message);
    this.name = 'ProviderTransientError';
    this.scheme = scheme;
    this.retryAfterMs = retryAfterMs;
  }
}
