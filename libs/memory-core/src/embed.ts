/**
 * Configurable embedding backend adapter for sox-memory.
 *
 * This is a thin ping/stats adapter over @adhd/sox-embedding-provider.
 * The old `embed.ts` + `embedWorker.ts` have been replaced by the canonical
 * worker-thread ONNX host in embedding-provider (CONTRACTS §E).
 *
 * Backend resolution via SOX_EMBED_BACKEND:
 *   'auto' → {type:'fastembed', model:'bge-base-en-v1.5'}
 *   'real' → {type:'fastembed', model:'bge-base-en-v1.5'} fail-loud
 *
 * Invariants (inherited from the old embed.ts):
 *   R1: zero per-query network calls (local ONNX inference).
 *   R2: getActiveEmbedModel() reflects the active backend.
 */

import { createEmbeddingProvider } from '@adhd/sox-embedding-provider';
import type { EmbeddingProvider } from '@adhd/sox-embedding-provider';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { log } from './telemetry.js';

// ── Public constants ──────────────────────────────────────────────────────────

export const EMBED_DIM = 768;

let _activeModel: string | null = null;
export function getActiveEmbedModel(): string | null {
  return _activeModel;
}

// ── Provider-call counter (R1 guard) ─────────────────────────────────────────

let providerCallCount = 0;
export function getProviderCallCount(): number {
  return providerCallCount;
}
export function resetProviderCallCount(): void {
  providerCallCount = 0;
}

// ── Config ────────────────────────────────────────────────────────────────────

export type EmbedBackend = 'auto' | 'real';

const VALID_EMBED_BACKENDS: readonly EmbedBackend[] = ['auto', 'real'];

export interface EmbedConfig {
  backend: EmbedBackend;
  cacheDir: string;
  model: string;
}

/**
 * BL-250: SOX_EMBED_BACKEND is validated against the live union instead of an
 * unchecked `as EmbedBackend` cast. The hash backend was removed (embedWorker.ts
 * deleted); an unknown value (e.g. a stale `SOX_EMBED_BACKEND=hash` left over from
 * before this removal) must fail LOUDLY here rather than silently flow through and
 * be reported back to a caller via memory_ping/memory_stats as if it were real.
 */
function resolveBackendEnv(): EmbedBackend {
  const raw = process.env['SOX_EMBED_BACKEND'];
  if (raw === undefined || raw === '') return 'auto';
  if ((VALID_EMBED_BACKENDS as readonly string[]).includes(raw)) {
    return raw as EmbedBackend;
  }
  throw new Error(
    `[sox-memory] Invalid SOX_EMBED_BACKEND: "${raw}". Valid values: ${VALID_EMBED_BACKENDS.join(', ')}.`,
  );
}

/** Public accessor so other modules (e.g. stats.ts) never re-implement the raw env read. */
export function getConfiguredEmbedBackend(): EmbedBackend {
  return resolveBackendEnv();
}

function resolveConfig(): EmbedConfig {
  const backend = resolveBackendEnv();
  const cacheDir =
    process.env['SOX_EMBED_CACHE_DIR'] ??
    join(
      process.env['XDG_CACHE_HOME'] ?? join(homedir(), '.cache'),
      'sox-memory',
      'models',
    );
  return { backend, cacheDir, model: 'bge-base-en-v1.5' };
}

// ── Provider singleton ────────────────────────────────────────────────────────

let _provider: EmbeddingProvider | null = null;
let _providerPromise: Promise<EmbeddingProvider> | null = null;
let _resolvedBackend: 'real' | null = null;
let _lastEmbedError: string | null = null;

/**
 * TEST-ONLY dependency-injection hook. When set, getOrCreateProvider() returns
 * this provider instead of initialising fastembed. This is a no-op in production
 * because only tests call it. Pass null to clear the override and let the next
 * call re-resolve the real backend.
 *
 * IMPORTANT: _resetEmbedSingleton() does NOT clear the injected test provider.
 * A test that switches to the real backend must call _setEmbedProviderForTest(null)
 * plus set SOX_EMBED_BACKEND=real before calling warmupEmbed().
 */
let _testProvider: EmbeddingProvider | null = null;

