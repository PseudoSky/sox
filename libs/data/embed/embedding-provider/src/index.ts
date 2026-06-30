// @adhd/sox-embedding-provider — pluggable text→vector embedding
// Authoritative interface spec: docs/plan/memory-refactor/COMPILED_INTERFACES.md

import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Types ─────────────────────────────────────────────────────────────────────

export type EmbedRole = 'document' | 'query';

export interface EmbeddingProviderMetadata {
  modelId: string;
  dimensions: number;
  maxTokens: number;
  isRemote: boolean;
  isDeterministic: boolean;
  providerUri?: string;
}

export interface EmbeddingProvider {
  readonly metadata: EmbeddingProviderMetadata;
  embedSingle(text: string, role?: EmbedRole): Promise<Float32Array>;
  embedBatch(
    texts: string[],
    opts?: { role?: EmbedRole; batchSize?: number },
  ): AsyncIterable<Float32Array>;
  warmUp(texts: string[]): Promise<void>;
}

export interface EmbeddingProviderConfig {
  type: string;
  model: string;
  options?: Record<string, unknown>;
}

// ── Error taxonomy — three tiers, no silent degradation ──────────────────────

export class TransientEmbeddingError extends Error {
  readonly retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'TransientEmbeddingError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class PermanentEmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentEmbeddingError';
  }
}

export class ResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolutionError';
  }
}

// ── Model config & pool types ──────────────────────────────────────────────────

/**
 * Static registration for a fastembed ONNX model.
 * Each model has a known HF repo, dimension, context window, and description.
 */
export interface FastEmbedModelConfig {
  modelId: string;               // 'bge-m3' | 'codexembed-400m' | etc.
  hfRepoId: string;              // HuggingFace repo for ONNX binary download
  dim: number;
  maxTokens: number;
  description: string;           // human-readable label for observability / tooling
}

/**
 * Worker thread pool configuration for fastembed ONNX inference.
 */
export interface FastEmbedPoolConfig {
  /** Maximum number of ONNX inference workers. Default: os.cpus().length / 2, minimum 1. */
  maxWorkers?: number;
  /** Models to preload at pool init. Lazy-load on first use if omitted. */
  preloadModels?: string[];
  /** Per-model batch size hint. Overrides the default 32. */
  batchSizes?: Record<string, number>;
}

/**
 * Policy for migrating vectors from one embedding model to another.
 */
export interface ReembedPolicy {
  sourceModel: string;           // modelId of the old model whose vectors need re-embedding
  targetModel: string;           // modelId of the new model
  batchSize: number;             // number of vectors to re-embed per batch (default: 64)
  dryRun: boolean;               // when true, report what would be re-embedded without executing
}

/**
 * Local model cache: download, verify SHA-256, and manage model binaries.
 * Binaries are stored at <dataRoot>/models/<modelId>/<version>/ with a sidecar .sha256 file.
 */
export interface ModelCache {
  /** Download and verify model binary. Returns once the model is ready. Throws ResolutionError on SHA-256 mismatch. */
  ensure(modelId: string): Promise<void>;
  /** Check whether the model binary is already in local cache. */
  cached(modelId: string): boolean;
  /** Remove a single model from cache. Does not affect other models. */
  clear(modelId: string): Promise<void>;
  /** Streaming download with progress. Yields byte-level progress updates. */
  ensureStream(modelId: string): AsyncIterable<{ bytesDownloaded: number; totalBytes: number }>;
}

// ── Re-exports ────────────────────────────────────────────────────────────────

export { FileSystemModelCache } from './cache.js';

// ── Factory ───────────────────────────────────────────────────────────────────

export async function createEmbeddingProvider(
  config: EmbeddingProviderConfig,
): Promise<EmbeddingProvider> {
  if (!config.type || typeof config.type !== 'string') {
    throw new ResolutionError(`Invalid provider type: ${String(config.type)}`);
  }

  switch (config.type) {
    case 'fastembed':
      return createFastembedProvider(config);
    case 'hash':
      return createDeterministicProvider(config);
    case 'remote':
      return createRemoteProvider(config);
    default:
      throw new ResolutionError(
        `Unknown embedding provider type: "${config.type}" (expected 'fastembed', 'hash', or 'remote')`,
      );
  }
}

// ── Provider factories ────────────────────────────────────────────────────────

async function createFastembedProvider(
  config: EmbeddingProviderConfig,
): Promise<EmbeddingProvider> {
  const { FastembedProvider, MODEL_CONFIGS, DEFAULT_MODEL } = await import('./fastembed.js');
  const modelId = config.model || DEFAULT_MODEL;
  const cfg = MODEL_CONFIGS[modelId];

  if (!cfg) {
    throw new ResolutionError(
      `Unknown fastembed model: "${modelId}". Supported: ${Object.keys(MODEL_CONFIGS).join(', ')}`,
    );
  }

  const cacheDir =
    (config.options?.['cacheDir'] as string) ??
    process.env['SOX_EMBED_CACHE_DIR'] ??
    joinDefaultCacheDir();

  try {
    const provider = new FastembedProvider(modelId, cfg.dim, cacheDir);
    await withTimeout(
      provider.embedSingle('warmup'),
      warmupTimeoutMs(),
      'fastembed warmup',
    );
    return provider;
  } catch (err) {
    if (err instanceof ResolutionError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new ResolutionError(
      `Fastembed provider "${modelId}" failed to initialise: ${message}`,
    );
  }
}

async function createDeterministicProvider(
  config: EmbeddingProviderConfig,
): Promise<EmbeddingProvider> {
  const { DeterministicProvider } = await import('./deterministic.js');
  const modelId = config.model || 'hash-768';
  const dimensions = (config.options?.['dimensions'] as number) ?? 768;
  return new DeterministicProvider(modelId, dimensions, Infinity);
}

async function createRemoteProvider(
  config: EmbeddingProviderConfig,
): Promise<EmbeddingProvider> {
  const { RemoteProvider } = await import('./remote.js');
  const modelId = config.model || 'remote-768';
  const dimensions = (config.options?.['dimensions'] as number) ?? 768;
  const endpoint = (config.options?.['endpoint'] as string) ?? '';
  const apiKey = config.options?.['apiKey'] as string | undefined;

  if (!endpoint) {
    throw new ResolutionError(
      'Remote provider requires an endpoint URL in config.options.endpoint',
    );
  }

  return new RemoteProvider(modelId, dimensions, endpoint, apiKey);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function warmupTimeoutMs(): number {
  const raw = Number(process.env['SOX_EMBED_WARMUP_TIMEOUT_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const to = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    if (typeof to.unref === 'function') to.unref();
    p.then(
      (v) => {
        clearTimeout(to);
        resolve(v);
      },
      (e) => {
        clearTimeout(to);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function joinDefaultCacheDir(): string {
  const xdg = process.env['XDG_CACHE_HOME'];
  return join(xdg ?? join(homedir(), '.cache'), 'sox', 'models');
}
