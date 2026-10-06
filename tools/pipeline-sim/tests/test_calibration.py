"""Calibration regression: the default parameters equal the MEASURED model.

Appendix C of ``docs/pipeline-simulation-spec.md`` grounds the model in real
prices and, in its "REAL MEASURED NUMBERS" block, the operator's own
``opencode.db``: the real runs bill OFF-PEAK (DeepSeek V4.1 Flash
input/output/cache-read $0.15/$0.60/$0.003 per 1M -- exactly half the old peak
card), reasoning is billed at the output rate, and cache-read is a first-class
class.  These tests pin the defaults to that measured table so a future edit
cannot silently drift back to the peak placeholders.

The token counts are the source of truth for the LLM costs: every ``c_op`` is
``llm_cost(in_tok, out_tok) = input + output + reasoning + cache_read`` at the
default (off-peak) basis, so the two halves of the table cannot disagree.
"""

from __future__ import annotations

import pytest

from pipeline_sim import (
    CACHE_READ_PER_OUTPUT,
    DEFAULT_TOKENS,
    DISPATCH_SCHEMA_TOKENS,
    LLM_COST_CLASSES,
    P_CACHE_READ,
    P_IN,
    P_IN_OFFPEAK,
    P_IN_PEAK,
    P_OUT,
    P_OUT_OFFPEAK,
    P_OUT_PEAK,
    PRICE_BASIS_DEFAULT,
    REASONING_PER_OUTPUT,
    TOOL_CALL_TOKENS,
    PipelineConfig,
    TaskDurations,
    TaskOpCost,
    TaskTokens,
    derive_op_costs,
    llm_cost,
    llm_cost_components,
    prices_for,
)


def test_price_basis_defaults_to_measured_off_peak():
    # spec Appendix C: the real runs bill OFF-PEAK -- input $0.15/M, output
    # $0.60/M, cache-read $0.003/M (the "peak" $0.30/$1.20 is exactly 2x).
    assert P_IN == pytest.approx(1.5e-7)
    assert P_OUT == pytest.approx(6.0e-7)
    assert P_CACHE_READ == pytest.approx(3.0e-9)
    assert PRICE_BASIS_DEFAULT == "off_peak"
    # the historical names ARE the off-peak effective values
    assert P_IN == P_IN_OFFPEAK and P_OUT == P_OUT_OFFPEAK
    # the peak card is retained, exactly 2x on input/output
    assert P_IN_PEAK == pytest.approx(2 * P_IN_OFFPEAK)
    assert P_OUT_PEAK == pytest.approx(2 * P_OUT_OFFPEAK)
    assert prices_for("peak")[0] == pytest.approx(2 * prices_for("off_peak")[0])


def test_llm_cost_components_sum_to_llm_cost():
    comp = llm_cost_components(30_000, 6_000)
    assert set(comp) == set(LLM_COST_CLASSES)
    assert sum(comp.values()) == pytest.approx(llm_cost(30_000, 6_000))
    # the measured mix formulas are pinned to the per-step ratios
    assert comp["reasoning"] == pytest.approx(
        REASONING_PER_OUTPUT * 6_000 * P_OUT)
    assert comp["cache_read"] == pytest.approx(
        CACHE_READ_PER_OUTPUT * 6_000 * P_CACHE_READ)


def test_llm_cost_matches_the_measured_table():
    # implement = 30k in, 6k out -> input 0.0045 + output 0.0036
    #   + reasoning 0.004520 + cache-read 0.006807 = 0.019427 (off-peak measured)
    assert llm_cost(30_000, 6_000) == pytest.approx(0.0194273, abs=1e-6)
    assert llm_cost(10_000, 3_000) == pytest.approx(0.0089637, abs=1e-6)   # spec
    assert llm_cost(2_000, 1_000) == pytest.approx(0.0027879, abs=1e-6)    # test_run
    # the pure input+output term is exactly half the old peak base
    assert llm_cost(30_000, 0, reasoning_tok=0, cache_read_tok=0) == pytest.approx(0.0045)


def test_reasoning_and_cache_read_are_modelled():
    # both previously-unmodelled classes are now non-zero and material
    comp = llm_cost_components(30_000, 6_000)
    assert comp["reasoning"] > 0
    assert comp["cache_read"] > 0
    assert comp["cache_read"] > comp["output"]
    # explicit overrides are honoured (an op with no replayed context)
    bare = llm_cost_components(30_000, 6_000, cache_read_tok=0)
    assert bare["cache_read"] == 0.0
    # reasoning is billed at the output rate
    assert llm_cost(0, 1_000, reasoning_tok=1_000, cache_read_tok=0) == pytest.approx(
        llm_cost(0, 2_000, reasoning_tok=0, cache_read_tok=0))


def test_op_cost_is_derived_from_the_token_counts():
    # the single-source-of-truth invariant
    assert TaskOpCost() == derive_op_costs(TaskTokens())
    assert TaskOpCost() == derive_op_costs(DEFAULT_TOKENS)


