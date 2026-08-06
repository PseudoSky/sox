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

import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
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
 */
function detectCompetingFastembedHost(ownPid: number | undefined): { pid: number; startedAt: string } | null {
  try {
    const lockPath = resolveFastembedLockPath();
    if (!existsSync(lockPath)) return null;
    const raw = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: unknown; startedAt?: unknown };
    const pid = typeof raw.pid === 'number' ? raw.pid : null;
    if (pid === null || pid === ownPid || !isPidAlive(pid)) return null;
    return { pid, startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : 'unknown' };
  } catch {
    return null;
  }
}

interface PendingEntry {
  resolve: (v: Record<string, unknown>) => void;
  reject: (e: Error) => void;
}

type HostMessage = { id: number } & Record<string, unknown>;

export class SharedFastembedProcessClient {
  private child: ChildProcess | null = null;
  private startingPromise: Promise<ChildProcess> | null = null;
  private nextId = 1;
  private pending = new Map<number, PendingEntry>();
  private readonly hostPath: string | undefined;

  /**
   * @param hostPathOverride Test-only injection point (BL-410): points the
   * fork target at a lightweight fixture host instead of the real
   * `fastembedProcessHost.js`, so a test can exercise the fork/ref/unref
   * contract without loading fastembed or downloading a model. Production
   * code (`getSharedFastembedProcess()`) never passes this — it always
   * resolves the real host path.
   */
  constructor(hostPathOverride?: string) {
    this.hostPath = hostPathOverride;
  }

  /** True once the underlying child process has been forked. */
  get started(): boolean {
    return this.child !== null;
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
      });

      c.on('exit', (code: number | null) => {
        if (code !== 0 && code !== null) {
          const err = new Error(`shared fastembed process exited with code ${code}`);
          for (const { reject } of this.pending.values()) reject(err);
          this.pending.clear();
        }
        this.child = null;
        this.startingPromise = null;
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
   */
  async request<T = Record<string, unknown>>(
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    const child = await this.ensureProcess();
    const id = this.nextId++;

    const queueDepth = this.pending.size;
    const competing = detectCompetingFastembedHost(child.pid);
    const baseFields: Record<string, unknown> = {
      queue_depth: queueDepth,
      ...(competing ? { competing_host_pid: competing.pid } : {}),
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

      this.pending.set(id, {
        resolve: (v) => {
          if (to) clearTimeout(to);
          log.info('fastembed_process.request.finish', {
            ...baseFields,
            response_ms: Math.round(performance.now() - sentAt),
          });
          resolve(v as T);
        },
        reject: (e) => {
          if (to) clearTimeout(to);
          log.warn('fastembed_process.request.error', {
            ...baseFields,
            response_ms: Math.round(performance.now() - sentAt),
            error: e.message,
          });
          reject(e);
        },
      });
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
    } catch {
      // IPC already gone — kill() below is the only path left.
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

let _singleton: SharedFastembedProcessClient | null = null;

/**
 * Process-wide singleton accessor — the ONLY sanctioned place a fastembed
 * child process is forked anywhere in `@adhd/sox-embedding-provider`
 * (BL-238/BL-171). Every `FastembedProvider` obtains its handle through this
 * function instead of constructing its own `worker_threads.Worker` or
 * `child_process`.
 */
export function getSharedFastembedProcess(): SharedFastembedProcessClient {
  if (!_singleton) _singleton = new SharedFastembedProcessClient();
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
