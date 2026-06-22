/**
 * cluster.ts — cosine-threshold connected-components clustering (E6).
 * CONTRACTS.md C1.8, C1.10. DESIGN.md D1.
 *
 * Determinism guarantees:
 * - Rowids sorted ascending before traversal (D1.2).
 * - Community UID = sha256(sorted member rowids joined by ',').slice(0,32).
 * - Label from centroid-nearest member (D1.4).
 * - Singletons suppressed (D1.6).
 * - Episodes with content.length < 50 excluded (D5.1).
 * - Degenerate guard: max_cluster/total > 0.5 → threshold+0.05 retry up to 3× (D5.5).
 *
 * No LLM, no network. All output is byte-reproducible for the same DB state.
 */

import * as crypto from 'node:crypto';
import type { Database } from 'better-sqlite3';

// ── Public types ──────────────────────────────────────────────────────────────

export interface ClusterResult {
  /** Stable UID = sha256(sorted member rowids as comma-joined string).slice(0,32). */
  community_uid: string;
  /** Human-readable label (D1.4: centroid-nearest member label). */
  label: string;
  /** Rowids of member episodes. Sorted ascending. */
  member_rowids: number[];
  /** Mean cosine similarity of all member pairs (quality metric per D1.8). */
  mean_intra_sim: number;
  /** Rowid of the centroid-nearest member (used to derive label). */
  centroid_rowid: number;
}

export interface ClusterStoreOptions {
  /** Cosine threshold τ (default 0.82 for real embeddings, 0.70 for hash). */
  threshold?: number;
  /** Soft cap on nodes per full pass (default 10000; D1.7). */
  nodeCap?: number;
  /** If true, only run local neighborhood check for new nodes rather than full re-cluster. */
  incrementalOnly?: boolean;
}

export interface ClusterStoreResult {
  clusters: ClusterResult[];
  /** Whether the full O(n²) pass was run (false if nodeCap exceeded or incrementalOnly). */
  full_pass: boolean;
  /** Count of episodes with no cluster assignment (singletons, suppressed per D1.6). */
  unclustered_count: number;
}

export interface ClusterStats {
  cluster_count: number;
  total_clustered: number;
  total_unclustered: number;
  mean_intra_sim: number;
  /** Mean cosine sim between cluster centroids. */
  mean_inter_sim: number;
  largest_cluster_size: number;
  /** Fraction of all live episodes that have a MEMBER_OF assignment. */
  coverage: number;
}

// ── Internal types ────────────────────────────────────────────────────────────

interface EpRow {
  rowid: number;
  uid: string;
  content: string | null;
  topic: string | null;
  name: string | null;
}

interface VecRow {
  node_id: number;
  embedding: Buffer;
}

// ── Union-Find ────────────────────────────────────────────────────────────────

class UnionFind {
  private parent: Map<number, number> = new Map();
  private rank: Map<number, number> = new Map();

  find(x: number): number {
    if (this.parent.get(x) === undefined) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    // Path compression
    let curr = x;
    while (this.parent.get(curr) !== root) {
      const next = this.parent.get(curr)!;
      this.parent.set(curr, root);
      curr = next;
    }
    return root;
  }

  union(x: number, y: number): void {
    const rx = this.find(x);
    const ry = this.find(y);
    if (rx === ry) return;
    const rankX = this.rank.get(rx) ?? 0;
    const rankY = this.rank.get(ry) ?? 0;
    if (rankX < rankY) {
      this.parent.set(rx, ry);
    } else if (rankX > rankY) {
      this.parent.set(ry, rx);
    } else {
      this.parent.set(ry, rx);
      this.rank.set(rx, rankX + 1);
    }
  }

  groups(): Map<number, number[]> {
    const result = new Map<number, number[]>();
    for (const x of this.parent.keys()) {
      const root = this.find(x);
      if (!result.has(root)) result.set(root, []);
      result.get(root)!.push(x);
    }
    return result;
  }
}

// ── Maths helpers ─────────────────────────────────────────────────────────────

/** Cosine similarity (dot product of L2-normalised vectors). */
function cosineSim(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += (a[i] as number) * (b[i] as number);
  }
  return dot;
}

/** Deserialise a blob from vec_node into Float32Array. */
function blobToFloat32(buf: Buffer): Float32Array {
  return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
}

/** Compute centroid (element-wise mean) of a list of Float32Array vectors. */
function centroid(vecs: Float32Array[]): Float32Array {
  const dim = vecs[0]?.length ?? 768;
  const c = new Float32Array(dim);
  for (const v of vecs) {
    for (let d = 0; d < dim; d++) {
      c[d] = (c[d] as number) + (v[d] as number);
    }
  }
  for (let d = 0; d < dim; d++) {
    c[d] = (c[d] as number) / vecs.length;
  }
  return c;
}

