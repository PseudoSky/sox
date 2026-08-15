import { warmupTimeoutMs, isModelCached, WARMUP_CACHE_HIT_ATTEMPTS } from './index.js';
import { getSharedFastembedProcess, type SharedFastembedClient } from './sharedFastembedProcess.js';
import type { EmbeddingHealth, EmbeddingProvider, EmbeddingProviderMetadata, EmbedRole } from './index.js';
// BUG-005: MODEL_CONFIGS lives in the side-effect-free `fastembedModels.js`
// (shared with the child-process host) — see that module's doc comment for
// why it cannot be imported from this file by the child. Re-exported below
// (the bottom `export { ... }` re-exports this imported binding) unchanged,
// so every existing consumer (`index.js`, `cache.js`, the bl376 /
// warmup-cachehit specs) keeps working.
import { MODEL_CONFIGS } from './fastembedModels.js';

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
  // the full root-cause writeup. (BUG-MEMORY-EMBED-HEAD-OF-LINE-BLOCKING-001)
  // Typed against the `SharedFastembedClient` interface, not the concrete
  // single-child class, so this transparently accepts either a lone
  // `SharedFastembedProcessClient` (tests) or the pooled
  // `FastembedProcessPool` (`getSharedFastembedProcess()`'s real return type).
  private shared: SharedFastembedClient;
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
    sharedClient: SharedFastembedClient = getSharedFastembedProcess(),
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
    const hfRepoId = MODEL_CONFIGS[this.model]?.hfRepoId;
    const cacheHit = hfRepoId ? isModelCached(this.cacheDir, hfRepoId) : false;
    // BUG-EMBED-WARMUP-CACHEHIT-ASSUMES-FAST-LOAD-001: a cache-hit warmup gets
    // WARMUP_CACHE_HIT_ATTEMPTS attempts at the same tight per-attempt budget
    // (unchanged from BL-376) instead of a single shot. A retry's IPC request
    // queues behind the still-running first attempt in the shared child's
    // serialized request queue and resolves once that load finishes, so a
    // retry is not wasted work — it is the second chance to observe a load
    // that was already going to succeed, just not within one tight window.
    // Cache-miss keeps exactly one attempt (unchanged): a stuck download is a
    // different failure mode, out of scope here.
    const attempts = cacheHit ? WARMUP_CACHE_HIT_ATTEMPTS : 1;
    let lastErr: Error = new Error('initModel: no attempt was made');
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
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
        return;
      } catch (e) {
        lastErr = e instanceof Error ? e : new Error(String(e));
        // Intermediate attempt failed — loop and retry (no logging dependency
        // added here; sharedFastembedProcess.ts already emits
        // fastembed_process.request.error/.finish telemetry per attempt with
        // queue_depth visible on each, which is sufficient observability).
      }
    }
    // Final attempt failed: preserve today's behaviour exactly.
    this._lastError = lastErr.message;
    // Allow a subsequent call to retry initialisation rather than being
    // permanently stuck on a failed readyPromise.
    this.readyPromise = null;
    throw lastErr;
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
