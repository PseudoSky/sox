"""Design-space exploration: a bounded search *domain* and an exhaustive sweep.

Spec 10.1 makes the UI an *explorer*, not a knob form: the user sets each
knob's RANGE / level set, presses RUN, and the sweep populates a results dataset
from which they select.  This module is that engine, independent of Streamlit so
it can be unit-tested.

Only the knobs the deterministic simulator actually implements are domain axes:
``n``, ``alpha``, ``branch_levels``, ``branch_fanout``, ``test_level``,
``test_exec``, ``m``.  Unimplemented knobs (``sigma`` policies, ``role_partition``,
file-isolation regimes, rework, stochastic durations) are deliberately absent --
adding axes for them would misrepresent a simulator that raises on them.
"""

from __future__ import annotations

import itertools
import logging
from dataclasses import dataclass, field, replace
from typing import Callable, Dict, Iterator, List, Optional, Sequence, Tuple

from .config import PipelineConfig, parse_test_level
from .engine import run

logger = logging.getLogger("pipeline_sim.explore")


def level_of(test_level: object) -> Optional[int]:
    """The ``L`` of an ``"level:L"`` string, else ``None``.

    ``all`` / ``top`` / ``none`` / any malformed value return ``None`` -- this is
    a *cheap structural* probe, not the authoritative parse (``is_realisable``).
    """
    if isinstance(test_level, str) and test_level.startswith("level:"):
        try:
            return int(test_level.split(":", 1)[1])
        except (ValueError, IndexError):
            return None
    return None


def is_realisable(test_level: object, branch_levels: int) -> bool:
    """True iff ``test_level`` can actually run at ``branch_levels`` (never raises).

    ``level:L`` needs ``L <= branch_levels`` (spec C10: >= 1 suite before
    release); ``all`` / ``top`` / ``none`` are realisable at any depth.  A
    malformed string is *not* realisable -- it would raise in
    :func:`pipeline_sim.config.parse_test_level`.  This is the single predicate
    the sidebar, :func:`iter_configs` and :func:`run_sweep` share, so "valid by
    construction" and "skipped at runtime" can never disagree.
    """
    try:
        parse_test_level(str(test_level), int(branch_levels))
        return True
    except Exception:  # noqa: BLE001 - any parse failure is simply "not realisable"
        return False


@dataclass(frozen=True)
class SearchDomain:
    """The bounded search space: a level set per knob (spec 10.1 step 1)."""

    ns: Tuple[int, ...] = (2, 4, 8)
    alphas: Tuple[int, ...] = (1, 2, 3)
    branch_levels: Tuple[int, ...] = (1, 2, 3)
    branch_fanouts: Tuple[int, ...] = (2, 3)
    test_levels: Tuple[str, ...] = ("all", "top")
    test_execs: Tuple[str, ...] = ("full_suite",)
    ms: Tuple[int, ...] = (2, 4, 8)
    # objective weights -- used only for ranking/colouring the results dataset,
    # never for the simulation itself (the engine has no scalariser).
    w1: float = 1.0   # makespan
    w2: float = 1.0   # cost
    w3: float = 1.0   # utilisation

    def size(self) -> int:
        """Number of grid points (the RUN button's workload)."""
        n = 1
        for seq in (self.ns, self.alphas, self.branch_levels, self.branch_fanouts,
                    self.test_levels, self.test_execs, self.ms):
            n *= max(1, len(seq))
        return n

    def knobs(self) -> Dict[str, Sequence[object]]:
        return {
            "n": self.ns,
            "alpha": self.alphas,
            "branch_levels": self.branch_levels,
            "branch_fanout": self.branch_fanouts,
            "test_level": self.test_levels,
            "test_exec": self.test_execs,
            "m": self.ms,
        }

    def valid_test_level_count(self) -> int:
        """Number of ``(branch_levels, test_level)`` pairs that can actually run.

        A ``level:L`` paired with a depth ``< L`` is impossible (spec C10), so it
        is not counted.  This is the ``test_level × branch_levels`` factor of
        :meth:`effective_size`.
        """
        return sum(1 for lvl in self.branch_levels for tl in self.test_levels
                   if is_realisable(tl, lvl))

    def effective_size(self) -> int:
        """Grid points that can actually run (impossible ``level:L`` dropped).

        :meth:`size` is the raw Cartesian product the RUN button *appears* to
        cover; ``effective_size`` is what the sweep really evaluates once the
        structurally impossible ``level:L`` combinations are excluded.  They are
        equal when no depth/level mismatch exists.
        """
        other = (max(1, len(self.ns)) * max(1, len(self.alphas))
                 * max(1, len(self.branch_fanouts))
                 * max(1, len(self.test_execs)) * max(1, len(self.ms)))
        vt = self.valid_test_level_count()
        if not self.branch_levels or not self.test_levels:
            # Degenerate axis (never produced by the UI): fall back to the raw
            # product so we never under-report a runnable space.
            return self.size()
        return other * vt


