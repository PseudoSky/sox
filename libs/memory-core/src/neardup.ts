/**
 * neardup.ts — near-duplicate detection (E8).
 * Uses the adapter's VectorDialect for KNN over the `vec_node` table and
 * plain portable SQL for node metadata lookup.
 *
 * KNN stays on vec_node (memory-core's own vector table) rather than
 * VectorBackend's own vec* tables — the write path inserts into vec_node,
 * so we query it directly for vector search.
 *
 * BL-381: this used to issue `WHERE embedding MATCH ? AND k = ?` — sqlite-vec
 * `vec0` KNN syntax — directly. Turso's `vec_node` is an ordinary table with an
 * `F32_BLOB` column and has neither a `MATCH` operator nor a `k` pseudo-column,
 * so the statement failed at prepare with `no such column: k` on the default
 * backend. Both call sites caught the throw and continued, so near-dup
 * detection was silently non-functional while every surface reported healthy.
 * The dialect is now a REQUIRED parameter precisely so that a call site which
 * forgets to supply it is a compile error rather than a wrong-backend query —
 * three memory-server call sites had dropped the old optional flag.
 */

import { detectNearDupPairs } from '@adhd/sox-analysis';
import type { NearDupOpts } from '@adhd/sox-analysis';
import type { AdapterTransaction, VectorDialect } from '@adhd/sox-store-adapter';

export interface NearDupResult {
  existing_uid: string;
  cosine_sim: number;
  should_invalidate: boolean;
}

interface VecRow {
  node_id: number;
  embedding: Buffer;
}

/** Candidate neighbours fetched per KNN pass (self is filtered out afterwards). */
const KNN_FETCH = 21;
/** Neighbours actually scored, after dropping self. */
const KNN_SCORE = 20;

function blobToFloat32(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

export async function detectNearDup(
  tx: AdapterTransaction,
  rowid: number,
  embedding: Float32Array,
  threshold: number,
  vectorDialect: VectorDialect,
): Promise<NearDupResult | null> {
  // ── KNN via the dialect ───────────────────────────────────────────────────
  // topKQuery emits `__PLACEHOLDER__` where a caller-supplied filter goes (see
  // recall.ts). Near-dup has no filter of its own — validity is checked below
  // against the winning neighbour — so it collapses to a true predicate. The
  // trailing LIMIT is required for the Turso dialect, whose ORDER BY is not
  // self-limiting the way vec0's `k =` is; it is harmless on sqlite-vec.
  const { sql: dialectSql, args: dialectArgs } = vectorDialect.topKQuery(
    'vec_node',
    'embedding',
    Array.from(embedding),
    KNN_FETCH,
    'cosine',
  );
  const knnSql = dialectSql.replace('__PLACEHOLDER__', '1=1') + ' LIMIT ?';
  const knnIdResult = await tx.executeAll<{ node_id: number }>(
    knnSql,
    [...dialectArgs, KNN_FETCH],
  );
  const neighborIds = knnIdResult.rows
    .map((r) => r.node_id)
    .filter((id) => id !== rowid)
    .slice(0, KNN_SCORE);

  if (neighborIds.length === 0) return null;

  // Fetch the candidate vectors themselves. Cosine is recomputed locally rather
  // than derived from the dialect's `distance` column on purpose: the two
  // backends do not agree on a distance metric (vec0's default is L2, Turso's
  // is whatever `vector_distance_*` was asked for), and the E8 threshold is
  // defined in cosine terms. `node_id` is the primary key on both backends —
  // an ordinary column on Turso, the rowid alias on a vec0 virtual table — so
  // this point lookup is portable.
  const placeholders = neighborIds.map(() => '?').join(',');
  const vecResult = await tx.executeAll<VecRow>(
    `SELECT node_id, embedding FROM vec_node WHERE node_id IN (${placeholders})`,
    neighborIds,
  );
  const knnRows = vecResult.rows;
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

  // Check node existence via raw SQL — avoids calling createGraphBackend (which
  // runs PRAGMAs that throw "Safety level may not be changed inside a transaction"
  // when detectNearDup is called from within applyEmbedding's transaction).
  const neighborUidRow = await tx.executeGet<{ uid: string }>(
    'SELECT uid FROM node WHERE rowid = ?',
    [neighborId],
  );
  if (!neighborUidRow) return null;

  return {
    existing_uid: neighborUidRow.uid,
    cosine_sim: bestPair.cosine,
    should_invalidate: bestPair.cosine >= threshold,
  };
}
