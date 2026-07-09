/**
 * Worker proxy for NLI verification — uses the shared ONNX worker thread.
 *
 * Uses the embedding-provider's shared embedWorker.ts — the ONLY worker
 * implementation (RS-2, BL-149c). The old verifierWorker.ts has been
 * migrated onto the shared worker protocol.
 */

import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { EntailmentLabel } from './types.js';

// ── Resolve shared worker path ────────────────────────────────────────────────

function resolveWorkerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));

  // Primary: resolve via Node module resolution through the
  // `@adhd/sox-embedding-provider` devDependency. Robust regardless of
  // monorepo directory depth/layout — follows the pnpm workspace symlink
  // (libs/data/verify/claim-verification/node_modules/@adhd/sox-embedding-provider
  // -> ../../../../embed/embedding-provider) rather than assuming a fixed
  // number of `..` hops from this file's own location.
  try {
    const require = createRequire(import.meta.url);
    const epEntry = require.resolve('@adhd/sox-embedding-provider');
    const workerPath = join(dirname(epEntry), 'embedWorker.js');
    if (existsSync(workerPath)) return workerPath;
  } catch {
    // continue to fallback
  }

  // Fallback: standard monorepo relative layout —
  // libs/data/verify/claim-verification/{src,dist} -> libs/data/embed/embedding-provider/dist
  // (src and dist are equidistant: dist mirrors src 1:1 via rootDir/outputPath).
  const relPath = join(here, '..', '..', '..', 'embed', 'embedding-provider', 'dist', 'embedWorker.js');
  if (existsSync(relPath)) return relPath;

  return join(here, 'verifierWorker.js');
}

// ── Main → Worker messages ─────────────────────────────────────────────────

export interface WorkerInitMessage {
  type: 'init';
  initType: 'verify';
  modelId: string;
  modelVersion: string;
}

export interface WorkerWarmupMessage {
  type: 'warmup';
}

export interface WorkerVerifyMessage {
  type: 'verify';
  jobId: string;
  claimText: string;
  sourceText: string;
  claimLang?: string;
  sourceLang?: string;
  preFilterThreshold?: number;
}

export interface WorkerVerifyBatchMessage {
  type: 'verifyBatch';
  jobId: string;
  pairs: Array<{
    jobId: string;
    claimText: string;
    sourceText: string;
    claimLang?: string;
    sourceLang?: string;
    preFilterThreshold?: number;
  }>;
}

export interface WorkerShutdownMessage {
  type: 'shutdown';
}

export type MainToWorkerMessage =
  | WorkerInitMessage
  | WorkerWarmupMessage
  | WorkerVerifyMessage
  | WorkerVerifyBatchMessage
  | WorkerShutdownMessage;

// ── Worker → Main messages ─────────────────────────────────────────────────
export interface WorkerReadyMessage {
  type: 'ready';
}

export interface WorkerWarmupCompleteMessage {
  type: 'warmupComplete';
  modelId: string;
  modelVersion: string;
}

export interface WorkerResultMessage {
  type: 'result';
  jobId: string;
  entailment: EntailmentLabel;
  confidence: number;
  preFilterSkipped: boolean;
  preFilterScore?: number;
  timingMs: number;
}

export interface WorkerErrorMessage {
  type: 'error';
  jobId: string;
  errorCode: string;
  errorMessage: string;
}

export interface WorkerProgressMessage {
  type: 'progress';
  jobId: string;
  completed: number;
  total: number;
}

export interface WorkerShutdownCompleteMessage {
  type: 'shutdownComplete';
}

export type WorkerToMainMessage =
  | WorkerReadyMessage
  | WorkerWarmupCompleteMessage
  | WorkerResultMessage
  | WorkerErrorMessage
  | WorkerProgressMessage
  | WorkerShutdownCompleteMessage;

// ── Worker proxy ────────────────────────────────────────────────────────────

