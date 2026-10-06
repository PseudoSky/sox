"""Robustness regressions for the sweep (spec 10.1/10.2): a bad configuration --
impossible, unschedulable or otherwise rejected by the engine -- must be skipped,
never abort the sweep, and never crash the app.

Two layers are covered:

* the engine layer (:mod:`pipeline_sim.explore`) -- ``run_sweep`` catches **any**
  exception, not only ``ValueError``, records the skip and keeps going; and the
  search domain is *valid by construction* (no ``level:L`` deeper than the tree);
* the app layer (``app.py``) -- pressing **Run the sweep** across the crash-prone
  domains (depth 1 alongside ``level:2``, bucket caps, release-gate variants)
  populates results and renders every tab and every chart with no exception.
"""

from __future__ import annotations

from dataclasses import replace
from pathlib import Path

import pytest

from pipeline_sim import PipelineConfig
from pipeline_sim.explore import (
    SearchDomain,
    is_realisable,
    iter_configs,
    level_of,
    run_sweep,
)

# ---------------------------------------------------------------------------
# engine layer: valid-by-construction domain + never-abort sweep
# ---------------------------------------------------------------------------


def _base(M: int = 8) -> PipelineConfig:
    return PipelineConfig(W_tot=M * 10.0, w=10.0, n=4, m=4)


def test_is_realisable_predicate_matches_the_models_own_parse():
    assert is_realisable("all", 1)
    assert is_realisable("top", 1)
    assert is_realisable("none", 1)
    assert not is_realisable("level:2", 1)   # the impossible combination
    assert is_realisable("level:2", 2)
    assert not is_realisable("bogus", 2)     # malformed -> not realisable
    assert level_of("level:3") == 3
    assert level_of("all") is None and level_of("bogus") is None


def test_effective_size_counts_only_runnable_level_combos():
    d = SearchDomain(ns=(4,), alphas=(2,), branch_levels=(1, 2), branch_fanouts=(2,),
                     test_levels=("all", "level:2"), test_execs=("full_suite",), ms=(4,))
    # raw product 2 x 2 = 4; runnable = L1:{all} + L2:{all, level:2} = 3
    assert d.size() == 4
    assert d.effective_size() == 3
    assert d.valid_test_level_count() == 3


def test_iter_configs_valid_only_never_emits_an_impossible_level():
    d = SearchDomain(ns=(4,), alphas=(2,), branch_levels=(1, 2), branch_fanouts=(2,),
                     test_levels=("all", "level:2"), test_execs=("full_suite",), ms=(4,))
    cfgs = list(iter_configs(_base(), d, valid_only=True))
    assert len(cfgs) == 3
    assert not any(c.test_level == "level:2" and c.branch_levels == 1 for c in cfgs)
    # the raw iterator still covers the whole grid (used to report totals)
    assert len(list(iter_configs(_base(), d))) == 4


def test_run_sweep_skips_impossible_level_without_aborting():
    d = SearchDomain(ns=(4,), alphas=(2,), branch_levels=(1,), branch_fanouts=(2,),
                     test_levels=("all", "level:2"), test_execs=("full_suite",), ms=(4,))
    skipped: list = []
    pts = run_sweep(_base(), d, skipped=skipped)
    assert len(pts) == 1                       # ``all`` survives, ``level:2`` is skipped
    assert skipped and "level:2" in skipped[0][1]


def test_run_sweep_never_aborts_on_any_non_valueerror(monkeypatch):
    """The core regression: an engine exception that is NOT ValueError is skipped.

    ``run_sweep`` used to catch only ``ValueError``; any other engine failure
    propagated and killed the whole sweep.  Here ``run`` is forced to raise a
    ``RuntimeError`` for one grid value and the sweep must still return the rest.
    """
    import pipeline_sim.explore as ex

    real_run = ex.run

    def flaky(cfg):
        if cfg.n == 99:
            raise RuntimeError("boom")
        return real_run(cfg)

    monkeypatch.setattr(ex, "run", flaky)
    d = SearchDomain(ns=(4, 99), alphas=(2,), branch_levels=(2,), branch_fanouts=(2,),
                     test_levels=("level:2",), test_execs=("full_suite",), ms=(4,))
    skipped: list = []
    pts = run_sweep(_base(), d, skipped=skipped)
    assert pts and all(p.n == 4 for p in pts)
    assert any("RuntimeError" in reason for _cfg, reason in skipped)


