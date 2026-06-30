import type { Claim, SourceRef, SingleSourceResult } from './types.js';

/**
 * Compute cosine similarity between two Float32Array vectors.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]!;
    const bi = b[i]!;
    dot += ai * bi;
    normA += ai * ai;
    normB += bi * bi;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface PreFilterOptions {
  threshold: number;
  embedClaim(text: string): Promise<Float32Array>;
  embedSource(text: string): Promise<Float32Array>;
}

/**
 * Run the embedding-based pre-filter gate.
 *
 * Returns a SingleSourceResult with preFilterSkipped=true if the cosine
 * similarity falls below the threshold. Returns undefined if the score
 * meets or exceeds the threshold (NLI should run).
 */
export async function runPreFilter(
  _claim: Claim,
  source: SourceRef,
  claimText: string,
  sourceText: string,
  options: PreFilterOptions,
): Promise<SingleSourceResult | undefined> {
  const start = Date.now();

  try {
    const [claimEmb, sourceEmb] = await Promise.all([
      options.embedClaim(claimText),
      options.embedSource(sourceText),
    ]);

    const score = cosineSimilarity(claimEmb, sourceEmb);

    if (score < options.threshold) {
      return {
        sourceId: source.id,
        entailment: 'unverifiable',
        confidence: 0,
        preFilterSkipped: true,
        preFilterScore: score,
        timingMs: Date.now() - start,
      };
    }

    // Score meets threshold — NLI should proceed
    return undefined;
  } catch (err) {
    console.warn('[claim-verifier] pre-filter failed, falling through to NLI:', err);
    return undefined;
  }
}
