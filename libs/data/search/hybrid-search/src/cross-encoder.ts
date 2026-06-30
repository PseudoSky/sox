import { Worker } from 'node:worker_threads';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TransientEmbeddingError,
  ResolutionError,
} from '@adhd/sox-embedding-provider';

/**
 * Resolve the path to the cross-encoder worker file, handling both ESM (vitest/dev)
 * and CJS (bundled) environments. The dirname is computed at call time (not module
 * level) so CJS bundles don't crash on undefined import.meta.url during module load.
 */
function resolveWorkerPath(): string {
  let baseDir: string;
  try {
    baseDir = dirname(fileURLToPath(import.meta.url));
  } catch {
    // CJS bundle or environment without import.meta.url — schema generation
    // never calls rerank(), so this path is only exercised at runtime.
    baseDir = '.';
  }

  const tsPath = join(baseDir, 'crossEncoderWorker.ts');
  const jsPath = join(baseDir, 'crossEncoderWorker.js');

  if (existsSync(tsPath)) return tsPath;
  return jsPath;
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface CrossEncoderMetadata {
  modelId: string;
  maxTokens: number;
}

export interface CrossEncoderConfig {
  modelId: string;
  options?: {
    maxTokens?: number;
  };
}

export interface CrossEncoder {
  readonly metadata: CrossEncoderMetadata;

  rerank(
    query: string,
    candidates: Array<{ id: number | string; text: string }>,
    opts?: { timeoutMs?: number },
  ): Promise<Float32Array>;

  rerankBatch(
    queries: string[],
    candidateSets: Array<Array<{ id: number | string; text: string }>>,
    opts?: { timeoutMs?: number },
  ): Promise<Float32Array[]>;

  dispose(): Promise<void>;
}

// ── Reranker mode (for HybridSearchConfig) ─────────────────────────────────

export interface CrossEncoderRerankerConfig {
  mode: 'always-on' | 'threshold-gated' | 'skip';
  modelId: string;
  maxCandidates?: number;
  gateThreshold?: number;
}

// ── Worker proxy ───────────────────────────────────────────────────────────

interface WorkerScoreRequest {
  id: number;
  type: 'rerank';
  query: string;
  candidates: Array<{ id: string; text: string }>;
}

interface WorkerBatchRequest {
  id: number;
  type: 'rerankBatch';
  queries: string[];
  candidateSets: Array<Array<{ id: string; text: string }>>;
}

interface WorkerInitRequest {
  id: number;
  type: 'init';
  modelId: string;
}

interface WorkerScoreResponse {
  id: number;
  scores: number[];
}

interface WorkerBatchResponse {
  id: number;
  allScores: number[][];
}

interface WorkerErrorResponse {
  id: number;
  error: string;
}

type WorkerMessage = WorkerScoreResponse | WorkerBatchResponse | WorkerErrorResponse;

// ── ONNX worker thread for cross-encoder ───────────────────────────────────

class CrossEncoderWorker {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: number[] | number[][]) => void; reject: (e: Error) => void }
  >();
  private readyPromise: Promise<void> | null = null;
  private modelId: string;

  constructor(modelId: string) {
    this.modelId = modelId;
  }

  async start(): Promise<void> {
    const workerPath = resolveWorkerPath();
    this.worker = new Worker(workerPath);
    this.worker.unref();

    this.worker.on('message', (msg: WorkerMessage) => {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if ('error' in msg) {
        pending.reject(new TransientEmbeddingError(msg.error));
      } else if ('scores' in msg) {
        pending.resolve(msg.scores);
      } else if ('allScores' in msg) {
        pending.resolve(msg.allScores);
      }
    });

    this.worker.on('error', (err) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.worker = null;
    });

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: () => {
          resolve();
        },
        reject: (e) => {
          reject(e);
        },
      });
      this.worker!.postMessage({
        id,
        type: 'init',
        modelId: this.modelId,
      } satisfies WorkerInitRequest);
    });

    await this.readyPromise;
  }

  async rerank(
    query: string,
    candidates: Array<{ id: number | string; text: string }>,
  ): Promise<Float32Array> {
    const worker = this.getWorker();
    if (this.readyPromise) await this.readyPromise;

    const mapped = candidates.map((c) => ({ id: String(c.id), text: c.text }));
    return new Promise<Float32Array>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: (v) => resolve(new Float32Array(v as number[])),
        reject,
      });
      worker.postMessage({
        id,
        type: 'rerank',
        query,
        candidates: mapped,
      } satisfies WorkerScoreRequest);
    });
  }

  async rerankBatch(
    queries: string[],
    candidateSets: Array<Array<{ id: number | string; text: string }>>,
  ): Promise<Float32Array[]> {
    const worker = this.getWorker();
    if (this.readyPromise) await this.readyPromise;

    const sets = candidateSets.map((set) =>
      set.map((c) => ({ id: String(c.id), text: c.text })),
    );

    return new Promise<Float32Array[]>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: (v) => resolve((v as number[][]).map((s) => new Float32Array(s))),
        reject,
      });
      worker.postMessage({
        id,
        type: 'rerankBatch',
        queries,
        candidateSets: sets,
      } satisfies WorkerBatchRequest);
    });
  }

  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
    this.readyPromise = null;
  }

  private getWorker() {
    if (!this.worker) throw new Error('CrossEncoder worker not started');
    return this.worker;
  }
}

