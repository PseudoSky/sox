/**
 * Configurable embedding backend for sox-memory.
 *
 * Backends:
 *   'hash' — deterministic FNV-1a hash projection (MVP, zero download, zero network).
 *   'real' — worker_thread ONNX via fastembed (BGE-base-en-v1.5, 768-dim, L2-normalized).
 *             onnxruntime-node runs in embedWorker.ts (worker_thread), isolated from the
 *             main thread's better-sqlite3 + sqlite-vec native handle. This prevents
 *             the BL-11 libpthread mutex corruption that occurred when both native addons
 *             shared the same thread (see libs/memory-core/src/index.ts process boundary note).
 *             Model is downloaded once to cacheDir on first use; subsequent calls are
 *             in-worker ONNX inference with zero per-query network I/O (satisfies R1).
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
 *
 * TODO: deduplicate with extensions/bundles/sox-memory-bundle/members/memory-server/src/embed.ts
 *       once memory-server adds @sox/memory-core as a dependency (nx migration C7).
 */

import * as os from 'node:os';
import * as path from 'node:path';
import { Worker } from 'node:worker_threads';

// ── Public constants ──────────────────────────────────────────────────────────

export const EMBED_DIM = 768;

// EMBED_MODEL is updated at runtime to reflect the active backend.
// Callers that read this after embed() resolves get the truthful model id.
let _activeModel = 'nomic-embed-text-v1.5-hash';
export function getActiveEmbedModel(): string {
  return _activeModel;
}
// The EMBED_MODEL constant is the *hash backend* identifier ('nomic-embed-text-v1.5-hash').
// When backend='real'/'auto'→real, getActiveEmbedModel() returns 'bge-base-en-v1.5'
// (BGE-base-en-v1.5 via fastembed, 768-dim). Do NOT use EMBED_MODEL as a proxy for the
// active backend — use getActiveEmbedModel().
export const EMBED_MODEL = 'nomic-embed-text-v1.5-hash';

// ── Provider-call counter (R1 guard) ─────────────────────────────────────────

// Counts external HTTP/provider calls. MUST remain 0 on the read path.
// The real ONNX backend DOES NOT increment this — it is local inference.
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
  /** Filesystem path where the ONNX model is cached. */
  cacheDir: string;
  /** fastembed model id string. Must produce 768-dim output. */
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
    model: 'fast-bge-base-en-v1.5', // BGE-base-en-v1.5 — 768-dim, supported by fastembed 2.x
  };
}

// ── Real backend — worker_thread proxy ───────────────────────────────────────
//
// onnxruntime-node loads in a dedicated worker_thread (embedWorker.ts), keeping
// it isolated from the main thread's better-sqlite3 + sqlite-vec native handle.
// This resolves BL-11: the libpthread mutex corruption that occurred when both
// native addons shared the same thread.

let _resolvedBackend: 'real' | 'hash' | null = null;

interface WorkerEmbedResponse {
  id: number;
  embedding?: number[];
  error?: string;
}

let _worker: Worker | null = null;
let _workerReady = false;
let _workerReadyPromise: Promise<void> | null = null;
let _nextId = 1;
const _pending = new Map<number, { resolve: (v: number[]) => void; reject: (e: Error) => void }>();

/**
 * Returns the persistent embed worker, spawning it on first call.
 * The worker preloads fastembed before accepting requests so the first embed
 * call pays the model-init cost without blocking subsequent calls.
 */
function getEmbedWorker(config: EmbedConfig): Worker {
  if (_worker) return _worker;

  // embedWorker.js lives alongside this file in dist/
  const workerPath = path.join(__dirname, 'embedWorker.js');
  _worker = new Worker(workerPath, { workerData: { cacheDir: config.cacheDir } });

  // Do not let the embed worker keep the host event loop / test fork alive when idle.
  // It only does work in response to a posted message; production servers keep the loop
  // alive via stdin/socket. Without unref(), vitest's fork pool times out terminating
  // workers that ran an embed (the worker thread lingers past test teardown).
  _worker.unref();

  _worker.on('message', (msg: WorkerEmbedResponse) => {
    const pending = _pending.get(msg.id);
    if (!pending) return;
    _pending.delete(msg.id);
    if (msg.error) {
      pending.reject(new Error(msg.error));
    } else {
      pending.resolve(msg.embedding!);
    }
  });

  _worker.on('error', (err) => {
    // Propagate to all pending requests
    for (const { reject } of _pending.values()) reject(err);
    _pending.clear();
    _worker = null;
    _workerReady = false;
    _workerReadyPromise = null;
  });

  _worker.on('exit', (code) => {
    if (code !== 0) {
      const err = new Error(`embedWorker exited with code ${code}`);
      for (const { reject } of _pending.values()) reject(err);
      _pending.clear();
    }
    _worker = null;
    _workerReady = false;
    _workerReadyPromise = null;
  });

  // Send a warmup embed so the model is loaded before the first real request.
  // We treat this as a fire-and-forget; failures are surfaced on the first real call.
  _workerReadyPromise = new Promise<void>((resolve) => {
    const id = _nextId++;
    _pending.set(id, {
      resolve: () => {
        _workerReady = true;
        _activeModel = 'bge-base-en-v1.5';
        _resolvedBackend = 'real';
        resolve();
      },
      reject: (e) => {
        _workerReadyPromise = null;
        resolve(); // don't block; caller will get the error on first real embed
        console.warn('[sox-memory] embed worker warmup failed:', e.message);
      },
    });
    _worker!.postMessage({ id, text: 'warmup', cacheDir: config.cacheDir });
  });

  return _worker;
}

