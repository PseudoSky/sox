/**
 * Cross-encoder reranker using the shared ONNX worker thread.
 *
 * Uses the embedding-provider's shared embedWorker.ts — the ONLY worker
 * implementation (RS-2, BL-149c). Cross-encoder and claim-verification
 * migrated onto the same worker protocol.
 */

import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';

// TransientEmbeddingError/ResolutionError are used as VALUES (thrown + `new`) in the
// hot path, so they must be statically imported (not `import type`). nx flags this as a
// static-import-of-a-lazy-loaded-lib because resolveWorkerPath() below references the same
// package via `require.resolve(...)` — but require.resolve only RESOLVES a worker path, it
// never lazy-LOADS the module, so the heuristic is a false positive here. embedding-provider
// is a declared workspace dep of this package. (Regression surfaced from RS-1/RS-2, 3360f8b.)
// eslint-disable-next-line @nx/enforce-module-boundaries
import {
  TransientEmbeddingError,
  ResolutionError,
} from '@adhd/sox-embedding-provider';

/**
 * Resolve the path to the shared embed worker in @adhd/sox-embedding-provider.
 *
 * BL-fix (surfaced by tools/e2e/substrate-pipeline.test.mjs — the first real,
 * non-vitest-transformed `node --test` execution of this path): the previous
 * implementation (a) computed the monorepo-relative fallback with one `..`
 * hop too many (`libs/embed/...` instead of `libs/data/embed/...`, since this
 * file lives at `libs/data/search/hybrid-search/dist`, not `libs/hybrid-search/dist`),
 * and (b) referenced a bare `require` global inside this ESM module with no
 * `createRequire` shim — `require` is undefined here outside of vitest's SSR
 * transform (which synthesizes one for compatibility), so real Node execution
 * threw a ReferenceError, was silently swallowed by the catch, and fell all
 * the way through to a `crossEncoderWorker.js` that has never existed. Mirrors
 * the already-correct, already-proven pattern in
 * `claim-verification/src/worker.ts::resolveWorkerPath` (same
 * `libs/data/<group>/<pkg>/{src,dist}` depth).
 */
function resolveWorkerPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));

  // Primary: resolve via Node module resolution through the
  // `@adhd/sox-embedding-provider` workspace dependency — robust regardless
  // of monorepo directory depth/layout, follows this package's own
  // `node_modules/@adhd/sox-embedding-provider` pnpm workspace symlink.
  try {
    const require = createRequire(import.meta.url);
    const epEntry = require.resolve('@adhd/sox-embedding-provider');
    const workerPath = join(dirname(epEntry), 'embedWorker.js');
    if (existsSync(workerPath)) return workerPath;
  } catch {
    // continue to fallback
  }

  // Fallback: standard monorepo relative layout —
  // libs/data/search/hybrid-search/{src,dist} -> libs/data/embed/embedding-provider/dist
  // (src and dist are equidistant: dist mirrors src 1:1 via rootDir/outputPath).
  const relPath = join(here, '..', '..', '..', 'embed', 'embedding-provider', 'dist', 'embedWorker.js');
  if (existsSync(relPath)) return relPath;

  // Absolute last resort
  return join(here, 'crossEncoderWorker.js');
}

// ── Types ──────────────────────────────────────────────────────────────────

export interface CrossEncoderMetadata {
  modelId: string;
  maxTokens: number;
}

export interface CrossEncoderConfig {
  modelId: string;
  options?: {
    maxTokens?: number;
  };
}

export interface CrossEncoder {
  readonly metadata: CrossEncoderMetadata;

  rerank(
    query: string,
    candidates: Array<{ id: number | string; text: string }>,
    opts?: { timeoutMs?: number },
  ): Promise<Float32Array>;

  rerankBatch(
    queries: string[],
    candidateSets: Array<Array<{ id: number | string; text: string }>>,
    opts?: { timeoutMs?: number },
  ): Promise<Float32Array[]>;

  dispose(): Promise<void>;
}

// ── Reranker mode (for HybridSearchConfig) ─────────────────────────────────

export interface CrossEncoderRerankerConfig {
  mode: 'always-on' | 'threshold-gated' | 'skip';
  modelId: string;
  maxCandidates?: number;
  gateThreshold?: number;
}

// ── Worker proxy ───────────────────────────────────────────────────────────

interface WorkerScoreRequest {
  id: number;
  type: 'rerank';
  query: string;
  candidates: Array<{ id: string; text: string }>;
}

interface WorkerBatchRequest {
  id: number;
  type: 'rerankBatch';
  queries: string[];
  candidateSets: Array<Array<{ id: string; text: string }>>;
}

interface WorkerInitRequest {
  id: number;
  type: 'init';
  initType: 'rerank';
  modelId: string;
}

interface WorkerScoreResponse {
  id: number;
  scores: number[];
}

interface WorkerBatchResponse {
  id: number;
  allScores: number[][];
}

interface WorkerInitOkResponse {
  id: number;
  initOk: true;
  dim?: number;
}

interface WorkerErrorResponse {
  id: number;
  error: string;
}

type WorkerMessage = WorkerScoreResponse | WorkerBatchResponse | WorkerInitOkResponse | WorkerErrorResponse;

// ── ONNX worker thread for cross-encoder ───────────────────────────────────

