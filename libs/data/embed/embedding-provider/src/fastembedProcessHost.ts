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
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { EmbeddingModel, ExecutionProvider } from 'fastembed';

// ── BL-331: cross-process CoreML/ANE contention advisory lock ──────────────
//
// Root cause of BL-331 (production embed ~25-50x slower than a clean-room
// harness on the same machine): two orphaned one-shot debug scripts had each
// forked their OWN `fastembedProcessHost.js` (via `sharedFastembedProcess.ts`'s
// `getSharedFastembedProcess()`, but from a DIFFERENT `dist/` copy than the
// real server's, so it's a distinct Node module singleton and thus a distinct
// OS process) and never exited — each holding an idle CoreML
// `InferenceSession` for hours.
//
// ⚠️ MEASUREMENT CORRECTION (2026-07-31): an earlier revision of this comment
// claimed those orphans held "~900MB" each. That was wrong by more than an
// order of magnitude. Measured at kill time via `ps -eo pid,ppid,rss`:
// orphan hosts 32MB each, their parent scripts 28MB each, and the LIVE server's
// host 46MB. Reaping both freed ~120MB, not ~1.8GB — and did NOT change embed
// latency. So cross-process ANE contention is NOT an established cause of
// BL-331; treat it as UNPROVEN.
//
// What IS measured: the real server's embed calls take 8-20s wall-clock for
// tiny (<600 char) inputs at only ~34% CPU (NOT compute-bound — waiting), while
// the identical model/EP in a clean-room single-process harness measured ~0.4s.
// Note the clean-room number was taken on a quiet machine and the production
// number under load average 18-25 on 10 cores, so the ratio itself is partly
// load-confounded — record ambient load with any future comparison.
//
// The leading UNTESTED hypothesis is EP graph partitioning: CoreML cannot
// execute bge-base's 30522x768 `word_embeddings` tensor (see the
// `IsInputSupported` warning logged at every startup), so onnxruntime splits the
// graph and every inference pays a CPU/ANE boundary crossing. A CoreML-vs-CPU
// A/B would settle it; it has not been run. See BL-331.
//
// This lock remains useful regardless: nothing in this process logs the
// existence of sibling fastembed hosts, and that blindness cost an afternoon
// of `ps`/`vm_stat` archaeology.
//
// This lock is advisory-only — it never blocks or refuses to load the model
// (a legitimate second store/project running its own memory-server on the
// same machine is a real, supported scenario, not a bug). It exists purely
// so a FUTURE occurrence of this contention class is a loud, immediately
// greppable stderr line at model-load time instead of a silent 25-50x
// slowdown that takes an agent an afternoon of `ps`/`vm_stat` archaeology to
// diagnose.
/** Resolved fresh on every call (not a module-level constant) so tests can
 *  point it at an isolated temp path via SOX_FASTEMBED_LOCK_PATH without
 *  needing `vi.resetModules()`. */
function resolveFastembedLockPath(): string {
  return process.env['SOX_FASTEMBED_LOCK_PATH'] ?? join(tmpdir(), 'sox-fastembed-host.lock');
}

interface FastembedLockInfo {
  pid: number;
  startedAt: string;
}

/** True if a process with this pid is alive (best-effort; ESRCH => dead). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Check for (and then claim) the advisory single-host lock. Logs a loud,
 * greppable warning to stderr — naming the conflicting pid — if another LIVE
 * process already holds it. Always overwrites the lock with our own pid
 * afterward (last writer wins; this is advisory, not exclusive).
 */
