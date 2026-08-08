/**
 * BL-496 — time-to-community instrumentation.
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
 * An unclustered episode is in one of four states, and before BL-496 all four
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
import { LatencyRing, summarizeLatencies } from './latency-stats.js';
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

/**
 * Grace window for `ever_clustered_fraction`: an episode younger than this has
 * not yet had a fair opportunity to be considered, so counting it as "never
 * clustered" would understate the fraction and make the censoring rate look
 * worse than it is.
 *
 * Set to 2× the memory-server enrich tick (`PERIODIC_ENRICH_INTERVAL_MS`,
 * 5 min) so an episode has had at least one full pass at it, with margin for
 * the embedding to land first (live `time_to_vector_ms` p50 ~3.6s, p99 ~22s).
 *
 * Deliberately biases the fraction UPWARD (optimistic). A censoring rate that
 * errs optimistic can only ever make the latency figure look less trustworthy
 * than it is, never more — which is the safe direction for a number whose
 * entire job is to stop someone over-trusting a p50.
 */
const EVER_CLUSTERED_GRACE_MS = 10 * 60 * 1000;

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
   * **THE CENSORING RATE. Read this before `time_to_community_ms`, always.**
   *
   * Of episodes written since the last bulk re-partition and old enough to
   * have had a real opportunity (see `EVER_CLUSTERED_GRACE_MS`), the fraction
   * that ever acquired a community. `null` when the sample is empty.
   *
   * `time_to_community_ms` is computed over survivors ONLY. At a low fraction
   * here, its percentiles are not merely optimistic — they are **undefined**:
   * if only 15% of writes ever cluster, the true p50 and p99 are infinite, and
   * the reported p50 describes the 15% that made it, no matter how bad the
   * excluded tail gets. Measured 0.146 on the live store 2026-08-08, where the
   * survivors' p50 read a healthy 9.1 minutes.
   *
   * This is deliberately a scalar rather than something a caller derives from
   * `clustered_episodes / total`, because the whole failure mode is a reader
   * taking the latency number and skipping the context beside it. A division
   * is easy to skip; a named fraction is harder.
   *
   * Distinct from `coverage`: that is store-wide and dominated by whatever
   * historical full passes did. This one describes the CURRENT regime — what
   * happens to a write today.
   */
  ever_clustered_fraction: number | null;
  /** Denominator of `ever_clustered_fraction` — episodes in the current regime past the grace window. */
  ever_clustered_sample: number;
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

  // Censoring rate over the CURRENT regime: episodes written since the last
  // bulk re-partition (or all episodes, if none) and past the grace window.
  // One query, both terms, so numerator and denominator cannot drift apart.
  //
  // MUST use CLUSTER_ELIGIBLE_SQL, same as the backlog partitioning above
  // (`ineligible`/`awaitingVector`/`awaitingRows`) — an ineligible episode
  // (content < 50 chars) never clusters BY DESIGN (see the `ineligible` row
  // in the backlog-by-cause table in this file's header). Without this
  // predicate every such episode counts as "never clustered" in the
  // denominator, pulling the fraction down for a reason that has nothing to
  // do with the defect this scalar exists to surface — the exact opposite of
  // the documented "errs optimistic, never pessimistic" guarantee below.
  const regimeCutoff = lastBulkPassAt;
  const graceCutoff = new Date(Date.now() - EVER_CLUSTERED_GRACE_MS).toISOString();
  const regimeRow = await adapter.executeGet<{ total: number; clustered: number }>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN EXISTS (
              SELECT 1 FROM edge e
               WHERE e.src = n.rowid AND e.rel = 'MEMBER_OF' AND e.t_invalid IS NULL
            ) THEN 1 ELSE 0 END) AS clustered
       FROM node n
      WHERE ${CLUSTER_ELIGIBLE_SQL}
        AND n.t_created IS NOT NULL
        AND n.t_created < ?${regimeCutoff ? ' AND n.t_created > ?' : ''}`,
    regimeCutoff ? [graceCutoff, regimeCutoff] : [graceCutoff],
  );
  const regimeTotal = regimeRow?.total ?? 0;
  const regimeClustered = regimeRow?.clustered ?? 0;

  return {
    time_to_community_ms: summarize(lags),
    time_to_community_samples: lags.length,
    ever_clustered_fraction: regimeTotal > 0 ? regimeClustered / regimeTotal : null,
    ever_clustered_sample: regimeTotal,
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

// ── In-memory per-store counters (tracing branch) ────────────────────────────
//
// The functions below record cluster activity IN-PROCESS. The DB-based metrics
// above (`getClusterPipelineMetrics`) are durable and survive process restarts;
// these are live, lightweight, and reported by `memory_ping`'s in-memory block.
// Both coexist: the DB path for historical/durable access, the in-memory path
// for per-process observability and the durable JSONL log (`cluster.pass`).

/** Rolling-window capacity — mirrors `PIPELINE_LATENCY_WINDOW`. */
const CLUSTER_LATENCY_WINDOW = 256;

/**
 * Why an episode did or did not join a community on an incremental pass.
 *
 * **This taxonomy is deliberately finer than the join loop's two `continue`
 * statements.** Counting only the `continue`s would answer "was it rejected?"
 * but not "was it ever eligible?", which is the exact question that separates a
 * latency problem from an exclusion problem. Three of these five outcomes are
 * reached BEFORE the similarity comparison happens at all:
 *
 * - `joined` — cleared τ and the degenerate guard; a `MEMBER_OF` edge was written.
 * - `below_threshold` — compared against every live member of every candidate
 *   community and the best single-link similarity did not clear τ. **This is the
 *   only outcome that means "considered and rejected."** A high count here is a
 *   τ-calibration signal.
 * - `degenerate_guard` — cleared τ, but admitting it would push that community
 *   past 50% of live episodes, so the join was refused and deferred. Distinct
 *   from `below_threshold`: the episode IS similar enough; the guard, not the
 *   similarity, excluded it.
 * - `no_vector` — the episode has no row in `vec_node`, so it could not be
 *   compared to anything. **Never considered**, and no amount of τ tuning
 *   changes it — this is an embedding-pipeline backlog symptom surfacing in
 *   clustering, and conflating it with `below_threshold` would send an
 *   investigation to the wrong subsystem.
 * - `no_target` — the pass found no live community in scope to join to (an
 *   empty or freshly-wiped partition). Also never considered, but for a reason
 *   that lives in the community table rather than the vector table.
 */
export type JoinOutcome =
  | 'joined'
  | 'below_threshold'
  | 'degenerate_guard'
  | 'no_vector'
  | 'no_target';

/** Which entry point a clustering pass was made through. */
export type ClusterPassPath = 'full' | 'incremental' | 'subset';

interface ClusterCounters {
  /** Passes completed, by entry point. */
  passes_full: number;
  passes_incremental: number;
  passes_subset: number;

  /** Per-candidate incremental-join outcomes. See {@link JoinOutcome}. */
  joins_joined: number;
  joins_below_threshold: number;
  joins_degenerate_guard: number;
  joins_no_vector: number;
  joins_no_target: number;

  /**
   * Community lifecycle, summed across materialize passes.
   *
   * `revived` is NOT a subset of `created`: `materializeClusters` invalidates
   * every prior community in scope and then re-upserts, so a community whose
   * member set is unchanged recomputes to the same uid, is found, and is
   * revived (`t_invalid = NULL`). One whose membership changed recomputes to a
   * DIFFERENT uid and is created fresh, permanently orphaning the old uid.
   * Watching `created` climb while `revived` stays flat is precisely the
   * signature of community-identity churn.
   */
  communities_created: number;
  communities_invalidated: number;
  communities_revived: number;
  /** `MEMBER_OF` edges invalidated by a materialize pass's scope reset. */
  member_edges_invalidated: number;
}

interface ClusterState {
  /** WALL-CLOCK (now − node.t_created) at MEMBER_OF insert. See module header. */
  timeToCommunity: LatencyRing;
  counters: ClusterCounters;
  /** Live backlog as of the most recent pass; null until a pass has measured it. */
  backlog: { unclustered: number; oldest_unclustered_ms: number } | null;
}

const clusterStates = new Map<string, ClusterState>();

function newState(): ClusterState {
  return {
    timeToCommunity: new LatencyRing(CLUSTER_LATENCY_WINDOW),
    backlog: null,
    counters: {
      passes_full: 0,
      passes_incremental: 0,
      passes_subset: 0,
      joins_joined: 0,
      joins_below_threshold: 0,
      joins_degenerate_guard: 0,
      joins_no_vector: 0,
      joins_no_target: 0,
      communities_created: 0,
      communities_invalidated: 0,
      communities_revived: 0,
      member_edges_invalidated: 0,
    },
  };
}

function stateFor(storeKey: string): ClusterState {
  let s = clusterStates.get(storeKey);
  if (!s) {
    s = newState();
    clusterStates.set(storeKey, s);
  }
  return s;
}

// ── Recording surface (called from cluster.ts; never throws) ─────────────────

/** Record one completed clustering pass, by entry point. */
export function recordClusterPass(storeKey: string, path: ClusterPassPath): void {
  const c = stateFor(storeKey).counters;
  if (path === 'full') c.passes_full++;
  else if (path === 'incremental') c.passes_incremental++;
  else c.passes_subset++;
}

/**
 * Record `n` candidates resolving to one outcome. `n` defaults to 1 so
 * per-candidate call sites read naturally, while the bulk pre-comparison
 * exclusions (`no_vector`, `no_target`) can be recorded in one call.
 */
export function recordJoinOutcome(storeKey: string, outcome: JoinOutcome, n = 1): void {
  if (n <= 0) return;
  const c = stateFor(storeKey).counters;
  if (outcome === 'joined') c.joins_joined += n;
  else if (outcome === 'below_threshold') c.joins_below_threshold += n;
  else if (outcome === 'degenerate_guard') c.joins_degenerate_guard += n;
  else if (outcome === 'no_vector') c.joins_no_vector += n;
  else c.joins_no_target += n;
}

/**
 * Record an episode becoming community-visible.
 *
 * `ageMs` is wall-clock `now − t_created` (see the module header's CLOCK
 * DECISION). Negative values — possible if the system clock moved backwards
 * between write and join — are clamped to 0 rather than dropped: dropping them
 * would silently bias the distribution toward the slow side, which is the
 * opposite of the honesty this instrument exists for.
 */
export function recordTimeToCommunity(storeKey: string, ageMs: number): void {
  if (!Number.isFinite(ageMs)) return;
  stateFor(storeKey).timeToCommunity.push(Math.max(0, ageMs));
}

/** Record one materialize pass's community lifecycle deltas. */
export function recordCommunityLifecycle(
  storeKey: string,
  delta: {
    created?: number;
    invalidated?: number;
    revived?: number;
    memberEdgesInvalidated?: number;
  },
): void {
  const c = stateFor(storeKey).counters;
  c.communities_created += delta.created ?? 0;
  c.communities_invalidated += delta.invalidated ?? 0;
  c.communities_revived += delta.revived ?? 0;
  c.member_edges_invalidated += delta.memberEdgesInvalidated ?? 0;
}

/**
 * Record the unclustered backlog measured by a pass.
 *
 * This is a GAUGE, not a counter — it is overwritten, not accumulated, because
 * "how many episodes are unclustered right now" is a level, and summing levels
 * across passes would produce a number that means nothing. `oldestUnclusteredMs`
 * is what distinguishes a backlog that is draining from one that is stuck: a
 * steady count with a rising age is a floor, not a queue.
 */
export function recordBacklog(
  storeKey: string,
  unclustered: number,
  oldestUnclusteredMs: number,
): void {
  stateFor(storeKey).backlog = {
    unclustered,
    oldest_unclustered_ms: Math.max(0, oldestUnclusteredMs),
  };
}

// ── Read surface ────────────────────────────────────────────────────────────

export interface ClusterMetrics {
  /**
   * WALL-CLOCK episode-write → community-visible latency, ms. See the module
   * header's CLOCK DECISION before quoting a p99: this accrues during system
   * sleep and is subject to clock adjustment (BL-369).
   */
  time_to_community_ms: { p50: number; p99: number; mean: number; max: number };
  time_to_community_samples: number;
  /**
   * Live unclustered backlog as of the most recent pass, or `null` if no pass
   * has measured it yet. A flat `unclustered` with a climbing
   * `oldest_unclustered_ms` means episodes are not draining — they are excluded.
   */
  backlog: { unclustered: number; oldest_unclustered_ms: number } | null;
  counters: ClusterCounters;
}

/**
 * Pure, read-only snapshot for a store — zero side effects, callable from
 * `memory_ping`. Returns `null` when no clustering activity has touched this
 * store in this process, mirroring `getEmbedPipelineMetrics`.
 */
export function getClusterMetrics(storeKey: string): ClusterMetrics | null {
  const s = clusterStates.get(storeKey);
  if (!s) return null;
  const t = summarizeLatencies(s.timeToCommunity.values());
  return {
    time_to_community_ms: { p50: t.p50, p99: t.p99, mean: t.mean, max: t.max },
    time_to_community_samples: s.timeToCommunity.count,
    backlog: s.backlog ? { ...s.backlog } : null,
    counters: { ...s.counters },
  };
}

/** Test seam: drop all per-store cluster metrics state (fresh-process shape). */
export function _resetClusterMetrics(): void {
  clusterStates.clear();
}
