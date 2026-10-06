"""Headless smoke tests for the Streamlit design-space explorer (``app.py``).

They drive the *actual* script through ``streamlit.testing.v1.AppTest`` -- no
mocks -- so a render regression is caught without a browser.  Skipped when the
optional ``ui`` extra is not installed (``pip install -e '.[ui]'``).
"""

from __future__ import annotations

from pathlib import Path

import pytest

pytest.importorskip("streamlit")

from streamlit.testing.v1 import AppTest  # noqa: E402

from pipeline_sim.config import PipelineConfig  # noqa: E402
from pipeline_sim.explore import pareto_front_cost_makespan  # noqa: E402

APP = str(Path(__file__).resolve().parents[1] / "app.py")


def _tiny_domain(at: AppTest) -> None:
    """Shrink the search domain to a handful of points so the sweep is instant."""
    at.text_input(key="dom_n").set_value("4")
    at.text_input(key="dom_alpha").set_value("2")
    at.text_input(key="dom_branch_levels").set_value("1,2")
    at.text_input(key="dom_branch_fanout").set_value("2")
    at.text_input(key="dom_m").set_value("4")
    at.multiselect(key="dom_test_level").set_value(["all", "top"])
    at.multiselect(key="dom_test_exec").set_value(["full_suite"])


def test_app_renders_without_exception():
    at = AppTest.from_file(APP, default_timeout=60)
    at.run()
    assert not at.exception, at.exception
    assert at.title[0].value == "pipeline-sim — design-space explorer"
    assert len(at.tabs) == 5
    # task-graph tab renders its DAG preview, validation and cost table
    assert len(at.get("graphviz_chart")) >= 1
    assert len(at.get("dataframe")) >= 1
    assert any("Valid" in s.value for s in at.success)
    # expected-cost metrics (M, scenario total, active types)
    assert len(at.metric) >= 3


def test_app_run_sweep_populates_results_and_views():
    at = AppTest.from_file(APP, default_timeout=120)
    at.run()
    _tiny_domain(at)
    at.button(key="run_sweep").click().run()
    assert not at.exception, at.exception
    results = at.session_state["results"]
    assert results is not None and len(results) == 4
    # views render plotly figures; drill-down renders a Gantt
    assert len(at.get("plotly_chart")) >= 5


def test_app_rejects_a_cyclic_task_graph():
    at = AppTest.from_file(APP, default_timeout=60)
    at.run()
    # seed a cyclic P over the active types
    at.session_state["tg_active"] = ["implement", "test_run", "release"]
    at.session_state["tg_edges"] = [
        ("implement", "test_run"), ("test_run", "implement"),
        ("merge_resolve", "release"),
    ]
    at.run()
    assert not at.exception, at.exception
    assert any("C19" in e.value for e in at.error)
    assert at.button(key="run_sweep").disabled is True


# ---------------------------------------------------------------------------
# Layout invariants: every design-space knob lives in the sidebar, and the
# landing page presents the discovered configurations.
# ---------------------------------------------------------------------------
_DESIGN_KNOB_KEYS = {
    "dom_n", "w", "dom_alpha", "dom_branch_levels", "dom_branch_fanout",
    "dom_test_level", "dom_test_exec", "dom_m",
    "adv_w_cost", "adv_w_time", "adv_w_risk",
}


def _widget_keys(block) -> set[str]:
    return ({w.key for w in block.text_input}
            | {w.key for w in block.number_input}
            | {w.key for w in block.multiselect}
            | {w.key for w in block.selectbox})


def test_sidebar_holds_all_design_knobs_and_main_body_has_none():
    at = AppTest.from_file(APP, default_timeout=120)
    at.run()
    assert not at.exception, at.exception

    sidebar_keys = _widget_keys(at.sidebar)
    assert _DESIGN_KNOB_KEYS <= sidebar_keys, _DESIGN_KNOB_KEYS - sidebar_keys
    # the Advanced expander's numeric parameters also live in the sidebar,
    # as does the Run control.
    assert {"adv_t_dispatch", "adv_t_suite", "adv_e", "adv_seed"} <= sidebar_keys
    assert "run_sweep" in {b.key for b in at.sidebar.button}

    main = at.main
    main_keys = _widget_keys(main)
    assert not (main_keys & _DESIGN_KNOB_KEYS), main_keys & _DESIGN_KNOB_KEYS
    # The main body carries no design-space knob controls at all -- only the
    # row-per-task dependency editor's multiselects remain.
    assert not main.text_input
    assert not main.number_input
    assert not main.selectbox
    assert main.multiselect and all(w.key.startswith("dep_") for w in main.multiselect)


