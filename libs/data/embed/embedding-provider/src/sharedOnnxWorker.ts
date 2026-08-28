/**
 * Process-wide singleton client for the ONE onnxruntime-native-bearing
 * `worker_threads.Worker` allowed to exist in this process (BL-238/BL-171).
 *
 * This worker (`embedWorker.ts`) hosts the MS-MARCO cross-encoder reranker
 * (`@adhd/sox-hybrid-search`) and the DeBERTa NLI verifier
 * (`@adhd/sox-claim-verification`) — both driven by
 * `@huggingface/transformers`' onnxruntime-node@1.24.3. fastembed embeddings
 * (`fastembed.ts`, onnxruntime-node@1.21.0) are DELIBERATELY routed
 * elsewhere — see `sharedFastembedProcess.ts` / `fastembedProcessHost.ts` —
 * for a second, independent native hazard (see below).
 *
 * ── Root cause #1 (proven via a from-scratch minimal repro, no test
 * harness, no mocks — two independent worker_threads.Worker instances, each
 * performing real ONNX inference, concurrently) ──
 *
 * onnxruntime-node's native N-API addon crashes the ENTIRE process (not
 * just the offending worker) with:
 *
 *   FATAL ERROR: HandleScope::HandleScope Entering the V8 API without
 *   proper locking in place
 *     ... Napi::FunctionReference::New(...)
 *     ... OrtValueToNapiValue(Napi::Env, Ort::Value&&)
 *     ... InferenceSessionWrap::Run(...)
 *
 * whenever 2+ *separate* `worker_threads.Worker` instances (i.e. 2+ separate
 * V8 isolates) each hold an active onnxruntime-node `InferenceSession` and
 * run inference concurrently. The crash fires from inside a `setImmediate`
 * completion callback (`onnxruntime-node/dist/backend.js`), which strongly
 * suggests the native binding keeps some global/static Napi reference that
 * is not isolate-scoped, so a background completion callback belonging to
 * one isolate's session fires while the wrong isolate (or no isolate/
 * HandleScope at all) is active.
 *
 * This reproduces even with TWO workers using the exact SAME
 * onnxruntime-node version (fastembed's 1.21.0, twice) — so it is NOT an
 * ABI/version-mismatch bug between fastembed's onnxruntime-node@1.21.0 and
 * @huggingface/transformers' onnxruntime-node@1.24.3; it is a genuine
 * thread-safety limitation of the onnxruntime-node native addon itself when
 * 2+ instances are concurrently active in one process, regardless of which
 * package loaded which version.
 *
 * ── Root cause #2 (why fastembed is NOT also hosted in this same worker) ──
 *
 * A single shared worker hosting BOTH onnxruntime-node@1.21.0 (fastembed)
 * AND onnxruntime-node@1.24.3 (transformers) was tried and instrumented:
 * even with the two `init` calls strictly serialized in JS (proven via
 * tracing — the second `init` provably did not begin until the first's
 * promise had fully settled), fastembed's init still deterministically threw
 * `std::bad_alloc` when it ran second. This means the two onnxruntime-node
 * major versions leave native state that JS-level Promise resolution does
 * not observe/synchronize (e.g. lingering background native thread-pool
 * teardown) — a hazard below what JS scheduling can prevent. Only a real OS
 * process boundary is proven safe for mixing the two versions; see
 * `sharedFastembedProcess.ts` for that isolation.
 *
 * ── Fix ──
 *
 * Every rerank/verify ONNX consumer in this codebase — the MS-MARCO
 * cross-encoder reranker (`@adhd/sox-hybrid-search`) and the DeBERTa NLI
 * verifier (`@adhd/sox-claim-verification`) — is routed through exactly ONE
 * lazily created, process-wide `worker_threads.Worker` running
 * `embedWorker.ts`. There is never a second onnxruntime-bearing worker alive
 * in the process, so root cause #1 is structurally impossible. fastembed
 * never shares a thread (or process) with this worker at all, so root cause
 * #2 is structurally impossible too.
 *
 * This is the ONLY place a `new Worker(embedWorker.js)` (or any other
 * onnxruntime-bearing worker) should be constructed anywhere in the
 * `@adhd/sox-embedding-provider` / `@adhd/sox-hybrid-search` /
 * `@adhd/sox-claim-verification` triangle. `CrossEncoderWorker` and
 * `WorkerProxy` delegate their wire traffic to
 * `getSharedOnnxWorker().request(...)` instead of spawning their own
 * `Worker`; `FastembedProvider` delegates to
 * `getSharedFastembedProcess().request(...)` instead (a separate child
 * PROCESS, not this worker).
 *
 * Trade-off (accepted, documented): `@adhd/sox-claim-verification`'s
 * `workerCount` pool option (`ClaimVerifierConfig.workerCount`) previously
 * gave real parallelism by spawning N separate worker threads. Since
 * rerank+verify work in the process now funnels through this single shared
 * worker, a `workerCount > 1` no longer buys extra parallelism (every
 * `WorkerProxy` in the pool proxies to the same underlying worker) — but it
 * remains safe (no crash) and does not regress correctness, only
 * throughput under artificially-forced pool concurrency. This is the
 * correct trade for a HIGH-severity whole-process crash.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import { spawnWorker, _recordChildTelemetry } from '@adhd/sox-telemetry';
import type { ChildTelemetrySnapshot } from '@adhd/sox-telemetry';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve `embedWorker.js` regardless of whether this module is running
 * compiled (`dist/sharedOnnxWorker.js`, sitting next to the compiled
 * `dist/embedWorker.js`) or transformed-in-place from source (vitest runs
 * `.ts` files directly via its SSR transform, so `__dirname` resolves to
 * `src/`, which never contains a compiled `.js`) — mirrors the same
 * `dist`-fallback pattern already proven in `embedWorker.spec.ts`.
 */
