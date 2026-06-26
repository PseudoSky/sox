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
 */

import * as fs from 'node:fs';
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

/**
 * BL-54: the truthful embed-subsystem state, distinguishing "the real worker has not
 * warmed up yet" from "we actually fell back to hash". memory_ping / memory_stats use
 * this so a freshly-served server (zero embeds yet) does NOT falsely report a hash
 * fallback — the lazy-warmup artifact that triggered the BL-52 false alarm.
 *
 *   'real'          — the ONNX/BGE worker warmed up; real embeddings are active
 *                     (_activeModel flipped to 'bge-base-en-v1.5').
 *   'hash'          — hash embedding is the resolved backend: either configured
 *                     (SOX_EMBED_BACKEND=hash) or an auto/real fallback that occurred.
 *   'uninitialized' — no embed() has run yet (and no warmup completed); the backend is
 *                     not yet determined. NOT a fallback.
 */
export type EmbedState = 'real' | 'hash' | 'uninitialized';
export function getEmbedState(): EmbedState {
  if (_activeModel === 'bge-base-en-v1.5') return 'real';
  if (_resolvedBackend === 'hash') return 'hash';
  return 'uninitialized';
}

// BL-89: the last error the real embedding backend produced (worker spawn failure,
// fastembed/onnxruntime init failure, warmup timeout, or per-call embed failure).
// Surfaced via memory_ping / memory_stats so a silent hash downgrade becomes LOUD and
// diagnosable instead of a one-line stderr warn nobody reads. null = no failure recorded.
let _lastEmbedError: string | null = null;
export function getLastEmbedError(): string | null {
  return _lastEmbedError;
}

export interface EmbedHealth {
  state: EmbedState;
  /** Resolved active model id (truthful, runtime). */
  model: string;
  /** Configured SOX_EMBED_BACKEND ('auto' | 'real' | 'hash'). */
  backend: EmbedBackend;
  /** true when backend is auto/real but hash is actually active (silent/loud downgrade). */
  on_hash_fallback: boolean;
  /** Last real-backend error, if any. */
  last_error: string | null;
}

/** Truthful embed-subsystem health for health checks (memory_ping / memory_stats). */
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

