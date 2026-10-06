"""Acceptance-criteria as a 0-heavy DISTRIBUTION (spec C4 revised / Appendix E).

The original C4 mandated ``a_bk >= 1`` for every ticket (a floor).  The real
backlog's modal ticket carries ZERO ACs, so this suite pins the replacement
behaviour:

* the distribution's shape (modal 0, ~93 % zero, ~0.3 expected, ~7 % tail);
* deterministic, 0-heavy sampling;
* uniform mode is bit-for-bit unchanged (backward compatibility);
* a 0-AC ticket instantiates NO test-write / test-run work;
* the occurrence counts, engine cost and constraint set all follow.
"""

from __future__ import annotations

from pathlib import Path

import pytest

APP = str(Path(__file__).resolve().parents[1] / "app.py")

from pipeline_sim.alpha import (
    REAL_AC_DISTRIBUTION,
    REAL_OPEN_BACKLOG,
    REAL_SPRINT_BATCH_MAX,
    REAL_SPRINT_BATCH_MIN,
    REAL_TICKET_KIND_MIX,
    REAL_TOTAL_BACKLOG,
    AcDistribution,
    histogram,
)
from pipeline_sim.config import PipelineConfig
from pipeline_sim.engine import _op_cost, run
from pipeline_sim.harness import _build_parser, _config_from_args
from pipeline_sim.model import build_task_graph
from pipeline_sim.taskgraph import occurrence_counts

# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def _dist_cfg(M: int = 60, seed: int = 0, **kw) -> PipelineConfig:
    base = dict(W_tot=float(M * 10), w=10.0, n=5, m=4, seed=seed,
                ac_distribution=REAL_AC_DISTRIBUTION)
    base.update(kw)
    return PipelineConfig(**base)


# ---------------------------------------------------------------------------
# 1. distribution shape (Appendix E)
# ---------------------------------------------------------------------------
def test_real_distribution_reproduces_appendix_e_shape():
    d = REAL_AC_DISTRIBUTION
    # the modal ticket carries ZERO -- the whole correction
    assert d.modal_ac == 0
    # ~93 % zero, ~7 % tail, expected ~0.3
    assert d.zero_share == pytest.approx(0.925)
    assert 0.90 <= d.zero_share <= 0.95
    assert d.expected_ac == pytest.approx(0.30, abs=0.02)
    # tail: ~3-5, median 4
    assert d.tail_counts == (3, 4, 5)
    assert d.median_tail == 4


def test_real_population_constants_match_appendix_e():
    assert REAL_TOTAL_BACKLOG == 1_271
    assert REAL_OPEN_BACKLOG == 880
    assert REAL_SPRINT_BATCH_MIN == 40 and REAL_SPRINT_BATCH_MAX == 60
    assert sum(REAL_TICKET_KIND_MIX.values()) == pytest.approx(1.0)
    assert REAL_TICKET_KIND_MIX["bug"] == pytest.approx(0.45)


# ---------------------------------------------------------------------------
# 2. sampling: deterministic + 0-heavy
# ---------------------------------------------------------------------------
def test_sampling_is_deterministic():
    a = REAL_AC_DISTRIBUTION.sample_counts(60, seed=3)
    b = REAL_AC_DISTRIBUTION.sample_counts(60, seed=3)
    assert a == b
    assert a != REAL_AC_DISTRIBUTION.sample_counts(60, seed=4)


def test_sampling_is_dominated_by_zero():
    d = REAL_AC_DISTRIBUTION
    for M in (60, 200, 880):
        counts = d.sample_counts(M, seed=0)
        assert len(counts) == M
        h = histogram(counts)
        # the modal ticket is 0, and ~93 % of tickets are 0
        assert max(h, key=h.get) == 0
        assert h.get(0, 0) / M >= 0.90
        # every positive count sits in the tail range
        assert all(c == 0 or min(d.tail_counts) <= c <= max(d.tail_counts)
                   for c in counts)
        # the realised mean is ~0.3 (expected value over the ensemble)
        assert 0.15 <= sum(counts) / M <= 0.45


