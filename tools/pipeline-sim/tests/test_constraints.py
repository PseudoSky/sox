"""Supporting tests: the M1 model must respect the named constraints and the
analytic lower bound must be valid.  These back the sqrt test's claim that the
sweep results are trustworthy."""

from __future__ import annotations

import dataclasses

import pytest

from pipeline_sim import PipelineConfig, build_task_graph, run
from pipeline_sim.harness import run_and_report


@pytest.mark.parametrize("branch", ["flat", "hierarchical", "serial"])
def test_no_constraint_violations(branch):
    cfg = PipelineConfig(W_tot=200.0, w=10.0, n=5, m=3, branch=branch, alpha=2)
    res = run(cfg)
    assert res.violations == [], res.violations


@pytest.mark.parametrize("branch", ["flat", "hierarchical", "serial"])
def test_makespan_respects_critical_path_lower_bound(branch):
    cfg = PipelineConfig(W_tot=200.0, w=10.0, n=5, m=3, branch=branch, alpha=2)
    res = run(cfg)
    assert res.makespan + 1e-9 >= res.critical_path
    assert res.critical_path > 0


def test_one_suite_run_per_merge_C10():
    cfg = PipelineConfig(W_tot=200.0, w=10.0, n=5, m=3)
    res = run(cfg)
    assert res.num_suite_runs == res.num_merges


def test_full_suite_more_expensive_than_affected_only():
    base = dict(W_tot=200.0, w=10.0, n=5, m=3, alpha=2)
    full = run(PipelineConfig(**base, test_exec="full_suite"))
    affected = run(PipelineConfig(**base, test_exec="affected_only"))
    assert full.total_cost > affected.total_cost
    # full-suite makespan is no shorter than affected-only (it does more work)
    assert full.makespan >= affected.makespan - 1e-9


def test_optional_gates_add_tasks():
    off = run(PipelineConfig(W_tot=100.0, w=10.0, n=5, m=2))
    on = run(PipelineConfig(W_tot=100.0, w=10.0, n=5, m=2, y_triage=True, y_spec=True))
    assert on.num_tasks > off.num_tasks
    assert on.makespan >= off.makespan


def test_config_validate_rejects_unimplemented_knobs():
    with pytest.raises(NotImplementedError):
        run(PipelineConfig(W_tot=100.0, w=10.0, n=5, m=2, sigma="largest-last"))  # type: ignore[arg-type]
    with pytest.raises(NotImplementedError):
        build_task_graph(PipelineConfig(role_partition={"impl": ("impl",)}))


def test_determinism_same_config_same_result():
    cfg = PipelineConfig(W_tot=300.0, w=10.0, n=6, m=4, branch="hierarchical")
    a, b = run(cfg), run(cfg)
    assert a.makespan == b.makespan
    assert a.total_cost == b.total_cost
    assert a.num_merges == b.num_merges


def test_run_and_report_headline_fields():
    cfg = PipelineConfig(W_tot=100.0, w=10.0, n=5, m=2)
    res = run_and_report(cfg)
    assert res.makespan > 0
    assert res.total_cost > 0
    assert res.num_suite_runs >= 1
    assert res.num_merges >= 1
