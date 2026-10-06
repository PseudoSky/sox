"""Tests for the spec revision (2026-10-05):

* the bucket / merge separation (spec 1.1, OPEN-8, backlog 47bf572f),
* the branch tree knobs ``branch_levels`` / ``branch_fanout``,
* the time model (spec 3.2 / 4-f1 / C17),
* the cost model with the compounding test term and the holding term (4-f2),
* the ``test_level`` policy with deferral allowed (C10 / C18),
* the H1 contrast harness (7.4 X2 / 7.6 V7 / L8).
"""

from __future__ import annotations

import math
from dataclasses import replace

import pytest

from pipeline_sim import (
    PipelineConfig,
    build_task_graph,
    run,
    run_h1_contrast,
)


def _cfg(**kw) -> PipelineConfig:
    base = dict(W_tot=200.0, w=10.0, n=5, m=4, alpha=2)
    base.update(kw)
    return PipelineConfig(**base)


# ---------------------------------------------------------------------------
# bucket / merge separation (spec 1.1, OPEN-8, backlog 47bf572f)
# ---------------------------------------------------------------------------
def test_bucket_size_does_not_change_the_merge_tree():
    """BL 47bf572f: the merge structure is INDEPENDENT of bucket size n.

    Changing n must change only the number of buckets (and therefore the number
    of dispatches / the per-batch setup term) -- never the number of merges.
    """
    merge_counts = set()
    for n in (1, 2, 4, 5, 10, 20):
        g = build_task_graph(_cfg(n=n, branch_levels=2, branch_fanout=2))
        merge_counts.add(g.num_merges)
        assert g.num_dispatches == g.num_buckets == len(g.buckets)
    assert merge_counts == {30}, merge_counts  # M=20 leaves + ceil(20/2)=10 parents


def test_flat_merges_one_per_ticket_multilevel_adds_branch_nodes():
    M = 20
    flat = build_task_graph(_cfg(n=5, branch_levels=1))
    two = build_task_graph(_cfg(n=5, branch_levels=2, branch_fanout=2))
    three = build_task_graph(_cfg(n=5, branch_levels=3, branch_fanout=2))
    # flat: every work unit (ticket) merges straight to main
    assert flat.num_merges == M
    # depth 2: M leaf merges + ceil(M/2)=10 parents
    assert two.num_merges == M + math.ceil(M / 2)
    # depth 3 adds another level: + ceil(10/2)=5
    assert three.num_merges == M + math.ceil(M / 2) + math.ceil(math.ceil(M / 2) / 2)
    assert flat.num_merges < two.num_merges < three.num_merges


def test_only_top_merges_touch_main():
    """C16: internal (non-top) merges do not acquire the single-capacity main."""
    g = build_task_graph(_cfg(n=5, branch_levels=2, branch_fanout=2))
    top = [n for n in g.merge_nodes if n.is_top]
    assert len(top) == math.ceil(g.M / 2)
    for node in g.merge_nodes:
        assert node.merge.needs_main == node.is_top


def test_internal_merges_can_run_concurrently():
    """Multi-level branching buys time by doing merges off-main in parallel."""
    res = run(_cfg(n=2, m=8, branch_levels=3, branch_fanout=2, test_level="top"))
    internal = [
        r for r in res.records
        if r.kind == "merge" and not r.is_main_merge
    ]
    assert internal, "expected internal merges at branch_levels=3"
    # any pair of internal merges that overlap proves off-main parallelism
    internal.sort(key=lambda r: r.start)
    overlaps = any(
        a.finish > b.start + 1e-9 for a, b in zip(internal, internal[1:])
    )
    assert overlaps, "internal merges never overlapped -- no branch parallelism"


# ---------------------------------------------------------------------------
# test policy (spec C10 / C18, knob test_level)
# ---------------------------------------------------------------------------
def test_test_level_all_matches_every_merge():
    res = run(_cfg(branch_levels=1, test_level="all"))
    assert res.num_suite_runs == res.num_merges


