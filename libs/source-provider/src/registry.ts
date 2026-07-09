// @adhd/sox-source-provider — ProviderRegistry
// Authoritative spec: sox-ecosystem/docs/plan/source-provider/SPEC.md §8

import { ProviderNotFoundError, SchemeAlreadyRegisteredError } from './errors.js';
import type { SourceRef } from './source-ref.js';
import type { SourceProvider } from './types.js';

/** A factory that creates a provider instance for a given scheme. */
export type ProviderFactory = () => SourceProvider;

export interface ProviderRegistry {
  /**
   * Register a provider factory for one URL scheme. Scheme keys are the
   * authority segment of a normalized {@link SourceRef} — "github.com",
   * "bitbucket.org" — or "local" for the local filesystem provider.
   *
   * THROWS SchemeAlreadyRegisteredError if a scheme already has a provider,
   * unless `opts.force` is set.
   */
  register(scheme: string, factory: ProviderFactory, opts?: { force?: boolean }): void;

  /** Register a provider factory for multiple schemes at once. */
  registerMany(schemes: string[], factory: ProviderFactory): void;

  /**
   * Get the provider for a given source reference. Resolves the scheme key
   * from the ref (its `authority`, or "local" for local refs).
   *
   * THROWS ProviderNotFoundError if no provider is registered for the scheme.
   */
  getProvider(ref: SourceRef): SourceProvider;

  /** Get all registered scheme keys. */
  registeredSchemes(): string[];

  /** Remove a provider registration. Returns true if a provider was removed. */
  deregister(scheme: string): boolean;

  /**
   * Create a fresh provider instance for a scheme (calls the factory).
   * Use `getProvider()` for the common case (one cached instance per scheme).
   */
  createProvider(scheme: string): SourceProvider;
}

/** Resolve the registry scheme key for a ref: "local", or the ref's authority. */
function schemeKeyFor(ref: SourceRef): string {
  return ref.scheme === 'local' ? 'local' : ref.authority;
}

/**
 * Default {@link ProviderRegistry} implementation. Provider instances are
 * lazily created and cached per scheme — the first `getProvider(ref)` call
 * for a scheme creates the instance (via the registered factory);
 * subsequent calls reuse it. This avoids re-authenticating and re-creating
 * HTTP client connections on every request. To force a fresh instance
 * (e.g. after token rotation), call `deregister(scheme)` then
 * `register(scheme, factory)` again.
 */
export class DefaultProviderRegistry implements ProviderRegistry {
  private readonly factories = new Map<string, ProviderFactory>();
  private readonly instances = new Map<string, SourceProvider>();

  register(scheme: string, factory: ProviderFactory, opts?: { force?: boolean }): void {
    if (this.factories.has(scheme) && !opts?.force) {
      throw new SchemeAlreadyRegisteredError(scheme);
    }
    this.factories.set(scheme, factory);
    this.instances.delete(scheme);
  }

  registerMany(schemes: string[], factory: ProviderFactory): void {
    for (const scheme of schemes) {
      this.register(scheme, factory);
    }
  }

  getProvider(ref: SourceRef): SourceProvider {
    const scheme = schemeKeyFor(ref);
    const cached = this.instances.get(scheme);
    if (cached) return cached;

    const factory = this.factories.get(scheme);
    if (!factory) throw new ProviderNotFoundError(scheme);

    const instance = factory();
    this.instances.set(scheme, instance);
    return instance;
  }

  registeredSchemes(): string[] {
    return Array.from(this.factories.keys());
  }

  deregister(scheme: string): boolean {
    this.instances.delete(scheme);
    return this.factories.delete(scheme);
  }

  createProvider(scheme: string): SourceProvider {
    const factory = this.factories.get(scheme);
    if (!factory) throw new ProviderNotFoundError(scheme);
    return factory();
  }
}
