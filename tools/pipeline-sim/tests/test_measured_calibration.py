"""The measured cost model: reasoning + cache-read classes and distributions.

Guards the spec-Appendix-C "REAL MEASURED NUMBERS" block (the operator's own
``opencode.db``):

* the engine's LLM composition has all four billed classes and its shares
  resemble the measured input/output/reasoning/cache-read mix;
* dispatch and tool spend are input-only (they are not generation);
* the measured distributions are exposed (not just point estimates);
* the peak/off-peak switch scales the LLM terms and leaves CI alone.
"""

from __future__ import annotations

import pytest

from pipeline_sim import (
    LLM_COST_CLASSES,
    MEASURED_COST_COMPOSITION,
    PipelineConfig,
    format_measured_distributions,
    run,
)
from pipeline_sim.distributions import (
    MEASURED,
    MEASURED_TOTALS,
    PER_DISPATCH_COST,
    PER_STEP_COST,
    composition_rows,
    rows,
)

_REP = dict(W_tot=600.0, w=10.0, n=5, m=4, alpha=2)


def test_engine_exposes_all_four_llm_classes():
    res = run(PipelineConfig(**_REP))
    assert set(res.llm_cost_classes) == set(LLM_COST_CLASSES)
    assert all(v > 0 for v in res.llm_cost_classes.values()), res.llm_cost_classes
    assert sum(res.llm_cost_class_shares.values()) == pytest.approx(1.0)


def test_composition_resembles_the_measured_mix():
    res = run(PipelineConfig(**_REP))
    shares = res.llm_cost_class_shares
    for cls, measured in MEASURED_COST_COMPOSITION.items():
        # within 10 percentage points of the measured store mix
        assert abs(shares[cls] - measured) < 0.10, (cls, shares[cls], measured)
    # the two previously-unmodelled classes are material (together ~half)
    assert shares["reasoning"] + shares["cache_read"] > 0.35


def test_dispatch_and_tool_spend_are_input_only():
    res = run(PipelineConfig(**_REP))
    # dispatch + tool dollars are a subset of the input class (the rest is the
    # per-op input); they can never appear under output/reasoning/cache-read.
    input_usd = res.llm_cost_classes["input"]
    dispatch_plus_tool = (
        res.cost_breakdown["dispatch"] + res.cost_breakdown["tool"]
    )
    assert input_usd >= dispatch_plus_tool - 1e-9


def test_price_basis_switch_scales_llm_and_spares_ci():
    off = PipelineConfig(**_REP)
    peak = off.repriced("peak")
    r_off, r_peak = run(off), run(peak)
    # every LLM class doubles (the peak card is exactly 2x off-peak) ...
    for cls in LLM_COST_CLASSES:
        assert r_peak.llm_cost_classes[cls] == pytest.approx(
            2 * r_off.llm_cost_classes[cls])
    # ... while the CI-only lines are unchanged
    assert r_peak.cost_breakdown["suite"] == pytest.approx(
        r_off.cost_breakdown["suite"])
    assert r_peak.cost_breakdown["merge"] == pytest.approx(
        r_off.cost_breakdown["merge"])


# ---------------------------------------------------------------------------
# measured distributions (spec Appendix C) -- exposed, not just point estimates
# ---------------------------------------------------------------------------
def test_measured_distributions_are_present_with_p50_and_p90():
    assert len(MEASURED) >= 10
    # the two calibration anchors carry both a p50 and real spread
    assert PER_DISPATCH_COST.p50 < PER_DISPATCH_COST.p90
    assert PER_STEP_COST.p50 < PER_STEP_COST.p90
    assert MEASURED_TOTALS["cache_read_tokens"] == 34_500_000_000


def test_distribution_rows_are_tabular_and_composition_rows_sum():
    rws = rows()
    assert all("p50" in r and "p90" in r for r in rws)
    comp = composition_rows()
    assert sum(r["share"] for r in comp) == pytest.approx(1.0)
    assert {r["class"] for r in comp} == set(LLM_COST_CLASSES)


def test_format_measured_distributions_renders_p50_and_p90():
    text = format_measured_distributions()
    assert "p50" in text and "p90" in text
    assert "$354.65" in text
