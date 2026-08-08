/**
 * BL-492 — time-to-community instrumentation.
 *
 * ## Why this is not an in-process ring like `embed-pipeline.ts`
 *
 * `time_to_vector_ms` can use monotonic `performance.now()` stamps held in a
 * per-store `LatencyRing` because the embed pipeline runs IN the server
 * process: the stamp and the completion are the same process's memory.
 *
 * Clustering does not. `runEnrichPassOnDb` executes the batch enrich — and
 * therefore `clusterStore`/`incrementalJoin` — inside an ISOLATED CHILD
 * PROCESS via `runEnrichIsolated` (BL-348), which exits after each pass. A
 * ring populated there dies with the child every five minutes and would report
 * an empty distribution forever.
 *
 * So time-to-community is derived from the DATABASE instead, which is both
 * durable and, unusually, exact: `incrementalJoin` stamps every `MEMBER_OF`
 * edge it writes with `t_created` (cluster.ts, the INSERT in the candidate
 * loop), and `node.t_created` records when the episode was written. The
 * difference IS the measurement, already persisted, retroactively available
 * for every assignment the store has ever made. That is strictly better than a
 * ring here: it survives restarts and could be computed for historical data
 * the instrument never observed live.
 *
 * The tradeoff, stated plainly: this is WALL-CLOCK, not monotonic — same
 * caveat `heal_lag_ms` documents. Clock adjustments perturb it, and lags here
 * are minutes-to-hours, so millisecond skew is irrelevant at this scale.
 *
 * ## The distinction this exists to make
 *
 * An unclustered episode is in one of four states, and before BL-492 all four
 * were the same observable ("a live episode with no MEMBER_OF edge"):
 *
 * | state | drains on its own? | right response |
 * |---|---|---|
 * | `ineligible` (content < 50 chars) | never | nothing — by design |
 * | `awaiting_vector` | yes, embed pipeline | watch `embed_backlog` |
 * | `awaiting_pass` | yes, next 5-min tick | wait |
 * | `rejected_below_threshold` | **NO — never** | lower τ / schedule a full pass |
 *
 * Conflating the last two is the specific defect: they look identical, drain
 * on opposite timescales (minutes vs. never), and demand opposite responses.
 */

import type { StoreAdapter } from '@adhd/sox-store-adapter';
import { CLUSTER_ELIGIBLE_SQL } from './cluster.js';
import { summarizeLatencies } from './latency-stats.js';
import type { ClusterAdmissionStats } from './cluster.js';

/**
 * How many recent assignments the time-to-community distribution is computed
 * over. Bounded so the query cost is O(window), not O(all edges ever) — and
 * because a percentile over the entire history is dominated by whichever
 * one-off full pass backfilled the corpus, which is not a rate anyone can act
 * on. (Measured on the live store 2026-08-08: 3,478 of 3,623 MEMBER_OF edges
 * carry the identical `t_created` of a single 2026-08-04 pass, so an
 * all-history p50 reads ~38 days and describes nothing.)
 */
const TIME_TO_COMMUNITY_WINDOW = 500;

/**
 * An assignment pass that wrote at least this many `MEMBER_OF` edges is
 * treated as a BULK RE-PARTITION (a full pass / `memory_curate recluster`),
 * not as per-episode latency, and is excluded from
 * `time_to_community_ms`.
 *
 * This is not a cosmetic filter — without it the metric is actively false.
 * Measured against a copy of the live store on 2026-08-08, BEFORE this
 * exclusion existed: 3,478 of 3,623 live `MEMBER_OF` edges carry the single
 * identical `t_created` of one 2026-08-04 full pass. Those edges' "lag" is the
 * age each episode happened to have when that pass swept the corpus — up to
 * 43 days — which says nothing whatsoever about how long a new write waits.
 * The unfiltered p50 read **62,115 minutes**; the same window with bulk passes
 * excluded reads **9.1 minutes**, which is the real, actionable number and
 * matches the 5-minute tick interval it is produced by.
 *
 * A pass is identified by its exact `t_created` string because
 * `incrementalJoin` computes `now` ONCE per pass and stamps every edge in that
 * pass with it — so edge timestamps group by pass exactly, with no bucketing
 * heuristic required.
 */
const BULK_PASS_EDGE_THRESHOLD = 100;

/** Distribution summary, same shape as the embed pipeline's. */
export interface LagSummary {
  p50: number;
  p99: number;
  mean: number;
  max: number;
}

