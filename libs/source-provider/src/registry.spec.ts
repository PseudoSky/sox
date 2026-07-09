import { describe, expect, it, vi } from 'vitest';

import { ProviderNotFoundError, SchemeAlreadyRegisteredError } from './errors.js';
import { DefaultProviderRegistry } from './registry.js';
import { SourceRef } from './source-ref.js';
import type { SourceProvider } from './types.js';

function makeStubProvider(): SourceProvider {
  return {
    supportedSchemes: () => ['github', 'github.com'],
    fileTree: vi.fn(),
    content: vi.fn(),
    isAvailable: () => true,
  };
}

describe('DefaultProviderRegistry', () => {
  it('registers and resolves a provider by scheme', () => {
    const registry = new DefaultProviderRegistry();
    const provider = makeStubProvider();
    registry.register('github.com', () => provider);

    const ref = SourceRef.parse('github.com/owner/repo');
    expect(registry.getProvider(ref)).toBe(provider);
  });

  it('registerMany registers a single factory under multiple scheme keys', () => {
    const registry = new DefaultProviderRegistry();
    const provider = makeStubProvider();
    registry.registerMany(['github.com', 'github'], () => provider);

    expect(registry.registeredSchemes().sort()).toEqual(['github', 'github.com']);
    expect(registry.getProvider(SourceRef.parse('github.com/owner/repo'))).toBe(provider);
  });

  it('resolves the local scheme for local refs regardless of authority', () => {
    const registry = new DefaultProviderRegistry();
    const provider = makeStubProvider();
    registry.register('local', () => provider);

    const ref = SourceRef.parse('/abs/path');
    expect(registry.getProvider(ref)).toBe(provider);
  });

  it('throws ProviderNotFoundError for an unregistered scheme', () => {
    const registry = new DefaultProviderRegistry();
    const ref = SourceRef.parse('github.com/owner/repo');
    expect(() => registry.getProvider(ref)).toThrow(ProviderNotFoundError);
  });

  it('throws SchemeAlreadyRegisteredError on duplicate registration', () => {
    const registry = new DefaultProviderRegistry();
    registry.register('github.com', () => makeStubProvider());
    expect(() => registry.register('github.com', () => makeStubProvider())).toThrow(
      SchemeAlreadyRegisteredError,
    );
  });

  it('force:true overwrites an existing registration', () => {
    const registry = new DefaultProviderRegistry();
    const first = makeStubProvider();
    const second = makeStubProvider();
    registry.register('github.com', () => first);
    registry.register('github.com', () => second, { force: true });

    expect(registry.getProvider(SourceRef.parse('github.com/owner/repo'))).toBe(second);
  });

  it('caches the provider instance across repeated getProvider calls (lazy singleton per scheme)', () => {
    const registry = new DefaultProviderRegistry();
    const factory = vi.fn(() => makeStubProvider());
    registry.register('github.com', factory);

    const ref = SourceRef.parse('github.com/owner/repo');
    const first = registry.getProvider(ref);
    const second = registry.getProvider(SourceRef.parse('github.com/other/repo'));

    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('createProvider always returns a fresh instance', () => {
    const registry = new DefaultProviderRegistry();
    const factory = vi.fn(() => makeStubProvider());
    registry.register('github.com', factory);

    const a = registry.createProvider('github.com');
    const b = registry.createProvider('github.com');

    expect(a).not.toBe(b);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('createProvider throws ProviderNotFoundError for an unregistered scheme', () => {
    const registry = new DefaultProviderRegistry();
    expect(() => registry.createProvider('github.com')).toThrow(ProviderNotFoundError);
  });

  it('deregister removes the registration and invalidates the cached instance', () => {
    const registry = new DefaultProviderRegistry();
    const factory = vi.fn(() => makeStubProvider());
    registry.register('github.com', factory);
    registry.getProvider(SourceRef.parse('github.com/owner/repo'));

    expect(registry.deregister('github.com')).toBe(true);
    expect(registry.deregister('github.com')).toBe(false);
    expect(registry.registeredSchemes()).toEqual([]);
    expect(() => registry.getProvider(SourceRef.parse('github.com/owner/repo'))).toThrow(
      ProviderNotFoundError,
    );
  });

  it('deregister followed by register creates a fresh instance on next getProvider (token rotation)', () => {
    const registry = new DefaultProviderRegistry();
    const first = makeStubProvider();
    const second = makeStubProvider();
    registry.register('github.com', () => first);

    const ref = SourceRef.parse('github.com/owner/repo');
    expect(registry.getProvider(ref)).toBe(first);

    registry.deregister('github.com');
    registry.register('github.com', () => second);
    expect(registry.getProvider(ref)).toBe(second);
  });
});