def test_run_sweep_skips_a_real_non_valueerror_engine_rejection():
    """A genuine non-ValueError engine rejection (unimplemented merge order)."""
    base = replace(_base(), sigma="largest_last")   # -> NotImplementedError
    d = SearchDomain(ns=(4,), alphas=(2,), branch_levels=(1,), branch_fanouts=(2,),
                     test_levels=("all",), test_execs=("full_suite",), ms=(4,))
    skipped: list = []
    pts = run_sweep(base, d, skipped=skipped)       # must NOT raise
    assert pts == []
    assert skipped and "NotImplementedError" in skipped[0][1]


def test_run_sweep_skips_the_branch_gate_bucket_cap_deadlock():
    """``max_parallel_buckets < bucket count`` + a branch release gate deadlocks.

    The engine reports it as a ``ValueError``; ``run_sweep`` must record and skip
    it, never let it become fatal.
    """
    base = PipelineConfig(W_tot=600.0, w=10.0, n=5, m=4,
                          max_parallel_buckets=2, release_gate="branch")
    d = SearchDomain(ns=(5,), alphas=(2,), branch_levels=(1,), branch_fanouts=(2,),
                     test_levels=("all",), test_execs=("full_suite",), ms=(4,))
    skipped: list = []
    pts = run_sweep(base, d, skipped=skipped)       # must NOT raise
    assert isinstance(pts, list)
    assert skipped and any("did not complete" in reason for _cfg, reason in skipped)


# ---------------------------------------------------------------------------
# app layer: drive the crash-prone domains through a sweep + every tab
# ---------------------------------------------------------------------------

pytest.importorskip("streamlit")
from streamlit.testing.v1 import AppTest  # noqa: E402

APP = str(Path(__file__).resolve().parents[1] / "app.py")

_ALL_CHART_KEYS = {
    "fig_discovered", "fig_cost_time", "fig_h1", "fig_bucket", "fig_alpha",
    "fig_agents", "fig_tradeoffs", "fig_scenario", "fig_scenario_gantt",
}

#: (name, dom_n, dom_branch_levels, dom_test_levels, max_parallel_buckets, dom_m)
_CRASH_PRONE_DOMAINS = [
    ("depth{1,2} + level:2 (the impossible cross-product)", "3, 5, 8", "1,2",
     ["all", "level:2", "top"], 2, "2, 4, 8"),
    ("depth{1,2,3} + level:2,3", "4", "1,2,3",
     ["all", "level:2", "level:3", "top"], 1, "4"),
    ("single depth 1 (no level option)", "4", "1",
     ["all", "top"], 2, "4"),
    ("bucket cap 1 on depth 1 (cap < buckets)", "4", "1",
     ["all", "top"], 1, "4"),
    ("unlimited cap, level:2 only", "4", "1,2",
     ["level:2"], 0, "4"),
]


def _chart_keys(at: AppTest) -> set:
    return {c.key for c in at.get("plotly_chart") if getattr(c, "key", None)}


def _set_domain(at: AppTest, lv: str, tl: list[str], cap: int, m: str, ns: str) -> None:
    at.text_input(key="dom_n").set_value(ns)
    at.text_input(key="dom_alpha").set_value("1, 2, 3")
    at.text_input(key="dom_branch_levels").set_value(lv)
    at.text_input(key="dom_branch_fanout").set_value("2")
    at.text_input(key="dom_m").set_value(m)
    at.multiselect(key="dom_test_level").set_value(tl)
    at.multiselect(key="dom_test_exec").set_value(["full_suite"])
    at.number_input(key="max_parallel_buckets").set_value(cap)


@pytest.mark.parametrize("name,ns,lv,tl,cap,m", _CRASH_PRONE_DOMAINS,
                         ids=[d[0] for d in _CRASH_PRONE_DOMAINS])