@pytest.mark.parametrize("field,expected", [
    ("impl", 0.0194273),
    ("test_write_per_ac", 0.0117516),
    ("test_run_per_ac", 0.0027879),
    ("merge", 0.0064758),
    ("setup", 0.0006476),
    ("pre_release", 0.0032379),
    ("release", 0.0015439),
    ("triage", 0.0032379),
    ("spec", 0.0089637),
])
def test_per_op_llm_costs_match_measured(field, expected):
    assert getattr(TaskOpCost(), field) == pytest.approx(expected, abs=1e-6)


@pytest.mark.parametrize("field,expected", [
    ("impl", 600.0),              # implement
    ("test_write_per_ac", 180.0),  # test_write
    ("merge", 120.0),             # merge_resolve
    ("setup", 20.0),              # wt_setup
    ("pre_release", 180.0),       # gates
    ("release", 60.0),
    ("triage", 60.0),
    ("spec", 120.0),
])
def test_per_op_durations_match_appendix_c(field, expected):
    assert getattr(TaskDurations(), field) == pytest.approx(expected)


def test_top_level_defaults_match_measured_calibration():
    cfg = PipelineConfig()
    assert cfg.t_dispatch == pytest.approx(3.0)
    assert cfg.c_dispatch == pytest.approx(DISPATCH_SCHEMA_TOKENS * P_IN)
    # measured first-step: 14,470 tok x off-peak P_IN -> ~$0.0022/fire
    assert cfg.c_dispatch == pytest.approx(0.0022, abs=1e-4)
    assert cfg.t_suite == pytest.approx(30.0)
    assert cfg.e == pytest.approx(20.0)              # per-AC exec; > 3 s
    assert cfg.c_suite == pytest.approx(0.008)       # 1 min CI @ $0.008/min
    assert cfg.c_a == pytest.approx(0.0027)          # 20 s CI @ $0.008/min
    assert cfg.c_wt == pytest.approx(0.003)
    assert cfg.c_merge == pytest.approx(0.016)
    # FIRST-ORDER knob costs (spec §4 NOTE / OPEN-7): rebalanced so depth,
    # bucket size and deferral each carry a cost that grows with the knob, and
    # the ∝ 1/n setup (c_bucket) balances the ∝ n holding term (c_wip) at
    # n* ~ sqrt(M).  The old c_wip (1e-3) was a rounding error next to c_agent.
    assert cfg.c_wip == pytest.approx(0.30)
    assert cfg.c_bucket == pytest.approx(0.20)
    # branch cost is charged per work unit integrated (Σ_nodes |tickets|),
    # so it scales with depth AND workload -> an interior depth optimum; the
    # per-deferred-AC gate rate is first-order -> an interior test-timing one.
    assert cfg.c_branch == pytest.approx(0.03)
    assert cfg.c_level == pytest.approx(0.02)
    assert cfg.c_gate_rework_per_deferred_ac == pytest.approx(0.010)
    assert cfg.OC == pytest.approx(TOOL_CALL_TOKENS * P_IN)
    assert cfg.OC == pytest.approx(0.000143, abs=1e-5)  # measured ~950 tok/call
    assert cfg.price_basis == "off_peak"


def test_horizon_stays_a_fixed_planning_horizon():
    """Spec 4 NOTE: horizon is a FIXED input, never the realised makespan."""
    cfg = PipelineConfig()
    assert cfg.horizon == pytest.approx(1.0)
    # it is a plain scalar input, independent of any run length
    assert isinstance(cfg.horizon, float)


def test_setup_and_merge_llm_cost_is_not_the_ci_cost():
    """The CI component lives in PipelineConfig, not in c_op (no double count)."""
    cfg = PipelineConfig()
    # merge LLM and merge CI are distinct line items
    assert cfg.c_op.merge == pytest.approx(0.0064758, abs=1e-6)
    assert cfg.c_merge == pytest.approx(0.016)
    assert cfg.c_op.setup == pytest.approx(0.0006476, abs=1e-6)
    assert cfg.c_wt == pytest.approx(0.003)


# ---------------------------------------------------------------------------
# peak/off-peak switch (spec Appendix C)
# ---------------------------------------------------------------------------
def test_repriced_switches_the_whole_llm_card():
    off = PipelineConfig()
    peak = off.repriced("peak")
    assert peak.price_basis == "peak"
    # exactly 2x every LLM term, and only the LLM terms
    assert peak.c_dispatch == pytest.approx(2 * off.c_dispatch)
    assert peak.OC == pytest.approx(2 * off.OC)
    assert peak.c_op.impl == pytest.approx(2 * off.c_op.impl)
    # CI terms are untouched by the price basis
    assert peak.c_suite == off.c_suite
    assert peak.c_merge == off.c_merge
    # and the switch is validated
    with pytest.raises(ValueError):
        off.repriced("noon")
