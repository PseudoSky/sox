/**
 * embedding-provider.ts — public contract for @adhd/sox-embedding-provider.
 *
 * Package path: libs/data/embed/embedding-provider/
 * Execution context: w2a-embedding-provider
 * Published: public@0.x (ADR-0006)
 *
 * Key invariants this contract encodes:
 *   [def:loud-fail]   — resolveProvider THROWS if the real backend cannot load.
 *                       No silent hash downgrade exists.
 *   [inv:loud-fail]   — the hash/deterministic provider is first-class and
 *                       explicit-only; never an implicit fallback.
 *   local‖remote-agnostic — EmbedProvider is valid for in-process ONNX AND network
 *                       providers (async, batch-first, no in-process assumptions).
 *   BL-11 worker seam — real embed() runs in a worker_thread; the interface does not
 *                       expose the thread but implementors must preserve the boundary.
 *
 * Resolves demo stubs: U1, U2, U3, U4, U5, U6 + REQ-005 warmCache.
 * See CONTRACTS.md §Stub-resolution table.
 */

import type { EmbeddingVector, ProviderMetadata } from './types.js';

// ── Provider interface ─────────────────────────────────────────────────────────

/** Options for embedBatch. */
export interface EmbedBatchOpts {
  /**
   * Block size for ONNX batch inference. Default 256.
   * fastembed-js processes inputs in blocks of this size; tuning affects throughput.
   */
  batchSize?: number;
}

/**
 * The public contract every provider (local ONNX or remote) must implement.
 *
 * Extends ProviderMetadata so callers always have access to the provider's identity
 * ({providerId, modelId, dim, isDeterministic, isRemote}) without a separate call.
 *
 * Design: local‖remote-agnostic. The interface has NO in-process assumptions — every
 * method is async and batch-first. A remote HTTP adapter is a valid conformer.
 *
 * Resolves:
 *   U3 — embedBatch method (on the provider instance, AsyncGenerator, batchSize option)
 *   U6 — no dispose() method; GC releases the ONNX session on process exit
 */
export interface EmbedProvider extends ProviderMetadata {
  /**
   * Embed a single text. Returns a L2-normalised Float32Array of length this.dim.
   * For N≥2 texts use embedBatch — N serial embed() calls are the N×latency footgun.
   *
   * BL-11: the real implementation routes through a worker_thread; this call never
   * blocks the main thread alongside an open better-sqlite3 connection.
   */
  embed(text: string): Promise<EmbeddingVector>;

  /**
   * Embed multiple texts as a streaming async generator.
   * Yields one Float32Array per text, in input order.
   *
   * Default batchSize 256 (fastembed-js batch inference block).
   * The generator must be fully consumed before results are valid.
   *
   * Usage:
   *   for await (const vec of provider.embedBatch(texts)) { ... }
   */
  embedBatch(texts: string[], opts?: EmbedBatchOpts): AsyncGenerator<EmbeddingVector>;

  /**
   * Optional query-optimized embedding for asymmetric retrieval models.
   * When absent, callers fall back to embed(). Implementors of symmetric models
   * (bge-*, e5-*) may omit this; it is meaningful only for asymmetric models
   * (e.g. msmarco distilbert).
   */
  queryEmbed?(text: string): Promise<EmbeddingVector>;

  /**
   * Optional startup cache warm-up for hot/topic embeddings.
   * When present, embed() calls for these texts will be served from an in-memory Map
   * without ONNX inference, eliminating per-call latency for frequently-embedded strings.
   *
   * Resolves REQ-005 (USE_CASES UC-EMB-5): "startup Map cache for hot/topic embeddings."
   * Cache is keyed by text string; eviction policy is implementation-defined.
   *
   * Usage:
   *   await provider.warmCache(['code review', 'technical debt', ...topicNames]);
   */
  warmCache?(texts: string[]): Promise<void>;
}

// ── Provider configuration ─────────────────────────────────────────────────────

/**
 * Configuration for resolveProvider.
 *
 * 'real'   — local ONNX via fastembed-js. THROWS ProviderLoadError if unavailable.
 *            Ships ≥3 models spanning dims from the gate:
 *              'BAAI/bge-small-en-v1.5'  → dim 384
 *              'BAAI/bge-base-en-v1.5'   → dim 768 (default when model is omitted)
 *              'intfloat/e5-large-v2'    → dim 1024
 *            providerId: 'fastembed'
 *
 * 'hash'   — deterministic FNV-1a hash projection. First-class, explicit-only.
 *            NEVER an implicit fallback ([def:loud-fail]).
 *            isDeterministic: true. Used for testing + offline scenarios.
 *
 * 'remote' — typed reference implementation against the same EmbedProvider contract.
 *            Not wired to a live/paid endpoint (isRemote:true, no-cost reference impl).
 *            Proves the interface is context-agnostic without incurring F3 spend.
 *            Requires endpoint for a live deployment (not enforced in the reference impl).
 *
 * Resolves:
 *   U1 — 'model' is the config key for model selection
 *   U2 — exact model string IDs and providerId
 *   U5 — remote backend instantiation via backend:'remote' + optional endpoint
 */
export interface ProviderConfig {
  backend: 'real' | 'hash' | 'remote';

  /**
   * fastembed model identifier (backend:'real').
   * Defaults to 'BAAI/bge-base-en-v1.5' (768-dim) when omitted.
   * The active model's dim MUST be used to parameterize applyVecSchema — NEVER hard-code 768.
   */
  model?: string;

  /**
   * Filesystem path for the ONNX model cache.
   * Default: ~/.cache/sox-memory/models (or $XDG_CACHE_HOME/sox-memory/models).
   */
  cacheDir?: string;

  /**
   * Remote provider endpoint (backend:'remote' only).
   * The reference implementation ignores this; a live deployment requires it.
   */
  endpoint?: string;
}

// ── Errors ─────────────────────────────────────────────────────────────────────

/**
 * Thrown by resolveProvider when backend:'real' cannot load its ONNX provider.
 *
 * [def:loud-fail]: there is NO silent fallback to the hash provider.
 * The message includes the configured model name and the underlying cause.
 * Callers catching this must make the failure visible to the operator.
 *
 * Resolves U4 — diagnosable error type for real-provider load failure.
 */
export class ProviderLoadError extends Error {
  /** The ProviderConfig that triggered the failure. */
  public readonly config: ProviderConfig;
  /** The underlying error from the ONNX/fastembed layer, if available. */
  public readonly cause: unknown;

  constructor(message: string, config: ProviderConfig, cause?: unknown) {
    super(message);
    this.name = 'ProviderLoadError';
    this.config = config;
    this.cause = cause;
  }
}

// ── Factory ────────────────────────────────────────────────────────────────────

/**
 * Resolve and return an EmbedProvider for the given config.
 *
 * [def:loud-fail]: if backend is 'real' and the ONNX provider cannot load,
 * THROWS ProviderLoadError. There is NO silent downgrade to the hash provider.
 *
 * The hash/deterministic provider is returned ONLY when backend:'hash' is
 * explicitly set in config. It is never selected automatically.
 *
 * The returned provider's dim MUST be used to parameterize vector-store.applyVecSchema.
 * Hardcoding 768 is a bug — the plan ships a 1024-dim model that makes it a hard failure.
 *
 * @throws {ProviderLoadError} when backend:'real' and the ONNX provider is unavailable.
 *
 * Resolves U1 (model config key), U2 (model IDs + providerId), U5 (remote backend).
 */
export declare function resolveProvider(config: ProviderConfig): Promise<EmbedProvider>;
