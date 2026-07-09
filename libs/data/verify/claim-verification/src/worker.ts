/**
 * Worker proxy for NLI verification — uses the shared ONNX worker thread.
 *
 * BL-238/BL-171 fix: routes ALL NLI inference through
 * `@adhd/sox-embedding-provider`'s `getSharedOnnxWorker()` — the ONE
 * process-wide onnxruntime-bearing worker allowed to exist in this process
 * (see `sharedOnnxWorker.ts` there for the full root-cause writeup). This
 * package no longer constructs its own `worker_threads.Worker`: doing so
 * would risk a second, concurrent onnxruntime-node native instance in the
 * same process, which crashes the whole process with a V8 HandleScope fatal
 * error (proven via a from-scratch minimal repro — see BL-238). `WorkerProxy`
 * below is now a thin proxy over the shared client rather than the owner of
 * a real `Worker` — its `workerId`/`isBusy`/`queuedJobs` bookkeeping is kept
 * for pool health-reporting (`ClaimVerifierConfig.workerCount`), but every
 * `WorkerProxy` in a pool now funnels onto the SAME underlying shared worker
 * (a deliberate, documented trade-off — see `sharedOnnxWorker.ts`).
 */

import { getSharedOnnxWorker, type SharedOnnxWorkerClient } from '@adhd/sox-embedding-provider';
import type { EntailmentLabel } from './types.js';

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
//
// BL-238/BL-171: every verify request is proxied through the ONE process-wide
// `SharedOnnxWorkerClient` instead of a `Worker` owned by this class — see
// the file header for why. `send()` only ever needs to support
// `WorkerVerifyMessage` in practice (the only variant `@adhd/sox-claim-
// verification`'s `index.ts` ever constructs); `warmup`/`verifyBatch`/
// `shutdown` message *types* are kept in the public union for API
// compatibility but are not meaningful wire requests to embedWorker.ts.

interface SharedInitOkResponse {
  initOk: true;
  dim?: number;
}

// Note: `SharedOnnxWorkerClient.request()` already rejects the promise when
// embedWorker.ts responds with `{ error: string }` (see sharedOnnxWorker.ts),
// so a successfully-resolved response here always carries `result` — never
// `error`. Errors are handled uniformly by the `catch` block in `send()`
// below, not by inspecting this shape.
interface SharedVerifyResponse {
  result: { entailment: string; confidence: number; timingMs: number };
}

export class WorkerProxy {
  readonly workerId: number;
  private shared: SharedOnnxWorkerClient;
  private _isBusy = false;
  private _queuedJobs = 0;
  private _lastActivityMs = Date.now();
  private _isReady = false;
  private _shutdown = false;

  constructor(workerId: number) {
    this.workerId = workerId;
    this.shared = getSharedOnnxWorker();
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
    await this.shared.request<SharedInitOkResponse>({
      type: 'init',
      initType: 'verify',
      modelId: config.modelId,
      modelVersion: config.modelVersion,
    });
    this._isReady = true;
    this._lastActivityMs = Date.now();
  }

  async send(message: MainToWorkerMessage, timeoutMs = 30000): Promise<WorkerToMainMessage> {
    if (this._shutdown) throw new Error('worker has been shut down');
    if (!this._isReady) throw new Error('worker not started');
    if (message.type !== 'verify') {
      throw new Error(
        `WorkerProxy.send: unsupported message type "${message.type}" — only "verify" is wired to the shared ONNX worker`,
      );
    }

    this._isBusy = true;
    this._queuedJobs++;
    try {
      const res = await this.shared.request<SharedVerifyResponse>(
        {
          type: 'verify',
          jobId: message.jobId,
          claimText: message.claimText,
          sourceText: message.sourceText,
        },
        timeoutMs,
      );
      this._lastActivityMs = Date.now();

      const result = res.result;
      const verifyResult: WorkerResultMessage = {
        type: 'result',
        jobId: message.jobId,
        entailment: result.entailment as EntailmentLabel,
        confidence: result.confidence,
        preFilterSkipped: false,
        timingMs: result.timingMs,
      };
      return verifyResult;
    } catch (err) {
      const errResult: WorkerErrorMessage = {
        type: 'error',
        jobId: message.jobId,
        errorCode: 'WORKER_ERROR',
        errorMessage: err instanceof Error ? err.message : String(err),
      };
      return errResult;
    } finally {
      this._isBusy = false;
      this._queuedJobs = Math.max(0, this._queuedJobs - 1);
    }
  }

  /**
   * Stop using the shared ONNX worker from this instance. Does NOT terminate
   * the underlying shared worker — fastembed embeddings and/or the
   * cross-encoder reranker may still depend on it (BL-238).
   */
  async shutdown(): Promise<void> {
    this._shutdown = true;
    this._isReady = false;
  }
}