def test_sampling_mean_and_zero_share_are_unbiased_across_seeds():
    d = REAL_AC_DISTRIBUTION
    means, zero_shares = [], []
    for seed in range(80):
        counts = d.sample_counts(60, seed=seed)
        means.append(sum(counts) / 60)
        zero_shares.append(counts.count(0) / 60)
    assert sum(means) / len(means) == pytest.approx(0.30, abs=0.03)
    assert sum(zero_shares) / len(zero_shares) == pytest.approx(0.925, abs=0.02)


# ---------------------------------------------------------------------------
# 3. uniform mode is unchanged (backward compatibility)
# ---------------------------------------------------------------------------
def test_uniform_mode_unchanged():
    cfg = PipelineConfig(W_tot=200.0, w=10.0, alpha=2)
    assert cfg.uses_ac_distribution is False
    assert cfg.ac_counts() == [2] * cfg.M
    assert cfg.total_ac() == cfg.M * 2
    assert cfg.ac_model_label() == "2 AC per ticket (uniform)"


def test_distribution_mode_overrides_the_scalar_alpha():
    cfg = PipelineConfig(W_tot=600.0, w=10.0, alpha=2,
                         ac_distribution=REAL_AC_DISTRIBUTION)
    counts = cfg.ac_counts()
    assert cfg.uses_ac_distribution is True
    # not the scalar 2 for every ticket
    assert counts != [2] * cfg.M
    assert counts.count(0) >= cfg.M * 0.9
    assert cfg.total_ac() == sum(counts)


def test_config_validate_c4_revised():
    # uniform mode keeps the historic floor
    with pytest.raises(ValueError):
        PipelineConfig(W_tot=100.0, w=10.0, alpha=0).validate()
    # distribution mode makes alpha irrelevant: 0 is legal, 0-AC is the mode
    all_zero = AcDistribution(zero_share=1.0, tail_counts=(4,), tail_weights=(1.0,))
    cfg = PipelineConfig(W_tot=100.0, w=10.0, alpha=0, ac_distribution=all_zero)
    cfg.validate()
    assert cfg.ac_counts() == [0] * cfg.M
    assert cfg.total_ac() == 0
    # negative alpha is still rejected
    with pytest.raises(ValueError):
        PipelineConfig(W_tot=100.0, w=10.0, alpha=-1).validate()


def test_ac_distribution_rejects_malformed_shape():
    with pytest.raises(ValueError):
        AcDistribution(zero_share=1.5)
    with pytest.raises(ValueError):
        AcDistribution(tail_counts=(3, 4), tail_weights=(0.5,))
    with pytest.raises(ValueError):
        AcDistribution(tail_counts=(0,), tail_weights=(1.0,))


# ---------------------------------------------------------------------------
# 4. 0-AC tickets generate NO test-write / test-run work
# ---------------------------------------------------------------------------
def test_zero_ac_ticket_has_no_test_tasks():
    cfg = _dist_cfg(M=60)
    g = build_task_graph(cfg)
    ac = g.ac_counts
    assert len([c for c in ac if c == 0]) >= g.M * 0.9
    test_write_tickets = {t.ticket for t in g.tasks if t.kind == "test_write"}
    test_run_tickets = {t.ticket for t in g.tasks if t.kind == "test_run"}
    zero_tickets = {i for i, c in enumerate(ac) if c == 0}
    positive_tickets = {i for i, c in enumerate(ac) if c > 0}
    # no 0-AC ticket writes or runs a test ...
    assert not (test_write_tickets & zero_tickets)
    assert not (test_run_tickets & zero_tickets)
    # ... and every >0-AC ticket does both
    assert positive_tickets == test_write_tickets
    assert positive_tickets == test_run_tickets
    # exactly one test-write and one test-run task per positive ticket
    assert len(test_write_tickets) == len(positive_tickets)
    assert len(test_run_tickets) == len(positive_tickets)
    # the tasks scale with the ticket's *own* AC count
    for t in g.tasks:
        if t.kind in ("test_write", "test_run") and t.ticket is not None:
            assert t.unit_ac == ac[t.ticket] > 0


