import { describe, it, expect } from 'vitest';
import { getSharedOnnxWorker, __resetSharedOnnxWorkerForTests } from './sharedOnnxWorker.js';

/**
 * BL-238/BL-171 regression test — real ONNX inference, no mocks.
 *
 * Exercises the `getSharedOnnxWorker()` singleton directly at the wire-
 * protocol level: TWO concurrent consumers (mirroring
 * `@adhd/sox-hybrid-search`'s cross-encoder and `@adhd/sox-claim-
 * verification`'s NLI verifier) both `init` + run real inference CONCURRENTLY
 * (`Promise.all`) against the ONE shared `worker_threads.Worker`. Both are
 * `@huggingface/transformers`-driven (onnxruntime-node@1.24.3) — proven safe
 * to share a single worker thread even under real concurrency (BACKLOG.md
 * BL-238 repro (a)/(d)). fastembed (onnxruntime-node@1.21.0) is
 * DELIBERATELY not exercised here — see `sharedFastembedProcess.spec.ts` for
 * that workload, which is isolated in its own child process instead.
 */
describe('BL-238/BL-171 — getSharedOnnxWorker() singleton (rerank + verify, real ONNX)', () => {
  it(
    'concurrent rerank init+score and verify init+check both complete via the ONE shared worker without crashing',
    async () => {
      const worker = getSharedOnnxWorker();

      await Promise.all([
        worker.request({ type: 'init', initType: 'rerank', modelId: 'MiniCheck' }),
        worker.request({ type: 'init', initType: 'verify', modelId: 'MiniCheck', modelVersion: '1' }),
      ]);

      const [rerankRes, verifyRes] = await Promise.all([
        worker.request<{ scores: number[] }>({
          type: 'rerank',
          query: 'What is the capital of France?',
          candidates: [
            { id: 'relevant', text: 'Paris is the capital and most populous city of France.' },
            { id: 'irrelevant', text: 'Bananas are a good source of potassium and fiber.' },
          ],
        }),
        worker.request<{ result: { entailment: string; confidence: number } }>({
          type: 'verify',
          jobId: 'job-1',
          sourceText: 'Paris is the capital of France and its most populous city.',
          claimText: 'Paris is the capital of France.',
        }),
      ]);

      expect(rerankRes.scores).toHaveLength(2);
      expect(rerankRes.scores[0]).toBeGreaterThan(rerankRes.scores[1]!);

      expect(verifyRes.result.entailment).toBe('entails');
      expect(verifyRes.result.confidence).toBeGreaterThan(0.5);
    },
    120_000,
  );

  it('is a true process-wide singleton', () => {
    const w1 = getSharedOnnxWorker();
    const w2 = getSharedOnnxWorker();
    expect(w1).toBe(w2);
    expect(w1.started).toBe(true);
    // Exercised for coverage/documentation only — does not tear down the
    // live worker used by the test above (no `.terminate()` call here).
    expect(typeof __resetSharedOnnxWorkerForTests).toBe('function');
  });
});
