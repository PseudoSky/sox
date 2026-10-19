/**
 * cluster.ts — cosine-threshold connected-components clustering (E6).
 * CONTRACTS.md C1.8, C1.10. DESIGN.md D1.
 *
 * Determinism guarantees:
 * - Rowids sorted ascending before traversal (D1.2).
 * - Community UID = sha256(sorted member rowids joined by ',').slice(0,32).
 * - Label from centroid-nearest member (D1.4).
 * - Singletons suppressed (D1.6).
 * - Episodes with content.length < CLUSTER_MIN_CONTENT_LENGTH (default 20, tunable via SOX_CLUSTER_MIN_CONTENT_LENGTH) excluded (D5.1).
 * - Degenerate guard: max_cluster/total > 0.5 → threshold+0.05 retry up to 3× (D5.5).
 *
 * No LLM, no network. All output is byte-reproducible for the same DB state.
 */

import * as crypto from 'node:crypto';
import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { getMemoryGraphBackend } from './graph-backend.js';
import { cluster as analysisCluster } from '@adhd/sox-analysis';
import { buildFiltersClause } from './memory-filters.js';
import {
  recordClusterPass,
  recordJoinOutcome,
  recordTimeToCommunity,
  recordCommunityLifecycle,
  recordBacklog,
  recordNeverClustered,
  recordQuality,
  getClusterMetrics,
  type ClusterPassPath,
} from './cluster-metrics.js';
import { log } from './telemetry.js';
import { MEMORY_CORE_STAGES } from './stages.js';

/**
 * Metrics bucket used when a caller supplies no `storeKey`.
 *
 * Every production entry point (memory-server's periodic tick and `memory_curate`)
 * has the store's `dbPath` in hand and passes it, exactly as `embed-pipeline.ts`
 * keys on `WriteQueue.storePath`. This fallback exists for tests and ad-hoc
 * callers. It is a NAMED bucket rather than a silent merge into the first real
 * store's numbers, so an unkeyed caller shows up as its own row in
 * `memory_ping` instead of quietly corrupting a real store's aggregate.
 */
const DEFAULT_STORE_KEY = '(unkeyed)';

/**
 * Minimum content length for an episode to be a clustering candidate at all.
 *
 * BL-496: exported because the time-to-community metric MUST partition the
 * unclustered population by the same predicate the clusterer uses. An episode
 * below this length is not "awaiting clustering" — it is structurally ineligible
 * and will never be considered, and reporting it as backlog would make the
 * awaiting count permanently non-draining for a reason that has nothing to do
 * with clustering throughput.
 *
 * BL-497: the floor was a hardcoded 50 with no rationale on record, silently
 * excluding every episode whose content fell in [20, 50) chars (tag-like notes,
 * command output, terse prose). It is now operator-tunable via
 * `SOX_CLUSTER_MIN_CONTENT_LENGTH` (default 20, floor >= 1 — 0 or negative
 * would admit empty-string episodes as `awaiting_vector` noise). Operators who
 * see short-content admissions bloating communities can RAISE the floor to keep
 * terse episodes out of clustering entirely. Resolved ONCE
 * at module config time, because `CLUSTER_ELIGIBLE_SQL` below interpolates this
 * value into a baked SQL string: a per-call re-read would let the exported
 * constant and the executed predicate drift apart, recreating the exact
 * two-sources-of-truth defect this module exists to prevent.
 */
const CLUSTER_MIN_CONTENT_LENGTH_DEFAULT = 20;

function resolveMinContentLength(): number {
  const raw = process.env['SOX_CLUSTER_MIN_CONTENT_LENGTH'];
  if (raw === undefined) return CLUSTER_MIN_CONTENT_LENGTH_DEFAULT;
  const parsed = Number(raw);
  // Same guard shape as resolveTargetMeanDegree: a non-finite or out-of-range
  // value falls back to the default rather than disabling the floor. The bound
  // is >= 1 (not > 0) so 0 — which would admit empty-string episodes — cannot
  // be configured in.
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : CLUSTER_MIN_CONTENT_LENGTH_DEFAULT;
}

export const CLUSTER_MIN_CONTENT_LENGTH = resolveMinContentLength();

/** SQL predicate (alias `n`) for "this episode is a clustering candidate". Shared with cluster-metrics. */
export const CLUSTER_ELIGIBLE_SQL =
  `n.kind = 'episode' AND n.t_invalid IS NULL AND n.content IS NOT NULL AND LENGTH(n.content) >= ${CLUSTER_MIN_CONTENT_LENGTH}`;

/**
 * The clustering-candidate predicate over alias `n` (D5.1: live episodes with
 * content ≥ CLUSTER_MIN_CONTENT_LENGTH, default 20).
 *
 * Extracted to ONE constant because two call sites must agree exactly:
 * `selectEpisodes` (which returns the candidates) and `clusterStore`'s
 * pre-count (which picks the stage's path label from how many there are). If
 * those two predicates ever diverged, the telemetry would confidently report a
 * `full` pass that actually ran `incremental`, or vice versa — a mislabel is
 * worse than no label, because it is believed.
 */
const EPISODE_CANDIDATE_PREDICATE = CLUSTER_ELIGIBLE_SQL;
export type { MemoryFilter } from './memory-filters.js';

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

/**
 * Why a pass that was asked to do (or was in the middle of) a FULL re-cluster
 * did not produce a full partition. Present on a result ONLY when the caller's
 * request was not honoured — never on an incremental pass the caller asked for.
 *
 * Backlog 0c9c76b4: before this existed a requested full pass over a corpus
 * larger than `nodeCap` silently ran the incremental join (which can never
 * create a community) and was settled `completed`. A caller must be able to
 * tell "the global reorganisation ran" from "it was refused/aborted".
 */
export type ClusterDegradation =
  | {
      /** The candidate corpus exceeded `nodeCap`; the O(n²) pass was not attempted. */
      reason: 'nodeCap';
      episodeCount: number;
      nodeCap: number;
    }
  | {
      /** The full pass ran past `budgetMs` and was abandoned before writing anything. */
      reason: 'budget';
      episodeCount: number;
      budgetMs: number;
      elapsedMs: number;
    };

/**
 * Default ceiling on candidate episodes for one FULL (O(n²)) pass. Defined
 * here once; `runBatchEnrich` and `clusterStore` both read it (ADR-0013: a
 * typed constant/option, no env toggle).
 *
 * ## Derivation (backlog 0c9c76b4 AC6)
 *
 * The full pass is an all-pairs DBSCAN in `@adhd/sox-analysis`: cost is
 * c · N², c ≈ one 768-d cosine distance per pair.
 *
 * Measured 2026-10-14, synthetic 768-d vectors, isolated node process, host at
 * load average 100-150 (so WALL time was 8-10x inflated: 204-268 s at N=5000).
 * CPU time is what load cannot distort, and it repeated to within 1%
 * and scaled quadratically (N=12,000 predicted 149 s, measured 149.2 s):
 *   N=2,500  CPU 6.5 s, 6.4 s                      -> 1.03 µs/pair
 *   N=5,000  CPU 26.7 s, 26.5 s, 26.7 s, 26.4 s    -> 1.06 µs/pair
 *   N=12,000 CPU 149.2 s (wall 1,012 s under the same load)  -> 1.04 µs/pair
 *   N=4,950  23.4 s (in-repo measurement, see calibrateThreshold) -> 0.95 µs/pair
 * so c ≈ 1.07 µs (the worst repeat is used below).
 *
 * Rule: ONE full pass, on an idle core, must use at most 50% of the 600 s
 * enrich-child SIGTERM (`DEFAULT_ENRICH_FULL_TIMEOUT_MS`), leaving the other
 * half for vector load, materialisation and CPU contention:
 *   c · cap² ≤ 300 s  =>  cap ≤ sqrt(300 / 1.068e-6) ≈ 16,760.
 * 16,000 -> 273 s (46%). 17,000 -> 309 s (breaks the rule) — pinned by a test.
 * The previous 10,000 cost 107 s, and the live corpus (11,763 episodes) was
 * already past it.
 *
 * The D5.5 degenerate guard may re-run the pass at τ+0.05 (up to 3 more
 * times). Multiplying the cost by four would cap the corpus at ~8,400 — below
 * the live store — so retries are NOT budgeted into the cap; they are bounded
 * by the budget instead: a retry only starts if (elapsed + the previous pass's
 * duration) fits `DEFAULT_FULL_PASS_BUDGET_MS`, so at 16,000 a retry is refused
 * rather than run, and the pass reports `degraded: 'budget'`. Calibration
 * (PKT-30) puts the guard at zero retries in practice.
 */
export const DEFAULT_CLUSTER_NODE_CAP = 16_000;

/**
 * Raw measurement behind {@link DEFAULT_CLUSTER_NODE_CAP}; the arithmetic in
 * the derivation above is re-checked from these fields by the AC6 test, so the
 * comment and the constant cannot drift apart.
 */
export const CLUSTER_NODE_CAP_MEASUREMENT = {
  measuredN: 5_000,
  /** Worst CPU-seconds of four repeats of one all-pairs pass at measuredN. */
  measuredSeconds: 26.7,
  worstCasePasses: 1,
  budgetSeconds: 600,
  budgetFraction: 0.5,
} as const;

/**
 * Wall-clock budget for a full pass, below the 600 s SIGTERM of the isolated
 * enrich child so the pass can abandon CLEANLY (no write, honest result)
 * instead of being killed mid-flight. Checked before each (re)run of the
 * all-pairs pass, and a RE-run must be predicted to fit (elapsed + the previous
 * run's duration). An in-flight run is synchronous inside `@adhd/sox-analysis`
 * and cannot be interrupted from here, which is why the cap above, not this
 * budget, is what bounds a single run.
 */
export const DEFAULT_FULL_PASS_BUDGET_MS = 540_000;

export interface ClusterStoreOptions {
  /** Cosine threshold τ (default: resolveDefaultThreshold(), currently 0.87). */
  threshold?: number;
  /**
   * Cap on candidate episodes for one full pass (default
   * {@link DEFAULT_CLUSTER_NODE_CAP}; D1.7). Above it a requested full pass is
   * REFUSED and reported as `degraded: { reason: 'nodeCap' }`.
   */
  nodeCap?: number;
  /** Wall-clock budget for a full pass (default {@link DEFAULT_FULL_PASS_BUDGET_MS}). */
  budgetMs?: number;
  /** Injectable monotonic-ms clock for the budget check (default `performance.now`). */
  now?: () => number;
  /** If true, only run local neighborhood check for new nodes rather than full re-cluster. */
  incrementalOnly?: boolean;
  /** Metrics bucket — the store's `dbPath`. See {@link DEFAULT_STORE_KEY}. */
  storeKey?: string;
}

