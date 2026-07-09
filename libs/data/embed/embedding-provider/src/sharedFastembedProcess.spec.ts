import { describe, it, expect } from 'vitest';
import { createEmbeddingProvider } from './index.js';
import { getSharedFastembedProcess } from './sharedFastembedProcess.js';

/**
 * BL-238/BL-171 regression test — real ONNX inference, no mocks.
 *
 * Before the fix, running 2+ `worker_threads.Worker` instances each hosting
 * an active onnxruntime-node `InferenceSession` and running inference
 * CONCURRENTLY crashed the entire process with a native V8 fatal error:
 *
 *   FATAL ERROR: HandleScope::HandleScope Entering the V8 API without
 *   proper locking in place
 *
 * reproduced even with two `FastembedProvider` instances using the exact
 * same onnxruntime-node version (no ABI/version mismatch involved at all —
 * see BACKLOG.md BL-238 for the full repro matrix and a from-scratch minimal
 * repro outside this test harness).
 *
 * This test creates TWO independent `FastembedProvider` instances (via the
 * public `createEmbeddingProvider` factory) and runs real embed inference on
 * both CONCURRENTLY (`Promise.all`) in this one vitest process. Because both
 * now route through `getSharedFastembedProcess()` — the ONE process-wide
 * fastembed child PROCESS — there is only ever one fastembed-hosting
 * process alive, so the crash class is structurally impossible.
 */
describe('BL-238/BL-171 — concurrent fastembed consumers share ONE child process (no crash)', () => {
  it(
    'two concurrent FastembedProvider instances both complete real embed inference without crashing the process',
    async () => {
      const [providerA, providerB] = await Promise.all([
        createEmbeddingProvider({ type: 'fastembed', model: 'bge-small-en-v1.5' }),
        createEmbeddingProvider({ type: 'fastembed', model: 'bge-small-en-v1.5' }),
      ]);

      // Real concurrent ONNX inference on both providers at once — this is
      // exactly the shape that crashed the whole process pre-fix (repro (c)
      // in BL-238: 2x fastembed workers, same onnxruntime-node version).
      const textsA = Array.from({ length: 8 }, (_, i) => `provider A text ${i}: apples and oranges`);
      const textsB = Array.from({ length: 8 }, (_, i) => `provider B text ${i}: cars and airplanes`);

      const [vecsA, vecsB] = await Promise.all([
        Promise.all(textsA.map((t) => providerA.embedSingle(t))),
        Promise.all(textsB.map((t) => providerB.embedSingle(t))),
      ]);

      expect(vecsA).toHaveLength(8);
      expect(vecsB).toHaveLength(8);
      for (const v of [...vecsA, ...vecsB]) {
        expect(v).toBeInstanceOf(Float32Array);
        expect(v.length).toBe(384); // bge-small-en-v1.5 dimensions
        // Real (non-zero, non-mocked) inference — a genuine embedding is
        // never the exact zero vector.
        expect(v.some((x) => x !== 0)).toBe(true);
      }

      // Both providers must have produced DIFFERENT embeddings for
      // different input text (sanity check that this is real inference,
      // not a stub returning a constant vector).
      expect(Array.from(vecsA[0]!)).not.toEqual(Array.from(vecsB[0]!));
    },
    120_000,
  );

  it('both provider instances above are backed by the exact same shared fastembed process singleton', () => {
    const p1 = getSharedFastembedProcess();
    const p2 = getSharedFastembedProcess();
    expect(p1).toBe(p2);
    expect(p1.started).toBe(true);
  });
});