function resolveEmbedWorkerPath(): string {
  const sibling = join(__dirname, 'embedWorker.js');
  if (existsSync(sibling)) return sibling;

  const distSibling = join(__dirname, '..', 'dist', 'embedWorker.js');
  if (existsSync(distSibling)) return distSibling;

  // Last resort: return the original candidate so the resulting error names
  // the path that was actually attempted.
  return sibling;
}

interface PendingEntry {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

/**
 * Wire message shape understood by embedWorker.ts: every request/response
 * carries a numeric `id` used purely for request/response correlation.
 * Beyond `id`, the shape is a discriminated union (`type`, `error`, etc.)
 * that this client treats opaquely — callers of `request()` supply/consume
 * the typed payloads.
 */
type WorkerMessage = { id: number } & Record<string, unknown>;

export class SharedOnnxWorkerClient {
  private worker: Worker | null = null;
  private startingPromise: Promise<Worker> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();

  /** True once the underlying Worker has been created. */
  get started(): boolean {
    return this.worker !== null;
  }

  /** Lazily create (exactly once) and return the single shared Worker instance. */
  private ensureWorker(): Promise<Worker> {
    if (this.worker) return Promise.resolve(this.worker);
    if (this.startingPromise) return this.startingPromise;

    this.startingPromise = new Promise<Worker>((resolveStart) => {
      const workerPath = resolveEmbedWorkerPath();
      const w = spawnWorker(workerPath, { service: 'embedding-provider', role: 'harness', logSink: 'file' });
      _recordChildTelemetry({
        service: 'embedding-provider',
        role: 'harness',
        logSink: 'file',
        filePath: null,
        pid: w.threadId,
        source: 'embedding-provider',
      });
      w.unref();

      w.on('message', (msg: WorkerMessage) => {
        // BL-618: the worker's telemetry.ready ack carries no request `id` — it
        // must be handled BEFORE the pending lookup, and it never settles a
        // pending request, only records the worker's telemetry state.
        const ready = msg as unknown as { type?: unknown; telemetry?: ChildTelemetrySnapshot };
        if (ready.type === 'telemetry.ready' && ready.telemetry && typeof ready.telemetry === 'object') {
          _recordChildTelemetry({ ...ready.telemetry, source: 'embedding-provider', acked: true });
          return;
        }
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if ('error' in msg && typeof msg['error'] === 'string') {
          pending.reject(new Error(msg['error'] as string));
        } else {
          pending.resolve(msg);
        }
      });

      w.on('error', (err: Error) => {
        for (const { reject } of this.pending.values()) reject(err);
        this.pending.clear();
        this.worker = null;
        this.startingPromise = null;
      });

      w.on('exit', (code: number) => {
        if (code !== 0) {
          const err = new Error(`shared ONNX worker exited with code ${code}`);
          for (const { reject } of this.pending.values()) reject(err);
          this.pending.clear();
        }
        this.worker = null;
        this.startingPromise = null;
      });

      // Attaching a 'message'/'error'/'exit' listener re-refs a Worker's
      // underlying MessagePort even if `.unref()` already ran once before
      // any listener existed (carried over from the BL-fix already applied
      // to the 3 previous per-consumer worker implementations this module
      // replaces). Re-assert unref now that every listener is attached, so
      // a real process can exit once its own work is done instead of
      // hanging on this worker forever.
      w.unref();

      this.worker = w;
      resolveStart(w);
    });

    return this.startingPromise;
  }

