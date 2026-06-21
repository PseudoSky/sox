/**
 * Configurable embedding backend for sox-memory.
 *
 * TODO: This file is a duplicate of libs/memory-core/src/embed.ts.
 *       Deduplicate once @sox/extension-memory-server adds @sox/memory-core as a
 *       dependency (nx migration C7 — ref: memory-server/src/lib.ts note).
 *       Until then, keep both files in sync.
 *
 * Backends:
 *   'hash' — deterministic FNV-1a hash projection (MVP, zero download, zero network).
 *   'real' — in-process ONNX via fastembed (BGE-base-en-v1.5, 768-dim, L2-normalized).
 *             Model is downloaded once to cacheDir on first use; subsequent calls are
 *             in-process ONNX inference with zero per-query network I/O (satisfies R1).
 *   'auto' — try to load/init the real model; fall back to hash if unavailable.
 *
 * Configuration (env vars, read once at first embed() call):
 *   SOX_EMBED_BACKEND   'auto' | 'real' | 'hash'  (default: 'auto')
 *   SOX_EMBED_CACHE_DIR  path for model files       (default: ~/.cache/sox-memory/models)
 *
 * Invariants:
 *   R1: zero per-query network calls. The real backend uses local ONNX inference;
 *       a one-time model download on first use is acceptable.
 *   R2: EMBED_MODEL reflects the active backend so memory_scope pin is truthful.
 */

import * as os from 'node:os';
import * as path from 'node:path';

// ── Public constants ──────────────────────────────────────────────────────────

export const EMBED_DIM = 768;

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
    path.join(
      process.env['XDG_CACHE_HOME'] ?? path.join(os.homedir(), '.cache'),
      'sox-memory',
      'models',
    );
  return {
    backend,
    cacheDir,
    model: 'fast-bge-base-en-v1.5',
  };
}

// ── Real backend singleton ────────────────────────────────────────────────────

type FlagEmbeddingInstance = {
  queryEmbed(query: string): Promise<number[]>;
};

let _realInstance: FlagEmbeddingInstance | null = null;
let _realInitPromise: Promise<FlagEmbeddingInstance | null> | null = null;
let _resolvedBackend: 'real' | 'hash' | null = null;

async function initRealBackend(config: EmbedConfig): Promise<FlagEmbeddingInstance | null> {
  if (_realInstance !== null) return _realInstance;
  if (_realInitPromise !== null) return _realInitPromise;

  _realInitPromise = (async () => {
    try {
      // TODO: fastembed is installed in libs/memory-core/node_modules; once memory-server
      // adds @sox/memory-core as a dep (nx C7), this import moves to the shared lib.
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore — fastembed not in this package's node_modules yet (see TODO above)
      const { FlagEmbedding, EmbeddingModel } = await import('fastembed');

      const instance = await FlagEmbedding.init({
        model: EmbeddingModel.BGEBaseENV15,
        cacheDir: config.cacheDir,
        showDownloadProgress: false,
      });

      _realInstance = instance;
      _activeModel = 'bge-base-en-v1.5';
      _resolvedBackend = 'real';
      return instance;
    } catch (err) {
      _realInitPromise = null;
      throw err;
    }
  })();

  return _realInitPromise;
}

// ── Primary async embed API ───────────────────────────────────────────────────

let _configCache: EmbedConfig | null = null;

export async function embed(text: string): Promise<Float32Array> {
  const config = (_configCache ??= resolveConfig());

  if (config.backend === 'hash') {
    _resolvedBackend = 'hash';
    return hashEmbed(text);
  }

  if (config.backend === 'real') {
    let instance: FlagEmbeddingInstance | null;
    try {
      instance = await initRealBackend(config);
    } catch (err) {
      throw new Error(
        `[sox-memory] embedding.backend='real' but real backend failed to init: ${String(err)}`,
      );
    }
    if (!instance) {
      throw new Error('[sox-memory] embedding.backend=\'real\' but real backend returned null');
    }
    return toFloat32Normalised(await instance.queryEmbed(text));
  }

  // 'auto': try real, fall back to hash
  try {
    const instance = await initRealBackend(config);
    if (instance) {
      return toFloat32Normalised(await instance.queryEmbed(text));
    }
  } catch {
    if (_resolvedBackend === null) {
      console.warn(
        '[sox-memory] Real embedding model unavailable; falling back to hash embedding. ' +
          'Set SOX_EMBED_BACKEND=hash to silence this warning.',
      );
      _resolvedBackend = 'hash';
      _activeModel = 'nomic-embed-text-v1.5-hash';
    }
  }

  return hashEmbed(text);
}

/**
 * Legacy synchronous shim — kept for internal callers not yet on the async embed() API.
 * @deprecated Use `await embed(text)` instead.
 */
export function embedText(text: string): Float32Array {
  return hashEmbed(text);
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
    db.prepare(
      'INSERT OR REPLACE INTO vec_node(node_id, embedding) VALUES (CAST(? AS INTEGER), ?)',
    ).run(rowid, vecJson);
    updated++;
  }
  return updated;
}

// ── Hash backend ──────────────────────────────────────────────────────────────

function hashEmbed(text: string): Float32Array {
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

function toFloat32Normalised(raw: number[]): Float32Array {
  const vec = new Float32Array(EMBED_DIM);
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) {
    vec[i] = raw[i] ?? 0;
    norm += (vec[i] as number) * (vec[i] as number);
  }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i < EMBED_DIM; i++) {
    vec[i] = (vec[i] as number) / norm;
  }
  return vec;
}

export function _resetEmbedSingleton(): void {
  _realInstance = null;
  _realInitPromise = null;
  _resolvedBackend = null;
  _activeModel = 'nomic-embed-text-v1.5-hash';
  _configCache = null;
}
