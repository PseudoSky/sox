/**
 * embed.spec.ts — Tests for the real embedding backend.
 *
 * Covers:
 *   Real backend semantics (skipped if model download unavailable):
 *   cosine(similar pair) > cosine(unrelated pair).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

// ── Real-model gate ───────────────────────────────────────────────────────────
// The semantic similarity test runs when:
//   - SOX_EMBED_BACKEND=real  (explicit opt-in), OR
//   - SOX_RUN_EMBED_DOWNLOAD_TESTS=1  (CI gate when model is pre-cached)
// In all other environments it skips cleanly.
const RUN_REAL_EMBED =
  process.env['SOX_EMBED_BACKEND'] === 'real' ||
  process.env['SOX_RUN_EMBED_DOWNLOAD_TESTS'] === '1';

import {
  embed,
  getActiveEmbedModel,
  getEmbedHealth,
  getLastEmbedError,
  warmupEmbed,
  EMBED_DIM,
  _resetEmbedSingleton,
  _setEmbedProviderForTest,
} from './embed.js';
import { DeterministicTestProvider } from './embed-test-provider.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

function cosine(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number);
    na += (a[i] as number) * (a[i] as number);
    nb += (b[i] as number) * (b[i] as number);
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// Save and restore SOX_EMBED_BACKEND between tests.
// The vitest.setup.ts installs a DeterministicTestProvider; the real-bge test
// clears it with _setEmbedProviderForTest(null) before opting in to fastembed.
let savedBackend: string | undefined;
beforeEach(() => {
  savedBackend = process.env['SOX_EMBED_BACKEND'];
  _resetEmbedSingleton();
});
afterEach(() => {
  // Restore the test provider so subsequent tests don't accidentally hit fastembed.
  if (RUN_REAL_EMBED) {
    _setEmbedProviderForTest(new DeterministicTestProvider());
  }
  if (savedBackend === undefined) {
    delete process.env['SOX_EMBED_BACKEND'];
  } else {
    process.env['SOX_EMBED_BACKEND'] = savedBackend;
  }
  _resetEmbedSingleton();
});

// ── Real backend semantics (skipped if model not cached) ─────────────────────

describe('real backend — semantic similarity', () => {
  // Runs when SOX_EMBED_BACKEND=real or SOX_RUN_EMBED_DOWNLOAD_TESTS=1.
  // Skips cleanly in CI when the model has not been downloaded.
  it.skipIf(!RUN_REAL_EMBED)(
    'cosine(similar pair) > cosine(unrelated pair) [requires model download]',
    async () => {
      // Clear the deterministic test provider so the real fastembed backend is used.
      _setEmbedProviderForTest(null);
      process.env['SOX_EMBED_BACKEND'] = 'real';

      // BL-89: warmupEmbed engages the real backend up front and must report healthy.
      // (Combined into this single real-worker test because onnxruntime-node does not
      // re-init cleanly when a second worker is spawned in the same process — production
      // only ever spawns one embed worker per process.)
      const warm = await warmupEmbed();
      expect(warm.state).toBe('real');
      expect(warm.model).toBe('bge-base-en-v1.5');
      expect(warm.last_error).toBeNull();

      const dog1 = await embed('The dog ran across the field.');
      const dog2 = await embed('A puppy sprinted through the meadow.');
      const unrelated = await embed('The quarterly earnings report exceeded expectations.');

      const simSimilar = cosine(dog1, dog2);
      const simUnrelated = cosine(dog1, unrelated);

      expect(dog1.length).toBe(EMBED_DIM);
      expect(dog2.length).toBe(EMBED_DIM);
      expect(unrelated.length).toBe(EMBED_DIM);
      // Similar-meaning sentences must score higher than unrelated ones
      expect(simSimilar).toBeGreaterThan(simUnrelated);
      // BL-86: the real model must NOT be degenerate — it separates unrelated
      // pairs with a wide margin.
      expect(simUnrelated).toBeLessThan(0.85);
      expect(simSimilar - simUnrelated).toBeGreaterThan(0.1);

      // BL-89: when real engages, health reports real + no error.
      const h = getEmbedHealth();
      expect(h.state).toBe('real');
      expect(h.model).toBe('bge-base-en-v1.5');
      expect(h.last_error).toBeNull();
    },
    60_000, // first call loads the ONNX model
  );
});