/**
 * Embed text via the worker proxy. Waits for worker readiness on first call.
 */
async function workerEmbed(text: string, config: EmbedConfig): Promise<number[]> {
  const worker = getEmbedWorker(config);
  // Wait for warmup to complete (model download + init) on first real call
  if (!_workerReady && _workerReadyPromise) {
    await _workerReadyPromise;
  }
  return new Promise<number[]>((resolve, reject) => {
    const id = _nextId++;
    _pending.set(id, { resolve, reject });
    worker.postMessage({ id, text, cacheDir: config.cacheDir });
  });
}

// ── Primary async embed API ───────────────────────────────────────────────────

let _configCache: EmbedConfig | null = null;

/**
 * Embed `text` and return a 768-dim L2-normalised Float32Array.
 *
 * This is the primary API. All call sites use `await embed(text)`.
 * The hash path is synchronous internally but wrapped in Promise for a
 * uniform async signature across backends.
 *
 * R1: no per-query network calls. The real backend uses local ONNX inference.
 *     A one-time model download on first call is the only network activity.
 */
export async function embed(text: string): Promise<Float32Array> {
  const config = (_configCache ??= resolveConfig());

  if (config.backend === 'hash') {
    _resolvedBackend = 'hash';
    return hashEmbed(text);
  }

  if (config.backend === 'real') {
    try {
      const vec = await workerEmbed(text, config);
      return toFloat32Normalised(vec);
    } catch (err) {
      throw new Error(
        `[sox-memory] embedding.backend='real' but worker embed failed: ${String(err)}`,
      );
    }
  }

  // 'auto': try real via worker, fall back to hash
  try {
    const vec = await workerEmbed(text, config);
    return toFloat32Normalised(vec);
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
 * Legacy synchronous shim — kept for internal callers that have not yet been
 * migrated to the async `embed()` API. Uses the hash backend only.
 *
 * @deprecated Use `await embed(text)` instead.
 */
export function embedText(text: string): Float32Array {
  return hashEmbed(text);
}

// ── Serialisation helpers (unchanged public API) ──────────────────────────────

/**
 * Serialize Float32Array to JSON array string for sqlite-vec MATCH queries.
 */
export function vecToJson(vec: Float32Array): string {
  const arr: number[] = Array.from(vec);
  return '[' + arr.map((v) => v.toFixed(8)).join(',') + ']';
}

/**
 * Serialize Float32Array to Buffer for sqlite-vec INSERT (blob format).
 * sqlite-vec accepts both JSON strings and binary blobs.
 */
export function vecToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer);
}

// ── Re-embed helper (used by the reindex organizer op) ───────────────────────

/**
 * Re-embed a batch of nodes and update their vec_node rows.
 * Called by memoryd's 'reindex' op when embed_model changes.
 *
 * Operates inside a transaction for atomicity.
 */
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

// ── Hash backend (FNV-1a projection, zero download, zero network) ─────────────

/**
 * Deterministic 768-dim embedding via seeded FNV-1a hash projection.
 * Produces L2-normalised Float32Array. No network, no download.
 *
 * Float32Array index access returns `number` (not `number | undefined`)
 * so no null-assertion or nullish coalescing is needed.
 */
function hashEmbed(text: string): Float32Array {
  const normalized = text.toLowerCase().replace(/[^\w\s]/g, ' ').trim();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const vec = new Float32Array(EMBED_DIM);

  for (const token of tokens) {
    const h1 = hash32(token, 0x811c9dc5);
    const h2 = hash32(token, 0x01000193);
    for (let d = 0; d < EMBED_DIM; d++) {
      const seed = ((d * 0x9e3779b9 + h1) >>> 0) as number;
      const val = ((seed ^ h2) / 0x80000000) - 1.0; // in [-1, 1]
      vec[d] = (vec[d] as number) + val / Math.max(tokens.length, 1);
    }
  }

  // L2 normalize
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

/** FNV-1a 32-bit hash with custom offset basis */
function hash32(str: string, basis: number): number {
  let h = basis >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

// ── Internal util ─────────────────────────────────────────────────────────────

/** Convert number[] from fastembed to L2-normalised Float32Array(768). */
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

/** Exposed for tests: reset singleton so backend can be re-initialised. */
/**
 * Await full termination of the embed worker thread. Use in test teardown so the
 * vitest fork can exit cleanly — the worker (and its onnxruntime native threads) must
 * be gone before the test file finishes, which the fire-and-forget `_resetEmbedSingleton`
 * does not guarantee.
 */
export async function _shutdownEmbedWorker(): Promise<void> {
  const w = _worker;
  _worker = null;
  _workerReady = false;
  _workerReadyPromise = null;
  _pending.clear();
  if (!w) return;
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = (): void => { if (!done) { done = true; resolve(); } };
    w.once('exit', finish);
    // Ask the worker to exit voluntarily between messages. A forced terminate() while
    // onnxruntime native code is on the stack can hard-abort the host (V8 ReportApiFailure).
    try { w.postMessage({ __shutdown: true }); } catch { void w.terminate().finally(finish); }
    // Fallback: if the worker does not exit promptly, force-terminate.
    const t = setTimeout(() => { if (!done) void w.terminate().finally(finish); }, 3000);
    if (typeof t.unref === 'function') t.unref();
  });
}

export function _resetEmbedSingleton(): void {
  if (_worker) {
    _worker.terminate().catch(() => {/* ignore */});
    _worker = null;
  }
  _workerReady = false;
  _workerReadyPromise = null;
  _pending.clear();
  _nextId = 1;
  _resolvedBackend = null;
  _activeModel = 'nomic-embed-text-v1.5-hash';
  _configCache = null;
}