/** The unclustered population, partitioned by WHY it is unclustered. */
export interface ClusterBacklogBreakdown {
  /**
   * Structurally ineligible: content shorter than `CLUSTER_MIN_CONTENT_LENGTH`
   * or null. `selectEpisodes` never returns these, so no pass will ever
   * consider them. Not a backlog — a permanent, by-design exclusion.
   */
  ineligible: number;
  /**
   * Eligible but not yet vectorised. Blocked on the EMBED pipeline, not on
   * clustering; drains as `embed_backlog` drains.
   */
  awaiting_vector: number;
  /**
   * Eligible, vectorised, unassigned. **Ambiguous by construction from the DB
   * alone** — this count includes both "written since the last pass" and
   * "rejected below τ on every pass so far". Read `last_pass_admission` to
   * split it: that is the only source that knows which.
   */
  awaiting_or_rejected: number;
  /** Wall-clock age (ms) of the oldest `awaiting_or_rejected` episode. */
  oldest_awaiting_age_ms: number | null;
  /** Median wall-clock age (ms) of the `awaiting_or_rejected` population. */
  median_awaiting_age_ms: number | null;
}

export interface ClusterPipelineMetrics {
  /**
   * Episode write → first `MEMBER_OF` edge, ms, over the last
   * `TIME_TO_COMMUNITY_WINDOW` assignments. **The answer to "how long does it
   * take an episode to get a cluster" — for the episodes that get one at all.**
   * Must be read next to `backlog.awaiting_or_rejected` and
   * `last_pass_admission.rejected_below_threshold`, or it is a survivorship
   * statistic: it describes only the winners and says nothing about the
   * population that never joins.
   */
  time_to_community_ms: LagSummary;
  time_to_community_samples: number;
  /**
   * `MEMBER_OF` edges in the window that were excluded as bulk re-partition
   * output (see `BULK_PASS_EDGE_THRESHOLD`). Surfaced rather than silently
   * dropped: a large value here means most of this store's membership came
   * from one-off full passes rather than from steady-state incremental
   * clustering, which is itself the diagnosis.
   */
  bulk_pass_edges_excluded: number;
  /** `t_created` of the most recent bulk re-partition, or null if none. */
  last_bulk_pass_at: string | null;
  /** Live communities available as join targets. Zero ⇒ nothing can be assigned. */
  community_count: number;
  /** Live episodes holding at least one live `MEMBER_OF` edge. */
  clustered_episodes: number;
  /** clustered_episodes / live episodes. */
  coverage: number;
  backlog: ClusterBacklogBreakdown;
  /**
   * Admission accounting from the most recent incremental pass in this
   * process, or null if no pass has reported yet (fresh process — mirrors
   * `getEmbedPipelineMetrics`'s null-until-first-activity honesty).
   *
   * **This is the only field that can distinguish "rejected" from "not yet
   * considered."** The DB cannot: a rejection writes nothing.
   */
  last_pass_admission: (ClusterAdmissionStats & { at: string }) | null;
}

// ── Last-pass admission registry (parent process, per store) ─────────────────
//
// KEYING — by resolved store path, identical to `pipelineStates` in
// embed-pipeline.ts and `WriteQueue.instances`, so a multi-store process's
// ping block stays attributable.
//
// The child process computes these stats and returns them in its
// `BatchEnrichResult`; the PARENT records them here on pass completion. That
// is what makes them outlive the child, and it needs no IPC beyond the result
// object the parent already receives.

const lastAdmission = new Map<string, ClusterAdmissionStats & { at: string }>();

/** Record the admission stats of a completed incremental pass. Called by the parent. */
export function recordClusterPassAdmission(storeKey: string, admission: ClusterAdmissionStats): void {
  lastAdmission.set(storeKey, { ...admission, at: new Date().toISOString() });
}

/** Test seam: drop recorded admission state (fresh-process shape). */
export function _resetClusterMetricsForTest(): void {
  lastAdmission.clear();
}

function summarize(samples: number[]): LagSummary {
  const s = summarizeLatencies(samples);
  return { p50: s.p50, p99: s.p99, mean: s.mean, max: s.max };
}

/**
 * Read-only snapshot of the clustering pipeline for a store.
 *
 * Pure reads — SELECT only, no DDL, no verify-and-repair, safe to call from a
 * ping handler against a live store (BL-412's hazard is `openDb()` registering
 * a path, not query execution; this takes an already-open adapter and opens
 * nothing).
 */