export interface ClusterStoreResult {
  clusters: ClusterResult[];
  /**
   * Whether the full O(n²) pass was run to completion (false if nodeCap
   * exceeded, budget abort, or incrementalOnly).
   */
  full_pass: boolean;
  /**
   * Set when a FULL pass was requested but not delivered — see
   * {@link ClusterDegradation}. Absent when the pass ran as requested.
   */
  degraded?: ClusterDegradation;
  /** Count of episodes with no cluster assignment (singletons, suppressed per D1.6). */
  unclustered_count: number;
  /**
   * BL-349: count of episodes joined to an EXISTING community via the
   * incremental local-neighborhood join (non-full-pass only — §2.2 of
   * `pkt28-clustering-strategy.md`). `undefined` on a full pass, where
   * membership instead comes from `clusters`.
   */
  incremental_joined?: number;
  /**
   * PKT-30/BL-328: the target-mean-degree calibration this pass ran. Present
   * only on a full pass that resolved its own τ (absent when the caller passed
   * an explicit `threshold`, which is an absolute override, and on the
   * incremental path, which never recalibrates — §2.2).
   */
  calibration?: ThresholdCalibration;
  /**
   * How many times the D5.5 degenerate guard had to retry at τ+0.05. With
   * calibration in front of it this should be 0 — a non-zero value means
   * calibration under-shot and is the signal to re-examine D_target.
   */
  guard_retries?: number;
  /** The τ the partition was actually produced at (post-calibration, post-guard). */
  effective_threshold?: number;
  /**
   * BL-496: the admission decisions this incremental pass made, which the
   * pre-fix code computed and then threw away at the `bestSim < threshold`
   * `continue` (previously cluster.ts:596). Without this, a caller could not
   * distinguish an episode that was CONSIDERED AND REJECTED from one that had
   * not yet been considered — the two states are observationally identical
   * (both are "live episode with no MEMBER_OF edge") and demand opposite
   * responses (wait vs. lower τ / schedule a full pass).
   *
   * Present only on the incremental path; a full pass re-partitions from
   * scratch and reports through `clusters`/`calibration` instead.
   */
  admission?: ClusterAdmissionStats;
}

/**
 * BL-496: per-pass admission accounting for the incremental join — the
 * "considered and rejected" population that had no representation anywhere in
 * the system before this.
 *
 * Every field is derived from values `incrementalJoin` already computes; this
 * type only stops discarding them. No schema change, no behaviour change, no
 * extra similarity computation.
 */
export interface ClusterAdmissionStats {
  /** τ this pass admitted at. */
  threshold: number;
  /** Episodes eligible for a join decision (unassigned, vectorised). */
  considered: number;
  /** Cleared τ and were written a MEMBER_OF edge. */
  joined: number;
  /**
   * Cleared τ but were refused by the degenerate-ratio guard (would have
   * pushed a community past the 0.5 majority bound). These are deferred, NOT
   * permanently excluded — a full/subset pass owns re-thresholding them.
   */
  rejected_degenerate_guard: number;
  /**
   * **The H2 population.** Compared against every live community member and
   * fell below τ. These do not "wait" for anything: the comparison is
   * deterministic over a near-static member set, so absent new neighbouring
   * content or a full pass, the same episode is re-rejected on every
   * subsequent tick, forever.
   */
  rejected_below_threshold: number;
  /**
   * Of `rejected_below_threshold`, how many landed within 0.02 of τ — the
   * population a small τ change would admit. A large near-miss count with a
   * small `joined` count is the signature of a mis-set τ rather than of
   * genuinely unrelated content.
   */
  rejected_near_miss: number;
  /** Best-similarity distribution over rejected candidates (max-to-any-member). */
  rejected_best_sim: { p50: number; p90: number; max: number };
  /**
   * Live communities available as join targets. **Zero means no episode can
   * be assigned at all** — the incremental path only ever JOINS an existing
   * community, it can never CREATE one (`computeClusters` returns
   * `clusters: []` on this branch, so `materializeClusters` never runs).
   */
  community_targets: number;
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
  /** ISO wall-clock write time. Carried ONLY to compute `time_to_community_ms`
   *  at join (cluster-metrics.ts) — never used as clustering input, so it
   *  cannot influence which episodes group together. */
  t_created: string | null;
}

