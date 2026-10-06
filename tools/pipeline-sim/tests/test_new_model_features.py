"""Tests for the new model features (spec 2026-10-05 revision):

* rework (spec 5.1 A1) + the risk objective ``f3`` (spec section 4),
* the parallelism cost ``c_agent`` on occupied agent-seconds (spec 4-f2),
* all active catalogue task kinds instantiated (BL 51ec18ef / f3a9eeb5),
* custom task types (spec 3.6),
* a non-degenerate cost/makespan (and cost|time/risk) Pareto front.
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from pipeline_sim import (
    PipelineConfig,
    expected_cost_per_item,
    occurrence_counts,
    run,
    to_dot,
    validate_task_graph,
)
from pipeline_sim.analytics import (
    blast_radius,
    conflict_rate,
    deferral_levels,
    expected_rework_burden,
    risk_objective,
)
from pipeline_sim.explore import (
    SearchDomain,
    pareto_front_cost_makespan,
    pareto_front_cost_risk,
    pareto_front_time_risk,
    run_sweep,
)
from pipeline_sim.taskgraph import (
    DEFAULT_EDGES,
    TASK_TYPE_IDS,
    TaskType,
    effective_active,
)


def _cfg(**kw) -> PipelineConfig:
    base = dict(W_tot=200.0, w=10.0, n=5, m=4, alpha=2)
    base.update(kw)
    return PipelineConfig(**base)


# ---------------------------------------------------------------------------
# item 1a: rework (spec 5.1 A1)
# ---------------------------------------------------------------------------
def test_rework_fires_per_bucket_with_probability_p():
    with_rework = run(_cfg(p=1.0))            # every bucket reworked
    assert with_rework.rework_buckets == with_rework.graph.num_buckets
    n = with_rework.graph.num_buckets
    assert sum(1 for r in with_rework.records if r.kind == "rework_impl") == n
    assert sum(1 for r in with_rework.records if r.kind == "rework_confirm") == n
    assert with_rework.cost_breakdown["rework"] > 0

    without = run(_cfg(p=0.0))                # no bucket reworked
    assert without.rework_buckets == 0
    assert without.cost_breakdown["rework"] == 0.0

    # rework adds both time and cost
    assert with_rework.total_cost > without.total_cost
    assert with_rework.makespan >= without.makespan


def test_rework_uses_seeded_common_random_numbers():
    base = _cfg(p=0.5)
    assert run(base).rework_buckets == run(base).rework_buckets
    # same n => same bucket partition => same rework draws across arms
    arm_a = run(replace(base, branch_levels=1, test_level="all"))
    arm_b = run(replace(base, branch_levels=2, test_level="top"))
    assert arm_a.rework_buckets == arm_b.rework_buckets


def test_rework_expected_burden_is_implement_plus_reconfirm():
    cfg = _cfg()
    per_bucket = cfg.c_op.impl + cfg.c_op.review + cfg.c_op.review_routing
    assert expected_rework_burden(cfg) == pytest.approx(
        cfg.num_buckets * per_bucket)


# ---------------------------------------------------------------------------
# item 1b: the risk objective f3
# ---------------------------------------------------------------------------
def test_f3_risk_formula_matches_spec():
    cfg = _cfg(branch_levels=2, test_level="top")
    expected = (cfg.rho
                * blast_radius(cfg.resolved_branch_levels(), deferral_levels(cfg))
                * conflict_rate(cfg)
                + cfg.p * expected_rework_burden(cfg))
    assert risk_objective(cfg) == pytest.approx(expected)
    # exposed on the result as the third objective
    assert run(cfg).risk == pytest.approx(expected)


def test_risk_grows_with_branch_depth_and_deferral():
    base = _cfg(rho=0.5)
    r_all1 = run(replace(base, branch_levels=1, test_level="all"))
    r_all2 = run(replace(base, branch_levels=2, test_level="all"))
    r_top2 = run(replace(base, branch_levels=2, test_level="top"))
    r_top3 = run(replace(base, branch_levels=3, test_level="top"))
    assert r_all2.risk > r_all1.risk          # deeper tree
    assert r_top2.risk > r_all2.risk          # testing deferred
    assert r_top3.risk > r_top2.risk          # deeper + deferred
    # deferral_levels is the claimed driver
    assert deferral_levels(replace(base, test_level="all")) == 0
    assert deferral_levels(replace(base, branch_levels=2, test_level="top")) == 1


def test_conflict_rate_is_zero_for_no_edges_and_positive_for_fragmented():
    assert conflict_rate(_cfg(file_regime="no_edges")) == 0.0
    assert conflict_rate(_cfg(file_regime="fragmented")) > 0.0
    assert conflict_rate(_cfg(file_regime="one_component")) == pytest.approx(1.0)


# ---------------------------------------------------------------------------
# item 2: parallelism cost c_agent on occupied agent-seconds
# ---------------------------------------------------------------------------
def test_c_agent_charges_occupied_agent_seconds():
    base = _cfg()
    res = run(base)
    assert res.agent_seconds > 0
    assert res.cost_breakdown["agent"] == pytest.approx(
        base.c_agent * res.agent_seconds)
    # cost-only: disabling c_agent changes cost, not the schedule
    off = run(replace(base, c_agent=0.0))
    assert off.cost_breakdown["agent"] == 0.0
    assert res.total_cost - off.total_cost == pytest.approx(
        base.c_agent * res.agent_seconds)
    assert res.makespan == off.makespan


def test_more_agents_trade_makespan_for_cost():
    base = _cfg(n=8, alpha=2)
    makespans, costs = [], []
    for m in (2, 4, 8, 16):
        r = run(replace(base, m=m))
        makespans.append(r.makespan)
        costs.append(r.total_cost)
    # more agents buy time ...
    assert all(b < a for a, b in zip(makespans, makespans[1:])), makespans
    # ... at a higher occupancy cost (parallelism is not free)
    assert all(b > a for a, b in zip(costs, costs[1:])), costs


def test_c_agent_default_is_non_trivial_at_realistic_makespans():
    """~hundreds of agent-seconds must be a visible cost, not a rounding error."""
    res = run(_cfg())
    agent_cost = res.cost_breakdown["agent"]
    assert agent_cost > 0.005                    # visible
    assert agent_cost < res.total_cost           # but not the whole budget
    assert res.agent_seconds > 500


# ---------------------------------------------------------------------------
# non-degenerate Pareto front (items 1+2 together)
# ---------------------------------------------------------------------------
def test_cost_vs_makespan_front_is_non_degenerate():
    base = PipelineConfig(W_tot=400.0, w=10.0, alpha=2, n=4, m=4)
    dom = SearchDomain(
        ns=(2, 4, 8), alphas=(1, 2), branch_levels=(1, 2, 3), branch_fanouts=(2,),
        test_levels=("all", "top"), test_execs=("full_suite",), ms=(2, 4, 8, 16))
    pts = run_sweep(base, dom)
    assert len(pareto_front_cost_makespan(pts)) > 1
    assert len(pareto_front_cost_risk(pts)) > 1
    assert len(pareto_front_time_risk(pts)) > 1


# ---------------------------------------------------------------------------
# item 4: all active catalogue kinds are instantiated
# ---------------------------------------------------------------------------
_FORMERLY_MISSING = ("intake", "routing", "plan", "review", "review_routing",
                     "main_build", "post_verify")


def test_all_active_catalogue_kinds_are_simulated():
    res = run(_cfg())
    kinds = {r.kind for r in res.records}
    for k in _FORMERLY_MISSING:
        assert k in kinds, f"{k} not instantiated"
        assert all(r.duration > 0 for r in res.records if r.kind == k)
    # optional gates come on with the flags (or an explicit T_active)
    gated = run(_cfg(y_triage=True, y_spec=True))
    gkinds = {r.kind for r in gated.records}
    assert {"triage", "spec"} <= gkinds


def test_disabling_a_catalogue_kind_removes_its_time_and_cost():
    base = _cfg()
    full = run(base)
    assert any(r.kind == "main_build" for r in full.records)

    active = tuple(sorted(set(effective_active(base)) - {"main_build"}))
    reduced = run(replace(base, T_active=active, P=DEFAULT_EDGES))
    assert not any(r.kind == "main_build" for r in reduced.records)
    assert reduced.total_cost < full.total_cost


def test_occurrence_and_expected_cost_cover_the_formely_missing_kinds():
    cfg = _cfg()
    counts = occurrence_counts(cfg)
    for k in _FORMERLY_MISSING:
        assert counts[k] > 0, k
    rep = expected_cost_per_item(cfg)
    by_id = {r.id: r for r in rep.rows}
    for k in _FORMERLY_MISSING:
        assert by_id[k].occurrences > 0
        assert by_id[k].subtotal > 0
        assert by_id[k].implemented


# ---------------------------------------------------------------------------
# item 5: custom task types (spec 3.6)
# ---------------------------------------------------------------------------
def _custom_type() -> TaskType:
    return TaskType(
        id="security_scan", label="Security scan", scope="ticket",
        token_field="", t_op=45.0, in_tok=4_000, out_tok=1_000, tool_calls=2,
        default_predecessors=("implement",), default_successors=("test_run",),
        custom=True, implemented=True,
    )


def test_custom_task_type_flows_into_graph_validation_and_run():
    ct = _custom_type()
    cfg = _cfg(W_tot=100.0, m=3, custom_task_types=(ct,))
    report = validate_task_graph(cfg.resolve_task_graph(), cfg=cfg)
    assert report.ok, report.errors

    res = run(cfg)
    assert sum(1 for r in res.records if r.kind == "security_scan") == cfg.M
    assert res.violations == [], res.violations
    # the custom type's own edges are honoured (impl -> scan -> test_run)
    scan = next(r for r in res.records if r.kind == "security_scan")
    impl = next(r for r in res.records
                if r.kind == "impl" and r.ticket == scan.ticket)
    assert impl.finish <= scan.start + 1e-9


def test_custom_task_type_flows_into_occurrence_and_expected_cost():
    ct = _custom_type()
    cfg = _cfg(W_tot=100.0, m=3, custom_task_types=(ct,))
    assert occurrence_counts(cfg)["security_scan"] == cfg.M
    rep = expected_cost_per_item(cfg)
    row = next(r for r in rep.rows if r.id == "security_scan")
    assert row.occurrences == cfg.M
    assert row.per_fire == pytest.approx(ct.per_fire)
    assert row.subtotal == pytest.approx(ct.per_fire * cfg.M)
    assert '"security_scan"' in to_dot(cfg.resolve_task_graph(), cfg=cfg)


def test_custom_task_type_rejects_a_catalogue_id_collision():
    bad = replace(_custom_type(), id="implement")
    with pytest.raises(ValueError, match="collides"):
        _cfg(custom_task_types=(bad,)).validate()
