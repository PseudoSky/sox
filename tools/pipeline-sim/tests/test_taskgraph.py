"""Tests for the editable task graph (spec 3.6 / C19 / C20) and the
Appendix-D expected-cost roll-up.

These pin three things:

1. the **default** graph preserves current behaviour (no override -> unchanged),
2. **C19** rejects cycles and **C20** warns on missing domain-required edges,
3. ``expected_cost_per_item`` matches the measured ``total$/fire`` column
   (spec Appendix C, off-peak + reasoning/cache-read) and derives occurrence
   counts from the realised structure.
"""

from __future__ import annotations

import pytest

from pipeline_sim import PipelineConfig, run
from pipeline_sim.taskgraph import (
    DEFAULT_TASK_GRAPH,
    REQUIRED_EDGES,
    TASK_TYPE_BY_ID,
    TASK_TYPES,
    TaskGraphSpec,
    effective_active,
    expected_cost_per_item,
    find_cycle,
    occurrence_counts,
    to_dot,
    validate_task_graph,
)

# "total$/fire" (LLM + CI) under the MEASURED calibration (spec Appendix C):
# off-peak prices ($0.15/$0.60/$0.003 per 1M) plus the reasoning (billed at the
# output rate) and cache-read classes.  The old Appendix-D column priced the
# peak card with neither class.  CI components are unchanged.
MEASURED_PER_FIRE = {
    "intake": 0.0027879,
    "routing": 0.0015439,
    "triage": 0.0032379,
    "spec": 0.0089637,
    "plan": 0.0064758,
    "implement": 0.0194273,
    "test_write": 0.0117516,
    "test_run": 0.0054879,          # 0.0027879 LLM + 0.0027 CI
    "review": 0.0079758,
    "review_routing": 0.0015439,
    "wt_setup": 0.0036476,          # 0.0006476 LLM + 0.003 CI
    "merge_resolve": 0.0224758,     # 0.0064758 LLM + 0.016 CI
    "main_build": 0.0416939,        # 0.0016939 LLM + 0.040 CI
    "gates": 0.0032379,
    "release": 0.0015439,
    "post_verify": 0.0015439,
}


# ---------------------------------------------------------------------------
# catalogue + defaults
# ---------------------------------------------------------------------------
def test_catalogue_is_the_sixteen_spec_task_types():
    assert len(TASK_TYPES) == 16
    assert len({t.id for t in TASK_TYPES}) == 16


@pytest.mark.parametrize("tid,expected", sorted(MEASURED_PER_FIRE.items()))
def test_per_fire_cost_matches_measured_calibration(tid, expected):
    assert TASK_TYPE_BY_ID[tid].per_fire == pytest.approx(expected, abs=1e-6)


def test_default_config_has_no_task_graph_override():
    cfg = PipelineConfig()
    assert cfg.T_active is None and cfg.P is None
    assert cfg.resolve_task_graph() == DEFAULT_TASK_GRAPH


def test_default_graph_is_acyclic_and_contains_every_required_edge():
    report = validate_task_graph(DEFAULT_TASK_GRAPH)
    assert report.ok, report.errors
    assert report.warnings == [], report.warnings
    eff = set(DEFAULT_TASK_GRAPH.effective_edges())
    for edge in REQUIRED_EDGES:
        assert edge in eff


def test_default_active_follows_the_optional_gate_flags():
    """No override -> triage/spec follow y_triage/y_spec, exactly as before."""
    default = effective_active(PipelineConfig())
    assert "implement" in default and "release" in default
    assert "triage" not in default and "spec" not in default
    gated = effective_active(PipelineConfig(y_triage=True, y_spec=True))
    assert "triage" in gated and "spec" in gated
    # an explicit T_active override is authoritative for the gates
    explicit = effective_active(PipelineConfig(
        T_active=("implement", "test_run", "triage", "release")))
    assert "triage" in explicit


# ---------------------------------------------------------------------------
# C19 / C20
# ---------------------------------------------------------------------------
def test_c19_rejects_a_cycle():
    cyc = TaskGraphSpec(
        active=("implement", "test_run", "release"),
        edges=(("implement", "test_run"), ("test_run", "implement"),
               ("merge_resolve", "release")),
    )
    report = validate_task_graph(cyc)
    assert not report.ok
    assert any("C19" in e for e in report.errors)
    found = find_cycle(cyc)
    assert found is not None and found[0] == found[-1]
    assert set(found) == {"implement", "test_run"}


def test_c19_cycle_rejected_by_config_validate():
    cfg = PipelineConfig(
        T_active=("implement", "test_run"),
        P=(("implement", "test_run"), ("test_run", "implement")),
    )
    with pytest.raises(ValueError, match="C19"):
        cfg.validate()


