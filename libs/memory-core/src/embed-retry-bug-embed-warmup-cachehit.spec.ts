/**
 * embed-retry-bug-embed-warmup-cachehit.spec.ts
 *
 * BUG-EMBED-WARMUP-CACHEHIT-ASSUMES-FAST-LOAD-001, §1b / AC-3.
 *
 * `getOrCreateProvider()` (embed.ts) used to cache the REJECTED promise from
 * `resolveProvider()` forever: `.then((p) => {...})` only ran its fulfillment
 * handler, so a rejected `_providerPromise` was never reset to `null`. Every
 * subsequent `embed()`/`warmupEmbed()` call for the rest of the process's
 * life hit `if (_providerPromise) return _providerPromise;` and got back the
 * SAME already-rejected promise — no matter how much time passed or how many
 * calls were made. This is the literal, sole mechanism behind the live
 * incident's "did not lazily recover across ~5 minutes and multiple recall
 * calls."
 *
 * These tests use `_setCreateProviderOverrideForTest()` — a test-only seam
 * inside `resolveProvider()` — rather than `_setEmbedProviderForTest()`,
 * because the latter bypasses `getOrCreateProvider()`/`resolveProvider()`
 * entirely (it short-circuits at the very top of `getOrCreateProvider()`),
 * so it cannot exercise the promise-caching bug this item fixes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  embed,
  getEmbedState,
  _resetEmbedSingleton,
  _setEmbedProviderForTest,
  _setCreateProviderOverrideForTest,
} from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';
import type { EmbeddingProvider } from '@adhd/sox-embedding-provider';

let savedBackend: string | undefined;

beforeEach(() => {
  savedBackend = process.env['SOX_EMBED_BACKEND'];
  // Ensure the real resolution path is exercised, not the injected test
  // provider short-circuit.
  _setEmbedProviderForTest(null);
  _resetEmbedSingleton();
});

afterEach(() => {
  _setCreateProviderOverrideForTest(null);
  // Restore the deterministic test provider so subsequent files' tests don't
  // accidentally hit fastembed (mirrors embed.spec.ts's own afterEach).
  _setEmbedProviderForTest(new DeterministicTestProvider());
  if (savedBackend === undefined) {
    delete process.env['SOX_EMBED_BACKEND'];
  } else {
    process.env['SOX_EMBED_BACKEND'] = savedBackend;
  }
  _resetEmbedSingleton();
});

describe('BUG-EMBED-WARMUP-CACHEHIT-ASSUMES-FAST-LOAD-001 — getOrCreateProvider() does not cache a rejection forever (AC-3)', () => {
  it('a failed resolution does not permanently poison subsequent embed() calls; the resolver is invoked again once the underlying condition is fixed', async () => {
    let calls = 0;
    let shouldFail = true;
    _setCreateProviderOverrideForTest(async (): Promise<EmbeddingProvider> => {
      calls++;
      if (shouldFail) {
        throw new Error('injected cold-load failure');
      }
      return new DeterministicTestProvider();
    });

    // First call: rejects (injected failure).
    await expect(embed('first attempt, should fail')).rejects.toThrow();
    expect(getEmbedState()).toBe('uninitialized');
    expect(calls).toBe(1);

    // Flip the injected condition to now succeed — mirrors "the underlying
    // condition is fixed" (e.g. the cold load that eventually finished in
    // the background, per §1a).
    shouldFail = false;

    // Second call: today (pre-fix) this would return the SAME cached
    // rejected promise without invoking the resolver again — `calls` would
    // stay at 1 and this would reject with the exact same injected error.
    // Post-fix: `_providerPromise` was cleared on rejection, so this call
    // attempts resolution again.
    const vec = await embed('second attempt, should now succeed');
    expect(vec).toBeInstanceOf(Float32Array);
    expect(calls).toBe(2); // the resolver WAS invoked a second time
    expect(getEmbedState()).toBe('real');
  });

  it('warmupEmbed() also recovers on a subsequent call after a prior rejection', async () => {
    let calls = 0;
    let shouldFail = true;
    _setCreateProviderOverrideForTest(async (): Promise<EmbeddingProvider> => {
      calls++;
      if (shouldFail) throw new Error('injected cold-load failure');
      return new DeterministicTestProvider();
    });

    const { warmupEmbed } = await import('./embed.js');
    await expect(warmupEmbed()).rejects.toThrow();
    expect(calls).toBe(1);

    shouldFail = false;
    const health = await warmupEmbed();
    expect(health.state).toBe('real');
    expect(calls).toBe(2);
  });

  it('CONCURRENCY: two concurrent embed() calls issued before the injected resolver settles result in only ONE resolver invocation (in-flight dedup preserved)', async () => {
    let calls = 0;
    let resolveGate: (() => void) | null = null;
    const gate = new Promise<void>((resolve) => {
      resolveGate = resolve;
    });
    _setCreateProviderOverrideForTest(async (): Promise<EmbeddingProvider> => {
      calls++;
      await gate; // stay pending until the test releases it
      return new DeterministicTestProvider();
    });

    // Fire two concurrent embed() calls before the resolver settles.
    const p1 = embed('concurrent call one');
    const p2 = embed('concurrent call two');

    // Let microtasks run so both calls reach getOrCreateProvider().
    await Promise.resolve();
    await Promise.resolve();

    expect(calls).toBe(1); // deduped — only one resolveProvider() in flight

    resolveGate!();
    const [v1, v2] = await Promise.all([p1, p2]);
    expect(v1).toBeInstanceOf(Float32Array);
    expect(v2).toBeInstanceOf(Float32Array);
    expect(calls).toBe(1); // still only ever invoked once
  });
});
