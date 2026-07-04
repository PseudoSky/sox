/**
 * Configurable embedding backend adapter for sox-memory.
 *
 * This is a thin ping/stats adapter over @adhd/sox-embedding-provider.
 * The old `embed.ts` + `embedWorker.ts` have been replaced by the canonical
 * worker-thread ONNX host in embedding-provider (CONTRACTS §E).
 *
 * Backend resolution via SOX_EMBED_BACKEND (CONTRACTS §E compat mapping):
 *   'auto' → {type:'fastembed', model:'bge-base-en-v1.5'} with hash fallback on failure
 *   'real' → {type:'fastembed', model:'bge-base-en-v1.5'} fail-loud
 *   'hash' → {type:'hash'}
 *
 * Invariants (inherited from the old embed.ts):
 *   R1: zero per-query network calls (local ONNX inference).
 *   R2: getActiveEmbedModel() reflects the active backend.
 */

import { createEmbeddingProvider } from '@adhd/sox-embedding-provider';
import type { EmbeddingProvider } from '@adhd/sox-embedding-provider';
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Public constants ──────────────────────────────────────────────────────────

export const EMBED_DIM = 768;

// EMBED_MODEL is updated at runtime to reflect the active backend.
let _activeModel = 'nomic-embed-text-v1.5-hash';
export function getActiveEmbedModel(): string {
  return _activeModel;
}
export const EMBED_MODEL = 'nomic-embed-text-v1.5-hash';

// ── Provider-call counter (R1 guard) ─────────────────────────────────────────

let providerCallCount = 0;
export function getProviderCallCount(): number {
  return providerCallCount;
}
export function resetProviderCallCount(): void {
  providerCallCount = 0;
}

// ── Config ────────────────────────────────────────────────────────────────────

export type EmbedBackend = 'auto' | 'real' | 'hash';

export interface EmbedConfig {
  backend: EmbedBackend;
  cacheDir: string;
  model: string;
}

function resolveConfig(): EmbedConfig {
  const backend = (process.env['SOX_EMBED_BACKEND'] ?? 'auto') as EmbedBackend;
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
let _resolvedBackend: 'real' | 'hash' | null = null;
let _lastEmbedError: string | null = null;

/**
 * BL-54: the truthful embed-subsystem state.
 */
export type EmbedState = 'real' | 'hash' | 'uninitialized';
export function getEmbedState(): EmbedState {
  if (_activeModel === 'bge-base-en-v1.5') return 'real';
  if (_resolvedBackend === 'hash') return 'hash';
  return 'uninitialized';
}

export function getLastEmbedError(): string | null {
  return _lastEmbedError;
}

export interface EmbedHealth {
  state: EmbedState;
  model: string;
  backend: EmbedBackend;
  on_hash_fallback: boolean;
  last_error: string | null;
}

/** Truthful embed-subsystem health for memory_ping / memory_stats. */
export function getEmbedHealth(): EmbedHealth {
  const backend = (process.env['SOX_EMBED_BACKEND'] ?? 'auto') as EmbedBackend;
  const state = getEmbedState();
  return {
    state,
    model: _activeModel,
    backend,
    on_hash_fallback: backend !== 'hash' && state === 'hash',
    last_error: _lastEmbedError,
  };
}

/**
 * Map SOX_EMBED_BACKEND to provider config per CONTRACTS §E.
 */
async function resolveProvider(): Promise<EmbeddingProvider> {
  const config = resolveConfig();

  if (config.backend === 'hash') {
    const p = await createEmbeddingProvider({ type: 'hash', model: 'hash-768' });
    _resolvedBackend = 'hash';
    _activeModel = 'nomic-embed-text-v1.5-hash';
    _lastEmbedError = null;
    return p;
  }

  // auto or real: try fastembed
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

    if (config.backend === 'real') {
      throw new Error(
        `[sox-memory] embedding.backend='real' but provider init failed: ${cause}`,
      );
    }

    // auto: fall back to hash with loud diagnostic
    console.error(
      '[sox-memory] Real embedding model unavailable; FALLING BACK TO HASH embedding ' +
        '(degraded semantic recall). ' +
        `Cause: ${cause}. Set SOX_EMBED_BACKEND=hash to opt in intentionally.`,
    );
    const p = await createEmbeddingProvider({ type: 'hash', model: 'hash-768' });
    _resolvedBackend = 'hash';
    _activeModel = 'nomic-embed-text-v1.5-hash';
    return p;
  }
}

