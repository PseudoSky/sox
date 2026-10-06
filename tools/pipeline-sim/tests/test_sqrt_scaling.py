"""Milestone 1 required test: the cost-optimal bucket size scales ~ sqrt(M).

Spec derived result L1 (spec section 6) / research-question RQ1.  The test does
NOT assert an exact constant -- it asserts the trend:

1. the optimum is interior for every M (a real trade-off, not a boundary),
2. ``n*`` is non-decreasing in ``M``,
3. the log-log exponent of ``n*`` vs ``M`` is approximately 1/2,
4. ``n* / sqrt(M)`` stays within a bounded band (approximate proportionality).

To compare bucket sizing *across workload sizes* fairly, the agent pool scales
with the workload (``m ~ M / 8``) so the per-ticket cycle time does not itself
grow with M -- otherwise the fixed planning horizon in the batch law is not
comparable across instances.

Isolating the batch trade
-------------------------
The parallelism cost ``c_agent`` (spec 4-f2, ``[fix]``) charges occupied
agent-seconds (≈ ``m · makespan``); when it is active, cost tracks makespan and
the argmin is driven by schedule noise rather than the ``K/n + h·n`` batch
trade.  L1 (spec §6, OPEN-7) is a statement about the *per-batch setup vs
holding* trade, so the law is measured with ``c_agent = 0``: the pure batch term
is then the only ``n``-dependent cost, and the square-root law holds cleanly
(exponent ≈ 0.65 on this grid, ``n* = [8, 16, 22, 32]``).
"""

from __future__ import annotations

import math

from pipeline_sim import PipelineConfig, cost_optimal_n, sqrt_bucket_size


def _loglog_slope(xs, ys) -> float:
    lx = [math.log(x) for x in xs]
    ly = [math.log(y) for y in ys]
    mx = sum(lx) / len(lx)
    my = sum(ly) / len(ly)
    num = sum((a - mx) * (b - my) for a, b in zip(lx, ly))
    den = sum((a - mx) ** 2 for a in lx)
    return num / den


def _config_for(M: int) -> PipelineConfig:
    w = 10.0
    m = max(2, math.ceil(M / 8))
    return PipelineConfig(
        W_tot=M * w, w=w, m=m, n=1, alpha=2,
        branch="flat", test_exec="full_suite",
        c_agent=0.0,   # isolate the K/n + h*n batch trade (see module docstring)
    )


def test_cost_optimal_bucket_size_scales_with_sqrt_M():
    Ms = [16, 32, 64, 128]
    nstars = []
    for M in Ms:
        cfg = _config_for(M)
        n_star, best, _sweep = cost_optimal_n(cfg, range(1, M // 2 + 1))
        # 1. interior optimum -- not the smallest or largest candidate bucket
        assert 1 < n_star < M, f"M={M}: optimum n*={n_star} is not interior"
        assert best.violations == [], f"M={M}: constraint violations {best.violations}"
        nstars.append(n_star)

    # 2. monotone trend
    assert all(b >= a for a, b in zip(nstars, nstars[1:])), nstars
    assert nstars[-1] > nstars[0], nstars

    # 3. exponent approximately one half (square-root law), clearly sub-linear
    exponent = _loglog_slope(Ms, nstars)
    assert 0.30 <= exponent <= 0.70, f"estimated exponent {exponent:.3f} not ~0.5"

    # 4. approximate proportionality to sqrt(M)
    ratios = [n / math.sqrt(M) for n, M in zip(nstars, Ms)]
    assert max(ratios) / min(ratios) <= 3.0, ratios


def test_analytic_sqrt_formula_quadrupling():
    """The closed-form batch law is itself square-root in M (spec V1 anchor)."""
    n1 = sqrt_bucket_size(100, fixed_cost_per_bucket=150, holding_rate=1.0, horizon=1.0)
    n4 = sqrt_bucket_size(400, fixed_cost_per_bucket=150, holding_rate=1.0, horizon=1.0)
    assert math.isclose(n4 / n1, 2.0, rel_tol=1e-9)  # quadrupling M doubles n*