def test_c20_warns_on_missing_required_edge():
    # merge_resolve dropped while release is still active -> merges->release unmet
    spec = TaskGraphSpec(
        active=("implement", "test_write", "test_run", "release"),
        edges=(("implement", "test_run"), ("test_write", "test_run")),
    )
    report = validate_task_graph(spec)
    assert report.ok  # a missing required edge warns, it does not reject
    assert any("C20" in w and "merge_resolve" in w for w in report.warnings)


def test_unknown_type_and_self_loop_are_errors():
    spec = TaskGraphSpec(active=("implement", "nope"),
                         edges=(("implement", "nope"), ("implement", "implement")))
    report = validate_task_graph(spec)
    assert any("unknown task type" in e for e in report.errors)
    assert any("self-loop" in e for e in report.errors)


def test_dangling_edge_is_a_warning_and_is_ignored():
    spec = TaskGraphSpec(active=("implement", "test_run"),
                         edges=(("implement", "test_run"), ("review", "release")))
    report = validate_task_graph(spec)
    assert any("inactive" in w for w in report.warnings)
    assert ("review", "release") not in spec.effective_edges()


def test_dangling_edge_to_optional_gate_is_not_warned():
    """The canonical graph keeps its gate edges; an edge into an optional gate
    that is toggled off is expected-dormant, not a warning."""
    spec = TaskGraphSpec(
        active=("implement", "test_run", "routing", "release"),
        edges=(("implement", "test_run"), ("routing", "triage"),
               ("merge_resolve", "release")),
    )
    report = validate_task_graph(spec)
    assert not any("'triage'" in w for w in report.warnings)


def test_to_dot_contains_active_nodes_and_edges():
    dot = to_dot(DEFAULT_TASK_GRAPH)
    assert dot.startswith("digraph")
    # C6 relaxed (spec 5.2): test_write -> test_run (NOT implement -> test_run)
    assert '"test_write" -> "test_run"' in dot
    assert '"implement" -> "test_run"' not in dot
    assert '"release"' in dot


# ---------------------------------------------------------------------------
# expected_cost_per_item (Appendix D)
# ---------------------------------------------------------------------------
def _cfg(**kw) -> PipelineConfig:
    base = dict(W_tot=200.0, w=10.0, n=5, m=4, alpha=2)  # M=20 -> 4 buckets
    base.update(kw)
    return PipelineConfig(**base)


def test_occurrence_counts_from_realised_structure():
    cfg = _cfg(n=5, alpha=2, branch_levels=1)  # M=20, b=4, flat merges
    counts = occurrence_counts(cfg)
    assert counts["implement"] == 20          # per ticket
    assert counts["test_write"] == 40         # per AC = M*alpha
    assert counts["test_run"] == 40
    assert counts["plan"] == 4                # per bucket
    assert counts["wt_setup"] == 20           # per worktree/node
    assert counts["merge_resolve"] == 20
    assert counts["main_build"] == 20         # flat: every merge is to main
    assert counts["gates"] == counts["release"] == 1


def test_occurrence_counts_zero_for_inactive_types():
    counts = occurrence_counts(_cfg())
    assert counts["triage"] == 0 and counts["spec"] == 0   # gates off by default
    active = occurrence_counts(_cfg(T_active=tuple(t.id for t in TASK_TYPES),
                                    P=DEFAULT_TASK_GRAPH.edges))
    assert active["triage"] == 20 and active["spec"] == 20


def test_expected_report_rows_carry_per_fire_and_occurrences():
    cfg = _cfg()
    rep = expected_cost_per_item(cfg)
    by_id = {r.id: r for r in rep.rows}
    assert by_id["implement"].per_fire == pytest.approx(0.0194273, abs=1e-6)
    assert by_id["implement"].occurrences == 20
    assert by_id["implement"].subtotal == pytest.approx(0.0194273 * 20, abs=1e-5)
    # inactive catalogue types are present but carry zero occurrences
    assert by_id["triage"].occurrences == 0
    assert by_id["triage"].subtotal == 0.0


def test_expected_scenario_total_is_items_plus_extras():
    rep = expected_cost_per_item(_cfg())
    assert rep.total == pytest.approx(rep.items_total + rep.extras_total)
    assert rep.total > 0
    extra_ids = {e.id for e in rep.extras}
    assert {"dispatch", "suite", "tool", "rework", "holding"} <= extra_ids


def test_engine_honours_t_active_optional_gates():
    """An explicit T_active override turns the optional gates on/off."""
    plain = run(_cfg(m=3))
    gated = run(_cfg(m=3, T_active=tuple(t.id for t in TASK_TYPES),
                     P=DEFAULT_TASK_GRAPH.edges))
    assert gated.num_tasks > plain.num_tasks  # triage + spec added
    assert gated.violations == []