def test_landing_does_not_run_the_full_sweep_on_load():
    """The FULL sweep must NOT run on load (it is slow and could crash).

    On first load the landing page renders a small CURATED default set; the
    ``results`` dataset -- populated only by the explicit **Run the sweep**
    button -- stays empty, so the heavy 540-combination sweep never runs
    automatically.
    """
    at = AppTest.from_file(APP, default_timeout=120)
    at.run()
    assert not at.exception, at.exception
    # no sweep ran: results is still empty ...
    assert at.session_state["results"] is None
    # ... but a small curated default set is present and rendered.
    cached = at.session_state["discovered_default"]
    assert cached is not None
    pts = cached[1]
    assert 0 < len(pts) <= 20
    # the landing tab is first and reports the default-discovered configurations
    assert at.tabs[0].label == "Discovered configurations"
    assert at.tabs[1].label == "Design & dependencies"
    assert any("default-discovered configurations" in i.value for i in at.info)
    assert len(at.get("dataframe")) >= 2
    # no chart/render failure occurred
    assert not [e.value for e in at.error if "failed to render" in e.value]


def test_landing_shows_instance_flows_for_variants():
    """Page 1 renders INSTANCE-level flows (so variants visibly differ)."""
    at = AppTest.from_file(APP, default_timeout=180)
    at.run()
    assert not at.exception, at.exception
    # the variant comparison lives on page 1 and draws instance flow graphs
    assert any("INSTANCE flows" in m.value for m in at.markdown)
    assert len(at.get("graphviz_chart")) >= 2


def test_landing_reflects_sweep_results_after_a_run():
    at = AppTest.from_file(APP, default_timeout=120)
    at.run()
    _tiny_domain(at)
    at.button(key="run_sweep").click().run()
    assert not at.exception, at.exception
    assert at.session_state["results"] is not None
    # the landing page now reports the sweep's discovered set, not the default
    assert any("feasible configurations discovered" in c.value for c in at.caption)


# ---------------------------------------------------------------------------
# Every tab and every chart must render without an unhandled exception.
# ---------------------------------------------------------------------------
#: Every chart the app can draw, by its ``key``.
_ALL_CHART_KEYS = {
    "fig_discovered", "fig_cost_time", "fig_h1", "fig_bucket", "fig_alpha",
    "fig_agents", "fig_tradeoffs", "fig_scenario", "fig_scenario_gantt",
}


def _chart_keys(at: AppTest) -> set:
    return {c.key for c in at.get("plotly_chart") if getattr(c, "key", None)}


def test_every_tab_and_every_chart_renders_without_exception():
    """Drive EVERY tab and EVERY chart; none may raise (the crash regression).

    Streamlit executes all five tab bodies on each run, so a page-load run
    already exercises the landing tab.  The Results and Scenario charts only
    populate once data exists, so this clicks **Run the sweep** (tiny domain)
    and **Run scenario**, then asserts the full chart set rendered with no
    exception and no render-guard error.
    """
    at = AppTest.from_file(APP, default_timeout=180)
    at.run()
    assert not at.exception, at.exception
    assert [t.label for t in at.tabs] == [
        "Discovered configurations", "Design & dependencies", "Results",
        "Answers", "Scenario",
    ]
    # the landing tab renders its frontier chart + instance-flow graphviz
    assert "fig_discovered" in _chart_keys(at)
    assert len(at.get("graphviz_chart")) >= 1

    # Run a tiny sweep -> every Results-tab chart must render.
    _tiny_domain(at)
    at.button(key="run_sweep").click().run()
    assert not at.exception, at.exception
    assert at.session_state["results"] is not None

    # Run the scenario -> its frontier overlay + Gantt must render.
    at.button(key="btn_scenario").click().run()
    assert not at.exception, at.exception

    missing = _ALL_CHART_KEYS - _chart_keys(at)
    assert not missing, f"charts that failed to render: {sorted(missing)}"
    # the per-tab render guard never had to fire
    assert not [e.value for e in at.error if "failed to render" in e.value]


