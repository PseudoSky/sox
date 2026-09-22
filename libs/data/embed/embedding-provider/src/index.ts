// @adhd/sox-embedding-provider — pluggable text→vector embedding
// Authoritative interface spec: docs/plan/memory-refactor/COMPILED_INTERFACES.md

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Local binding so this module's own throws/type-guards use the SAME classes the
// barrel re-exports (one home — see `errors.ts`).
import { ResolutionError } from './errors.js';
import { configureEmbedHostHost, configureEmbedHostIdleGraceMs } from './embedHostConfig.js';

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

export interface EmbeddingHealth {
  configured: string;      // e.g. 'fastembed:bge-base-en-v1.5'
  active: string | null;   // null until warm — NEVER a placeholder model name
  state: 'uninitialized' | 'warming' | 'real' | 'error';
  dimensions: number | null;
  last_error: string | null;
  execution_provider?: string;
  /**
   * The resolved host-selection posture (SPEC-EMBEDDING-FUNNEL.md): `'shared'`
   * funnels through the peer-spawned host, `'private'` is the pre-funnel
   * per-process fork. Reported so an operator can see the active mode from one
   * call (ADR-0013 D2) — never inferred, never a placeholder.
   */
  host?: 'shared' | 'private';
}

export interface EmbeddingProvider {
  readonly metadata: EmbeddingProviderMetadata;
  embedSingle(text: string, role?: EmbedRole): Promise<Float32Array>;
  embedBatch(
    texts: string[],
    opts?: { role?: EmbedRole; batchSize?: number },
  ): AsyncIterable<Float32Array>;
  warmUp(texts: string[]): Promise<void>;
  /** Return the current embedding health per CONTRACTS §E. */
  health(): EmbeddingHealth;
}

export interface EmbeddingProviderConfig {
  type: string;
  model: string;
  options?: Record<string, unknown>;
  /**
   * Host-selection posture (SPEC-EMBEDDING-FUNNEL.md; ADR-0013). Defaults to
   * `'shared'` — funnel through the one peer-spawned, self-reaping host.
   * `'private'` is the explicit pre-funnel per-process fork (CI/diagnostics);
   * it is a closed union, never an env toggle, and is reported in `health()`.
   */
  host?: 'shared' | 'private';
  /**
   * How long the peer-shared host lingers with zero clients and zero in-flight
   * work before it reaps itself, in milliseconds. Typed config (owner directive:
   * "the time bound should be configurable") — applied process-wide before the
   * host is spawned, and reported in the host's `embedding.health`. Defaults to
   * `DEFAULT_EMBED_HOST_IDLE_GRACE_MS` (30 s). Must be a positive number.
   */
  idleGraceMs?: number;
}

// ── Error taxonomy — three tiers, no silent degradation ──────────────────────
// Defined in `errors.ts` so `funnelClient.ts` can throw them without importing
// this barrel (which re-exports the funnel client) — re-exported here so the
// public surface and `instanceof` identity are unchanged.

export { TransientEmbeddingError, PermanentEmbeddingError, ResolutionError } from './errors.js';

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
 *
 * SOX-DOC-004: not currently consumed by `createEmbeddingProvider()` /
 * `createFastembedProvider()` — no code constructs or reads a
 * `FastEmbedPoolConfig` today. Kept as a forward-declared shape for a future
 * multi-worker pool; do not assume it has any runtime effect yet.
 */
