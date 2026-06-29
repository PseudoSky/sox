import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { EmbeddingProvider, EmbeddingProviderMetadata, EmbedRole } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

interface WorkerRequest {
  id: number;
  type: 'init';
  model: string;
  cacheDir: string;
}

interface EmbedWorkerRequest {
  id: number;
  type: 'embed';
  text: string;
}

interface EmbedBatchWorkerRequest {
  id: number;
  type: 'embedBatch';
  texts: string[];
}

interface InitOkResponse {
  id: number;
  initOk: true;
  dim: number;
}

interface EmbedResponse {
  id: number;
  embedding: number[];
}

interface EmbedBatchResponse {
  id: number;
  embeddings: number[][];
}

interface ErrorResponse {
  id: number;
  error: string;
}

type WorkerMessage = InitOkResponse | EmbedResponse | EmbedBatchResponse | ErrorResponse;

const MODEL_DIMS: Record<string, number> = {
  'bge-small-en-v1.5': 384,
  'bge-base-en-v1.5': 768,
  'multilingual-e5-large': 1024,
};

const DEFAULT_MODEL = 'bge-base-en-v1.5';
const DEFAULT_BATCH_SIZE = 256;

function warmupTimeoutMs(): number {
  const raw = Number(process.env['SOX_EMBED_WARMUP_TIMEOUT_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/**
 * Real ONNX embedding provider using fastembed-js.
 *
 * Runs inference in a worker thread (BL-11 boundary) — onnxruntime-node
 * never runs on the main thread alongside better-sqlite3 + sqlite-vec.
 */
export class FastembedProvider implements EmbeddingProvider {
  readonly metadata: EmbeddingProviderMetadata;
  private model: string;
  private cacheDir: string;
  private worker: Worker | null = null;
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: number[] | number[][] | { dim: number }) => void; reject: (e: Error) => void }
  >();
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private embedDim = 0;

  constructor(model: string, dimensions: number, cacheDir: string) {
    this.model = model;
    this.cacheDir = cacheDir;
    this.embedDim = dimensions;
    this.metadata = {
      modelId: model,
      dimensions,
      isRemote: false,
      isDeterministic: false,
      providerUri: `local:onnx:${model}`,
    };
  }

  async embedSingle(text: string, _role?: EmbedRole): Promise<Float32Array> {
    const worker = this.getWorker();
    await this.ensureReady();

    return new Promise<Float32Array>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: (v: number[] | number[][] | { dim: number }) => {
          const vec = v as number[];
          resolve(this.toFloat32Normalised(vec));
        },
        reject,
      });
      worker.postMessage({ id, type: 'embed', text } satisfies EmbedWorkerRequest);
    });
  }

  async *embedBatch(
    texts: string[],
    opts?: { role?: EmbedRole; batchSize?: number },
  ): AsyncIterable<Float32Array> {
    void opts?.role;
    const worker = this.getWorker();
    await this.ensureReady();

    const batchSize = opts?.batchSize ?? DEFAULT_BATCH_SIZE;
    for (let i = 0; i < texts.length; i += batchSize) {
      const chunk = texts.slice(i, i + batchSize);
      const embeddings = await this.sendBatch(worker, chunk);
      for (const vec of embeddings) {
        yield this.toFloat32Normalised(vec);
      }
    }
  }

  async warmUp(texts: string[]): Promise<void> {
    // No-op: isDeterministic is false, cache would be unreliable.
    // Pre-warm the model by embedding the texts, priming ONNX inference.
    void texts;
  }

  private getWorker(): Worker {
    if (this.worker) return this.worker;

    const workerPath = join(__dirname, 'embedWorker.js');
    this.worker = new Worker(workerPath, {
      workerData: { cacheDir: this.cacheDir },
    });
    this.worker.unref();

    this.worker.on('message', (msg: WorkerMessage) => {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if ('error' in msg) {
        pending.reject(new Error(msg.error));
      } else if ('initOk' in msg) {
        this.embedDim = msg.dim;
        pending.resolve({ dim: msg.dim });
      } else if ('embedding' in msg) {
        pending.resolve(msg.embedding);
      } else if ('embeddings' in msg) {
        pending.resolve(msg.embeddings);
      }
    });

    this.worker.on('error', (err) => {
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
      this.worker = null;
      this.ready = false;
      this.readyPromise = null;
    });

    this.worker.on('exit', (code) => {
      if (code !== 0) {
        const err = new Error(`embedWorker exited with code ${code}`);
        for (const { reject } of this.pending.values()) reject(err);
        this.pending.clear();
      }
      this.worker = null;
      this.ready = false;
      this.readyPromise = null;
    });

    this.readyPromise = new Promise<void>((resolve, reject) => {
      const id = this.nextId++;
      const to = setTimeout(() => {
        this.pending.delete(id);
        const err = new Error(
          `Fastembed worker init timed out after ${warmupTimeoutMs()}ms`,
        );
        reject(err);
      }, warmupTimeoutMs());
      if (typeof to.unref === 'function') to.unref();

      this.pending.set(id, {
        resolve: (v: number[] | number[][] | { dim: number }) => {
          clearTimeout(to);
          const dimResult = v as { dim: number };
          if (dimResult.dim > 0) {
            this.embedDim = dimResult.dim;
          }
          this.ready = true;
          resolve();
        },
        reject: (e: Error) => {
          clearTimeout(to);
          reject(e);
        },
      });

      this.worker!.postMessage({
        id,
        type: 'init',
        model: this.model,
        cacheDir: this.cacheDir,
      } satisfies WorkerRequest);
    });

    return this.worker;
  }

  private async ensureReady(): Promise<void> {
    if (this.ready) return;
    if (this.readyPromise) {
      await this.readyPromise;
    }
  }

  private sendBatch(worker: Worker, texts: string[]): Promise<number[][]> {
    return new Promise<number[][]>((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, {
        resolve: (v: number[] | number[][] | { dim: number }) => resolve(v as number[][]),
        reject,
      });
      worker.postMessage({
        id,
        type: 'embedBatch',
        texts,
      } satisfies EmbedBatchWorkerRequest);
    });
  }

  private toFloat32Normalised(raw: number[]): Float32Array {
    const dim = this.embedDim || raw.length;
    const vec = new Float32Array(dim);
    let norm = 0;
    for (let i = 0; i < dim && i < raw.length; i++) {
      vec[i] = raw[i] ?? 0;
      norm += vec[i]! * vec[i]!;
    }
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) {
      vec[i] = vec[i]! / norm;
    }
    return vec;
  }
}

export { MODEL_DIMS, DEFAULT_MODEL, DEFAULT_BATCH_SIZE };