/** Deterministic community UID = sha256(sorted member rowids, comma-separated).slice(0,32). */
function communityUid(sortedRowids: number[]): string {
  return crypto
    .createHash('sha256')
    .update(sortedRowids.join(','))
    .digest('hex')
    .slice(0, 32);
}

/** Derive a human-readable label from the centroid-nearest episode (D1.4). */
function deriveLabel(ep: EpRow): string {
  // Priority a: [<topic>] prefix
  if (ep.topic) return ep.topic;
  // Priority b: node.name
  if (ep.name) return ep.name;
  // Priority c: first 6 words of content, title-cased
  const content = ep.content ?? '';
  const prefixMatch = /^\s*\[([^\]\n]{1,64})\]/.exec(content);
  if (prefixMatch) return prefixMatch[1]!;
  const words = content.split(/\s+/).slice(0, 6).join(' ').trim();
  if (words) return words;
  return 'cluster-?';
}

/** Compute mean intra-cluster cosine similarity. Returns 1.0 for single-member clusters. */
function meanIntraSim(vecs: Float32Array[]): number {
  if (vecs.length < 2) return 1.0;
  let totalSim = 0;
  let count = 0;
  for (let i = 0; i < vecs.length; i++) {
    for (let j = i + 1; j < vecs.length; j++) {
      totalSim += cosineSim(vecs[i]!, vecs[j]!);
      count++;
    }
  }
  return count > 0 ? totalSim / count : 1.0;
}

// ── Core clustering implementation ─────────────────────────────────────────────

function runConnectedComponents(
  rowids: number[],
  vecs: Float32Array[],
  threshold: number,
): Map<number, number[]> {
  const uf = new UnionFind();

  // Sort rowids ascending for stable traversal (D1.2)
  // rowids + vecs are already sorted ascending by the caller
  for (let i = 0; i < rowids.length; i++) {
    const ri = rowids[i]!;
    uf.find(ri); // ensure all nodes are registered
    for (let j = i + 1; j < rowids.length; j++) {
      const rj = rowids[j]!;
      const sim = cosineSim(vecs[i]!, vecs[j]!);
      if (sim >= threshold) {
        uf.union(ri, rj);
      }
    }
  }

  // Collect groups (Map<root, members[]>)
  return uf.groups();
}

function buildClusterResults(
  groups: Map<number, number[]>,
  rowidToVec: Map<number, Float32Array>,
  rowidToEp: Map<number, EpRow>,
): ClusterResult[] {
  const results: ClusterResult[] = [];

  for (const [, members] of groups) {
    if (members.length < 2) continue; // singletons suppressed (D1.6)

    const sortedMembers = [...members].sort((a, b) => a - b);
    const uid = communityUid(sortedMembers);

    const memberVecs = sortedMembers.map((r) => rowidToVec.get(r)!).filter(Boolean);
    const c = centroid(memberVecs);

    // Find centroid-nearest member
    let bestSim = -1;
    let bestRowid = sortedMembers[0]!;
    for (const r of sortedMembers) {
      const v = rowidToVec.get(r);
      if (!v) continue;
      const s = cosineSim(c, v);
      if (s > bestSim) {
        bestSim = s;
        bestRowid = r;
      }
    }

    const labelEp = rowidToEp.get(bestRowid);
    const label = labelEp ? deriveLabel(labelEp) : `cluster-${uid.slice(0, 6)}`;
    const intraSim = meanIntraSim(memberVecs);

    results.push({
      community_uid: uid,
      label,
      member_rowids: sortedMembers,
      mean_intra_sim: intraSim,
      centroid_rowid: bestRowid,
    });
  }

  return results;
}