async function getOrCreateProvider(): Promise<EmbeddingProvider> {
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
 * Embed `text` and return a 768-dim L2-normalised Float32Array.
 * Delegates to the embedding-provider's embedSingle().
 */
export async function embed(text: string): Promise<Float32Array> {
  _configCache ??= resolveConfig();
  const provider = await getOrCreateProvider();
  if (_resolvedBackend !== 'hash') providerCallCount++;
  return provider.embedSingle(text);
}

/**
 * Proactively warm up the real embedding backend and return its truthful health.
 */
export async function warmupEmbed(_timeoutMs?: number): Promise<EmbedHealth> {
  const config = (_configCache ??= resolveConfig());
  if (config.backend === 'hash') {
    _resolvedBackend = 'hash';
    return getEmbedHealth();
  }
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
    if (config.backend === 'real') {
      throw new Error(`[sox-memory] FATAL: embedding.backend='real' but warmup failed: ${cause}`);
    }
    _resolvedBackend = 'hash';
    _activeModel = 'nomic-embed-text-v1.5-hash';
    return getEmbedHealth();
  }
}

/**
 * Legacy synchronous shim — kept for internal callers.
 * @deprecated Use `await embed(text)` instead.
 */
export function embedText(text: string): Float32Array {
  // Local hash implementation for sync backward compat
  return hashEmbedLocal(text);
}

// ── Serialisation helpers ─────────────────────────────────────────────────────

export function vecToJson(vec: Float32Array): string {
  const arr: number[] = Array.from(vec);
  return '[' + arr.map((v) => v.toFixed(8)).join(',') + ']';
}

export function vecToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer);
}

// ── Re-embed helper ───────────────────────────────────────────────────────────

export async function reembedNodes(
  db: import('better-sqlite3').Database,
  nodeRowIds: number[],
  getContent: (rowid: number) => string | null,
): Promise<number> {
  let updated = 0;
  for (const rowid of nodeRowIds) {
    const text = getContent(rowid);
    if (!text) continue;
    const vec = await embed(text);
    const vecJson = vecToJson(vec);
    const info = db
      .prepare('UPDATE vec_node SET embedding = ? WHERE node_id = CAST(? AS INTEGER)')
      .run(vecJson, rowid);
    if (info.changes === 0) {
      db.prepare('INSERT INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)').run(
        rowid,
        vecJson,
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
 */
export function _resetEmbedSingleton(): void {
  _provider = null;
  _providerPromise = null;
  _resolvedBackend = null;
  _activeModel = 'nomic-embed-text-v1.5-hash';
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

// ── Local hash implementation (sync fallback for embedText) ───────────────────

function hashEmbedLocal(text: string): Float32Array {
  const normalized = text.toLowerCase().replace(/[^\w\s]/g, ' ').trim();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const vec = new Float32Array(EMBED_DIM);

  for (const token of tokens) {
    const h1 = hash32(token, 0x811c9dc5);
    const h2 = hash32(token, 0x01000193);
    for (let d = 0; d < EMBED_DIM; d++) {
      const seed = ((d * 0x9e3779b9 + h1) >>> 0) as number;
      const val = ((seed ^ h2) / 0x80000000) - 1.0;
      vec[d] = (vec[d] as number) + val / Math.max(tokens.length, 1);
    }
  }

  let norm = 0;
  for (let d = 0; d < EMBED_DIM; d++) {
    norm += (vec[d] as number) * (vec[d] as number);
  }
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < EMBED_DIM; d++) {
    vec[d] = (vec[d] as number) / norm;
  }

  return vec;
}

function hash32(str: string, basis: number): number {
  let h = basis >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
