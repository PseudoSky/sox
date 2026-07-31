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
import { existsSync } from 'node:fs';

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

  /** True once the underlying child process has been forked. */
  get started(): boolean {
    return this.child !== null;
  }

  /** Lazily fork (exactly once) and return the single shared child process. */
  private ensureProcess(): Promise<ChildProcess> {
    if (this.child) return Promise.resolve(this.child);
    if (this.startingPromise) return this.startingPromise;

    this.startingPromise = new Promise<ChildProcess>((resolveStart) => {
      const hostPath = resolveFastembedHostPath();
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
   * Send a request to the shared fastembed process and await its correlated
   * response. Assigns a globally-unique `id` — the caller must NOT set its
   * own `id` (any `id` field on `payload` is ignored/overwritten).
   */
  async request<T = Record<string, unknown>>(
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    const child = await this.ensureProcess();
    const id = this.nextId++;

    return new Promise<T>((resolve, reject) => {
      let to: NodeJS.Timeout | undefined;
      if (timeoutMs && timeoutMs > 0) {
        to = setTimeout(() => {
          this.pending.delete(id);
          reject(new Error(`shared fastembed process request timed out after ${timeoutMs}ms`));
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

      child.send({ ...payload, id });
    });
  }

  /**
   * Forcefully terminate the shared fastembed process. Intended ONLY for
   * full process shutdown or test teardown that genuinely owns the whole
   * process's fastembed lifecycle.
   */
  async terminate(): Promise<void> {
    const c = this.child;
    this.child = null;
    this.startingPromise = null;
    for (const { reject } of this.pending.values()) {
      reject(new Error('shared fastembed process terminated'));
    }
    this.pending.clear();
    if (c) {
      c.kill();
    }
  }
}

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