function persistClusters(db: Database, clusters: ClusterResult[]): void {
  const now = new Date().toISOString();

  // Invalidate all current community nodes and MEMBER_OF edges first
  db.prepare(
    `UPDATE node SET t_invalid = ? WHERE kind = 'community' AND t_invalid IS NULL`,
  ).run(now);
  db.prepare(
    `UPDATE edge SET t_invalid = ? WHERE rel = 'MEMBER_OF' AND t_invalid IS NULL`,
  ).run(now);

  for (const cluster of clusters) {
    const metaJson = JSON.stringify({
      mean_intra_sim: cluster.mean_intra_sim,
      centroid_rowid: cluster.centroid_rowid,
      member_count: cluster.member_rowids.length,
    });

    // Upsert community node
    const existingRow = db
      .prepare<[string], { rowid: number }>(
        `SELECT rowid FROM node WHERE uid = ?`,
      )
      .get(cluster.community_uid);

    let communityRowid: number;
    if (existingRow) {
      // Reactivate if invalidated
      db.prepare(
        `UPDATE node SET t_invalid = NULL, name = ?, meta = ?, t_created = ?
         WHERE uid = ?`,
      ).run(cluster.label, metaJson, now, cluster.community_uid);
      communityRowid = existingRow.rowid;
    } else {
      const insertResult = db
        .prepare<unknown[], { rowid: number }>(
          `INSERT INTO node (uid, kind, name, level, t_created, t_valid, meta)
           VALUES (?, 'community', ?, 0, ?, ?, ?) RETURNING rowid`,
        )
        .get(cluster.community_uid, cluster.label, now, now, metaJson);
      if (!insertResult) continue; // should not happen
      communityRowid = insertResult.rowid;
    }

    // Insert MEMBER_OF edges
    for (const memberRowid of cluster.member_rowids) {
      db.prepare(
        `INSERT INTO edge (src, dst, rel, origin, weight, t_created)
         VALUES (?, ?, 'MEMBER_OF', 'inferred', 1.0, ?)`,
      ).run(memberRowid, communityRowid, now);
    }
  }
}

// ── Main exported functions ───────────────────────────────────────────────────

/**
 * Run cosine-threshold connected-components clustering over all live episodes (E6, D1).
 *
 * @param db   Open better-sqlite3 Database (write-capable).
 * @param opts Tuning parameters.
 * @returns    ClusterStoreResult with all cluster descriptors.
 */
export function clusterStore(
  db: Database,
  opts: ClusterStoreOptions = {},
): ClusterStoreResult {
  const defaultThreshold = resolveDefaultThreshold();
  const threshold = opts.threshold ?? defaultThreshold;
  const nodeCap = opts.nodeCap ?? 10000;

  // Fetch all live episodes with sufficient content length (D5.1: exclude < 50 chars)
  const episodes = db
    .prepare<[], EpRow>(
      `SELECT rowid, uid, content, topic, name
       FROM node
       WHERE kind = 'episode' AND t_invalid IS NULL
         AND content IS NOT NULL AND LENGTH(content) >= 50
       ORDER BY rowid ASC`,
    )
    .all();

  if (episodes.length < 2) {
    // Not enough episodes for any clusters
    return { clusters: [], full_pass: true, unclustered_count: episodes.length };
  }

  const isFullPass = !opts.incrementalOnly && episodes.length <= nodeCap;

  if (!isFullPass) {
    // Incremental mode: skip full re-cluster (TODO: implement local neighborhood check per D1.3)
    return { clusters: [], full_pass: false, unclustered_count: episodes.length };
  }

  // Fetch embeddings for all candidate episodes
  const rowids = episodes.map((e) => e.rowid);
  const rowidToEp = new Map<number, EpRow>(episodes.map((e) => [e.rowid, e]));

  const vecRows = db
    .prepare<unknown[], VecRow>(
      `SELECT node_id, embedding FROM vec_node
       WHERE node_id IN (${rowids.map(() => '?').join(',')})
       ORDER BY node_id ASC`,
    )
    .all(...(rowids as unknown[]));

  const rowidToVec = new Map<number, Float32Array>();
  for (const vRow of vecRows) {
    rowidToVec.set(vRow.node_id, blobToFloat32(vRow.embedding));
  }

  // Filter to only episodes with vectors
  const candidateRowids = rowids.filter((r) => rowidToVec.has(r));
  const candidateVecs = candidateRowids.map((r) => rowidToVec.get(r)!);

  // Degenerate-cluster guard (D5.5): retry up to 3 times with threshold+0.05
  let currentThreshold = threshold;
  let attempts = 0;
  let clusters: ClusterResult[] = [];

  while (attempts < 4) {
    const groups = runConnectedComponents(candidateRowids, candidateVecs, currentThreshold);
    const maxClusterSize = Math.max(...Array.from(groups.values()).map((g) => g.length));
    const ratio = maxClusterSize / candidateRowids.length;

    if (ratio <= 0.5 || attempts === 3) {
      clusters = buildClusterResults(groups, rowidToVec, rowidToEp);
      break;
    }

    // Degenerate: raise threshold
    currentThreshold = Math.min(currentThreshold + 0.05, 0.99);
    attempts++;
  }

  if (clusters.length === 0 && attempts === 3) {
    // Degenerate guard exhausted: return empty (do not write garbage)
    return { clusters: [], full_pass: false, unclustered_count: candidateRowids.length };
  }

  // Persist clusters to DB
  const clusterTx = db.transaction(() => persistClusters(db, clusters));
  clusterTx();

  const totalClustered = clusters.reduce((sum, c) => sum + c.member_rowids.length, 0);
  const unclustered = candidateRowids.length - totalClustered;

  return {
    clusters,
    full_pass: true,
    unclustered_count: unclustered,
  };
}