def test_app_sweeps_crash_prone_domains_and_every_tab_without_exception(
        name, ns, lv, tl, cap, m):
    """Press **Run the sweep** then render every tab/chart: nothing may raise.

    This is the end-to-end crash regression: each domain includes a depth-1
    cluster (with ``level:2``/``level:3`` where the sidebar offers it) and a
    bucket cap, so both the impossible ``level:L`` combination and the bucket
    limits are exercised.  The landing page also renders the release-gate
    variants (which run through the quiet runner).
    """
    at = AppTest.from_file(APP, default_timeout=300)
    at.run()
    assert not at.exception, at.exception

    _set_domain(at, lv, tl, cap, m, ns)
    at.run()
    assert not at.exception, at.exception

    at.button(key="run_sweep").click().run()
    assert not at.exception, at.exception           # the sweep never crashes
    results = at.session_state["results"]
    assert results is not None and len(results) > 0  # and it actually produced points

    # every feasible point is genuinely runnable (no impossible combo leaked in)
    assert all(not (p.branch_levels == 1 and p.test_level.startswith("level:"))
               for p in results), [(p.branch_levels, p.test_level) for p in results]

    # the bucket-cap domains must not have silently swallowed the whole grid
    # ... unless they legitimately deadlock, which is what skipping is for.

    # release-gate variants render (they run gated configs via the quiet runner)
    assert any("INSTANCE flows" in md.value for md in at.markdown)
    assert len(at.get("graphviz_chart")) >= 2

    # scenario charts
    at.button(key="btn_scenario").click().run()
    assert not at.exception, at.exception

    missing = _ALL_CHART_KEYS - _chart_keys(at)
    assert not missing, f"charts that failed to render for {name}: {sorted(missing)}"
    assert not [e.value for e in at.error if "failed to render" in e.value]


def test_app_run_sweep_reports_skips_but_never_crashes():
    """A domain with impossible combos reports them instead of dropping silently."""
    at = AppTest.from_file(APP, default_timeout=300)
    at.run()
    _set_domain(at, "1,2", ["all", "level:2", "top"], 2, "4", "4")
    at.run()
    assert not at.exception, at.exception
    at.button(key="run_sweep").click().run()
    assert not at.exception, at.exception
    assert at.session_state["results"] is not None
    # the impossible level:2 @ depth 1 combinations are accounted for
    assert any("skipped" in w.value for w in at.warning)


def test_sidebar_never_offers_a_level_deeper_than_the_selected_depths():
    """``level:L`` is only offered when some candidate depth is >= L."""
    at = AppTest.from_file(APP, default_timeout=180)
    at.run()
    # depth 1 -> no tier-level option at all
    at.text_input(key="dom_branch_levels").set_value("1")
    at.run()
    opts = at.multiselect(key="dom_test_level").options
    assert "from tier 2 up" not in opts and "from tier 3 up" not in opts, opts
    # depth 2 -> tier 2 offered, tier 3 not
    at.text_input(key="dom_branch_levels").set_value("1, 2")
    at.run()
    opts = at.multiselect(key="dom_test_level").options
    assert "from tier 2 up" in opts and "from tier 3 up" not in opts, opts
    # depth 3 -> tier 3 offered
    at.text_input(key="dom_branch_levels").set_value("1, 2, 3")
    at.run()
    opts = at.multiselect(key="dom_test_level").options
    assert "from tier 3 up" in opts, opts


def test_sidebar_refilters_a_stale_level_after_shrinking_the_depth():
    """Changing depth must drop a now-impossible ``level:L`` from the domain."""
    at = AppTest.from_file(APP, default_timeout=300)
    at.run()
    at.text_input(key="dom_branch_levels").set_value("1, 2, 3")
    at.multiselect(key="dom_test_level").set_value(["all", "level:2", "level:3", "top"])
    at.text_input(key="dom_n").set_value("4")
    at.text_input(key="dom_alpha").set_value("2")
    at.text_input(key="dom_branch_fanout").set_value("2")
    at.text_input(key="dom_m").set_value("4")
    at.multiselect(key="dom_test_exec").set_value(["full_suite"])
    at.number_input(key="max_parallel_buckets").set_value(2)
    at.run()
    assert not at.exception, at.exception

    # shrink depth -> level:3 (and, at depth 1, level:2) are no longer realisable
    at.text_input(key="dom_branch_levels").set_value("1")
    at.run()
    assert not at.exception, at.exception
    at.button(key="run_sweep").click().run()
    assert not at.exception, at.exception
    results = at.session_state["results"]
    assert results is not None
    assert all(not (p.branch_levels == 1 and p.test_level.startswith("level:"))
               for p in results)
