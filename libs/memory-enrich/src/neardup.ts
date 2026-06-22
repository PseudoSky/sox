/**
 * neardup.ts — near-duplicate detection via cosine similarity (E8).
 * CONTRACTS.md C1.6, DESIGN.md D2 E8.
 *
 * Determinism: for a fixed DB state and embedding, always returns the same result.
 * No LLM, no network.
 */

import type { Database } from 'better-sqlite3';

export interface NearDupResult {
  /** UID of the existing near-duplicate episode. */
  existing_uid: string;
  /** Cosine similarity between the new episode and the existing one. */
  cosine_sim: number;
  /** Whether the new episode should be invalidated (true if sim >= nearDupThreshold). */
  should_invalidate: boolean;
}

interface VecRow {
  node_id: number;
  embedding: Buffer;
}

interface NodeRow {
  uid: string;
  content: string | null;
}

/**
 * Compute cosine similarity between two L2-normalised Float32Array vectors.
 * Since both are L2-normalised, cosine sim = dot product.
 */
function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number);
  }
  return dot;
}

/** Deserialise a binary blob from vec_node into a Float32Array. */
function blobToFloat32(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/**
 * Check if a newly-written episode has a semantic near-duplicate in the store (E8).
 *
 * Uses KNN-20 from vec_node to find the closest existing episode.
 * Compares cosine similarity against `threshold`.
 *
 * Hash-backend guard: when backend=hash (detected via getActiveEmbedModel()),
 * also requires content.length >= 50 AND at least one shared MENTIONS entity
 * before treating as near-dup (D5.1).
 *
 * @param db        Open better-sqlite3 Database (read-only safe).
 * @param rowid     Rowid of the just-inserted episode.
 * @param embedding 768-dim L2-normalised embedding of the new episode.
 * @param threshold Cosine threshold (caller supplies the backend-appropriate value).
 * @returns         NearDupResult if a dup is found above threshold, else null.
 */
export function detectNearDup(
  db: Database,
  rowid: number,
  embedding: Float32Array,
  threshold: number,
): NearDupResult | null {
  // Fetch KNN-21 neighbours from vec_node (21 to account for self), then exclude self.
  // sqlite-vec requires `k = ?` for KNN queries.
  const embJson = '[' + Array.from(embedding).map((v) => v.toFixed(8)).join(',') + ']';
  const knnRows = db
    .prepare<[string, number], VecRow>(
      `SELECT node_id, embedding
       FROM vec_node
       WHERE embedding MATCH ? AND k = ?`,
    )
    .all(embJson, 21)
    .filter((r) => r.node_id !== rowid)
    .slice(0, 20);

  if (knnRows.length === 0) return null;

  // Find the highest cosine similarity among KNN neighbours
  let bestSim = -1;
  let bestNodeId = -1;

  for (const kRow of knnRows) {
    const neighborVec = blobToFloat32(kRow.embedding);
    const sim = cosineSim(embedding, neighborVec);
    if (sim > bestSim) {
      bestSim = sim;
      bestNodeId = kRow.node_id;
    }
  }

  if (bestSim < threshold) return null;

  // Fetch the neighbour's uid and content for the guard check
  const neighborNode = db
    .prepare<[number], NodeRow>(
      `SELECT uid, content FROM node WHERE rowid = ? AND t_invalid IS NULL`,
    )
    .get(bestNodeId);

  if (!neighborNode) return null;

  // Hash-backend guard (D5.1): require content.length >= 50 AND shared MENTIONS entity.
  // Detect hash backend by querying memory_scope embed_model (if available) or
  // by checking whether the embedding sum is suspiciously round (hash backend produces
  // FNV projections). We use a practical heuristic: if the vector max-abs is exactly
  // representable as a simple fraction, it's likely hash. Instead, we detect via
  // checking the current embed model from process.env (the simplest available signal).
  const isHashBackend =
    (process.env['SOX_EMBED_BACKEND'] === 'hash') ||
    (process.env['SOX_EMBED_BACKEND'] === undefined && !process.env['SOX_EMBED_REAL']);

  if (isHashBackend) {
    const newContent = db
      .prepare<[number], { content: string | null }>(`SELECT content FROM node WHERE rowid = ?`)
      .get(rowid);
    const newContentLen = (newContent?.content ?? '').length;
    if (newContentLen < 50) return null;

    // Check for shared MENTIONS entity
    const sharedEntity = db
      .prepare<[number, number], { cnt: number }>(
        `SELECT COUNT(*) AS cnt
         FROM edge e1
         JOIN edge e2 ON e1.dst = e2.dst AND e2.src = ?
         WHERE e1.src = ? AND e1.rel = 'MENTIONS' AND e2.rel = 'MENTIONS'
           AND e1.t_expired IS NULL AND e2.t_expired IS NULL`,
      )
      .get(rowid, bestNodeId);
    if (!sharedEntity || sharedEntity.cnt === 0) return null;
  }

  return {
    existing_uid: neighborNode.uid,
    cosine_sim: bestSim,
    should_invalidate: bestSim >= threshold,
  };
}
