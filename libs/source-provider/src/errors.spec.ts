import { describe, expect, it } from 'vitest';

import {
  FileNotFoundError,
  InvalidSourceRefError,
  ManifestTooLargeError,
  ProviderAuthenticationError,
  ProviderNotFoundError,
  ProviderRateLimitError,
  ProviderTransientError,
  SchemeAlreadyRegisteredError,
  SourceProviderError,
} from './errors.js';

describe('error taxonomy', () => {
  it('every error is a SourceProviderError which is an Error', () => {
    const errors = [
      new ProviderNotFoundError('gitlab.com'),
      new ProviderAuthenticationError('bad token', 'github'),
      new ProviderRateLimitError('rate limited', 'github', 1000),
      new SchemeAlreadyRegisteredError('github.com'),
      new InvalidSourceRefError('xyz', 'bad'),
      new FileNotFoundError('github.com/o/r', 'README.md'),
      new ManifestTooLargeError('github.com/o/r', 100_000, 200_000),
      new ProviderTransientError('timeout', 'github'),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(Error);
      expect(err).toBeInstanceOf(SourceProviderError);
    }
  });

  it('ProviderNotFoundError carries the scheme and a matching message', () => {
    const err = new ProviderNotFoundError('gitlab.com');
    expect(err.name).toBe('ProviderNotFoundError');
    expect(err.scheme).toBe('gitlab.com');
    expect(err.message).toContain('gitlab.com');
  });

  it('ProviderAuthenticationError carries the scheme', () => {
    const err = new ProviderAuthenticationError('token invalid', 'github');
    expect(err.name).toBe('ProviderAuthenticationError');
    expect(err.scheme).toBe('github');
    expect(err.message).toBe('token invalid');
  });

  it('ProviderRateLimitError carries retryAfterMs and optional resetAt', () => {
    const err = new ProviderRateLimitError('rate limited', 'github', 5000, '2026-01-01T00:00:00.000Z');
    expect(err.name).toBe('ProviderRateLimitError');
    expect(err.retryAfterMs).toBe(5000);
    expect(err.resetAt).toBe('2026-01-01T00:00:00.000Z');

    const withoutReset = new ProviderRateLimitError('rate limited', 'github', 5000);
    expect(withoutReset.resetAt).toBeUndefined();
  });

  it('SchemeAlreadyRegisteredError carries the scheme', () => {
    const err = new SchemeAlreadyRegisteredError('github.com');
    expect(err.name).toBe('SchemeAlreadyRegisteredError');
    expect(err.scheme).toBe('github.com');
    expect(err.message).toContain('github.com');
  });

  it('InvalidSourceRefError carries the raw input and reason in the message', () => {
    const err = new InvalidSourceRefError('bad ref', 'unparseable');
    expect(err.name).toBe('InvalidSourceRefError');
    expect(err.raw).toBe('bad ref');
    expect(err.message).toContain('bad ref');
    expect(err.message).toContain('unparseable');
  });

  it('FileNotFoundError carries ref and path', () => {
    const err = new FileNotFoundError('github.com/o/r@main', 'missing.txt');
    expect(err.name).toBe('FileNotFoundError');
    expect(err.ref).toBe('github.com/o/r@main');
    expect(err.path).toBe('missing.txt');
    expect(err.message).toContain('missing.txt');
    expect(err.message).toContain('github.com/o/r@main');
  });

  it('ManifestTooLargeError carries maxEntries and estimatedTotal', () => {
    const err = new ManifestTooLargeError('github.com/o/r', 100_000, 250_000);
    expect(err.name).toBe('ManifestTooLargeError');
    expect(err.maxEntries).toBe(100_000);
    expect(err.estimatedTotal).toBe(250_000);
    expect(err.message).toContain('250000');
    expect(err.message).toContain('100000');
  });

  it('ProviderTransientError carries an optional retryAfterMs', () => {
    const err = new ProviderTransientError('network reset', 'github', 2000);
    expect(err.name).toBe('ProviderTransientError');
    expect(err.retryAfterMs).toBe(2000);

    const withoutRetry = new ProviderTransientError('network reset', 'github');
    expect(withoutRetry.retryAfterMs).toBeUndefined();
  });
});
