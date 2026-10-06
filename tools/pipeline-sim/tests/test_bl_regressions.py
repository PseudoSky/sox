"""BL-named regression tests (red -> green).

Each test names the backlog item it guards and fails **without** the fix /
passes **with** it:

* ``BL f9c92068`` -- the holding term (``c_wip * n * horizon``) is what gives the
  cost-optimal bucket size an *interior* optimum ``n* ~ sqrt(M)``.  Remove the
  holding term (``c_wip = 0``) and the optimum degenerates to one giant bucket
  ``n* = M``; these tests pin both halves.
* ``BL 47bf572f`` -- the bucket (a ticket group) is independent of the merge
  structure.  The old conflation made the merge count depend on ``n``.
* ``BL b46a5f8f`` -- the Appendix-C cost decomposition: dispatch-schema tokens,
  tool-call-result tokens and per-op tokens are three DISJOINT pools.

Red->green is demonstrated in the verification transcript by temporarily
disabling the mechanism (``c_wip = 0`` for f9c92068; ``c_wip`` removed and a
bucket-as-merge-unit graph for 47bf572f) and showing the named assertion fail.
"""

from __future__ import annotations

import math
from dataclasses import replace

import pytest

from pipeline_sim import PipelineConfig, cost_optimal_n, run
from pipeline_sim.config import (
    DEFAULT_TOKENS,
    DISPATCH_SCHEMA_TOKENS,
    P_IN,
    TOOL_CALL_TOKENS,
    llm_cost,
)
from pipeline_sim.model import build_task_graph


def _loglog_slope(xs, ys) -> float:
    lx = [math.log(x) for x in xs]
    ly = [math.log(y) for y in ys]
    mx = sum(lx) / len(lx)
    my = sum(ly) / len(ly)
    return (sum((a - mx) * (b - my) for a, b in zip(lx, ly))
            / sum((a - mx) ** 2 for a in lx))


# ---------------------------------------------------------------------------
# BL f9c92068 -- holding term gives an interior sqrt(M) bucket optimum
# ---------------------------------------------------------------------------
def _workload(M: int, **kw) -> PipelineConfig:
    w = 10.0
    # ``c_agent = 0`` isolates the per-batch setup vs holding trade that L1 /
    # BL f9c92068 is about; the parallelism cost (spec 4-f2) is a separate
    # objective that otherwise makes cost track makespan and masks the law.
    base = dict(W_tot=M * w, w=w, m=max(2, math.ceil(M / 8)), n=1, alpha=2,
                branch_levels=1, test_exec="full_suite", c_agent=0.0)
    base.update(kw)
    return PipelineConfig(**base)


def test_bl_f9c92068_holding_term_gives_interior_optimum():
    """WITH the ``c_wip`` holding term the cost optimum is interior (BL f9c92068).

    Fails without the fix: with ``c_wip = 0`` the optimum is the boundary
    ``n* = M`` (see the companion test).
    """
    Ms = [32, 64, 128]
    nstars = []
    for M in Ms:
        cfg = _workload(M)                        # holding term ON (the fix)
        n_star, best, _sweep = cost_optimal_n(cfg, range(1, M + 1))
        assert 1 < n_star < M, f"M={M}: n*={n_star} is not interior"
        assert best.violations == [], best.violations
        nstars.append(n_star)

    assert all(b >= a for a, b in zip(nstars, nstars[1:])), nstars
    assert nstars[-1] > nstars[0], nstars
    # approximately sqrt(M): the anchor law of derived result L1
    exponent = _loglog_slope(Ms, nstars)
    assert 0.30 <= exponent <= 0.70, f"exponent {exponent:.3f} not ~0.5"


def test_bl_f9c92068_without_holding_term_optimum_collapses_to_boundary():
    """Without the holding term the optimum degenerates to one giant bucket.

    This is the red half: if the fix (holding) is absent, the interior-optimum
    assertion above cannot hold.
    """
    for M in (32, 64):
        cfg = _workload(M, c_wip=0.0)            # holding term REMOVED
        n_star, _best, _sweep = cost_optimal_n(cfg, range(1, M + 1))
        assert n_star == M, f"M={M}: without holding n*={n_star} != M"


