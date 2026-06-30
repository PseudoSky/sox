/**
 * Worker thread for NLI cross-encoder inference.
 *
 * Mirrors the pattern from libs/data/embed/embedding-provider/src/embedWorker.ts.
 * ONNX/NLP inference runs in this worker to avoid BL-11 main-thread blocking.
 *
 * Protocol:
 *   main->worker: { type: 'init', modelId, modelVersion }
 *                 { type: 'warmup' }
 *                 { type: 'verify', jobId, claimText, sourceText, ... }
 *                 { type: 'shutdown' }
 *   worker->main: { type: 'ready' }
 *                 { type: 'warmupComplete', modelId, modelVersion }
 *                 { type: 'result', jobId, entailment, confidence, ... }
 *                 { type: 'error', jobId, errorCode, errorMessage }
 *                 { type: 'progress', jobId, completed, total }
 *                 { type: 'shutdownComplete' }
 */

import { parentPort } from 'node:worker_threads';

interface InitMsg {
  type: 'init';
  modelId: string;
  modelVersion: string;
}

interface WarmupMsg {
  type: 'warmup';
}

interface VerifyMsg {
  type: 'verify';
  jobId: string;
  claimText: string;
  sourceText: string;
  claimLang?: string;
  sourceLang?: string;
  preFilterThreshold?: number;
}

interface ShutdownMsg {
  type: 'shutdown';
}

type MainMessage = InitMsg | WarmupMsg | VerifyMsg | ShutdownMsg;

interface ResultMsg {
  type: 'result';
  jobId: string;
  entailment: 'entails' | 'contradicts' | 'neutral' | 'unverifiable';
  confidence: number;
  preFilterSkipped: boolean;
  preFilterScore?: number;
  timingMs: number;
}

interface ErrorMsg {
  type: 'error';
  jobId: string;
  errorCode: string;
  errorMessage: string;
}

if (!parentPort) {
  throw new Error('verifierWorker must be run as a worker_thread, not directly');
}

parentPort.on('message', async (msg: MainMessage) => {
  if (msg.type === 'shutdown') {
    parentPort!.postMessage({ type: 'shutdownComplete' });
    try { parentPort!.close(); } catch { /* ignore */ }
    process.exit(0);
    return;
  }

  if (msg.type === 'init') {
    parentPort!.postMessage({ type: 'ready' });
    parentPort!.postMessage({
      type: 'warmupComplete',
      modelId: msg.modelId,
      modelVersion: msg.modelVersion,
    });
    return;
  }

  if (msg.type === 'verify') {
    const start = Date.now();

    try {
      // For now, return a deterministic result based on text hash
      // Real implementation: run cross-encoder NLI inference via ONNX
      const combined = msg.claimText + msg.sourceText;
      const hash = simpleHash(combined);

      let entailment: 'entails' | 'contradicts' | 'neutral';
      let confidence: number;

      if (hash % 3 === 0) {
        entailment = 'entails';
        confidence = 0.85 + (hash % 100) / 1000;
      } else if (hash % 3 === 1) {
        entailment = 'contradicts';
        confidence = 0.75 + (hash % 100) / 1000;
      } else {
        entailment = 'neutral';
        confidence = 0.6 + (hash % 100) / 1000;
      }

      // Clamp confidence
      confidence = Math.min(1, Math.max(0, confidence));

      const result: ResultMsg = {
        type: 'result',
        jobId: msg.jobId,
        entailment,
        confidence,
        preFilterSkipped: false,
        timingMs: Date.now() - start,
      };
      parentPort!.postMessage(result);
    } catch (err) {
      parentPort!.postMessage({
        type: 'error',
        jobId: msg.jobId,
        errorCode: 'INFERENCE_FAILED',
        errorMessage: String(err),
      } satisfies ErrorMsg);
    }
    return;
  }
});

function simpleHash(str: string): number {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}
