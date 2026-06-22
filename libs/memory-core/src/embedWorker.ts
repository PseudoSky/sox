/**
 * embedWorker.ts — runs as a worker_thread, holds the ONNX runtime in isolation.
 *
 * The main thread (which holds better-sqlite3 + sqlite-vec) sends embed requests
 * via parentPort.postMessage; this worker responds with the embedding vector.
 * This prevents the BL-11 libpthread mutex corruption: onnxruntime-node's thread
 * pool never runs in the same thread context as the SQLite native handle.
 *
 * Protocol:
 *   request:  { id: number, text: string, cacheDir: string }
 *   response: { id: number, embedding: number[] }
 *           | { id: number, error: string }
 */

import { parentPort } from 'node:worker_threads';
import * as fs from 'node:fs';

interface EmbedRequest {
  id: number;
  text: string;
  cacheDir: string;
}

interface EmbedResponse {
  id: number;
  embedding?: number[];
  error?: string;
}

let _embedder: { queryEmbed(text: string): Promise<number[]> } | null = null;
let _initPromise: Promise<void> | null = null;
let _initCacheDir = '';

async function ensureEmbedder(cacheDir: string): Promise<{ queryEmbed(text: string): Promise<number[]> }> {
  if (_embedder && _initCacheDir === cacheDir) return _embedder;
  if (!_initPromise || _initCacheDir !== cacheDir) {
    _initCacheDir = cacheDir;
    _initPromise = (async () => {
      const { FlagEmbedding, EmbeddingModel } = await import('fastembed');
      fs.mkdirSync(cacheDir, { recursive: true });
      _embedder = await FlagEmbedding.init({
        model: EmbeddingModel.BGEBaseENV15,
        cacheDir,
        showDownloadProgress: false,
      });
    })();
  }
  await _initPromise;
  return _embedder!;
}

if (!parentPort) {
  throw new Error('embedWorker must be run as a worker_thread, not directly');
}

parentPort.on('message', (msg: EmbedRequest | { __shutdown: true }) => {
  // Graceful shutdown: exit voluntarily between messages (no onnxruntime native op on
  // the stack), avoiding the hard V8 abort that worker.terminate() triggers when it
  // force-kills the thread mid-inference.
  if ('__shutdown' in msg) {
    try { parentPort!.close(); } catch { /* ignore */ }
    process.exit(0);
    return;
  }
  const req = msg;
  ensureEmbedder(req.cacheDir)
    .then(async (inst) => {
      const vec = await inst.queryEmbed(req.text);
      (parentPort!).postMessage({ id: req.id, embedding: Array.from(vec) } satisfies EmbedResponse);
    })
    .catch((e) => {
      (parentPort!).postMessage({ id: req.id, error: String(e) } satisfies EmbedResponse);
    });
});