def valid_test_levels(branch_levels: Sequence[int]) -> List[str]:
    """Every ``test_level`` string valid for at least one depth in ``branch_levels``.

    ``level:L`` is only valid when some candidate depth is ``>= L``; this keeps
    the UI from offering a level that no run can accept.
    """
    out = ["all", "top"]
    max_l = max(branch_levels) if branch_levels else 1
    for lvl in range(2, max_l + 1):
        out.append(f"level:{lvl}")
    return out


@dataclass(frozen=True)
class SweepPoint:
    """One evaluated design point (duck-compatible with ``plots.DesignPoint``)."""

    index: int
    n: int
    alpha: int
    branch_levels: int
    branch_fanout: int
    test_level: str
    test_exec: str
    m: int
    cost: float
    makespan: float
    util: float
    suite_runs: int
    num_merges: int
    num_dispatches: int
    ok: bool
    risk: float = 0.0
    violations: Tuple[str, ...] = ()
    breakdown: Dict[str, float] = field(default_factory=dict)

    def knobs(self) -> Dict[str, object]:
        return {
            "n": self.n, "alpha": self.alpha,
            "branch_levels": self.branch_levels,
            "branch_fanout": self.branch_fanout,
            "test_level": self.test_level, "test_exec": self.test_exec,
            "m": self.m,
        }

    def label(self) -> str:
        return (f"#{self.index}  n={self.n} α={self.alpha} L={self.branch_levels} "
                f"fo={self.branch_fanout} {self.test_level} {self.test_exec} m={self.m}")


def _mean_utilisation(res) -> float:
    """f5: total busy agent-time / (m * makespan); local copy keeps explore viz-free."""
    busy: Dict[int, float] = {}
    for r in res.records:
        busy[r.agent_id] = busy.get(r.agent_id, 0.0) + r.duration
    horizon = max(res.makespan, 1e-9)
    return sum(busy.values()) / (res.config.m * horizon)


def iter_configs(base: PipelineConfig,
                 domain: SearchDomain,
                 *,
                 valid_only: bool = False) -> Iterator[PipelineConfig]:
    """Cartesian product of the domain level sets, as configs derived from ``base``.

    ``base`` carries everything not in the domain (workload ``W_tot``/``w``,
    cost/time parameters, and the editable task graph ``T_active``/``P``).

    With ``valid_only=True`` the structurally impossible combinations are
    dropped *before* they are yielded: a ``level:L`` whose ``L`` exceeds the
    candidate branch depth ``L`` would run no top-level suite and violate C10
    (spec 10.2), so it is never emitted.  The default (``False``) preserves the
    raw product -- callers that report a total or want to record every skipped
    combination rely on it.
    """
    axes = ("n", "alpha", "branch_levels", "branch_fanout",
            "test_level", "test_exec", "m")
    for combo in itertools.product(
            domain.ns, domain.alphas, domain.branch_levels,
            domain.branch_fanouts, domain.test_levels, domain.test_execs, domain.ms):
        cfg = replace(base, **dict(zip(axes, combo)))
        if valid_only and not is_realisable(cfg.test_level,
                                            cfg.resolved_branch_levels()):
            continue
        yield cfg