/** Warmup timeout (ms) — bounds an indefinite worker/init hang (BL-89). Configurable. */
function warmupTimeoutMs(): number {
  const raw = Number(process.env['SOX_EMBED_WARMUP_TIMEOUT_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/** Reject a promise if it does not settle within `ms`. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const to = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    if (typeof to.unref === 'function') to.unref();
    p.then(
      (v) => { clearTimeout(to); resolve(v); },
      (e) => { clearTimeout(to); reject(e instanceof Error ? e : new Error(String(e))); },
    );
  });
}

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

  // Resolve the absolute path to embedWorker.js robustly, independent of the
  // process cwd and vitest's parallel fork pool cwd juggling (BL-29).
  //
  // Strategy:
  //  1. Try `__dirname` first — correct at runtime (embed.js and embedWorker.js
  //     are siblings in dist/).
  //  2. If the file doesn't exist there (e.g. vitest transpiles from src/ so
  //     __dirname = src/ but embedWorker.js was built to dist/), walk up to the
  //     package root and resolve via dist/embedWorker.js.
  //  3. As a final guard, use the raw __dirname join (which will produce a useful
  //     error message if even that fails).
  //
  // All three branches produce an absolute path, so fork-cwd changes are irrelevant.
  let workerPath = path.join(__dirname, 'embedWorker.js');
  if (!fs.existsSync(workerPath)) {
    // __dirname is src/ (vitest transpilation context); built worker is in dist/
    const pkgRoot = path.resolve(__dirname, '..');
    const distWorker = path.join(pkgRoot, 'dist', 'embedWorker.js');
    if (fs.existsSync(distWorker)) {
      workerPath = distWorker;
    }
    // else: keep the original path so the Worker constructor gives a clear error
  }
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
    // BL-89: record the real worker error (e.g. Worker constructor failure when
    // embedWorker.js is missing from the bundle) so health checks can surface it.
    _lastEmbedError = `embed worker error: ${err.message}`;
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
      _lastEmbedError = err.message;
      for (const { reject } of _pending.values()) reject(err);
      _pending.clear();
    }
    _worker = null;
    _workerReady = false;
    _workerReadyPromise = null;
  });

  // Send a warmup embed so the model is loaded before the first real request.
  // We treat this as a fire-and-forget; failures are surfaced on the first real call.
  // BL-89: bound the warmup with a timeout so an indefinite worker/init hang (the
  // observed dev-box symptom) cannot wedge every caller forever — it resolves to a
  // recorded error instead, which health checks surface.
  _workerReadyPromise = new Promise<void>((resolve) => {
    const id = _nextId++;
    let settled = false;
    const to = setTimeout(() => {
      if (settled) return;
      settled = true;
      _pending.delete(id);
      _lastEmbedError = `embed worker warmup timed out after ${warmupTimeoutMs()}ms`;
      console.error(`[sox-memory] ${_lastEmbedError}`);
      _workerReadyPromise = null;
      resolve(); // don't block; caller will get/report the error
    }, warmupTimeoutMs());
    if (typeof to.unref === 'function') to.unref();
    _pending.set(id, {
      resolve: () => {
        if (settled) return;
        settled = true;
        clearTimeout(to);
        _workerReady = true;
        _activeModel = 'bge-base-en-v1.5';
        _resolvedBackend = 'real';
        _lastEmbedError = null;
        resolve();
      },
      reject: (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(to);
        _lastEmbedError = `embed worker warmup failed: ${e.message}`;
        _workerReadyPromise = null;
        resolve(); // don't block; caller will get the error on first real embed
        console.error(`[sox-memory] ${_lastEmbedError}`);
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
    // backend='real' is fail-LOUD by contract: never downgrade to hash. A worker/init
    // failure or hang (bounded by withTimeout) throws with the real cause recorded.
    try {
      const vec = await withTimeout(workerEmbed(text, config), warmupTimeoutMs(), 'real embed');
      return toFloat32Normalised(vec);
    } catch (err) {
      _lastEmbedError = String(err instanceof Error ? err.message : err);
      throw new Error(
        `[sox-memory] embedding.backend='real' but worker embed failed: ${_lastEmbedError}`,
      );
    }
  }

  // 'auto': try real via worker, fall back to hash — but make the fallback LOUD (BL-89)
  // and record the cause so memory_ping / memory_stats can report WHY real is off.
  try {
    const vec = await withTimeout(workerEmbed(text, config), warmupTimeoutMs(), 'auto embed');
    return toFloat32Normalised(vec);
  } catch (err) {
    const cause = String(err instanceof Error ? err.message : err);
    if (_resolvedBackend === null || _resolvedBackend !== 'hash') {
      _lastEmbedError = cause;
      console.error(
        '[sox-memory] Real embedding model unavailable; FALLING BACK TO HASH embedding ' +
          '(degraded semantic recall — see BL-86/87/89). ' +
          `Cause: ${cause}. Set SOX_EMBED_BACKEND=hash to opt in intentionally and silence this.`,
      );
      _resolvedBackend = 'hash';
      _activeModel = 'nomic-embed-text-v1.5-hash';
    }
  }

  return hashEmbed(text);
}

/**
 * Proactively warm up the real embedding backend and return its truthful health.
 *
 * Call this at server startup so an embedding-runtime failure is reported LOUDLY at
 * boot (and via memory_ping) instead of silently degrading to hash on the first write.
 *
 *  - backend='hash'  → no-op, returns hash health.
 *  - backend='auto'  → attempts real; on failure records the cause + falls back to hash
 *                      (loud), returns health with on_hash_fallback:true and last_error set.
 *  - backend='real'  → attempts real; on failure THROWS (fail-loud, no downgrade).
 */
export async function warmupEmbed(timeoutMs?: number): Promise<EmbedHealth> {
  const config = (_configCache ??= resolveConfig());
  if (config.backend === 'hash') {
    _resolvedBackend = 'hash';
    return getEmbedHealth();
  }
  const ms = timeoutMs ?? warmupTimeoutMs();
  try {
    const vec = await withTimeout(workerEmbed('warmup', config), ms, 'embed warmup');
    toFloat32Normalised(vec); // validate shape
    _lastEmbedError = null;
    return getEmbedHealth();
  } catch (err) {
    const cause = String(err instanceof Error ? err.message : err);
    _lastEmbedError = cause;
    if (config.backend === 'real') {
      console.error(
        `[sox-memory] FATAL: embedding.backend='real' but warmup failed: ${cause}`,
      );
      throw new Error(cause);
    }
    console.error(
      '[sox-memory] Real embedding warmup failed; FALLING BACK TO HASH (degraded recall). ' +
        `Cause: ${cause}`,
    );
    _resolvedBackend = 'hash';
    _activeModel = 'nomic-embed-text-v1.5-hash';
    return getEmbedHealth();
  }
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
    // sqlite-vec vec0 virtual tables do NOT support INSERT OR REPLACE (raises a UNIQUE
    // PK error). Use UPDATE for an existing row; INSERT only when the row is absent.
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
  _lastEmbedError = null;
}
