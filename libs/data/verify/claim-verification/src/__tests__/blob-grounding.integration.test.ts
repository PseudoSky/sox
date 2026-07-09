/**
 * Exercised-path integration spec: blob-store -> claim-verification (real NLI).
 *
 * Binds `@adhd/sox-blob-store` (content-addressable, on-disk) to
 * `@adhd/sox-claim-verification` (real ONNX cross-encoder NLI, via the
 * shared embedWorker.ts — no `simpleHash`/token-overlap stub). Source text
 * is `put()` into a real on-disk BlobStore, retrieved via `get()` (which
 * exercises the sha256 `verifyOnRead` integrity check), and fed as the NLI
 * premise for a genuine grounded/ungrounded verdict.
 *
 * Also exercises `store.verify(hash)` directly (explicit integrity check,
 * §wire-blob-claim commit point 1) alongside the implicit verifyOnRead path
 * inside `get()`.
 *
 * First run downloads + caches Xenova/nli-deberta-v3-xsmall (~87MB
 * quantized) via @huggingface/transformers — same model already exercised
 * by embedding-provider's embedWorker.spec.ts (cross-encoder state).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';

import { createBlobStore, type BlobStore } from '@adhd/sox-blob-store';
import { createClaimVerifier, type ClaimVerifier } from '../index.js';

const REAL_INFERENCE_TIMEOUT_MS = 180_000;

describe('blob-store -> claim-verification exercised path (real ONNX NLI)', () => {
  let basePath: string;
  let store: BlobStore;
  let verifier: ClaimVerifier | null = null;

  beforeEach(async () => {
    basePath = path.join(tmpdir(), `blob-grounding-${randomUUID()}`);
    store = createBlobStore({ basePath });
    await store.open();
  });

  afterEach(async () => {
    if (verifier) {
      await verifier.shutdown();
      verifier = null;
    }
    await store.close();
    await fsp.rm(basePath, { recursive: true, force: true });
  });

  it(
    'stores source text as a real on-disk blob, retrieves + integrity-verifies it, ' +
      'and the real NLI worker entails a claim genuinely supported by it',
    async () => {
      // ── 1. blob-store put/verify/get on a real on-disk path ──
      const sourceText =
        'Paris is the capital of France and its most populous city, ' +
        'situated on the river Seine in the north of the country.';
      const sourceBytes = new TextEncoder().encode(sourceText);

      const hash = await store.put(sourceBytes);
      expect(hash).toHaveLength(64);

      // Explicit integrity check (content-addressable: computed == expected).
      const integrity = await store.verify(hash);
      expect(integrity.match).toBe(true);
      expect(integrity.hash).toBe(hash);

      // Retrieval exercises verifyOnRead (sha256 recompute) internally.
      const retrieved = await store.get(hash);
      expect(retrieved).not.toBeNull();
      const retrievedText = new TextDecoder().decode(retrieved!);
      expect(retrievedText).toBe(sourceText);

      // ── 2. feed the blob-backed source text to the real claim-verifier ──
      verifier = await createClaimVerifier({ modelId: 'MiniCheck', modelVersion: '1' });
      expect(verifier.isReady).toBe(true);

      const result = await verifier.verify(
        { id: 'claim-grounded', text: 'Paris is the capital of France.' },
        { id: hash, text: retrievedText },
      );

      expect(result.sourceResults).toHaveLength(1);
      const [sourceResult] = result.sourceResults;
      expect(sourceResult!.entailment).toBe('entails');
      expect(sourceResult!.confidence).toBeGreaterThan(0.5);
      expect(result.aggregateConfidence).toBeGreaterThan(0.5);
    },
    REAL_INFERENCE_TIMEOUT_MS,
  );

  it(
    'flags a claim NOT grounded in the blob-backed source (ungrounded verdict)',
    async () => {
      const sourceText = 'Paris is the capital of France.';
      const hash = await store.put(new TextEncoder().encode(sourceText));
      const retrieved = await store.get(hash);
      const retrievedText = new TextDecoder().decode(retrieved!);

      verifier = await createClaimVerifier({ modelId: 'MiniCheck', modelVersion: '1' });

      const result = await verifier.verify(
        { id: 'claim-ungrounded', text: 'Berlin is the capital of France.' },
        { id: hash, text: retrievedText },
      );

      const [sourceResult] = result.sourceResults;
      expect(sourceResult!.entailment).not.toBe('entails');
      expect(['contradicts', 'neutral', 'unverifiable']).toContain(sourceResult!.entailment);
    },
    REAL_INFERENCE_TIMEOUT_MS,
  );
});
