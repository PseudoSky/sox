/**
 * importance.ts — deterministic importance scoring (E7).
 * CONTRACTS.md C1.5, DESIGN.md D2 E7.
 *
 * Determinism: same inputs → same output. Pure function, no DB, no I/O.
 */

/** Configurable blend weights for the importance formula. */
export interface ImportanceWeights {
  /** Weight on length_score (default 1.0). */
  length: number;
  /** Weight on link_score (default 1.0). */
  link: number;
  /** Weight on access_score (default 1.0). */
  access: number;
  /** Weight on tag_score (default 1.0). */
  tag: number;
}

const DEFAULT_WEIGHTS: ImportanceWeights = {
  length: 1.0,
  link: 1.0,
  access: 1.0,
  tag: 1.0,
};

export interface ImportanceInputs {
  /** Content word count. */
  word_count: number;
  /** In-degree + out-degree edge count (0 at write time; updated on batch). */
  link_degree: number;
  /** Cumulative recall access count. */
  access_count: number;
  /** Number of user-asserted tags. */
  tag_count: number;
}

/**
 * Compute a deterministic importance score in [1.0, 10.0] (E7).
 *
 * Formula:
 *   length_score  = min(word_count / 50, 1.0) × 4.0
 *   link_score    = min(link_degree / 5, 1.0) × 3.0
 *   access_score  = min(access_count / 10, 1.0) × 2.0
 *   tag_score     = min(tag_count / 3, 1.0) × 1.0
 *   raw           = α·length_score + β·link_score + γ·access_score + δ·tag_score
 *   importance    = clamp(raw, 1.0, 10.0)
 *
 * α=β=γ=δ=1.0 unless overridden by weights param.
 */
export function computeImportance(
  inputs: ImportanceInputs,
  weights?: Partial<ImportanceWeights>,
): number {
  const w: ImportanceWeights = { ...DEFAULT_WEIGHTS, ...weights };

  const lengthScore = Math.min(inputs.word_count / 50, 1.0) * 4.0;
  const linkScore   = Math.min(inputs.link_degree / 5, 1.0) * 3.0;
  const accessScore = Math.min(inputs.access_count / 10, 1.0) * 2.0;
  const tagScore    = Math.min(inputs.tag_count / 3, 1.0) * 1.0;

  const raw =
    w.length * lengthScore +
    w.link   * linkScore   +
    w.access * accessScore +
    w.tag    * tagScore;

  return Math.max(1.0, Math.min(10.0, raw));
}
