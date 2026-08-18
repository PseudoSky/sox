/**
 * Process-wide singleton client for the ONE fastembed-hosting child
 * **process** allowed to exist in this process (BL-238/BL-171).
 *
 * See `fastembedProcessHost.ts` for the full root-cause writeup: fastembed's
 * onnxruntime-node@1.21.0 cannot safely share a `worker_threads.Worker` (or
 * any thread) with `@huggingface/transformers`' onnxruntime-node@1.24.3 —
 * proven not just for concurrent execution (whole-process HandleScope fatal)
 * but even for strictly JS-serialized sequential loading in the same thread
 * (deterministic `std::bad_alloc`, confirmed via instrumented tracing showing
 * zero JS-level overlap). Only a real OS process boundary is proven safe.
 *
 * This mirrors `sharedOnnxWorker.ts`'s client shape (lazy singleton,
 * request/response correlation by `id`, `unref()`'d so it never keeps a real
 * process alive) but forks a child **process** instead of constructing a
 * `worker_threads.Worker`.
 */

import { fork, execSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import { performance } from 'node:perf_hooks';
import { log } from '@adhd/sox-telemetry';
import { resolveFastembedLockPath } from './fastembedLock.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Resolve `fastembedProcessHost.js` regardless of whether this module is
 * running compiled (`dist/sharedFastembedProcess.js`, sitting next to the
 * compiled `dist/fastembedProcessHost.js`) or transformed-in-place from
 * source (vitest runs `.ts` files directly via its SSR transform, so
 * `__dirname` resolves to `src/`, which never contains a compiled `.js`) —
 * mirrors the same `dist`-fallback pattern already proven in
 * `sharedOnnxWorker.ts`.
 */
function resolveFastembedHostPath(): string {
  const sibling = join(__dirname, 'fastembedProcessHost.js');
  if (existsSync(sibling)) return sibling;

  const distSibling = join(__dirname, '..', 'dist', 'fastembedProcessHost.js');
  if (existsSync(distSibling)) return distSibling;

  // Last resort: return the original candidate so the resulting error names
  // the path that was actually attempted.
  return sibling;
}

/** True if a process with this pid is alive (best-effort; ESRCH => dead). Not
 *  imported from `fastembedProcessHost.ts` — see `detectCompetingFastembedHost`. */
function isPidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * BL-432 (signal 3, best-effort): read the BL-331 advisory lock file that
 * `fastembedProcessHost.ts`'s `checkAndClaimFastembedLock()` writes on every
 * host startup, and report whether it names a DIFFERENT, still-live pid from
 * `ownPid` — i.e. a second fastembed host currently exists on this machine. A
 * second host changes embed latency 25-50x (cross-process CoreML/ANE
 * contention, BL-331) and nothing previously recorded whether one was
 * present for any given embed-latency number (BL-432/BL-433's "unlabelled
 * measurement" class).
 *
 * Deliberately does NOT `import` `fastembedProcessHost.ts` — that module
 * calls `checkAndClaimFastembedLock()` and registers `process.on('message')`
 * at module scope, both meant for the forked CHILD process, never the
 * parent that owns this client. The lock path convention and payload shape
 * ARE shared with that module, via the side-effect-free `./fastembedLock.js`
 * (BL-471) — only the tiny pid-liveness check below is duplicated, since it
 * has nothing to do with the lock file's format. Advisory only: a
 * missing/unreadable/stale lock file is silently treated as "no competing
 * host", never thrown — this must never be able to break or slow a real
 * embed call.
 *
 * (DEBT-EPIC-HOTPATH-REDUNDANT-IO-001) This used to be an UNCONDITIONAL
 * `existsSync` + `readFileSync` pair on EVERY call to `request()` below — i.e.
 * on every single embed, since `embedSingle`/`embedBatch` route through it.
 * Measured (Node 20, warm fs cache, 5000 iterations against a real lock
 * file): ~9.6us/call synchronously blocking the event loop each time — small
 * relative to a ~619ms warm bge-base embed, but it is a real, avoidable
 * per-call syscall pair on the single hottest path in the write pipeline, and
 * a sync fs call blocks OTHER concurrent work in the same process regardless
 * of its own cost (the mechanism argument the epic calls out). The value this
 * reads — whether a second fastembed host process is alive — cannot change on
 * a sub-second cadence (it only flips at process start/exit), so a short TTL
 * cache removes the per-call I/O without weakening the signal: a genuinely
 * competing host is still detected and logged, just at worst
 * `COMPETING_HOST_CACHE_TTL_MS` later than before.
 */
const COMPETING_HOST_CACHE_TTL_MS = 3000;
let _competingHostCache: { pid: number; startedAt: string } | null = null;
let _competingHostCacheOwnPid: number | undefined;
let _competingHostCacheOwnPoolGroup: string | undefined;
let _competingHostCacheAt = -Infinity;

/** TEST-ONLY: clear the TTL cache so a test can force a fresh fs read. */
export function __resetCompetingHostCacheForTests(): void {
  _competingHostCache = null;
  _competingHostCacheOwnPid = undefined;
  _competingHostCacheOwnPoolGroup = undefined;
  _competingHostCacheAt = -Infinity;
}

/**
 * Exported for direct unit testing (DEBT-EPIC-HOTPATH-REDUNDANT-IO-001) — see the
 * TTL-cache doc comment above for why this used to be a per-call sync fs read.
 *
 * (BUG-MEMORY-EMBED-HEAD-OF-LINE-BLOCKING-001) `ownPoolGroup`, when supplied,
 * suppresses a "competing host" result whose lock entry carries the SAME
 * `poolGroup` — i.e. another member of this client's own `FastembedProcessPool`,
 * not a genuinely unrelated fastembed host. Without this, the BL-432
 * `competing_host_pid` telemetry field would read as permanently "contended"
 * for every pooled request, which is exactly the false-positive noise BL-331's
 * own postmortem warns against trusting.
 */
export function detectCompetingFastembedHost(
  ownPid: number | undefined,
  ownPoolGroup?: string,
): { pid: number; startedAt: string } | null {
  const now = performance.now();
  if (
    now - _competingHostCacheAt < COMPETING_HOST_CACHE_TTL_MS &&
    _competingHostCacheOwnPid === ownPid &&
    _competingHostCacheOwnPoolGroup === ownPoolGroup
  ) {
    return _competingHostCache;
  }
  _competingHostCacheAt = now;
  _competingHostCacheOwnPid = ownPid;
  _competingHostCacheOwnPoolGroup = ownPoolGroup;
  try {
    const lockPath = resolveFastembedLockPath();
    if (!existsSync(lockPath)) {
      _competingHostCache = null;
      return null;
    }
    const raw = JSON.parse(readFileSync(lockPath, 'utf8')) as {
      pid?: unknown;
      startedAt?: unknown;
      poolGroup?: unknown;
    };
    const pid = typeof raw.pid === 'number' ? raw.pid : null;
    const isKnownPoolSibling =
      typeof raw.poolGroup === 'string' && ownPoolGroup !== undefined && raw.poolGroup === ownPoolGroup;
    if (pid === null || pid === ownPid || !isPidAlive(pid) || isKnownPoolSibling) {
      _competingHostCache = null;
      return null;
    }
    _competingHostCache = { pid, startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : 'unknown' };
    return _competingHostCache;
  } catch {
    _competingHostCache = null;
    return null;
  }
}

interface PendingEntry {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

type HostMessage = { id: number } & Record<string, unknown>;

/**
 * (BUG-MEMORY-EMBED-HEAD-OF-LINE-BLOCKING-001) The structural shape both
 * `SharedFastembedProcessClient` (one child) and `FastembedProcessPool`
 * (N independent children) satisfy. `FastembedProvider` (fastembed.ts)
 * depends on this interface, not the concrete single-child class, so
 * `getSharedFastembedProcess()` can return either without callers caring —
 * every existing `.request()`/`.terminate()`/`.started` call site keeps
 * working unchanged.
 */
export interface SharedFastembedClient {
  request<T = Record<string, unknown>>(
    payload: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T>;
  terminate(): Promise<void>;
  readonly started: boolean;
}

/**
 * (BUG-MEMORY-EMBED-HEAD-OF-LINE-BLOCKING-001) Thrown by `FastembedProcessPool
 * .request()` when every pool member already has `admissionLimit` or more
 * requests in flight — the "a queue that never refuses hides its own
 * failure" backstop the bug item asked for. This is NOT the primary fix (the
 * pool itself is — see the class below); it exists purely so a burst that
 * genuinely exceeds total pool capacity gets a fast, typed, retryable
 * rejection instead of silently joining a multi-minute queue. Named
 * `TransientEmbeddingError`-shaped (has `retryAfterMs`) but defined locally
 * rather than importing from `./index.js`, to keep this module free of a
 * dependency on the public interface skeleton — callers can duck-type on
 * `.name === 'FastembedBusyError'` or `instanceof FastembedBusyError`.
 */
export class FastembedBusyError extends Error {
  readonly retryAfterMs: number;
  constructor(message: string, retryAfterMs: number) {
    super(message);
    this.name = 'FastembedBusyError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class SharedFastembedProcessClient implements SharedFastembedClient {
  private child: ChildProcess | null = null;
  private startingPromise: Promise<ChildProcess> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();
  private readonly hostPath: string | undefined;
  private readonly poolGroup: string | undefined;
  private poolSize: number | undefined;
  private memberIndex: number | undefined;
  /**
   * (BUG-021) The last `{ type: 'init', model, cacheDir }` payload this
   * member has ever been asked to load — kept independently of any pool
   * wrapper above it so a LONE (non-pooled) client is self-healing too.
   * `null` until the first successful `init`.
   */
  private lastInitPayload: Record<string, unknown> | null = null;
  /**
   * (BUG-021 root cause) True once the CURRENT `this.child` has actually
   * loaded the model named by `lastInitPayload`. Reset to `false` every time
   * `ensureProcess()` forks a NEW child — including a transparent respawn
   * after the previous child died (crash, OOM-kill, the BL-426/std::bad_alloc
   * native-teardown hazards documented on `fastembedProcessHost.ts`, etc).
   *
   * Before this fix, `ensureProcess()`'s `c.on('exit')`/`c.on('error')`
   * handlers nulled out `this.child`/`this.startingPromise` on an unexpected
   * death, but nothing told the NEXT `request()` call that the freshly
   * (re)forked replacement child has an empty `_embedder` — every real
   * `embed`/`embedBatch` request sent to it failed with "Model not
   * initialized" forever, because the higher-level `FastembedProvider.ready`
   * flag was already latched `true` from the original (pre-crash) init and
   * `ensureReady()` never re-sends `init` once `ready` is true. Live incident
   * BUG-021: the lock file showed a child forked mere SECONDS before every
   * request against it failed — exactly this respawn-without-reinit gap, not
   * a stale/orphaned lock as first suspected.
   */
  private childInitialized = false;

  /**
   * @param hostPathOverride Test-only injection point (BL-410): points the
   * fork target at a lightweight fixture host instead of the real
   * `fastembedProcessHost.js`, so a test can exercise the fork/ref/unref
   * contract without loading fastembed or downloading a model. Production
   * code (`getSharedFastembedProcess()`) never passes this — it always
   * resolves the real host path.
   * @param poolGroup (BUG-MEMORY-EMBED-HEAD-OF-LINE-BLOCKING-001) Set by
   * `FastembedProcessPool` to a group id shared by every member of that pool.
   * Forwarded to the forked child via `SOX_FASTEMBED_POOL_GROUP` so the
   * BL-331 advisory lock can tell "another member of my own pool" apart from
   * "a genuinely unrelated fastembed host" — see `fastembedLock.ts`'s
   * `poolGroup` doc comment. `undefined` for a lone (non-pooled) client,
   * which preserves today's exact single-host lock behaviour there.
   * @param poolSize / @param memberIndex (BUG-EMBED-POOL-SIZE-DARWIN-FREEMEM-001,
   * observability addendum) Set by `FastembedProcessPool` so every
   * `fastembed_process.request.*` telemetry record this client emits carries
   * the pool's actual size and this member's index alongside `queue_depth`/
   * `response_ms`. Diagnosing THIS incident required an agent to read source
   * and reconstruct `resolveFastembedPoolSize()`'s arithmetic by hand,
   * because no telemetry field ever recorded what size the pool actually
   * resolved to at runtime — `queue_depth` alone cannot distinguish
   * "contention on an inert 1-member pool" from "genuine over-capacity on a
   * 4-member pool". `undefined` for a lone (non-pooled) client, which omits
   * both fields from telemetry exactly as before this addendum.
   */
  constructor(hostPathOverride?: string, poolGroup?: string, poolSize?: number, memberIndex?: number) {
    this.hostPath = hostPathOverride;
    this.poolGroup = poolGroup;
    this.poolSize = poolSize;
    this.memberIndex = memberIndex;
  }

  /** True once the underlying child process has been forked. */
  get started(): boolean {
    return this.child !== null;
  }

  /**
   * (BUG-MEMORY-EMBED-HEAD-OF-LINE-BLOCKING-001) Number of requests already
   * admitted-and-unsettled on this specific child, i.e. how many are ahead
   * of a hypothetical next request. Exposed read-only so `FastembedProcessPool`
   * (below) can route a new request to whichever pool member is least loaded
   * — the exact `this.pending.size` value `request()` already measures
   * internally for the `queue_depth` telemetry field, just made visible to a
   * caller one level up instead of re-derived.
   */
  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * (BL-575) Update the `pool_size`/`member_index` telemetry fields this
   * client stamps on every `fastembed_process.request.*` record. Package-
   * private (no `readonly`) specifically so `AdaptiveFastembedProcessPool`
   * can keep them truthful as the pool grows/shrinks at runtime — a FIXED
   * `FastembedProcessPool` never calls this (its size is constant for the
   * member's whole lifetime, set once at construction).
   */
  setPoolMeta(poolSize: number, memberIndex: number): void {
    this.poolSize = poolSize;
    this.memberIndex = memberIndex;
  }

  /** Lazily fork (exactly once) and return the single shared child process. */
  private ensureProcess(): Promise<ChildProcess> {
    if (this.child) return Promise.resolve(this.child);
    if (this.startingPromise) return this.startingPromise;

    this.startingPromise = new Promise<ChildProcess>((resolveStart) => {
      const hostPath = this.hostPath ?? resolveFastembedHostPath();
      const c = fork(hostPath, [], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        // Real inference is CPU-bound in native code; no need to keep the
        // parent process alive on this child's account.
        detached: false,
        ...(this.poolGroup !== undefined
          ? { env: { ...process.env, SOX_FASTEMBED_POOL_GROUP: this.poolGroup } }
          : {}),
      });
      c.unref();

      c.on('message', (msg: HostMessage) => {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        this.unrefIfIdle();
        if ('error' in msg && typeof msg['error'] === 'string') {
          pending.reject(new Error(msg['error'] as string));
        } else {
          pending.resolve(msg);
        }
      });

      c.on('error', (err: Error) => {
        for (const { reject } of this.pending.values()) reject(err);
        this.pending.clear();
        this.child = null;
        this.startingPromise = null;
        // (BUG-021) A dead child never reappears un-loaded — the NEXT
        // ensureProcess() forks a genuinely new one, which starts this flag
        // at false again anyway, but clearing it here too closes any window
        // where a caller reads `childInitialized` between the crash and the
        // next fork.
        this.childInitialized = false;
      });

      c.on('exit', (code: number | null) => {
        if (code !== 0 && code !== null) {
          const err = new Error(`shared fastembed process exited with code ${code}`);
          for (const { reject } of this.pending.values()) reject(err);
          this.pending.clear();
        }
        this.child = null;
        this.startingPromise = null;
        this.childInitialized = false;
      });

      // Same re-unref pattern as `sharedOnnxWorker.ts` — attaching listeners
      // can re-ref the underlying handle; re-assert `unref()` once every
      // listener is attached so a real process can exit when its own work is
      // done instead of hanging on this child forever.
      c.unref();

      // BL-370: `ChildProcess.unref()` is NOT sufficient here, and for two
      // years the comment above described an outcome this code did not achieve.
      // `fork()` with `'ipc'` in `stdio` creates a SEPARATE libuv handle for the
      // IPC channel, and unref-ing the ChildProcess does not unref that channel.
      // The result: every process that embedded even once stayed alive forever.
      // Observed in the wild — two probe processes still running 40+ minutes
      // after writing their final output, each holding a resident ONNX model.
      //
      // That leak was not merely wasteful, it CORRUPTED DIAGNOSIS: the
      // "[fastembed] WARNING … another fastembed host process (pid N) is ALREADY
      // RUNNING … severe (25-50x) embed latency due to Neural Engine contention"
      // message was repeatedly cited as evidence of real ANE contention, and at
      // least one such warning named a leaked orphan this very defect created,
      // idle at 0% CPU. Cross-process ANE contention remains unproven; the
      // measured cause of the live slowdown was scheduling QoS (BL-331).
      c.channel?.unref();

      this.child = c;
      resolveStart(c);
    });

    return this.startingPromise;
  }

  /**
   * (BL-410) Ref the child process and its IPC channel while at least one
   * request is in flight. `ensureProcess()` unrefs both immediately after
   * forking so a long-lived *service* (memory-server) can exit cleanly
   * without the embed child pinning it open forever (BL-370). But a
   * **standalone script** whose only pending work is an in-flight
   * `request()` has nothing else ref'd — Node can decide the event loop is
   * empty and tear the process down mid-model-load, abandoning the pending
   * promise before the child's reply ever arrives. Re-ref-ing for the
   * duration of each in-flight request keeps such a script alive exactly
   * long enough to receive its answer, and `unrefIfIdle()` (called from
   * every settle path) immediately releases that ref again once nothing is
   * outstanding — so a script with no other work still exits promptly, it
   * just doesn't exit *before its own request completes*.
   */
  private refForPending(): void {
    this.child?.ref();
    this.child?.channel?.ref();
  }

  /** Counterpart to `refForPending()` — release the ref once `pending` drains. */
  private unrefIfIdle(): void {
    if (this.pending.size === 0) {
      this.child?.unref();
      this.child?.channel?.unref();
    }
  }

  /**
   * Send a request to the shared fastembed process and await its correlated
   * response. Assigns a globally-unique `id` — the caller must NOT set its
   * own `id` (any `id` field on `payload` is ignored/overwritten).
   *
   * BL-432: this is where BL-331's head-of-line-blocking question actually
   * lives — NOT in memory-core's `embed.ts` `wait`/`work` split, which was
   * measured (n=570) to be structurally incapable of observing it, because
   * `wait` only covers acquiring the already-memoised provider promise.
   * Every request beyond the first in a process contends here, on this one
   * shared child. Three signals are emitted with every
   * `fastembed_process.request.*` record via the `@adhd/sox-telemetry`
   * substrate (no second telemetry mechanism):
   *   1. `queue_depth` — `this.pending.size` measured BEFORE this request is
   *      added, i.e. how many requests are already admitted and awaiting a
   *      reply ahead of this one. The direct head-of-line-blocking signal.
   *   2. `response_ms` — elapsed time from immediately after `child.send()`
   *      to this request's own settle, so "sat behind N others" (visible via
   *      `queue_depth` > 0 alongside a `response_ms` that scales with it) is
   *      distinguishable from "the child itself was slow on a solo request"
   *      (`queue_depth` === 0 with a large `response_ms`).
   *   3. `competing_host_pid` — present only when a second, still-live
   *      `fastembedProcessHost` process is detected (BL-331's advisory lock),
   *      since that changes embed latency 25-50x independent of queueing.
   *
   * BL-576: `signal`, when supplied, is an external cancellation source —
   * e.g. `operation-guard.ts`'s `withOperationDeadline` abort controller, so
   * a deadline that fires while an embed is queued behind an unrelated slow
   * request stops WAITING on it immediately rather than riding the deadline
   * out via its own separate mechanism. This does NOT kill the underlying
   * fastembed child mid-inference (the same "no native cancellation
   * primitive" constraint `operation-guard.ts` documents applies here too —
   * the child process is shared across other pending requests, so killing
   * it on one caller's abort would collaterally fail every other in-flight
   * request on that member) — it settles the CALLER's promise immediately
   * with an `AbortError` and removes the pending entry so a late reply from
   * the child (once the real work finishes) is silently dropped instead of
   * resolving/rejecting a promise nobody is awaiting anymore. If `signal`
   * is already aborted when `request()` is called, it rejects immediately
   * without ever sending to the child.
   */
  async request<T = Record<string, unknown>>(
    payload: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (signal?.aborted) {
      throw signal.reason instanceof Error
        ? signal.reason
        : new Error('shared fastembed process request aborted before it was sent');
    }
    const isInitRequest = payload['type'] === 'init';
    if (isInitRequest) {
      this.lastInitPayload = payload;
    }
    let child = await this.ensureProcess();

    if (!isInitRequest && this.lastInitPayload && !this.childInitialized) {
      // (BUG-021 fix) `child` was just (re)spawned — by this call's own
      // `ensureProcess()` above, OR by an earlier request on this member
      // after the previous child died unexpectedly — and has never loaded a
      // model. Replay the last known-good `init` payload before letting the
      // real request through, exactly mirroring what `FastembedProcessPool`/
      // `AdaptiveFastembedProcessPool` already do for a brand-new member on
      // grow, but here for the respawn-in-place case those pools never
      // detect (they only (re)send `init` when THEY create a member; they
      // have no visibility into this client transparently re-forking its own
      // dead child). Recurses through this exact method so the replay gets
      // identical telemetry/timeout/admission treatment to any other init.
      await this.request(this.lastInitPayload, timeoutMs, signal);
      // Re-fetch: `ensureProcess()` is idempotent for a live child, but never
      // trust a reference captured before an `await` against a process that
      // can die out from under it.
      child = await this.ensureProcess();
    }

    const id = this.nextId++;

    const queueDepth = this.pending.size;
    const competing = detectCompetingFastembedHost(child.pid, this.poolGroup);
    const baseFields: Record<string, unknown> = {
      queue_depth: queueDepth,
      ...(competing ? { competing_host_pid: competing.pid } : {}),
      // (BUG-EMBED-POOL-SIZE-DARWIN-FREEMEM-001) See the constructor's
      // `poolSize`/`memberIndex` doc comment: makes "was this process even
      // pooled, and at what size" a directly observable telemetry field
      // instead of something an agent has to re-derive from source.
      ...(this.poolSize !== undefined ? { pool_size: this.poolSize, member_index: this.memberIndex } : {}),
    };

    return new Promise<T>((resolve, reject) => {
      let to: NodeJS.Timeout | undefined;
      // Reassigned synchronously (below, before `child.send()` returns) so
      // every settle path — including the ones triggered from a totally
      // different call site (`c.on('error')`/`c.on('exit')` above, iterating
      // `this.pending.values()`) — closes over the correct value.
      let sentAt = performance.now();

      if (timeoutMs && timeoutMs > 0) {
        to = setTimeout(() => {
          this.pending.delete(id);
          this.unrefIfIdle();
          log.warn('fastembed_process.request.error', {
            ...baseFields,
            response_ms: Math.round(performance.now() - sentAt),
            error: `timed out after ${timeoutMs}ms`,
          });
          reject(new Error(`shared fastembed process request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        if (typeof to.unref === 'function') to.unref();
      }

      let onAbort: (() => void) | undefined;
      const detachAbort = (): void => {
        if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      };

      this.pending.set(id, {
        resolve: (v) => {
          if (to) clearTimeout(to);
          detachAbort();
          // (BUG-021) Only a genuinely SUCCESSFUL init reply proves this
          // child now has a loaded model — flip the flag here, not
          // optimistically at send time, so a rejected init (model load
          // error) correctly leaves `childInitialized` false and the next
          // real request replays init again rather than sailing through
          // believing a failed load succeeded.
          if (isInitRequest) this.childInitialized = true;
          log.info('fastembed_process.request.finish', {
            ...baseFields,
            response_ms: Math.round(performance.now() - sentAt),
          });
          resolve(v as T);
        },
        reject: (e) => {
          if (to) clearTimeout(to);
          detachAbort();
          log.warn('fastembed_process.request.error', {
            ...baseFields,
            response_ms: Math.round(performance.now() - sentAt),
            error: e.message,
          });
          reject(e);
        },
      });

      // BL-576: an external abort (e.g. operation-guard.ts's deadline)
      // settles the CALLER's promise immediately — via the SAME pending-map
      // removal + `unrefIfIdle()` path the internal `timeoutMs` timer above
      // already uses — without waiting for `timeoutMs` (which may be unset,
      // or longer than the caller's own deadline) and without touching the
      // child process itself: the real work, if the child is still grinding
      // on it, keeps running and its late reply (if any) is silently
      // dropped by the `c.on('message')` handler above (`pending.get(msg.id)`
      // returns undefined once this entry is deleted).
      if (signal) {
        onAbort = () => {
          if (!this.pending.has(id)) return;
          this.pending.delete(id);
          this.unrefIfIdle();
          if (to) clearTimeout(to);
          log.warn('fastembed_process.request.aborted', {
            ...baseFields,
            response_ms: Math.round(performance.now() - sentAt),
            reason: signal.reason instanceof Error ? signal.reason.message : String(signal.reason),
          });
          reject(signal.reason instanceof Error ? signal.reason : new Error('shared fastembed process request aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }

      // BL-410: keep the parent's event loop ref'd until this request settles.
      this.refForPending();

      log.info('fastembed_process.request.admitted', baseFields);
      sentAt = performance.now();
      child.send({ ...payload, id });
    });
  }

  /**
   * Terminate the shared fastembed process. Intended ONLY for full process
   * shutdown or test teardown that genuinely owns the whole process's
   * fastembed lifecycle.
   *
   * (BL-405) Prefers the host protocol's own `{ __shutdown: true }` message
   * (`fastembedProcessHost.ts`'s `process.on('message', ...)` already
   * handles it via a clean `process.exit(0)`) over a raw `kill()` — a signal
   * landing while the child is mid-`process.send()` for an unrelated reply
   * is what produced the uncaught EPIPE crash this bug is named for. Bounded
   * to `TERMINATE_GRACE_MS`: if the child doesn't exit on its own (wedged,
   * or the IPC channel was already gone so the message silently no-op'd),
   * `kill()` is still the fallback — this must never hang the CALLER's own
   * shutdown sequence waiting on a child that will never exit gracefully.
   */
  async terminate(): Promise<void> {
    const c = this.child;
    this.child = null;
    this.startingPromise = null;
    for (const { reject } of this.pending.values()) {
      reject(new Error('shared fastembed process terminated'));
    }
    this.pending.clear();
    if (!c) return;

    const exited = new Promise<void>((resolve) => {
      c.once('exit', () => resolve());
    });
    try {
      if (c.connected) c.send({ __shutdown: true });
    } catch (err) {
      // IPC already gone — kill() below is the only path left. Deliberately silent:
      // process.send() throws EPIPE if the IPC channel is gone; this is the
      // expected path when the child exits without a graceful __shutdown message.
      log.debug('embedding_provider.fastembed.terminate.send_failed', {
        reason: err instanceof Error ? err.message : 'IPC channel unavailable',
      });
    }
    const timedOut = await Promise.race([
      exited.then(() => false),
      new Promise<boolean>((resolve) => {
        const t = setTimeout(() => resolve(true), TERMINATE_GRACE_MS);
        if (typeof t.unref === 'function') t.unref();
      }),
    ]);
    if (timedOut) c.kill();
  }
}

/** (BL-405) How long `terminate()` waits for the graceful `__shutdown` message before falling back to `kill()`. */
const TERMINATE_GRACE_MS = 1000;

// ── FastembedProcessPool (BUG-MEMORY-EMBED-HEAD-OF-LINE-BLOCKING-001) ───────
//
// PRODUCTION MEASUREMENT (n=3769, 11 days, from the bug report this fixes):
//
//   response_ms   p50=1011ms   p90=5674ms   p99=40518ms   max=109089ms
//   qdepth 0      n=1335   p50=534ms     p90=1501ms
//   qdepth 1-2    n=1905   p50=1164ms    p90=4367ms
//   qdepth 3-5    n=354    p50=2821ms    p90=15441ms
//   qdepth 6-10   n=105    p50=5519ms    p90=18862ms
//   qdepth 11+    n=70     p50=26723ms   p90=76712ms
//
// Root cause: ALL embed requests in a process share ONE `SharedFastembedProcessClient`
// (`getSharedFastembedProcess()`), which forks exactly ONE child process, whose
// `fastembedProcessHost.ts` processes requests through a single serialized
// `_queue` promise chain (`enqueue()`). Every request beyond the first-in-flight
// waits for every earlier one to fully finish — classic head-of-line blocking,
// and it is why the slope above is so clean: `response_ms` scales almost
// linearly with `queue_depth`.
//
// The single-child-PROCESS design is NOT what's wrong — it is the proven fix
// for BL-238 (fastembed's onnxruntime-node@1.21.0 cannot share a THREAD, or
// even sequential same-thread loading, with transformers.js's onnxruntime-node
// @1.24.3; see the file-header comment in `fastembedProcessHost.ts`). What's
// wrong is that there is only ONE such child. A POOL of N independent child
// PROCESSES preserves the exact isolation property BL-238 requires (each pool
// member is its own OS process — the hazard classes BL-238 documents are both
// structurally about SHARING a thread/address space, never about how many
// separate processes exist) while removing the forced serialization across
// members: N members can each process one request at a time, so N requests
// run concurrently instead of 1.
//
// Routing: least-loaded-member (by `pendingCount`), not round-robin — under
// bursty arrival (the production shape: several agents writing at once) a
// least-loaded pick keeps the queue-depth distribution across members far
// tighter than round-robin, which can stack several slow requests on the same
// member by bad luck.
//
// Admission control: once EVERY member already has `admissionLimit` or more
// requests in flight, `request()` for a non-init payload throws
// `FastembedBusyError` instead of enqueuing — "a queue that never refuses is
// a queue that hides its own failure" (bug item, direction #2). The default
// (`Number.POSITIVE_INFINITY`, i.e. disabled) preserves today's "always admit"
// behaviour; ops can opt in via `SOX_EMBED_POOL_ADMISSION_LIMIT` once the pool
// alone is proven sufficient in production (see the benchmark harness results
// cited in this bug's resolution notes — a 4-member pool absorbs the
// qdepth-11+ regime the production telemetry measured with room to spare, so
// admission control is shipped as an available backstop, not defaulted on).
//
// Batch coalescing (bug item direction #3) was evaluated and rejected for
// this pass: `embedBatch` already exists and batches WITHIN one caller's
// texts; merging batches ACROSS independent concurrent callers would require
// buffering/deadline logic (wait up to Xms for more arrivals before sending)
// that trades a bounded latency floor for a throughput gain the pool already
// captures via parallelism. The pool is strictly simpler, has no added
// latency floor, and the measured numbers below show it closes the gap
// without it.
//
// ── Memory cost — MEASURED, not assumed (post-review addendum) ─────────────
//
// A pool member is a full onnxruntime-node `InferenceSession`, and the
// question of whether N of them cost N times the model's on-disk size was
// open until measured directly: forked 1 and 4 REAL `fastembedProcessHost.js`
// children loading the production default model (bge-base-en-v1.5, 219MB on
// disk) and read each child's `footprint` (Apple's private+compressed
// physical-footprint accounting, which — unlike raw RSS — correctly
// distinguishes real per-process cost from pages shared/mmap'd across
// processes):
//
//   1 child:  phys_footprint ≈ 261 MB, of which 207 MB is a single
//             `MALLOC_LARGE` DIRTY (not Clean/Reclaimable) allocation.
//   4 children: EACH independently shows phys_footprint ≈ 262-271 MB with
//             its OWN ~207-208 MB MALLOC_LARGE dirty block — no shared/clean
//             mmap'd region for the model weights at all.
//
// Conclusion: onnxruntime-node HEAP-ALLOCATES the model per process; it does
// NOT mmap it read-only for the OS to share across children. The cost is
// real and scales linearly with pool size — a 4-member pool for this model
// costs ~4×265MB ≈ 1.06GB of additional resident memory, not a few hundred
// extra KB for session arenas. Other configured models range further: per
// `fastembedModels.ts`'s own descriptions, codexembed-400m is documented at
// "~1.6GB RAM" per instance — a 4-member pool of that model would be ~6.4GB.
//
// This matters because embedding-provider has no way to know at
// `getSharedFastembedProcess()` call time (before any `init`) which model
// will be loaded, so pool sizing CANNOT be exact per-model — and the box
// this was measured on had 128MB of free physical memory at measurement
// time (`top -l 1`, `PhysMem: 31G used … 128M unused`), out of 32GB total,
// with 11GB already in the compressor. An unconditional hardware-sized
// default (the original `floor(cpus/2)`, cap 4) would have shipped a
// default that, on THIS box alone, tries to allocate ~800MB more than is
// physically free — risking heavy swap or an OOM kill mid-embed-write, which
// is exactly the unclean-shutdown shape this subsystem's corruption class
// feeds on. A latency fix that increases corruption exposure is not a win.
//
// So sizing is now BOTH memory-aware (auto-computed from `os.freemem()`
// against a conservative measured per-member budget, `DEFAULT_PER_MEMBER_MB`
// below — calibrated to the measured bge-base-en-v1.5 figure with margin, the
// package's own default model) AND still capped by CPU count, defaulting to
// the SAFE end when the two disagree. On a memory-constrained box this
// resolves to pool size 1 — the exact pre-fix single-child topology — rather
// than silently trying to grab memory that isn't there. `SOX_EMBED_POOL_SIZE`
// remains an unconditional override for an operator who has measured their
// own model's real footprint and confirmed headroom; it is honored exactly,
// with no memory clamp applied (the operator's explicit judgement wins).

/** Conservative measured per-member memory budget (MB) used only for the
 *  memory-aware AUTO-sizing path (i.e. when `SOX_EMBED_POOL_SIZE` is not
 *  set) — calibrated to the measured bge-base-en-v1.5 `phys_footprint`
 *  (~262-271MB observed) with margin. Models configured with a materially
 *  different footprint (bge-m3, codexembed-400m — "~1.6GB RAM" per
 *  `fastembedModels.ts`) are NOT auto-detected here (pool size is resolved
 *  before any model is known); an operator running one of those should set
 *  `SOX_EMBED_POOL_PER_CHILD_MB` (or just pin `SOX_EMBED_POOL_SIZE`
 *  directly) rather than trust this default. */
const DEFAULT_PER_MEMBER_MB = 300;

/** Auto-sizing never lets the pool consume the machine's last headroom —
 *  this many MB of free memory are always left unclaimed by the pool-sizing
 *  calculation (the rest of the process, and everything else on the
 *  machine, still needs to run). */
const MEMORY_SAFETY_MARGIN_MB = 1024;

/**
 * (BUG-EMBED-POOL-SIZE-DARWIN-FREEMEM-001) Estimate REAL available memory
 * (MB), platform-aware — the input `resolveFastembedPoolSize()`'s
 * memory-cap arithmetic below actually needs, as opposed to what
 * `os.freemem()` alone reports.
 *
 * `os.freemem()` is not a usable proxy for "memory this process could
 * actually claim" on macOS: it maps to Mach's raw "free" page count only,
 * which deliberately EXCLUDES "inactive"/"speculative"/"purgeable" pages —
 * pages the kernel is using as disk cache but will hand back instantly
 * (zero swap-in cost) under real pressure. Measured via `vm_stat` on the
 * exact box this defect was diagnosed on (32GB physical, page size 16384):
 * `os.freemem()` reported ~299MB while `Pages inactive` ALONE was 345,579
 * pages (~5.4GB) — the overwhelming majority of genuinely-available memory
 * was invisible to the metric `resolveFastembedPoolSize()` used to
 * compute `memoryCap`. Because `MEMORY_SAFETY_MARGIN_MB` (1024) routinely
 * exceeds `os.freemem()`'s ~300MB-ish reading on macOS regardless of real
 * load, `memoryCap` collapsed to `Math.max(1, negative) === 1` on every
 * macOS box, unconditionally — the pool was permanently INERT (silently
 * behaving exactly like the pre-fix single-child topology) unless an
 * operator manually overrode `SOX_EMBED_POOL_SIZE`. `hol-pool-sizing.spec.ts`
 * even self-documents "this suite was itself first run on a box with only
 * ~128MB free" — the sizing design was validated against the very macOS
 * quirk that made it universally wrong, not a genuinely memory-constrained
 * machine.
 *
 * Fix: compute "available" as free + inactive + speculative + purgeable
 * pages (the standard macOS "reclaimable without swapping" heuristic —
 * matches what `htop`-family tools approximate; NOT Apple's undocumented
 * memory-pressure internals, which have no public API). On Linux,
 * `/proc/meminfo`'s `MemAvailable` is already the kernel's own equivalent
 * estimate and is used directly. Any other platform, or any parse/exec
 * failure, falls back to `os.freemem()` unchanged — this must never throw
 * or block pool sizing on a shell-out failing; it runs once per process
 * (at `getSharedFastembedProcess()` construction), never per-request.
 */
export function estimateAvailableMemMb(): number {
  try {
    if (process.platform === 'darwin') {
      const out = execSync('vm_stat', { encoding: 'utf8', timeout: 2000 });
      const pageSizeMatch = /page size of (\d+) bytes/.exec(out);
      const pageSize = pageSizeMatch ? Number(pageSizeMatch[1]) : 4096;
      const pages = (label: string): number => {
        const m = new RegExp(`${label}:\\s+(\\d+)\\.`).exec(out);
        return m ? Number(m[1]) : 0;
      };
      const availablePages =
        pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable');
      const availableMb = (availablePages * pageSize) / (1024 * 1024);
      if (Number.isFinite(availableMb) && availableMb > 0) return availableMb;
    } else if (process.platform === 'linux') {
      const meminfo = readFileSync('/proc/meminfo', 'utf8');
      const m = /MemAvailable:\s+(\d+)\s+kB/.exec(meminfo);
      if (m) {
        const availableMb = Number(m[1]) / 1024;
        if (Number.isFinite(availableMb) && availableMb > 0) return availableMb;
      }
    }
  } catch (err) {
    log.debug('embedding_provider.fastembed.pool_sizing.mem_estimate_failed', {
      error: err instanceof Error ? err.message : String(err),
      platform: process.platform,
    });
  }
  return os.freemem() / (1024 * 1024);
}

/**
 * (BL-575) The explicit `SOX_EMBED_POOL_SIZE` override, if set — a HARD PIN.
 * Split out of `resolveFastembedPoolSize()` so `getSharedFastembedProcess()`
 * can tell "operator pinned an exact size" (disables ALL adaptation —
 * `AdaptiveFastembedProcessPool` is never constructed) apart from "no
 * override, compute a ceiling for adaptive sizing to grow toward" — the two
 * cases used to be indistinguishable from the return value of a single
 * function that already folded the CPU/memory-cap arithmetic into the
 * "no override" branch.
 */
export function resolveFastembedPoolPin(): number | null {
  const raw = Number(process.env['SOX_EMBED_POOL_SIZE']);
  if (Number.isFinite(raw) && raw >= 1) return Math.floor(raw);
  return null;
}

/**
 * (BL-575) The maximum pool size the memory/CPU budget allows — i.e. what
 * `resolveFastembedPoolSize()` used to compute unconditionally in its
 * "no override" branch. Now used two ways: (a) unchanged, as
 * `resolveFastembedPoolSize()`'s own fallback when no pin is set, so every
 * existing caller of that function keeps its exact prior behavior; (b) as
 * `AdaptiveFastembedProcessPool`'s `maxSize` — the ceiling it is allowed to
 * grow toward under sustained load, never exceeded regardless of how
 * sustained the demand is.
 *
 * Auto-sized from BOTH real available memory (`estimateAvailableMemMb()` —
 * see its doc comment for why this is NOT simply `os.freemem()`, and
 * BUG-EMBED-POOL-SIZE-DARWIN-FREEMEM-001 for the incident this fixes —
 * against `DEFAULT_PER_MEMBER_MB`, less `MEMORY_SAFETY_MARGIN_MB` headroom —
 * override the per-member budget via `SOX_EMBED_POOL_PER_CHILD_MB` for a
 * non-default model) AND CPU count (half the logical CPUs, cap 4 — fastembed
 * inference is CPU/ANE-bound per request, not embarrassingly parallel across
 * all cores), taking the SMALLER of the two so a memory-constrained box
 * never gets sized past what's actually free. See the module doc comment
 * above for the measurement (footprint/vmmap on 1 vs 4 real children) that
 * justifies this.
 *
 * @param getAvailableMemMb Test-only injection point — production always
 * uses the default `estimateAvailableMemMb`. Lets tests exercise the sizing
 * arithmetic against deterministic MB values instead of the real, inherently
 * machine/moment-dependent OS memory state.
 */
export function resolveFastembedPoolCeiling(getAvailableMemMb: () => number = estimateAvailableMemMb): number {
  const perMemberMb = Number(process.env['SOX_EMBED_POOL_PER_CHILD_MB']);
  const memberBudgetMb = Number.isFinite(perMemberMb) && perMemberMb > 0 ? perMemberMb : DEFAULT_PER_MEMBER_MB;
  const freeMb = getAvailableMemMb();
  const memoryCap = Math.max(1, Math.floor((freeMb - MEMORY_SAFETY_MARGIN_MB) / memberBudgetMb));

  const cpus = os.cpus().length || 1;
  const cpuCap = Math.max(1, Math.min(4, Math.floor(cpus / 2)));

  return Math.max(1, Math.min(cpuCap, memoryCap));
}

/**
 * Number of independent fastembed child processes a FIXED (non-adaptive)
 * pool should use. Preserved unchanged for backward compatibility (existing
 * callers/tests) — `SOX_EMBED_POOL_SIZE` honored exactly if set
 * (`resolveFastembedPoolPin()`), else the memory/CPU ceiling
 * (`resolveFastembedPoolCeiling()`). `getSharedFastembedProcess()` itself no
 * longer calls this for its default (adaptive) path as of BL-575 — see
 * `resolveFastembedPoolPin`/`resolveFastembedPoolCeiling`'s doc comments.
 *
 * @param getAvailableMemMb Test-only injection point, forwarded to
 * `resolveFastembedPoolCeiling`.
 */
export function resolveFastembedPoolSize(getAvailableMemMb: () => number = estimateAvailableMemMb): number {
  return resolveFastembedPoolPin() ?? resolveFastembedPoolCeiling(getAvailableMemMb);
}

/** Per-member in-flight cap above which `FastembedProcessPool.request()` fast-rejects
 *  a non-init request with `FastembedBusyError` instead of enqueuing. Disabled
 *  (`Infinity`) by default — see the pool doc comment above for why. Override
 *  via `SOX_EMBED_POOL_ADMISSION_LIMIT` (a finite number opts in). */
export function resolveFastembedAdmissionLimit(): number {
  const raw = Number(process.env['SOX_EMBED_POOL_ADMISSION_LIMIT']);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return Number.POSITIVE_INFINITY;
}

/**
 * A pool of `size` independent `SharedFastembedProcessClient`s — i.e. `size`
 * independent fastembed-hosting OS child processes, each fully isolated from
 * the others (preserving BL-238's process-isolation requirement) — routing
 * each request to whichever member currently has the fewest requests in
 * flight. See the module-level doc comment above for the full rationale and
 * the production measurements this fixes.
 */
export class FastembedProcessPool implements SharedFastembedClient {
  readonly members: SharedFastembedProcessClient[];
  private readonly admissionLimit: number;
  /**
   * (BUG-MEMORY-EMBED-HEAD-OF-LINE-BLOCKING-001) Routing/admission MUST NOT
   * read `member.pendingCount` for the decision — that counter is only
   * incremented deep inside `SharedFastembedProcessClient.request()`, AFTER
   * its own `await this.ensureProcess()`, i.e. at least one microtask tick
   * after the call starts. Several callers issued in the same synchronous
   * burst (`Promise.all(callers.map(() => pool.request(...)))`, the exact
   * shape a real caller under load produces) all run their OWN synchronous
   * prefix — including this pool's `leastLoaded()`/admission check — before
   * ANY of them reaches that tick, so every one of them would read
   * `pendingCount === 0` for every member and pile onto `members[0]`,
   * silently defeating both load-balancing and admission control for
   * exactly the bursty-arrival case this fix exists for. `inFlight` is
   * incremented SYNCHRONOUSLY the instant a member is chosen (before any
   * `await`), so the very next synchronous call in the same burst already
   * sees it.
   */
  private readonly inFlight: number[];
  /** Cached so a member added to routing after the first `init` (there is
   *  none today — pool size is fixed at construction — but kept so a future
   *  dynamic-resize doesn't silently skip initializing a new member) can be
   *  brought up to date. Also lets `request()` short-circuit a redundant
   *  broadcast if the model/cacheDir haven't changed. */
  private lastInitPayload: Record<string, unknown> | null = null;

  constructor(size: number, hostPathOverride?: string, admissionLimit = resolveFastembedAdmissionLimit()) {
    if (!Number.isFinite(size) || size < 1) {
      throw new Error(`FastembedProcessPool: size must be >= 1, got ${size}`);
    }
    // One group id shared by every member — see `fastembedLock.ts`'s
    // `poolGroup` doc comment: this is what lets the BL-331 advisory lock
    // recognize a sibling pool member instead of warning about it as an
    // unrelated competing host.
    const poolGroup = `pool-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    this.members = Array.from(
      { length: size },
      (_, i) => new SharedFastembedProcessClient(hostPathOverride, poolGroup, size, i),
    );
    this.inFlight = new Array(size).fill(0) as number[];
    this.admissionLimit = admissionLimit;
  }

  /** True once at least one member has forked its child process. */
  get started(): boolean {
    return this.members.some((m) => m.started);
  }

  /** The last `{ type: 'init', model, cacheDir }` payload broadcast to every
   *  member, or `null` before the first init. Exposed for introspection/tests
   *  only — `request()` itself doesn't need to read this back today (pool
   *  size is fixed at construction, so every member is always initialized by
   *  the broadcast), it's retained purely so a future dynamic-resize path has
   *  the payload on hand to bring a newly-added member up to date. */
  get lastInit(): Record<string, unknown> | null {
    return this.lastInitPayload;
  }

  /** Sum of in-flight requests across every member — the pool-wide
   *  head-of-line depth an arriving caller would experience. */
  get pendingCount(): number {
    return this.members.reduce((sum, m) => sum + m.pendingCount, 0);
  }

  /** Index of the least-loaded member by the SYNCHRONOUS `inFlight` counter
   *  — see that field's doc comment for why `member.pendingCount` itself is
   *  unsafe to read here. */
  private leastLoadedIndex(): number {
    let bestIdx = 0;
    for (let i = 1; i < this.inFlight.length; i++) {
      if (this.inFlight[i]! < this.inFlight[bestIdx]!) bestIdx = i;
    }
    return bestIdx;
  }

  async request<T = Record<string, unknown>>(
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    // `init` must reach EVERY member — an embed/embedBatch request can be
    // routed to ANY member, so every member needs the model loaded before
    // it can serve one. Broadcasting once (per distinct model/cacheDir) is
    // cheap relative to a real model load, and members race the load
    // concurrently rather than serially, so this does not multiply the
    // warmup budget by pool size.
    if (payload['type'] === 'init') {
      this.lastInitPayload = payload;
      const results = await Promise.all(
        this.members.map((m) => m.request<T>(payload, timeoutMs)),
      );
      return results[0] as T;
    }

    // Reserve the slot SYNCHRONOUSLY (see `inFlight`'s doc comment) before
    // any `await` — this is what makes routing/admission correct for a
    // burst of calls issued in the same microtask (e.g. `Promise.all` over
    // many concurrent callers), not just for calls staggered by real I/O.
    const idx = this.leastLoadedIndex();
    if (this.inFlight[idx]! >= this.admissionLimit) {
      const retryAfterMs = Math.min(2000, 100 * (this.inFlight[idx]! + 1));
      throw new FastembedBusyError(
        `fastembed pool saturated: every one of ${this.members.length} member(s) already has ` +
          `>= ${this.admissionLimit} requests in flight`,
        retryAfterMs,
      );
    }
    this.inFlight[idx]! += 1;
    const target = this.members[idx]!;
    try {
      return await target.request<T>(payload, timeoutMs);
    } finally {
      this.inFlight[idx]! -= 1;
    }
  }

  async terminate(): Promise<void> {
    await Promise.all(this.members.map((m) => m.terminate()));
  }
}

// ── AdaptiveFastembedProcessPool (BL-575) ───────────────────────────────────
//
// PROBLEM: `FastembedProcessPool` above sizes itself ONCE, at process start,
// via `resolveFastembedPoolSize()`. A fixed size is the wrong shape across
// the concurrency range production actually sees — real-inference
// measurement (cached bge-base-en-v1.5, built dist, 10-core Apple Silicon
// box, `SOX_EMBED_EXECUTION_PROVIDER` both default/CoreML and forced `cpu`
// to rule out ANE-specific hardware contention as the sole cause) re-verified
// 2026-08-17 (see this package's `bl575-adaptive-pool.spec.ts` for the
// harness and full per-run numbers):
//
//   concurrency  8 (n=24): pool=1 p99≈3.0s  wall≈8.6s | pool=4 p99≈4.6s  wall≈10.3s  -> pool WORSE
//   concurrency 16 (n=48): pool=1 p99≈6.1s  wall≈17.2s| pool=4 p99≈6.3s  wall≈16.1s  -> mixed
//   concurrency 24 (n=60): pool=1 p99≈24.7s wall≈41.4s| pool=4 p99≈15.0s wall≈28.4s  -> pool BETTER (p99 -39%)
//
// Below ~20 concurrency, onnxruntime-node's OWN intra-op thread pool already
// saturates available CPU/ANE per inference, so extra pool members add
// process-level SCHEDULING CONTENTION rather than real capacity — a fixed
// pool sized for the qdepth-11+ production regime that motivated the pool
// in the first place (BUG-MEMORY-EMBED-HEAD-OF-LINE-BLOCKING-001) makes
// EVERY LOWER-CONCURRENCY REQUEST WORSE than the pre-fix single-child
// topology, unconditionally, all the time — not just a missed opportunity.
//
// FIX: start small (`minSize`, default 1 — the topology that wins at low
// concurrency) and grow toward the SAME ceiling `resolveFastembedPoolSize()`
// used to apply unconditionally (`resolveFastembedPoolCeiling()`) only when
// SUSTAINED queue depth actually demands it, shrinking back down once
// demand subsides. `SOX_EMBED_POOL_SIZE` remains a hard pin — when set,
// `getSharedFastembedProcess()` constructs the FIXED `FastembedProcessPool`
// above instead of this class at all, so an operator's explicit sizing
// judgement is never second-guessed by adaptation.
//
// HYSTERESIS POLICY (asymmetric by design — grow reasonably responsively,
// shrink conservatively; a spawned child is expensive, see below, so
// thrashing is worse than a size that's briefly one member too large):
//
//   GROW:   `queue_depth / current_size` (average pending-per-member at the
//           moment of admission) must be >= `GROW_QUEUE_RATIO_THRESHOLD`
//           (1.5 — meaningfully oversubscribed, not just "one request
//           landed while another was in flight") for `GROW_SUSTAIN_COUNT`
//           (3) CONSECUTIVE admissions AND the over-threshold streak must
//           span >= `GROW_SUSTAIN_WINDOW_MS` (2000ms) of REAL wall-clock
//           time — a count alone is NOT sufficient (BL-575 post-ship fix,
//           see `GROW_SUSTAIN_WINDOW_MS`'s own doc comment: instantaneous
//           concurrency at admission time can satisfy 3 consecutive
//           over-threshold observations within the same millisecond, which
//           made a single momentary burst of simultaneous submissions
//           trigger a grow every time — exactly the case this policy is
//           supposed to filter out). Requiring both conditions distinguishes
//           "everyone submitted at once, N in-flight for one round-trip"
//           from genuine sustained backlog that persists across multiple
//           seconds because throughput can't keep up. Also gated by
//           `GROW_COOLDOWN_MS` (15000ms) since the last grow action, so a
//           sustained-high-load period doesn't spawn several children back
//           to back before the first one is even usable — grounded in a
//           REAL measured cost: `warmupTimeoutMs(cacheHit)` (`index.ts`)
//           bounds a cache-HIT model load at 8000ms (the realistic runtime
//           case — the model is already downloaded), so 15000ms leaves real
//           margin above the typical spin-up latency a newly grown member
//           needs before it can serve a request.
//   SHRINK: checked periodically (`SHRINK_CHECK_INTERVAL_MS`, 15000ms) —
//           requires the ENTIRE pool to have been fully idle
//           (`pendingCount === 0` pool-wide) continuously for
//           `SHRINK_IDLE_MS` (60000ms, a full minute) before terminating
//           exactly ONE idle member and resetting the idle clock — shrinking
//           one member at a time, not straight back to `minSize`, so a
//           demand spike that resumes right after a shrink only has to
//           re-grow by one step, not rebuild the whole pool. Never shrinks
//           below `minSize`.
//
// Spawning is genuinely expensive — a full `onnxruntime-node` model load,
// not a cheap `fork()` — which is why growth requires SUSTAINED demand
// (not one burst) and a cooldown, while shrink requires a much longer
// sustained ABSENCE of demand: the asymmetry is deliberate, not an oversight.
export interface AdaptiveFastembedPoolOptions {
  /** Starting (and floor) pool size. Default 1 — the topology real
   *  measurement shows wins at concurrency <20. */
  minSize?: number;
  /** Ceiling the pool may grow to — pass `resolveFastembedPoolCeiling()`'s
   *  result in production; never exceeded regardless of how sustained
   *  demand is. */
  maxSize: number;
  hostPathOverride?: string;
  admissionLimit?: number;
  /** Test-only clock injection — production uses `Date.now`. */
  now?: () => number;
  /** Hysteresis knobs — all optional, defaulting to the values documented
   *  above. Exposed so a test can use tiny thresholds/intervals instead of
   *  waiting out real minutes-scale windows, and so an operator can tune
   *  the policy without a rebuild if the defaults prove wrong for their
   *  traffic shape. Production (`getSharedFastembedProcess()`) never
   *  overrides any of these — it relies on the documented defaults. */
  growQueueRatioThreshold?: number;
  growSustainCount?: number;
  /** (BL-575 hysteresis fix, post-ship) Minimum WALL-CLOCK span the
   *  over-threshold streak must cover before a grow is allowed to fire —
   *  see `growSustainWindowMs`'s own doc comment on the field below for why
   *  `growSustainCount` alone was not sufficient. */
  growSustainWindowMs?: number;
  growCooldownMs?: number;
  shrinkIdleMs?: number;
  shrinkCheckIntervalMs?: number;
}

const GROW_QUEUE_RATIO_THRESHOLD = 1.5;
const GROW_SUSTAIN_COUNT = 3;
/**
 * (BL-575 hysteresis fix, post-ship — real-inference sweep by a peer agent,
 * 2026-08-17) `growSustainCount` alone has NO time dimension:
 * `avgPendingPerMember` is a function of INSTANTANEOUS concurrency, not
 * sustained demand. When N callers submit near-simultaneously against a
 * small pool (e.g. concurrency=8 against size=1), `pendingCount` ramps past
 * the threshold within MILLISECONDS — "3 consecutive over-threshold
 * admissions" can all land in the same millisecond, so a single momentary
 * burst (exactly the case §HYSTERESIS POLICY above says should NOT trigger
 * a grow) satisfied the count condition every time. Measured: concurrency=8,
 * n=24 (where the pool should stay at size 1 the whole run per the cited
 * benchmark) grew 1->2 on 2/2 real trials, making both wall time and p99
 * WORSE than the correct behavior (wall 7896/6690ms, p99 4749/3959ms vs the
 * real fixed-pool=1 baseline of ~3041ms). `GROW_COOLDOWN_MS` does not help —
 * it only gates the SECOND+ grow, not this premature first one.
 *
 * Fix: require the over-threshold streak to span at least
 * `GROW_SUSTAIN_WINDOW_MS` of REAL elapsed time, in addition to the
 * consecutive-count requirement — a burst of simultaneous submissions that
 * resolves within milliseconds (the common case at low-moderate concurrency,
 * where each request completes in low seconds) cannot satisfy both; genuine
 * sustained backlog (queue depth staying elevated for multiple seconds while
 * throughput fails to keep up) can. 2000ms is deliberately shorter than a
 * single solo inference's own typical latency (~2.5-3s measured) — long
 * enough to rule out "everyone submitted at once", short enough not to blunt
 * the responsiveness a genuinely overloaded pool needs.
 */
const GROW_SUSTAIN_WINDOW_MS = 2_000;
const GROW_COOLDOWN_MS = 15_000;
const SHRINK_IDLE_MS = 60_000;
const SHRINK_CHECK_INTERVAL_MS = 15_000;

export class AdaptiveFastembedProcessPool implements SharedFastembedClient {
  private members: SharedFastembedProcessClient[];
  private inFlight: number[];
  private readonly minSize: number;
  private readonly maxSize: number;
  private readonly hostPathOverride: string | undefined;
  private readonly admissionLimit: number;
  private readonly poolGroup: string;
  private readonly clock: () => number;
  private readonly shrinkTimer: ReturnType<typeof setInterval>;
  private readonly growQueueRatioThreshold: number;
  private readonly growSustainCount: number;
  private readonly growSustainWindowMs: number;
  private readonly growCooldownMs: number;
  private readonly shrinkIdleMs: number;

  private lastInitPayload: Record<string, unknown> | null = null;
  private growConsecutiveOverThreshold = 0;
  /** Wall-clock timestamp the CURRENT over-threshold streak began — `null`
   *  when not currently in a streak. See `GROW_SUSTAIN_WINDOW_MS`'s doc
   *  comment for why a count alone is insufficient. */
  private growStreakStartedAt: number | null = null;
  private lastGrowAt = -Infinity;
  private idleSinceMs: number | null;
  /** Serializes concurrent grow attempts — `request()` can observe the
   *  over-threshold condition from several concurrent callers in the same
   *  burst; only one grow should actually happen. */
  private growInFlight: Promise<void> | null = null;
  private terminated = false;

  /** Counts of grow/shrink actions taken — exposed for tests/observability,
   *  not consumed by any routing logic. */
  growCount = 0;
  shrinkCount = 0;

  constructor(opts: AdaptiveFastembedPoolOptions) {
    this.minSize = Math.max(1, Math.floor(opts.minSize ?? 1));
    this.maxSize = Math.max(this.minSize, Math.floor(opts.maxSize));
    this.hostPathOverride = opts.hostPathOverride;
    this.admissionLimit = opts.admissionLimit ?? resolveFastembedAdmissionLimit();
    this.clock = opts.now ?? (() => Date.now());
    this.growQueueRatioThreshold = opts.growQueueRatioThreshold ?? GROW_QUEUE_RATIO_THRESHOLD;
    this.growSustainCount = opts.growSustainCount ?? GROW_SUSTAIN_COUNT;
    this.growSustainWindowMs = opts.growSustainWindowMs ?? GROW_SUSTAIN_WINDOW_MS;
    this.growCooldownMs = opts.growCooldownMs ?? GROW_COOLDOWN_MS;
    this.shrinkIdleMs = opts.shrinkIdleMs ?? SHRINK_IDLE_MS;
    this.poolGroup = `apool-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    this.members = Array.from(
      { length: this.minSize },
      (_, i) => new SharedFastembedProcessClient(this.hostPathOverride, this.poolGroup, this.minSize, i),
    );
    this.inFlight = new Array(this.minSize).fill(0) as number[];
    this.idleSinceMs = this.clock();

    // Unref'd — a periodic shrink-check timer must never keep an otherwise
    // idle process alive (BL-370's exact failure shape, applied here).
    this.shrinkTimer = setInterval(() => {
      this.maybeShrink();
    }, opts.shrinkCheckIntervalMs ?? SHRINK_CHECK_INTERVAL_MS);
    if (typeof this.shrinkTimer.unref === 'function') this.shrinkTimer.unref();
  }

  get started(): boolean {
    return this.members.some((m) => m.started);
  }

  get lastInit(): Record<string, unknown> | null {
    return this.lastInitPayload;
  }

  get pendingCount(): number {
    return this.members.reduce((sum, m) => sum + m.pendingCount, 0);
  }

  /** Current pool size — exposed for tests/observability. */
  get size(): number {
    return this.members.length;
  }

  private leastLoadedIndex(): number {
    let bestIdx = 0;
    for (let i = 1; i < this.inFlight.length; i++) {
      if (this.inFlight[i]! < this.inFlight[bestIdx]!) bestIdx = i;
    }
    return bestIdx;
  }

  /** Renumber every member's `pool_size`/`member_index` telemetry fields to
   *  match current pool composition — called after every grow/shrink so
   *  `fastembed_process.request.*` records stay truthful. */
  private renumberMembers(): void {
    for (let i = 0; i < this.members.length; i++) {
      this.members[i]!.setPoolMeta(this.members.length, i);
    }
  }

  /**
   * Attempt to add one member, up to `maxSize`. Best-effort and internally
   * serialized (`growInFlight`) — safe to call from multiple concurrent
   * `request()` admissions without double-growing. If a `lastInitPayload`
   * exists (the pool has already been initialized with a model), the new
   * member is sent the SAME init payload before being added to routing —
   * an un-initialized member would fail every real embed request it was
   * routed to.
   */
  private async grow(): Promise<void> {
    if (this.growInFlight) return this.growInFlight;
    if (this.members.length >= this.maxSize) return;

    this.growInFlight = (async () => {
      const newIndex = this.members.length;
      const member = new SharedFastembedProcessClient(
        this.hostPathOverride,
        this.poolGroup,
        newIndex + 1,
        newIndex,
      );
      try {
        if (this.lastInitPayload) {
          await member.request(this.lastInitPayload);
        }
        this.members.push(member);
        this.inFlight.push(0);
        this.renumberMembers();
        this.growCount += 1;
        this.lastGrowAt = this.clock();
        this.growConsecutiveOverThreshold = 0;
        this.growStreakStartedAt = null;
        log.info('fastembed_process.pool.grew', {
          pool_group: this.poolGroup,
          new_size: this.members.length,
          max_size: this.maxSize,
        });
      } catch (err) {
        // A failed init (model load error, fork failure) must not corrupt
        // routing state — the member is simply discarded; the pool stays
        // at its previous size and can retry growing on a later admission.
        log.warn('fastembed_process.pool.grow_failed', {
          pool_group: this.poolGroup,
          attempted_size: newIndex + 1,
          error: err instanceof Error ? err.message : String(err),
        });
        await member.terminate().catch(() => undefined);
      }
    })();
    try {
      await this.growInFlight;
    } finally {
      this.growInFlight = null;
    }
  }

  /** Periodic shrink check — terminates exactly ONE idle member if the
   *  entire pool has been continuously idle for `SHRINK_IDLE_MS`. Never
   *  shrinks below `minSize`. Resets the idle clock after shrinking so a
   *  demand spike right after only costs one re-grow step, not a full
   *  rebuild, and so consecutive shrinks are still spaced `SHRINK_IDLE_MS`
   *  apart (the same conservative cadence, not a rapid drain to `minSize`). */
  private maybeShrink(): void {
    if (this.terminated) return;
    if (this.members.length <= this.minSize) return;
    if (this.pendingCount > 0) {
      this.idleSinceMs = null;
      return;
    }
    if (this.idleSinceMs === null) {
      this.idleSinceMs = this.clock();
      return;
    }
    if (this.clock() - this.idleSinceMs < this.shrinkIdleMs) return;

    const doomed = this.members.pop()!;
    this.inFlight.pop();
    this.renumberMembers();
    this.shrinkCount += 1;
    this.idleSinceMs = this.clock();
    log.info('fastembed_process.pool.shrank', {
      pool_group: this.poolGroup,
      new_size: this.members.length,
      min_size: this.minSize,
    });
    void doomed.terminate().catch((err: unknown) => {
      log.warn('fastembed_process.pool.shrink_terminate_failed', {
        pool_group: this.poolGroup,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  async request<T = Record<string, unknown>>(
    payload: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (payload['type'] === 'init') {
      this.lastInitPayload = payload;
      const results = await Promise.all(
        this.members.map((m) => m.request<T>(payload, timeoutMs, signal)),
      );
      return results[0] as T;
    }

    // Any real admission means the pool is not idle right now — cancel any
    // in-progress idle clock so `maybeShrink()` requires a fresh full
    // `SHRINK_IDLE_MS` window starting from here.
    this.idleSinceMs = null;

    // Evaluate the grow condition BEFORE reserving this request's own slot —
    // the ratio should reflect backlog that existed independent of this
    // admission, matching "sustained queue depth", not "this one request
    // pushed the ratio over the line by itself".
    //
    // BL-575 hysteresis fix: a count of consecutive over-threshold
    // admissions has NO time dimension on its own — see
    // `GROW_SUSTAIN_WINDOW_MS`'s doc comment for the real-inference trial
    // that caught this (concurrency=8 grew 1->2 on every run, which the
    // design explicitly says should never happen). BOTH the count AND a
    // minimum REAL elapsed span since the streak began are now required.
    const avgPendingPerMember = this.pendingCount / this.members.length;
    const now = this.clock();
    if (avgPendingPerMember >= this.growQueueRatioThreshold) {
      if (this.growConsecutiveOverThreshold === 0) this.growStreakStartedAt = now;
      this.growConsecutiveOverThreshold += 1;
    } else {
      this.growConsecutiveOverThreshold = 0;
      this.growStreakStartedAt = null;
    }
    const streakSpanMs = this.growStreakStartedAt === null ? 0 : now - this.growStreakStartedAt;
    if (
      this.growConsecutiveOverThreshold >= this.growSustainCount &&
      streakSpanMs >= this.growSustainWindowMs &&
      this.members.length < this.maxSize &&
      now - this.lastGrowAt >= this.growCooldownMs &&
      !this.growInFlight
    ) {
      // Fire-and-forget: growth must not add its own (model-load-scale)
      // latency to THIS request, which should be routed to an existing
      // member right now, not wait for a brand new one to spin up.
      void this.grow();
    }

    const idx = this.leastLoadedIndex();
    if (this.inFlight[idx]! >= this.admissionLimit) {
      const retryAfterMs = Math.min(2000, 100 * (this.inFlight[idx]! + 1));
      throw new FastembedBusyError(
        `fastembed pool saturated: every one of ${this.members.length} member(s) already has ` +
          `>= ${this.admissionLimit} requests in flight`,
        retryAfterMs,
      );
    }
    this.inFlight[idx]! += 1;
    const target = this.members[idx]!;
    try {
      return await target.request<T>(payload, timeoutMs, signal);
    } finally {
      this.inFlight[idx]! -= 1;
    }
  }

  async terminate(): Promise<void> {
    this.terminated = true;
    clearInterval(this.shrinkTimer);
    await Promise.all(this.members.map((m) => m.terminate()));
  }
}

let _singleton: SharedFastembedClient | null = null;

/**
 * Process-wide singleton accessor — the ONLY sanctioned place a fastembed
 * child process is forked anywhere in `@adhd/sox-embedding-provider`
 * (BL-238/BL-171). Every `FastembedProvider` obtains its handle through this
 * function instead of constructing its own `worker_threads.Worker` or
 * `child_process`.
 *
 * (BL-575) Two shapes, chosen by whether `SOX_EMBED_POOL_SIZE` is set:
 *
 *   - PINNED (`resolveFastembedPoolPin()` returns non-null): a FIXED
 *     `FastembedProcessPool` at exactly that size, no adaptation — an
 *     operator who set this has already judged their model's footprint and
 *     the box's headroom; adaptive sizing would second-guess that judgement.
 *   - DEFAULT (no override): an `AdaptiveFastembedProcessPool` starting at
 *     `minSize: 1` (the topology real measurement shows wins below ~20
 *     concurrency) and growing toward `resolveFastembedPoolCeiling()` (the
 *     SAME ceiling `FastembedProcessPool` used to apply unconditionally)
 *     only under sustained demand — see that class's doc comment for the
 *     full measurement and hysteresis policy (BUG-MEMORY-EMBED-HEAD-OF-LINE-
 *     BLOCKING-001's original qdepth-11+ production regime is exactly the
 *     sustained-demand case this still grows to meet; the difference is it
 *     no longer pays that pool's cost on every LOWER-concurrency request
 *     too).
 *
 * Every existing caller keeps working unchanged either way — both classes
 * implement the same `SharedFastembedClient` shape (`request()`/
 * `terminate()`/`started`). Setting `SOX_EMBED_POOL_SIZE=1` recovers the
 * exact pre-BL-575 (and pre-pool) single-child topology.
 */
export function getSharedFastembedProcess(): SharedFastembedClient {
  if (_singleton) return _singleton;
  const pin = resolveFastembedPoolPin();
  _singleton =
    pin !== null
      ? new FastembedProcessPool(pin)
      : new AdaptiveFastembedProcessPool({ minSize: 1, maxSize: resolveFastembedPoolCeiling() });
  return _singleton;
}

/**
 * Test-only: reset the module-level singleton so a test can exercise a
 * fresh shared-process lifecycle (e.g. after deliberately crashing/
 * terminating it). Does NOT terminate any existing process itself — call
 * `.terminate()` on the previous instance first if a clean shutdown is
 * needed.
 */
export function __resetSharedFastembedProcessForTests(): void {
  _singleton = null;
}