export interface FastEmbedPoolConfig {
  /** Maximum number of ONNX inference workers. Default: os.cpus().length / 2, minimum 1. */
  maxWorkers?: number;
  /** Models to preload at pool init. Lazy-load on first use if omitted. */
  preloadModels?: string[];
  /** Per-model batch size hint. Overrides the default 256 (`DEFAULT_BATCH_SIZE` in fastembed.ts). */
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
 *
 * @deprecated SOX-BUG-002: dead API. `createEmbeddingProvider()` /
 * `FastembedProvider` never accept or use a `ModelCache` — fastembed resolves
 * a plain `cacheDir` STRING and `FlagEmbedding.init({ model, cacheDir })`
 * downloads and caches the model for itself. That string is resolved as
 * `config.options.cacheDir` → `SOX_EMBED_CACHE_DIR` → `$XDG_CACHE_HOME/sox/models`
 * → `~/.cache/sox/models`. This interface (and `FileSystemModelCache` below)
 * is kept only for external consumers who may already depend on it; do not
 * wire it into the factory expecting it to have any effect.
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

/**
 * @deprecated SOX-BUG-002: dead API, not used by `createEmbeddingProvider` or
 * `FastembedProvider`. Fastembed manages its own model cache internally via
 * the `cacheDir` string (see `ModelCache` JSDoc above for the resolution
 * order). Kept only for external consumers; do not wire it into the factory.
 */
export { FileSystemModelCache } from './cache.js';

/**
 * BL-238/BL-171 fix: the single shared ONNX worker singleton for rerank +
 * verify. `@adhd/sox-hybrid-search`'s cross-encoder and
 * `@adhd/sox-claim-verification`'s NLI verifier MUST route ONNX inference
 * through this one process-wide `worker_threads.Worker` instead of
 * constructing their own — see `sharedOnnxWorker.ts` for the full
 * root-cause writeup and rationale.
 */
export { getSharedOnnxWorker, SharedOnnxWorkerClient, resetSharedOnnxWorker } from './sharedOnnxWorker.js';

/**
 * BL-238/BL-171 fix: the single shared fastembed CHILD PROCESS singleton.
 * This package's own `FastembedProvider` routes ONNX inference through this
 * one process-wide child process instead of constructing its own
 * `worker_threads.Worker` or process — fastembed's onnxruntime-node@1.21.0
 * cannot safely share a thread with `getSharedOnnxWorker()`'s
 * onnxruntime-node@1.24.3, even sequentially — see
 * `sharedFastembedProcess.ts` / `fastembedProcessHost.ts` for the full
 * root-cause writeup and rationale.
 */
export {
  getSharedFastembedProcess,
  SharedFastembedProcessClient,
  resetSharedFastembedProcess,
} from './sharedFastembedProcess.js';

/**
 * (BUG-MEMORY-EMBED-HEAD-OF-LINE-BLOCKING-001 / BL-575) `getSharedFastembedProcess()`
 * returns either a FIXED `FastembedProcessPool` (when `SOX_EMBED_POOL_SIZE`
 * pins an exact size) or, by default, an `AdaptiveFastembedProcessPool` that
 * grows from `minSize` toward `resolveFastembedPoolCeiling()` only under
 * sustained demand — see `sharedFastembedProcess.ts` for the full
 * production-measurement writeup, hysteresis policy, and rationale.
 * `SharedFastembedClient` is the structural interface every shape (single
 * client, fixed pool, adaptive pool) satisfies; `FastembedBusyError` is the
 * typed admission-control rejection (opt-in via
 * `SOX_EMBED_POOL_ADMISSION_LIMIT`). `resolveFastembedPoolPin`/
 * `resolveFastembedPoolCeiling` are the split halves of what
 * `resolveFastembedPoolSize` (kept for backward compatibility) used to
 * compute as one value — see their doc comments for why the split exists.
 */
export type { SharedFastembedClient, PrivateFastembedProcess } from './sharedFastembedProcess.js';
export {
  getPrivateFastembedProcess,
  FastembedProcessPool,
  AdaptiveFastembedProcessPool,
  type AdaptiveFastembedPoolOptions,
  FastembedBusyError,
  resolveFastembedPoolSize,
  resolveFastembedPoolPin,
  resolveFastembedPoolCeiling,
  resolveFastembedAdmissionLimit,
} from './sharedFastembedProcess.js';

// ── The embedding funnel (SPEC-EMBEDDING-FUNNEL.md) ────────────────────────────

/**
 * The host-aware client and its heal entry point. `FunneledFastembedClient` is
 * what `getSharedFastembedProcess()` returns by default (`host: 'shared'`):
 * N processes share ONE peer-spawned, self-reaping ONNX host, and a consumer's
 * `terminate()` is a no-op (it must never kill a shared host).
 * `resetSharedFastembedHost()` is the heal path — it asks the live host to
 * re-fork its private pool (memory-core's `reinitEmbedProvider` routes here).
 */
export { FunneledFastembedClient, resetSharedFastembedHost } from './funnelClient.js';
export {
  resolveEmbedHostConfig,
  configureEmbedHostHost,
  configureEmbedHostIdleGraceMs,
  resolveEmbedHostSocketDir,
  embedHostSingletonKey,
  embedHostSocketPath,
  resolveEmbedHostMainPath,
  resolveEmbedHostIdleGraceMs,
  EMBED_HOST_PROTOCOL_VERSION,
  DEFAULT_EMBED_HOST_IDLE_GRACE_MS,
  EMBED_HOST_IDLE_GRACE_ENV,
  type EmbedHostConfig,
  type EmbedHostMode,
} from './embedHostConfig.js';

// ── Factory ───────────────────────────────────────────────────────────────────

export async function createEmbeddingProvider(
  config: EmbeddingProviderConfig,
): Promise<EmbeddingProvider> {
  if (!config.type || typeof config.type !== 'string') {
    throw new ResolutionError(`Invalid provider type: ${String(config.type)}`);
  }

  // SPEC-EMBEDDING-FUNNEL.md / ADR-0013: apply the typed host-selection posture
  // BEFORE the accessor singleton is first constructed. Process-wide (the host
  // is shared by every provider in the process); reported in `health()`.
  if (config.host !== undefined) {
    try {
      configureEmbedHostHost(config.host);
    } catch (err) {
      throw new ResolutionError(
        `Invalid embedding host mode: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Typed idle bound (owner directive: "the time bound should be configurable").
  // Applied process-wide before the host is spawned; the spawner forwards the
  // resolved value to the host, which consumes it.
  if (config.idleGraceMs !== undefined) {
    try {
      configureEmbedHostIdleGraceMs(config.idleGraceMs);
    } catch (err) {
      throw new ResolutionError(
        `Invalid embedding idle grace: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  switch (config.type) {
    case 'fastembed':
      return createFastembedProvider(config);
    case 'remote':
      return createRemoteProvider(config);
    default:
      throw new ResolutionError(
        `Unknown embedding provider type: "${config.type}" (expected 'fastembed' or 'remote')`,
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
    // SPEC-EMBEDDING-FUNNEL.md §E: NO eager warmup. Construction is deliberately
    // INERT — it resolves the model's static metadata but does NOT load the ONNX
    // model, and therefore does NOT spawn the shared embedding host. A host that
    // constructs a provider but never embeds (e.g. `backlog query` on a read-only
    // view) spawns zero hosts. The model loads — and the host spawns — on the
    // first real `embedSingle`/`embedBatch`, via `FastembedProvider.ensureReady()`.
    //
    // Contract note (was: "throws ResolutionError at factory time if the model
    // cannot load"): CONFIG errors (unknown model/type) still fail here at
    // factory time. A MODEL-LOAD failure now surfaces on first use — still a
    // loud, typed throw, never a silent downgrade — which is the cost of not
    // paying a model load (and a host spawn) for a verb that never embeds.
    const provider = new FastembedProvider(modelId, cfg.dim, cacheDir);
    return provider;
  } catch (err) {
    if (err instanceof ResolutionError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new ResolutionError(
      `Fastembed provider "${modelId}" failed to initialise: ${message}`,
    );
  }
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

/**
 * Single source of truth for the fastembed warmup/init timeout budget.
 *
 * Shared by TWO call sites that were previously two disagreeing copies
 * (SOX-BUG-001): the outer `createFastembedProvider()` factory wrapper
 * (below) that bounds the initial `embedSingle('warmup')` call, AND the
 * inner `FastembedProvider`'s worker-init `readyPromise` timeout
 * (fastembed.ts) that bounds the actual ONNX model load inside the worker
 * thread. Both now read this one function/env var so a cold ONNX model
 * download is bounded consistently end-to-end.
 *
 * BL-376: one budget used to cover both a cold network download (legitimately
 * slow, ~180s) and a cached local load (measured ~650ms-12s depending on OS
 * scheduling QoS). Sizing for the worst case meant a hung cache-hit load was
 * indistinguishable from a slow download for the full 180s. The budget is now
 * split by `cacheHit`, which callers determine up front via
 * `isModelCached()` before choosing which number to ask for — this is NOT a
 * renamed single constant, the caller genuinely branches on cache state.
 *
 * - `cacheHit === true`  → tight, single-digit-second budget (default 8s,
 *   override via `SOX_EMBED_WARMUP_CACHED_TIMEOUT_MS`). The model binary is
 *   already on disk; loading it should be near-instant, so a hang here must
 *   surface fast instead of silently eating three minutes.
 * - `cacheHit === false` → the original generous download budget (default
 *   180s, override via `SOX_EMBED_WARMUP_TIMEOUT_MS`), unchanged.
 */
export function warmupTimeoutMs(cacheHit: boolean): number {
  if (cacheHit) {
    const raw = Number(process.env['SOX_EMBED_WARMUP_CACHED_TIMEOUT_MS']);
    return Number.isFinite(raw) && raw > 0 ? raw : 8_000;
  }
  const raw = Number(process.env['SOX_EMBED_WARMUP_TIMEOUT_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : 180_000;
}

/**
 * BUG-EMBED-WARMUP-CACHEHIT-ASSUMES-FAST-LOAD-001: the single source of truth
 * for how many attempts a cache-hit warmup gets. A retry's `{type:'init'}` IPC
 * request queues behind the still-running first attempt in the shared child's
 * serialized `_queue` (`fastembedProcessHost.ts`) and resolves once that load
 * finishes — it does not restart the load from zero. 2 is the minimum that
 * turns "a single retry would have succeeded" into code; see SPEC-WARMUP-COLD.md
 * §3 decision 3 for why not more, and why the per-attempt budget stays tight
 * (not escalating) so a genuinely-hung load still fails fast (BL-376's
 * guarantee), not just a slow one.
 *
 * Cache-miss warmups are NOT retried (1 attempt, unchanged) — a stuck
 * *download* is a materially different failure mode than a stuck *local
 * read*, and is out of scope for this item.
 */
export const WARMUP_CACHE_HIT_ATTEMPTS = 2;

/**
 * The OUTER factory-level guard around the whole (possibly-retried) warmup —
 * must never drift from the inner per-attempt budget × attempt count. BL-376's
 * own postmortem (SOX-BUG-001 above) is literally about two hand-typed copies
 * of a timeout budget disagreeing; this is derived from `warmupTimeoutMs` and
 * `WARMUP_CACHE_HIT_ATTEMPTS` rather than hand-typed for the same reason.
 *
 * cacheHit === false: unchanged, one attempt, `warmupTimeoutMs(false)` (180s
 * default) — a genuine cache-miss download already gets a generous single
 * budget; see `WARMUP_CACHE_HIT_ATTEMPTS`'s doc comment for why it is not
 * extended a retry here.
 */
export function warmupOuterBudgetMs(cacheHit: boolean): number {
  const attempts = cacheHit ? WARMUP_CACHE_HIT_ATTEMPTS : 1;
  return attempts * warmupTimeoutMs(cacheHit);
}

/**
 * BL-376: determine cache-hit vs. cache-miss up front, synchronously, before
 * either warmup timeout budget is chosen. fastembed lays the ONNX binary out
 * at `<cacheDir>/<hfRepoId>/model_optimized.onnx` (verified against a live
 * `~/.cache/sox/models/` tree) — its presence is the cache-hit signal.
 */
export function isModelCached(cacheDir: string, hfRepoId: string): boolean {
  return existsSync(join(cacheDir, hfRepoId, 'model_optimized.onnx'));
}

function joinDefaultCacheDir(): string {
  const xdg = process.env['XDG_CACHE_HOME'];
  return join(xdg ?? join(homedir(), '.cache'), 'sox', 'models');
}
