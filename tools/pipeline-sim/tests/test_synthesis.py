"""Synthesis v2 (spec §10.2 item 3): every knob explained, plus deltas vs the
PRIMARY baseline (% faster / cheaper / safer / overall)."""

from __future__ import annotations

from dataclasses import replace

from pipeline_sim import (
    PipelineConfig,
    deltas_vs_primary,
    describe_config,
    format_deltas,
    run,
    synthesis_table,
)

#: Every knob spec §10.2 item 3 requires the synthesis table to explain.
_REQUIRED_FIELDS = {
    "Total workload (work units)",
    "Work per ticket",
    "Bucket size (tickets per bucket)",
    "AC per ticket (α)",
    "Branch depth (merge levels)",
    "Branch fan-out",
    "Agents (m)",
    "Parallelizable buckets",
    "When to test",
    "Test scope",
    "Plan placement",
    "Release gate",
    "Objective weights (cost / time / risk)",
}


def test_describe_config_explains_every_knob():
    cfg = PipelineConfig(W_tot=600.0, w=10.0, n=5, alpha=2,
                         branch_levels=2, branch_fanout=2, m=4,
                         test_level="top", test_exec="full_suite")
    res = run(cfg)
    rows = describe_config(cfg, res)
    fields = {r["Field"] for r in rows}
    missing = _REQUIRED_FIELDS - fields
    assert not missing, f"synthesis table is missing knobs: {sorted(missing)}"
    # every row has the three contract columns, non-empty
    for r in rows:
        assert r["Field"] and r["Value"] and r["What it means"]
    # the run metrics are appended when a result is supplied
    assert "Cost ($)" in fields and "End-to-end time (s)" in fields


def test_describe_config_without_result_still_lists_all_knobs():
    fields = {r["Field"] for r in describe_config(PipelineConfig())}
    assert _REQUIRED_FIELDS <= fields


def test_deltas_vs_primary_are_signed_and_weighted():
    primary = run(PipelineConfig(W_tot=600.0, w=10.0, n=5, alpha=2,
                                 branch_levels=1, test_level="all", m=4))
    # a strictly different optimum
    res = run(replace(primary.config, n=10, branch_levels=2, test_level="top"))

    d = deltas_vs_primary(primary, res, weights=(1.0, 2.0, 1.0))
    # keys the spec names
    assert {"pct_faster", "pct_cheaper", "pct_safer", "pct_overall"} <= set(d)
    # a positive percentage always means "better" (cost/time/risk lower is better)
    assert d["pct_cheaper"] == ((primary.total_cost - res.total_cost)
                                / abs(primary.total_cost) * 100)
    # the overall is the weight-averaged relative improvement
    expected = (1.0 * d["pct_faster"] + 2.0 * d["pct_cheaper"]
                + 1.0 * d["pct_safer"]) / 4.0
    assert abs(d["pct_overall"] - expected) < 1e-9
    assert "faster" in format_deltas(d) and "overall" in format_deltas(d)


def test_deltas_of_a_config_against_itself_are_zero():
    cfg = PipelineConfig(W_tot=400.0, w=10.0, m=4)
    res = run(cfg)
    d = deltas_vs_primary(res, res)
    assert d["pct_faster"] == 0.0 and d["pct_cheaper"] == 0.0
    assert d["pct_safer"] == 0.0 and d["pct_overall"] == 0.0
    assert d["improved"] is False


def test_synthesis_table_marks_the_primary_and_deltas_each_variant():
    primary_cfg = PipelineConfig(W_tot=600.0, w=10.0, n=5, m=4,
                                 branch_levels=1, test_level="all")
    primary_res = run(primary_cfg)
    alt_cfg = replace(primary_cfg, branch_levels=2, test_level="top")
    records = [
        ("Primary (baseline)", primary_cfg, primary_res),
        ("Defer to top", alt_cfg, run(alt_cfg)),
    ]
    table = synthesis_table(primary_cfg, records, weights=(1.0, 1.0, 1.0))
    assert len(table) == 2
    assert table[0]["is_primary"] is True
    assert table[0]["summary"] == "baseline"
    assert table[1]["is_primary"] is False
    assert "overall" in table[1]["summary"]
    assert "cfg" in table[1] and "res" in table[1]