export function _setEmbedProviderForTest(p: EmbeddingProvider | null): void {
  _testProvider = p;
  if (p !== null) {
    // When injecting a test provider, also update state so health/model reflect the test provider.
    _provider = null;
    _providerPromise = null;
    _resolvedBackend = 'real';
    _activeModel = p.metadata.modelId;
    _configCache = null;
    _lastEmbedError = null;
  }
}

/**
 * BL-54: the truthful embed-subsystem state.
 */
export type EmbedState = 'real' | 'uninitialized';
export function getEmbedState(): EmbedState {
  if (_testProvider !== null) return 'real';
  if (_activeModel !== null && _resolvedBackend === 'real') return 'real';
  return 'uninitialized';
}

export function getLastEmbedError(): string | null {
  return _lastEmbedError;
}

export interface EmbedHealth {
  state: EmbedState;
  model: string;
  backend: EmbedBackend;
  last_error: string | null;
  execution_provider?: string;
}

/** Truthful embed-subsystem health for memory_ping / memory_stats. */
export function getEmbedHealth(): EmbedHealth {
  const backend = resolveBackendEnv();
  const state = getEmbedState();
  const execProvider = _provider?.health()?.execution_provider ?? 'cpu';
  return {
    state,
    model: _activeModel ?? 'unknown',
    backend,
    last_error: _lastEmbedError,
    execution_provider: execProvider,
  };
}

/**
 * Resolve and create the embedding provider — always uses the real fastembed backend.
 * Throws on failure for both 'auto' and 'real' modes (no degraded fallback).
 */
async function resolveProvider(): Promise<EmbeddingProvider> {
  const config = resolveConfig();

  try {
    const p = await createEmbeddingProvider({
      type: 'fastembed',
      model: config.model,
      options: { cacheDir: config.cacheDir },
    });
    _resolvedBackend = 'real';
    _activeModel = 'bge-base-en-v1.5';
    _lastEmbedError = null;
    return p;
  } catch (err) {
    const cause = String(err instanceof Error ? err.message : err);
    _lastEmbedError = cause;
    throw new Error(
      `[sox-memory] Embedding provider init failed: ${cause}`,
    );
  }
}

async function getOrCreateProvider(): Promise<EmbeddingProvider> {
  // TEST-ONLY: return the injected test provider if set (bypasses fastembed entirely).
  if (_testProvider !== null) return _testProvider;

  if (_provider) return _provider;
  if (_providerPromise) return _providerPromise;

  _providerPromise = resolveProvider().then((p) => {
    _provider = p;
    _providerPromise = null;
    return p;
  });

  return _providerPromise;
}

// ── Primary async embed API ───────────────────────────────────────────────────

let _configCache: EmbedConfig | null = null;

/**
 * BL-320: optional embed-call timeout, in ms. 0/unset = disabled (the
 * historical, unbounded behaviour). Read per-call so it can be flipped live.
 * When set, a call that exceeds the budget logs `embed.timeout` (the call
 * itself is NOT aborted — the underlying worker-thread provider has no
 * cancellation hook — but the timeout fires as an observability signal so a
 * hung embed is visible in the log well before any MCP client gives up).
 */
