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
import type {
  PreTrainedTokenizer,
  PreTrainedModel,
  Tensor,
} from '@huggingface/transformers';

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

// ── Rerank (cross-encoder) — real ONNX inference ──────────────────────────────
//
// Cross-encoder scoring uses a sequence-classification ONNX model run through
// @huggingface/transformers (which drives onnxruntime-node under the hood on
// Node — the same "load ONNX in a worker thread" pattern as fastembed above,
// BL-11). `modelId` is a logical name resolved to a concrete HuggingFace ONNX
// repo; unknown ids pass through unchanged so any Xenova-converted
// cross-encoder repo can be wired directly.
//
// Primary: MS-MARCO MiniLM cross-encoder (relevance regression — single
// logit per query/candidate pair, squashed to [0,1] via sigmoid so "higher
// score = more relevant" per the CrossEncoder contract).

const RERANK_MODEL_MAP: Record<string, string> = {
  MiniCheck: 'Xenova/ms-marco-MiniLM-L-6-v2',
  'ms-marco-MiniLM-L-6-v2': 'Xenova/ms-marco-MiniLM-L-6-v2',
  'cross-encoder/ms-marco-MiniLM-L-6-v2': 'Xenova/ms-marco-MiniLM-L-6-v2',
};

interface SequenceClassifierOutput {
  logits: Tensor;
}

let _rerankResolvedModelId = '';
let _rerankTokenizer: PreTrainedTokenizer | null = null;
let _rerankModel: PreTrainedModel | null = null;
let _rerankLoadPromise: Promise<void> | null = null;

async function setRerankModel(modelId: string): Promise<void> {
  const resolved = RERANK_MODEL_MAP[modelId] ?? modelId;
  if (_rerankModel && _rerankResolvedModelId === resolved) return;
  if (_rerankLoadPromise && _rerankResolvedModelId === resolved) return _rerankLoadPromise;

  _rerankResolvedModelId = resolved;
  _rerankLoadPromise = (async () => {
    const { AutoTokenizer, AutoModelForSequenceClassification } = await import(
      '@huggingface/transformers'
    );
    _rerankTokenizer = await AutoTokenizer.from_pretrained(resolved);
    _rerankModel = (await AutoModelForSequenceClassification.from_pretrained(resolved, {
      dtype: 'q8',
    })) as PreTrainedModel;
  })();

  try {
    await _rerankLoadPromise;
  } finally {
    _rerankLoadPromise = null;
  }
}

async function computeRerankScores(
  query: string,
  candidates: Array<{ id: string; text: string }>,
): Promise<number[]> {
  if (!_rerankTokenizer || !_rerankModel) {
    throw new Error('Rerank model not initialized — send init{initType:"rerank"} first');
  }
  if (candidates.length === 0) return [];

  const queries = new Array(candidates.length).fill(query) as string[];
  const texts = candidates.map((c) => c.text);
  const features = _rerankTokenizer(queries, {
    text_pair: texts,
    padding: true,
    truncation: true,
  });

  const output = (await _rerankModel(features)) as SequenceClassifierOutput;
  const rows = output.logits.tolist() as number[][];
  return rows.map((row) => sigmoid(row[0] ?? 0));
}

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

// ── Verify (NLI) — real ONNX inference ─────────────────────────────────────────
//
// NLI verification uses a 3-way entailment/contradiction/neutral cross-encoder
// (SPEC accuracy-optimized family: cross-encoder/nli-deberta-v3-*). The
// premise is the source passage, the hypothesis is the claim. Softmax over
// the model's own `id2label` (never hardcoded ordering) yields entailment +
// confidence; `entailment`/`contradiction`/`neutral` are mapped onto the
// frozen wire vocabulary `'entails'|'contradicts'|'neutral'`.

const VERIFY_MODEL_MAP: Record<string, string> = {
  MiniCheck: 'Xenova/nli-deberta-v3-xsmall',
  'nli-deberta-v3-xsmall': 'Xenova/nli-deberta-v3-xsmall',
  'cross-encoder/nli-deberta-v3-xsmall': 'Xenova/nli-deberta-v3-xsmall',
};

const NLI_LABEL_MAP: Record<string, 'entails' | 'contradicts' | 'neutral'> = {
  entailment: 'entails',
  contradiction: 'contradicts',
  neutral: 'neutral',
};

let _verifyResolvedModelId = '';
let _verifyTokenizer: PreTrainedTokenizer | null = null;
let _verifyModel: PreTrainedModel | null = null;
let _verifyId2Label: Record<number, string> = {};
let _verifyLoadPromise: Promise<void> | null = null;

