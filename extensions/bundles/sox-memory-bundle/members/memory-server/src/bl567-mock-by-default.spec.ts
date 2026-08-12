/**
 * bl567-mock-by-default.spec.ts — BL-567 regression: the DEFAULT memory-server
 * test path must run on the deterministic feature-hash provider, never the
 * real fastembed/ONNX backend.
 *
 * BEFORE BL-567 the suite ran REAL bge-base-en-v1.5 embeddings in every
 * worker that embedded (only 10 of 26 spec files injected
 * DeterministicTestProvider), paying native ONNX model loads, serializing the
 * pool (maxWorkers:1) and requiring 30s timeouts. BL-567 installs the mock in
 * vitest.setup.ts instead, so a spec that does NOT opt out — like this one —
 * must observe the deterministic provider end-to-end: correct model id, no
 * real backend init, bit-identical vectors across calls.
 *
 * RED side (fix disabled = remove the _setEmbedProviderForTest(...) call from
 * vitest.setup.ts): embed() resolves the REAL provider, getActiveEmbedModel()
 * reports 'bge-base-en-v1.5' (not 'test-feature-hash-768') and the model-id
 * assertion fails — verified 2026-08-12. GREEN side: this file passes with the
 * setup mock installed, in milliseconds, with zero ONNX loading (BL-225).
 */
import {
  _resetEmbedSingleton,
  _shutdownEmbedWorker,
  embed,
  getActiveEmbedModel,
  warmupEmbed,
} from '@adhd/sox-memory-core';
import { afterEach, describe, expect, it } from 'vitest';

describe('BL-567 — deterministic mock is the default embedding provider', () => {
  afterEach(async () => {
    await _shutdownEmbedWorker();
  });

  it('reports the deterministic model id with NO opt-in (no real ONNX resolved)', async () => {
    _resetEmbedSingleton();
    // The setup-file mock survives _resetEmbedSingleton() by design (embed.ts),
    // so the model identity must already be the deterministic one.
    expect(getActiveEmbedModel()).toBe('test-feature-hash-768');
    const vec = await embed('BL-567 regression: the default embed path is deterministic.');
    expect(vec).toHaveLength(768);
    // Still the deterministic provider after an actual embed call.
    expect(getActiveEmbedModel()).toBe('test-feature-hash-768');
  });

  it('embeds are bit-identical across calls (feature-hash determinism, not ONNX)', async () => {
    _resetEmbedSingleton();
    const a = await embed('BL-567 determinism check text.');
    const b = await embed('BL-567 determinism check text.');
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('warmupEmbed health reflects the deterministic provider without real backend init', async () => {
    _resetEmbedSingleton();
    const health = await warmupEmbed();
    expect(health.state).toBe('real');
    expect(health.model).toBe('test-feature-hash-768');
  });
});
