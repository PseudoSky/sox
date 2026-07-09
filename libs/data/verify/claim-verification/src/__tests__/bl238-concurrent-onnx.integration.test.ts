/**
 * BL-238/BL-171 regression test — real ONNX inference, no mocks.
 *
 * Before the fix: `@adhd/sox-embedding-provider`'s `FastembedProvider`
 * (fastembed, onnxruntime-node@1.21.0), `@adhd/sox-hybrid-search`'s
 * cross-encoder reranker, and `@adhd/sox-claim-verification`'s `WorkerProxy`
 * (NLI, both via `@huggingface/transformers`'s onnxruntime-node@1.24.3) each
 * spawned their OWN separate `worker_threads.Worker`. Running 2+ of them
 * concurrently in one process crashed the entire process with a native V8
 * fatal error:
 *
 *   FATAL ERROR: HandleScope::HandleScope Entering the V8 API without
 *   proper locking in place
 *
 * (BL-238 repro (b): "1x fastembed + 1x cross-encoder/verifier -> crash".)
 *
 * The fix (see `@adhd/sox-embedding-provider`'s `sharedOnnxWorker.ts` /
 * `sharedFastembedProcess.ts` for the full root-cause writeup) is two-part:
 *   - Rerank (hybrid-search) + verify (claim-verification) — both
 *     `@huggingface/transformers`, onnxruntime-node@1.24.3 — route through
 *     `getSharedOnnxWorker()`, the ONE process-wide onnxruntime-bearing
 *     `worker_threads.Worker`.
 *   - Embed (fastembed, onnxruntime-node@1.21.0) routes through
 *     `getSharedFastembedProcess()`, a dedicated child PROCESS — proven
 *     necessary because even strictly-JS-serialized sequential loading of
 *     onnxruntime-node@1.21.0 immediately after onnxruntime-node@1.24.3 in
 *     the SAME worker thread deterministically crashed with `std::bad_alloc`
 *     (a native hazard below what JS-level scheduling can prevent).
 *
 * There is only ever ONE onnxruntime-bearing worker thread alive (rerank +
 * verify) and fastembed never shares a thread or process with it at all, so
 * both crash classes are structurally impossible — this test exercises all
 * THREE real ONNX workloads (embed + rerank + verify) concurrently in one
 * process, the exact composition that used to crash.
 *
 * First run downloads + caches Xenova/ms-marco-MiniLM-L-6-v2 (~23MB,
 * rerank) and Xenova/nli-deberta-v3-xsmall (~87MB, verify) via
 * @huggingface/transformers, plus bge-small-en-v1.5 (fastembed, embed) —
 * same models already exercised by embedding-provider's embedWorker.spec.ts,
 * hybrid-search's cross-encoder.spec.ts, and this package's
 * blob-grounding.integration.test.ts.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { createEmbeddingProvider, type EmbeddingProvider } from '@adhd/sox-embedding-provider';
import { createCrossEncoder, type CrossEncoder } from '@adhd/sox-hybrid-search';
import { createClaimVerifier, type ClaimVerifier } from '../index.js';

const REAL_INFERENCE_TIMEOUT_MS = 180_000;

describe('BL-238/BL-171 — concurrent ONNX consumers share ONE worker (no crash)', () => {
  let verifier: ClaimVerifier | null = null;
  let encoder: CrossEncoder | null = null;

  afterEach(async () => {
    if (verifier) {
      await verifier.shutdown();
      verifier = null;
    }
    if (encoder) {
      await encoder.dispose();
      encoder = null;
    }
  });

  it(
    'real fastembed embedding + real ONNX NLI verification run concurrently in one process without crashing',
    async () => {
      let embedder: EmbeddingProvider;
      [embedder, verifier] = await Promise.all([
        createEmbeddingProvider({ type: 'fastembed', model: 'bge-small-en-v1.5' }),
        createClaimVerifier({ modelId: 'MiniCheck', modelVersion: '1' }),
      ]);

      const [vec, result] = await Promise.all([
        embedder.embedSingle('Paris is the capital of France.'),
        verifier.verify(
          { id: 'claim-grounded', text: 'Paris is the capital of France.' },
          { id: 'source-1', text: 'Paris is the capital of France and its most populous city.' },
        ),
      ]);

      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(384);

      expect(result.sourceResults).toHaveLength(1);
      const [sourceResult] = result.sourceResults;
      expect(sourceResult!.entailment).toBe('entails');
      expect(sourceResult!.confidence).toBeGreaterThan(0.5);
    },
    REAL_INFERENCE_TIMEOUT_MS,
  );

  it(
    'real fastembed embedding + real ONNX cross-encoder rerank + real ONNX NLI verification ALL run concurrently in one process without crashing (the exact composition that crashed pre-fix)',
    async () => {
      let embedder: EmbeddingProvider;
      [embedder, encoder, verifier] = await Promise.all([
        createEmbeddingProvider({ type: 'fastembed', model: 'bge-small-en-v1.5' }),
        createCrossEncoder({ modelId: 'MiniCheck' }),
        createClaimVerifier({ modelId: 'MiniCheck', modelVersion: '1' }),
      ]);

      const [vec, scores, result] = await Promise.all([
        embedder.embedSingle('Paris is the capital of France.'),
        encoder.rerank('What is the capital of France?', [
          { id: 'relevant', text: 'Paris is the capital and most populous city of France.' },
          { id: 'irrelevant', text: 'Bananas are a good source of potassium and fiber.' },
        ]),
        verifier.verify(
          { id: 'claim-grounded', text: 'Paris is the capital of France.' },
          { id: 'source-1', text: 'Paris is the capital of France and its most populous city.' },
        ),
      ]);

      // Real (non-mocked) embed inference: correct dims, non-zero vector.
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(384);
      expect(vec.some((x) => x !== 0)).toBe(true);

      // Real (non-mocked) rerank inference: relevant candidate scores higher.
      expect(scores.length).toBe(2);
      expect(scores[0]).toBeGreaterThan(scores[1]!);

      // Real (non-mocked) NLI verification: clearly-supported claim entails.
      expect(result.sourceResults).toHaveLength(1);
      const [sourceResult] = result.sourceResults;
      expect(sourceResult!.entailment).toBe('entails');
      expect(sourceResult!.confidence).toBeGreaterThan(0.5);
    },
    REAL_INFERENCE_TIMEOUT_MS,
  );
});
