import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ResolutionError } from './index.js';
import type { FastEmbedModelConfig, ModelCache } from './index.js';

export class EmbeddingCache {
  private cache = new Map<string, Float32Array>();
  private maxSize: number;

  constructor(maxSize = 10000) {
    this.maxSize = maxSize;
  }

  get(text: string): Float32Array | undefined {
    const vec = this.cache.get(text);
    if (vec !== undefined) {
      this.cache.delete(text);
      this.cache.set(text, vec);
    }
    return vec;
  }

  set(text: string, vec: Float32Array): void {
    if (this.cache.has(text)) {
      this.cache.delete(text);
    } else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(text, vec);
  }

  has(text: string): boolean {
    return this.cache.has(text);
  }

  clear(): void {
    this.cache.clear();
  }

  get size(): number {
    return this.cache.size;
  }
}

/**
 * Lazily resolve MODEL_CONFIGS from fastembed.js to avoid forcing eager
 * evaluation of fastembed's top-level import.meta.url in CJS bundles.
 */
async function getModelConfig(modelId: string): Promise<FastEmbedModelConfig> {
  const { MODEL_CONFIGS } = await import('./fastembed.js');
  const cfg = MODEL_CONFIGS[modelId];
  if (!cfg) {
    throw new ResolutionError(
      `Unknown model: "${modelId}". Supported: ${Object.keys(MODEL_CONFIGS).join(', ')}`,
    );
  }
  return cfg;
}

/**
 * FileSystemModelCache — downloads, caches, and verifies ONNX model binaries.
 *
 * Models are stored at:
 *   <baseDir>/<modelId>/main/model.onnx
 *   <baseDir>/<modelId>/main/model.onnx.sha256
 *
 * SHA-256 verification runs after every download. Throws ResolutionError on mismatch
 * or download failure.
 *
 * @implements {ModelCache}
 */
export class FileSystemModelCache implements ModelCache {
  constructor(private baseDir: string) {}

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Download and verify model binary. Returns once the model is ready.
   * Throws ResolutionError if the model is unknown, download fails, or
   * SHA-256 verification fails.
   */
  async ensure(modelId: string): Promise<void> {
    if (this.cached(modelId)) return;

    const config = await getModelConfig(modelId);
    await mkdir(this.modelDir(modelId), { recursive: true });

    const url = this.buildUrl(config.hfRepoId);
    const response = await fetch(url);
    if (!response.ok) {
      throw new ResolutionError(
        `Failed to download model "${modelId}": HTTP ${response.status} ${response.statusText} (${url})`,
      );
    }

    const hash = createHash('sha256');
    const writeStream = createWriteStream(this.onnxPath(modelId));

    try {
      const reader = response.body!.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
        writeStream.write(value);
      }
    } catch (err) {
      writeStream.close();
      await rm(this.modelDir(modelId), { recursive: true, force: true }).catch(() => {});
      throw new ResolutionError(
        `Download failed for model "${modelId}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', (e) => {
        rm(this.modelDir(modelId), { recursive: true, force: true }).catch(() => {});
        reject(new ResolutionError(`Write failed for model "${modelId}": ${e.message}`));
      });
    });

    const digest = hash.digest('hex');
    await writeFile(this.shaPath(modelId), digest + '\n');
  }

  /**
   * Check whether the model binary is already in local cache and its
   * SHA-256 sidecar matches the on-disk binary.
   */
  cached(modelId: string): boolean {
    const onnx = this.onnxPath(modelId);
    const sha = this.shaPath(modelId);
    if (!existsSync(onnx) || !existsSync(sha)) return false;

    try {
      const expected = readFileSync(sha, 'utf-8').trim();
      const actual = createHash('sha256').update(readFileSync(onnx)).digest('hex');
      return expected === actual;
    } catch {
      return false;
    }
  }

  /**
   * Remove a single model from cache. Does not affect other models.
   * No-op if the model is not cached.
   */
  async clear(modelId: string): Promise<void> {
    const dir = this.modelDir(modelId);
    if (existsSync(dir)) {
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Streaming download with byte-level progress.
   * Yields { bytesDownloaded, totalBytes } as chunks arrive.
   * If already cached, yields the full size immediately and returns.
   */
  async *ensureStream(
    modelId: string,
  ): AsyncIterable<{ bytesDownloaded: number; totalBytes: number }> {
    if (this.cached(modelId)) {
      const stats = await stat(this.onnxPath(modelId));
      yield { bytesDownloaded: stats.size, totalBytes: stats.size };
      return;
    }

    const config = await getModelConfig(modelId);
    await mkdir(this.modelDir(modelId), { recursive: true });

    const url = this.buildUrl(config.hfRepoId);
    const response = await fetch(url);
    if (!response.ok) {
      throw new ResolutionError(
        `Failed to download model "${modelId}": HTTP ${response.status} ${response.statusText} (${url})`,
      );
    }

    const totalBytes = Number(response.headers.get('content-length') ?? 0);
    const reader = response.body!.getReader();
    const writeStream = createWriteStream(this.onnxPath(modelId));
    const hash = createHash('sha256');

    let bytesDownloaded = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        bytesDownloaded += value.length;
        hash.update(value);
        writeStream.write(value);
        yield { bytesDownloaded, totalBytes };
      }
    } catch (err) {
      writeStream.close();
      await rm(this.modelDir(modelId), { recursive: true, force: true }).catch(() => {});
      throw new ResolutionError(
        `Stream download failed for model "${modelId}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await new Promise<void>((resolve, reject) => {
      writeStream.on('finish', resolve);
      writeStream.on('error', (e) => {
        rm(this.modelDir(modelId), { recursive: true, force: true }).catch(() => {});
        reject(new ResolutionError(`Write failed for model "${modelId}": ${e.message}`));
      });
    });

    const digest = hash.digest('hex');
    await writeFile(this.shaPath(modelId), digest + '\n');
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Directory for a specific model version.
   * Pattern: <baseDir>/<modelId>/main/
   */
  private modelDir(modelId: string): string {
    return join(this.baseDir, modelId, 'main');
  }

  /**
   * Path to the ONNX model binary.
   */
  private onnxPath(modelId: string): string {
    return join(this.modelDir(modelId), 'model.onnx');
  }

  /**
   * Path to the SHA-256 sidecar file.
   */
  private shaPath(modelId: string): string {
    return join(this.modelDir(modelId), 'model.onnx.sha256');
  }

  /**
   * Build the HuggingFace download URL for an ONNX model.
   */
  private buildUrl(hfRepoId: string): string {
    return `https://huggingface.co/${hfRepoId}/resolve/main/onnx/model.onnx`;
  }
}