def test_test_level_top_defers_to_top_level_only():
    res = run(_cfg(n=5, branch_levels=2, branch_fanout=2, test_level="top"))
    assert res.num_suite_runs == res.num_main_merges
    assert res.num_suite_runs < res.num_merges


@pytest.mark.parametrize("levels,fanout", [(2, 2), (3, 2), (2, 4), (4, 3)])
def test_level_family_is_monotone_in_L(levels, fanout):
    """level:1 == all and level:branch_levels == top; suites shrink as L rises."""
    cfg = _cfg(n=5, branch_levels=levels, branch_fanout=fanout)
    counts = []
    for level in range(1, levels + 1):
        res = run(replace(cfg, test_level=f"level:{level}"))
        counts.append(res.num_suite_runs)
    all_res = run(replace(cfg, test_level="all"))
    top_res = run(replace(cfg, test_level="top"))
    assert counts[0] == all_res.num_suite_runs
    assert counts[-1] == top_res.num_suite_runs
    assert all(b <= a for a, b in zip(counts, counts[1:])), counts
    assert counts[0] >= counts[-1]


def test_deferral_is_allowed_nothing_forces_a_suite_below_level():
    """C18: no constraint forces a suite run below the chosen test level."""
    res = run(_cfg(n=5, branch_levels=3, branch_fanout=2, test_level="top"))
    suites = [r for r in res.records if r.kind == "suite"]
    assert suites, "at least one suite must occur before release (C10)"
    # every suite sits at a top-level merge
    assert all(r.is_main_merge for r in suites)
    assert res.violations == []


def test_test_level_rejects_out_of_range_level():
    with pytest.raises(ValueError):
        run(_cfg(branch_levels=2, test_level="level:5"))


# ---------------------------------------------------------------------------
# time model (spec 3.2 / 4-f1 / C17)
# ---------------------------------------------------------------------------
def test_t_dispatch_enters_makespan():
    base = _cfg(n=20, m=2, branch_levels=1)   # one bucket -> dispatch is on the path
    lo = run(replace(base, t_dispatch=5.0))
    hi = run(replace(base, t_dispatch=500.0))
    assert hi.makespan > lo.makespan


def test_t_suite_enters_makespan():
    base = _cfg(n=5, m=4, branch_levels=1, test_level="all")
    lo = run(replace(base, t_suite=1.0))
    hi = run(replace(base, t_suite=1000.0))
    assert hi.makespan > lo.makespan


def test_per_ac_test_time_e_enters_makespan():
    base = _cfg(n=5, m=4, branch_levels=1, test_level="all")
    lo = run(replace(base, e=1.0))
    hi = run(replace(base, e=200.0))
    assert hi.makespan > lo.makespan


def test_t_op_per_operation_enters_makespan():
    base = _cfg(n=5, m=4, branch_levels=1)
    lo = run(base)
    hi = run(replace(base, durations=replace(base.durations, impl=base.durations.impl * 5)))
    assert hi.makespan > lo.makespan


# ---------------------------------------------------------------------------
# cost model (spec 4-f2)
# ---------------------------------------------------------------------------
def test_dispatch_cost_is_per_bucket():
    cfg = _cfg(n=5)  # M=20 -> 4 buckets
    res = run(cfg)
    assert res.num_dispatches == 4
    assert res.cost_breakdown["dispatch"] == pytest.approx(cfg.c_dispatch * 4)


def test_holding_term_is_c_wip_times_n_times_horizon():
    cfg = _cfg(n=5, c_wip=7.0, horizon=3.0)
    res = run(cfg)
    assert res.cost_breakdown["holding"] == pytest.approx(7.0 * 5 * 3.0)


def test_compounding_test_term_grows_with_accumulated_acs():
    """Each suite run costs c_suite + sum(c_a over accumulated ACs) (4-f2)."""
    cfg = _cfg(n=5, branch_levels=1, test_level="all", test_exec="full_suite")
    res = run(cfg)
    suite_records = [r for r in res.records if r.kind == "suite"]
    assert suite_records
    expected = (
        len(suite_records) * cfg.c_suite
        + sum(r.ac for r in suite_records) * cfg.c_a
    )
    assert res.cost_breakdown["suite"] == pytest.approx(expected)
    # the compounding term is strictly present (Appendix C calibration)
    assert sum(r.ac for r in suite_records) * cfg.c_a > 0
    # accumulated ACs grow: the last suite sees at least as many ACs as the first
    by_start = sorted(suite_records, key=lambda r: r.start)
    assert by_start[-1].ac >= by_start[0].ac
    assert by_start[-1].ac > by_start[0].ac


