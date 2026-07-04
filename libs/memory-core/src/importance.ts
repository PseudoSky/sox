/**
 * importance.ts — write-time importance computation (E7, E14).
 * Delegates structural score to @adhd/sox-analysis.scoreImportance (BL-149b).
 *
 * Uses GraphBackend for degree queries on the batch importance update pass;
 * write-time (enrichOnWrite) is pure computation with zero backend calls since
 * no edges exist yet for the new node.
 */

import { scoreImportance } from '@adhd/sox-analysis';

export interface ImportanceWeights {
  length: number;
  link: number;
  access: number;
  tag: number;
}

const DEFAULT_WEIGHTS: ImportanceWeights = {
  length: 1.0,
  link: 1.0,
  access: 1.0,
  tag: 1.0,
};

export interface ImportanceInputs {
  word_count: number;
  link_degree: number;
  access_count: number;
  tag_count: number;
}

export function computeImportance(
  inputs: ImportanceInputs,
  weights?: Partial<ImportanceWeights>,
): number {
  const w: ImportanceWeights = { ...DEFAULT_WEIGHTS, ...weights };

  const lengthScore = Math.min(inputs.word_count / 50, 1.0) * 4.0;
  const accessScore = Math.min(inputs.access_count / 10, 1.0) * 2.0;

  const inDegree = Math.ceil(inputs.link_degree / 2);
  const outDegree = Math.floor(inputs.link_degree / 2);

  const structuralScore = scoreImportance({
    inDegree,
    outDegree,
    recencyMs: 0,
    nearDupCount: inputs.tag_count,
  });

  const structuralAboveFloor = Math.max(0, structuralScore - 6.0);

  const raw =
    lengthScore * w.length +
    accessScore * w.access +
    structuralAboveFloor * ((w.link + w.tag) / 2);

  return Math.max(1.0, Math.min(10.0, raw));
}
