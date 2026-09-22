/**
 * errors.ts — the embedding error taxonomy, extracted so internal modules
 * (notably `funnelClient.ts`) can throw typed errors without importing the
 * public `index.ts` barrel and creating an import cycle.
 *
 * The classes are re-exported verbatim from `index.ts`, so the public surface is
 * unchanged: `import { TransientEmbeddingError } from '@adhd/sox-embedding-provider'`
 * keeps working, and `instanceof` identity is preserved (one class, one home).
 *
 * Three tiers, no silent degradation:
 *   - TransientEmbeddingError — the caller may retry (has `retryAfterMs`).
 *   - PermanentEmbeddingError — the caller must not retry.
 *   - ResolutionError — factory-time only (bad config / unknown model), never mid-call.
 */

export class TransientEmbeddingError extends Error {
  readonly retryAfterMs: number | undefined;
  constructor(message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'TransientEmbeddingError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class PermanentEmbeddingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentEmbeddingError';
  }
}

export class ResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResolutionError';
  }
}
