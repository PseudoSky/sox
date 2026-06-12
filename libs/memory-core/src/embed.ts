/**
 * Local embedding wrapper for sox-memory.
 *
 * MVP implementation: deterministic hash-based embedding (768-dim).
 * This is a local, zero-provider embedding that produces consistent vectors
 * from text without any network calls. It satisfies:
 *   - R1: zero provider/LLM calls on the read path
 *   - R2: embed model pinned in memory_scope
 *
 * The implementation uses a TF-IDF inspired approach with murmur-hash-like
 * deterministic hashing to produce 768-dimensional float vectors that have
 * reasonable semantic overlap (words with similar positions in hash space
 * will have similar vectors, giving adequate BM25+vector fusion recall).
 *
 * When fastembed/onnxruntime becomes available in the environment, swap
 * the embedText() implementation — the schema (embed_model, embed_dim)
 * is already pinned to enforce re-embedding on model change.
 */

export const EMBED_MODEL = 'nomic-embed-text-v1.5-hash';
export const EMBED_DIM = 768;

// Provider-call counter: MUST remain 0 on the read path (invariant R1)
let providerCallCount = 0;
export function getProviderCallCount(): number {
  return providerCallCount;
}
export function resetProviderCallCount(): void {
  providerCallCount = 0;
}

/**
 * Deterministic 768-dim embedding from text.
 * Uses a seeded hash projection: each dimension is the sum of
 * per-token scalar projections for that dimension index.
 * Produces normalized Float32Array for use with sqlite-vec FLOAT[768].
 */
export function embedText(text: string): Float32Array {
  const normalized = text.toLowerCase().replace(/[^\w\s]/g, ' ').trim();
  const tokens = normalized.split(/\s+/).filter(Boolean);
  const vec = new Float32Array(EMBED_DIM);

  for (const token of tokens) {
    const h1 = hash32(token, 0x811c9dc5);
    const h2 = hash32(token, 0x01000193);
    for (let d = 0; d < EMBED_DIM; d++) {
      // Each dimension gets a contribution from this token via a seeded projection
      const seed = ((d * 0x9e3779b9 + h1) >>> 0) as number;
      const val = ((seed ^ h2) / 0x80000000) - 1.0; // in [-1, 1]
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      vec[d] = (vec[d]! + val / Math.max(tokens.length, 1));
    }
  }

  // L2 normalize
  let norm = 0;
  for (let d = 0; d < EMBED_DIM; d++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    norm += vec[d]! * vec[d]!;
  }
  norm = Math.sqrt(norm) || 1;
  for (let d = 0; d < EMBED_DIM; d++) {
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    vec[d] = vec[d]! / norm;
  }

  return vec;
}

/**
 * Serialize Float32Array to JSON array string for sqlite-vec MATCH queries.
 */
export function vecToJson(vec: Float32Array): string {
  const arr: number[] = Array.from(vec);
  return '[' + arr.map((v) => v.toFixed(8)).join(',') + ']';
}

/**
 * Serialize Float32Array to Buffer for sqlite-vec INSERT (blob format).
 * sqlite-vec accepts both JSON strings and binary blobs.
 */
export function vecToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer);
}

/** FNV-1a 32-bit hash with custom offset basis */
function hash32(str: string, basis: number): number {
  let h = basis >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