# ---------------------------------------------------------------------------
# BL 47bf572f -- bucket size is independent of the merge structure
# ---------------------------------------------------------------------------
def test_bl_47bf572f_bucket_size_is_independent_of_merge_structure():
    """Changing ``n`` must not change the merge tree (BL 47bf572f).

    Fails under the old conflation, where buckets *were* the merge units and the
    merge count moved with ``n``.
    """
    M = 20
    merges, worktrees, tops = set(), set(), set()
    for n in range(1, M + 1):
        g = build_task_graph(PipelineConfig(
            W_tot=M * 10.0, w=10.0, n=n, m=4, branch_levels=2, branch_fanout=2))
        merges.add(g.num_merges)
        worktrees.add(g.num_worktrees)
        tops.add(g.num_main_merges)
        # only the bucket/dispatch axes move with n
        assert g.num_buckets == math.ceil(M / n)
        assert g.num_dispatches == g.num_buckets
    assert len(merges) == 1 and len(worktrees) == 1 and len(tops) == 1
    # M leaf merges + ceil(M/2) parents -- entirely n-independent
    assert merges == {M + math.ceil(M / 2)}


def test_bl_47bf572f_buckets_group_tickets_only():
    """A bucket is a ticket group; it is not a merge node (BL 47bf572f)."""
    cfg = PipelineConfig(W_tot=200.0, w=10.0, n=7, m=4, branch_levels=1)
    g = build_task_graph(cfg)
    # flat merge tree: one merge per ticket, independent of bucket size 7
    assert g.num_merges == cfg.M
    assert g.num_buckets == math.ceil(cfg.M / 7)
    # every bucket is a group of tickets
    for b in g.buckets:
        assert 1 <= len(b) <= 7


# ---------------------------------------------------------------------------
# BL b46a5f8f -- cost decomposition: three disjoint token pools
# ---------------------------------------------------------------------------
def test_bl_b46a5f8f_dispatch_and_tool_pools_match_appendix_c():
    """``c_dispatch`` covers schema tokens once; ``OC`` covers one tool call."""
    cfg = PipelineConfig()
    assert cfg.c_dispatch == pytest.approx(DISPATCH_SCHEMA_TOKENS * P_IN)
    assert cfg.OC == pytest.approx(TOOL_CALL_TOKENS * P_IN)
    # per-op tokens are the operation's OWN tokens (not the schema/tool pools)
    assert cfg.c_op.impl == pytest.approx(llm_cost(*DEFAULT_TOKENS.impl))
    assert DEFAULT_TOKENS.impl[0] != DISPATCH_SCHEMA_TOKENS


def test_bl_b46a5f8f_three_cost_pools_are_disjoint():
    """Changing one pool moves ONLY its own cost line (no double-count)."""
    base = PipelineConfig(W_tot=200.0, w=10.0, n=5, m=4, alpha=2)
    r0 = run(base)

    # (1) tool term responds ONLY to O_nu
    r_tool = run(replace(base, tool_calls=replace(
        base.tool_calls, impl=base.tool_calls.impl + 3)))
    assert r_tool.cost_breakdown["tool"] > r0.cost_breakdown["tool"]
    assert r_tool.cost_breakdown["op"] == pytest.approx(r0.cost_breakdown["op"])
    assert r_tool.cost_breakdown["dispatch"] == pytest.approx(
        r0.cost_breakdown["dispatch"])

    # (2) op term responds ONLY to per-op tokens
    r_op = run(replace(base, c_op=replace(base.c_op, impl=base.c_op.impl + 0.01)))
    assert r_op.cost_breakdown["op"] > r0.cost_breakdown["op"]
    assert r_op.cost_breakdown["tool"] == pytest.approx(r0.cost_breakdown["tool"])
    assert r_op.cost_breakdown["dispatch"] == pytest.approx(
        r0.cost_breakdown["dispatch"])

    # (3) dispatch term responds ONLY to the fresh-agent-start charge
    r_disp = run(replace(base, c_dispatch=base.c_dispatch + 0.01))
    assert r_disp.cost_breakdown["dispatch"] > r0.cost_breakdown["dispatch"]
    assert r_disp.cost_breakdown["op"] == pytest.approx(r0.cost_breakdown["op"])
    assert r_disp.cost_breakdown["tool"] == pytest.approx(r0.cost_breakdown["tool"])