export async function getClusterPipelineMetrics(
  adapter: StoreAdapter,
  storeKey: string,
): Promise<ClusterPipelineMetrics> {
  const liveEpisodes =
    (await adapter.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM node WHERE kind = 'episode' AND t_invalid IS NULL`,
    ))?.c ?? 0;

  const communityCount =
    (await adapter.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM node WHERE kind = 'community' AND t_invalid IS NULL`,
    ))?.c ?? 0;

  const clustered =
    (await adapter.executeGet<{ c: number }>(
      `SELECT COUNT(DISTINCT e.src) AS c
         FROM edge e JOIN node n ON n.rowid = e.src
        WHERE e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
          AND n.kind = 'episode' AND n.t_invalid IS NULL`,
    ))?.c ?? 0;

  // Identify bulk re-partition passes so their edges can be excluded from the
  // latency distribution. `incrementalJoin` stamps one `now` per pass, so
  // grouping by the exact timestamp partitions edges by pass precisely.
  const bulkRows = (
    await adapter.executeAll<{ ts: string; c: number }>(
      `SELECT t_created AS ts, COUNT(*) AS c
         FROM edge
        WHERE rel = 'MEMBER_OF' AND t_invalid IS NULL AND t_created IS NOT NULL
        GROUP BY t_created
       HAVING COUNT(*) >= ${BULK_PASS_EDGE_THRESHOLD}
        ORDER BY t_created DESC`,
    )
  ).rows;
  const bulkTimestamps = new Set(bulkRows.map((r) => r.ts));
  const lastBulkPassAt = bulkRows[0]?.ts ?? null;

  // Time-to-community over the most RECENTLY ASSIGNED window (ordered by the
  // edge's own t_created, not the episode's — we want the last N assignments,
  // which is the current rate, not the last N episodes written).
  // Bulk-pass edges are excluded in SQL, not after the fact: filtering
  // post-LIMIT would let one backfill consume the entire window and hand back
  // an empty distribution (the live store's 3,478-edge pass would swallow a
  // 500-row window whole).
  const bulkExclusion =
    bulkTimestamps.size > 0
      ? ` AND e.t_created NOT IN (${[...bulkTimestamps].map(() => '?').join(',')})`
      : '';
  const lagRows = (
    await adapter.executeAll<{ ep: string; ed: string }>(
      `SELECT n.t_created AS ep, MIN(e.t_created) AS ed
         FROM edge e JOIN node n ON n.rowid = e.src
        WHERE e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
          AND n.kind = 'episode' AND n.t_invalid IS NULL
          AND e.t_created IS NOT NULL AND n.t_created IS NOT NULL${bulkExclusion}
        GROUP BY n.rowid
        ORDER BY MIN(e.t_created) DESC
        LIMIT ${TIME_TO_COMMUNITY_WINDOW}`,
      [...bulkTimestamps],
    )
  ).rows;

  const lags: number[] = [];
  for (const r of lagRows) {
    const ms = Date.parse(r.ed) - Date.parse(r.ep);
    // Negative lag means the edge predates the episode row — only possible via
    // clock adjustment or an import that rewrote t_created. Dropped rather than
    // clamped to 0, which would silently bias p50 downward.
    if (Number.isFinite(ms) && ms >= 0) lags.push(ms);
  }

  const unassignedClause = `NOT EXISTS (
    SELECT 1 FROM edge e WHERE e.src = n.rowid AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL)`;
  const hasVector = `EXISTS (SELECT 1 FROM vec_node v WHERE v.node_id = n.rowid)`;

  const ineligible =
    (await adapter.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM node n
        WHERE n.kind = 'episode' AND n.t_invalid IS NULL
          AND NOT (${CLUSTER_ELIGIBLE_SQL}) AND ${unassignedClause}`,
    ))?.c ?? 0;

  const awaitingVector =
    (await adapter.executeGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM node n
        WHERE ${CLUSTER_ELIGIBLE_SQL} AND NOT ${hasVector} AND ${unassignedClause}`,
    ))?.c ?? 0;

  const awaitingRows = (
    await adapter.executeAll<{ t_created: string }>(
      `SELECT n.t_created AS t_created FROM node n
        WHERE ${CLUSTER_ELIGIBLE_SQL} AND ${hasVector} AND ${unassignedClause}
        ORDER BY n.t_created ASC`,
    )
  ).rows;

  const now = Date.now();
  const ages = awaitingRows
    .map((r) => now - Date.parse(r.t_created))
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);

  return {
    time_to_community_ms: summarize(lags),
    time_to_community_samples: lags.length,
    bulk_pass_edges_excluded: bulkRows.reduce((sum, r) => sum + r.c, 0),
    last_bulk_pass_at: lastBulkPassAt,
    community_count: communityCount,
    clustered_episodes: clustered,
    coverage: liveEpisodes > 0 ? clustered / liveEpisodes : 0,
    backlog: {
      ineligible,
      awaiting_vector: awaitingVector,
      awaiting_or_rejected: awaitingRows.length,
      oldest_awaiting_age_ms: ages.length > 0 ? ages[ages.length - 1]! : null,
      median_awaiting_age_ms: ages.length > 0 ? ages[Math.floor(ages.length / 2)]! : null,
    },
    last_pass_admission: lastAdmission.get(storeKey) ?? null,
  };
}