def test_all_zero_tickets_still_run_cleanly():
    """The extreme of the corrected C4: every ticket carries 0 ACs."""
    all_zero = AcDistribution(zero_share=1.0, tail_counts=(4,), tail_weights=(1.0,))
    cfg = PipelineConfig(W_tot=600.0, w=10.0, n=5, m=4, ac_distribution=all_zero)
    g = build_task_graph(cfg)
    assert g.total_ac == 0
    assert not [t for t in g.tasks if t.kind in ("test_write", "test_run")]
    res = run(cfg)
    assert res.violations == []            # C10 still satisfied by the suites
    assert res.num_suite_runs >= 1
    assert res.makespan > 0


# ---------------------------------------------------------------------------
# 5. engine cost + occurrences follow the realised ACs
# ---------------------------------------------------------------------------
def test_engine_op_cost_scales_with_the_ticket_ac_count():
    cfg = _dist_cfg(M=60)
    per_ac = cfg.c_op.test_write_per_ac
    run_ac = cfg.c_op.test_run_per_ac
    assert _op_cost("test_write", cfg, ac=4) == pytest.approx(per_ac * 4)
    assert _op_cost("test_run", cfg, ac=4) == pytest.approx(run_ac * 4)
    # when no explicit ac is passed the legacy uniform alpha is used
    assert _op_cost("test_write", cfg) == pytest.approx(per_ac * cfg.alpha)


def test_occurrence_counts_use_the_realised_total_ac():
    cfg = _dist_cfg(M=60)
    counts = occurrence_counts(cfg)
    assert counts["test_write"] == cfg.total_ac()
    assert counts["test_run"] == cfg.total_ac()
    assert counts["test_write"] < cfg.M * cfg.alpha   # far below the uniform 2x


def test_distribution_run_is_valid_and_cheaper_than_uniform_on_tests():
    dist = run(_dist_cfg(M=60))
    uniform = run(PipelineConfig(W_tot=600.0, w=10.0, n=5, m=4, alpha=2))
    assert dist.violations == []
    # ~0.3 AC/ticket vs 2.0 -> the (compounding) suite line is materially smaller
    assert dist.cost_breakdown["suite"] < uniform.cost_breakdown["suite"]


def test_gate_rework_scales_with_total_ac():
    """Deferred testing's remediation is per accumulated AC, not M*alpha."""
    tmp = _dist_cfg(M=60, test_level="top", branch_levels=2)
    res = run(tmp)
    assert res.violations == []
    # deferral > 0 with no explicit gate => the deferred-AC remediation applies
    assert res.cost_breakdown["gate_rework"] > 0


# ---------------------------------------------------------------------------
# 6. the shipped default scenario reflects the real distribution
# ---------------------------------------------------------------------------
def test_harness_cli_defaults_to_the_real_distribution():
    args = _build_parser().parse_args([])
    cfg = _config_from_args(args)
    assert cfg.uses_ac_distribution is True
    assert cfg.ac_distribution is REAL_AC_DISTRIBUTION
    # the default workload is a sprint-sized batch of tickets, not 880
    assert REAL_SPRINT_BATCH_MIN <= cfg.M <= REAL_SPRINT_BATCH_MAX


def test_harness_uniform_mode_opt_out():
    args = _build_parser().parse_args(["--ac-mode", "uniform", "--alpha", "3"])
    cfg = _config_from_args(args)
    assert cfg.uses_ac_distribution is False
    assert cfg.ac_counts() == [3] * cfg.M


# ---------------------------------------------------------------------------
# 7. the UI reflects the distribution + maps the dial to a ticket count
# ---------------------------------------------------------------------------
def test_app_default_enables_the_real_distribution_and_labels_tickets():
    pytest.importorskip("streamlit")
    from streamlit.testing.v1 import AppTest

    at = AppTest.from_file(APP, default_timeout=120)
    at.run()
    assert not at.exception, at.exception
    assert at.checkbox(key="ac_distribution").value is True
    captions = "\n".join(c.value for c in at.caption)
    # the workload dial is labelled with the TICKET COUNT and the real backlog
    assert "Tickets = 60" in captions
    assert "880" in captions

