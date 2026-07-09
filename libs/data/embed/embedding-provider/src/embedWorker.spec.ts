import { describe, it, expect, afterEach } from 'vitest';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Integration tests for the shared embedWorker.ts — real ONNX inference,
 * no mocks. Exercises BOTH ONNX paths this worker carries (cross-encoder
 * rerank AND NLI verify) directly over the wire protocol, since the
 * `cross-encoder` build state is the sole writer of this file and
 * `nx test hybrid-search` only covers the rerank path via
 * `@adhd/sox-hybrid-search`'s CrossEncoder. The verify path (consumed by
 * `@adhd/sox-claim-verification`) is smoke-tested here so both stub
 * replacements are proven against real models, not left unverified.
 *
 * First run downloads + caches:
 *   - Xenova/ms-marco-MiniLM-L-6-v2 (rerank, ~23MB quantized)
 *   - Xenova/nli-deberta-v3-xsmall (verify, ~87MB quantized)
 */

const REAL_INFERENCE_TIMEOUT_MS = 180_000;

const WORKER_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'embedWorker.js');

interface PendingEntry {
  resolve: (msg: any) => void;
  reject: (err: Error) => void;
}

class TestWorkerClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();

  constructor() {
    this.worker = new Worker(WORKER_PATH);
    this.worker.on('message', (msg: any) => {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      if ('error' in msg) entry.reject(new Error(msg.error));
      else entry.resolve(msg);
    });
    this.worker.on('error', (err) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
  }

  send(payload: Record<string, unknown>): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, ...payload });
    });
  }

  async terminate(): Promise<void> {
    await this.worker.terminate();
  }
}

describe('embedWorker — cross-encoder rerank (real ONNX)', () => {
  let client: TestWorkerClient | null = null;

  afterEach(async () => {
    if (client) {
      await client.terminate();
      client = null;
    }
  });

  it(
    'inits the rerank model and scores a relevant candidate above an irrelevant one',
    async () => {
      client = new TestWorkerClient();
      const initRes = await client.send({ type: 'init', initType: 'rerank', modelId: 'MiniCheck' });
      expect(initRes.initOk).toBe(true);

      const res = await client.send({
        type: 'rerank',
        query: 'What is the capital of France?',
        candidates: [
          { id: 'relevant', text: 'Paris is the capital and most populous city of France.' },
          { id: 'irrelevant', text: 'Bananas are a good source of potassium and fiber.' },
        ],
      });

      expect(res.scores).toHaveLength(2);
      expect(res.scores[0]).toBeGreaterThan(res.scores[1]);
    },
    REAL_INFERENCE_TIMEOUT_MS,
  );
});

describe('embedWorker — NLI verify (real ONNX)', () => {
  let client: TestWorkerClient | null = null;

  afterEach(async () => {
    if (client) {
      await client.terminate();
      client = null;
    }
  });

  it(
    'inits the verify model and entails a claim clearly supported by the source',
    async () => {
      client = new TestWorkerClient();
      const initRes = await client.send({
        type: 'init',
        initType: 'verify',
        modelId: 'MiniCheck',
        modelVersion: '1',
      });
      expect(initRes.initOk).toBe(true);

      const res = await client.send({
        type: 'verify',
        jobId: 'job-1',
        sourceText: 'Paris is the capital of France and its most populous city.',
        claimText: 'Paris is the capital of France.',
      });

      expect(res.result.entailment).toBe('entails');
      expect(res.result.confidence).toBeGreaterThan(0.5);
      expect(typeof res.result.timingMs).toBe('number');
    },
    REAL_INFERENCE_TIMEOUT_MS,
  );

  it(
    'flags a claim that contradicts the source',
    async () => {
      client = new TestWorkerClient();
      await client.send({
        type: 'init',
        initType: 'verify',
        modelId: 'MiniCheck',
        modelVersion: '1',
      });

      const res = await client.send({
        type: 'verify',
        jobId: 'job-2',
        sourceText: 'Paris is the capital of France.',
        claimText: 'Berlin is the capital of France.',
      });

      expect(res.result.entailment).toBe('contradicts');
    },
    REAL_INFERENCE_TIMEOUT_MS,
  );
});