function resolveEmbedTimeoutMs(): number {
  const raw = process.env['SOX_EMBED_TIMEOUT_MS'];
  const n = raw ? parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Embed `text` and return a 768-dim L2-normalised Float32Array.
 * Delegates to the embedding-provider's embedSingle().
 *
 * BL-320: logs `embed.start`/`embed.finish`/`embed.error` (+ an advisory
 * `embed.timeout` line if SOX_EMBED_TIMEOUT_MS elapses first) with durations.
 * Never logs the text itself — only its length.
 */
export async function embed(text: string): Promise<Float32Array> {
  const t0 = performance.now();
  const textLen = text.length;
  log.info('embed.start', { text_len: textLen });

  // Advisory timeout: fires a durable `embed.timeout` warning line if the
  // embed hasn't settled by SOX_EMBED_TIMEOUT_MS, WITHOUT aborting or racing
  // the real call (the worker-thread provider has no cancellation hook — an
  // aborted-looking promise would just leak the still-running inference).
  // This exists purely so a stuck embed is visible in the log before any MCP
  // client timeout, instead of the silence the incident exposed.
  const timeoutMs = resolveEmbedTimeoutMs();
  const timeoutHandle: ReturnType<typeof setTimeout> | undefined =
    timeoutMs > 0
      ? setTimeout(() => {
          log.warn('embed.timeout', { text_len: textLen, timeout_ms: timeoutMs });
        }, timeoutMs)
      : undefined;

  try {
    _configCache ??= resolveConfig();
    const provider = await getOrCreateProvider();
    providerCallCount++; // BL-254: track actual local embed calls
    const vec = await provider.embedSingle(text);
    log.info('embed.finish', { text_len: textLen, duration_ms: Math.round(performance.now() - t0) });
    return vec;
  } catch (err) {
    log.error('embed.error', {
      text_len: textLen,
      duration_ms: Math.round(performance.now() - t0),
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

/**
 * Proactively warm up the real embedding backend and return its truthful health.
 */
export async function warmupEmbed(_timeoutMs?: number): Promise<EmbedHealth> {
  _configCache ??= resolveConfig();
  try {
    const p = await getOrCreateProvider();
    const health = p.health();
    if (health.state === 'error' || health.state === 'uninitialized') {
      throw new Error(`Provider health: ${health.state}: ${health.last_error ?? 'unknown'}`);
    }
    _lastEmbedError = null;
    return getEmbedHealth();
  } catch (err) {
    const cause = String(err instanceof Error ? err.message : err);
    _lastEmbedError = cause;
    throw new Error(`[sox-memory] Embedding warmup failed: ${cause}`);
  }
}

/**
 * Legacy synchronous shim — kept for internal callers.
 * @deprecated Use `await embed(text)` instead.
 */
export function embedText(_text: string): Float32Array {
  throw new Error(
    '[sox-memory] embedText() is no longer available without the hash backend. Use await embed(text) instead.',
  );
}

// ── Serialisation helpers ─────────────────────────────────────────────────────

export function vecToJson(vec: Float32Array): string {
  const arr: number[] = Array.from(vec);
  return '[' + arr.map((v) => v.toFixed(8)).join(',') + ']';
}

export function vecToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

// ── Re-embed helper ───────────────────────────────────────────────────────────

export async function reembedNodes(
  adapter: StoreAdapter,
  nodeRowIds: number[],
  getContent: (rowid: number) => string | null,
): Promise<number> {
  let updated = 0;
  const useBinaryFormat = adapter.capabilities.nativeVectors;
  for (const rowid of nodeRowIds) {
    const text = getContent(rowid);
    if (!text) continue;
    const vec = await embed(text);
    const serialized = useBinaryFormat ? vecToBuffer(vec) : vecToJson(vec);
    const info = await adapter.executeRun(
      'UPDATE vec_node SET embedding = ? WHERE node_id = CAST(? AS INTEGER)',
      [serialized, rowid],
    );
    if (info.rowsAffected === 0) {
      await adapter.executeRun(
        'INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)',
        [rowid, serialized],
      );
    }
    updated++;
  }
  return updated;
}

// ── Test lifecycle ────────────────────────────────────────────────────────────

/**
 * Reset the provider singleton. Used in test teardown so the provider can be
 * re-initialised with a different backend config.
 *
 * NOTE: deliberately does NOT clear the injected test provider (_testProvider).
 * Tests that want the real bge backend must call _setEmbedProviderForTest(null)
 * explicitly. This ensures the test setup file's DeterministicTestProvider
 * survives per-test resets in files that reset purely for isolation (e.g. db.spec.ts).
 */
export function _resetEmbedSingleton(): void {
  _provider = null;
  _providerPromise = null;
  _resolvedBackend = null;
  _activeModel = _testProvider ? _testProvider.metadata.modelId : null;
  _configCache = null;
  _lastEmbedError = null;
}

/**
 * Shutdown the provider. For the provider-based implementation this is a no-op
 * since the embedding-provider's FastembedProvider manages worker lifecycle.
 * The function remains for test compatibility.
 */
export async function _shutdownEmbedWorker(): Promise<void> {
  _resetEmbedSingleton();
}