  /**
   * Send a request to the shared worker and await its correlated response.
   * Assigns a globally-unique `id` — the caller must NOT set its own `id`
   * (any `id` field on `payload` is ignored/overwritten).
   *
   * Resolves with the raw response message (everything embedWorker.ts sent
   * back except the correlation `id` is semantically meaningful to the
   * caller — e.g. `{ initOk, dim }`, `{ embedding }`, `{ scores }`,
   * `{ result }`). Rejects if the response carries an `error` string, if
   * the shared worker itself errors/exits non-zero while the request is
   * pending, or if `timeoutMs` elapses first.
   */
  async request<T = Record<string, unknown>>(
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    const worker = await this.ensureWorker();
    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      let to: NodeJS.Timeout | undefined;
      if (timeoutMs && timeoutMs > 0) {
        to = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`shared ONNX worker request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (typeof to.unref === 'function') to.unref();
      }

      this.pending.set(id, {
        resolve: (v) => {
          if (to) clearTimeout(to);
          resolve(v as T);
        },
        reject: (e) => {
          if (to) clearTimeout(to);
          reject(e);
        },
      });

      worker.postMessage({ ...payload, id });
    });
  }

  /**
   * Forcefully terminate the shared worker. Intended ONLY for full process
   * shutdown or test teardown that genuinely owns the whole process's ONNX
   * lifecycle — an individual consumer's dispose()/stop() must NOT call
   * this, since other consumers (embed / rerank / verify) may still depend
   * on the shared worker.
   */
  async terminate(): Promise<void> {
    const w = this.worker;
    this.worker = null;
    this.startingPromise = null;
    for (const { reject } of this.pending.values()) {
      reject(new Error('shared ONNX worker terminated'));
    }
    this.pending.clear();
    if (w) await w.terminate();
  }
}

let _singleton: SharedOnnxWorkerClient | null = null;

/**
 * Process-wide singleton accessor — the ONLY sanctioned place a
 * `new Worker(embedWorker.js)` is constructed anywhere in the embed/rerank/
 * verify triangle (BL-238/BL-171). Every ONNX consumer (fastembed
 * embeddings, cross-encoder rerank, NLI verify) must obtain its worker
 * handle through this function instead of constructing its own `Worker`.
 */
export function getSharedOnnxWorker(): SharedOnnxWorkerClient {
  if (!_singleton) _singleton = new SharedOnnxWorkerClient();
  return _singleton;
}

/**
 * Test-only: reset the module-level singleton so a test can exercise a
 * fresh shared-worker lifecycle (e.g. after deliberately crashing/
 * terminating it). Does NOT terminate any existing worker itself — call
 * `.terminate()` on the previous instance first if a clean shutdown is
 * needed.
 */
export function __resetSharedOnnxWorkerForTests(): void {
  _singleton = null;
}
