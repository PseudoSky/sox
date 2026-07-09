/**
 * Shared worker thread for @huggingface/transformers-based ONNX inference —
 * cross-encoder rerank and NLI verify.
 *
 * Runs in isolation from the main thread (BL-11 boundary) — onnxruntime-node's
 * thread pool never shares a thread context with better-sqlite3 + sqlite-vec.
 *
 * Supports two operation types:
 *   1. Cross-encoder rerank — 'init' (type: 'rerank'), 'rerank', 'rerankBatch'
 *   2. NLI verification     — 'init' (type: 'verify'), 'verify'
 *
 * Protocol:
 *   request:  { id, type: 'init',          type: 'rerank', modelId: string }
 *   request:  { id, type: 'init',          type: 'verify', modelId: string, modelVersion: string }
 *   request:  { id, type: 'rerank',        query: string, candidates: Array<{id, text}> }
 *   request:  { id, type: 'rerankBatch',   queries: string[], candidateSets: ... }
 *   request:  { id, type: 'verify',        jobId: string, claimText: string, sourceText: string }
 *   response: { id, initOk: true, dim }
 *   response: { id, scores: number[] }
 *   response: { id, allScores: number[][] }
 *   response: { id, result: { entailment, confidence, ... } }
 *   response: { id, error: string }
 *   internal: { __shutdown: true }
 *
 * ── BL-238/BL-171 ── This worker is the ONE place cross-encoder rerank and
 * NLI verify (both `@huggingface/transformers`, onnxruntime-node@1.24.3) run,
 * loaded into exactly ONE process-wide `worker_threads.Worker` (constructed
 * exclusively by `sharedOnnxWorker.ts`'s `getSharedOnnxWorker()` singleton —
 * never directly by `@adhd/sox-hybrid-search`'s cross-encoder or
 * `@adhd/sox-claim-verification`'s worker proxy).
 *
 * Root cause #1 (cross-isolate, whole-process fatal — the reason there must
 * be only ONE onnxruntime-bearing `worker_threads.Worker`, proven via a
 * from-scratch minimal repro, no test harness, no mocks): onnxruntime-node's
 * native N-API addon fatally crashes the ENTIRE process — not just the
 * offending worker — with
 *
 *   FATAL ERROR: HandleScope::HandleScope Entering the V8 API without
 *   proper locking in place
 *     ... Napi::FunctionReference::New(...)
 *     ... OrtValueToNapiValue(Napi::Env, Ort::Value&&)
 *     ... InferenceSessionWrap::Run(...)
 *
 * whenever 2+ *separate* `worker_threads.Worker` instances (i.e. 2+ separate
 * V8 isolates) each hold an active onnxruntime-node `InferenceSession` and
 * run inference concurrently — reproduced even with TWO workers using the
 * exact SAME onnxruntime-node version, so this is a genuine thread-safety
 * limitation of the addon itself, not an ABI/version-mismatch issue (see root
 * `BACKLOG.md` BL-238 for the full repro matrix).
 *
 * fastembed (onnxruntime-node@1.21.0) is DELIBERATELY NOT hosted in this
 * worker, for a SECOND, independent reason (root cause #2): even a single
 * shared worker hosting BOTH onnxruntime-node@1.21.0 (fastembed) AND
 * onnxruntime-node@1.24.3 (transformers) — loaded strictly sequentially, with
 * every JS `await` fully resolved before the next `init` begins (proven via
 * instrumented tracing showing zero JS-level overlap between the two
 * `init`s) — still deterministically threw `std::bad_alloc` the moment
 * fastembed initialised second. That means the two onnxruntime-node major
 * versions leave lingering native state (e.g. background native thread-pool
 * teardown) not synchronized by the JS Promise resolving — a hazard below
 * what JS-level scheduling/serialization can observe or prevent. Only a real
 * OS process boundary is proven safe for fastembed; see
 * `fastembedProcessHost.ts` / `sharedFastembedProcess.ts` for where fastembed
 * actually runs (its own dedicated child PROCESS, never a
 * `worker_threads.Worker`, never sharing an address space with this worker).
 *
 * Fix: every rerank/verify consumer routes through
 * `getSharedOnnxWorker().request(...)` instead of constructing its own
 * `Worker`; every fastembed consumer routes through
 * `getSharedFastembedProcess().request(...)` instead of constructing its own
 * `Worker`/process. There is never a second onnxruntime-bearing WORKER THREAD
 * alive in the process, and fastembed never shares a thread (or process) with
 * this worker at all — both crash classes above are structurally impossible,
 * not merely statistically less likely.
 */

