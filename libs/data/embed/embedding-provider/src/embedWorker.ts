/**
 * Worker thread for fastembed ONNX inference.
 *
 * Runs in isolation from the main thread (BL-11 boundary) — onnxruntime-node's
 * thread pool never shares a thread context with better-sqlite3 + sqlite-vec.
 *
 * Protocol:
 *   request:  { id: number, type: 'init', model: string, cacheDir: string }
 *   request:  { id: number, type: 'embed', text: string }
 *   request:  { id: number, type: 'embedBatch', texts: string[] }
 *   response: { id: number, initOk: true, dim: number }
 *   response: { id: number, embedding: number[] }
 *   response: { id: number, embeddings: number[][] }
 *   response: { id: number, error: string }
 *   internal: { __shutdown: true }
 */

import { parentPort } from 'node:worker_threads';
import * as fs from 'node:fs';

import type { EmbeddingModel } from 'fastembed';

interface InitRequest {
  id: number;
  type: 'init';
  model: string;
  cacheDir: string;
}

interface EmbedRequest {
  id: number;
  type: 'embed';
  text: string;
}

interface EmbedBatchRequest {
  id: number;
  type: 'embedBatch';
  texts: string[];
}

type WorkerRequest = InitRequest | EmbedRequest | EmbedBatchRequest | { __shutdown: true };

interface InitOkResponse {
  id: number;
  initOk: true;
  dim: number;
}

interface EmbedResponse {
  id: number;
  embedding: number[];
}

interface EmbedBatchResponse {
  id: number;
  embeddings: number[][];
}

interface ErrorResponse {
  id: number;
  error: string;
}

const MODEL_MAP: Record<string, string> = {
  'bge-small-en-v1.5': 'fast-bge-small-en-v1.5',
  'bge-base-en-v1.5': 'fast-bge-base-en-v1.5',
  'multilingual-e5-large': 'fast-multilingual-e5-large',
  'bge-m3': 'BAAI/bge-m3',
  'codexembed-400m': 'CodeXEmbed-400M',
};

interface EmbedderInstance {
  queryEmbed(text: string): Promise<number[]>;
  embed(texts: string[], batchSize?: number): AsyncGenerator<number[][], void, unknown>;
  listSupportedModels(): Array<{ model: EmbeddingModel; dim: number; description: string }>;
}

let _embedder: EmbedderInstance | null = null;
let _currentModel = '';
let _currentCacheDir = '';

async function loadModel(model: string, cacheDir: string): Promise<{ dim: number }> {
  if (_embedder && _currentModel === model && _currentCacheDir === cacheDir) {
    const models = _embedder.listSupportedModels();
    const info = models.find((m) => m.model === model);
    return { dim: info?.dim ?? 0 };
  }

  const { FlagEmbedding, EmbeddingModel: EM } = await import('fastembed');
  const fastModel = MODEL_MAP[model] ?? model;
  const modelKeys = Object.keys(EM) as Array<keyof typeof EM>;
  const foundKey = modelKeys.find((k) => EM[k] === fastModel);
  const modelEnum: EmbeddingModel = foundKey ? EM[foundKey] : fastModel as EmbeddingModel;

  fs.mkdirSync(cacheDir, { recursive: true });

  _embedder = (await FlagEmbedding.init({
    model: modelEnum as Exclude<EmbeddingModel, EmbeddingModel.CUSTOM>,
    cacheDir,
    showDownloadProgress: false,
  })) as unknown as EmbedderInstance;

  _currentModel = model;
  _currentCacheDir = cacheDir;

  const models = _embedder.listSupportedModels();
  const info = models.find((m) => m.model === model);
  return { dim: info?.dim ?? 0 };
}

if (!parentPort) {
  throw new Error('embedWorker must be run as a worker_thread, not directly');
}

parentPort.on('message', (msg: WorkerRequest) => {
  if ('__shutdown' in msg) {
    try {
      parentPort!.close();
    } catch {
      /* ignore */
    }
    process.exit(0);
    return;
  }

  if (msg.type === 'init') {
    loadModel(msg.model, msg.cacheDir)
      .then(({ dim }) => {
        parentPort!.postMessage({ id: msg.id, initOk: true, dim } satisfies InitOkResponse);
      })
      .catch((e) => {
        parentPort!.postMessage({
          id: msg.id,
          error: String(e instanceof Error ? e.message : e),
        } satisfies ErrorResponse);
      });
    return;
  }

  if (msg.type === 'embed') {
    if (!_embedder) {
      parentPort!.postMessage({ id: msg.id, error: 'Model not initialized' } satisfies ErrorResponse);
      return;
    }
    _embedder
      .queryEmbed(msg.text)
      .then((vec) => {
        parentPort!.postMessage({
          id: msg.id,
          embedding: Array.from(vec),
        } satisfies EmbedResponse);
      })
      .catch((e) => {
        parentPort!.postMessage({
          id: msg.id,
          error: String(e instanceof Error ? e.message : e),
        } satisfies ErrorResponse);
      });
    return;
  }

  if (msg.type === 'embedBatch') {
    if (!_embedder) {
      parentPort!.postMessage({ id: msg.id, error: 'Model not initialized' } satisfies ErrorResponse);
      return;
    }
    collectEmbeddings(_embedder, msg.texts)
      .then((embeddings) => {
        parentPort!.postMessage({ id: msg.id, embeddings } satisfies EmbedBatchResponse);
      })
      .catch((e) => {
        parentPort!.postMessage({
          id: msg.id,
          error: String(e instanceof Error ? e.message : e),
        } satisfies ErrorResponse);
      });
    return;
  }
});

async function collectEmbeddings(
  embedder: EmbedderInstance,
  texts: string[],
): Promise<number[][]> {
  const results: number[][] = [];
  for await (const batch of embedder.embed(texts, 256)) {
    for (const vec of batch) {
      results.push(vec);
    }
  }
  return results;
}
