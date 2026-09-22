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

// @adhd/sox-embedding-provider is an OPTIONAL dependency (package.json) that
// drags a native chain (onnxruntime / fastembed). Importing this module — for
// the pure `fuse()` or for `StoreSearchBackend` — must NOT resolve it. So the
// ONLY thing taken statically is its type (erased at emit); every VALUE use
// (`getSharedOnnxWorker`, `TransientEmbeddingError`, `ResolutionError`) is
// reached through the lazy loader below, resolved exactly once, on the first
// `createCrossEncoder()` call. See ADR-0019 and `optional-loadability.spec.ts`.
import type { SharedOnnxWorkerClient } from '@adhd/sox-embedding-provider';

/**
 * Non-literal on purpose: a literal `import('@adhd/sox-embedding-provider')` is
 * statically analysable, so a bundler (esbuild/rollup) may hoist it back to an
 * eager import — silently restoring the mandatory native load this package must
 * not have. A non-literal specifier is opaque to static analysis, so it can only
 * ever be a genuine runtime `import()`, taken only when a cross-encoder is built.
 * Mirrors sox-semantic's EMBEDDING_PROVIDER_SPECIFIER.
 */
const EMBEDDING_PROVIDER_SPECIFIER = '@adhd/sox-embedding-provider';

/** The value surface of the optional package, derived from the real package. */
type EmbeddingProviderRuntime = typeof import('@adhd/sox-embedding-provider');

let _runtime: EmbeddingProviderRuntime | null = null;

/**
 * Resolve the optional @adhd/sox-embedding-provider runtime exactly once, on
 * first use of the cross-encoder — NEVER at module load. Maps "not installed"
 * onto a clear error naming the specifier and the remedy, rather than an
 * ERR_MODULE_NOT_FOUND escaping from a package the caller never asked for.
 */
async function embeddingProviderRuntime(): Promise<EmbeddingProviderRuntime> {
  if (_runtime) return _runtime;
  try {
    _runtime = (await import(/* @vite-ignore */ EMBEDDING_PROVIDER_SPECIFIER)) as EmbeddingProviderRuntime;
    return _runtime;
  } catch (err) {
    throw new Error(
      `"${EMBEDDING_PROVIDER_SPECIFIER}" is required by the cross-encoder reranker and could not be ` +
        `loaded. Install it (npm i @adhd/sox-embedding-provider). The pure fusion surface ` +
        `(fuse/normalize/rrfFuse) and StoreSearchBackend over an injected VectorBackend do not need it.`,
      { cause: err },
    );
  }
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
  private shared: SharedOnnxWorkerClient | null = null;
  private readyPromise: Promise<void> | null = null;
  private modelId: string;
  private rt: EmbeddingProviderRuntime;
  private started = false;

  constructor(modelId: string, rt: EmbeddingProviderRuntime) {
    this.modelId = modelId;
    this.rt = rt;
  }

  async start(): Promise<void> {
    // Resolved from the lazily-loaded runtime — the shared worker is a live
    // process-wide singleton (ADR-0018), obtained only when a cross-encoder
    // actually starts, never at module load.
    const shared = this.rt.getSharedOnnxWorker();
    this.shared = shared;

    this.readyPromise = (async () => {
      try {
        await shared.request<InitOkResponse>({
          type: 'init',
          initType: 'rerank',
          modelId: this.modelId,
        });
        this.started = true;
      } catch (e) {
        throw e instanceof Error ? new this.rt.TransientEmbeddingError(e.message) : e;
      }
    })();

    await this.readyPromise;
  }

  async rerank(
    query: string,
    candidates: Array<{ id: number | string; text: string }>,
  ): Promise<Float32Array> {
    const shared = this.assertStarted();
    if (this.readyPromise) await this.readyPromise;

    const mapped = candidates.map((c) => ({ id: String(c.id), text: c.text }));
    try {
      const res = await shared.request<ScoreResponse>({
        type: 'rerank',
        query,
        candidates: mapped,
      });
      return new Float32Array(res.scores);
    } catch (e) {
      throw e instanceof Error ? new this.rt.TransientEmbeddingError(e.message) : e;
    }
  }

  async rerankBatch(
    queries: string[],
    candidateSets: Array<Array<{ id: number | string; text: string }>>,
  ): Promise<Float32Array[]> {
    const shared = this.assertStarted();
    if (this.readyPromise) await this.readyPromise;

    const sets = candidateSets.map((set) =>
      set.map((c) => ({ id: String(c.id), text: c.text })),
    );

    try {
      const res = await shared.request<BatchScoreResponse>({
        type: 'rerankBatch',
        queries,
        candidateSets: sets,
      });
      return res.allScores.map((s) => new Float32Array(s));
    } catch (e) {
      throw e instanceof Error ? new this.rt.TransientEmbeddingError(e.message) : e;
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

  private assertStarted(): SharedOnnxWorkerClient {
    if (!this.started || !this.shared) throw new Error('CrossEncoder worker not started');
    return this.shared;
  }
}

// ── CrossEncoderImpl ───────────────────────────────────────────────────────

class CrossEncoderImpl implements CrossEncoder {
  readonly metadata: CrossEncoderMetadata;
  private worker: CrossEncoderWorker | null = null;
  private startingPromise: Promise<CrossEncoderWorker> | null = null;
  private disposed = false;
  private rt: EmbeddingProviderRuntime;

  constructor(config: CrossEncoderConfig, rt: EmbeddingProviderRuntime) {
    this.rt = rt;
    const modelId = config.modelId;
    const maxTokens = config.options?.maxTokens ?? 512;
    this.metadata = { modelId, maxTokens };
  }

  async rerank(
    query: string,
    candidates: Array<{ id: number | string; text: string }>,
    opts?: { timeoutMs?: number },
  ): Promise<Float32Array> {
    if (this.disposed) throw new this.rt.ResolutionError('CrossEncoder has been disposed');
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
    if (this.disposed) throw new this.rt.ResolutionError('CrossEncoder has been disposed');
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
      const w = new CrossEncoderWorker(this.metadata.modelId, this.rt);
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
  // The single lazy gate: the optional embedding-provider runtime is resolved
  // here and only here, on the first call — never at module load. An absent
  // package fails with the named-specifier message from embeddingProviderRuntime().
  const rt = await embeddingProviderRuntime();
  return new CrossEncoderImpl(config, rt);
}
