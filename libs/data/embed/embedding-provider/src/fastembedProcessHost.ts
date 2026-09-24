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
import type { EmbeddingModel, ExecutionProvider } from 'fastembed';
import { bootstrapChildTelemetry, childTelemetrySnapshot, log } from '@adhd/sox-telemetry';
import { resolveFastembedLockPath, resolveFastembedServiceLabel, type FastembedLockInfo } from './fastembedLock.js';
// BUG-005: MODEL_MAP + resolveModelDim live in the side-effect-free
// `fastembedModels.js` (see its doc comment — importing them from
// `./fastembed.js` here would drag parent-side modules into this child
// bundle via their `import.meta.url` module-scope resolution, BL-155).
import { MODEL_MAP, resolveModelDim } from './fastembedModels.js';

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
// of `ps`/`vm_stat` archaeology. It is an OBSERVABILITY aid, not a claim about
// the cause of any slowdown — the 25-50x class it names is associated with a
// second host by UNPROVEN hypothesis only.
//
// This lock is advisory-only — it never blocks or refuses to load the model
// (a legitimate second store/project running its own memory-server on the
// same machine is a real, supported scenario, not a bug). It exists purely
// so a FUTURE occurrence of a second host is a loud, immediately greppable
// stderr line at model-load time, instead of a silent slowdown that takes an
// agent an afternoon of `ps`/`vm_stat` archaeology to diagnose.
// BL-471: `resolveFastembedLockPath()` and `FastembedLockInfo` now live in
// `./fastembedLock.ts` — the single shared definition imported by both this
// writer and `sharedFastembedProcess.ts`'s reader. See that module's doc
// comment for why it isn't just this file.

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
  // (BUG-MEMORY-EMBED-HEAD-OF-LINE-BLOCKING-001) Set by `SharedFastembedProcessClient
  // .ensureProcess()` only when this child was forked as one member of a
  // `FastembedProcessPool` — undefined for a lone (non-pooled) client, which
  // preserves today's exact behaviour there. See `fastembedLock.ts`'s
  // `poolGroup` doc comment for why this must be checked before warning.
  const ownPoolGroup = process.env['SOX_FASTEMBED_POOL_GROUP'];
  // (BL-432) The OWNING service's identity, threaded from the parent via
  // `SOX_FASTEMBED_SERVICE` (the same env pattern as `SOX_FASTEMBED_POOL_GROUP`
  // directly above). `undefined` for a host whose owner never declared a
  // service — see `fastembedLock.ts`'s `service` doc comment.
  const ownService = resolveFastembedServiceLabel();
  try {
    if (fs.existsSync(lockPath)) {
      const raw = fs.readFileSync(lockPath, 'utf8');
      const prev = JSON.parse(raw) as Partial<FastembedLockInfo>;
      const isKnownPoolSibling =
        typeof prev.poolGroup === 'string' &&
        ownPoolGroup !== undefined &&
        prev.poolGroup === ownPoolGroup;
      // (BL-432) The sequential-CLI false positive: a lock naming OUR OWN
      // service (e.g. a previous run of the same CLI, or a second instance of
      // the same service) is not "a genuinely unrelated fastembed host".
      // Suppress it exactly as a pool sibling is suppressed. Requires BOTH
      // sides to carry a real identity — `ownService === undefined` (owner
      // never declared one) or an unlabelled/old lock keeps the original
      // warn-on-any-live-pid behaviour.
      const isSameService =
        typeof prev.service === 'string' &&
        ownService !== undefined &&
        prev.service === ownService;
      if (
        typeof prev.pid === 'number' &&
        prev.pid !== process.pid &&
        isPidAlive(prev.pid) &&
        !isKnownPoolSibling &&
        !isSameService
      ) {
        const prevService = typeof prev.service === 'string' ? prev.service : 'unknown';
        const msg = `another fastembed host process (pid ${prev.pid}, ` +
            `service ${prevService}, ` +
            `started ${prev.startedAt ?? 'unknown'}) is ALREADY RUNNING on this machine. ` +
            `A second concurrent onnxruntime-node CoreML/ANE host is the leading, UNPROVEN ` +
            `hypothesis for the 25-50x embed-latency class this lock exists to make visible — the ` +
            `measured cause of the live BL-331 slowdown was scheduling QoS, NOT Neural Engine ` +
            `contention (see this file's header). If pid ${prev.pid} is a leaked/orphaned process ` +
            `(check with \`ps -p ${prev.pid}\`), terminate it. Lock file: ${lockPath}`;
        console.error(`[fastembed] WARNING (BL-331): ${msg}`);
        log.warn('embedding_provider.fastembed.competing_host_detected', {
          competing_pid: prev.pid,
          competing_service: prevService,
          competing_started_at: prev.startedAt ?? 'unknown',
          lock_file: lockPath,
        });
      }
    }
  } catch (err) {
    // Never let a malformed/unreadable lock file block real startup — this
    // is a pure observability aid, not a correctness mechanism.
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[fastembed] BL-331 lock check failed (non-fatal): ${errMsg}`);
    log.warn('embedding_provider.fastembed.lock_check_failed', {
      error: errMsg,
    });
  }

  try {
    const info: FastembedLockInfo = {
      pid: process.pid,
      startedAt: new Date().toISOString(),
      ...(ownPoolGroup !== undefined ? { poolGroup: ownPoolGroup } : {}),
      ...(ownService !== undefined ? { service: ownService } : {}),
    };
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

// (Page-in telemetry, host-side) `host_majflt`/`host_minflt` are
// process.resourceUsage() major/minor page-fault DELTAS spanning the same
// window as work_ms/cpu_ms (see measureWork() below); `host_queue_ms` is the
// receipt->task-start wait on this child's own serialized `_queue` (see
// `handleRequest`). All three are optional: absent on an error reply (the
// measured span never completed) or when resourceUsage() throws on a
// platform that doesn't support it (guarded in measureWork()).
interface InitOkResponse { id: number; initOk: true; dim: number; execution_provider: string; work_ms: number; cpu_ms: number; host_majflt?: number; host_minflt?: number; host_queue_ms?: number }
interface EmbedResponse { id: number; embedding: number[]; work_ms: number; cpu_ms: number; host_majflt?: number; host_minflt?: number; host_queue_ms?: number }
interface EmbedBatchResponse { id: number; embeddings: number[][]; work_ms: number; cpu_ms: number; host_majflt?: number; host_minflt?: number; host_queue_ms?: number }
interface ErrorResponse { id: number; error: string }

// ── Model management ──────────────────────────────────────────────────────────

// BUG-005: the raw model name → fastembed id map now lives in the shared
// side-effect-free `fastembedModels.ts` (imported above), so the dim
// resolution (`resolveModelDim`) uses the SAME source of truth as the
// parent-side model configs.

interface EmbedderInstance {
  queryEmbed(text: string): Promise<number[]>;
  embed(texts: string[], batchSize?: number): AsyncGenerator<number[][], void, unknown>;
  listSupportedModels(): Array<{ model: EmbeddingModel; dim: number; description: string }>;
}

let _embedder: EmbedderInstance | null = null;
let _currentModel = '';
let _currentCacheDir = '';
let _currentExecutionProvider = 'cpu';

function resolveExecutionProviders(): ExecutionProvider[] {
  const forced = process.env.SOX_EMBED_EXECUTION_PROVIDER;
  if (forced) {
    console.error(`[fastembed] Using forced execution provider: ${forced}`);
    log.info('embedding_provider.fastembed.execution_provider_forced', {
      provider: forced,
    });
    return [forced as ExecutionProvider, 'cpu' as ExecutionProvider];
  }
  if (process.platform === 'darwin') return ['coreml' as ExecutionProvider, 'cpu' as ExecutionProvider];
  if (process.platform === 'linux' && process.arch === 'x64') return ['cuda' as ExecutionProvider, 'cpu' as ExecutionProvider];
  if (process.platform === 'win32') return ['dml' as ExecutionProvider, 'cpu' as ExecutionProvider];
  return ['cpu' as ExecutionProvider];
}

async function loadModel(model: string, cacheDir: string): Promise<{ dim: number; execution_provider: string }> {
  if (!(_embedder && _currentModel === model && _currentCacheDir === cacheDir)) {
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
    _currentExecutionProvider = executionProviders[0]!;
  }

  // BUG-005: the pre-fix lookup `listSupportedModels().find((m) => m.model === model)`
  // compared the RAW configured name ('bge-base-en-v1.5') against fastembed's
  // enum VALUE ('fast-bge-base-en-v1.5') — it never matched, so the init reply
  // always carried dim 0. `resolveModelDim` matches against the enum constant
  // (MODEL_MAP) first, then falls back to the resolved MODEL_CONFIGS entry
  // (covers custom models like bge-m3 / codexembed-400m that the supported
  // list never contains). A still-unknown model FAILS LOUD here instead of
  // replying dim 0: the init reply contract is dim > 0 or an error.
  const dim = resolveModelDim(model, _embedder.listSupportedModels());
  if (dim <= 0) {
    throw new Error(
      `Cannot report embedding dimension for model "${model}" (fastembed id "${MODEL_MAP[model] ?? model}"): ` +
        `not in listSupportedModels() and no MODEL_CONFIGS entry — refusing to report dim 0 (BUG-005)`,
    );
  }
  return { dim, execution_provider: _currentExecutionProvider };
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

/**
 * (Embed-host page-in vs. compute telemetry) Wall-clock and CPU-time deltas
 * for a single request's actual on-CPU work, measured entirely INSIDE this
 * child process around the real fastembed/onnxruntime call. Distinct from
 * the parent's `response_ms` (`sharedFastembedProcess.ts`'s `request()`),
 * which spans `child.send()` → reply and therefore also includes IPC
 * marshalling and any time the request sat queued behind others on this
 * same child (BL-432's `queue_depth`/`response_ms`) — i.e. "page-in"/queue
 * wait that looks identical to compute from the parent's vantage point.
 * `cpuUsage().user + .system` is wall-independent (a request that blocks on
 * disk/model-load I/O without spinning the CPU shows low `cpu_ms` despite a
 * large `work_ms`), which is exactly the signal needed to tell the two apart.
 *
 * CAVEAT — `process.cpuUsage()` is whole-PROCESS, not per-request.
 * `handleRequest` is async and this child can have several requests awaiting
 * concurrently, so both `work_ms` (wall time) and `cpu_ms` for one request
 * can include time spent on other requests overlapping it on this same
 * child. The page-in vs. compute distinction above is exact only when
 * requests are effectively serialized on this child; under real concurrency
 * treat both numbers as upper bounds shared across the overlapping set.
 *
 * (Page-in vs. compute, CoreML addendum) `cpu_ms` alone still under-reports
 * on the `coreml` execution provider: ANE/GPU execution time is dispatched
 * off-CPU and never accrues to `process.cpuUsage()`, so a request that is
 * genuinely blocked waiting on a page-in (first touch of a model weight
 * page not yet resident) looks identical to one blocked waiting on the ANE
 * — both show high `work_ms`, low `cpu_ms`. `process.resourceUsage()`'s
 * `majorPageFault`/`minorPageFault` DELTAS across the same window
 * disambiguate the page-in case specifically: a nonzero `host_majflt` means
 * the kernel actually served a fault from disk/backing-store during this
 * request, which ANE/GPU compute time alone cannot produce.
 */
function measureWork<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; work_ms: number; cpu_ms: number; host_majflt?: number; host_minflt?: number }> {
  const startedAt = performance.now();
  const cpuStart = process.cpuUsage();
  const resourceStart = typeof process.resourceUsage === 'function' ? process.resourceUsage() : undefined;
  return fn().then((result) => {
    const cpuDelta = process.cpuUsage(cpuStart);
    let host_majflt: number | undefined;
    let host_minflt: number | undefined;
    if (resourceStart) {
      try {
        const resourceEnd = process.resourceUsage();
        host_majflt = resourceEnd.majorPageFault - resourceStart.majorPageFault;
        host_minflt = resourceEnd.minorPageFault - resourceStart.minorPageFault;
      } catch (err) {
        // Non-fatal: page-fault telemetry is an observability aid, never a
        // correctness mechanism — a platform without resourceUsage() support
        // (or a transient failure) must not break the embed reply.
        const errMsg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[fastembed-host] resourceUsage() failed (non-fatal): ${errMsg}\n`);
      }
    }
    return {
      result,
      work_ms: Math.round(performance.now() - startedAt),
      cpu_ms: Math.round((cpuDelta.user + cpuDelta.system) / 1000),
      ...(host_majflt !== undefined ? { host_majflt } : {}),
      ...(host_minflt !== undefined ? { host_minflt } : {}),
    };
  });
}