interface VecRow {
  node_id: number;
  embedding: Buffer;
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

function runClusters(
  vecs: Array<{ id: number; vec: Float32Array }>,
  threshold: number,
): Map<number, number[]> {
  const result = analysisCluster(vecs, { threshold, minClusterSize: 2 });
  const groups = new Map<number, number[]>();
  for (const community of result.communities) {
    const root = community.memberIds[0]!;
    groups.set(root, community.memberIds);
  }
  return groups;
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
  /** Metrics bucket — the store's `dbPath`. See {@link DEFAULT_STORE_KEY}. */
  storeKey?: string;
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
export async function materializeClusters(
  adapter: StoreAdapter,
  clusters: ClusterResult[],
  opts: MaterializeOptions = {},
): Promise<void> {
  const scope = opts.scope ?? 'global';
  if (scope === 'subset' && !opts.provenanceHash) {
    throw new Error('materializeClusters: scope="subset" requires a provenanceHash');
  }
  const now = new Date().toISOString();

  // 1. Identify the prior community nodes THIS pass owns, then invalidate just
  //    those nodes and their MEMBER_OF edges. Edges are scoped by their dst node.
  const priorIds =
    scope === 'subset'
      ? (await adapter.executeAll<{ rowid: number }>(
            `SELECT rowid FROM node
             WHERE kind = 'community' AND t_invalid IS NULL
               AND json_extract(meta, '$.cluster_scope.hash') = ?`,
            [opts.provenanceHash as string],
          )).rows.map((r) => r.rowid)
      : (await adapter.executeAll<{ rowid: number }>(
            `SELECT rowid FROM node
             WHERE kind = 'community' AND t_invalid IS NULL
               AND (json_extract(meta, '$.cluster_scope.kind') IS NULL
                    OR json_extract(meta, '$.cluster_scope.kind') = 'global')`,
          )).rows.map((r) => r.rowid);

  let edgesInvalidated = 0;
  if (priorIds.length > 0) {
    const ph = priorIds.map(() => '?').join(',');
    await adapter.executeRun(`UPDATE node SET t_invalid = ? WHERE rowid IN (${ph})`, [now, ...priorIds]);
    const edgeRes = await adapter.executeRun(
      `UPDATE edge SET t_invalid = ? WHERE rel = 'MEMBER_OF' AND t_invalid IS NULL AND dst IN (${ph})`,
      [now, ...priorIds],
    );
    edgesInvalidated = edgeRes.rowsAffected;
  }
  // Recorded BEFORE the upsert loop below, so a pass that throws midway still
  // leaves evidence that N communities were invalidated. The whole point of
  // this counter is that a mass invalidation must never be reconstructible only
  // by noticing rows are missing.
  recordCommunityLifecycle(opts.storeKey ?? DEFAULT_STORE_KEY, {
    invalidated: priorIds.length,
    memberEdgesInvalidated: edgesInvalidated,
  });

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

    const existingRow = await adapter.executeGet<{ rowid: number }>(
      `SELECT rowid FROM node WHERE uid = ?`,
      [cluster.community_uid],
    );

    let communityRowid: number;
    if (existingRow) {
      // REVIVED: this uid recomputed identically, meaning its member set is
      // unchanged since the last pass. Distinct from `created` — see
      // cluster-metrics.ts's note on why `created` climbing while `revived`
      // stays flat is the signature of community-identity churn.
      await adapter.executeRun(
        `UPDATE node SET t_invalid = NULL, name = ?, meta = ?, t_created = ? WHERE uid = ?`,
        [cluster.label, metaJson, now, cluster.community_uid],
      );
      recordCommunityLifecycle(opts.storeKey ?? DEFAULT_STORE_KEY, { revived: 1 });
      communityRowid = existingRow.rowid;
    } else {
      const insertResult = await adapter.executeGet<{ rowid: number }>(
        `INSERT INTO node (uid, kind, name, level, t_created, t_valid, meta)
         VALUES (?, 'community', ?, 0, ?, ?, ?) RETURNING rowid`,
        [cluster.community_uid, cluster.label, now, now, metaJson],
      );
      if (!insertResult) continue;
      recordCommunityLifecycle(opts.storeKey ?? DEFAULT_STORE_KEY, { created: 1 });
      communityRowid = insertResult.rowid;
    }

    for (const memberRowid of cluster.member_rowids) {
      await adapter.executeRun(
        `INSERT INTO edge (src, dst, rel, origin, weight, t_created)
         VALUES (?, ?, 'MEMBER_OF', 'inferred', 1.0, ?)
         ON CONFLICT(src, dst, rel) DO UPDATE SET t_invalid = NULL`,
        [memberRowid, communityRowid, now],
      );
    }
  }
}

/**
 * Persist a zero-member "lens marker" for a subset recluster that produced no
 * communities (BL-153). The marker is a `kind='community'` node tagged with
 * `cluster_scope.marker = true`, carrying the provenance hash and filter but no
 * MEMBER_OF edges. It makes an otherwise-empty lens visible to `listSubsetLenses`
 * and removable via `dropSubsetLens`, while `community_count` reporting excludes
 * it. The uid is derived from the hash so re-runs upsert the same marker node.
 */
export async function materializeLensMarker(
  adapter: StoreAdapter,
  provenanceHash: string,
  filter: unknown = null,
): Promise<void> {
  const now = new Date().toISOString();
  const uid = communityUid([], `${provenanceHash}:__lens_marker__`);
  const metaJson = JSON.stringify({
    member_count: 0,
    cluster_scope: { kind: 'subset', hash: provenanceHash, filter, marker: true },
  });

  const existingRow = await adapter.executeGet<{ rowid: number }>(
    `SELECT rowid FROM node WHERE uid = ?`,
    [uid],
  );

  if (existingRow) {
    await adapter.executeRun(
      `UPDATE node SET t_invalid = NULL, name = ?, meta = ?, t_created = ? WHERE uid = ?`,
      ['(empty lens)', metaJson, now, uid],
    );
  } else {
    await adapter.executeRun(
      `INSERT INTO node (uid, kind, name, level, t_created, t_valid, meta)
       VALUES (?, 'community', ?, 0, ?, ?, ?)`,
      [uid, '(empty lens)', now, now, metaJson],
    );
  }
}

// ── Main exported functions ───────────────────────────────────────────────────

/**
 * Select candidate episodes for clustering: live episodes with content ≥
 * CLUSTER_MIN_CONTENT_LENGTH (D5.1, default 20 — tunable via
 * SOX_CLUSTER_MIN_CONTENT_LENGTH), optionally narrowed by an additive WHERE
 * clause against alias `n`.
 *
 * `restrict` is consumed verbatim from the same predicate builder the recall path
 * uses (`buildFiltersClause`), so subset selection and recall filtering share one
 * filter vocabulary (tags / topic / project_path / importance_min / time range).
 * `restrict.sql` MUST be an AND-prefixed clause over alias `n` (or empty).
 */
async function selectEpisodes(
  adapter: StoreAdapter,
  restrict?: { sql: string; params: unknown[] },
): Promise<EpRow[]> {
  const result = await adapter.executeAll<EpRow>(
    `SELECT n.rowid AS rowid, n.uid AS uid, n.content AS content, n.topic AS topic, n.name AS name,
            n.t_created AS t_created
     FROM node n
     WHERE ${EPISODE_CANDIDATE_PREDICATE}${restrict?.sql ?? ''}
     ORDER BY n.rowid ASC`,
    restrict?.params ?? undefined,
  );
  return result.rows;
}

/** The single full-vs-incremental decision for one pass (backlog 0c9c76b4 AC4). */
export interface ClusterPassDecision {
  mode: 'full' | 'incremental';
  /** Set iff a full pass was requested and refused for exceeding `nodeCap`. */
  degraded?: Extract<ClusterDegradation, { reason: 'nodeCap' }>;
}

/**
 * Resolve, ONCE, whether a pass runs full or incremental. `clusterStore` calls
 * this for its stage label and passes the decision down to `computeClusters`
 * for the branch, so the label and the branch cannot drift (they used to be two
 * hand-synchronised copies of the same predicate).
 *
 * Boundary: `episodeCount === nodeCap` is a full pass; `nodeCap + 1` degrades.
 */
export function resolveClusterPass(
  episodeCount: number,
  opts: { incrementalOnly?: boolean | undefined; nodeCap?: number | undefined },
): ClusterPassDecision {
  const nodeCap = opts.nodeCap ?? DEFAULT_CLUSTER_NODE_CAP;
  if (opts.incrementalOnly) return { mode: 'incremental' };
  if (episodeCount <= nodeCap) return { mode: 'full' };
  return { mode: 'incremental', degraded: { reason: 'nodeCap', episodeCount, nodeCap } };
}

interface ComputeClustersOptions {
  threshold?: number | undefined;
  nodeCap?: number | undefined;
  incrementalOnly?: boolean | undefined;
  /** Pre-resolved decision (clusterStore); resolved from `episodes.length` when absent. */
  pass?: ClusterPassDecision | undefined;
  budgetMs?: number | undefined;
  now?: (() => number) | undefined;
  /** UID salt for the produced communities (subset provenance; '' for global). */
  salt?: string | undefined;
  /** Metrics bucket — the store's `dbPath`. See {@link DEFAULT_STORE_KEY}. */
  storeKey?: string | undefined;
}

/** Scope predicate over a community node's `meta` column (alias `n`), matching `salt`. */
function communityScopeClause(salt: string): string {
  return salt
    ? `json_extract(n.meta, '$.cluster_scope.hash') = ?`
    : `(json_extract(n.meta, '$.cluster_scope.kind') IS NULL OR json_extract(n.meta, '$.cluster_scope.kind') = 'global')`;
}

/**
 * BL-349/BL-326: write-triggered incremental association (PKT-29, per
 * `pkt28-clustering-strategy.md` §2.2). Answers "which EXISTING community does
 * a new episode join" in O(unclustered × live members), never a full O(n²)
 * re-cluster over the whole corpus. This is the reachable replacement for the
 * dead `incrementalOnly` stub that previously always returned `clusters: []`
 * (BL-326: with the corpus past `nodeCap`, or simply run with
 * `incrementalOnly:true` as the periodic tick does, NO ordinary write could
 * ever result in a cluster assignment).
 *
 * ── Metric: single-link (max similarity to ANY live member), NOT centroid ──
 * The full pass's τ is calibrated against pairwise cosine similarity under
 * single-linkage connected components (D1: an episode joins a cluster if it
 * is within τ of ANY existing member, and clusters transitively chain through
 * such links). A candidate-vs-CENTROID (mean-of-members) comparison is a
 * DIFFERENT metric with a systematically higher expected value — measured
 * directly on three real BL-328 topic cohorts, mean pairwise vs. mean
 * to-centroid similarity differs by +0.086 to +0.127. Reusing τ=0.87 against
 * a centroid comparison behaves like roughly τ=0.78 in the domain τ was
 * actually calibrated in — well past the point PKT-28 measured as degenerate
 * (τ=0.82 already gives largest-cluster ratio 0.759 at full corpus scale).
 * Shipping a centroid comparison at the pairwise-calibrated τ would silently
 * re-introduce the exact percolation failure the research ruled out. So this
 * function compares each candidate against every LIVE member vector of each
 * candidate community and takes the max — the same connectivity test the
 * full pass itself uses, just evaluated incrementally instead of over the
 * whole corpus at once.
 *
 * ── Degenerate guard, incremental-path equivalent ──
 * The full pass's guard (`computeClusters` above, D5.5: max_cluster/total >
 * 0.5 → raise τ by 0.05 and retry) cannot be reused verbatim here — this
 * function only ever sees a slice of candidates for ONE pass and does not
 * own τ (only a full pass may recompute it, per §2.2). Instead: once a
 * community's LIVE member count (existing + joined so far THIS pass) would
 * exceed 50% of total live episodes, no further candidate may join it during
 * this pass — it is left unclustered for the next full/subset pass to
 * reconcile (§2.2/§3 of the research: split/merge/orphan reconciliation is
 * explicitly a full-pass responsibility, not this O(1)-per-write step's).
 * This stops incremental joins from being ABLE to grow a single community
 * past the same degenerate bound the full pass enforces, without this
 * function ever touching τ itself.
 *
 * Interim threshold policy (explicitly scoped, not silently hardcoded): per
 * §2.2 of the research, an incremental join reuses the CURRENT threshold
 * as-is — it never recomputes τ, because a single write does not change N or
 * the similarity distribution enough to justify recalibration; only a full
 * pass recomputes τ. The target-degree calibration function that replaces a
 * fixed τ for FULL passes is PKT-30 (BL-328) — out of scope here. When
 * PKT-30 lands, `resolveDefaultThreshold()` becomes a function of sampled
 * data and this join simply keeps consuming whatever `threshold` its caller
 * resolves, unchanged.
 *
 * Does not create new communities (that remains a full/subset pass's job).
 *
 * 050ba52f: in the same transaction as each join's MEMBER_OF insert,
 * `meta.member_count` of the receiving community is rewritten to its live
 * MEMBER_OF count, because
 * `memory_get_community` reads `memberCount` straight from `meta`. The
 * community uid is deliberately NOT recomputed (owner ruling K0 32a2a24e: the
 * first-minted uid stays stable; member overlap inherits it), so a join never
 * mints, re-derives, or supersedes an identity. The `joined` outcome counter
 * (`recordJoinOutcome`) is the join-rate instrument that the old stale-count
 * drift used to be by accident (note 37d0a0df) — it must keep firing per join.
 * `mean_intra_sim` and `centroid_rowid` stay at their materialize-time values;
 * they describe the cluster as scored, not its live size.
 */
async function incrementalJoin(
  adapter: StoreAdapter,
  episodes: EpRow[],
  threshold: number,
  salt: string,
  storeKey: string,
): Promise<{ joined: number; candidate_count: number; admission: ClusterAdmissionStats }> {
  // BL-496: every early return below is a DISTINCT reason nothing clustered,
  // and the pre-fix code collapsed all of them into an indistinguishable
  // `{joined: 0}`. `community_targets: 0` in particular is the one that means
  // "no episode can EVER be assigned on this path", not "nothing matched".
  const emptyAdmission = (targets: number, considered = 0): ClusterAdmissionStats => ({
    threshold,
    considered,
    joined: 0,
    rejected_degenerate_guard: 0,
    rejected_below_threshold: 0,
    rejected_near_miss: 0,
    rejected_best_sim: { p50: 0, p90: 0, max: 0 },
    community_targets: targets,
  });

  if (episodes.length === 0) return { joined: 0, candidate_count: 0, admission: emptyAdmission(0) };

  const scopeClause = communityScopeClause(salt);
  const scopeParams = salt ? [salt] : [];

  // 1. Live communities in this scope (global salt='' or a specific subset
  //    provenance hash) — the join targets.
  const communityRows = (
    await adapter.executeAll<{ community_rowid: number }>(
      `SELECT n.rowid AS community_rowid
       FROM node n
       WHERE n.kind = 'community' AND n.t_invalid IS NULL AND ${scopeClause}`,
      scopeParams,
    )
  ).rows;
  if (communityRows.length === 0) {
    // No live community in scope to join to. Every episode this pass would have
    // considered is excluded for a reason that lives in the COMMUNITY table, not
    // the vector table or τ — recorded distinctly so an empty/freshly-wiped
    // partition cannot be misread as a threshold problem.
    recordJoinOutcome(storeKey, 'no_target', episodes.length);
    return { joined: 0, candidate_count: 0, admission: emptyAdmission(0, episodes.length) };
  }
  const communityRowids = communityRows.map((r) => r.community_rowid);

  // 2. ALL live member vectors per community — the single-link comparison
  //    set (see doc comment: NOT centroid-only). One JOIN query, not one
  //    query per community.
  const memberRows = (
    await adapter.executeAll<{ community_rowid: number; node_id: number; embedding: Buffer }>(
      `SELECT e.dst AS community_rowid, v.node_id AS node_id, v.embedding AS embedding
       FROM edge e
       JOIN vec_node v ON v.node_id = e.src
       WHERE e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
         AND e.dst IN (${communityRowids.map(() => '?').join(',')})`,
      communityRowids as unknown[],
    )
  ).rows;

  const communityMemberVecs = new Map<number, Float32Array[]>();
  const communityLiveMemberCount = new Map<number, number>();
  for (const row of memberRows) {
    const vecs = communityMemberVecs.get(row.community_rowid) ?? [];
    vecs.push(blobToFloat32(row.embedding));
    communityMemberVecs.set(row.community_rowid, vecs);
    communityLiveMemberCount.set(row.community_rowid, (communityLiveMemberCount.get(row.community_rowid) ?? 0) + 1);
  }
  if (communityMemberVecs.size === 0) {
    // Communities exist but none has a single live member vector, so there is
    // nothing to compare against — structurally the same exclusion as having no
    // community at all, and counted the same way.
    recordJoinOutcome(storeKey, 'no_target', episodes.length);
    return { joined: 0, candidate_count: 0, admission: emptyAdmission(0, episodes.length) };
  }

  // 3. Episodes already MEMBER_OF a live community in this scope — excluded
  //    from candidacy (the `assignedSet` below is exactly the src side of
  //    the query in step 2, reused rather than re-queried).
  const assignedSet = new Set(memberRows.map((r) => r.node_id));
  const candidates = episodes.filter((e) => !assignedSet.has(e.rowid));
  /** rowid → t_created, for the time-to-community stamp at join. */
  const candidateCreatedAt = new Map<number, string | null>(
    candidates.map((e) => [e.rowid, e.t_created]),
  );
  if (candidates.length === 0) return { joined: 0, candidate_count: 0, admission: emptyAdmission(communityMemberVecs.size, 0) };

  // 3b. Rejection watermark (BL-cluster-watermark). A candidate rejected on
  //     similarity or no-target is a pure function of (threshold, live member
  //     set, its own vector). While none of those change, re-evaluating it on
  //     every tick is wasted work — live data showed 5,506 unassigned candidates
  //     rescanned against every member each tick with zero joins (543 of 549
  //     passes). The watermark records the rowid up to which every candidate was
  //     decided, and only candidates above it are evaluated. See
  //     `readIncrementalWatermark` for the invalidation rules.
  const wmKey = incrementalWatermarkKey(storeKey, salt);
  const membership = membershipFingerprint(communityRowids, memberRows);
  const stored = await readIncrementalWatermark(adapter, wmKey);
  const belowWatermark = (wm: number): number => candidates.reduce((n, e) => (e.rowid <= wm ? n + 1 : n), 0);
  const watermarkUsable =
    stored !== null &&
    stored.threshold === threshold &&
    stored.membership === membership &&
    Date.now() - Date.parse(stored.fullScanAt) < INCREMENTAL_WATERMARK_BACKSTOP_MS &&
    belowWatermark(stored.rowid) <= stored.belowCount;
  const scanFrom = watermarkUsable && stored ? stored.rowid : 0;
  const toEvaluate = candidates.filter((e) => e.rowid > scanFrom);
  log.info('cluster.incremental.scan', {
    store_key: storeKey,
    mode: scanFrom === 0 ? 'full' : 'resumed',
    scanned: toEvaluate.length,
    skipped: candidates.length - toEvaluate.length,
    scan_from_rowid: scanFrom,
  });
  /** Lowest rowid still undecided this pass (missing vector or guard-rejected). */
  let blockedRowid: number | null = null;
  // Persists the watermark for this pass. Runs on EVERY exit that has a candidate
  // set, not only the full path: `belowCount` must track the live candidate set,
  // or a count left stale-high by an early return hides a later un-invalidation.
  const persistWatermark = async (): Promise<void> => {
    const evaluatedMax = toEvaluate.reduce((m, e) => Math.max(m, e.rowid), scanFrom);
    const nextWatermark = blockedRowid === null ? evaluatedMax : Math.min(evaluatedMax, blockedRowid - 1);
    await writeIncrementalWatermark(adapter, wmKey, {
      threshold,
      membership,
      rowid: nextWatermark,
      belowCount: belowWatermark(nextWatermark),
      // `scanFrom > 0` only when a usable watermark was read, so `stored` is set.
      fullScanAt: scanFrom === 0 || !stored ? new Date().toISOString() : stored.fullScanAt,
    });
  };
  if (toEvaluate.length === 0) {
    await persistWatermark();
    return { joined: 0, candidate_count: candidates.length, admission: emptyAdmission(communityMemberVecs.size, 0) };
  }

  // 4. Vectors for the candidates that still need a decision.
  const evalRowids = toEvaluate.map((e) => e.rowid);
  const candidateVecResult = await adapter.executeAll<VecRow>(
    `SELECT node_id, embedding FROM vec_node WHERE node_id IN (${evalRowids.map(() => '?').join(',')})`,
    evalRowids as unknown[],
  );
  // Candidates with no `vec_node` row can never be compared to anything. This is
  // an EMBEDDING-pipeline backlog surfacing inside clustering, and conflating it
  // with `below_threshold` would point an investigation at τ when the actual
  // cause is an unembedded episode. Counted here (and not only in the
  // zero-rows early return) so a PARTIALLY-embedded candidate set is still
  // attributed correctly. A missing vector also BLOCKS the watermark: the
  // candidate must be re-examined once its vector lands.
  const vecIds = new Set(candidateVecResult.rows.map((r) => r.node_id));
  const missingRowids = evalRowids.filter((rowid) => !vecIds.has(rowid));
  blockedRowid = missingRowids.length > 0 ? Math.min(...missingRowids) : null;
  const missingVectors = missingRowids.length;
  recordJoinOutcome(storeKey, 'no_vector', missingVectors);
  if (candidateVecResult.rows.length === 0) {
    await persistWatermark();
    return { joined: 0, candidate_count: candidates.length, admission: emptyAdmission(communityMemberVecs.size, 0) };
  }

  // 5. Total live episode count — denominator for the degenerate-ratio guard.
  const totalLiveRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL`,
  );
  const totalLiveEpisodes = totalLiveRow?.cnt ?? candidates.length;

  // 6. For each candidate (deterministic order — `episodes` is already
  //    rowid-ASC per `selectEpisodes`), join the community with the highest
  //    single-link (max-over-members) similarity if it clears `threshold`
  //    AND admitting it would not push that community over the degenerate
  //    bound (D5.5's 0.5 ratio, mirrored here per-pass). Otherwise leave the
  //    candidate unclustered for the next full/subset pass.
  const now = new Date().toISOString();
  let joined = 0;
  const joinedThisPass = new Map<number, number>(); // community_rowid -> count joined so far this call
  // BL-496: admission accounting. `rejectedSims` collects the max-similarity
  // each rejected candidate actually achieved — the number the pre-fix code
  // computed on every tick and dropped on the floor, leaving "will never
  // cluster" and "has not been looked at yet" indistinguishable.
  const rejectedSims: number[] = [];
  let rejectedGuard = 0;
  const NEAR_MISS_BAND = 0.02;

  for (const vRow of candidateVecResult.rows) {
    const candidateVec = blobToFloat32(vRow.embedding);
    let bestCommunityRowid: number | null = null;
    let bestSim = -1;
    for (const [communityRowid, memberVecs] of communityMemberVecs) {
      for (const memberVec of memberVecs) {
        const sim = cosineSim(candidateVec, memberVec);
        if (sim > bestSim) {
          bestSim = sim;
          bestCommunityRowid = communityRowid;
        }
      }
    }
    if (bestCommunityRowid === null || bestSim < threshold) {
      // The ONLY outcome meaning "considered and rejected on similarity". A
      // rising count here is a τ-calibration signal; every other exclusion
      // outcome in this function is reached without a comparison ever happening.
      recordJoinOutcome(storeKey, 'below_threshold');
      // BL-496: capture bestSim for the admission distribution — gate on
      // `bestCommunityRowid !== null` so a genuine no-community-to-compare
      // case is distinguishable from a sub-threshold result.
      if (bestCommunityRowid !== null) rejectedSims.push(bestSim);
      continue;
    }

    const priorSize = communityLiveMemberCount.get(bestCommunityRowid) ?? 0;
    const alreadyJoinedThisPass = joinedThisPass.get(bestCommunityRowid) ?? 0;
    const projectedSize = priorSize + alreadyJoinedThisPass + 1;
    if (totalLiveEpisodes > 0 && projectedSize / totalLiveEpisodes > 0.5) {
      // Degenerate-ratio guard (incremental-path equivalent of D5.5): this
      // community would become a majority blob — refuse, defer to the next
      // full/subset pass, which owns re-thresholding and reconciliation.
      //
      // Counted separately from `below_threshold` because the episode DID clear
      // τ: the guard excluded it, not the similarity. Tuning τ in response to
      // this count would be the wrong lever.
      recordJoinOutcome(storeKey, 'degenerate_guard');
      // BL-496: counted separately from below_threshold — this candidate
      // DID clear τ and is genuinely deferred, not excluded.
      rejectedGuard++;
      // The guard's outcome depends on the live episode total, which moves on
      // every write, so a guard-rejected candidate is not a stable decision and
      // must hold the watermark below it.
      blockedRowid = blockedRowid === null ? vRow.node_id : Math.min(blockedRowid, vRow.node_id);
      continue;
    }

    // 050ba52f: the MEMBER_OF insert and the community's member_count recount
    // commit in ONE transaction, so a crash or a failed UPDATE can never leave
    // an edge counted by `memory_get_community` as absent. The count is
    // recomputed from live edges (not incremented): a revived edge (the ON
    // CONFLICT branch) and any earlier drift converge on the truth.
    const joinedCommunityRowid = bestCommunityRowid;
    await adapter.transaction(async (tx) => {
      await tx.executeRun(
        `INSERT INTO edge (src, dst, rel, origin, weight, t_created)
         VALUES (?, ?, 'MEMBER_OF', 'inferred', 1.0, ?)
         ON CONFLICT(src, dst, rel) DO UPDATE SET t_invalid = NULL`,
        [vRow.node_id, joinedCommunityRowid, now],
      );
      await tx.executeRun(
        `UPDATE node SET meta = json_set(COALESCE(meta, '{}'), '$.member_count',
                (SELECT COUNT(*) FROM edge
                  WHERE dst = ? AND rel = 'MEMBER_OF' AND t_invalid IS NULL))
          WHERE rowid = ?`,
        [joinedCommunityRowid, joinedCommunityRowid],
      );
    });
    joinedThisPass.set(bestCommunityRowid, alreadyJoinedThisPass + 1);
    recordJoinOutcome(storeKey, 'joined');
    // The MEMBER_OF insert above is the exact moment this episode becomes
    // visible to memory_get_community, so the clock stops HERE rather than at
    // end-of-pass. Wall-clock by necessity — the write happened in an earlier
    // tick, usually an earlier process, so no monotonic start stamp survives.
    // See cluster-metrics.ts's CLOCK DECISION.
    const createdAt = candidateCreatedAt.get(vRow.node_id);
    if (createdAt !== undefined && createdAt !== null) {
      const createdMs = Date.parse(createdAt);
      if (Number.isFinite(createdMs)) {
        recordTimeToCommunity(storeKey, Date.parse(now) - createdMs);
      }
    }
    // Deliberately NOT added to `communityMemberVecs` as a comparison target
    // for later candidates in this same pass: doing so would let candidates
    // chain transitively through EACH OTHER within a single tick, which is
    // extra percolation risk beyond what the degenerate-ratio guard above
    // was sized for. A candidate that only matches another freshly-joined
    // candidate (not an original live member) simply waits for the NEXT
    // periodic tick, by which time that candidate IS a live member — this
    // still converges, just one tick later, with a materially smaller blob
    // risk per pass.
    joined++;
  }

  // Advance the watermark past every candidate decided this pass, stopping just
  // below the lowest candidate that is still undecided (missing vector or
  // guard-rejected). The membership fingerprint was taken BEFORE this pass's
  // joins, so any join here makes the next tick re-check the rejected set against
  // the new member — the convergence the join loop's comment describes.
  await persistWatermark();

  // BL-496: summarise the rejected population. `sort` is over at most the
  // candidate count (bounded by the unassigned backlog), and only runs on
  // numbers already computed above — no extra similarity work.
  const sortedSims = [...rejectedSims].sort((a, b) => a - b);
  const at = (p: number): number =>
    sortedSims.length === 0 ? 0 : sortedSims[Math.min(sortedSims.length - 1, Math.floor((p / 100) * sortedSims.length))]!;

  return {
    joined,
    candidate_count: candidates.length,
    admission: {
      threshold,
      considered: candidateVecResult.rows.length,
      joined,
      rejected_degenerate_guard: rejectedGuard,
      rejected_below_threshold: rejectedSims.length,
      rejected_near_miss: rejectedSims.filter((s) => s >= threshold - NEAR_MISS_BAND).length,
      rejected_best_sim: { p50: at(50), p90: at(90), max: sortedSims.at(-1) ?? 0 },
      community_targets: communityMemberVecs.size,
    },
  };
}

/**
 * Rejection watermark for `incrementalJoin` (BL-cluster-watermark).
 *
 * Persisted in `sox_store_meta` per (storeKey, salt). `rowid` is the highest
 * candidate rowid decided with nothing left undecided below it. A stored
 * watermark is reused only while ALL of these hold; any miss forces a full
 * re-check of every unassigned candidate:
 *
 *  - `threshold` is unchanged — τ moves, every rejection moves with it.
 *  - `membership` (fingerprint of the live community set and every MEMBER_OF
 *    pair, taken before the pass's joins) is unchanged — a new member can
 *    make an old rejection a join.
 *  - `belowCount` has not grown — an unassigned candidate at or below the
 *    watermark can only appear through un-invalidation or revival of an old
 *    row (restore-neardup, the un-invalidate paths in this file). Shrinkage
 *    (near-dup invalidation) is harmless and does not force a rescan.
 *  - `fullScanAt` is within `INCREMENTAL_WATERMARK_BACKSTOP_MS` — a bounded
 *    staleness backstop for mutations that change a vector's similarity
 *    without touching membership (re-embeds). It is the time of the last FULL
 *    re-check, so resumed ticks do not extend it.
 */
export const INCREMENTAL_WATERMARK_BACKSTOP_MS = 6 * 60 * 60 * 1000;

interface IncrementalWatermark {
  threshold: number;
  membership: string;
  rowid: number;
  belowCount: number;
  fullScanAt: string;
}

function incrementalWatermarkKey(storeKey: string, salt: string): string {
  return `cluster_incremental_watermark:${storeKey}:${salt}`;
}

/** Stable fingerprint of the live join targets: community rowids plus every
 *  live MEMBER_OF pair. Any join, invalidation, or community change moves it. */
function membershipFingerprint(
  communityRowids: readonly number[],
  memberRows: readonly { community_rowid: number; node_id: number }[],
): string {
  const h = crypto.createHash('sha256');
  for (const c of [...communityRowids].sort((a, b) => a - b)) h.update(`c${c};`);
  const pairs = memberRows.map((r) => `${r.community_rowid}:${r.node_id}`).sort();
  for (const p of pairs) h.update(`m${p};`);
  return h.digest('hex');
}

async function readIncrementalWatermark(
  adapter: StoreAdapter,
  key: string,
): Promise<IncrementalWatermark | null> {
  const row = await adapter.executeGet<{ value: string }>(
    `SELECT value FROM sox_store_meta WHERE key = ?`,
    [key],
  );
  if (!row) return null;
  let parsed: Partial<IncrementalWatermark>;
  try {
    parsed = JSON.parse(row.value) as Partial<IncrementalWatermark>;
  } catch (err) {
    // A corrupt watermark is discarded (forcing a full re-check, which is always
    // correct), but never silently: the trace is the only evidence it happened.
    log.warn('cluster.incremental.watermark_unreadable', {
      key,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (
    typeof parsed.threshold !== 'number' ||
    typeof parsed.membership !== 'string' ||
    typeof parsed.rowid !== 'number' ||
    typeof parsed.belowCount !== 'number' ||
    typeof parsed.fullScanAt !== 'string'
  ) {
    return null;
  }
  return parsed as IncrementalWatermark;
}

async function writeIncrementalWatermark(
  adapter: StoreAdapter,
  key: string,
  watermark: IncrementalWatermark,
): Promise<void> {
  await adapter.executeRun(
    `INSERT INTO sox_store_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [key, JSON.stringify(watermark)],
  );
}

