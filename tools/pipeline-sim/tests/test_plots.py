"""Tests for the visualization layer (spec 10 plot pack).

These are smoke + correctness tests for the additive ``pipeline_sim.plots``
module.  They are skipped when the optional ``viz`` extra is not installed
(``pip install -e '.[viz]'``), so the core deterministic test suite stays
dependency-light.

Run::

    ./.venv/bin/pytest tests/test_plots.py -v
"""

from __future__ import annotations

import math

import pytest

pytest.importorskip("matplotlib")
pytest.importorskip("plotly")
pytest.importorskip("numpy")

from pipeline_sim import PipelineConfig, run  # noqa: E402
from pipeline_sim.plots import (  # noqa: E402
    _agent_utilisation,
    _loglog_slope,
    compute_design_grid,
    compute_sqrt_scaling,
    generate_all,
    pareto_front,
)


# ---------------------------------------------------------------------------
# pure helpers
# ---------------------------------------------------------------------------
def test_loglog_slope_recovers_sqrt_law():
    xs = [1, 4, 16, 64]
    ys = [2 * math.sqrt(x) for x in xs]
    assert math.isclose(_loglog_slope(xs, ys), 0.5, rel_tol=1e-9)


def test_pareto_front_keeps_only_non_dominated():
    Ms = [1, 2, 3, 4, 5, 6]

    class P:
        def __init__(self, cost, makespan):
            self.cost = cost
            self.makespan = makespan
            self.n = 0
            self.alpha = 0
            self.branch_levels = 0
            self.branch_fanout = 0
            self.test_level = "all"
            self.m = 0

    pts = [
        P(1.0, 10.0),   # frontier
        P(2.0, 5.0),    # frontier
        P(3.0, 4.0),    # frontier
        P(2.5, 7.0),    # dominated by (2,5)
        P(4.0, 10.0),   # dominated by (1,10)
        P(0.5, 20.0),   # frontier
    ]
    front = pareto_front(pts)
    got = sorted((p.cost, p.makespan) for p in front)
    assert got == [(0.5, 20.0), (1.0, 10.0), (2.0, 5.0), (3.0, 4.0)]


def test_agent_utilisation_sums_to_busy_share_of_makespan():
    cfg = PipelineConfig(W_tot=80.0, w=10.0, n=4, alpha=2, m=3,
                         branch_levels=2, test_level="all")
    res = run(cfg)
    agents, util = _agent_utilisation(res)
    assert len(agents) >= 1
    assert all(0.0 <= u <= 1.0 for u in util)
    # total busy time cannot exceed m * makespan
    busy_total = sum(u * res.makespan for u in util)
    assert busy_total <= res.config.m * res.makespan + 1e-6


def test_sqrt_scaling_endpoints_are_interior_and_positive():
    rows = compute_sqrt_scaling((8, 16))
    for r in rows:
        assert 1 < r.n_star < r.M
        assert r.cost > 0
        assert r.n_analytic > 0
    # n* is non-decreasing in M
    assert rows[-1].n_star >= rows[0].n_star


def test_design_grid_is_complete_and_runs_clean():
    pts = compute_design_grid(
        M=12, ns=(2, 4), alphas=(1, 2), levels=(1, 2), fanouts=(2,),
        test_levels=("all", "top"), ms=(2, 4))
    assert len(pts) == 2 * 2 * 2 * 1 * 2 * 2
    assert all(p.ok for p in pts)
    assert all(p.cost > 0 and p.makespan > 0 for p in pts)


# ---------------------------------------------------------------------------
# end-to-end render smoke test
# ---------------------------------------------------------------------------
def test_generate_all_quick_writes_non_empty_figures(tmp_path):
    rendered = generate_all(tmp_path, quick=True)
    keys = {r.key for r in rendered}
    assert {"sqrt", "h1", "pareto", "heatmap", "tornado", "compounding",
            "small_multiples", "gantt", "parcoords", "dashboard"} <= keys

    for r in rendered:
        for p in r.paths:
            assert p.exists(), p
            assert p.stat().st_size > 0, p

    # both a static PNG and an interactive HTML exist for the core figures
    assert (tmp_path / "01_sqrt_scaling.png").stat().st_size > 0
    assert (tmp_path / "01_sqrt_scaling.html").stat().st_size > 0
    # the dashboard is interactive HTML only
    assert (tmp_path / "10_dashboard.html").exists()
    # the shared Plotly runtime is written once for offline viewing
    assert (tmp_path / "plotly.min.js").stat().st_size > 0

    # dashboard must reference the shared runtime and contain tab wiring
    dash = (tmp_path / "10_dashboard.html").read_text(encoding="utf-8")
    assert "plotly.min.js" in dash
    assert "showTab(" in dash


def test_generate_only_subset(tmp_path):
    rendered = generate_all(tmp_path, quick=True, only=["sqrt"])
    assert [r.key for r in rendered] == ["sqrt"]
    assert (tmp_path / "01_sqrt_scaling.png").exists()
    assert not (tmp_path / "02_h1_contrast.png").exists()
