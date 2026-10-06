"""Tests for the design-space sweep (spec 10.1 step 1-2)."""

from __future__ import annotations

from pipeline_sim import PipelineConfig
from pipeline_sim.explore import (
    SearchDomain,
    SweepPoint,
    iter_configs,
    run_sweep,
    valid_test_levels,
    weighted_score,
)


def _base(M: int = 8) -> PipelineConfig:
    return PipelineConfig(W_tot=M * 10.0, w=10.0, n=4, m=4)


def test_domain_size_is_the_product_of_level_sets():
    d = SearchDomain(ns=(2, 4), alphas=(1, 2, 3), branch_levels=(1,),
                     branch_fanouts=(2,), test_levels=("all",), test_execs=("full_suite",),
                     ms=(2, 4))
    assert d.size() == 2 * 3 * 1 * 1 * 1 * 1 * 2


def test_iter_configs_covers_the_whole_grid():
    d = SearchDomain(ns=(2, 4), alphas=(1, 2), branch_levels=(1, 2),
                     branch_fanouts=(2,), test_levels=("all", "top"),
                     test_execs=("full_suite",), ms=(2,))
    cfgs = list(iter_configs(_base(), d))
    assert len(cfgs) == d.size() == 16
    # base parameters survive; only the seven domain axes vary
    assert all(c.W_tot == 80.0 for c in cfgs)


def test_valid_test_levels_only_offers_reachable_levels():
    assert valid_test_levels((1,)) == ["all", "top"]
    assert "level:2" in valid_test_levels((1, 2, 3))
    assert "level:4" not in valid_test_levels((1, 2, 3))


def test_run_sweep_returns_points_and_skips_invalid_levels():
    # test_level=level:2 with branch_levels=1 is rejected -> skipped, not fatal.
    d = SearchDomain(ns=(4,), alphas=(2,), branch_levels=(1, 2), branch_fanouts=(2,),
                     test_levels=("all", "level:2"), test_execs=("full_suite",), ms=(4,))
    skipped: list = []
    pts = run_sweep(_base(), d, skipped=skipped)
    assert pts and len(pts) == 3          # 4 combos, one invalid level:2 @ L=1
    assert skipped and "level:2" in skipped[0][1]
    assert all(isinstance(p, SweepPoint) for p in pts)
    assert all(p.cost > 0 and p.makespan > 0 for p in pts)
    assert all(p.ok for p in pts)


def test_run_sweep_pareto_duck_typing_fields():
    d = SearchDomain(ns=(4,), alphas=(2,), branch_levels=(1, 2), branch_fanouts=(2,),
                     test_levels=("all", "top"), test_execs=("full_suite",), ms=(4,))
    pts = run_sweep(_base(), d)
    p = pts[0]
    for attr in ("cost", "makespan", "util", "n", "alpha", "branch_levels"):
        assert hasattr(p, attr)
    assert 0.0 <= p.util <= 1.0


def test_weighted_score_is_bounded_and_ranks_lower_better():
    d = SearchDomain(ns=(4,), alphas=(2,), branch_levels=(1, 2), branch_fanouts=(2,),
                     test_levels=("all", "top"), test_execs=("full_suite",), ms=(4,),
                     w1=1.0, w2=1.0, w3=0.0)
    pts = run_sweep(_base(), d)
    rng = {
        "makespan": (min(p.makespan for p in pts), max(p.makespan for p in pts)),
        "cost": (min(p.cost for p in pts), max(p.cost for p in pts)),
        "util": (min(p.util for p in pts), max(p.util for p in pts)),
    }
    scores = [weighted_score(p, d, rng) for p in pts]
    assert all(0.0 <= s <= 1.0 for s in scores)
    best = min(pts, key=lambda p: weighted_score(p, d, rng))
    assert weighted_score(best, d, rng) == min(scores)
