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
import { homedir } from 'node:os';
import { join } from 'node:path';

// ── Public constants ──────────────────────────────────────────────────────────

export const EMBED_DIM = 768;

let _activeModel = 'bge-base-en-v1.5';
export function getActiveEmbedModel(): string {
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
let _resolvedBackend: 'real' | null = null;
let _lastEmbedError: string | null = null;

/**
 * BL-54: the truthful embed-subsystem state.
 */
export type EmbedState = 'real' | 'uninitialized';
export function getEmbedState(): EmbedState {
  if (_activeModel === 'bge-base-en-v1.5' && _resolvedBackend === 'real') return 'real';
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
}

/** Truthful embed-subsystem health for memory_ping / memory_stats. */
export function getEmbedHealth(): EmbedHealth {
  const backend = (process.env['SOX_EMBED_BACKEND'] ?? 'auto') as EmbedBackend;
  const state = getEmbedState();
  return {
    state,
    model: _activeModel,
    backend,
    last_error: _lastEmbedError,
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
  return provider.embedSingle(text);
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
    throw new Error(`[sox-memory] FATAL: Embedding warmup failed: ${cause}`);
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
  _activeModel = 'bge-base-en-v1.5';
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


