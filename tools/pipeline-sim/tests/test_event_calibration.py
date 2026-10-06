"""Real agent-event spend calibration (agent-dashboard event stream).

These pin the extraction, the operation -> real-agent mapping, the cold-start
calibration and the additive ``event_calibrated`` overlay, and — when the raw
40 MB source is present on this machine — prove the committed snapshot is a
faithful re-extraction of it.
"""

from __future__ import annotations

import math

import pytest

from pipeline_sim import PipelineConfig, run
from pipeline_sim.alpha import REAL_AC_DISTRIBUTION
from pipeline_sim.config import DISPATCH_SCHEMA_TOKENS, P_IN, llm_cost
from pipeline_sim.deps import PUBLISH_STAGE_FRAMING, format_publish_graph, measured_graph
from pipeline_sim import events as ev


@pytest.fixture(scope="module")
def ds() -> ev.EventDataset:
    return ev.dataset()


# ---------------------------------------------------------------------------
# provenance: the stream is the real one
# ---------------------------------------------------------------------------
def test_provenance_matches_the_stream(ds: ev.EventDataset):
    p = ds.provenance
    assert p["event_count"] == ev.EVENT_COUNT == 56_840
    assert p["schema_version"] == ev.EVENT_SCHEMA_VERSION == 3
    assert abs(float(p["total_cost_usd"]) - ev.TOTAL_COST_USD) < 0.01
    assert int(p["total_dispatches"]) == ev.TOTAL_DISPATCHES == 4_055
    assert int(p["total_steps"]) == ev.TOTAL_STEPS == 172_852
    assert int(p["total_tool_calls"]) == ev.TOTAL_TOOL_CALLS == 244_324
    assert "agent-dashboard/public/events.json" in str(p["source"])


def test_recomputed_cost_matches_billed_cost(ds: ev.EventDataset):
    """The four-class model at the off-peak card reproduces the stream's cost.

    The store's own per-row estimate is rounded, so the recomputation lands
    within a couple of percent of the billed total (measured: 0.7 %).
    """
    comp = ev.composition_rows(ds)
    recomputed = sum(c["usd"] for c in comp)
    billed = float(ds.provenance["total_cost_usd"])
    assert abs(recomputed - billed) / billed < 0.03
    assert abs(sum(c["share"] for c in comp) - 1.0) < 1e-9


# ---------------------------------------------------------------------------
# per-agent / per-task extraction
# ---------------------------------------------------------------------------
def test_agent_profiles_present_and_pinned(ds: ev.EventDataset):
    assert len(ds.agents) >= 40
    assert ds.agents["typescript"].sessions == 440
    assert ds.agents["backend"].sessions == 206
    assert ds.agents["dispatcher"].sessions == 40
    # a pinned mean run cost (regenerated only if the source changes)
    assert ds.agents["backend"].mean["cost_usd"] == pytest.approx(0.10634, abs=1e-4)
    # every profile is mean/median/p90 across real runs
    for p in ds.agents.values():
        assert p.sessions >= ev.MIN_SESSIONS
        assert p.mean["cost_usd"] >= 0
        assert p.p90["cost_usd"] >= p.median["cost_usd"] >= 0


def test_task_profiles_are_top_tasks(ds: ev.EventDataset):
    assert len(ds.tasks) == 30
    top = max(ds.tasks.values(), key=lambda v: v["cost_usd"])
    assert top["cost_usd"] > 0
    assert ds.tasks["Planning agent dashboard"]["rows"] > 0


def test_distributions_carry_counts(ds: ev.EventDataset):
    # the per-agent distribution is over ALL real agents (56), not only the
    # profiled ones (>= MIN_SESSIONS runs)
    assert ds.agent_dist["cost_usd"].count == 56
    assert ds.agent_dist["cost_usd"].count >= len(ds.agents)
    # per-event rows: exactly the stream's row count
    assert ds.per_event["cost_usd"].count == ev.EVENT_COUNT
    assert ds.per_event["cost_usd"].p90 >= ds.per_event["cost_usd"].p50


# ---------------------------------------------------------------------------
# operation -> real agent(s) mapping
# ---------------------------------------------------------------------------
def test_op_agent_mapping_covers_the_brief(ds: ev.EventDataset):
    assert ev.OP_AGENTS["impl"] == ("implement", "backend", "typescript")
    assert ev.OP_AGENTS["review"] == ("review", "reviewer")
    assert ev.OP_AGENTS["plan"] == ("plan-builder", "plan")
    assert ev.OP_AGENTS["explore"] == ("explore",)
    assert ev.OP_AGENTS["debug"] == ("debug",)
    assert ev.OP_AGENTS["research"] == ("researcher",)
    assert ev.OP_AGENTS["dispatch"] == ("dispatcher",)
    assert ev.OP_AGENTS["backlog"] == ("backlog-operator",)
    assert ev.OP_AGENTS["test_write"] == ("test", "test-agent")
    # every engine op the overlay writes has a profile
    for op in ev.ENGINE_OPS:
        assert ds.op_profile(op) is not None


