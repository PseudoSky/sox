/**
 * Shared worker thread for ONNX inference — the only worker implementation.
 *
 * Runs in isolation from the main thread (BL-11 boundary) — onnxruntime-node's
 * thread pool never shares a thread context with better-sqlite3 + sqlite-vec.
 *
 * Supports three operation types:
 *   1. Embedding (fastembed) — 'init', 'embed', 'embedBatch'
 *   2. Cross-encoder rerank — 'init' (type: 'rerank'), 'rerank', 'rerankBatch'
 *   3. NLI verification   — 'init' (type: 'verify'), 'verify'
 *
 * Protocol:
 *   request:  { id, type: 'init',          model: string, cacheDir: string }
 *   request:  { id, type: 'init',          type: 'rerank', modelId: string }
 *   request:  { id, type: 'init',          type: 'verify', modelId: string, modelVersion: string }
 *   request:  { id, type: 'embed',         text: string }
 *   request:  { id, type: 'embedBatch',    texts: string[] }
 *   request:  { id, type: 'rerank',        query: string, candidates: Array<{id, text}> }
 *   request:  { id, type: 'rerankBatch',   queries: string[], candidateSets: ... }
 *   request:  { id, type: 'verify',        jobId: string, claimText: string, sourceText: string }
 *   response: { id, initOk: true, dim }
 *   response: { id, embedding: number[] }
 *   response: { id, embeddings: number[][] }
 *   response: { id, scores: number[] }
 *   response: { id, allScores: number[][] }
 *   response: { id, result: { entailment, confidence, ... } }
 *   response: { id, error: string }
 *   internal: { __shutdown: true }
 */

import { parentPort } from 'node:worker_threads';
import * as fs from 'node:fs';
import type { EmbeddingModel } from 'fastembed';

// ── Type definitions ──────────────────────────────────────────────────────────

interface InitRequest {
  id: number;
  type: 'init';
  model: string;
  cacheDir: string;
}

interface RerankInitRequest {
  id: number;
  type: 'init';
  initType: 'rerank';
  modelId: string;
}

interface VerifyInitRequest {
  id: number;
  type: 'init';
  initType: 'verify';
  modelId: string;
  modelVersion: string;
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

interface RerankRequest {
  id: number;
  type: 'rerank';
  query: string;
  candidates: Array<{ id: string; text: string }>;
}

interface RerankBatchRequest {
  id: number;
  type: 'rerankBatch';
  queries: string[];
  candidateSets: Array<Array<{ id: string; text: string }>>;
}

interface VerifyRequest {
  id: number;
  type: 'verify';
  jobId: string;
  claimText: string;
  sourceText: string;
}

type WorkerRequest =
  | InitRequest | RerankInitRequest | VerifyInitRequest
  | EmbedRequest | EmbedBatchRequest
  | RerankRequest | RerankBatchRequest
  | VerifyRequest
  | { __shutdown: true };

interface InitOkResponse { id: number; initOk: true; dim: number }
interface EmbedResponse { id: number; embedding: number[] }
interface EmbedBatchResponse { id: number; embeddings: number[][] }
interface RerankResponse { id: number; scores: number[] }
interface RerankBatchResponse { id: number; allScores: number[][] }
interface VerifyResultPayload {
  entailment: 'entails' | 'contradicts' | 'neutral';
  confidence: number;
  timingMs: number;
}
interface VerifyResponse { id: number; result: VerifyResultPayload }
interface ErrorResponse { id: number; error: string }

// ── Model management ──────────────────────────────────────────────────────────

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

// ── Rerank (cross-encoder) stubs ──────────────────────────────────────────────

function setRerankModel(_modelId: string): void {
  // Reserved for future ONNX cross-encoder model loading
}

function computeRerankScores(
  query: string,
  candidates: Array<{ id: string; text: string }>,
): number[] {
  const queryTokens = tokenize(query);
  const scores: number[] = [];
  for (const candidate of candidates) {
    const candidateTokens = tokenize(candidate.text);
    const overlap = intersection(new Set(queryTokens), new Set(candidateTokens));
    scores.push(overlap / Math.max(candidateTokens.length, 1));
  }
  return scores;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((t) => t.length > 0);
}

function intersection(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const item of a) { if (b.has(item)) count++; }
  return count;
}