# ---------------------------------------------------------------------------
# Interesting defaults + the removed hard-coded overrides (part-1 regressions).
# ---------------------------------------------------------------------------
def test_defaults_use_model_c_wip_and_do_not_force_bucket_size():
    """Regression: no hard-coded ``c_wip`` and no forced-max bucket size.

    The old UI hard-coded ``c_wip = 0.001`` -- a rounding error next to
    ``c_agent`` that switched the ∝n holding term off and collapsed the
    bucket-size optimum to the largest bucket ("max out the knob").  The
    Advanced default must be the model's calibrated value, and the default
    discovered set must span an INTERIOR bucket size with a non-trivial trade.
    """
    at = AppTest.from_file(APP, default_timeout=120)
    at.run()
    assert not at.exception, at.exception
    assert at.number_input(key="adv_c_wip").value == pytest.approx(PipelineConfig.c_wip)
    assert PipelineConfig.c_wip != pytest.approx(0.001)

    pts = at.session_state["discovered_default"][1]
    ns = {p.n for p in pts}
    assert len(ns) > 1, "the default set must span more than one bucket size"
    cheapest = min(pts, key=lambda p: p.cost)
    assert min(ns) < cheapest.n < max(ns), (
        f"cost-optimal bucket size {cheapest.n} is on the boundary "
        f"{min(ns)}..{max(ns)} -- the bucket size must not be forced to max")


def test_curated_defaults_are_the_interesting_interior_set():
    """The requested interesting defaults are the app's actual defaults.

    ~60 tickets at ~2 ACs, a mid-range bucket size, branch depth 2, partial
    test deferral (tier >= 2), ~4 agents, ~2 parallelizable buckets, and equal
    objective weights -- and the resulting set shows a REAL (interior) trade.
    """
    at = AppTest.from_file(APP, default_timeout=120)
    at.run()
    assert not at.exception, at.exception

    # the model defaults already encode ~60 tickets at ~2 ACs each (M=60)
    base = PipelineConfig()
    assert base.M == 60 and base.alpha == 2
    # ~2 parallelizable buckets, and equal objective weights, are the defaults
    assert at.number_input(key="max_parallel_buckets").value == 2
    assert (at.number_input(key="adv_w_cost").value,
            at.number_input(key="adv_w_time").value,
            at.number_input(key="adv_w_risk").value) == (1.0, 1.0, 1.0)

    pts = at.session_state["discovered_default"][1]
    # the interior default point (n=5, alpha=2, depth 2, tier>=2 deferral, m=4)
    # is IN the curated set ...
    assert any(p.n == 5 and p.alpha == 2 and p.branch_levels == 2
               and p.test_level == "level:2" and p.m == 4 for p in pts)
    # ... and the set spans depth, test-timing and agent-count so it is a real
    # trade rather than a single point
    assert {p.branch_levels for p in pts} == {1, 2}
    assert {p.test_level for p in pts} == {"all", "level:2", "top"}
    assert {p.m for p in pts} == {2, 4, 8}
    assert len(pareto_front_cost_makespan(pts)) > 1


def test_app_event_calibrated_toggle_renders_and_runs():
    """The real agent-event spend calibration is a first-class, additive UI path."""
    at = AppTest.from_file(APP, default_timeout=120)
    at.run()
    assert not at.exception, at.exception
    # turn the calibration on and pick the finer per-event unit
    at.checkbox(key="event_calibrated").set_value(True)
    at.radio(key="event_unit").set_value("event")
    _tiny_domain(at)
    at.run()
    assert not at.exception, at.exception
    # the panel reports the event stream and the calibrated state
    joined = " ".join(c.value for c in at.get("code"))
    assert "EVENT-DATA CALIBRATION" in joined
    assert "EVENT-CALIBRATED" in joined or "event" in joined.lower()
    # a full sweep still runs against the calibrated config
    at.button(key="run_sweep").click().run()
    assert not at.exception, at.exception
    assert len(at.session_state["results"]) == 4