def test_op_profile_is_the_mean_of_mapped_agents(ds: ev.EventDataset):
    prof = ds.op_profile("impl")
    expected = sum(ds.agents[a].mean["tokens_in"]
                   for a in ("implement", "backend", "typescript")) / 3.0
    assert prof.in_tok == pytest.approx(expected)
    # the cost is exactly the four-class llm_cost of the profile tokens
    assert prof.cost_usd == pytest.approx(
        llm_cost(prof.in_tok, prof.out_tok, prof.reasoning_tok,
                 prof.cache_read_tok)
    )
    assert prof.seconds > 0 and prof.tool_calls > 0


def test_per_ac_ops_are_split_by_the_median_ac_count(ds: ev.EventDataset):
    prof = ds.op_profile("test_write")
    raw = sum(ds.agents[a].mean["tokens_in"]
              for a in ("test", "test-agent")) / 2.0
    # the per-AC profile is exactly the raw agent-run token count / the divisor
    assert prof.in_tok == pytest.approx(raw / ev.PER_AC_DIVISOR)
    assert prof.seconds == pytest.approx(
        sum(ds.agents[a].mean["active_ms"]
            for a in ("test", "test-agent")) / 2.0
        / 1000.0 / ev.PER_AC_DIVISOR)


def test_per_event_unit_is_finer_than_per_run(ds: ev.EventDataset):
    run_p = ds.op_profile("impl", unit="run")
    ev_p = ds.op_profile("impl", unit="event")
    assert 0 < ev_p.cost_usd < run_p.cost_usd
    assert 0 < ev_p.seconds < run_p.seconds


# ---------------------------------------------------------------------------
# cold start uses the MEASURED per-agent system-prompt sizes
# ---------------------------------------------------------------------------
def test_cold_start_uses_measured_agent_prompt_sizes(ds: ev.EventDataset):
    agents = [a for a in ev.dispatched_agents() if a in ds.agents]
    expected = sum(ds.agents[a].cold_start_cost for a in agents) / len(agents)
    assert ev.calibrated_c_dispatch(ds) == pytest.approx(expected)
    # the real per-agent prompt is far larger than the old flat 14,470-token
    # schema constant (it is the replayed system prompt + schemas)
    biggest = max(ds.agents[a].cold_start_prompt for a in ds.agents)
    assert biggest > DISPATCH_SCHEMA_TOKENS
    # a cold start billed at the right rates is cheap (the cached prefix is
    # charged at the cache-read rate, not the input rate)
    assert 0 < ev.calibrated_c_dispatch(ds) < 0.01


def test_tool_call_cost_is_event_derived(ds: ev.EventDataset):
    oc = ev.calibrated_OC(ds)
    # measured $0.0001418, within 1 % of the prior opencode.db value 0.000143
    assert oc == pytest.approx(0.000143, rel=0.02)


# ---------------------------------------------------------------------------
# the additive overlay
# ---------------------------------------------------------------------------
def _base() -> PipelineConfig:
    return PipelineConfig(W_tot=600, w=10, n=5, m=4, branch_levels=1,
                          test_level="all", ac_distribution=REAL_AC_DISTRIBUTION)


def test_overlay_is_additive_default_config_untouched():
    base = PipelineConfig()
    # importing / using the module never mutates the shipped defaults
    assert base.c_dispatch == pytest.approx(DISPATCH_SCHEMA_TOKENS * P_IN)
    assert base.op_event_profiles is None
    assert base.c_op.impl == PipelineConfig().c_op.impl


def test_event_calibrated_validates_and_runs_clean(ds: ev.EventDataset):
    cal = ev.event_calibrated(_base(), ds=ds)
    cal.validate()
    assert cal.op_event_profiles is not None and len(cal.op_event_profiles) > 0
    # the per-op tokens / durations / costs came from the real profiles
    impl = ds.op_profile("impl")
    assert cal.tokens.impl == (impl.in_tok, impl.out_tok)
    assert cal.c_op.impl == pytest.approx(impl.cost_usd)
    assert cal.durations.impl == pytest.approx(impl.seconds)
    assert cal.c_dispatch == pytest.approx(ev.calibrated_c_dispatch(ds))
    assert cal.OC == pytest.approx(ev.calibrated_OC(ds))

    res = run(cal)
    assert res.violations == []
    assert res.total_cost > 0


def test_overlay_changes_the_forecast_shape(ds: ev.EventDataset):
    base = run(_base())
    cal = run(ev.event_calibrated(_base(), ds=ds))
    # real agentic operations cost more than the Appendix-C placeholders
    assert cal.total_cost > base.total_cost
    assert cal.makespan > base.makespan
    # and the LLM composition now matches the real event stream
    stream = {c["class"]: c["share"] for c in ev.composition_rows(ds)}
    shares = cal.llm_cost_class_shares
    for cls in ("input", "output", "reasoning", "cache_read"):
        assert abs(shares[cls] - stream[cls]) < 0.06


