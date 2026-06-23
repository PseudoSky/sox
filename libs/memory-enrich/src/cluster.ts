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
import { buildFiltersClause } from './filters.js';
export type { MemoryFilter } from './filters.js';

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

/**
 * Deterministic community UID = sha256([salt:]sorted member rowids, comma-separated).slice(0,32).
 *
 * `salt` namespaces a community to a clustering provenance (e.g. a subset filter
 * hash). With an empty salt the output is byte-identical to the historical global
 * UID, so existing global communities keep their UIDs. A non-empty salt guarantees
 * a subset community NEVER collides with a global community of identical membership
 * — the two coexist as distinct nodes (different lenses over the same episodes).
 */
function communityUid(sortedRowids: number[], salt = ''): string {
  const key = salt ? `${salt}:${sortedRowids.join(',')}` : sortedRowids.join(',');
  return crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
}

/** Stable provenance hash of a subset filter (sorted-key JSON → sha256 → 16 hex). */
function filterProvenanceHash(filter: unknown): string {
  const stable = stableStringify(filter ?? null);
  return crypto.createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

/** Deterministic JSON: object keys sorted recursively so equal filters hash equal. */
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
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
  salt = '',
): ClusterResult[] {
  const results: ClusterResult[] = [];

  for (const [, members] of groups) {
    if (members.length < 2) continue; // singletons suppressed (D1.6)

    const sortedMembers = [...members].sort((a, b) => a - b);
    const uid = communityUid(sortedMembers, salt);

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

export interface MaterializeOptions {
  /**
   * Which slice of communities this pass owns and is allowed to replace.
   * - `global` (default): the whole-store partition. Replaces only global-scoped
   *   communities (and legacy untagged ones) — leaves subset communities intact.
   * - `subset`: a filtered lens. Replaces only communities sharing `provenanceHash`
   *   — leaves the global partition and every other filter's communities intact.
   */
  scope?: 'global' | 'subset';
  /** Required when scope='subset': identifies this filter's community slice. */
  provenanceHash?: string;
  /** Optional: the originating filter, stored on each community node for debugging. */
  filter?: unknown;
}

/**
 * Persist clusters as `community` nodes + `MEMBER_OF` edges — the single,
 * shared community materializer. Both the global batch pass (`clusterStore` →
 * `runBatchEnrich`) and the filtered synthesis path (`clusterSubset`) write
 * through this one function, so there is exactly ONE place that knows how a
 * community is shaped on disk (DRY).
 *
 * Invalidation is SCOPED so the two passes coexist without clobbering each other:
 * a global pass never touches subset communities, and a subset pass replaces only
 * its own filter's communities. Each persisted community records its provenance in
 * `meta.cluster_scope`, which is what scoping keys on.
 *
 * Note: an episode may end up `MEMBER_OF` both a global community and one or more
 * subset communities — these are intentionally different lenses, not duplicates.
 */
export function materializeClusters(
  db: Database,
  clusters: ClusterResult[],
  opts: MaterializeOptions = {},
): void {
  const scope = opts.scope ?? 'global';
  if (scope === 'subset' && !opts.provenanceHash) {
    throw new Error('materializeClusters: scope="subset" requires a provenanceHash');
  }
  const now = new Date().toISOString();

  // 1. Identify the prior community nodes THIS pass owns, then invalidate just
  //    those nodes and their MEMBER_OF edges. Edges are scoped by their dst node.
  const priorIds =
    scope === 'subset'
      ? db
          .prepare<[string], { rowid: number }>(
            `SELECT rowid FROM node
             WHERE kind = 'community' AND t_invalid IS NULL
               AND json_extract(meta, '$.cluster_scope.hash') = ?`,
          )
          .all(opts.provenanceHash as string)
          .map((r) => r.rowid)
      : db
          .prepare<[], { rowid: number }>(
            `SELECT rowid FROM node
             WHERE kind = 'community' AND t_invalid IS NULL
               AND (json_extract(meta, '$.cluster_scope.kind') IS NULL
                    OR json_extract(meta, '$.cluster_scope.kind') = 'global')`,
          )
          .all()
          .map((r) => r.rowid);

  if (priorIds.length > 0) {
    const ph = priorIds.map(() => '?').join(',');
    db.prepare(`UPDATE node SET t_invalid = ? WHERE rowid IN (${ph})`).run(now, ...priorIds);
    db.prepare(
      `UPDATE edge SET t_invalid = ? WHERE rel = 'MEMBER_OF' AND t_invalid IS NULL AND dst IN (${ph})`,
    ).run(now, ...priorIds);
  }

  const clusterScope =
    scope === 'subset'
      ? { kind: 'subset', hash: opts.provenanceHash, filter: opts.filter ?? null }
      : { kind: 'global' };

  // 2. Upsert each community + insert its MEMBER_OF edges.
  for (const cluster of clusters) {
    const metaJson = JSON.stringify({
      mean_intra_sim: cluster.mean_intra_sim,
      centroid_rowid: cluster.centroid_rowid,
      member_count: cluster.member_rowids.length,
      cluster_scope: clusterScope,
    });

    const existingRow = db
      .prepare<[string], { rowid: number }>(`SELECT rowid FROM node WHERE uid = ?`)
      .get(cluster.community_uid);

    let communityRowid: number;
    if (existingRow) {
      db.prepare(
        `UPDATE node SET t_invalid = NULL, name = ?, meta = ?, t_created = ? WHERE uid = ?`,
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
 * Select candidate episodes for clustering: live episodes with content ≥ 50 chars
 * (D5.1), optionally narrowed by an additive WHERE clause against alias `n`.
 *
 * `restrict` is consumed verbatim from the same predicate builder the recall path
 * uses (`buildFiltersClause`), so subset selection and recall filtering share one
 * filter vocabulary (tags / topic / project_path / importance_min / time range).
 * `restrict.sql` MUST be an AND-prefixed clause over alias `n` (or empty).
 */
function selectEpisodes(
  db: Database,
  restrict?: { sql: string; params: unknown[] },
): EpRow[] {
  return db
    .prepare<unknown[], EpRow>(
      `SELECT n.rowid AS rowid, n.uid AS uid, n.content AS content, n.topic AS topic, n.name AS name
       FROM node n
       WHERE n.kind = 'episode' AND n.t_invalid IS NULL
         AND n.content IS NOT NULL AND LENGTH(n.content) >= 50${restrict?.sql ?? ''}
       ORDER BY n.rowid ASC`,
    )
    .all(...(restrict?.params ?? []));
}

interface ComputeClustersOptions {
  threshold?: number | undefined;
  nodeCap?: number | undefined;
  incrementalOnly?: boolean | undefined;
  /** UID salt for the produced communities (subset provenance; '' for global). */
  salt?: string | undefined;
}

/**
 * Pure clustering core shared by `clusterStore` (global) and `clusterSubset`
 * (filtered): fetch vectors for the given episodes, run the degenerate-guarded
 * connected-components pass, and return cluster descriptors. NO DB writes —
 * persistence is the caller's choice via `materializeClusters`.
 */
function computeClusters(
  db: Database,
  episodes: EpRow[],
  opts: ComputeClustersOptions = {},
): ClusterStoreResult {
  const threshold = opts.threshold ?? resolveDefaultThreshold();
  const nodeCap = opts.nodeCap ?? 10000;
  const salt = opts.salt ?? '';

  if (episodes.length < 2) {
    return { clusters: [], full_pass: true, unclustered_count: episodes.length };
  }

  const isFullPass = !opts.incrementalOnly && episodes.length <= nodeCap;
  if (!isFullPass) {
    // Incremental mode: skip full re-cluster (TODO: local neighborhood check per D1.3)
    return { clusters: [], full_pass: false, unclustered_count: episodes.length };
  }

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

  const candidateRowids = rowids.filter((r) => rowidToVec.has(r));
  const candidateVecs = candidateRowids.map((r) => rowidToVec.get(r)!);

  if (candidateRowids.length < 2) {
    return { clusters: [], full_pass: true, unclustered_count: candidateRowids.length };
  }

  // Degenerate-cluster guard (D5.5): retry up to 3 times with threshold+0.05
  let currentThreshold = threshold;
  let attempts = 0;
  let clusters: ClusterResult[] = [];

  while (attempts < 4) {
    const groups = runConnectedComponents(candidateRowids, candidateVecs, currentThreshold);
    const maxClusterSize = Math.max(...Array.from(groups.values()).map((g) => g.length));
    const ratio = maxClusterSize / candidateRowids.length;

    if (ratio <= 0.5 || attempts === 3) {
      clusters = buildClusterResults(groups, rowidToVec, rowidToEp, salt);
      break;
    }

    currentThreshold = Math.min(currentThreshold + 0.05, 0.99);
    attempts++;
  }

  const totalClustered = clusters.reduce((sum, c) => sum + c.member_rowids.length, 0);
  return { clusters, full_pass: true, unclustered_count: candidateRowids.length - totalClustered };
}

/**
 * Run cosine-threshold connected-components clustering over ALL live episodes (E6, D1)
 * and persist the result as the GLOBAL community partition.
 *
 * @param db   Open better-sqlite3 Database (write-capable).
 * @param opts Tuning parameters.
 * @returns    ClusterStoreResult with all cluster descriptors.
 */
export function clusterStore(
  db: Database,
  opts: ClusterStoreOptions = {},
): ClusterStoreResult {
  const episodes = selectEpisodes(db);
  const result = computeClusters(db, episodes, {
    threshold: opts.threshold,
    nodeCap: opts.nodeCap,
    incrementalOnly: opts.incrementalOnly,
    // salt='' → global UIDs unchanged (back-compat).
  });

  if (result.clusters.length > 0) {
    const tx = db.transaction(() => materializeClusters(db, result.clusters, { scope: 'global' }));
    tx();
  }
  return result;
}

export interface ClusterSubsetOptions {
  /**
   * Structured filter — the preferred way to call `clusterSubset`. The engine
   * builds the SQL clause internally (`buildFiltersClause`) so callers need no
   * knowledge of the internal table alias or SQL shape. The filter also drives
   * the deterministic provenance hash and is stored on each community node's
   * `meta` for traceability.
   *
   * Use `filter` instead of the lower-level `restrict` unless you have a
   * pre-built clause from a legacy callsite.
   */
  filter?: import('./filters.js').MemoryFilter;
  /**
   * Low-level additive WHERE predicate over alias `n` — `{ sql, params }`.
   * Prefer `filter` above; this exists for callers that pre-build the clause.
   * When both are supplied, `filter` is used for the provenance hash and `restrict`
   * provides the SQL (they must be consistent).
   * @deprecated Pass `filter` and let the engine build the clause.
   */
  restrict?: { sql: string; params: unknown[] };
  threshold?: number;
  nodeCap?: number;
  /**
   * When true, persist the produced communities to the DB under this filter's
   * provenance (scoped — does not touch global or other-filter communities).
   * Default false: a read-only synthesis query with no side effects.
   */
  persist?: boolean;
}

export interface ClusterSubsetResult extends ClusterStoreResult {
  /** Whether communities were written to the DB. */
  persisted: boolean;
  /** Stable hash identifying this filter's community slice. */
  provenance_hash: string;
  /** Number of candidate episodes the filter selected. */
  candidate_count: number;
}

/**
 * Filtered clustering for synthesis: cluster ONLY the episodes matching `restrict`,
 * and optionally persist the result as a provenance-scoped community slice.
 *
 * This is the on-demand replacement for a curator's manual cross-agent clustering
 * pass. Read mode (`persist:false`, default) returns synthesis candidates with no
 * side effects; write mode (`persist:true`) lets an agent durably persist the
 * revised communities — reusing the SAME `materializeClusters` writer as the global
 * batch pass, scoped so it never clobbers the global partition (DRY).
 */
export function clusterSubset(
  db: Database,
  opts: ClusterSubsetOptions = {},
): ClusterSubsetResult {
  // Guard: an empty/absent filter with persist:true would write a duplicate of the
  // global partition under a non-global salt — creating a confusing, unreachable
  // subset lens. Reject before writing. Read-only (persist:false) is still fine:
  // a no-filter read is equivalent to "show me all clusters in memory", which is
  // a valid synthesis query with no side effects.  (BL-27 LOW-1)
  const hasFilter =
    opts.filter != null && Object.keys(opts.filter).length > 0;
  const hasRestrict = opts.restrict != null && opts.restrict.sql.trim() !== '';
  if (opts.persist && !hasFilter && !hasRestrict) {
    throw new Error(
      'clusterSubset: persist:true requires at least one filter field (or a restrict clause). ' +
      'An empty/absent filter would duplicate the global partition under a hashed name — ' +
      'use clusterStore() to run the global pass instead.',
    );
  }

  // Build restrict clause from the structured filter when provided.
  // Fall back to a pre-built `restrict` for legacy callers, then empty (cluster-all).
  const restrict: { sql: string; params: unknown[] } | undefined =
    opts.filter != null
      ? buildFiltersClause(opts.filter)
      : opts.restrict;

  // Provenance hash keys on the structured filter (preferred) or the raw SQL
  // fragment (legacy). The hash must be stable across calls with the same intent.
  const provenanceHash = filterProvenanceHash(opts.filter ?? opts.restrict?.sql ?? '');
  const episodes = selectEpisodes(db, restrict);

  const result = computeClusters(db, episodes, {
    threshold: opts.threshold,
    nodeCap: opts.nodeCap,
    salt: provenanceHash, // namespace community UIDs to this filter
  });

  let persisted = false;
  if (opts.persist && result.clusters.length > 0) {
    const tx = db.transaction(() =>
      materializeClusters(db, result.clusters, {
        scope: 'subset',
        provenanceHash,
        // Store whichever filter representation is available for traceability.
        filter: opts.filter ?? opts.restrict?.sql ?? null,
      }),
    );
    tx();
    persisted = true;
  }

  return {
    ...result,
    persisted,
    provenance_hash: provenanceHash,
    candidate_count: episodes.length,
  };
}

/**
 * Compute structural quality metrics for the current cluster state (D1.8).
 * Read-only: no DB writes.
 */
export function clusterStats(db: Database): ClusterStats {
  // Scope all stats to GLOBAL communities only (kind='global' or legacy NULL scope).
  // Persisted subset lenses must NOT inflate the health/CI-gate numbers reported here.
  //
  // Two variants of the scope predicate:
  //  - `globalScopeUnaliased` — for single-table queries where `meta` is unambiguous.
  //  - `globalScopeDst`       — for JOIN queries; qualifies meta with the `dst` alias.
  const globalScopeUnaliased = `(json_extract(meta, '$.cluster_scope.kind') IS NULL OR json_extract(meta, '$.cluster_scope.kind') = 'global')`;
  const globalScopeDst = `(json_extract(dst.meta, '$.cluster_scope.kind') IS NULL OR json_extract(dst.meta, '$.cluster_scope.kind') = 'global')`;

  const clusterCountRow = db
    .prepare<[], { cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'community' AND t_invalid IS NULL AND ${globalScopeUnaliased}`,
    )
    .get();
  const clusterCount = clusterCountRow?.cnt ?? 0;

  const totalClusteredRow = db
    .prepare<[], { cnt: number }>(
      `SELECT COUNT(*) AS cnt
       FROM edge e
       JOIN node src ON src.rowid = e.src AND src.kind = 'episode' AND src.t_invalid IS NULL
       JOIN node dst ON dst.rowid = e.dst AND dst.kind = 'community' AND dst.t_invalid IS NULL
         AND ${globalScopeDst}
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

  // largest_cluster_size: scoped to global communities only.
  const largestRow = db
    .prepare<[], { max_count: number | null }>(
      `SELECT MAX(member_count) AS max_count FROM (
         SELECT COUNT(*) AS member_count
         FROM edge e
         JOIN node dst ON dst.rowid = e.dst AND dst.kind = 'community' AND dst.t_invalid IS NULL
           AND (json_extract(dst.meta, '$.cluster_scope.kind') IS NULL
                OR json_extract(dst.meta, '$.cluster_scope.kind') = 'global')
         WHERE e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
         GROUP BY e.dst
       )`,
    )
    .get();
  const largestClusterSize = largestRow?.max_count ?? 0;

  // Compute mean intra-cluster sim from community node metas.
  // Guard: meta column may not exist on older stores (pre-P1 migration).
  const communityNodeCols = (db.prepare(`PRAGMA table_info(node)`).all() as { name: string }[]).map((c) => c.name);
  const hasMeta = communityNodeCols.includes('meta');

  // Scoped to global communities only so subset lenses don't skew the metric.
  const communityMetas = hasMeta
    ? db
        .prepare<[], { meta: string | null }>(
          `SELECT meta FROM node WHERE kind = 'community' AND t_invalid IS NULL AND meta IS NOT NULL
           AND (json_extract(meta, '$.cluster_scope.kind') IS NULL
                OR json_extract(meta, '$.cluster_scope.kind') = 'global')`,
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

  // Compute mean inter-sim from centroids — global communities only.
  const communityRows = hasMeta
    ? db
        .prepare<[], { meta: string | null }>(
          `SELECT meta FROM node WHERE kind = 'community' AND t_invalid IS NULL AND meta IS NOT NULL
           AND (json_extract(meta, '$.cluster_scope.kind') IS NULL
                OR json_extract(meta, '$.cluster_scope.kind') = 'global')`,
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

// ── Subset-lens lifecycle (BL-26) ─────────────────────────────────────────────

export interface SubsetLensDescriptor {
  /** 16-hex provenance hash that identifies this lens. */
  provenance_hash: string;
  /** Number of live community nodes in this slice. */
  community_count: number;
  /** ISO timestamp of the most recently created community in this slice. */
  last_updated: string;
  /** The filter stored on the community nodes at persist time (may be null for legacy/raw). */
  filter: unknown;
}

/**
 * List all persisted subset lenses currently live in the store.
 *
 * Returns one descriptor per distinct `provenance_hash`. Cheap: reads only the
 * community node metadata, no vec_node access.
 *
 * Note: only lenses with `cluster_scope.kind = 'subset'` are returned. The
 * global partition is excluded.
 */
export function listSubsetLenses(db: Database): SubsetLensDescriptor[] {
  const rows = db
    .prepare<[], { meta: string | null; t_created: string }>(
      `SELECT meta, t_created FROM node
       WHERE kind = 'community' AND t_invalid IS NULL
         AND json_extract(meta, '$.cluster_scope.kind') = 'subset'
       ORDER BY t_created DESC`,
    )
    .all();

  // Group by provenance_hash
  const byHash = new Map<
    string,
    { community_count: number; last_updated: string; filter: unknown }
  >();

  for (const row of rows) {
    if (!row.meta) continue;
    let m: { cluster_scope?: { hash?: string; filter?: unknown }; [k: string]: unknown };
    try {
      m = JSON.parse(row.meta) as typeof m;
    } catch {
      continue;
    }
    const hash = m.cluster_scope?.hash;
    if (typeof hash !== 'string') continue;

    const existing = byHash.get(hash);
    if (!existing) {
      byHash.set(hash, {
        community_count: 1,
        last_updated: row.t_created,
        filter: m.cluster_scope?.filter ?? null,
      });
    } else {
      existing.community_count++;
      // keep the latest t_created as last_updated
      if (row.t_created > existing.last_updated) {
        existing.last_updated = row.t_created;
      }
    }
  }

  return Array.from(byHash.entries()).map(([hash, v]) => ({
    provenance_hash: hash,
    community_count: v.community_count,
    last_updated: v.last_updated,
    filter: v.filter,
  }));
}

export interface DropSubsetLensResult {
  /** The provenance_hash that was dropped. */
  provenance_hash: string;
  /** Number of community nodes invalidated. */
  communities_dropped: number;
  /** Number of MEMBER_OF edges invalidated (as a consequence of community invalidation). */
  edges_dropped: number;
}

/**
 * Drop a persisted subset lens by its provenance hash.
 *
 * Invalidates ONLY the subset community nodes keyed to `provenanceHash` and
 * their `MEMBER_OF` edges. Never touches the global partition or any other
 * lens's communities.
 *
 * This is the GC operation for subset lenses whose member episodes were
 * invalidated or whose filter is no longer relevant (BL-26).
 *
 * Returns a summary of what was invalidated.
 *
 * If no communities exist for the given hash, returns a result with counts of 0
 * (not an error — idempotent).
 */
export function dropSubsetLens(
  db: Database,
  provenanceHash: string,
): DropSubsetLensResult {
  const now = new Date().toISOString();

  // Find all live community nodes owned by this lens.
  const priorIds = db
    .prepare<[string], { rowid: number }>(
      `SELECT rowid FROM node
       WHERE kind = 'community' AND t_invalid IS NULL
         AND json_extract(meta, '$.cluster_scope.hash') = ?`,
    )
    .all(provenanceHash)
    .map((r) => r.rowid);

  if (priorIds.length === 0) {
    return { provenance_hash: provenanceHash, communities_dropped: 0, edges_dropped: 0 };
  }

  const ph = priorIds.map(() => '?').join(',');

  // Count edges to be invalidated before writing.
  const edgeCount = (
    db
      .prepare<unknown[], { cnt: number }>(
        `SELECT COUNT(*) AS cnt FROM edge
         WHERE rel = 'MEMBER_OF' AND t_invalid IS NULL AND dst IN (${ph})`,
      )
      .get(...priorIds)
  )?.cnt ?? 0;

  const tx = db.transaction(() => {
    db.prepare(`UPDATE node SET t_invalid = ? WHERE rowid IN (${ph})`).run(now, ...priorIds);
    db.prepare(
      `UPDATE edge SET t_invalid = ? WHERE rel = 'MEMBER_OF' AND t_invalid IS NULL AND dst IN (${ph})`,
    ).run(now, ...priorIds);
  });
  tx();

  return {
    provenance_hash: provenanceHash,
    communities_dropped: priorIds.length,
    edges_dropped: edgeCount,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function resolveDefaultThreshold(): number {
  const backend = process.env['SOX_EMBED_BACKEND'];
  if (backend === 'hash') return 0.70;
  if (backend === 'real') return 0.82;
  return 0.70; // conservative default
}