/**
 * (Host-side queue wait) `receivedAt` is stamped at `process.on('message')`
 * time, BEFORE this task is enqueued onto `_queue`; `host_queue_ms` — taken
 * here, at the moment this task actually starts running — is the wait this
 * specific request spent sitting behind whatever else was already queued on
 * this same child (BUG-005/BL-432's head-of-line blocking), a component of
 * `work_ms` that `measureWork()` alone cannot isolate since `work_ms` only
 * starts timing once the task is already executing.
 */
async function handleRequest(
  msg: InitRequest | EmbedRequest | EmbedBatchRequest,
  receivedAt: number,
): Promise<void> {
  const host_queue_ms = Math.round(performance.now() - receivedAt);

  if (msg.type === 'init') {
    try {
      const { result, work_ms, cpu_ms, host_majflt, host_minflt } = await measureWork(() =>
        loadModel(msg.model, msg.cacheDir),
      );
      send({
        id: msg.id,
        initOk: true,
        dim: result.dim,
        execution_provider: result.execution_provider,
        work_ms,
        cpu_ms,
        host_queue_ms,
        ...(host_majflt !== undefined ? { host_majflt } : {}),
        ...(host_minflt !== undefined ? { host_minflt } : {}),
      });
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
      const embedder = _embedder;
      const { result, work_ms, cpu_ms, host_majflt, host_minflt } = await measureWork(() => embedder.queryEmbed(msg.text));
      send({
        id: msg.id,
        embedding: Array.from(result),
        work_ms,
        cpu_ms,
        host_queue_ms,
        ...(host_majflt !== undefined ? { host_majflt } : {}),
        ...(host_minflt !== undefined ? { host_minflt } : {}),
      });
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
      const embedder = _embedder;
      const { result, work_ms, cpu_ms, host_majflt, host_minflt } = await measureWork(() =>
        collectEmbeddings(embedder, msg.texts),
      );
      send({
        id: msg.id,
        embeddings: result,
        work_ms,
        cpu_ms,
        host_queue_ms,
        ...(host_majflt !== undefined ? { host_majflt } : {}),
        ...(host_minflt !== undefined ? { host_minflt } : {}),
      });
    } catch (e) {
      send({ id: msg.id, error: String(e instanceof Error ? e.message : e) });
    }
    return;
  }
}

