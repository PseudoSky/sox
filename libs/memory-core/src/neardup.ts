/**
 * neardup.ts — near-duplicate detection (E8).
 * Uses VectorBackend-compatible vec_node KNN for similarity search and
 * GraphBackend for node metadata lookup.
 *
 * KNN stays on vec_node (memory-core private vec0 table) rather than
 * VectorBackend's own vec* tables — the write path inserts into vec_node,
 * so we query it directly for vector search. GraphBackend handles node CRUD.
 */

import type { Database } from 'better-sqlite3';
import { createGraphBackend } from '@adhd/sox-graph-store';
import { detectNearDupPairs } from '@adhd/sox-analysis';
import type { NearDupOpts } from '@adhd/sox-analysis';

export interface NearDupResult {
  existing_uid: string;
  cosine_sim: number;
  should_invalidate: boolean;
}

interface VecRow {
  node_id: number;
  embedding: Buffer;
}

function blobToFloat32(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export function detectNearDup(
  db: Database,
  rowid: number,
  embedding: Float32Array,
  threshold: number,
): NearDupResult | null {
  // Create GraphBackend instance for node/edge CRUD (pattern: sibling read-path modules)
  const graph = createGraphBackend(db);

  // ── KNN via vec_node (memory-core specific vec0 table) ─────────────────
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

  const vecs: Array<{ id: number; vec: Float32Array }> = [
    { id: rowid, vec: embedding },
    ...knnRows.map((r) => ({ id: r.node_id, vec: blobToFloat32(r.embedding) })),
  ];

  const nearDupOpts: NearDupOpts = {
    nearDupThreshold: threshold,
    distinctThreshold: 0.70,
  };
  const pairs = detectNearDupPairs(vecs, nearDupOpts);

  let bestPair: { a: number; b: number; cosine: number } | null = null;
  for (const p of pairs) {
    if ((p.a === rowid || p.b === rowid) && p.status === 'near_dup') {
      if (!bestPair || p.cosine > bestPair.cosine) {
        bestPair = { a: p.a, b: p.b, cosine: p.cosine };
      }
    }
  }

  if (!bestPair) return null;

  const neighborId = bestPair.a === rowid ? bestPair.b : bestPair.a;

  // Check node existence + get content via GraphBackend; uid via raw SQL
  // (NodeRecord does not expose uid, which is memory-core-specific)
  const neighborNodeRecord = graph.getNode(neighborId);
  if (!neighborNodeRecord) return null;

  const neighborUidRow = db
    .prepare<[number], { uid: string }>(`SELECT uid FROM node WHERE rowid = ?`)
    .get(neighborId);
  if (!neighborUidRow) return null;

  return {
    existing_uid: neighborUidRow.uid,
    cosine_sim: bestPair.cosine,
    should_invalidate: bestPair.cosine >= threshold,
  };
}
