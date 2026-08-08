/**
 * cluster-metrics.spec.ts — regression suite for the clustering-observability
 * gap (BUG-MEMORY-008 / BUG-MEMORY-009 / BUG-MEMORY-010).
 *
 * ## What this suite is defending, and why each assertion exists
 *
 * Clustering shipped with ZERO instrumentation: two declared stages, and no
 * counter or event naming a community anywhere in the log. Three concrete
 * failures followed, and there is one test below for each — written so that
 * removing the instrument makes the test fail, not so that it restates the
 * implementation.
 *
 * **AC-1 (BUG-MEMORY-008) — a mass community invalidation must leave a trace.**
 * `buildCommunities` invalidates every `level = 0` community in one statement.
 * Had it ever run, the only evidence would have been absent rows. This asserts
 * the lifecycle counters make such a wipe *visible as a number*.
 *
 * **AC-2 (BUG-MEMORY-009) — "considered and rejected" must be distinguishable
 * from "never considered".** This is the entire difference between a τ problem
 * and an exclusion problem, and it was unmeasurable. The taxonomy is asserted
 * to separate `below_threshold` (compared, rejected) from `no_vector` /
 * `no_target` (never compared) — NOT merely to count them.
 *
 * **AC-3 (BUG-MEMORY-010) — the join rate must survive the fix that destroys
 * its accidental ledger.** The only reason anyone could measure "17 joins in 11
 * days" is that the incremental join fails to update `meta.member_count`, so
 * the drift acted as a ledger. Fixing that defect makes the join rate
 * unobservable again unless a real counter exists first. This asserts the real
 * counter, so the fix can land without blinding the subsystem.
 *
 * **AC-4 — the instrument must not fabricate.** `null` until first activity, per
 * BL-319: an instrument reporting zeroes is indistinguishable from a broken one.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordClusterPass,
  recordJoinOutcome,
  recordTimeToCommunity,
  recordCommunityLifecycle,
  recordBacklog,
  recordNeverClustered,
  recordQuality,
  getClusterMetrics,
  _resetClusterMetrics,
} from './cluster-metrics.js';
import { MEMORY_CORE_STAGES } from './stages.js';

const STORE = '/tmp/test-store.db';

beforeEach(() => {
  _resetClusterMetrics();
});

describe('AC-4 — no fabricated measurements (BL-319)', () => {
  it('returns null for a store with no clustering activity, not a zeroed record', () => {
    // The distinction that matters: `null` says "nothing happened here";
    // an all-zero record would be indistinguishable from a broken instrument.
    expect(getClusterMetrics(STORE)).toBeNull();
  });

  it('keeps per-store buckets separate so one store cannot report another\'s activity', () => {
    recordClusterPass(STORE, 'full');
    expect(getClusterMetrics('/tmp/other-store.db')).toBeNull();
    expect(getClusterMetrics(STORE)?.counters.passes_full).toBe(1);
  });
});

describe('AC-1 (BUG-MEMORY-008) — a mass community invalidation is visible', () => {
  it('records invalidated communities and orphaned member edges as counters', () => {
    // The buildCommunities shape: every live community invalidated at once.
    recordCommunityLifecycle(STORE, { invalidated: 443, memberEdgesInvalidated: 3623 });

    const m = getClusterMetrics(STORE);
    expect(m).not.toBeNull();
    expect(m!.counters.communities_invalidated).toBe(443);
    expect(m!.counters.member_edges_invalidated).toBe(3623);
  });

  it('separates created from revived, so identity churn is distinguishable from steady state', () => {
    // A pass where every community recomputed to the same uid: pure revival,
    // nothing created. This is the healthy steady state.
    recordCommunityLifecycle(STORE, { invalidated: 10, revived: 10 });
    let m = getClusterMetrics(STORE)!;
    expect(m.counters.communities_revived).toBe(10);
    expect(m.counters.communities_created).toBe(0);

    // A pass where membership changed: uids re-mint, so communities are CREATED
    // rather than revived, permanently orphaning the old uids. `created`
    // climbing while `revived` stays flat is exactly the churn signature, and
    // collapsing these two counters into one would erase it.
    recordCommunityLifecycle(STORE, { invalidated: 10, created: 10 });
    m = getClusterMetrics(STORE)!;
    expect(m.counters.communities_created).toBe(10);
    expect(m.counters.communities_revived).toBe(10);
  });
});

describe('AC-2 (BUG-MEMORY-009) — considered-and-rejected vs never-considered', () => {
  it('counts the five join outcomes independently', () => {
    recordJoinOutcome(STORE, 'joined', 3);
    recordJoinOutcome(STORE, 'below_threshold', 17);
    recordJoinOutcome(STORE, 'degenerate_guard', 2);
    recordJoinOutcome(STORE, 'no_vector', 41);
    recordJoinOutcome(STORE, 'no_target', 5);

    const c = getClusterMetrics(STORE)!.counters;
    expect(c.joins_joined).toBe(3);
    expect(c.joins_below_threshold).toBe(17);
    expect(c.joins_degenerate_guard).toBe(2);
    expect(c.joins_no_vector).toBe(41);
    expect(c.joins_no_target).toBe(5);
  });

  it('does not conflate an unembedded episode with a below-threshold one', () => {
    // The failure this prevents: an investigation reading a high exclusion count
    // and tuning τ, when the real cause is an embedding backlog that τ cannot
    // touch. These must never share a counter.
    recordJoinOutcome(STORE, 'no_vector', 100);
    const c = getClusterMetrics(STORE)!.counters;
    expect(c.joins_no_vector).toBe(100);
    expect(c.joins_below_threshold).toBe(0);
  });

  it('treats a zero or negative count as a no-op rather than corrupting the total', () => {
    recordJoinOutcome(STORE, 'no_vector', 0);
    recordJoinOutcome(STORE, 'no_vector', -5);
    expect(getClusterMetrics(STORE)).toBeNull();
  });
});

describe('AC-3 (BUG-MEMORY-010) — join rate survives the member_count fix', () => {
  it('counts joins directly, not via meta.member_count drift', () => {
    // "17 joins in 11 days" was only recoverable because the incremental join
    // fails to update meta.member_count, making the drift an accidental ledger.
    // This counter is the replacement, so fixing BUG-MEMORY-010 cannot blind
    // the subsystem.
    for (let i = 0; i < 17; i++) recordJoinOutcome(STORE, 'joined');
    expect(getClusterMetrics(STORE)!.counters.joins_joined).toBe(17);
  });
});

describe('censored distribution — the target must stay falsifiable', () => {
  it('never folds never-clustered episodes into the latency percentiles', () => {
    // The failure this prevents: a beautiful p50 computed over survivors only.
    // With ~29% of episodes never joining, that is not a rounding error — it is
    // the entire population that makes the target hard.
    recordTimeToCommunity(STORE, 100);
    recordNeverClustered(STORE, 1532);

    const m = getClusterMetrics(STORE)!;
    expect(m.time_to_community_samples).toBe(1);
    expect(m.time_to_community_ms_among_joined.p50).toBe(100);
    // The censored population is reported, not silently dropped.
    expect(m.never_clustered).toBe(1532);
  });

  it('exposes the censored population as the terminal histogram bucket', () => {
    recordTimeToCommunity(STORE, 50);
    recordNeverClustered(STORE, 7);
    const b = getClusterMetrics(STORE)!.time_to_community_buckets;
    expect(b['<=100ms']).toBe(1);
    // Without this bucket a reader would take the histogram as the whole
    // population, which is exactly how a censored metric gets misread.
    expect(b['never']).toBe(7);
  });

  it('reports join_rate so a percentile can never be read without its denominator', () => {
    recordJoinOutcome(STORE, 'joined', 3);
    recordNeverClustered(STORE, 1);
    expect(getClusterMetrics(STORE)!.join_rate).toBe(0.75);
  });

  it('returns a null join_rate rather than a fabricated 1.0 when nothing is censused', () => {
    // BL-319: "100% joined" with no denominator is a reassurance, not a
    // measurement.
    recordClusterPass(STORE, 'incremental');
    expect(getClusterMetrics(STORE)!.join_rate).toBeNull();
  });

  it('would show a FALLING join_rate for a change that clusters less — the gaming guard', () => {
    // A latency "win" achieved by clustering fewer, easier episodes must be
    // visible as a regression. Same joined count, more censored → rate drops.
    recordJoinOutcome(STORE, 'joined', 10);
    recordNeverClustered(STORE, 10);
    const before = getClusterMetrics(STORE)!.join_rate!;
    recordNeverClustered(STORE, 90);
    const after = getClusterMetrics(STORE)!.join_rate!;
    expect(before).toBe(0.5);
    expect(after).toBeLessThan(before);
  });
});

describe('quality gauges — a latency win that degrades clustering is a regression', () => {
  it('reports single-member clusters as their own population', () => {
    // meanIntraSim() returns 1.0 for n<2, so adopting singletons would drag the
    // store-wide mean toward 1.0 — a quality metric improving because the store
    // got less informative. This column is what makes that visible.
    recordQuality(STORE, {
      coverage: 0.706,
      mean_intra_sim: 0.91,
      mean_inter_sim: 0.42,
      largest_cluster_size: 885,
      community_count: 443,
      single_member_clusters: 0,
    });
    const q = getClusterMetrics(STORE)!.quality!;
    expect(q.single_member_clusters).toBe(0);
    expect(q.coverage).toBeCloseTo(0.706);
    expect(q.mean_inter_sim).toBeLessThan(q.mean_intra_sim);
  });

  it('is null until a full pass has measured it, rather than reporting zeroes', () => {
    recordClusterPass(STORE, 'incremental');
    expect(getClusterMetrics(STORE)!.quality).toBeNull();
  });
});

describe('time-to-community (wall-clock, per the module CLOCK DECISION)', () => {
  it('summarizes samples as a distribution, not just a mean', () => {
    for (const ms of [1000, 2000, 3000, 4000]) recordTimeToCommunity(STORE, ms);
    const m = getClusterMetrics(STORE)!;
    expect(m.time_to_community_samples).toBe(4);
    expect(m.time_to_community_ms_among_joined.max).toBe(4000);
    expect(m.time_to_community_ms_among_joined.p50).toBeGreaterThan(0);
  });

  it('clamps a backwards clock to 0 instead of dropping the sample', () => {
    // Dropping negatives would bias the distribution toward the slow side —
    // the opposite of what this instrument exists for.
    recordTimeToCommunity(STORE, -500);
    const m = getClusterMetrics(STORE)!;
    expect(m.time_to_community_samples).toBe(1);
    expect(m.time_to_community_ms_among_joined.max).toBe(0);
  });

  it('ignores non-finite samples rather than poisoning the distribution', () => {
    recordTimeToCommunity(STORE, NaN);
    recordTimeToCommunity(STORE, Infinity);
    expect(getClusterMetrics(STORE)).toBeNull();
  });
});

describe('backlog gauge', () => {
  it('overwrites rather than accumulates, because a level is not a counter', () => {
    recordBacklog(STORE, 1532, 950_400_000);
    recordBacklog(STORE, 1400, 960_000_000);
    const b = getClusterMetrics(STORE)!.backlog!;
    // 1400, not 2932 — summing levels across passes would be meaningless.
    expect(b.unclustered).toBe(1400);
    expect(b.oldest_unclustered_ms).toBe(960_000_000);
  });

  it('is null until a pass has actually measured it', () => {
    recordClusterPass(STORE, 'incremental');
    expect(getClusterMetrics(STORE)!.backlog).toBeNull();
  });
});

describe('stage declaration (telemetry_self_check coverage)', () => {
  it('declares the cluster stage with all three real entry-point paths', () => {
    // stages.ts's rule: every declared path must be wired at a real call site in
    // the same change, or it becomes a permanent `paths_with_zero_samples`
    // entry nobody can act on (BL-319).
    const paths = MEMORY_CORE_STAGES.stages.cluster.paths;
    expect([...paths].sort()).toEqual(['full', 'incremental', 'subset']);
  });

  it('raises stages_declared to three', () => {
    expect(Object.keys(MEMORY_CORE_STAGES.stages).sort()).toEqual([
      'cluster',
      'embed',
      'write_queue',
    ]);
  });
});
