import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ResolutionError } from './index.js';
import type { EmbeddingHealth, EmbeddingProvider, EmbeddingProviderMetadata, EmbedRole, FastEmbedModelConfig } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface WorkerRequest {
  id: number;
  type: 'init';
  model: string;
  cacheDir: string;
}

interface EmbedWorkerRequest {
  id: number;
  type: 'embed';
  text: string;
}

interface EmbedBatchWorkerRequest {
  id: number;
  type: 'embedBatch';
  texts: string[];
}

interface InitOkResponse {
  id: number;
  initOk: true;
  dim: number;
}

interface EmbedResponse {
  id: number;
  embedding: number[];
}

interface EmbedBatchResponse {
  id: number;
  embeddings: number[][];
}

interface ErrorResponse {
  id: number;
  error: string;
}

type WorkerMessage = InitOkResponse | EmbedResponse | EmbedBatchResponse | ErrorResponse;

const MODEL_CONFIGS: Record<string, FastEmbedModelConfig> = {
  'bge-small-en-v1.5': {
    modelId: 'bge-small-en-v1.5',
    hfRepoId: 'fast-bge-small-en-v1.5',
    dim: 384,
    maxTokens: 512,
    description: 'BGE Small English v1.5 — lightweight 384-dim embedding, ~33M params',
  },
  'bge-base-en-v1.5': {
    modelId: 'bge-base-en-v1.5',
    hfRepoId: 'fast-bge-base-en-v1.5',
    dim: 768,
    maxTokens: 512,
    description: 'BGE Base English v1.5 — balanced 768-dim embedding, ~110M params',
  },
  'multilingual-e5-large': {
    modelId: 'multilingual-e5-large',
    hfRepoId: 'fast-multilingual-e5-large',
    dim: 1024,
    maxTokens: 512,
    description: 'Multilingual E5 Large — 1024-dim, 100+ languages, ~335M params',
  },
  'bge-m3': {
    modelId: 'bge-m3',
    hfRepoId: 'BAAI/bge-m3',
    dim: 1024,
    maxTokens: 8192,
    description: 'BGE-M3 — 570M params, 8192-token context, 100+ languages, ONNX INT8',
  },
  'codexembed-400m': {
    modelId: 'codexembed-400m',
    hfRepoId: 'microsoft/codexembed-400m',
    dim: 1024,
    maxTokens: 8192,
    description: 'CodeXEmbed-400M — code-only CPU, ~1.6GB RAM, 8192-token context',
  },
};

/** @deprecated Use MODEL_CONFIGS[modelId].dim instead. */
const MODEL_DIMS: Record<string, number> = Object.fromEntries(
  Object.entries(MODEL_CONFIGS).map(([id, cfg]) => [id, cfg.dim]),
);

/** @deprecated Use MODEL_CONFIGS[modelId].maxTokens instead. */
const MODEL_MAX_TOKENS: Record<string, number> = Object.fromEntries(
  Object.entries(MODEL_CONFIGS).map(([id, cfg]) => [id, cfg.maxTokens]),
);

const DEFAULT_MODEL = 'bge-base-en-v1.5';
const DEFAULT_BATCH_SIZE = 256;