def run_sweep(base: PipelineConfig,
              domain: SearchDomain,
              progress: Optional[Callable[[int, int], None]] = None,
              skipped: Optional[List[Tuple[PipelineConfig, str]]] = None
              ) -> List[SweepPoint]:
    """Exhaustively evaluate the domain; return the results dataset.

    **A single bad configuration must never abort the sweep.**  Two independent
    guards enforce that:

    * A structurally impossible combo -- an out-of-range ``level:L`` for a
      shallower tree is the common case -- is detected *before* it is run (via
      :func:`is_realisable`) and recorded in ``skipped``.
    * ``run(cfg)`` is wrapped in a blanket ``except Exception``: any *other*
      engine rejection (an unimplemented knob, a deadlock or invariant failure)
      is logged, recorded in ``skipped`` and skipped, never propagated.

    Both paths are thus reported, never silent; ``progress`` (if given) is
    advanced for skipped configurations too, so the bar always reaches its end.
    """
    total = domain.effective_size()
    points: List[SweepPoint] = []
    i = 0

    def _advance() -> None:
        if progress is not None:
            progress(i, total)

    for cfg in iter_configs(base, domain):
        i += 1
        depth = cfg.resolved_branch_levels()
        if not is_realisable(cfg.test_level, depth):
            reason = (
                f"test_level {cfg.test_level!r} is not realisable at "
                f"branch_levels={depth} (spec C10: >= 1 test before release)"
            )
            logger.info("sweep skipped an impossible configuration: %s", reason)
            if skipped is not None:
                skipped.append((cfg, reason))
            _advance()
            continue
        try:
            res = run(cfg)
        except Exception as exc:  # noqa: BLE001 - ANY engine failure: skip, never abort
            reason = f"{type(exc).__name__}: {exc}"
            logger.warning(
                "sweep skipped a configuration that failed to run: "
                "n=%s L=%s test=%s m=%s cap=%s (%s)",
                cfg.n, cfg.branch_levels, cfg.test_level, cfg.m,
                cfg.max_parallel_buckets, reason,
            )
            if skipped is not None:
                skipped.append((cfg, reason))
            _advance()
            continue
        points.append(SweepPoint(
            index=len(points), n=cfg.n, alpha=cfg.alpha,
            branch_levels=res.branch_levels, branch_fanout=cfg.branch_fanout,
            test_level=cfg.test_level, test_exec=cfg.test_exec, m=cfg.m,
            cost=res.total_cost, makespan=res.makespan, util=_mean_utilisation(res),
            suite_runs=res.num_suite_runs, num_merges=res.num_merges,
            num_dispatches=res.num_dispatches, ok=not res.violations,
            risk=res.risk,
            violations=tuple(res.violations),
            breakdown=dict(res.cost_breakdown),
        ))
        _advance()
    return points


def pareto_front_2d(points: Sequence, x_of: Callable, y_of: Callable,
                    minimize_y: bool = True) -> List:
    """Non-dominated set for ``(min x, min y)`` (or ``max y`` if not minimize_y).

    Generic over any point objects exposing the two attributes through the
    accessor callables; works on :class:`SweepPoint` and ``plots.DesignPoint``.
    """
    import math as _math

    if minimize_y:
        pts = sorted(points, key=lambda p: (x_of(p), y_of(p)))
        best = _math.inf

        def keep(y, b):
            return y < b - 1e-9
    else:
        pts = sorted(points, key=lambda p: (x_of(p), -y_of(p)))
        best = -_math.inf

        def keep(y, b):
            return y > b + 1e-9
    front: List = []
    for p in pts:
        y = y_of(p)
        if _math.isfinite(y) and keep(y, best):
            front.append(p)
            best = y
    return front


def pareto_front_cost_makespan(points: Sequence) -> List:
    """Non-dominated set over ``(min cost, min makespan)`` -- the requested front."""
    return pareto_front_2d(points, lambda p: p.cost, lambda p: p.makespan)


def pareto_front_cost_risk(points: Sequence) -> List:
    """Non-dominated set over ``(min cost, min risk)`` (f2 vs f3)."""
    return pareto_front_2d(points, lambda p: p.cost, lambda p: getattr(p, "risk", 0.0))


def pareto_front_time_risk(points: Sequence) -> List:
    """Non-dominated set over ``(min makespan, min risk)`` (f1 vs f3)."""
    return pareto_front_2d(points, lambda p: p.makespan, lambda p: getattr(p, "risk", 0.0))


def weighted_score(point: SweepPoint,
                   domain: SearchDomain,
                   ranges: Dict[str, Tuple[float, float]]) -> float:
    """Min-max-normalised weighted score (lower is better) for ranking only.

    ``ranges`` maps ``"makespan" | "cost" | "util"`` to ``(min, max)`` over the
    dataset.  This is a *view* over the results -- the simulator has no
    scalariser (spec 4 reductions are a later milestone), so scores never feed
    back into a run.
    """
    def norm(key: str, value: float) -> float:
        lo, hi = ranges.get(key, (0.0, 1.0))
        return 0.0 if hi <= lo else (value - lo) / (hi - lo)

    w1, w2, w3 = domain.w1, domain.w2, domain.w3
    denom = max(w1 + w2 + w3, 1e-9)
    # makespan and cost: lower is better; utilisation: higher is better
    return (w1 * norm("makespan", point.makespan)
            + w2 * norm("cost", point.cost)
            + w3 * (1.0 - norm("util", point.util))) / denom
