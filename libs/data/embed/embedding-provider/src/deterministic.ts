import { createHash } from 'node:crypto';
import type { EmbeddingHealth, EmbeddingProvider, EmbeddingProviderMetadata, EmbedRole } from './index.js';
import { EmbeddingCache } from './cache.js';

function createRng(seed: bigint): () => number {
  let s0 = seed & 0xffffffffffffffffn;
  let s1 = (seed >> 64n) & 0xffffffffffffffffn;
  if (s0 === 0n && s1 === 0n) {
    s0 = 1n;
  }
  return () => {
    let x = s0;
    const y = s1;
    s0 = y;
    x ^= x << 23n;
    const shifted = x >> 17n;
    const shiftedY = y >> 26n;
    x ^= shifted;
    x ^= y;
    x ^= shiftedY;
    s1 = x & 0xffffffffffffffffn;
    const result = (s0 + s1) & 0xffffffffffffffffn;
    return Number(result & 0x1fffffffffffffn) / Number(0x1fffffffffffffn);
  };
}

function hashText(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * First-class deterministic embedding provider.
 *
 * Selected only by explicit config (`type: 'hash'`), never as an implicit fallback.
 * Carries the BL-86 degeneracy fix: two unrelated strings produce cosine < 0.5.
 */
export class DeterministicProvider implements EmbeddingProvider {
  readonly metadata: EmbeddingProviderMetadata;
  private cache: EmbeddingCache;

  constructor(modelId: string, dimensions: number, maxTokens = Number.MAX_SAFE_INTEGER) {
    this.metadata = {
      modelId,
      dimensions,
      maxTokens,
      isRemote: false,
      isDeterministic: true,
      providerUri: `local:hash-${dimensions}d`,
    };
    this.cache = new EmbeddingCache();
  }

  async embedSingle(text: string, _role?: EmbedRole): Promise<Float32Array> {
    const cached = this.cache.get(text);
    if (cached) return cached;
    const vec = this.computeEmbed(text);
    this.cache.set(text, vec);
    return vec;
  }

  async *embedBatch(
    texts: string[],
    _opts?: { role?: EmbedRole; batchSize?: number },
  ): AsyncIterable<Float32Array> {
    for (const text of texts) {
      yield await this.embedSingle(text);
    }
  }

  health(): EmbeddingHealth {
    return {
      configured: `hash:${this.metadata.modelId}`,
      active: this.metadata.modelId,
      state: 'hash-fallback',
      dimensions: this.metadata.dimensions,
      last_error: null,
    };
  }

  async warmUp(texts: string[]): Promise<void> {
    for (const text of texts) {
      await this.embedSingle(text);
    }
  }

  private computeEmbed(text: string): Float32Array {
    const hash = hashText(text);
    const seed = BigInt('0x' + hash.slice(0, 16));
    const rng = createRng(seed);
    const dim = this.metadata.dimensions;
    const vec = new Float32Array(dim);

    for (let d = 0; d < dim; d++) {
      const u1 = rng();
      const u2 = rng();
      const mag = Math.sqrt(-2 * Math.log(u1 || 1e-10));
      const theta = 2 * Math.PI * u2;
      vec[d] = mag * Math.cos(theta);
    }

    let norm = 0;
    for (let d = 0; d < dim; d++) {
      norm += vec[d]! * vec[d]!;
    }
    norm = Math.sqrt(norm) || 1;
    for (let d = 0; d < dim; d++) {
      vec[d] = vec[d]! / norm;
    }

    return vec;
  }
}
