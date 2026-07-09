/**
 * Cross-encoder reranker using the shared ONNX worker thread.
 *
 * BL-238/BL-171 fix: routes ALL rerank inference through
 * `@adhd/sox-embedding-provider`'s `getSharedOnnxWorker()` — the ONE
 * process-wide onnxruntime-bearing worker allowed to exist (see
 * `sharedOnnxWorker.ts` there for the full root-cause writeup). This
 * package no longer constructs its own `worker_threads.Worker`: doing so
 * would risk a second, concurrent onnxruntime-node native instance in the
 * same process, which crashes the whole process with a V8 HandleScope
 * fatal error (proven via a from-scratch minimal repro — see BL-238).
 */

// TransientEmbeddingError/ResolutionError/getSharedOnnxWorker are used as VALUES
// (thrown + `new` / called) in the hot path, so they must be statically imported
// (not `import type`). embedding-provider is a declared `dependencies` entry of
// this package (see package.json). (Regression surfaced from RS-1/RS-2, 3360f8b.)
import {
  TransientEmbeddingError,
  ResolutionError,
  getSharedOnnxWorker,
  type SharedOnnxWorkerClient,
} from '@adhd/sox-embedding-provider';

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

// ── ONNX shared-worker proxy for cross-encoder ─────────────────────────────
//
// BL-238/BL-171: every rerank request is proxied through the ONE process-wide
// `SharedOnnxWorkerClient` instead of a `Worker` owned by this class — see the
// file header for why.

interface InitOkResponse {
  initOk: true;
  dim?: number;
}

interface ScoreResponse {
  scores: number[];
}

interface BatchScoreResponse {
  allScores: number[][];
}

class CrossEncoderWorker {
  private shared: SharedOnnxWorkerClient;
  private readyPromise: Promise<void> | null = null;
  private modelId: string;
  private started = false;

  constructor(modelId: string) {
    this.modelId = modelId;
    this.shared = getSharedOnnxWorker();
  }

  async start(): Promise<void> {
    this.readyPromise = (async () => {
      try {
        await this.shared.request<InitOkResponse>({
          type: 'init',
          initType: 'rerank',
          modelId: this.modelId,
        });
        this.started = true;
      } catch (e) {
        throw e instanceof Error ? new TransientEmbeddingError(e.message) : e;
      }
    })();

    await this.readyPromise;
  }

  async rerank(
    query: string,
    candidates: Array<{ id: number | string; text: string }>,
  ): Promise<Float32Array> {
    this.assertStarted();
    if (this.readyPromise) await this.readyPromise;

    const mapped = candidates.map((c) => ({ id: String(c.id), text: c.text }));
    try {
      const res = await this.shared.request<ScoreResponse>({
        type: 'rerank',
        query,
        candidates: mapped,
      });
      return new Float32Array(res.scores);
    } catch (e) {
      throw e instanceof Error ? new TransientEmbeddingError(e.message) : e;
    }
  }

  async rerankBatch(
    queries: string[],
    candidateSets: Array<Array<{ id: number | string; text: string }>>,
  ): Promise<Float32Array[]> {
    this.assertStarted();
    if (this.readyPromise) await this.readyPromise;

    const sets = candidateSets.map((set) =>
      set.map((c) => ({ id: String(c.id), text: c.text })),
    );

    try {
      const res = await this.shared.request<BatchScoreResponse>({
        type: 'rerankBatch',
        queries,
        candidateSets: sets,
      });
      return res.allScores.map((s) => new Float32Array(s));
    } catch (e) {
      throw e instanceof Error ? new TransientEmbeddingError(e.message) : e;
    }
  }

  /**
   * Stop using the shared ONNX worker from this instance. Does NOT terminate
   * the underlying shared worker — fastembed embeddings and/or the NLI
   * verifier may still depend on it (BL-238).
   */
  async stop(): Promise<void> {
    this.started = false;
    this.readyPromise = null;
  }

  private assertStarted(): void {
    if (!this.started) throw new Error('CrossEncoder worker not started');
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