export function checkAndClaimFastembedLock(): void {
  const lockPath = resolveFastembedLockPath();
  try {
    if (fs.existsSync(lockPath)) {
      const raw = fs.readFileSync(lockPath, 'utf8');
      const prev = JSON.parse(raw) as Partial<FastembedLockInfo>;
      if (
        typeof prev.pid === 'number' &&
        prev.pid !== process.pid &&
        isPidAlive(prev.pid)
      ) {
        console.error(
          `[fastembed] WARNING (BL-331): another fastembed host process (pid ${prev.pid}, ` +
            `started ${prev.startedAt ?? 'unknown'}) is ALREADY RUNNING on this machine. ` +
            `Concurrent onnxruntime-node CoreML/ANE execution across separate OS processes has ` +
            `been observed to cause severe (25-50x) embed latency due to Neural Engine/hardware ` +
            `queue contention, even though each process's own CPU usage looks low (it is waiting, ` +
            `not computing). If pid ${prev.pid} is a leaked/orphaned process (check with ` +
            `\`ps -p ${prev.pid}\`), terminate it. Lock file: ${lockPath}`,
        );
      }
    }
  } catch (err) {
    // Never let a malformed/unreadable lock file block real startup — this
    // is a pure observability aid, not a correctness mechanism.
    console.error(
      `[fastembed] BL-331 lock check failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  try {
    const info: FastembedLockInfo = { pid: process.pid, startedAt: new Date().toISOString() };
    fs.writeFileSync(lockPath, JSON.stringify(info));
  } catch {
    // Non-fatal: if /tmp isn't writable for some reason, just skip claiming.
  }
}

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

interface InitOkResponse { id: number; initOk: true; dim: number; execution_provider: string }
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

function resolveExecutionProviders(): ExecutionProvider[] {
  const forced = process.env.SOX_EMBED_EXECUTION_PROVIDER;
  if (forced) {
    console.error(`[fastembed] Using forced execution provider: ${forced}`);
    return [forced as ExecutionProvider, 'cpu' as ExecutionProvider];
  }
  if (process.platform === 'darwin') return ['coreml' as ExecutionProvider, 'cpu' as ExecutionProvider];
  if (process.platform === 'linux' && process.arch === 'x64') return ['cuda' as ExecutionProvider, 'cpu' as ExecutionProvider];
  if (process.platform === 'win32') return ['dml' as ExecutionProvider, 'cpu' as ExecutionProvider];
  return ['cpu' as ExecutionProvider];
}

async function loadModel(model: string, cacheDir: string): Promise<{ dim: number; execution_provider: string }> {
  if (_embedder && _currentModel === model && _currentCacheDir === cacheDir) {
    const models = _embedder.listSupportedModels();
    const info = models.find((m) => m.model === model);
    return { dim: info?.dim ?? 0, execution_provider: 'cpu' };
  }

  // BL-331: advisory contention check, once, right before the real (expensive,
  // ANE-contending) model load — see the lock helpers above for the full
  // root-cause writeup.
  checkAndClaimFastembedLock();

  const { FlagEmbedding, EmbeddingModel: EM } = await import('fastembed');
  const fastModel = MODEL_MAP[model] ?? model;
  const modelKeys = Object.keys(EM) as Array<keyof typeof EM>;
  const foundKey = modelKeys.find((k) => EM[k] === fastModel);
  const modelEnum: EmbeddingModel = foundKey ? EM[foundKey] : fastModel as EmbeddingModel;

  fs.mkdirSync(cacheDir, { recursive: true });

  const executionProviders = resolveExecutionProviders();
  _embedder = (await FlagEmbedding.init({
    model: modelEnum as Exclude<EmbeddingModel, EmbeddingModel.CUSTOM>,
    cacheDir,
    executionProviders,
    showDownloadProgress: false,
  })) as unknown as EmbedderInstance;

  _currentModel = model;
  _currentCacheDir = cacheDir;

  const models = _embedder.listSupportedModels();
  const info = models.find((m) => m.model === model);
  return { dim: info?.dim ?? 0, execution_provider: executionProviders[0]! };
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

/**
 * (BL-405) Reply to the parent, guarded against the parent already being gone.
 *
 * Without this guard, `process.send()` with no error callback throws an
 * uncaught 'error' event (EPIPE) the instant the parent's IPC channel
 * disappears — which fatally crashes THIS child (`libc++abi: terminating due
 * to uncaught exception of type std::__1::system_error`), reproduced on
 * every SIGTERM sent to the parent during BL-405 diagnosis, including with
 * no embed work in flight at the moment of the signal. Nothing previously
 * called `getSharedFastembedProcess().terminate()` on parent shutdown, so
 * this child simply outlived its own IPC pipe.
 *
 * `process.connected` short-circuits the common case (parent already fully
 * torn down); the error-callback form of `process.send()` catches the
 * narrower race where the channel closes mid-call. Either way the reply is
 * moot once the parent is gone — log and drop it instead of crashing.
 */
function send(msg: InitOkResponse | EmbedResponse | EmbedBatchResponse | ErrorResponse): void {
  if (!process.connected) return;
  process.send?.(msg, (err: Error | null) => {
    if (err) {
      process.stderr.write(`[fastembed-host] send failed (parent likely exited): ${err.message}\n`);
    }
  });
}

async function handleRequest(msg: InitRequest | EmbedRequest | EmbedBatchRequest): Promise<void> {
  if (msg.type === 'init') {
    try {
      const { dim, execution_provider } = await loadModel(msg.model, msg.cacheDir);
      send({ id: msg.id, initOk: true, dim, execution_provider });
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
