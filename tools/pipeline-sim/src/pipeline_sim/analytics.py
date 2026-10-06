"""Analytic pieces referenced by the spec.

Two closed forms live here:

1. The square-root batch law (spec derived result L1, anchored on EOQ/ELSP):
   ``n* = sqrt(2 * K * M / h)`` where ``K`` is the fixed cost incurred *per
   bucket* and ``h`` is the per-ticket holding rate over the horizon.  This is
   the "sqrt(M) bucket-size formula" the spec calls for.

2. The critical-path length of the task precedence DAG (spec response L8).  This
   is an exact lower bound on the makespan of *any* resource-feasible schedule,
   because it relaxes constraint C11/C16 (unbounded resources, serial merges).

The file-conflict graph ``G_X`` (spec 3.1) is also generated here.  It is a
**documented citation artifact** (spec Appendix E.1): it measures shared
evidence/meta files in ticket citations, NOT work overlap, and it must NOT be
used to bound parallelism -- the real serializer is the component dependency
(publish) DAG, modelled in :mod:`pipeline_sim.deps`.  Here it feeds only the
``f3`` *risk* term (a conflict-rate heuristic); constraints C13/C14 (file
isolation) are not enforced.
"""

from __future__ import annotations

import math
from typing import Dict, List, Sequence, Tuple

from .config import PipelineConfig


# ---------------------------------------------------------------------------
# square-root batch law
# ---------------------------------------------------------------------------
def sqrt_bucket_size(M: float, fixed_cost_per_bucket: float, holding_rate: float,
                     horizon: float = 1.0) -> float:
    """EOQ/ELSP closed form: ``n* = sqrt(2 * K * M / (h * T))``.

    Parameters
    ----------
    M
        Number of tickets (the "demand").
    fixed_cost_per_bucket
        Fixed cost incurred once per bucket (worktree + merge setup).
    holding_rate
        Per-ticket holding cost per unit horizon.
    horizon
        Length of the planning horizon ``T``.  A **fixed** planning horizon (the
        ``T`` of the EOQ formula), not the realised makespan -- coupling it to
        makespan would make the holding term ``∝ n·T(M)`` and collapse L1's
        square-root law (spec 4 NOTE); defaults to 1.0 for a scale-free form.

    Returns
    -------
    The cost-optimal real-valued bucket size.  Callers round to an integer.
    """
    if M <= 0:
        raise ValueError("M must be > 0")
    if fixed_cost_per_bucket < 0 or holding_rate <= 0 or horizon <= 0:
        raise ValueError("fixed_cost_per_bucket >= 0, holding_rate > 0, horizon > 0")
    return math.sqrt(2.0 * fixed_cost_per_bucket * M / (holding_rate * horizon))


def analytic_bucket_size(cfg: PipelineConfig, horizon: float) -> float:
    """Closed-form bucket size for a config, using the fixed per-bucket costs.

    The per-bucket setup term ``K`` is everything paid ONCE per bucket: the
    first-order bucket setup (``c_bucket``, spec §4 NOTE / OPEN-7), the
    fresh-agent dispatch (``c_dispatch``, C17), the per-bucket plan, and the
    expected per-bucket rework (``p_eff * rework_burden``).  The merge tree is
    independent of ``n`` so its costs do *not* enter ``K``.  ``h`` is ``c_wip``
    and ``T`` the horizon (spec 4-f2, L1, OPEN-7).
    """
    K = (cfg.c_bucket + cfg.c_dispatch + cfg.c_op.plan
         + cfg.effective_rework_p() * rework_burden_per_bucket(cfg))
    return sqrt_bucket_size(cfg.M, K, cfg.c_wip, horizon=horizon)


# ---------------------------------------------------------------------------
# critical path (longest path through the precedence DAG)
# ---------------------------------------------------------------------------
def topological_order(tasks: Sequence) -> List:
    """Kahn topological sort; raises on a cycle (a malformed precedence DAG)."""
    indeg: Dict[int, int] = {t.tid: len(t.preds) for t in tasks}
    ready = [t for t in tasks if indeg[t.tid] == 0]
    order: List = []
    while ready:
        t = ready.pop(0)
        order.append(t)
        for s in t.succs:
            indeg[s.tid] -= 1
            if indeg[s.tid] == 0:
                ready.append(s)
    if len(order) != len(tasks):
        raise ValueError("precedence graph contains a cycle")
    return order


def critical_path_bound(tasks: Sequence, min_suite_duration: float = 0.0) -> float:
    """Longest path through the DAG, using a *lower bound* on each duration.

    Dynamically-sized tasks (the compounding suite runs, C9) use
    ``min_suite_duration`` -- the smallest duration any suite run can have.
    Under-estimating durations keeps the result a valid lower bound on the
    realised makespan.
    """
    order = topological_order(tasks)
    dist: Dict[int, float] = {}
    for t in order:
        dur = min_suite_duration if getattr(t, "duration_is_dynamic", False) else t.duration
        best = 0.0
        for p in t.preds:
            if dist[p.tid] > best:
                best = dist[p.tid]
        dist[t.tid] = best + dur
    return max(dist.values()) if dist else 0.0