export class WorkerProxy {
  readonly workerId: number;
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: WorkerToMainMessage) => void; reject: (e: Error) => void }>();
  private _isBusy = false;
  private _queuedJobs = 0;
  private _lastActivityMs = Date.now();
  private _isReady = false;
  private _shutdown = false;

  constructor(workerId: number) {
    this.workerId = workerId;
  }

  get isBusy(): boolean {
    return this._isBusy;
  }

  get queuedJobs(): number {
    return this._queuedJobs;
  }

  get lastActivityMs(): number {
    return this._lastActivityMs;
  }

  get isReady(): boolean {
    return this._isReady;
  }

  async start(config: { modelId: string; modelVersion: string }): Promise<void> {
    const workerPath = resolveWorkerPath();
    this.worker = new Worker(workerPath);
    this.worker.unref();

    // ── Warmup handshake: send init and wait ──
    const warmupPromise = new Promise<void>((resolve, reject) => {
      const onMsg = (msg: WorkerToMainMessage | { initOk?: boolean }): void => {
        if ('initOk' in msg && msg.initOk === true) {
          this._isReady = true;
          this.worker?.removeListener('message', onMsg);
          resolve();
        }
      };
      this.worker!.on('message', onMsg);
      this.worker!.on('error', reject);
    });

    // ── General message handler for verify/result lifecycle ──
    this.worker.on('message', (msg:
      | WorkerToMainMessage
      | { initOk?: boolean; id?: number; result?: { entailment: string; confidence: number; timingMs: number }; error?: string }
    ) => {
      this._lastActivityMs = Date.now();

      if ('result' in msg && msg.result) {
        // Map shared worker verify response ({id, result}) to WorkerResultMessage.
        // `id` is the numeric correlation id set by send() below (echoed back
        // verbatim by embedWorker.ts) — NOT the caller-supplied UUID `jobId`.
        const verifyResult: WorkerResultMessage = {
          type: 'result',
          jobId: String(msg.id),
          entailment: msg.result.entailment as EntailmentLabel,
          confidence: msg.result.confidence,
          preFilterSkipped: false,
          timingMs: msg.result.timingMs,
        };
        this.resolvePendingById(verifyResult.jobId, verifyResult);
      } else if ('error' in msg && typeof msg.error === 'string' && typeof msg.id === 'number') {
        // Shared worker error response ({id, error}) — map onto WorkerErrorMessage.
        const errResult: WorkerErrorMessage = {
          type: 'error',
          jobId: String(msg.id),
          errorCode: 'WORKER_ERROR',
          errorMessage: msg.error,
        };
        this.resolvePendingById(errResult.jobId, errResult);
      } else if ('type' in msg && (msg.type === 'result' || msg.type === 'error' || msg.type === 'progress')) {
        const typedMsg = msg as WorkerToMainMessage;
        const pendingId = typedMsg.type === 'result' || typedMsg.type === 'error'
          ? (typedMsg as WorkerResultMessage | WorkerErrorMessage).jobId
          : String(this.nextId);
        this.resolvePendingById(pendingId, typedMsg);
      }
    });

    this.worker.on('error', (err) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });

    this.worker.on('exit', (code) => {
      if (code !== 0 && !this._shutdown) {
        const err = new Error(`worker exited with code ${code}`);
        for (const { reject } of this.pending.values()) reject(err);
        this.pending.clear();
      }
    });

    // Send init with the shared worker protocol (initType: 'verify')
    this.worker.postMessage({
      type: 'init',
      initType: 'verify',
      modelId: config.modelId,
      modelVersion: config.modelVersion,
    });

    await warmupPromise;
  }

  /** Resolve (and clear) a pending job by its correlation id, if still pending. */
  private resolvePendingById(pendingId: string, resolved: WorkerToMainMessage): void {
    const pending = this.pending.get(pendingId);
    if (!pending) return;
    this.pending.delete(pendingId);
    this._isBusy = false;
    this._queuedJobs = Math.max(0, this._queuedJobs - 1);
    pending.resolve(resolved);
  }

  async send(message: MainToWorkerMessage, timeoutMs = 30000): Promise<WorkerToMainMessage> {
    if (!this.worker) throw new Error('worker not started');
    // `id` is the numeric wire-protocol correlation id the shared embedWorker.ts
    // echoes back verbatim in its response ({id, result} / {id, error}) — distinct
    // from `jobId`, the caller-supplied UUID carried through in the request for
    // logging/tracing purposes only. Pending jobs are keyed by String(id).
    const id = this.nextId++;
    const msg = { ...message, id } as MainToWorkerMessage & { id: number };
    const pendingId = String(id);

    return new Promise<WorkerToMainMessage>((resolve, reject) => {
      this._isBusy = true;
      this._queuedJobs++;
      this.pending.set(pendingId, { resolve, reject });
      this.worker!.postMessage(msg);

      // Timeout guard
      const to = setTimeout(() => {
        this.pending.delete(pendingId);
        this._isBusy = false;
        this._queuedJobs = Math.max(0, this._queuedJobs - 1);
        reject(new Error(`Worker ${this.workerId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // Wrap resolve/reject to clear the timeout guard
      const origResolve = this.pending.get(pendingId)!.resolve;
      this.pending.set(pendingId, {
        resolve: (v) => { clearTimeout(to); origResolve(v); },
        reject: (e) => { clearTimeout(to); reject(e); },
      });
    });
  }

  async shutdown(): Promise<void> {
    this._shutdown = true;
    if (this.worker) {
      this.worker.postMessage({ __shutdown: true } as unknown as MainToWorkerMessage);
      await Promise.race([
        new Promise<void>((resolve) => {
          this.worker!.once('message', (msg) => {
            if (msg && msg.type === 'shutdownComplete') resolve();
          });
        }),
        new Promise<void>((_) => setTimeout(_, 2000)),
      ]);
      this.worker = null;
    }
  }
}
