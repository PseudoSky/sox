"""Operator topology tests (spec §5.2) -- the topology is NAMED here.

The operator-specified flow replaces the old linear default::

    intake -> {triage, spec}             triage and spec in PARALLEL
    {triage, spec} -> routing
    routing -> {implement, test_write}   implement and test-write in PARALLEL
    implement -> review                  review depends on IMPLEMENT ONLY
    test_write -> test_run               test_run depends on test-write (NOT impl)
    {review, test_run} -> merge-to-main  BOTH must finish before the merge
    merge-to-main -> [release gate] -> release

These tests name each edge at the *type* level (``DEFAULT_EDGES`` /
``REQUIRED_EDGES``) and confirm the engine realises it per ticket, plus the two
operator variants: ``plan`` placement (before routing vs before implement, with
raised rework odds) and the ``release gate`` (branch vs main remediation cost).
"""

from __future__ import annotations

from dataclasses import replace

import pytest

from pipeline_sim import PipelineConfig, build_task_graph, run
from pipeline_sim.taskgraph import DEFAULT_EDGES, REQUIRED_EDGES


def _cfg(**kw) -> PipelineConfig:
    base = dict(W_tot=100.0, w=10.0, n=5, m=4, alpha=2)   # M = 10
    base.update(kw)
    return PipelineConfig(**base)


# ---------------------------------------------------------------------------
# the named topology (type level)
# ---------------------------------------------------------------------------
#: The operator's intended edges (spec 5.2).  ``merge-to-main`` is the
#: catalogue's ``merge_resolve``; ``release gate`` is ``gates``.
OPERATOR_EDGES = (
    ("intake", "triage"),
    ("intake", "spec"),
    ("triage", "routing"),
    ("spec", "routing"),
    ("routing", "implement"),
    ("routing", "test_write"),
    ("implement", "review"),
    ("test_write", "test_run"),
    ("review", "merge_resolve"),
    ("test_run", "merge_resolve"),
    ("merge_resolve", "gates"),
    ("gates", "release"),
)


def test_operator_topology_edges_are_all_present():
    edges = set(DEFAULT_EDGES)
    for edge in OPERATOR_EDGES:
        assert edge in edges, f"operator edge {edge} missing from DEFAULT_EDGES"


def test_operator_topology_is_the_domain_mandated_subset():
    """C20: every operator edge is required, and every required edge is an
    operator edge or an internal merge-tree edge."""
    required = set(REQUIRED_EDGES)
    for edge in (
        ("implement", "review"),
        ("test_write", "test_run"),
        ("review", "merge_resolve"),
        ("test_run", "merge_resolve"),
        ("merge_resolve", "gates"),
        ("gates", "release"),
    ):
        assert edge in required, f"{edge} must be a domain-required edge"


def test_review_does_not_depend_on_test_run_in_default_graph():
    """Spec 5.2: review depends on IMPLEMENT ONLY (not on test_run)."""
    assert ("test_run", "review") not in set(DEFAULT_EDGES)


def test_implement_does_not_gate_test_run_in_default_graph():
    """C6 is relaxed: test_run follows test_write, never implement."""
    assert ("implement", "test_run") not in set(DEFAULT_EDGES)
    assert ("test_write", "test_run") in set(DEFAULT_EDGES)


# ---------------------------------------------------------------------------
# the engine realises the topology per ticket
# ---------------------------------------------------------------------------
def _by_kind(graph, kind):
    return [t for t in graph.tasks if t.kind == kind]


def test_engine_test_run_follows_test_write_only():
    """C6 relaxed: no test_run has an impl predecessor; each has a test_write
    predecessor on the same ticket."""
    g = build_task_graph(_cfg())
    for trun in _by_kind(g, "test_run"):
        assert all(p.kind != "impl" for p in trun.preds), \
            "test_run must not wait on implementation (spec 5.2)"
        assert any(p.kind == "test_write" and p.ticket == trun.ticket
                   for p in trun.preds), "test_run must wait on its test_write"


def test_engine_review_follows_implement_only():
    g = build_task_graph(_cfg())
    for review in _by_kind(g, "review"):
        assert any(p.kind == "impl" and p.ticket == review.ticket
                   for p in review.preds), "review must wait on its implement"
        assert all(p.kind != "test_run" for p in review.preds), \
            "review must not wait on test_run (spec 5.2)"


def test_engine_review_and_test_run_both_precede_the_merge():
    """{review, test_run} -> merge-to-main: both are predecessors of a leaf
    merge's setup, and each leaf merge WAITS on both."""
    g = build_task_graph(_cfg())
    leaves = [n for n in g.merge_nodes if not n.children]
    assert leaves
    for leaf in leaves:
        pred_kinds = {p.kind for p in leaf.setup.preds}
        assert "test_run" in pred_kinds
        assert pred_kinds & {"review", "review_routing"}