/**
 * Pure clustering core shared by `clusterStore` (global) and `clusterSubset`
 * (filtered): fetch vectors for the given episodes, run the degenerate-guarded
 * connected-components pass, and return cluster descriptors. NO DB writes —
 * persistence is the caller's choice via `materializeClusters`.
 */
async function computeClusters(
  adapter: StoreAdapter,
  episodes: EpRow[],
  opts: ComputeClustersOptions = {},
): Promise<ClusterStoreResult> {
  // Un-calibrated seed. A full pass RE-RESOLVES this below, once it has the
  // vectors calibration needs (PKT-30). An explicit `opts.threshold` is an
  // absolute override at every layer — callers that pass one mean it.
  const threshold = opts.threshold ?? resolveDefaultThreshold();
  const salt = opts.salt ?? '';

  if (episodes.length < 2) {
    return { clusters: [], full_pass: true, unclustered_count: episodes.length };
  }

  const decision = opts.pass ?? resolveClusterPass(episodes.length, opts);
  if (decision.mode !== 'full') {
    // BL-349/BL-326: incremental mode now performs a real, O(1)-per-episode
    // local-neighborhood join against existing communities (createGraphBackend
    // has already run in the caller — clusterStore/clusterSubset — before
    // selectEpisodes, so `node`/`edge` are guaranteed to exist here).
    const { joined, candidate_count, admission } = await incrementalJoin(
      adapter,
      episodes,
      threshold,
      salt,
      opts.storeKey ?? DEFAULT_STORE_KEY,
    );
    return {
      clusters: [],
      full_pass: false,
      unclustered_count: candidate_count - joined,
      incremental_joined: joined,
      admission,
      ...(decision.degraded ? { degraded: decision.degraded } : {}),
    };
  }

  const now = opts.now ?? (() => performance.now());
  const budgetMs = opts.budgetMs ?? DEFAULT_FULL_PASS_BUDGET_MS;
  const startedAt = now();
  /** Duration of the most recent all-pairs run — the best predictor of the next one. */
  let lastPassMs = 0;
  /**
   * Elapsed ms if starting another all-pairs run now would not fit the budget,
   * else null. `elapsed` is measured from the start of the pass, so it already
   * includes vector loading and calibration. Before the first run
   * `lastPassMs` is 0 and this reduces to `elapsed > budgetMs` (the setup alone
   * spent the budget); before a guard RETRY, `elapsed + lastPassMs` predicts
   * that the retry costs about what the pass before it cost, so a retry that
   * cannot finish inside the budget is refused up front rather than started and
   * killed by the parent's SIGTERM.
   */
  const wontFit = (): number | null => {
    const elapsed = now() - startedAt;
    return elapsed + lastPassMs > budgetMs ? elapsed : null;
  };

  const rowids = episodes.map((e) => e.rowid);
  const rowidToEp = new Map<number, EpRow>(episodes.map((e) => [e.rowid, e]));

  const vecResult = await adapter.executeAll<VecRow>(
    `SELECT node_id, embedding FROM vec_node
     WHERE node_id IN (${rowids.map(() => '?').join(',')})
     ORDER BY node_id ASC`,
    rowids as unknown[],
  );
  const vecRows = vecResult.rows;

  const rowidToVec = new Map<number, Float32Array>();
  for (const vRow of vecRows) {
    rowidToVec.set(vRow.node_id, blobToFloat32(vRow.embedding));
  }

  const candidateRowids = rowids.filter((r) => rowidToVec.has(r));
  const candidateVecs = candidateRowids.map((r) => rowidToVec.get(r)!);

  if (candidateRowids.length < 2) {
    return { clusters: [], full_pass: true, unclustered_count: candidateRowids.length };
  }

  // ── PKT-30 / BL-328: target-mean-degree calibration ──────────────────────
  // Only a FULL pass may recompute τ (§2.2: a single write changes neither N
  // nor the similarity distribution enough to justify it), and only when the
  // caller did not name a threshold explicitly. The vectors are already in
  // hand, so calibration costs one bounded O(sample²) scan — measured 148ms
  // against a 23.4s pass at N=4950.
  const calibration =
    opts.threshold === undefined
      ? calibrateThreshold(candidateVecs, candidateRowids.length, resolveTargetMeanDegree())
      : null;
  const passThreshold = calibration?.threshold ?? threshold;

  // Degenerate-cluster guard (D5.5): retry up to 3 times with threshold+0.05.
  // With calibration in front of it this should now be a backstop that rarely
  // fires (PKT-28 §2, and BL-328 §5.4 — "the guard must not be the mechanism"),
  // not the thing quietly doing the real calibration.
  let currentThreshold = passThreshold;
  let attempts = 0;
  let clusters: ClusterResult[] = [];

  while (attempts < 4) {
    // Deadline: checked BEFORE every (re)run of the all-pairs pass (see
    // `wontFit`). Nothing has been written at this point (`computeClusters` is
    // pure; persistence is the caller's single transaction), so abandoning
    // leaves the previous partition exactly as it was.
    //
    // In practice this fires in exactly two situations: (1) before the first
    // run, when vector loading + calibration alone consumed the budget; and
    // (2) before a D5.5 guard RETRY that is predicted not to fit. In case (2)
    // the pass that just finished was REJECTED by the degenerate guard (its
    // largest cluster held more than half the corpus), so there is no
    // acceptable partition to keep: it is discarded (`clusters: []`) and the
    // previous partition stays. A run in flight is never interrupted — it is
    // synchronous and uninterruptible inside `@adhd/sox-analysis`; that is why
    // `nodeCap`, not this budget, bounds a single run.
    const overBy = wontFit();
    if (overBy !== null) {
      return {
        clusters: [],
        full_pass: false,
        unclustered_count: candidateRowids.length,
        guard_retries: attempts,
        effective_threshold: currentThreshold,
        degraded: {
          reason: 'budget',
          episodeCount: candidateRowids.length,
          budgetMs,
          elapsedMs: overBy,
        },
      };
    }
    const clusterInput = candidateRowids.map((id, i) => ({ id, vec: candidateVecs[i]! }));
    const passStartedAt = now();
    const groups = runClusters(clusterInput, currentThreshold);
    lastPassMs = now() - passStartedAt;
    const maxClusterSize = Math.max(...Array.from(groups.values()).map((g) => g.length), 0);
    const ratio = maxClusterSize / candidateRowids.length;

    if (ratio <= 0.5 || attempts === 3) {
      clusters = buildClusterResults(groups, rowidToVec, rowidToEp, salt);
      break;
    }

    currentThreshold = Math.min(currentThreshold + 0.05, 0.99);
    attempts++;
  }

  const totalClustered = clusters.reduce((sum, c) => sum + c.member_rowids.length, 0);
  return {
    clusters,
    full_pass: true,
    unclustered_count: candidateRowids.length - totalClustered,
    ...(calibration ? { calibration } : {}),
    guard_retries: attempts,
    effective_threshold: currentThreshold,
  };
}