/**
 * (BL-426) On `__shutdown`, let any in-flight/queued request settle and then
 * `process.disconnect()` instead of calling `process.exit(0)`.
 *
 * `process.exit()` forces an ABRUPT teardown: it skips draining the event
 * loop and runs native `atexit`/static-destructor unwinding immediately,
 * regardless of what else is still alive in the process. Once an
 * onnxruntime-node `InferenceSession` has been created in this process
 * (`loadModel()` above — even a bare `init` with no `embed` call is
 * sufficient), onnxruntime's own native background thread pool is still
 * alive/tearing down when that abrupt unwind runs, and the two race on a
 * native mutex. Reproduced in total isolation (no memory-server, no
 * backend.ts, no Turso, no ONNX rerank worker — this file forked directly
 * and driven with a real `init`/`embed`/`__shutdown` sequence), on BOTH the
 * `coreml` and `cpu` execution providers, and even with `init` alone (no
 * `embed` call ever made):
 *
 *   libc++abi: terminating due to uncaught exception of type
 *   std::__1::system_error: mutex lock failed: Invalid argument
 *   (child exits via SIGABRT, not code 0)
 *
 * `process.disconnect()` closes the IPC channel and lets Node run its
 * NORMAL exit sequence once the event loop is otherwise empty — no forced
 * unwind mid-native-teardown. Verified the same isolated repro exits code 0
 * with no crash text once `process.exit(0)` is replaced with this. See
 * BL-426 in BACKLOG.md / `fastembedProcessHost-bl426-shutdown.spec.ts`.
 *
 * Waiting for `_queue` first (rather than disconnecting immediately) avoids
 * dropping a request that was still in flight when `__shutdown` arrived.
 */