function warmupTimeoutMs(): number {
  const raw = Number(process.env['SOX_EMBED_WARMUP_TIMEOUT_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/**
 * Real ONNX embedding provider using fastembed-js.
 *
 * Runs inference in a worker thread (BL-11 boundary) — onnxruntime-node
 * never runs on the main thread alongside better-sqlite3 + sqlite-vec.
 */
export class FastembedProvider implements EmbeddingProvider {
  readonly metadata: EmbeddingProviderMetadata;
  private model: string;
  private cacheDir: string;
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: number[] | number[][] | { dim: number }) => void; reject: (e: Error) => void }
  >();
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private embedDim = 0;
  private maxTokensVal = 512;
  private _lastError: string | null = null;

  constructor(model: string, dimensions: number, cacheDir: string) {
    this.model = model;
    this.cacheDir = cacheDir;
    this.embedDim = dimensions;
    const cfg = MODEL_CONFIGS[model];
    this.maxTokensVal = cfg?.maxTokens ?? 512;
    this.metadata = {
      modelId: model,
      dimensions,
      maxTokens: this.maxTokensVal,
      isRemote: false,
      isDeterministic: false,
      providerUri: `local:onnx:${model}`,
    };
  }

  health(): EmbeddingHealth {
    let state: EmbeddingHealth['state'] = 'uninitialized';
    if (this._lastError) {
      state = 'error';
    } else if (this.ready) {
      state = 'real';
    } else if (this.readyPromise) {
      state = 'warming';
    }
    return {
      configured: `fastembed:${this.model}`,
      active: this.ready ? this.metadata.modelId : null,
      state,
      dimensions: this.embedDim || this.metadata.dimensions,
      last_error: this._lastError,
    };
  }

  async embedSingle(text: string, _role?: EmbedRole): Promise<Float32Array> {
    // Chunk-then-mean-pool for text exceeding maxTokens (D7: no truncation)
    if (this.estimateTokens(text) > this.maxTokensVal) {
      const chunks = this.chunkText(text, this.maxTokensVal);
      const embeddings: Float32Array[] = [];
      const worker = this.getWorker();
      await this.ensureReady();
      for (const chunk of chunks) {
        const vec = await new Promise<Float32Array>((resolve, reject) => {
          const id = this.nextId++;
          this.pending.set(id, {
            resolve: (v: number[] | number[][] | { dim: number }) => {
              resolve(this.toFloat32Normalised(v as number[]));
            },
            reject,
          });
          worker.postMessage({ id, type: 'embed', text: chunk } satisfies EmbedWorkerRequest);
        });
        embeddings.push(vec);
      }
      return this.meanPool(embeddings);
    }

    const worker = this.getWorker();
    await this.ensureReady();

    return new Promise<Float32Array>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: (v: number[] | number[][] | { dim: number }) => {
          const vec = v as number[];
          resolve(this.toFloat32Normalised(vec));
        },
        reject,
      });
      worker.postMessage({ id, type: 'embed', text } satisfies EmbedWorkerRequest);
    });
  }

  async *embedBatch(
    texts: string[],
    opts?: { role?: EmbedRole; batchSize?: number },
  ): AsyncIterable<Float32Array> {
    void opts?.role;
    const worker = this.getWorker();
    await this.ensureReady();

    const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      // Check if any text in the batch exceeds maxTokens
      const needsChunking = batch.some((t) => this.estimateTokens(t) > this.maxTokensVal);
      if (needsChunking) {
        // Process each text individually with chunk-then-mean-pool
        for (const text of batch) {
          yield await this.embedSingle(text, opts?.role);
        }
      } else {
        const embeddings = await this.sendBatch(worker, batch);
        for (const vec of embeddings) {
          yield this.toFloat32Normalised(vec);
        }
      }
    }
  }

  async warmUp(texts: string[]): Promise<void> {
    // No-op: isDeterministic is false, cache would be unreliable.
    // Real warmup requires the worker to be initialized, which happens
    // lazily on the first embedSingle/embedBatch call.
    void texts;
  }

  /**
   * Rough token estimation: ~4 characters per token.
   * Used for chunk-then-mean-pool boundary detection.
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Split text into chunks that fit within maxTokens.
   * Splits on whitespace boundaries near the token limit for clean breaks.
   */
  private chunkText(text: string, maxTokens: number): string[] {
    const maxChars = maxTokens * 4;
    if (text.length <= maxChars) return [text];

    const chunks: string[] = [];
    let start = 0;
    while (start < text.length) {
      let end = Math.min(start + maxChars, text.length);
      // Back up to nearest whitespace if not at end of text
      if (end < text.length) {
        const lastSpace = text.lastIndexOf(' ', end);
        if (lastSpace > start) end = lastSpace;
      }
      chunks.push(text.slice(start, end));
      start = end;
    }
    return chunks;
  }

  /**
   * Mean-pool multiple embedding vectors into one.
   * All vectors must have the same length.
   */
  private meanPool(vectors: Float32Array[]): Float32Array {
    if (vectors.length === 0) return new Float32Array(0);
    if (vectors.length === 1) return vectors[0]!;
    const dim = vectors[0]!.length;
    const pooled = new Float32Array(dim);
    for (const vec of vectors) {
      for (let i = 0; i < dim; i++) {
        pooled[i]! += vec[i]!;
      }
    }
    const n = vectors.length;
    for (let i = 0; i < dim; i++) {
      pooled[i] = pooled[i]! / n;
    }
    // Normalise the pooled vector
    let norm = 0;
    for (let i = 0; i < dim; i++) {
      norm += pooled[i]! * pooled[i]!;
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) {
      pooled[i] = pooled[i]! / norm;
    }
    return pooled;
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;

    const workerPath = join(__dirname, 'embedWorker.js');
    this.worker = new Worker(workerPath, {
      workerData: { cacheDir: this.cacheDir },
    });
    this.worker.unref();

    this.worker.on('message', (msg: WorkerMessage) => {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if ('error' in msg) {
        pending.reject(new Error(msg.error));
      } else if ('initOk' in msg) {
        this.embedDim = msg.dim;
        pending.resolve({ dim: msg.dim });
      } else if ('embedding' in msg) {
        pending.resolve(msg.embedding);
      } else if ('embeddings' in msg) {
        pending.resolve(msg.embeddings);
      }
    });

    this.worker.on('error', (err) => {
      this._lastError = err.message;
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.worker = null;
      this.ready = false;
      this.readyPromise = null;
    });

    this.worker.on('exit', (code) => {
      if (code !== 0) {
        const err = new Error(`embedWorker exited with code ${code}`);
        this._lastError = err.message;
        for (const { reject } of this.pending.values()) reject(err);
        this.pending.clear();
      }
      this.worker = null;
      this.ready = false;
      this.readyPromise = null;
    });

    // BL-fix (surfaced by tools/e2e/substrate-pipeline.test.mjs — the first
    // real, non-vitest-force-killed process to let this worker run to
    // completion): attaching a `'message'` listener on a `Worker` re-refs its
    // underlying MessagePort even if `.unref()` was already called earlier
    // (the very first `.unref()` above ran before any listener existed, so it
    // was silently undone by the `.on('message', ...)` registration a few
    // lines later). Re-assert unref here, now that every listener is
    // attached, so a real (non-test-harness) Node process can actually exit
    // once its own work is done instead of hanging on this worker forever.
    this.worker.unref();

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const id = this.nextId++;
      const to = setTimeout(() => {
        this.pending.delete(id);
        const err = new Error(
          `Fastembed worker init timed out after ${warmupTimeoutMs()}ms`,
        );
        reject(err);
      }, warmupTimeoutMs());
      if (typeof to.unref === 'function') to.unref();

      this.pending.set(id, {
        resolve: (v: number[] | number[][] | { dim: number }) => {
          clearTimeout(to);
          const dimResult = v as { dim: number };
          if (dimResult.dim > 0) {
            this.embedDim = dimResult.dim;
          }
          this.ready = true;
          this._lastError = null;
          resolve();
        },
        reject: (e: Error) => {
          clearTimeout(to);
          this._lastError = e.message;
          reject(e);
        },
      });

      this.worker!.postMessage({
        id,
        type: 'init',
        model: this.model,
        cacheDir: this.cacheDir,
      } satisfies WorkerRequest);
    });

    return this.worker;
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) return;
    if (this.readyPromise) {
      await this.readyPromise;
      return;
    }
    throw new ResolutionError('Fastembed provider not initialized');
  }

  private sendBatch(worker: Worker, texts: string[]): Promise<number[][]> {
    return new Promise<number[][]>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: (v: number[] | number[][] | { dim: number }) => resolve(v as number[][]),
        reject,
      });
      worker.postMessage({
        id,
        type: 'embedBatch',
        texts,
      } satisfies EmbedBatchWorkerRequest);
    });
  }

  private toFloat32Normalised(raw: number[]): Float32Array {
    const dim = this.embedDim || raw.length;
    const vec = new Float32Array(dim);
    let norm = 0;
    for (let i = 0; i < dim && i < raw.length; i++) {
      vec[i] = raw[i] ?? 0;
      norm += vec[i]! * vec[i]!;
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) {
      vec[i] = vec[i]! / norm;
    }
    return vec;
  }
}

export { MODEL_CONFIGS, MODEL_DIMS, MODEL_MAX_TOKENS, DEFAULT_MODEL, DEFAULT_BATCH_SIZE };