def test_overlay_unit_event_is_cheaper_than_unit_run(ds: ev.EventDataset):
    r = run(ev.event_calibrated(_base(), ds=ds, unit="run"))
    e = run(ev.event_calibrated(_base(), ds=ds, unit="event"))
    assert e.total_cost < r.total_cost
    with pytest.raises(ValueError):
        ev.event_calibrated(_base(), ds=ds, unit="bogus")


def test_overlay_is_hashable_and_deterministic(ds: ev.EventDataset):
    a = ev.event_calibrated(_base(), ds=ds)
    b = ev.event_calibrated(_base(), ds=ds)
    # the explicit-profile field is a hashable tuple of tuples; the app's caches
    # key on repr(cfg), so determinism there matters too
    assert isinstance(a.op_event_profiles, tuple)
    assert all(isinstance(q, tuple) and len(q) == 2 for q in a.op_event_profiles)
    assert hash(a.op_event_profiles) == hash(b.op_event_profiles)
    assert a.op_event_profiles == b.op_event_profiles
    assert repr(a) == repr(b)


def test_catalogue_per_fire_honours_calibration(ds: ev.EventDataset):
    from pipeline_sim.taskgraph import expected_cost_per_item
    cal = ev.event_calibrated(_base(), ds=ds)
    rows = {r.id: r for r in expected_cost_per_item(cal).rows}
    assert rows["implement"].per_fire == pytest.approx(
        ds.op_profile("impl").cost_usd)
    # a default config still reports the shipped Appendix-D value
    base_rows = {r.id: r for r in expected_cost_per_item(_base()).rows}
    assert base_rows["implement"].per_fire == pytest.approx(
        PipelineConfig().c_op.impl)


# ---------------------------------------------------------------------------
# the publishing-DAG framing: it orders PUBLISH, not implementation
# ---------------------------------------------------------------------------
def test_framing_constant_states_publish_stage():
    text = PUBLISH_STAGE_FRAMING
    assert "PUBLISH stage, not implementation" in text
    assert "do NOT publish between them" in text
    assert "cross-project" in text
    assert "File overlap never bounds parallelism" in text


def test_framing_is_surfaced_in_the_report():
    text = format_publish_graph(measured_graph().summary())
    assert "orders the PUBLISH stage" in text
    # the measured numbers the report already pinned are still there
    assert "75 components" in text and "publish waves = 6" in text


def test_implementation_is_not_serialized_by_the_component_dag():
    """The component dependency DAG never schedules IMPLEMENTATION.

    The DAG is a release-stage graph: within a project components run their
    implementation concurrently, so neither the model nor the engine may
    consult ``pipeline_sim.deps`` (it is read only for the publish-graph panel).
    """
    import inspect

    from pipeline_sim import build_task_graph, deps, engine, model

    # structural guard: the scheduling modules do not import the publish DAG
    for module in (engine, model):
        src = inspect.getsource(module)
        assert "pipeline_sim.deps" not in src
        assert "from .deps" not in src
        assert "import deps" not in src
    # deps exposes publish scheduling only -- no task-graph builder
    assert not hasattr(deps, "build_task_graph")
    assert hasattr(deps.ComponentGraph, "publish_set")
    # and the instantiated implementation graph is unaffected by it
    graph = build_task_graph(PipelineConfig(n=5, branch_levels=1))
    assert len(graph.tasks) > 0
    for t in graph.tasks:
        for p in t.preds:
            assert hasattr(p, "kind")


# ---------------------------------------------------------------------------
# re-extraction from the raw source (skipped when it is absent)
# ---------------------------------------------------------------------------
@pytest.mark.skipif(not ev.source_available(),
                    reason="raw events.json not present on this machine")
def test_extract_from_source_reproduces_the_snapshot(ds: ev.EventDataset):
    live = ev.extract()
    # headline integer provenance is exact
    for key in ("event_count", "total_dispatches", "total_steps",
                "total_tool_calls"):
        assert live.provenance[key] == ds.provenance[key]
    assert live.provenance["total_cost_usd"] == pytest.approx(
        ds.provenance["total_cost_usd"], abs=0.01)
    assert set(live.agents) == set(ds.agents)
    # a sampled agent and the derived op profiles agree within float tolerance
    assert live.agents["backend"].mean["cost_usd"] == pytest.approx(
        ds.agents["backend"].mean["cost_usd"], rel=1e-9)
    assert live.op_profile("impl").cost_usd == pytest.approx(
        ds.op_profile("impl").cost_usd, rel=1e-9)
    assert live.op_profile("review").seconds == pytest.approx(
        ds.op_profile("review").seconds, rel=1e-9)


# ---------------------------------------------------------------------------
# reporting
# ---------------------------------------------------------------------------
def test_report_renders(ds: ev.EventDataset):
    text = ev.format_event_report(ds)
    assert "EVENT-DATA CALIBRATION" in text
    assert "PER-OPERATION CALIBRATION" in text
    assert "PER-AGENT PROFILES" in text
    assert "PER-TASK PROFILES" in text
    assert "EVENT DISTRIBUTIONS" in text
    # the op table shows the mapped real agents
    assert "implement, backend, typescript" in text