/**
 * Run cosine-threshold connected-components clustering over ALL live episodes (E6, D1)
 * and persist the result as the GLOBAL community partition.
 *
 * @param adapter StoreAdapter (write-capable).
 * @param opts   Tuning parameters.
 * @returns      ClusterStoreResult with all cluster descriptors.
 */
export async function clusterStore(
  adapter: StoreAdapter,
  opts: ClusterStoreOptions = {},
): Promise<ClusterStoreResult> {
  // GraphBackend ensures the canonical DDL (including ix_edge_unique) is applied.
  getMemoryGraphBackend(adapter);

  const storeKey = opts.storeKey ?? DEFAULT_STORE_KEY;

  // `withContendedStage` fixes the path label BEFORE `admit` runs, but the
  // full-vs-incremental branch depends on the candidate COUNT — which
  // `selectEpisodes` only learns by running. Resolving that with
  // `opts.incrementalOnly` alone would mislabel the case that matters most: a
  // full-pass request that silently degraded to incremental because it exceeded
  // `nodeCap`. So the count is resolved first, from the predicate
  // `selectEpisodes` uses (`EPISODE_CANDIDATE_PREDICATE` — one constant, so the
  // two cannot drift), making the stage label provably equal to the branch
  // taken. One indexed COUNT is negligible beside a pass that loads thousands
  // of vectors. The decision is made HERE, once (`resolveClusterPass`), and
  // handed to `computeClusters` — the label and the branch read the same value
  // rather than two copies of one predicate.
  const countRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM node n WHERE ${EPISODE_CANDIDATE_PREDICATE}`,
  );
  const decision = resolveClusterPass(countRow?.cnt ?? 0, opts);
  const path: ClusterPassPath = decision.mode === 'full' ? 'full' : 'incremental';

  let episodes: EpRow[] = [];
  return MEMORY_CORE_STAGES.withContendedStage(
    'cluster',
    path,
    // `wait` = assembling what the pass will consider; `work` = comparing and
    // persisting it. See stages.ts for why the split is drawn here.
    async () => {
      episodes = await selectEpisodes(adapter);
    },
    async () => {
      const result = await computeClusters(adapter, episodes, {
        threshold: opts.threshold,
        nodeCap: opts.nodeCap,
        incrementalOnly: opts.incrementalOnly,
        pass: decision,
        budgetMs: opts.budgetMs,
        now: opts.now,
        storeKey,
      });

      if (result.clusters.length > 0) {
        await adapter.transaction(async () => {
          await materializeClusters(adapter, result.clusters, { scope: 'global', storeKey });
        });
      }

      // A budget-aborted pass computed and wrote nothing: it is not a completed
      // `full` pass and must not inflate `passes_full` or trigger the
      // full-pass-only quality measurement. The backlog gauge is still read (a
      // cheap COUNT that stays true), under the non-full path so quality is
      // skipped. A nodeCap refusal already carries `path === 'incremental'`
      // (the incremental join genuinely ran), so it is counted as what it was.
      const completedPass = result.degraded?.reason !== 'budget';
      if (completedPass) recordClusterPass(storeKey, path);
      await measureBacklog(adapter, storeKey, completedPass ? path : 'incremental');
      emitClusterPassEvent(storeKey, path, result);
      return result;
    },
  );
}

/**
 * Emit this pass's counters to the DURABLE JSONL log.
 *
 * ## Why this exists in addition to the in-memory counters
 *
 * Production clustering does not run in the server process. The periodic tick
 * calls `runEnrichIsolated`, which forks a CHILD process (BL-348), so every
 * counter `cluster-metrics.ts` accumulates lives and dies in that child —
 * `memory_ping`, running in the parent, would read `null` forever.
 *
 * That is precisely the BL-319 defect this repo has already been bitten by
 * twice: an instrument wired to a path the observed process never executes,
 * which passes every in-process test while reading zero in production. The
 * in-memory counters remain correct and useful for the in-process callers
 * (tests, `memory_curate`, any future in-process pass); this event is what makes
 * the numbers survive the process boundary, because the JSONL sink is
 * per-process and the child writes to the same log directory.
 *
 * Emitted as ONE line per pass with the pass's own totals rather than one line
 * per candidate: a full pass considers thousands of episodes, and per-candidate
 * lines would make the log unreadable and the write cost non-trivial on the
 * exact path we are trying to measure.
 */
function emitClusterPassEvent(
  storeKey: string,
  path: ClusterPassPath,
  result: ClusterStoreResult,
): void {
  const m = getClusterMetrics(storeKey);
  log.info('cluster.pass', {
    store_key: storeKey,
    path,
    full_pass: result.full_pass,
    ...(result.degraded ? { degraded: result.degraded } : {}),
    clusters: result.clusters.length,
    unclustered_count: result.unclustered_count,
    incremental_joined: result.incremental_joined ?? 0,
    ...(result.effective_threshold !== undefined
      ? { effective_threshold: result.effective_threshold }
      : {}),
    // Cumulative for this process — a reader diffs consecutive lines to get the
    // per-pass delta. Absolute values are what survive a missed line; deltas
    // would not.
    ...(m
      ? {
          joins_joined: m.counters.joins_joined,
          joins_below_threshold: m.counters.joins_below_threshold,
          joins_degenerate_guard: m.counters.joins_degenerate_guard,
          joins_no_vector: m.counters.joins_no_vector,
          joins_no_target: m.counters.joins_no_target,
          communities_created: m.counters.communities_created,
          communities_invalidated: m.counters.communities_invalidated,
          communities_revived: m.counters.communities_revived,
          member_edges_invalidated: m.counters.member_edges_invalidated,
          backlog_unclustered: m.backlog?.unclustered ?? null,
          backlog_oldest_ms: m.backlog?.oldest_unclustered_ms ?? null,
          // Latency and its denominator travel TOGETHER in one line, on
          // purpose. A p50 emitted without `never_clustered` and `join_rate`
          // beside it can be read as "the system is fast" when it is only
          // being selective — and a reader grepping the log for latency must
          // not be able to find one without the other.
          time_to_community_p50_ms_among_joined: m.time_to_community_ms_among_joined.p50,
          time_to_community_p99_ms_among_joined: m.time_to_community_ms_among_joined.p99,
          time_to_community_samples: m.time_to_community_samples,
          never_clustered: m.never_clustered,
          join_rate: m.join_rate,
          // Quality alongside latency: a latency win that moves any of these
          // the wrong way is a regression, and the two must be readable from
          // the same line rather than correlated across two investigations.
          ...(m.quality
            ? {
                coverage: m.quality.coverage,
                mean_intra_sim: m.quality.mean_intra_sim,
                mean_inter_sim: m.quality.mean_inter_sim,
                largest_cluster_size: m.quality.largest_cluster_size,
                community_count: m.quality.community_count,
                single_member_clusters: m.quality.single_member_clusters,
              }
            : {}),
        }
      : {}),
  });
}

/**
 * Measure the live unclustered backlog and its age, and record it as a gauge.
 *
 * Deliberately measured AFTER the pass, off `edge` rows rather than off the
 * pass's own return value: `unclustered_count` in `ClusterStoreResult` counts
 * only what THIS pass considered, so it reads 0 on a pass that never got to
 * compare anything — precisely the situation the backlog gauge exists to make
 * visible. Reading the store directly cannot be fooled that way.
 *
 * Best-effort: a failure here must never fail a clustering pass, since this is
 * an instrument, not a step.
 */
async function measureBacklog(
  adapter: StoreAdapter,
  storeKey: string,
  path: ClusterPassPath,
): Promise<void> {
  try {
    const row = await adapter.executeGet<{ cnt: number; oldest: string | null }>(
      `SELECT COUNT(*) AS cnt, MIN(n.t_created) AS oldest
       FROM node n
       WHERE n.kind = 'episode' AND n.t_invalid IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM edge e
           WHERE e.src = n.rowid AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
         )`,
    );
    if (!row) return;
    const oldestMs = row.oldest ? Date.parse(row.oldest) : NaN;
    recordBacklog(storeKey, row.cnt, Number.isFinite(oldestMs) ? Date.now() - oldestMs : 0);

    // The SAME census, recorded as the right-censored population. This is the
    // number that makes the <600ms target falsifiable: a p50 computed without
    // it is unfalsifiable in both directions, because the episodes that would
    // fail the target are exactly the ones missing from the sample.
    recordNeverClustered(storeKey, row.cnt);

    // Cluster QUALITY is measured only on a full pass, deliberately.
    //
    // `clusterStats` computes mean_inter_sim by loading each community's
    // centroid vector — one query per community (~443 live today). That is
    // affordable once per full pass, which already loads every vector in the
    // store, but running it on every incremental tick would add hundreds of
    // queries to the O(1)-per-episode path this subsystem exists to keep cheap.
    // Coverage and the censored census above are plain COUNTs and stay on every
    // pass, so the cheap signals never go stale between full passes.
    if (path !== 'full') return;

    const stats = await clusterStats(adapter);
    const singles = await adapter.executeGet<{ cnt: number }>(
      `SELECT COUNT(*) AS cnt FROM (
         SELECT e.dst FROM edge e
         JOIN node c ON c.rowid = e.dst AND c.kind = 'community' AND c.t_invalid IS NULL
         WHERE e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
         GROUP BY e.dst HAVING COUNT(*) = 1
       )`,
    );
    recordQuality(storeKey, {
      coverage: stats.coverage,
      mean_intra_sim: stats.mean_intra_sim,
      mean_inter_sim: stats.mean_inter_sim,
      largest_cluster_size: stats.largest_cluster_size,
      community_count: stats.cluster_count,
      // Counted separately because each single-member cluster contributes
      // mean_intra_sim = 1.0 BY CONSTRUCTION (cluster.ts's meanIntraSim returns
      // 1.0 for n<2), not by quality. Without this column, adopting singletons
      // would read as a quality improvement on the very dashboard meant to
      // catch that.
      single_member_clusters: singles?.cnt ?? 0,
    });
  } catch {
    /* instrument must not break the pass */
  }
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
  filter?: import('./memory-filters.js').MemoryFilter;
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
  /** Wall-clock budget for the pass (default {@link DEFAULT_FULL_PASS_BUDGET_MS}). */
  budgetMs?: number;
  /** Injectable monotonic-ms clock for the budget check (default `performance.now`). */
  now?: () => number;
  /**
   * When true, persist the produced communities to the DB under this filter's
   * provenance (scoped — does not touch global or other-filter communities).
   * Default false: a read-only synthesis query with no side effects.
   *
   * A DEGRADED pass (`degraded` set: refused over `nodeCap` or aborted on
   * `budget`) is never persisted, whatever this says: the result reports
   * `persisted: false` and an existing lens for the same filter is left exactly
   * as it was (backlog 0c9c76b4 AC11).
   */
  persist?: boolean;
  /** Metrics bucket — the store's `dbPath`. See {@link DEFAULT_STORE_KEY}. */
  storeKey?: string;
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
export async function clusterSubset(
  adapter: StoreAdapter,
  opts: ClusterSubsetOptions = {},
): Promise<ClusterSubsetResult> {
  // GraphBackend instance (sibling pattern)
  getMemoryGraphBackend(adapter);

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
  const storeKey = opts.storeKey ?? DEFAULT_STORE_KEY;

  let episodes: EpRow[] = [];
  const result = await MEMORY_CORE_STAGES.withContendedStage(
    'cluster',
    'subset',
    async () => {
      episodes = await selectEpisodes(adapter, restrict);
    },
    async () =>
      computeClusters(adapter, episodes, {
        threshold: opts.threshold,
        nodeCap: opts.nodeCap,
        budgetMs: opts.budgetMs,
        now: opts.now,
        salt: provenanceHash,
        storeKey,
      }),
  );
  recordClusterPass(storeKey, 'subset');

  // A degraded pass (nodeCap refusal or budget abort) produced no partition. It
  // must not be persisted: `materializeClusters` with zero clusters would
  // REPLACE this lens's existing communities with nothing. (Before 0c9c76b4 a
  // degraded persist:true pass DID write an empty lens + marker and returned
  // persisted:true; it now leaves the old lens untouched and reports
  // persisted:false — AC11.)
  let persisted = false;
  if (opts.persist && !result.degraded) {
    const filterRepr = opts.filter ?? opts.restrict?.sql ?? null;
    await adapter.transaction(async () => {
      await materializeClusters(adapter, result.clusters, {
        scope: 'subset',
        provenanceHash,
        filter: filterRepr,
        storeKey,
      });
      if (result.clusters.length === 0) {
        await materializeLensMarker(adapter, provenanceHash, filterRepr);
      }
    });
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
export async function clusterStats(adapter: StoreAdapter): Promise<ClusterStats> {
  // GraphBackend for node/edge CRUD (sibling pattern)
  getMemoryGraphBackend(adapter);

  // Scope all stats to GLOBAL communities only (kind='global' or legacy NULL scope).
  // Persisted subset lenses must NOT inflate the health/CI-gate numbers reported here.
  //
  // Two variants of the scope predicate:
  //  - `globalScopeUnaliased` — for single-table queries where `meta` is unambiguous.
  //  - `globalScopeDst`       — for JOIN queries; qualifies meta with the `dst` alias.
  const globalScopeUnaliased = `(json_extract(meta, '$.cluster_scope.kind') IS NULL OR json_extract(meta, '$.cluster_scope.kind') = 'global')`;
  const globalScopeDst = `(json_extract(dst.meta, '$.cluster_scope.kind') IS NULL OR json_extract(dst.meta, '$.cluster_scope.kind') = 'global')`;

  const clusterCountRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'community' AND t_invalid IS NULL AND ${globalScopeUnaliased}`,
  );
  const clusterCount = clusterCountRow?.cnt ?? 0;

  const totalClusteredRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt
     FROM edge e
     JOIN node src ON src.rowid = e.src AND src.kind = 'episode' AND src.t_invalid IS NULL
     JOIN node dst ON dst.rowid = e.dst AND dst.kind = 'community' AND dst.t_invalid IS NULL
       AND ${globalScopeDst}
     WHERE e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL`,
  );
  const totalClustered = totalClusteredRow?.cnt ?? 0;

  const totalEpisodeRow = await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM node WHERE kind = 'episode' AND t_invalid IS NULL`,
  );
  const totalEpisodes = totalEpisodeRow?.cnt ?? 0;
  const totalUnclustered = totalEpisodes - totalClustered;

  const largestRow = await adapter.executeGet<{ max_count: number | null }>(
    `SELECT MAX(member_count) AS max_count FROM (
       SELECT COUNT(*) AS member_count
       FROM edge e
       JOIN node dst ON dst.rowid = e.dst AND dst.kind = 'community' AND dst.t_invalid IS NULL
         AND (json_extract(dst.meta, '$.cluster_scope.kind') IS NULL
              OR json_extract(dst.meta, '$.cluster_scope.kind') = 'global')
       WHERE e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
       GROUP BY e.dst
     )`,
  );
  const largestClusterSize = largestRow?.max_count ?? 0;

  // Compute mean intra-cluster sim from community node metas.
  const communityNodeCols = (await adapter.executeAll<{ name: string }>(`PRAGMA table_info(node)`)).rows.map((c) => c.name);
  const hasMeta = communityNodeCols.includes('meta');

  const communityMetas = hasMeta
    ? (await adapter.executeAll<{ meta: string | null }>(
          `SELECT meta FROM node WHERE kind = 'community' AND t_invalid IS NULL AND meta IS NOT NULL
           AND (NOT json_valid(meta)
                OR json_extract(meta, '$.cluster_scope.kind') IS NULL
                OR json_extract(meta, '$.cluster_scope.kind') = 'global')`,
        )).rows
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
    ? (await adapter.executeAll<{ meta: string | null }>(
          `SELECT meta FROM node WHERE kind = 'community' AND t_invalid IS NULL AND meta IS NOT NULL
           AND (NOT json_valid(meta)
                OR json_extract(meta, '$.cluster_scope.kind') IS NULL
                OR json_extract(meta, '$.cluster_scope.kind') = 'global')`,
        )).rows
    : [];
  for (const row of communityRows) {
    if (!row.meta) continue;
    try {
      const m = JSON.parse(row.meta) as { centroid_rowid?: number };
      if (typeof m.centroid_rowid === 'number') {
        const vRow = await adapter.executeGet<VecRow>(
          `SELECT node_id, embedding FROM vec_node WHERE node_id = ?`,
          [m.centroid_rowid],
        );
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
export async function listSubsetLenses(adapter: StoreAdapter): Promise<SubsetLensDescriptor[]> {
  const result = await adapter.executeAll<{ meta: string | null; t_created: string }>(
    `SELECT meta, t_created FROM node
     WHERE kind = 'community' AND t_invalid IS NULL
       AND json_extract(meta, '$.cluster_scope.kind') = 'subset'
     ORDER BY t_created DESC`,
  );
  const rows = result.rows;

  // Group by provenance_hash
  const byHash = new Map<
    string,
    { community_count: number; last_updated: string; filter: unknown }
  >();

  for (const row of rows) {
    if (!row.meta) continue;
    let m: {
      cluster_scope?: { hash?: string; filter?: unknown; marker?: boolean };
      [k: string]: unknown;
    };
    try {
      m = JSON.parse(row.meta) as typeof m;
    } catch {
      continue;
    }
    const hash = m.cluster_scope?.hash;
    if (typeof hash !== 'string') continue;

    // A lens marker (BL-153) registers the lens's existence but contributes no
    // community to the count — it stands in for a zero-community recluster.
    const isMarker = m.cluster_scope?.marker === true;

    const existing = byHash.get(hash);
    if (!existing) {
      byHash.set(hash, {
        community_count: isMarker ? 0 : 1,
        last_updated: row.t_created,
        filter: m.cluster_scope?.filter ?? null,
      });
    } else {
      if (!isMarker) existing.community_count++;
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
export async function dropSubsetLens(
  adapter: StoreAdapter,
  provenanceHash: string,
): Promise<DropSubsetLensResult> {
  const now = new Date().toISOString();

  // Find all live community nodes owned by this lens.
  const priorResult = await adapter.executeAll<{ rowid: number }>(
    `SELECT rowid FROM node
     WHERE kind = 'community' AND t_invalid IS NULL
       AND json_extract(meta, '$.cluster_scope.hash') = ?`,
    [provenanceHash],
  );
  const priorIds = priorResult.rows.map((r) => r.rowid);

  if (priorIds.length === 0) {
    return { provenance_hash: provenanceHash, communities_dropped: 0, edges_dropped: 0 };
  }

  const ph = priorIds.map(() => '?').join(',');

  // Count edges to be invalidated before writing.
  const edgeCount = (await adapter.executeGet<{ cnt: number }>(
    `SELECT COUNT(*) AS cnt FROM edge
     WHERE rel = 'MEMBER_OF' AND t_invalid IS NULL AND dst IN (${ph})`,
    priorIds,
  ))?.cnt ?? 0;

  await adapter.transaction(async () => {
    await adapter.executeRun(`UPDATE node SET t_invalid = ? WHERE rowid IN (${ph})`, [now, ...priorIds]);
    await adapter.executeRun(
      `UPDATE edge SET t_invalid = ? WHERE rel = 'MEMBER_OF' AND t_invalid IS NULL AND dst IN (${ph})`,
      [now, ...priorIds],
    );
  });

  return {
    provenance_hash: provenanceHash,
    communities_dropped: priorIds.length,
    edges_dropped: edgeCount,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Context for target-mean-degree threshold calibration (PKT-30 / BL-328).
 * Sample pairwise cosine similarity on `sampleVecs`, compute P(edge≥τ) over a
 * candidate grid, and pick the smallest τ whose projected mean degree
 * P(edge≥τ)×(targetN−1) stays at/under `D_target` — see
 * docs/reporting/memory/findings/pkt28-clustering-strategy.md §2.
 *
 * When both fields are absent, `resolveDefaultThreshold` returns the floor
 * constant, which is the pre-calibration behaviour (BL-420's locked value).
 */
export interface ThresholdCalibrationContext {
  /** Bounded sample of live embedding vectors to estimate edge probability from. */
  sampleVecs?: Float32Array[];
  /** Corpus size (N) the calibration should target. */
  targetN?: number;
  /** Target mean node degree. Default `CLUSTER_TARGET_MEAN_DEGREE` (2.0). */
  targetMeanDegree?: number;
}

/**
 * Calibration floor. τ may be RAISED above this by calibration, never lowered.
 *
 * This is the value PKT-28 measured non-degenerate at the true full corpus
 * (N=4867: largest-cluster ratio 0.1806) and the value BL-420's regression
 * test locks for the un-calibrated path. A floor — rather than a free search
 * over the whole grid — is what makes calibration monotone-safe: on a corpus
 * small enough that a loose τ would "fit" the degree budget, calibration
 * cannot hand back a threshold looser than the one already proven safe, so it
 * can never re-introduce the percolation failure it exists to prevent.
 */
export const CLUSTER_THRESHOLD_FLOOR = 0.87;
/** Upper bound of the candidate grid. */
export const CLUSTER_THRESHOLD_CEILING = 0.99;
/** Candidate-grid step. */
const CLUSTER_THRESHOLD_STEP = 0.01;
/**
 * Target mean node degree D_target (PKT-28 §2 recommends 2.0).
 *
 * Swept directly at the live corpus (N=4950) before adoption — the resulting
 * τ, cluster count, largest-cluster ratio and clustered fraction:
 *
 * | D_target | τ | clusters | ratio | clustered_frac |
 * |---|---|---|---|---|
 * | 0.5 | 0.93 | 500 | 0.0073 | 0.323 |
 * | 1.0 | 0.91 | 555 | 0.0143 | 0.472 |
 * | 1.5 | 0.90 | 542 | 0.0218 | 0.543 |
 * | **2.0** | **0.89** | **506** | **0.0483** | **0.606** |
 * | 3.0+ | 0.87 (floor) | 441 | 0.1776 | 0.727 |
 *
 * 2.0 is the largest value at which calibration is currently *active* rather
 * than inert at the floor, and it buys a 3.7× reduction in largest-cluster
 * ratio for a 0.12 coverage cost. Overridable at runtime via
 * `SOX_CLUSTER_TARGET_DEGREE` for operators who want to trade the other way.
 */
export const CLUSTER_TARGET_MEAN_DEGREE = 2.0;
/**
 * Bounded calibration sample size. Cost is O(sample²) pair comparisons, NOT
 * O(N²). Measured at the live corpus: sample=100 → 4,950 pairs / 7ms but an
 * unstable τ (0.87, i.e. it under-estimates the tail); sample=200/400/800 all
 * agree on τ=0.89 at 28/148/684ms. 400 is the smallest sample in the stable
 * region, and 148ms against a 23.4s full pass is 0.6% overhead.
 */
const CLUSTER_CALIBRATION_SAMPLE = 400;

/** Deterministic evenly-spaced subsample. No RNG — the same corpus calibrates identically. */
function boundedSample<T>(items: T[], max: number): T[] {
  if (items.length <= max) return items;
  const step = items.length / max;
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.min(items.length - 1, Math.floor(i * step))]!);
  return out;
}

/** Diagnostics for a calibration decision — surfaced so a pass can report WHY its τ is what it is. */
export interface ThresholdCalibration {
  /** The chosen τ. Always ≥ `CLUSTER_THRESHOLD_FLOOR`. */
  threshold: number;
  /**
   * The metric the edge probability was estimated over. Always `'pairwise'`.
   *
   * ⚠️ Load-bearing, not decorative. τ governs DBSCAN's pairwise cosine
   * distance (`analysisCluster`, ε = 1−τ) and `incrementalJoin`'s
   * max-similarity-to-any-member test — both PAIRWISE. Estimating P(edge)
   * from a to-CENTROID statistic instead would sample a systematically
   * higher-valued distribution and hand back a τ that is correspondingly too
   * LOOSE in the domain it is actually applied in. Measured on this store's
   * own 266 real multi-member communities: mean pairwise 0.8701 vs mean
   * to-centroid 0.9475, offset **+0.0774** (p10 +0.0553, p90 +0.0975, max
   * +0.1223, and **zero** communities where the offset was negative) —
   * matching the +0.086..+0.127 recorded on the three curated BL-328 cohorts
   * in PLAN.md §P0.5. A τ mis-derived by that much lands near 0.81, which
   * PKT-28 measured as degenerate (ratio 0.759 at 0.82).
   */
  metric: 'pairwise';
  /** Estimated P(cosine ≥ threshold) over sampled pairs. */
  edge_probability: number;
  /** edge_probability × (targetN − 1). */
  projected_mean_degree: number;
  /** D_target actually used. */
  target_mean_degree: number;
  /** Vectors compared (≤ `CLUSTER_CALIBRATION_SAMPLE`). */
  sample_size: number;
  /** sample_size × (sample_size − 1) / 2. */
  pair_count: number;
  /** Corpus size the degree was projected against. */
  target_n: number;
  /** Why this τ: floor (degree budget met at the floor), target-degree, or ceiling (budget unmeetable). */
  reason: 'floor' | 'target-degree' | 'ceiling' | 'sample-too-small';
}

/**
 * Target-mean-degree calibration (PKT-30 / BL-328, implementing PKT-28 §2).
 *
 * PKT-28 proved a FIXED global τ is not viable at any value: DBSCAN with
 * `minClusterSize = 2` is single-linkage-equivalent, so a constant τ fixes the
 * per-pair EDGE PROBABILITY and mean node degree therefore grows LINEARLY with
 * corpus size N. Measured on the same store as it grew: largest-cluster ratio
 * at τ=0.82 went 0.085 → 0.222 → 0.459 → 0.684 (N 200→1616) → 0.759 (N=4867).
 * Above mean degree ≈1 the graph percolates into a giant component.
 *
 * So: hold the DEGREE fixed instead of the threshold. Estimate P(edge≥τ) from
 * a bounded pairwise sample, walk the candidate grid upward from the floor,
 * and take the first τ whose projected degree P×(N−1) fits the budget.
 *
 * Measured on the live corpus (read-only copy, N=4950 vectors), calibrated vs
 * the fixed floor — note calibration is INERT below current scale and only
 * engages once the degree budget is actually exceeded:
 *
 * | N | calibrated τ | degree | clusters | ratio | frac | fixed-0.87 clusters | ratio | frac |
 * |---|---|---|---|---|---|---|---|---|
 * | 200 | 0.87 | 0.12 | 8 | 0.0200 | 0.095 | 8 | 0.0200 | 0.095 |
 * | 800 | 0.87 | 0.46 | 61 | 0.0437 | 0.254 | 61 | 0.0437 | 0.254 |
 * | 1616 | 0.87 | 0.51 | 164 | 0.0309 | 0.396 | 164 | 0.0309 | 0.396 |
 * | 3200 | 0.87 | 1.84 | 359 | 0.1347 | 0.628 | 359 | 0.1347 | 0.628 |
 * | 4950 | **0.89** | 1.80 | 506 | **0.0483** | 0.606 | 441 | **0.1776** | 0.727 |
 *
 * The N=3200 row is the one that matters: degree 1.84 against a budget of 2.0,
 * i.e. the live store is ~8% of growth away from the floor becoming unsafe.
 * That is precisely the drift a constant cannot track and this function does.
 *
 * @param sampleVecs Vectors to estimate the pairwise similarity distribution from.
 *                   Subsampled to `CLUSTER_CALIBRATION_SAMPLE` deterministically.
 * @param targetN    Corpus size to project mean degree against.
 */
export function calibrateThreshold(
  sampleVecs: Float32Array[],
  targetN: number,
  targetMeanDegree: number = CLUSTER_TARGET_MEAN_DEGREE,
): ThresholdCalibration {
  const sample = boundedSample(sampleVecs, CLUSTER_CALIBRATION_SAMPLE);
  const base = {
    metric: 'pairwise' as const,
    target_mean_degree: targetMeanDegree,
    sample_size: sample.length,
    pair_count: (sample.length * (sample.length - 1)) / 2,
    target_n: targetN,
  };

  // Too little signal to estimate a tail probability from — fall back to the
  // floor rather than inventing one. (A 2-vector sample yields exactly one
  // pair, so P(edge) can only ever be 0 or 1.)
  if (sample.length < 3 || targetN < 2) {
    return {
      ...base,
      threshold: CLUSTER_THRESHOLD_FLOOR,
      edge_probability: 0,
      projected_mean_degree: 0,
      reason: 'sample-too-small',
    };
  }

  // PAIRWISE similarities — see `ThresholdCalibration.metric`. Sorted ascending
  // so P(≥τ) is a binary search rather than a rescan per grid point.
  const sims: number[] = [];
  for (let i = 0; i < sample.length; i++) {
    for (let j = i + 1; j < sample.length; j++) {
      sims.push(cosineSim(sample[i]!, sample[j]!));
    }
  }
  sims.sort((a, b) => a - b);

  const pAtLeast = (t: number): number => {
    let lo = 0;
    let hi = sims.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sims[mid]! < t) lo = mid + 1;
      else hi = mid;
    }
    return (sims.length - lo) / sims.length;
  };

  for (let raw = CLUSTER_THRESHOLD_FLOOR; raw <= CLUSTER_THRESHOLD_CEILING + 1e-9; raw += CLUSTER_THRESHOLD_STEP) {
    const tau = Math.round(raw * 100) / 100;
    const p = pAtLeast(tau);
    const degree = p * (targetN - 1);
    if (degree <= targetMeanDegree) {
      return {
        ...base,
        threshold: tau,
        edge_probability: p,
        projected_mean_degree: degree,
        reason: tau === CLUSTER_THRESHOLD_FLOOR ? 'floor' : 'target-degree',
      };
    }
  }

  // The budget is unmeetable anywhere on the grid (a corpus of near-duplicates).
  // Take the tightest τ available and let the D5.5 guard backstop from there.
  const p = pAtLeast(CLUSTER_THRESHOLD_CEILING);
  return {
    ...base,
    threshold: CLUSTER_THRESHOLD_CEILING,
    edge_probability: p,
    projected_mean_degree: p * (targetN - 1),
    reason: 'ceiling',
  };
}

/**
 * Resolve the clustering threshold τ.
 *
 * With a calibration context (`sampleVecs` + `targetN`) this runs PKT-28 §2's
 * target-mean-degree calibration — see `calibrateThreshold`. Without one it
 * returns `CLUSTER_THRESHOLD_FLOOR` (0.87), the constant PKT-28 measured
 * non-degenerate at full corpus scale and the value BL-420 locks for the
 * un-calibrated path. It is deliberately NOT the historical 0.82 default:
 * shipping a known-degenerate constant into the now-reachable incremental
 * join path (BL-326/BL-349) would just trade "never joins" for "joins
 * everything into one giant blob" the moment writes start flowing through it.
 *
 * The floor is also why calibration is safe to enable everywhere at once: it
 * can only ever RAISE τ, so no corpus clusters more loosely than it did before
 * this function learned to calibrate.
 */
export function resolveDefaultThreshold(ctx: ThresholdCalibrationContext = {}): number {
  const { sampleVecs, targetN } = ctx;
  if (sampleVecs && sampleVecs.length > 0 && targetN !== undefined) {
    return calibrateThreshold(sampleVecs, targetN, ctx.targetMeanDegree ?? resolveTargetMeanDegree())
      .threshold;
  }
  return CLUSTER_THRESHOLD_FLOOR;
}

/**
 * D_target, with an operator override. `SOX_CLUSTER_TARGET_DEGREE` trades
 * coverage against blob risk: lower is tighter/purer/less covered (0.5 → τ=0.93,
 * clustered_frac 0.323), higher is looser (≥3.0 → inert at the floor). Any
 * non-finite or non-positive value falls back to the measured default rather
 * than disabling calibration.
 */
function resolveTargetMeanDegree(): number {
  const raw = process.env['SOX_CLUSTER_TARGET_DEGREE'];
  if (raw === undefined) return CLUSTER_TARGET_MEAN_DEGREE;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : CLUSTER_TARGET_MEAN_DEGREE;
}