async function setVerifyModel(modelId: string, _modelVersion: string): Promise<void> {
  const resolved = VERIFY_MODEL_MAP[modelId] ?? modelId;
  if (_verifyModel && _verifyResolvedModelId === resolved) return;
  if (_verifyLoadPromise && _verifyResolvedModelId === resolved) return _verifyLoadPromise;

  _verifyResolvedModelId = resolved;
  _verifyLoadPromise = (async () => {
    const { AutoTokenizer, AutoModelForSequenceClassification } = await import(
      '@huggingface/transformers'
    );
    _verifyTokenizer = await AutoTokenizer.from_pretrained(resolved);
    const model = await AutoModelForSequenceClassification.from_pretrained(resolved, {
      dtype: 'q8',
    });
    _verifyModel = model as PreTrainedModel;
    const config = (model as unknown as { config: { id2label?: Record<string, string> } })
      .config;
    _verifyId2Label = { ...(config?.id2label ?? {}) };
  })();

  try {
    await _verifyLoadPromise;
  } finally {
    _verifyLoadPromise = null;
  }
}

async function computeVerification(
  claimText: string,
  sourceText: string,
): Promise<VerifyResultPayload> {
  const start = Date.now();
  if (!_verifyTokenizer || !_verifyModel) {
    throw new Error('Verify model not initialized — send init{initType:"verify"} first');
  }

  // Premise = source (what we're checking against), hypothesis = claim.
  const features = _verifyTokenizer([sourceText], {
    text_pair: [claimText],
    padding: true,
    truncation: true,
  });

  const output = (await _verifyModel(features)) as SequenceClassifierOutput;
  const row = (output.logits.tolist() as number[][])[0] ?? [];
  const probs = softmax(row);

  let bestIdx = 0;
  for (let i = 1; i < probs.length; i++) {
    const candidate = probs[i];
    const current = probs[bestIdx];
    if (candidate !== undefined && (current === undefined || candidate > current)) bestIdx = i;
  }

  const rawLabel = _verifyId2Label[bestIdx] ?? 'neutral';
  const entailment = NLI_LABEL_MAP[rawLabel] ?? 'neutral';
  const confidence = probs[bestIdx] ?? 0;

  return { entailment, confidence, timingMs: Date.now() - start };
}

function softmax(logits: number[]): number[] {
  if (logits.length === 0) return [];
  const max = Math.max(...logits);
  const exps = logits.map((v) => Math.exp(v - max));
  const sum = exps.reduce((a, b) => a + b, 0);
  return exps.map((v) => v / sum);
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
      setRerankModel(msg.modelId)
        .then(() => {
          parentPort!.postMessage({ id: msg.id, initOk: true, dim: 0 } satisfies InitOkResponse);
        })
        .catch((e) => {
          parentPort!.postMessage({
            id: msg.id,
            error: String(e instanceof Error ? e.message : e),
          } satisfies ErrorResponse);
        });
      return;
    }
    if (msg.initType === 'verify') {
      setVerifyModel(msg.modelId, msg.modelVersion)
        .then(() => {
          parentPort!.postMessage({ id: msg.id, initOk: true, dim: 0 } satisfies InitOkResponse);
        })
        .catch((e) => {
          parentPort!.postMessage({
            id: msg.id,
            error: String(e instanceof Error ? e.message : e),
          } satisfies ErrorResponse);
        });
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
    computeRerankScores(msg.query, msg.candidates)
      .then((scores) => {
        parentPort!.postMessage({ id: msg.id, scores } satisfies RerankResponse);
      })
      .catch((err) => {
        parentPort!.postMessage({
          id: msg.id,
          error: String(err instanceof Error ? err.message : err),
        } satisfies ErrorResponse);
      });
    return;
  }

  if (msg.type === 'rerankBatch') {
    Promise.all(
      msg.queries.map((q, i) => {
        const set = msg.candidateSets[i];
        if (!set) return Promise.resolve([] as number[]);
        return computeRerankScores(q, set);
      }),
    )
      .then((allScores) => {
        parentPort!.postMessage({ id: msg.id, allScores } satisfies RerankBatchResponse);
      })
      .catch((err) => {
        parentPort!.postMessage({
          id: msg.id,
          error: String(err instanceof Error ? err.message : err),
        } satisfies ErrorResponse);
      });
    return;
  }

  // ── Verify (NLI) ─────────────────────────────────────────────────────────────

  if (msg.type === 'verify') {
    computeVerification(msg.claimText, msg.sourceText)
      .then((result) => {
        parentPort!.postMessage({ id: msg.id, result } satisfies VerifyResponse);
      })
      .catch((err) => {
        parentPort!.postMessage({
          id: msg.id,
          error: String(err instanceof Error ? err.message : err),
        } satisfies ErrorResponse);
      });
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