def test_deferral_reduces_both_suite_count_and_suite_cost():
    """Deferring testing skips the lower-level suite RUNS: fewer runs, less
    suite spend.  The TOTAL-cost win is a separate, workload-conditional claim
    (once gate remediation makes deferral a real trade) and is pinned by
    ``test_h1_cost_win_holds_above_a_workload_threshold``."""
    base = _cfg(n=5, branch_levels=2, branch_fanout=2)
    every = run(replace(base, test_level="all"))
    top = run(replace(base, test_level="top"))
    assert top.num_suite_runs < every.num_suite_runs
    assert top.cost_breakdown["suite"] < every.cost_breakdown["suite"]


# ---------------------------------------------------------------------------
# H1 contrast harness (spec 7.4 X2 / 7.6 V7 / L8)
# ---------------------------------------------------------------------------
def test_h1_contrast_mechanism_holds_in_defaults():
    """V7 (deferral reduces suite runs) and the makespan win hold unconditionally.

    The COST win (L8) is **workload-conditional** once branch depth carries a
    first-order per-branch cost (part 1 fix): a depth-2 tree adds ~half again as
    many merge nodes, so on a tiny workload its coordination cost can exceed the
    suite saving.  That threshold is pinned by the companion test below.
    """
    c = run_h1_contrast(_cfg(n=5, m=4, branch_levels=1, test_level="all"))
    # default arm A vs arm B
    assert c.baseline.branch_levels == 1 and c.baseline.test_level == "all"
    assert c.deferred.branch_levels == 2 and c.deferred.test_level == "top"
    # V7: deferring tests MUST reduce the number of suite runs
    assert c.mechanism_holds
    assert c.suite_runs_delta < 0
    # deferral (fewer, higher suites) is faster
    assert c.makespan_delta < 0


def test_h1_cost_win_holds_above_a_workload_threshold():
    """L8's cost win needs enough workload to amortise the branch-nodes cost.

    With the part-1 branch cost, "defer + deepen" is cheaper only when the
    agent+suite saving outgrows the extra merge-tree nodes; below that it is
    genuinely a trade (cheaper suites, dearer coordination), not a free lunch.
    """
    small = run_h1_contrast(_cfg(W_tot=200.0, n=5, m=4))     # M = 20
    large = run_h1_contrast(_cfg(W_tot=2000.0, n=5, m=4))    # M = 200
    assert small.mechanism_holds and small.makespan_delta < 0
    assert not small.h1_holds           # depth cost dominates at tiny M
    assert large.h1_holds               # cheaper AND faster once M is large


def test_h1_deferred_suite_count_matches_theory():
    M, n, fanout, levels = 200, 5, 2, 2
    c = run_h1_contrast(
        _cfg(W_tot=M * 10, w=10.0, n=n, m=8, branch_fanout=fanout),
        deferred_levels=levels,
    )
    assert c.baseline.num_suite_runs == M
    assert c.deferred.num_suite_runs == math.ceil(M / fanout)
    assert c.suite_runs_delta == math.ceil(M / fanout) - M


@pytest.mark.parametrize("m", [2, 4, 8, 16])
def test_h1_deltas_have_expected_signs_across_agent_counts(m):
    # M = 60: above the workload threshold, so the cost win (L8) holds for every
    # agent count (at tiny M the new per-branch depth cost can dominate).
    c = run_h1_contrast(_cfg(W_tot=600.0, n=5, m=m))
    assert c.suite_runs_delta < 0           # deferral always runs fewer suites
    assert c.cost_delta < 0                 # expensive compounding suite => cheaper
    assert c.makespan_delta < 0             # fewer suites => faster