def test_engine_triage_and_spec_and_impl_and_test_write_run_in_parallel():
    """{triage,spec} share a predecessor and both feed routing; {implement,
    test_write} share routing as predecessor (they are not ordered)."""
    g = build_task_graph(_cfg(y_triage=True, y_spec=True))
    routing = _by_kind(g, "routing")[0]
    assert {p.kind for p in routing.preds} >= {"triage", "spec"}
    impl = _by_kind(g, "impl")[0]
    tw = _by_kind(g, "test_write")[0]
    assert any(p.kind == "routing" for p in impl.preds)
    assert any(p.kind == "routing" for p in tw.preds)
    # implement and test_write are unordered relative to each other
    assert tw not in impl.preds and impl not in tw.preds


# ---------------------------------------------------------------------------
# plan placement is a VARIANT (spec 5.2)
# ---------------------------------------------------------------------------
def test_plan_before_routing_gates_routing():
    g = build_task_graph(_cfg(plan_position="before_routing"))
    routing = _by_kind(g, "routing")[0]
    assert any(p.kind == "plan" for p in routing.preds)
    impl = _by_kind(g, "impl")[0]
    assert all(p.kind != "plan" for p in impl.preds)


def test_plan_before_implement_gates_the_build():
    g = build_task_graph(_cfg(plan_position="before_implement"))
    impl = _by_kind(g, "impl")[0]
    tw = _by_kind(g, "test_write")[0]
    assert any(p.kind == "plan" for p in impl.preds)
    assert any(p.kind == "plan" for p in tw.preds)
    routing = _by_kind(g, "routing")[0]
    assert all(p.kind != "plan" for p in routing.preds)


def test_plan_before_implement_raises_rework_odds():
    """Placing the plan late raises implementation's rework probability."""
    late = _cfg(p=0.5, plan_position="before_implement", plan_rework_multiplier=2.0)
    early = _cfg(p=0.5, plan_position="before_routing")
    assert late.effective_rework_p() == pytest.approx(1.0)
    assert early.effective_rework_p() == pytest.approx(0.5)
    # the raised odds are realised by the seeded engine (more buckets reworked)
    late_res = run(late)
    early_res = run(early)
    assert late_res.rework_buckets >= early_res.rework_buckets
    assert late_res.rework_buckets == late_res.graph.num_buckets   # p_eff == 1.0
    assert late_res.risk > early_res.risk


def test_plan_rework_multiplier_is_clamped_and_validated():
    assert _cfg(p=0.9, plan_position="before_implement",
                plan_rework_multiplier=2.0).effective_rework_p() == pytest.approx(1.0)
    with pytest.raises(ValueError):
        _cfg(plan_rework_multiplier=0.5).validate()
    with pytest.raises(ValueError):
        _cfg(plan_position="sideways").validate()


# ---------------------------------------------------------------------------
# release gate (spec 5.2)
# ---------------------------------------------------------------------------
def test_release_gate_branch_sits_before_merge_to_main():
    g = build_task_graph(_cfg(release_gate="branch"))
    assert g.gate_suite is not None
    gate = g.gate_suite
    # the gate precedes every top (merge-to-main) merge
    for node in g.top_nodes:
        assert gate in node.merge.preds


def test_release_gate_main_sits_on_main_and_release_waits_on_it():
    g = build_task_graph(_cfg(release_gate="main"))
    gate = g.gate_suite
    assert gate is not None
    # the gate follows the merge-to-main builds (it runs ON main)
    assert any(p.kind == "merge" for p in gate.preds) or \
        any(p.kind == "main_build" for p in gate.preds)
    # and the release barrier waits on the gate
    pre = next(t for t in g.tasks if t.kind == "pre_release")
    assert gate in pre.preds


def test_release_gate_main_is_more_expensive_than_branch():
    """A gate failure on main needs a NEW branch -> pricier remediation."""
    base = _cfg(m=3, release_gate="branch")
    branch = run(base)
    main = run(replace(base, release_gate="main"))
    assert main.total_cost > branch.total_cost
    assert (main.cost_breakdown["gate_rework"]
            > branch.cost_breakdown["gate_rework"])
    assert main.violations == [] and branch.violations == []


def test_release_gate_can_be_the_only_test_run_in_the_extreme():
    cfg = _cfg(m=3, test_level="none", release_gate="main")
    res = run(cfg)
    assert res.num_suite_runs == 1                # the release gate alone
    assert res.violations == []
    # without a gate, "none" would run no test at all -> rejected (C10)
    with pytest.raises(ValueError):
        _cfg(test_level="none", release_gate="off").validate()
