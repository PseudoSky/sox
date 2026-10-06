"""PART 1 regression: the design-space optima are INTERIOR, not boundary.

Before the part-1 fix the three structural knobs had no first-order cost of
their own: bucket size, branch depth and test deferral only reduced makespan, and
because ``c_agent`` dominates the cost objective, cost simply tracked makespan.
Every optimum therefore collapsed to a corner -- "max out the knob" (bucket =
MAX, depth = MAX, test = defer).

These tests pin the FIXED behaviour: on a real workload the cost-minimising
bucket size and branch depth are INTERIOR, and (at a workload where deferral is
worth measuring) the test-timing optimum is interior too -- partial deferral
beats both "test at every merge" and "defer all the way to the top".
"""

from __future__ import annotations

import itertools
import math
from dataclasses import replace
from functools import lru_cache

from pipeline_sim import PipelineConfig, run

# A workload large enough that branching is a genuine trade-off (the model says a
# 20-ticket workload does not warrant a deep tree -- that is physics, not a bug).
_WORKLOADS = (60, 200)
_NS = (1, 2, 4, 5, 8, 10, 16, 40, 100)
_DEPTHS = (1, 2, 3, 4)
_TESTS = ("all", "level:2", "level:3", "top")


@lru_cache(maxsize=None)
def _rows(M: int):
    """All (cost, n, L, test) points for workload M (cached across tests)."""
    base = PipelineConfig(W_tot=float(M) * 10.0, w=10.0, m=4)
    ns = [n for n in _NS if n <= M]
    out = []
    for n, L, tl in itertools.product(ns, _DEPTHS, _TESTS):
        try:
            r = run(replace(base, n=n, branch_levels=L, test_level=tl))
        except ValueError:
            continue
        out.append((r.total_cost, n, L, tl))
    return tuple(ns), tuple(out)


def test_bucket_and_depth_optima_are_interior():
    for M in _WORKLOADS:
        ns, rows = _rows(M)
        best = min(rows, key=lambda x: x[0])
        _, n_star, L_star, _tl = best
        assert min(ns) < n_star < max(ns), (
            f"M={M}: bucket optimum n*={n_star} is on the bound {min(ns)}..{max(ns)}")
        assert 1 < L_star < 4, (
            f"M={M}: depth optimum L*={L_star} is on the bound 1..4")


def test_bucket_cost_curve_is_u_shaped():
    """A real trade: too small pays the per-bucket setup, too big holds WIP."""
    M = 200
    ns, rows = _rows(M)
    by_n = {n: min(c for c, n2, _L, _t in rows if n2 == n) for n in ns}
    n_star = min(by_n, key=by_n.get)
    assert by_n[n_star] < by_n[min(ns)]
    assert by_n[n_star] < by_n[max(ns)]


def test_test_timing_optimum_is_interior_at_scale():
    """Deferral is not a free lunch: a PARTIAL deferral beats both extremes.

    At M=200 the gate-remediation cost grows with deferral, so testing at
    ``level:2`` is strictly cheaper than testing at every merge AND strictly
    cheaper than deferring all the way to the top.
    """
    _, rows = _rows(200)
    L = 3

    def _best_for(tl):
        return min(c for c, _n, L2, t in rows if L2 == L and t == tl)

    assert _best_for("level:2") < _best_for("all")
    assert _best_for("level:2") < _best_for("top")


def test_sqrt_law_optimum_is_interior_and_grows():
    """n* ~ sqrt(M): interior at every M and non-decreasing in M."""
    nstars = {}
    for M in _WORKLOADS:
        ns, rows = _rows(M)
        nstars[M] = min(rows, key=lambda x: x[0])[1]
    assert nstars[200] >= nstars[60]
    for M, n_star in nstars.items():
        assert n_star / math.sqrt(M) < 1.5, (M, n_star)
