/**
 * Worker proxy for NLI verification — uses the shared ONNX worker thread.
 *
 * Uses the embedding-provider's shared embedWorker.ts — the ONLY worker
 * implementation (RS-2, BL-149c). The old verifierWorker.ts has been
 * migrated onto the shared worker protocol.
 */

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { EntailmentLabel } from './types.js';

// ── Resolve shared worker path ────────────────────────────────────────────────

function resolveWorkerPath(): string {
  const pkgPath = join(
    dirname(fileURLToPath(import.meta.url)),
    '..', '..', '..', '..',
    'embed', 'embedding-provider', 'dist', 'embedWorker.js',
  );

  if (existsSync(pkgPath)) return pkgPath;

  try {
    const epPath = require.resolve('@adhd/sox-embedding-provider');
    const base = dirname(epPath);
    const workerPath = join(base, 'embedWorker.js');
    if (existsSync(workerPath)) return workerPath;
  } catch {
    // continue to fallback
  }

  return join(
    dirname(fileURLToPath(import.meta.url)),
    'verifierWorker.js',
  );
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
    this.worker.on('message', (msg: WorkerToMainMessage | { initOk?: boolean; result?: { entailment: string; confidence: number; timingMs: number } }) => {
      this._lastActivityMs = Date.now();

      if ('result' in msg && msg.result) {
        // Map shared worker verify response to WorkerResultMessage
        const verifyResult: WorkerResultMessage = {
          type: 'result',
          jobId: String((msg as { id: number; result: { entailment: string; confidence: number; timingMs: number } }).id),
          entailment: msg.result.entailment as EntailmentLabel,
          confidence: msg.result.confidence,
          preFilterSkipped: false,
          timingMs: msg.result.timingMs,
        };
        const pending = this.pending.get(verifyResult.jobId);
        if (!pending) return;
        this.pending.delete(verifyResult.jobId);
        this._isBusy = false;
        this._queuedJobs = Math.max(0, this._queuedJobs - 1);
        pending.resolve(verifyResult);
      } else if ('type' in msg && (msg.type === 'result' || msg.type === 'error' || msg.type === 'progress')) {
        const typedMsg = msg as WorkerToMainMessage;
        const pendingId = typedMsg.type === 'result' || typedMsg.type === 'error'
          ? (typedMsg as WorkerResultMessage | WorkerErrorMessage).jobId
          : String(this.nextId);
        const pending = this.pending.get(pendingId);
        if (!pending) return;
        this.pending.delete(pendingId);
        this._isBusy = false;
        this._queuedJobs = Math.max(0, this._queuedJobs - 1);
        pending.resolve(typedMsg);
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

  async send(message: MainToWorkerMessage, timeoutMs = 30000): Promise<WorkerToMainMessage> {
    if (!this.worker) throw new Error('worker not started');
    const id = String(this.nextId++);
    const msg = { ...message, jobId: id } as MainToWorkerMessage & { jobId: string };

    return new Promise<WorkerToMainMessage>((resolve, reject) => {
      this._isBusy = true;
      this._queuedJobs++;
      this.pending.set(id, { resolve, reject });
      this.worker!.postMessage(msg);

      // Timeout guard
      const to = setTimeout(() => {
        this.pending.delete(id);
        this._isBusy = false;
        this._queuedJobs = Math.max(0, this._queuedJobs - 1);
        reject(new Error(`Worker ${this.workerId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      // Wrap resolve/reject to clear the timeout guard
      const origResolve = this.pending.get(id)!.resolve;
      this.pending.set(id, {
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
