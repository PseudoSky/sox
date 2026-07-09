import { describe, expect, it } from 'vitest';

import * as pkg from './index.js';

describe('@adhd/sox-source-provider — public export surface', () => {
  it('exports SourceRef with a working parse()', () => {
    expect(typeof pkg.SourceRef.parse).toBe('function');
    expect(pkg.SourceRef.parse('github:owner/repo').toString()).toBe('github.com/owner/repo');
  });

  it('exports normalizeSourceRef as the underlying free function', () => {
    expect(typeof pkg.normalizeSourceRef).toBe('function');
  });

  it('exports the provider registry', () => {
    expect(typeof pkg.DefaultProviderRegistry).toBe('function');
    const registry = new pkg.DefaultProviderRegistry();
    expect(registry.registeredSchemes()).toEqual([]);
  });

  it('exports all three concrete provider factories/classes', () => {
    expect(typeof pkg.createGitHubProvider).toBe('function');
    expect(typeof pkg.GitHubProvider).toBe('function');
    expect(typeof pkg.createBitbucketProvider).toBe('function');
    expect(typeof pkg.BitbucketProvider).toBe('function');
    expect(typeof pkg.createLocalProvider).toBe('function');
    expect(typeof pkg.LocalProvider).toBe('function');
  });

  it('exports createFakeProvider', () => {
    expect(typeof pkg.createFakeProvider).toBe('function');
    const fake = pkg.createFakeProvider({ trees: {} });
    expect(fake.isAvailable()).toBe(true);
  });

  it('exports the full error taxonomy (SPEC §11)', () => {
    const errorExports = [
      'ProviderNotFoundError',
      'ProviderAuthenticationError',
      'ProviderRateLimitError',
      'SchemeAlreadyRegisteredError',
      'InvalidSourceRefError',
      'FileNotFoundError',
      'ManifestTooLargeError',
      'ProviderTransientError',
    ] as const;

    expect(typeof pkg.SourceProviderError).toBe('function');
    for (const name of errorExports) {
      expect(typeof pkg[name]).toBe('function');
      expect(pkg[name].prototype).toBeInstanceOf(pkg.SourceProviderError);
    }
  });

  it('every concrete provider implements the same SourceProvider surface (no instanceof needed)', async () => {
    const providers = [
      pkg.createLocalProvider(),
      pkg.createFakeProvider({ trees: {} }),
      pkg.createGitHubProvider({ token: 'x' }),
      pkg.createBitbucketProvider({ token: 'x' }),
    ];
    for (const provider of providers) {
      expect(typeof provider.supportedSchemes).toBe('function');
      expect(typeof provider.fileTree).toBe('function');
      expect(typeof provider.content).toBe('function');
      expect(typeof provider.isAvailable).toBe('function');
      expect(Array.isArray(provider.supportedSchemes())).toBe(true);
    }
  });
});
