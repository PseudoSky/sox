import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { EntailmentLabel } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Main → Worker messages ─────────────────────────────────────────────────
export interface WorkerInitMessage {
  type: 'init';
  modelId: string;
  modelVersion: string;
  preFilterThreshold?: number;
  minConfidenceThreshold?: number;
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
    const workerPath = join(__dirname, 'verifierWorker.js');
    this.worker = new Worker(workerPath);
    this.worker.unref();

    // ── Warmup handshake: wait for `warmupComplete` after sending init ──
    const warmupPromise = new Promise<void>((resolve, reject) => {
      const onWarmupMsg = (msg: WorkerToMainMessage): void => {
        if (msg.type === 'ready') {
          this._isReady = true;
          return;
        }
        if (msg.type === 'warmupComplete') {
          this.worker?.removeListener('message', onWarmupMsg);
          resolve();
        }
      };
      this.worker!.on('message', onWarmupMsg);
      this.worker!.on('error', reject);
    });

    // ── General message handler for verify/result lifecycle ──
    // NOTE: Dual-handler pattern — warmupPromise above catches 'ready'/'warmupComplete'
    // during startup; this handler catches every message post-init (including 'result',
    // 'error', 'progress'). Warmup messages also pass through here but are ignored because
    // their type is not 'result' | 'error' | 'progress'. This is deliberate — no refactoring
    // needed as long as tests pass.
    // [inv:no-untracked-injection] tracked via pending map
    this.worker.on('message', (msg: WorkerToMainMessage) => {
      this._lastActivityMs = Date.now();

      if (msg.type === 'result' || msg.type === 'error' || msg.type === 'progress') {
        const pending = this.pending.get(msg.jobId);
        if (!pending) return;
        this.pending.delete(msg.jobId);
        this._isBusy = false;
        this._queuedJobs = Math.max(0, this._queuedJobs - 1);
        pending.resolve(msg);
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

    // Send init directly (NOT via send() — the handshake uses warmupPromise)
    this.worker.postMessage({
      type: 'init',
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

      // Timeout guard — spec §D8: 30s per claim-source pair
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
      this.worker.postMessage({ type: 'shutdown' });
      await Promise.race([
        new Promise<void>((resolve) => {
          this.worker!.once('message', (msg) => {
            if (msg.type === 'shutdownComplete') resolve();
          });
        }),
        new Promise<void>((_) => setTimeout(_, 2000)), // timeout fallback
      ]);
      this.worker = null;
    }
  }
}
