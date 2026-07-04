/**
 * embed-test-provider.ts — TEST-ONLY deterministic embedding provider.
 *
 * Implements EmbeddingProvider via feature hashing:
 *   1. Tokenize text on non-word chars (case-fold, filter empties).
 *   2. For each token hash it into a dimension bucket [0, DIM) using djb2,
 *      and also derive a sign from a second hash pass.
 *   3. Accumulate signed weights into a float vector (each token increments
 *      its bucket by +1 or -1, proportional to shared-token overlap).
 *   4. L2-normalise the result.
 *
 * Semantic guarantee:
 *   - SHARED TOKENS → HIGH cosine (token overlap drives the dot product up).
 *   - DISJOINT TOKENS → LOW cosine (orthogonal buckets, near-zero dot product).
 *
 * This is the property relied on by near-dup / clustering / recall tests.
 *
 * NOT for production — no ONNX, no I/O, no warmup delay.
 */

import type { EmbeddingProvider, EmbeddingHealth, EmbeddingProviderMetadata, EmbedRole } from '@adhd/sox-embedding-provider';

const EMBED_DIMENSIONS = 768;
const MODEL_ID = 'test-feature-hash-768';

/** djb2 hash — unsigned 32-bit */
function djb2(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    // keep unsigned 32-bit
    h = h >>> 0;
  }
  return h;
}

/**
 * Tokenise text into lowercase non-empty tokens split on non-word characters.
 */
function tokenise(text: string): string[] {
  return text.toLowerCase().split(/\W+/).filter((t) => t.length > 0);
}

/**
 * Embed a single text into a 768-dim L2-normalised Float32Array via feature hashing.
 */
export function featureHashEmbed(text: string, dim: number = EMBED_DIMENSIONS): Float32Array {
  const vec = new Float32Array(dim);
  const tokens = tokenise(text);

  for (const token of tokens) {
    const bucket = djb2(token) % dim;
    // Sign: second hash pass on token + a salt
    const signHash = djb2(token + '\x00sign');
    const sign = signHash % 2 === 0 ? 1 : -1;
    vec[bucket] = (vec[bucket] as number) + sign;
  }

  // L2 normalise
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    norm += (vec[i] as number) * (vec[i] as number);
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      vec[i] = (vec[i] as number) / norm;
    }
  }

  return vec;
}

/**
 * Deterministic test provider implementing EmbeddingProvider.
 * Fast, no I/O, no ONNX, reproducible across runs and processes.
 */
export class DeterministicTestProvider implements EmbeddingProvider {
  readonly metadata: EmbeddingProviderMetadata = {
    modelId: MODEL_ID,
    dimensions: EMBED_DIMENSIONS,
    maxTokens: 512,
    isRemote: false,
    isDeterministic: true,
  };

  async embedSingle(text: string, _role?: EmbedRole): Promise<Float32Array> {
    return featureHashEmbed(text, EMBED_DIMENSIONS);
  }

  async *embedBatch(
    texts: string[],
    _opts?: { role?: EmbedRole; batchSize?: number },
  ): AsyncIterable<Float32Array> {
    for (const text of texts) {
      yield featureHashEmbed(text, EMBED_DIMENSIONS);
    }
  }

  async warmUp(_texts: string[]): Promise<void> {
    // no-op — deterministic provider is always warm
  }

  health(): EmbeddingHealth {
    return {
      configured: `feature-hash:${MODEL_ID}`,
      active: MODEL_ID,
      state: 'real',
      dimensions: EMBED_DIMENSIONS,
      last_error: null,
    };
  }
}