# ---------------------------------------------------------------------------
# file-conflict graph G_X (informational in M1)
# ---------------------------------------------------------------------------
def _files_per_ticket(regime: str, M: int, params: dict) -> List[frozenset]:
    """Deterministic G_X regimes from spec experiment factor X3 (7.1)."""
    if regime == "no_edges":
        return [frozenset({f"f{i}"}) for i in range(M)]
    if regime == "one_component":
        shared = frozenset({"shared"})
        return [frozenset({f"f{i}"}) | shared for i in range(M)]
    if regime == "fragmented":
        fanout = int(params.get("fanout", 3))
        return [
            frozenset({f"f{i % fanout}", f"own{i}"})
            for i in range(M)
        ]
    raise ValueError(f"unknown file_regime: {regime!r}")


def file_conflict_pairs(cfg: PipelineConfig) -> Tuple[int, List[Tuple[int, int]]]:
    """Return ``(|G_X edges|, edges)`` -- a **citation artifact** (spec E.1).

    This is the shared-citation/meta-file graph, not work overlap.  It does not
    bound parallelism (the component dependency DAG does); it feeds the ``f3``
    conflict-rate risk heuristic only.
    """
    files = _files_per_ticket(cfg.file_regime, cfg.M, dict(cfg.gx_params))
    edges: List[Tuple[int, int]] = []
    for i in range(cfg.M):
        for j in range(i + 1, cfg.M):
            if files[i] & files[j]:
                edges.append((i, j))
    return len(edges), edges


def conflict_rate(cfg: PipelineConfig) -> float:
    """Density of the file-conflict graph ``G_X`` in ``[0, 1]`` (spec f3).

    ``|E(G_X)| / C(M, 2)``: 0 for ``no_edges``, 1 for a fully connected
    ``one_component`` regime, intermediate for ``fragmented``.  Two or fewer
    tickets have no pair -> rate 0.
    """
    M = cfg.M
    if M < 2:
        return 0.0
    n_edges, _ = file_conflict_pairs(cfg)
    return n_edges / (M * (M - 1) / 2.0)


# ---------------------------------------------------------------------------
# risk objective f3 (spec section 4)
# ---------------------------------------------------------------------------
def deferral_levels(cfg: PipelineConfig) -> int:
    """How many merge levels testing is deferred *past* the leaf (spec f3).

    ``all`` -> 0 (test at every merge); ``level:L`` -> ``L - 1``; ``top`` ->
    ``branch_levels - 1``.  More deferred testing means a later, larger blast
    radius -- the downside that closes the cost/time-vs-risk trade-off.
    """
    levels = max(cfg.resolved_branch_levels(), 1)
    mode, level = cfg.resolved_test_level()
    if mode == "all":
        return 0
    if mode == "none":
        # no per-merge suite at all: testing is fully deferred to the release
        # gate, the maximum-deferral extreme (spec 5.2).
        return levels
    if mode == "top":
        return max(0, levels - 1)
    return max(0, min(level, levels) - 1)


def blast_radius(branch_depth: int, deferral: int) -> float:
    """``blast_radius(branch_depth, deferral)`` (spec f3).

    Grows with both: deeper trees and more deferred testing widen the radius of
    a defect that escapes to a higher merge.  ``depth * (1 + deferral)`` -- at
    least 1, monotone increasing in each argument.
    """
    return float(max(branch_depth, 1) * (1 + max(deferral, 0)))


def branch_coordination_cost(cfg: PipelineConfig, merge_nodes) -> float:
    """First-order PER-BRANCH coordination cost (spec §4 NOTE / part-1 fix).

    ``c_branch * Σ_nodes |tickets| + c_level * Σ_nodes |tickets| * tier`` -- a
    merge node costs in proportion to the number of work units it integrates,
    and again in proportion to that count times its tier.  Every ticket is
    counted once per level (its leaf plus each ancestor), so ``Σ_nodes |tickets|
    = M · levels``: the cost grows with depth AND with workload, which is what
    makes the branch-depth optimum interior (deeper trees buy fewer/larger
    suites but pay more coordination) rather than monotonically reducing cost.

    ``merge_nodes`` is any iterable of objects exposing ``tickets`` (a sequence)
    and ``tier`` (int) -- :class:`pipeline_sim.model.MergeNode` instances.
    """
    unit_work = sum(len(n.tickets) for n in merge_nodes)
    tier_work = sum(len(n.tickets) * n.tier for n in merge_nodes)
    return cfg.c_branch * unit_work + cfg.c_level * tier_work


def rework_burden_per_bucket(cfg: PipelineConfig) -> float:
    """One rework event's cost: implement + reconfirm + re-review (spec A1)."""
    c = cfg.c_op
    return c.impl + c.review + c.review_routing


def expected_rework_burden(cfg: PipelineConfig) -> float:
    """``sum over buckets (implement + reconfirm + re-review)`` (Appendix D)."""
    return cfg.num_buckets * rework_burden_per_bucket(cfg)


def risk_objective(cfg: PipelineConfig) -> float:
    """``f3`` (spec section 4, [fix]):

    ``rho * blast_radius(branch_depth, deferral) * conflict_rate
       + p * (expected rework burden)``

    The first term is the blast radius of an escaped defect (grows with branch
    depth and with deferral -- so deferring testing has a downside even though
    it is cheaper and faster); the second is the expected cost of rework.
    """
    br = blast_radius(cfg.resolved_branch_levels(), deferral_levels(cfg))
    return (cfg.rho * br * conflict_rate(cfg)
            + cfg.effective_rework_p() * expected_rework_burden(cfg))