// ── CrossEncoderImpl ───────────────────────────────────────────────────────

class CrossEncoderImpl implements CrossEncoder {
  readonly metadata: CrossEncoderMetadata;
  private worker: CrossEncoderWorker | null = null;
  private startingPromise: Promise<CrossEncoderWorker> | null = null;
  private disposed = false;

  constructor(config: CrossEncoderConfig) {
    const modelId = config.modelId;
    const maxTokens = config.options?.maxTokens ?? 512;
    this.metadata = { modelId, maxTokens };
  }

  async rerank(
    query: string,
    candidates: Array<{ id: number | string; text: string }>,
    opts?: { timeoutMs?: number },
  ): Promise<Float32Array> {
    if (this.disposed) throw new ResolutionError('CrossEncoder has been disposed');
    const worker = await this.getWorker();
    const timeoutMs = opts?.timeoutMs ?? 30000;
    const result = worker.rerank(query, candidates);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`CrossEncoder rerank timed out after ${timeoutMs}ms`)), timeoutMs),
    );
    return Promise.race([result, timeout]) as Promise<Float32Array>;
  }

  async rerankBatch(
    queries: string[],
    candidateSets: Array<Array<{ id: number | string; text: string }>>,
    opts?: { timeoutMs?: number },
  ): Promise<Float32Array[]> {
    if (this.disposed) throw new ResolutionError('CrossEncoder has been disposed');
    const worker = await this.getWorker();
    const timeoutMs = opts?.timeoutMs ?? 30000;
    const result = worker.rerankBatch(queries, candidateSets);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`CrossEncoder rerankBatch timed out after ${timeoutMs}ms`)), timeoutMs),
    );
    return Promise.race([result, timeout]) as Promise<Float32Array[]>;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.worker) {
      await this.worker.stop();
      this.worker = null;
    }
  }

  private async getWorker(): Promise<CrossEncoderWorker> {
    if (this.worker) return this.worker;
    if (this.startingPromise) return this.startingPromise;

    this.startingPromise = (async () => {
      const w = new CrossEncoderWorker(this.metadata.modelId);
      await w.start();
      this.worker = w;
      this.startingPromise = null;
      return w;
    })();

    return this.startingPromise;
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

export async function createCrossEncoder(
  config: CrossEncoderConfig,
): Promise<CrossEncoder> {
  const encoder = new CrossEncoderImpl(config);
  return encoder;
}
