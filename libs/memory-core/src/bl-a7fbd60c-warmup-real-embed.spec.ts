/**
 * bl-a7fbd60c-warmup-real-embed.spec.ts — regression for warmupEmbed()
 * reading provider health BEFORE ever performing a real embed (backlog
 * a7fbd60c).
 *
 * `FastembedProvider` is lazy: its constructor does not load the model —
 * only the first real `embedSingle()` call does. Pre-fix, `warmupEmbed()`
 * called `getOrCreateProvider()` then immediately read `p.health()`, which
 * for a lazy provider always reports `state: 'uninitialized'` until an
 * embed has actually run — so warmup logged DEGRADED and never preloaded
 * the model, and the first post-restart caller paid the full model-load
 * cost inside the much shorter per-request funnel timeout.
 *
 * Fix (libs/memory-core/src/embed.ts, ~423-499): warmupEmbed() now performs
 * a real `embed('warmup', 'warmup')` under its own generous budget BEFORE
 * reading health.
 *
 * This test uses a LazyTestProvider that mimics FastembedProvider's laziness
 * exactly: health() reports 'uninitialized' until embedSingle() has been
 * called at least once, then reports 'real'. Pre-fix, warmupEmbed() reading
 * health() first would throw "Provider health: uninitialized: unknown".
 * Post-fix it embeds first, so health() reads 'real' and warmupEmbed()
 * resolves successfully.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { EmbeddingHealth, EmbeddingProvider, EmbeddingProviderMetadata } from '@adhd/sox-embedding-provider';
import { warmupEmbed, _setEmbedProviderForTest, _resetEmbedSingleton } from './embed.js';

class LazyTestProvider implements EmbeddingProvider {
  private embedded = false;
  readonly metadata: EmbeddingProviderMetadata = {
    modelId: 'lazy-test-model',
    dimensions: 8,
    maxTokens: 512,
    isRemote: false,
    isDeterministic: true,
  };

  async embedSingle(_text: string): Promise<Float32Array> {
    // Mirrors FastembedProvider: the model only becomes "loaded" once a real
    // embed call has gone through.
    this.embedded = true;
    return new Float32Array(this.metadata.dimensions).fill(0.1);
  }

  async *embedBatch(texts: string[]): AsyncIterable<Float32Array> {
    for (const _t of texts) {
      this.embedded = true;
      yield new Float32Array(this.metadata.dimensions).fill(0.1);
    }
  }

  async warmUp(_texts: string[]): Promise<void> {
    /* deliberately NOT preloading here — mirrors FastembedProvider, whose
     * constructor-time warmUp does not synchronously flip health() to
     * 'real'; only a completed embedSingle() does in this fixture. */
  }

  health(): EmbeddingHealth {
    return {
      configured: 'lazy-test:lazy-test-model',
      active: this.embedded ? this.metadata.modelId : null,
      state: this.embedded ? 'real' : 'uninitialized',
      dimensions: this.embedded ? this.metadata.dimensions : null,
      last_error: null,
    };
  }
}

describe('warmupEmbed — must perform a real embed before reading health (BL a7fbd60c)', () => {
  beforeEach(() => {
    _resetEmbedSingleton();
  });

  afterEach(() => {
    _resetEmbedSingleton();
    _setEmbedProviderForTest(null);
  });

  it('resolves successfully against a lazy provider whose health() is uninitialized until a real embed runs', async () => {
    const provider = new LazyTestProvider();
    // Sanity: this provider genuinely starts uninitialized, matching
    // FastembedProvider's real laziness — otherwise this test would pass
    // for the wrong reason.
    expect(provider.health().state).toBe('uninitialized');

    _setEmbedProviderForTest(provider);

    // THE regression assertion. Pre-fix, warmupEmbed() read health()
    // immediately after getOrCreateProvider() with no embed in between,
    // saw 'uninitialized', and threw `Embedding warmup failed: Provider
    // health: uninitialized: unknown`.
    const health = await warmupEmbed();

    expect(health.state).toBe('real');
    expect(provider.health().state).toBe('real');
  });
});