class CrossEncoderWorker {
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: number[] | number[][]) => void; reject: (e: Error) => void }
  >();
  private readyPromise: Promise<void> | null = null;
  private modelId: string;

  constructor(modelId: string) {
    this.modelId = modelId;
  }

  async start(): Promise<void> {
    const workerPath = resolveWorkerPath();
    this.worker = new Worker(workerPath);
    this.worker.unref();

    this.worker.on('message', (msg: WorkerMessage) => {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if ('error' in msg) {
        pending.reject(new TransientEmbeddingError(msg.error));
      } else if ('scores' in msg) {
        pending.resolve(msg.scores);
      } else if ('allScores' in msg) {
        pending.resolve(msg.allScores);
      } else if ('initOk' in msg) {
        pending.resolve([]);
      }
    });

    this.worker.on('error', (err) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.worker = null;
    });

    // BL-fix (surfaced by tools/e2e/substrate-pipeline.test.mjs — the first
    // real, non-vitest-force-killed process to let this worker run to
    // completion): attaching a `'message'` listener on a `Worker` re-refs its
    // underlying MessagePort even if `.unref()` was already called earlier
    // (the `.unref()` above ran before any listener existed, so it was
    // silently undone by the `.on('message', ...)` registration above).
    // Re-assert unref here, now that every listener is attached, so a real
    // process can actually exit once its own work is done instead of hanging
    // on this worker forever.
    this.worker.unref();

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: () => { resolve(); },
        reject: (e) => { reject(e); },
      });
      this.worker!.postMessage({
        id,
        type: 'init',
        initType: 'rerank',
        modelId: this.modelId,
      } satisfies WorkerInitRequest);
    });

    await this.readyPromise;
  }

  async rerank(
    query: string,
    candidates: Array<{ id: number | string; text: string }>,
  ): Promise<Float32Array> {
    const worker = this.getWorker();
    if (this.readyPromise) await this.readyPromise;

    const mapped = candidates.map((c) => ({ id: String(c.id), text: c.text }));
    return new Promise<Float32Array>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: (v) => resolve(new Float32Array(v as number[])),
        reject,
      });
      worker.postMessage({
        id,
        type: 'rerank',
        query,
        candidates: mapped,
      } satisfies WorkerScoreRequest);
    });
  }

  async rerankBatch(
    queries: string[],
    candidateSets: Array<Array<{ id: number | string; text: string }>>,
  ): Promise<Float32Array[]> {
    const worker = this.getWorker();
    if (this.readyPromise) await this.readyPromise;

    const sets = candidateSets.map((set) =>
      set.map((c) => ({ id: String(c.id), text: c.text })),
    );

    return new Promise<Float32Array[]>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: (v) => resolve((v as number[][]).map((s) => new Float32Array(s))),
        reject,
      });
      worker.postMessage({
        id,
        type: 'rerankBatch',
        queries,
        candidateSets: sets,
      } satisfies WorkerBatchRequest);
    });
  }

  async stop(): Promise<void> {
    if (this.worker) {
      await this.worker.terminate();
      this.worker = null;
    }
    this.readyPromise = null;
  }

  private getWorker() {
    if (!this.worker) throw new Error('CrossEncoder worker not started');
    return this.worker;
  }
}

// ── CrossEncoderImpl ───────────────────────────────────────────────────────

class CrossEncoderImpl implements CrossEncoder {
  readonly metadata: CrossEncoderMetadata;
  private worker: CrossEncoderWorker | null = null;
  private startingPromise: Promise<CrossEncoderWorker> | null = null;
  private disposed = false;

  constructor(config: CrossEncoderConfig) {
    const modelId = config.modelId;
    const maxTokens = config.options?.maxTokens ?? 512;
    this.metadata = { modelId, maxTokens };
  }

  async rerank(
    query: string,
    candidates: Array<{ id: number | string; text: string }>,
    opts?: { timeoutMs?: number },
  ): Promise<Float32Array> {
    if (this.disposed) throw new ResolutionError('CrossEncoder has been disposed');
    const worker = await this.getWorker();
    const timeoutMs = opts?.timeoutMs ?? 30000;
    const result = worker.rerank(query, candidates);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`CrossEncoder rerank timed out after ${timeoutMs}ms`)), timeoutMs),
    );
    return Promise.race([result, timeout]) as Promise<Float32Array>;
  }

  async rerankBatch(
    queries: string[],
    candidateSets: Array<Array<{ id: number | string; text: string }>>,
    opts?: { timeoutMs?: number },
  ): Promise<Float32Array[]> {
    if (this.disposed) throw new ResolutionError('CrossEncoder has been disposed');
    const worker = await this.getWorker();
    const timeoutMs = opts?.timeoutMs ?? 30000;
    const result = worker.rerankBatch(queries, candidateSets);
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`CrossEncoder rerankBatch timed out after ${timeoutMs}ms`)), timeoutMs),
    );
    return Promise.race([result, timeout]) as Promise<Float32Array[]>;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    if (this.worker) {
      await this.worker.stop();
      this.worker = null;
    }
  }

  private async getWorker(): Promise<CrossEncoderWorker> {
    if (this.worker) return this.worker;
    if (this.startingPromise) return this.startingPromise;

    this.startingPromise = (async () => {
      const w = new CrossEncoderWorker(this.metadata.modelId);
      await w.start();
      this.worker = w;
      this.startingPromise = null;
      return w;
    })();

    return this.startingPromise;
  }
}

// ── Factory ────────────────────────────────────────────────────────────────

export async function createCrossEncoder(
  config: CrossEncoderConfig,
): Promise<CrossEncoder> {
  const encoder = new CrossEncoderImpl(config);
  return encoder;
}
