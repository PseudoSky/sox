/**
 * bug021-ping-health-reflects-embed-failures.spec.ts — BUG-021, second defect
 * (live incident, 2026-08-18).
 *
 * Live evidence: `memory_ping` on the affected process reported
 * `embed.state: "real"`, `last_error: null` while EVERY embed call was
 * failing (532 `sox.stage.embed.error` records, `counters.embeds_completed:
 * 0`, `counters.embeds_failed: 4`). A health surface that reads clean during
 * total pipeline failure is the same class of defect as `[inv:list-never-
 * lies]`.
 *
 * ROOT CAUSE: `getEmbedState()` derived `'real'` purely from
 * `_resolvedBackend === 'real'` — set ONCE, the moment the provider was first
 * successfully constructed — and NEVER consulted whether the most recent
 * actual `embedSingle()` call succeeded. `_embedWork()`'s catch block logged
 * `embed.error` and rethrew, but never wrote `_lastEmbedError` or any failure
 * counter, so `getEmbedHealth()` kept reporting the state from process start
 * no matter how many subsequent embeds failed.
 *
 * FIX: `_embedWork()` now tracks `_consecutiveEmbedFailures` (bumped on every
 * catch, reset on the next success) and updates `_lastEmbedError` on EVERY
 * per-call failure, not just an init-time `resolveProvider()`/`warmupEmbed()`
 * failure. `getEmbedState()` reports `'degraded'` whenever the provider
 * resolved successfully at some point but the most recent call(s) failed.
 * `computePingHealthVerdict()` (`ping-health.ts`) already treats any non-
 * `'real'` embed state as `embedOk: false`, so this fix alone flips
 * `memory_ping`'s overall `status` from `'ok'` to `'degraded'` too, with
 * `status_reason` naming the real embed error — no memory-server changes
 * needed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EmbeddingProvider, EmbeddingHealth, EmbeddingProviderMetadata } from '@adhd/sox-embedding-provider';
import {
  embed,
  getEmbedHealth,
  getEmbedState,
  _resetEmbedSingleton,
  _setEmbedProviderForTest,
} from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';

/** A provider whose `embedSingle()` always rejects with a fixed message —
 *  mirrors the live incident's respawned-child-with-no-model shape without
 *  forking any real process. */
class AlwaysFailsProvider implements EmbeddingProvider {
  readonly metadata: EmbeddingProviderMetadata = {
    modelId: 'bug021-always-fails',
    dimensions: 8,
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
  async warmUp(): Promise<void> {
    // no-op
  }
  health(): EmbeddingHealth {
    // Mirrors the live incident: the PROVIDER-LEVEL health object itself
    // still reports 'real'/null — the defect is entirely in embed.ts's own
    // module-level state, not in what the provider self-reports.
    return { configured: 'stub', active: 'stub', state: 'real', dimensions: 8, last_error: null };
  }
}

beforeEach(() => {
  _resetEmbedSingleton();
});

afterEach(() => {
  _setEmbedProviderForTest(new DeterministicTestProvider());
  _resetEmbedSingleton();
});

describe('BUG-021 — embed health surface reflects live per-call failures', () => {
  it('getEmbedState()/getEmbedHealth() report degraded + the real error after embed() fails, not real/null', async () => {
    _setEmbedProviderForTest(new AlwaysFailsProvider());

    await expect(embed('this will fail')).rejects.toThrow('Model not initialized');

    // THE BUG: before the fix, this read state:'real', last_error:null —
    // clean, while the call above just failed.
    expect(getEmbedState()).toBe('degraded');
    const health = getEmbedHealth();
    expect(health.state).toBe('degraded');
    expect(health.last_error).toBe('Model not initialized');
  });

  it('recovers to real/null the instant a subsequent embed() call succeeds', async () => {
    _setEmbedProviderForTest(new AlwaysFailsProvider());
    await expect(embed('fails once')).rejects.toThrow();
    expect(getEmbedState()).toBe('degraded');

    // Swap in a working provider (mirrors the respawned child healing once
    // it is genuinely re-initialized) and embed again.
    _setEmbedProviderForTest(new DeterministicTestProvider());
    await embed('this succeeds');

    expect(getEmbedState()).toBe('real');
    expect(getEmbedHealth().last_error).toBeNull();
  });
});
