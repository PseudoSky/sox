/**
 * bug-memoryserver-embed-heal-nooperator-001-embed-reinit.spec.ts —
 * BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001, the embed-provider re-init.
 *
 * RED→GREEN (BL-225): the pre-fix embed subsystem had no recovery path for a
 * wedged shared fastembed child (BUG-021's "Model not initialized"
 * respawn-without-reinit state). Once `_consecutiveEmbedFailures` latched
 * `getEmbedState()` to 'degraded', nothing could clear it short of a process
 * restart — the heal loop kept re-attempting against the same dead child.
 * `reinitEmbedProvider()` tears down the shared hosts, clears the in-process
 * failure state, and re-warms, so the health surface recovers the instant the
 * provider is genuinely re-initialized. These arms fail against the pre-fix
 * (no reinit surface) and pass now.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbeddingProvider, EmbeddingHealth, EmbeddingProviderMetadata } from '@adhd/sox-embedding-provider';
import {
  embed,
  getEmbedState,
  getEmbedHealth,
  reinitEmbedProvider,
  _resetEmbedSingleton,
  _setEmbedProviderForTest,
} from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';

/** A provider that always rejects — mirrors BUG-021's wedged child. */
class AlwaysFailsProvider implements EmbeddingProvider {
  readonly metadata: EmbeddingProviderMetadata = {
    modelId: 'nooperator-always-fails',
    dimensions: 768,
    maxTokens: 512,
    isRemote: false,
    isDeterministic: false,
  };
  async embedSingle(): Promise<Float32Array> {
    throw new Error('Model not initialized');
  }
  async *embedBatch(): AsyncIterable<Float32Array> {
    throw new Error('Model not initialized');
  }
  async warmUp(): Promise<void> { /* no-op */ }
  health(): EmbeddingHealth {
    return { configured: 'stub', active: 'stub', state: 'real', dimensions: 768, last_error: null };
  }
}

/** A provider whose OWN health reports 'error' — re-init's warmup must surface it. */
class DeadProvider implements EmbeddingProvider {
  readonly metadata: EmbeddingProviderMetadata = {
    modelId: 'nooperator-dead',
    dimensions: 768,
    maxTokens: 512,
    isRemote: false,
    isDeterministic: false,
  };
  async embedSingle(): Promise<Float32Array> {
    throw new Error('Model not initialized');
  }
  async *embedBatch(): AsyncIterable<Float32Array> {
    throw new Error('Model not initialized');
  }
  async warmUp(): Promise<void> { /* no-op */ }
  health(): EmbeddingHealth {
    return { configured: 'stub', active: 'stub', state: 'error', dimensions: 768, last_error: 'Model not initialized' };
  }
}

beforeEach(() => _resetEmbedSingleton());
afterEach(() => {
  _setEmbedProviderForTest(new DeterministicTestProvider());
  _resetEmbedSingleton();
});

describe('BUG-MEMORYSERVER-EMBED-HEAL-NOOPERATOR-001 — reinitEmbedProvider', () => {
  it('recovers from a degraded/failure state and reports real health after re-init', async () => {
    _setEmbedProviderForTest(new AlwaysFailsProvider());
    await expect(embed('this will fail')).rejects.toThrow('Model not initialized');
    expect(getEmbedState()).toBe('degraded');
    expect(getEmbedHealth().last_error).toBe('Model not initialized');

    // The provider recovers (a genuinely re-initialized child), then the
    // operator/auto-heal re-init clears the latched failure state.
    _setEmbedProviderForTest(new DeterministicTestProvider());
    const r = await reinitEmbedProvider();

    expect(r.error).toBeNull();
    expect(r.state).toBe('real');
    expect(r.model).toBe('test-feature-hash-768');
    expect(getEmbedState()).toBe('real');
    expect(getEmbedHealth().last_error).toBeNull();
  });

  it('clears a prior failure streak so a subsequent embed reads real (no restart required)', async () => {
    _setEmbedProviderForTest(new AlwaysFailsProvider());
    await expect(embed('fails')).rejects.toThrow();
    await expect(embed('fails again')).rejects.toThrow();
    expect(getEmbedState()).toBe('degraded');

    _setEmbedProviderForTest(new DeterministicTestProvider());
    const r = await reinitEmbedProvider();
    expect(r.state).toBe('real');

    await embed('now succeeds');
    expect(getEmbedState()).toBe('real');
  });

  it('returns the error (state not real) when re-init still fails', async () => {
    _setEmbedProviderForTest(new DeadProvider());
    await expect(embed('fails')).rejects.toThrow();
    expect(getEmbedState()).toBe('degraded');

    // Re-init against a provider whose OWN health reports 'error' surfaces the
    // failure rather than a false clean bill of health.
    const r = await reinitEmbedProvider();
    expect(r.error).not.toBeNull();
  });
});