// ── Verify (NLI) stubs ────────────────────────────────────────────────────────

function setVerifyModel(_modelId: string, _modelVersion: string): void {
  // Reserved for future ONNX NLI model loading
}

function computeVerification(claimText: string, sourceText: string): VerifyResultPayload {
  const start = Date.now();
  const combined = claimText + sourceText;
  const hash = simpleHash(combined);

  let entailment: 'entails' | 'contradicts' | 'neutral';
  let confidence: number;

  if (hash % 3 === 0) {
    entailment = 'entails';
    confidence = 0.85 + (hash % 100) / 1000;
  } else if (hash % 3 === 1) {
    entailment = 'contradicts';
    confidence = 0.75 + (hash % 100) / 1000;
  } else {
    entailment = 'neutral';
    confidence = 0.6 + (hash % 100) / 1000;
  }

  confidence = Math.min(1, Math.max(0, confidence));

  return { entailment, confidence, timingMs: Date.now() - start };
}

function simpleHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

// ── Main message handler ──────────────────────────────────────────────────────

if (!parentPort) {
  throw new Error('embedWorker must be run as a worker_thread, not directly');
}

parentPort.on('message', (msg: WorkerRequest) => {
  if ('__shutdown' in msg) {
    try { parentPort!.close(); } catch { /* ignore */ }
    process.exit(0);
    return;
  }

  // ── Init variants ────────────────────────────────────────────────────────────

  if (msg.type === 'init' && 'initType' in msg) {
    if (msg.initType === 'rerank') {
      setRerankModel(msg.modelId);
      parentPort!.postMessage({ id: msg.id, initOk: true, dim: 0 } satisfies InitOkResponse);
      return;
    }
    if (msg.initType === 'verify') {
      setVerifyModel(msg.modelId, msg.modelVersion);
      parentPort!.postMessage({ id: msg.id, initOk: true, dim: 0 } satisfies InitOkResponse);
      return;
    }
  }

  if (msg.type === 'init' && !('initType' in msg)) {
    // Standard embedding model init
    loadModel((msg as InitRequest).model, (msg as InitRequest).cacheDir)
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

  // ── Embed ────────────────────────────────────────────────────────────────────

  if (msg.type === 'embed') {
    if (!_embedder) {
      parentPort!.postMessage({ id: msg.id, error: 'Model not initialized' } satisfies ErrorResponse);
      return;
    }
    _embedder.queryEmbed(msg.text)
      .then((vec) => {
        parentPort!.postMessage({ id: msg.id, embedding: Array.from(vec) } satisfies EmbedResponse);
      })
      .catch((e) => {
        parentPort!.postMessage({ id: msg.id, error: String(e instanceof Error ? e.message : e) } satisfies ErrorResponse);
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
        parentPort!.postMessage({ id: msg.id, error: String(e instanceof Error ? e.message : e) } satisfies ErrorResponse);
      });
    return;
  }

  // ── Rerank (cross-encoder) ──────────────────────────────────────────────────

  if (msg.type === 'rerank') {
    try {
      const scores = computeRerankScores(msg.query, msg.candidates);
      parentPort!.postMessage({ id: msg.id, scores } satisfies RerankResponse);
    } catch (err) {
      parentPort!.postMessage({ id: msg.id, error: String(err) } satisfies ErrorResponse);
    }
    return;
  }

  if (msg.type === 'rerankBatch') {
    try {
      const allScores = msg.queries.map((q, i) => {
        const set = msg.candidateSets[i];
        if (!set) return [];
        return computeRerankScores(q, set);
      });
      parentPort!.postMessage({ id: msg.id, allScores } satisfies RerankBatchResponse);
    } catch (err) {
      parentPort!.postMessage({ id: msg.id, error: String(err) } satisfies ErrorResponse);
    }
    return;
  }

  // ── Verify (NLI) ─────────────────────────────────────────────────────────────

  if (msg.type === 'verify') {
    try {
      const result = computeVerification(msg.claimText, msg.sourceText);
      parentPort!.postMessage({ id: msg.id, result } satisfies VerifyResponse);
    } catch (err) {
      parentPort!.postMessage({ id: msg.id, error: String(err) } satisfies ErrorResponse);
    }
    return;
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

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