process.on('message', (msg: HostRequest) => {
  if ('__shutdown' in msg) {
    void _queue.finally(() => {
      process.disconnect();
    });
    return;
  }
  const receivedAt = performance.now();
  enqueue(() => handleRequest(msg, receivedAt));
});

/**
 * (BL-404 universal-coverage) CHILD composition root. This file is the forked
 * child PROCESS (the parent's `initTelemetry` never crosses the fork — each
 * process has its own module-level `_state` in @adhd/sox-telemetry's
 * runtime.ts), so the child needs its own init or every record it ever emits
 * hits the logSink:'none' fallback. Today the child emits nothing via
 * @adhd/sox-telemetry (only console.error), and DurableJsonlSink opens its file
 * lazily on first write — so this is a zero-side-effect defensive composition
 * root until the child actually emits. Role 'harness' keeps the OTel SDK off
 * (otelDefaultFor) and the default logDir lands under SOX_ECOSYSTEM_HOME when a
 * test sandbox sets it, keeping test runs hermetic.
 *
 * BL-618: this now uses `bootstrapChildTelemetry` (the spawn-time convention)
 * and ACKS its state to the parent with a `telemetry.ready` message, so the
 * parent (`sharedFastembedProcess.ts`) can record this child in
 * `telemetrySelfCheck().children` instead of trusting it silently.
 *
 * Non-fatal by construction: an init failure must never break embedding, so the
 * call is guarded — telemetry is an observability aid, not a correctness
 * mechanism.
 */
bootstrapChildTelemetry({ service: 'embedding-provider', role: 'harness', logSink: 'file' });

// BL-618: ack the child's telemetry state to the parent. Guarded against the
// parent already being gone (same BL-405 EPIPE rationale as `send` below).
if (process.connected) {
  process.send?.(
    { type: 'telemetry.ready', telemetry: childTelemetrySnapshot() },
    (err: Error | null) => {
      if (err) {
        process.stderr.write(`[fastembed-host] telemetry.ready send failed (parent likely exited): ${err.message}\n`);
      }
    },
  );
}

// Let the parent decide the process lifecycle (it never calls `.ref()`/relies
// on this process staying alive beyond its own `disconnect`/`kill`); nothing
// else to keep this process alive once IPC is torn down.
