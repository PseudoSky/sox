import { warmupTimeoutMs, isModelCached } from './index.js';
import { getSharedFastembedProcess, type SharedFastembedProcessClient } from './sharedFastembedProcess.js';
import type { EmbeddingHealth, EmbeddingProvider, EmbeddingProviderMetadata, EmbedRole, FastEmbedModelConfig } from './index.js';

interface InitOkResponse {
  initOk: true;
  dim: number;
  execution_provider: string;
}

interface EmbedResponse {
  embedding: number[];
}

interface EmbedBatchResponse {
  embeddings: number[][];
}

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

/**
 * Real ONNX embedding provider using fastembed-js.
 *
 * Runs inference in a dedicated child PROCESS (BL-238/BL-171), never the
 * main thread and never a `worker_threads.Worker` shared with
 * `@huggingface/transformers`-based inference (rerank/verify) — see
 * `sharedFastembedProcess.ts` / `fastembedProcessHost.ts` for the full
 * root-cause writeup on why fastembed's onnxruntime-node@1.21.0 cannot
 * safely share a thread with onnxruntime-node@1.24.3, even sequentially.
 */
export class FastembedProvider implements EmbeddingProvider {
  readonly metadata: EmbeddingProviderMetadata;
  private model: string;
  private cacheDir: string;
  // BL-238/BL-171 fix: delegate ALL fastembed ONNX inference to the
  // process-wide shared fastembed CHILD PROCESS singleton instead of
  // spawning our own `Worker`/process — see `sharedFastembedProcess.ts` for
  // the full root-cause writeup.
  private shared: SharedFastembedProcessClient;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private embedDim = 0;
  private maxTokensVal = 512;
  private _lastError: string | null = null;
  private _executionProvider: string = 'cpu';

  /**
   * @param sharedClient Test-only injection point (BL-376): production code
   * always relies on the default `getSharedFastembedProcess()` singleton.
   * Tests pass a fake client here to inject an artificial init delay without
   * forking a real fastembed child process or downloading a model.
   */
  constructor(
    model: string,
    dimensions: number,
    cacheDir: string,
    sharedClient: SharedFastembedProcessClient = getSharedFastembedProcess(),
  ) {
    this.model = model;
    this.cacheDir = cacheDir;
    this.embedDim = dimensions;
    this.shared = sharedClient;
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
      execution_provider: this._executionProvider,
    };
  }

  async embedSingle(text: string, _role?: EmbedRole): Promise<Float32Array> {
    // Chunk-then-mean-pool for text exceeding maxTokens (D7: no truncation)
    if (this.estimateTokens(text) > this.maxTokensVal) {
      const chunks = this.chunkText(text, this.maxTokensVal);
      const embeddings: Float32Array[] = [];
      await this.ensureReady();
      for (const chunk of chunks) {
        const res = await this.shared.request<EmbedResponse>({ type: 'embed', text: chunk });
        embeddings.push(this.toFloat32Normalised(res.embedding));
      }
      return this.meanPool(embeddings);
    }

    await this.ensureReady();
    const res = await this.shared.request<EmbedResponse>({ type: 'embed', text });
    return this.toFloat32Normalised(res.embedding);
  }

  async *embedBatch(
    texts: string[],
    opts?: { role?: EmbedRole; batchSize?: number },
  ): AsyncIterable<Float32Array> {
    void opts?.role;
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
        const embeddings = await this.sendBatch(batch);
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

  /**
   * Lazily initialise this provider's model on the shared ONNX worker.
   * Idempotent: concurrent callers await the same in-flight init.
   */
  private ensureReady(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (!this.readyPromise) {
      this.readyPromise = this.initModel();
    }
    return this.readyPromise;
  }

  private async initModel(): Promise<void> {
    try {
      const hfRepoId = MODEL_CONFIGS[this.model]?.hfRepoId;
      const cacheHit = hfRepoId ? isModelCached(this.cacheDir, hfRepoId) : false;
      const res = await this.shared.request<InitOkResponse>(
        { type: 'init', model: this.model, cacheDir: this.cacheDir },
        warmupTimeoutMs(cacheHit),
      );
      if (res.dim > 0) {
        this.embedDim = res.dim;
      }
      this._executionProvider = res.execution_provider || 'cpu';
      this.ready = true;
      this._lastError = null;
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this._lastError = err.message;
      // Allow a subsequent call to retry initialisation rather than being
      // permanently stuck on a failed readyPromise.
      this.readyPromise = null;
      throw err;
    }
  }

  private async sendBatch(texts: string[]): Promise<number[][]> {
    const res = await this.shared.request<EmbedBatchResponse>({ type: 'embedBatch', texts });
    return res.embeddings;
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
