import type { Database } from 'better-sqlite3';
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

interface NodeRow {
  uid: string;
  content: string | null;
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

  const neighborNode = db
    .prepare<[number], NodeRow>(
      `SELECT uid, content FROM node WHERE rowid = ? AND t_invalid IS NULL`,
    )
    .get(neighborId);

  if (!neighborNode) return null;

  const isHashBackend =
    (process.env['SOX_EMBED_BACKEND'] === 'hash') ||
    (process.env['SOX_EMBED_BACKEND'] === undefined && !process.env['SOX_EMBED_REAL']);

  if (isHashBackend) {
    const newContent = db
      .prepare<[number], { content: string | null }>(`SELECT content FROM node WHERE rowid = ?`)
      .get(rowid);
    const newContentLen = (newContent?.content ?? '').length;
    if (newContentLen < 50) return null;

    const sharedEntity = db
      .prepare<[number, number], { cnt: number }>(
        `SELECT COUNT(*) AS cnt
         FROM edge e1
         JOIN edge e2 ON e1.dst = e2.dst AND e2.src = ?
         WHERE e1.src = ? AND e1.rel = 'MENTIONS' AND e2.rel = 'MENTIONS'
           AND e1.t_expired IS NULL AND e2.t_expired IS NULL`,
      )
      .get(rowid, neighborId);
    if (!sharedEntity || sharedEntity.cnt === 0) return null;
  }

  return {
    existing_uid: neighborNode.uid,
    cosine_sim: bestPair.cosine,
    should_invalidate: bestPair.cosine >= threshold,
  };
}
