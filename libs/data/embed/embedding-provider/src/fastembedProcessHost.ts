/**
 * Child-PROCESS host for fastembed (onnxruntime-node@1.21.0) ONNX inference —
 * BL-238/BL-171.
 *
 * ── Why a PROCESS, not a worker thread ──────────────────────────────────────
 *
 * `embedWorker.ts` (a `worker_threads.Worker`) hosts the cross-encoder rerank
 * and NLI verify workloads, both driven by `@huggingface/transformers`'
 * onnxruntime-node@1.24.3. Two independent, empirically-proven native hazards
 * rule out ALSO hosting fastembed's onnxruntime-node@1.21.0 in that same
 * worker (or any second worker thread):
 *
 *   1. **Cross-isolate hazard (whole-process fatal).** 2+ *separate*
 *      `worker_threads.Worker` instances, each holding an active
 *      onnxruntime-node `InferenceSession` and running inference
 *      concurrently, fatally crash the ENTIRE process with:
 *        `FATAL ERROR: HandleScope::HandleScope Entering the V8 API without
 *        proper locking in place` (inside `InferenceSessionWrap::Run`).
 *      Reproduced even with TWO workers on the exact SAME onnxruntime-node
 *      version (fastembed's 1.21.0, twice) — not an ABI/version-mismatch bug,
 *      a real thread-safety limitation of the addon whenever 2+ instances are
 *      concurrently active in one process. (See `sharedOnnxWorker.ts`.)
 *
 *   2. **Same-thread native timing hazard (std::bad_alloc), proven even with
 *      strict JS-level serialization.** Loading fastembed's
 *      onnxruntime-node@1.21.0 in the SAME worker thread immediately after
 *      `@huggingface/transformers`' onnxruntime-node@1.24.3 finishes loading
 *      — even when every JS `await` is fully resolved and the two `init`
 *      calls are proven (via instrumented tracing) to run strictly one after
 *      the other with zero JS-level overlap — still deterministically threw
 *      `std::bad_alloc` on the second (fastembed) init. This means the two
 *      onnxruntime-node major versions leave lingering native state (e.g.
 *      background thread-pool teardown) that is not synchronized by the JS
 *      Promise resolving, so no amount of JS-side queuing/mutexing can make
 *      sharing one thread safe — the hazard is at the native addon level,
 *      below what JS scheduling can observe or serialize.
 *
 * Because (2) cannot be fixed by better JS scheduling, fastembed is hosted in
 * its OWN **child process** (`node:child_process.fork()`), never a
 * `worker_threads.Worker` and never sharing a thread or address space with
 * `embedWorker.ts`. Separate OS processes cannot share native TLS/global
 * allocator state or V8 isolates by construction — both hazard classes above
 * are structurally impossible across a process boundary, not merely
 * statistically less likely. This mirrors the exact isolation
 * `tools/e2e/child-embed.mjs` already validated as a test-harness-side
 * mitigation; this file makes it the real, package-level fix instead of a
 * test-only workaround (BL-238's option (c)).
 *
 * ── Protocol (IPC via `process.send`/`process.on('message')`) ──────────────
 *   request:  { id, type: 'init',       model: string, cacheDir: string }
 *   request:  { id, type: 'embed',      text: string }
 *   request:  { id, type: 'embedBatch', texts: string[] }
 *   response: { id, initOk: true, dim }
 *   response: { id, embedding: number[] }
 *   response: { id, embeddings: number[][] }
 *   response: { id, error: string }
 *   internal: { __shutdown: true }
 */

import * as fs from 'node:fs';
import type { EmbeddingModel } from 'fastembed';

// ── Type definitions ──────────────────────────────────────────────────────────

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

type HostRequest = InitRequest | EmbedRequest | EmbedBatchRequest | { __shutdown: true };

interface InitOkResponse { id: number; initOk: true; dim: number }
interface EmbedResponse { id: number; embedding: number[] }
interface EmbedBatchResponse { id: number; embeddings: number[][] }
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

async function collectEmbeddings(embedder: EmbedderInstance, texts: string[]): Promise<number[][]> {
  const results: number[][] = [];
  for await (const batch of embedder.embed(texts, 256)) {
    for (const vec of batch) {
      results.push(vec);
    }
  }
  return results;
}

// ── Serialized request queue ────────────────────────────────────────────────
//
// Defense in depth: also serialize requests within this process (init vs.
// embed/embedBatch racing against each other has no known hazard today since
// only ONE onnxruntime-node version ever loads in this process, but there is
// no benefit to concurrent native calls here either — correctness first).

let _queue: Promise<void> = Promise.resolve();

function enqueue(task: () => Promise<void>): void {
  _queue = _queue.then(task, task);
}

function send(msg: InitOkResponse | EmbedResponse | EmbedBatchResponse | ErrorResponse): void {
  process.send?.(msg);
}

async function handleRequest(msg: InitRequest | EmbedRequest | EmbedBatchRequest): Promise<void> {
  if (msg.type === 'init') {
    try {
      const { dim } = await loadModel(msg.model, msg.cacheDir);
      send({ id: msg.id, initOk: true, dim });
    } catch (e) {
      send({ id: msg.id, error: String(e instanceof Error ? e.message : e) });
    }
    return;
  }

  if (msg.type === 'embed') {
    if (!_embedder) {
      send({ id: msg.id, error: 'Model not initialized' });
      return;
    }
    try {
      const vec = await _embedder.queryEmbed(msg.text);
      send({ id: msg.id, embedding: Array.from(vec) });
    } catch (e) {
      send({ id: msg.id, error: String(e instanceof Error ? e.message : e) });
    }
    return;
  }

  if (msg.type === 'embedBatch') {
    if (!_embedder) {
      send({ id: msg.id, error: 'Model not initialized' });
      return;
    }
    try {
      const embeddings = await collectEmbeddings(_embedder, msg.texts);
      send({ id: msg.id, embeddings });
    } catch (e) {
      send({ id: msg.id, error: String(e instanceof Error ? e.message : e) });
    }
    return;
  }
}

process.on('message', (msg: HostRequest) => {
  if ('__shutdown' in msg) {
    process.exit(0);
    return;
  }
  enqueue(() => handleRequest(msg));
});

// Let the parent decide the process lifecycle (it never calls `.ref()`/relies
// on this process staying alive beyond its own `disconnect`/`kill`); nothing
// else to keep this process alive once IPC is torn down.