import { parentPort } from 'node:worker_threads';
import type {
  PreTrainedTokenizer,
  PreTrainedModel,
  Tensor,
} from '@huggingface/transformers';

// ── Type definitions ──────────────────────────────────────────────────────────

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
  | RerankInitRequest | VerifyInitRequest
  | RerankRequest | RerankBatchRequest
  | VerifyRequest
  | { __shutdown: true };

interface InitOkResponse { id: number; initOk: true; dim: number }
interface RerankResponse { id: number; scores: number[] }
interface RerankBatchResponse { id: number; allScores: number[][] }
interface VerifyResultPayload {
  entailment: 'entails' | 'contradicts' | 'neutral';
  confidence: number;
  timingMs: number;
}
interface VerifyResponse { id: number; result: VerifyResultPayload }
interface ErrorResponse { id: number; error: string }

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
//
// Requests are processed by a single, strictly serialized async queue
// (`_queue`) rather than fired-and-forgotten independently. Rerank and verify
// share the same onnxruntime-node@1.24.3 addon (proven safe to run
// concurrently — see BACKLOG.md BL-238 repro (a)/(d): 2x transformers.js
// workers, and rerank+verify together, both coexist cleanly), so this is
// defense-in-depth rather than a required fix for THIS worker specifically;
// it costs nothing (both workloads are CPU-bound single-model calls) and
// keeps this worker's request handling consistent with
// `fastembedProcessHost.ts`'s own serialized queue.

if (!parentPort) {
  throw new Error('embedWorker must be run as a worker_thread, not directly');
}

let _queue: Promise<void> = Promise.resolve();

/** Enqueue a request handler so it runs strictly after every previously queued one. */
function enqueue(task: () => Promise<void>): void {
  _queue = _queue.then(task, task);
}

async function handleMessage(msg: Exclude<WorkerRequest, { __shutdown: true }>): Promise<void> {
  // ── Init variants ────────────────────────────────────────────────────────────

  if (msg.type === 'init' && msg.initType === 'rerank') {
    try {
      await setRerankModel(msg.modelId);
      parentPort!.postMessage({ id: msg.id, initOk: true, dim: 0 } satisfies InitOkResponse);
    } catch (e) {
      parentPort!.postMessage({
        id: msg.id,
        error: String(e instanceof Error ? e.message : e),
      } satisfies ErrorResponse);
    }
    return;
  }
  if (msg.type === 'init' && msg.initType === 'verify') {
    try {
      await setVerifyModel(msg.modelId, msg.modelVersion);
      parentPort!.postMessage({ id: msg.id, initOk: true, dim: 0 } satisfies InitOkResponse);
    } catch (e) {
      parentPort!.postMessage({
        id: msg.id,
        error: String(e instanceof Error ? e.message : e),
      } satisfies ErrorResponse);
    }
    return;
  }

  // ── Rerank (cross-encoder) ──────────────────────────────────────────────────

  if (msg.type === 'rerank') {
    try {
      const scores = await computeRerankScores(msg.query, msg.candidates);
      parentPort!.postMessage({ id: msg.id, scores } satisfies RerankResponse);
    } catch (err) {
      parentPort!.postMessage({
        id: msg.id,
        error: String(err instanceof Error ? err.message : err),
      } satisfies ErrorResponse);
    }
    return;
  }

  if (msg.type === 'rerankBatch') {
    try {
      const allScores = await Promise.all(
        msg.queries.map((q, i) => {
          const set = msg.candidateSets[i];
          if (!set) return Promise.resolve([] as number[]);
          return computeRerankScores(q, set);
        }),
      );
      parentPort!.postMessage({ id: msg.id, allScores } satisfies RerankBatchResponse);
    } catch (err) {
      parentPort!.postMessage({
        id: msg.id,
        error: String(err instanceof Error ? err.message : err),
      } satisfies ErrorResponse);
    }
    return;
  }

  // ── Verify (NLI) ─────────────────────────────────────────────────────────────

  if (msg.type === 'verify') {
    try {
      const result = await computeVerification(msg.claimText, msg.sourceText);
      parentPort!.postMessage({ id: msg.id, result } satisfies VerifyResponse);
    } catch (err) {
      parentPort!.postMessage({
        id: msg.id,
        error: String(err instanceof Error ? err.message : err),
      } satisfies ErrorResponse);
    }
    return;
  }
}

parentPort.on('message', (msg: WorkerRequest) => {
  if ('__shutdown' in msg) {
    try { parentPort!.close(); } catch { /* ignore */ }
    process.exit(0);
    return;
  }

  enqueue(() => handleMessage(msg));
});