/**
 * Compute structural quality metrics for the current cluster state (D1.8).
 * Read-only: no DB writes.
 */
export function clusterStats(db: Database): ClusterStats {
  const clusterCountRow = db
    .prepare<[], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'community' AND t_invalid IS NULL`,
    )
    .get();
  const clusterCount = clusterCountRow?.cnt ?? 0;

  const totalClusteredRow = db
    .prepare<[], { cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM edge e
       JOIN node src ON src.rowid = e.src AND src.kind = 'episode' AND src.t_invalid IS NULL
       WHERE e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL`,
    )
    .get();
  const totalClustered = totalClusteredRow?.cnt ?? 0;

  const totalEpisodeRow = db
    .prepare<[], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL`,
    )
    .get();
  const totalEpisodes = totalEpisodeRow?.cnt ?? 0;
  const totalUnclustered = totalEpisodes - totalClustered;

  const largestRow = db
    .prepare<[], { max_count: number | null }>(
      `SELECT MAX(member_count) AS max_count FROM (
         SELECT COUNT(*) AS member_count
         FROM edge WHERE rel = 'MEMBER_OF' AND t_invalid IS NULL
         GROUP BY dst
       )`,
    )
    .get();
  const largestClusterSize = largestRow?.max_count ?? 0;

  // Compute mean intra-cluster sim from community node metas.
  // Guard: meta column may not exist on older stores (pre-P1 migration).
  const communityNodeCols = (db.prepare(`PRAGMA table_info(node)`).all() as { name: string }[]).map((c) => c.name);
  const hasMeta = communityNodeCols.includes('meta');

  const communityMetas = hasMeta
    ? db
        .prepare<[], { meta: string | null }>(
          `SELECT meta FROM node WHERE kind = 'community' AND t_invalid IS NULL AND meta IS NOT NULL`,
        )
        .all()
    : [];

  let totalIntraSim = 0;
  let intraSamplesCount = 0;
  const centroids: number[][] = [];

  for (const row of communityMetas) {
    if (!row.meta) continue;
    try {
      const m = JSON.parse(row.meta) as { mean_intra_sim?: number; centroid_rowid?: number };
      if (typeof m.mean_intra_sim === 'number') {
        totalIntraSim += m.mean_intra_sim;
        intraSamplesCount++;
      }
    } catch {
      // malformed meta — skip
    }
  }

  // Compute mean inter-sim from centroids (read centroid vectors from vec_node)
  const communityRows = hasMeta
    ? db
        .prepare<[], { meta: string | null }>(
          `SELECT meta FROM node WHERE kind = 'community' AND t_invalid IS NULL AND meta IS NOT NULL`,
        )
        .all()
    : [];
  for (const row of communityRows) {
    if (!row.meta) continue;
    try {
      const m = JSON.parse(row.meta) as { centroid_rowid?: number };
      if (typeof m.centroid_rowid === 'number') {
        const vRow = db
          .prepare<[number], VecRow>(`SELECT node_id, embedding FROM vec_node WHERE node_id = ?`)
          .get(m.centroid_rowid);
        if (vRow) {
          const vec = blobToFloat32(vRow.embedding);
          centroids.push(Array.from(vec));
        }
      }
    } catch {
      // skip
    }
  }

  let meanInterSim = 0;
  if (centroids.length >= 2) {
    let totalInterSim = 0;
    let interCount = 0;
    for (let i = 0; i < centroids.length; i++) {
      for (let j = i + 1; j < centroids.length; j++) {
        const ai = new Float32Array(centroids[i]!);
        const bj = new Float32Array(centroids[j]!);
        totalInterSim += cosineSim(ai, bj);
        interCount++;
      }
    }
    meanInterSim = interCount > 0 ? totalInterSim / interCount : 0;
  }

  const meanIntraSim = intraSamplesCount > 0 ? totalIntraSim / intraSamplesCount : 0;
  const coverage = totalEpisodes > 0 ? totalClustered / totalEpisodes : 0;

  return {
    cluster_count: clusterCount,
    total_clustered: totalClustered,
    total_unclustered: totalUnclustered,
    mean_intra_sim: meanIntraSim,
    mean_inter_sim: meanInterSim,
    largest_cluster_size: largestClusterSize,
    coverage,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveDefaultThreshold(): number {
  const backend = process.env['SOX_EMBED_BACKEND'];
  if (backend === 'hash') return 0.70;
  if (backend === 'real') return 0.82;
  return 0.70; // conservative default
}
