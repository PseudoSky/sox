"""Visualization layer for the pipeline simulator -- the plot pack (spec 10).

This module is **additive**: it only *reads* the simulator
(:mod:`pipeline_sim.config`, :mod:`pipeline_sim.engine`,
:mod:`pipeline_sim.harness`); it changes no model behaviour.  It renders a pack
of figures -- static PNG (matplotlib) and interactive HTML (plotly) -- into
``tools/pipeline-sim/plots/``.

Figures (spec 10, techniques justified in spec 9):

==============  ============================================================
1  sqrt-scaling  ``n*`` vs ``M`` on a log-log axis with the fitted exponent
                 (~0.49) plus the analytic EOQ/ELSP curve  [L1]
2  H1 contrast   paired slope/dumbbell, baseline vs deferred, for cost AND
                 makespan across several ``M``  [H1 / X2 / L8]
3  Pareto front  cost vs makespan scatter from a design sweep, non-dominated
                 frontier highlighted  [RQ9]
4  interaction   cost/makespan over a ``(branch_levels x test_level)`` grid --
                 a phase/contour heatmap  [H1 / X2]
5  tornado       one-at-a-time knob effects on total cost  [7.1]
6  compounding   suite cost/time vs accumulated ACs (the C9 superlinear term)
7  small mults   cost and makespan vs ``n``, faceted by branch level
8  Gantt + util  schedule timeline with agent utilisation from one run
9  parallel      knobs -> (cost, makespan) for design-space exploration
   coordinates
10 dashboard     interactive HTML tablinking several of the above
==============  ============================================================

Only knobs the model actually implements today are plotted: ``n``, ``alpha``,
``branch_levels``, ``branch_fanout``, ``test_level``, ``test_exec``, ``m``.
Knobs the model does **not** implement (``sigma`` merge-order policies, the
``role_partition`` / Pi_R partition, file-isolation ``G_X`` regimes, rework
``p``/``rho``, and stochastic durations ``var_e``) are deliberately **not**
plotted -- fabricating axes for them would misrepresent a deterministic
simulator that raises ``NotImplementedError`` on them.

CLI::

    python -m pipeline_sim.plots                 # full pack -> plots/
    python -m pipeline_sim.plots --quick         # tiny/fast pack (smoke)
    python -m pipeline_sim.plots --only sqrt h1  # a subset
    python -m pipeline_sim.plots --out /tmp/plots
"""

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass, replace
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

import matplotlib

matplotlib.use("Agg")  # headless: never try to open a GUI window

import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402  (transitive via matplotlib)
import plotly.graph_objects as go  # noqa: E402
import plotly.io as pio  # noqa: E402
from plotly.offline import get_plotlyjs  # noqa: E402
from plotly.subplots import make_subplots  # noqa: E402

from .config import PipelineConfig  # noqa: E402
from .engine import SimulationResult, run  # noqa: E402
from .harness import cost_optimal_n, run_h1_contrast  # noqa: E402

# ---------------------------------------------------------------------------
# paths / palette / style
# ---------------------------------------------------------------------------
ROOT = Path(__file__).resolve().parents[2]          # tools/pipeline-sim
DEFAULT_PLOTS_DIR = ROOT / "plots"

C_BASE = "#d1495b"        # baseline arm (test every merge)
C_DEFER = "#2e86ab"       # deferred arm (postpone to top)
C_FIT = "#e07a5f"         # fitted power law
C_ANALYTIC = "#6a4c93"    # analytic closed form
C_GRID = "#b9b9b9"        # dominated population
C_FRONT = "#e07a5f"       # Pareto frontier
C_ACCENT = "#f4a259"
PALETTE = ["#2e86ab", "#e07a5f", "#3f8f6b", "#9b5de5", "#f4a259", "#d1495b"]

#: Stable colour per task kind (Gantt + legends).
KIND_COLORS: Dict[str, str] = {
    "dispatch": "#8d99ae",
    "impl": "#2e86ab",
    "test_write": "#5fa8d3",
    "test_run": "#48b1a0",
    "setup": "#f4a259",
    "merge": "#e07a5f",
    "suite": "#c44536",
    "pre_release": "#9b5de5",
    "release": "#3a0ca3",
    "triage": "#b0b0b0",
    "spec": "#707070",
}

#: Ordered (label, config-kwarg, low, high) knob perturbations for the tornado.
TORNADO_SPECS: List[Tuple[str, str, object, object]] = [
    ("n  (2 -> 10)", "n", 2, 10),
    ("alpha  (1 -> 4)", "alpha", 1, 4),
    ("branch_levels  (1 -> 3)", "branch_levels", 1, 3),
    ("branch_fanout  (2 -> 4)", "branch_fanout", 2, 4),
    ("test_level  (all -> top)", "test_level", "all", "top"),
    ("test_exec  (affected -> full)", "test_exec", "affected_only", "full_suite"),
    ("m  (2 -> 8)", "m", 2, 8),
]


def _style() -> None:
    """One consistent, readable matplotlib style for the whole pack."""
    plt.rcParams.update({
        "figure.dpi": 130,
        "savefig.dpi": 130,
        "figure.facecolor": "white",
        "axes.facecolor": "white",
        "axes.grid": True,
        "grid.alpha": 0.25,
        "grid.linestyle": "--",
        "grid.linewidth": 0.6,
        "axes.titlesize": 12,
        "axes.titleweight": "bold",
        "axes.labelsize": 10.5,
        "xtick.labelsize": 9.5,
        "ytick.labelsize": 9.5,
        "legend.fontsize": 9.5,
        "legend.frameon": False,
        "font.size": 10,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "figure.autolayout": False,
    })


# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------
def _workload_config(M: int, **over: object) -> PipelineConfig:
    """A config comparable *across* ``M``: the agent pool scales with workload.

    ``m = max(2, ceil(M/8))`` mirrors ``tests/test_sqrt_scaling.py`` so the
    per-ticket cycle time does not itself grow with ``M`` (otherwise the fixed
    planning horizon in the batch law is not comparable across instances).
    """
    base: Dict[str, object] = {
        "W_tot": M * 10.0,
        "w": 10.0,
        "n": 5,
        "alpha": 2,
        "m": max(2, math.ceil(M / 8)),
    }
    base.update(over)
    return PipelineConfig(**base)  # type: ignore[arg-type]


def _loglog_slope(xs: Sequence[float], ys: Sequence[float]) -> float:
    """Least-squares slope of ``log y`` vs ``log x``."""
    lx = [math.log(x) for x in xs]
    ly = [math.log(y) for y in ys]
    mx = sum(lx) / len(lx)
    my = sum(ly) / len(ly)
    num = sum((a - mx) * (b - my) for a, b in zip(lx, ly))
    den = sum((a - mx) ** 2 for a in lx)
    return num / den


def _fit_power_law(xs: Sequence[float], ys: Sequence[float], n: int = 160
                   ) -> Tuple[float, float, np.ndarray, np.ndarray]:
    """Fit ``y = C x^slope`` (geometric-mean anchored) -> slope, C, X, Y."""
    slope = _loglog_slope(xs, ys)
    a = (sum(math.log(y) for y in ys) / len(ys)
         - slope * sum(math.log(x) for x in xs) / len(xs))
    X = np.geomspace(min(xs), max(xs), n)
    Y = math.exp(a) * X ** slope
    return slope, math.exp(a), X, Y


def _save_png(fig: plt.Figure, out_dir: Path, stem: str) -> Path:
    p = out_dir / f"{stem}.png"
    fig.savefig(p, bbox_inches="tight")
    plt.close(fig)
    return p


def _save_html(fig: go.Figure, out_dir: Path, stem: str) -> Path:
    p = out_dir / f"{stem}.html"
    pio.write_html(fig, file=str(p), include_plotlyjs="directory", full_html=True)
    return p


def _mean_utilisation(res: SimulationResult) -> float:
    """f5: mean agent busy fraction = total busy agent-time / (m * makespan)."""
    busy: Dict[int, float] = {}
    for r in res.records:
        busy[r.agent_id] = busy.get(r.agent_id, 0.0) + r.duration
    horizon = max(res.makespan, 1e-9)
    return sum(busy.values()) / (res.config.m * horizon)


def _fmt_usd(x: float) -> str:
    return f"${x:,.4f}" if abs(x) < 1 else f"${x:,.2f}"


def _fmt_s(x: float) -> str:
    return f"{x:,.0f} s"


# ---------------------------------------------------------------------------
# figure 1 -- sqrt scaling (L1)
# ---------------------------------------------------------------------------
@dataclass
class SqrtRow:
    M: int
    n_star: int
    cost: float
    n_analytic: float


def compute_sqrt_scaling(Ms: Sequence[int]) -> List[SqrtRow]:
    """Cost-optimal bucket size ``n*`` per workload ``M`` (spec L1)."""
    rows: List[SqrtRow] = []
    for M in Ms:
        cfg = _workload_config(M, n=1)
        n_star, best, _sweep = cost_optimal_n(cfg, range(1, M // 2 + 1))
        # analytic EOQ/ELSP reference at the same fixed-cost/holding parameters
        K, h, T = cfg.c_dispatch, cfg.c_wip, cfg.horizon
        n_analytic = math.sqrt(2.0 * K * M / (h * T))
        rows.append(SqrtRow(M=M, n_star=n_star, cost=best.total_cost,
                            n_analytic=n_analytic))
    return rows


def render_sqrt_scaling(rows: List[SqrtRow], out_dir: Path):
    Ms = [r.M for r in rows]
    ns = [r.n_star for r in rows]
    slope, C, X, Y = _fit_power_law(Ms, ns)

    # ---- matplotlib PNG ---------------------------------------------------
    fig, ax = plt.subplots(figsize=(8.2, 5.6))
    ax.loglog(Ms, ns, "o-", color=C_BASE, lw=2, ms=8, label="simulated $n^*$")
    ax.loglog(X, Y, "--", color=C_FIT, lw=1.8,
              label=f"fit:  $n^* \\approx {C:.2f}\\,M^{{{slope:.3f}}}$")
    ax.loglog(Ms, [r.n_analytic for r in rows], ":", color=C_ANALYTIC, lw=1.6,
              label=r"analytic EOQ: $\sqrt{2KM/(hT)}$")
    for r in rows:
        ax.annotate(f"{r.n_star}", (r.M, r.n_star), textcoords="offset points",
                    xytext=(0, 9), ha="center", fontsize=8, color=C_BASE)
    ax.set_xlabel("M  — tickets in the workload  (count)")
    ax.set_ylabel("n*  — cost-optimal bucket size  (tickets / bucket)")
    ax.set_title(f"Figure 1 — sqrt-scaling:  n* vs M  (log-log, fitted exponent "
                 f"{slope:.3f})")
    ax.legend(loc="upper left")
    ax.text(0.985, 0.03, "spec L1: n* ~ sqrt(M)", transform=ax.transAxes,
            ha="right", va="bottom", fontsize=9, style="italic", color="#555")
    png = _save_png(fig, out_dir, "01_sqrt_scaling")

    # ---- plotly HTML ------------------------------------------------------
    pfig = go.Figure()
    pfig.add_trace(go.Scatter(x=Ms, y=ns, mode="lines+markers", name="simulated n*",
                              marker=dict(size=10, color=C_BASE),
                              line=dict(color=C_BASE, width=2.5),
                              hovertemplate="M=%{x}<br>n*=%{y}<extra></extra>"))
    pfig.add_trace(go.Scatter(x=list(X), y=list(Y), mode="lines",
                              name=f"fit  n*≈{C:.2f}·M^{slope:.3f}",
                              line=dict(color=C_FIT, width=2, dash="dash")))
    pfig.add_trace(go.Scatter(x=Ms, y=[r.n_analytic for r in rows], mode="lines",
                              name="analytic EOQ √(2KM/hT)",
                              line=dict(color=C_ANALYTIC, width=2, dash="dot")))
    pfig.update_xaxes(type="log", title="M — tickets in the workload (count)")
    pfig.update_yaxes(type="log", title="n* — cost-optimal bucket size (tickets)")
    pfig.update_layout(title=f"Figure 1 — sqrt-scaling (fitted exponent {slope:.3f})",
                       template="plotly_white", legend=dict(x=0, y=1))
    html = _save_html(pfig, out_dir, "01_sqrt_scaling")
    return [png, html], pfig


# ---------------------------------------------------------------------------
# figure 2 -- H1 contrast (paired dumbbell)
# ---------------------------------------------------------------------------
@dataclass
class H1Row:
    M: int
    base_cost: float
    defer_cost: float
    base_ms: float
    defer_ms: float
    base_suites: int
    defer_suites: int


def compute_h1(Ms: Sequence[int], deferred_levels: int = 2) -> List[H1Row]:
    rows: List[H1Row] = []
    for M in Ms:
        cfg = _workload_config(M)
        c = run_h1_contrast(cfg, deferred_levels=deferred_levels)
        rows.append(H1Row(
            M=M,
            base_cost=c.baseline.total_cost, defer_cost=c.deferred.total_cost,
            base_ms=c.baseline.makespan, defer_ms=c.deferred.makespan,
            base_suites=c.baseline.num_suite_runs,
            defer_suites=c.deferred.num_suite_runs,
        ))
    return rows


def _dumbbell_ax(ax, ys, lo, hi, lo_label, hi_label, xlabel, title, fmt,
                 xlog=False):
    for y, a, b in zip(ys, lo, hi):
        ax.plot([a, b], [y, y], color="#cccccc", lw=3, zorder=1, solid_capstyle="round")
    ax.scatter(lo, ys, s=70, color=C_BASE, zorder=3, label=lo_label, edgecolor="white")
    ax.scatter(hi, ys, s=70, color=C_DEFER, zorder=3, label=hi_label, edgecolor="white")
    for y, a, b in zip(ys, lo, hi):
        lo_x, hi_x = (a, b) if a <= b else (b, a)
        ax.annotate("", xy=(hi_x, y), xytext=(lo_x, y), zorder=2,
                    arrowprops=dict(arrowstyle="->", color="#888", lw=1.2))
    if xlog:
        ax.set_xscale("log")
    ax.set_yticks(list(ys))
    ax.set_yticklabels([str(y) for y in ys])
    ax.invert_yaxis()
    ax.set_xlabel(xlabel)
    ax.set_ylabel("M — tickets in the workload  (count)")
    ax.set_title(title)
    ax.legend(loc="upper right")


def render_h1_contrast(rows: List[H1Row], out_dir: Path):
    Ms = [r.M for r in rows]

    # ---- matplotlib PNG: two dumbbell panels ------------------------------
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(11.5, 5.4))
    _dumbbell_ax(a1, Ms, [r.base_cost for r in rows], [r.defer_cost for r in rows],
                 "baseline (levels=1, test=all)", "deferred (levels=2, test=top)",
                 "total cost  (USD)",
                 "cost", _fmt_usd, xlog=True)
    _dumbbell_ax(a2, Ms, [r.base_ms for r in rows], [r.defer_ms for r in rows],
                 "baseline", "deferred",
                 "makespan  (seconds)",
                 "end-to-end time", _fmt_s, xlog=True)
    fig.suptitle("Figure 2 — H1 contrast: deferring tests to top-level merges "
                 "reduces BOTH cost and makespan", fontweight="bold", fontsize=12.5)
    for ax in (a1, a2):
        for r, y in zip(rows, Ms):
            d = (r.defer_cost - r.base_cost) if ax is a1 else (r.defer_ms - r.base_ms)
            ax.annotate(f"Δ {d:+,.3f}" if ax is a1 else f"Δ {d:+,.0f} s",
                        xy=(min((r.base_cost if ax is a1 else r.base_ms),
                                (r.defer_cost if ax is a1 else r.defer_ms)),
                            y),
                        xytext=(-6, 0), textcoords="offset points",
                        ha="right", va="center", fontsize=7.5, color="#444")
    png = _save_png(fig, out_dir, "02_h1_contrast")

    # ---- plotly HTML: grouped bars, cost + makespan -----------------------
    pfig = make_subplots(rows=1, cols=2,
                         subplot_titles=("total cost (USD, log)", "makespan (seconds, log)"))
    cats = [f"M={r.M}" for r in rows]
    for arm, val, colour in (("baseline (levels=1, test=all)",
                              [r.base_cost for r in rows], C_BASE),
                             ("deferred (levels=2, test=top)",
                              [r.defer_cost for r in rows], C_DEFER)):
        pfig.add_trace(go.Bar(x=cats, y=val, name=arm, marker_color=colour,
                              legendgroup="cost", showlegend=True,
                              hovertemplate="%{x}<br>$%{y:.3f}<extra>" + arm + "</extra>"),
                       row=1, col=1)
    for arm, val, colour in (("baseline", [r.base_ms for r in rows], C_BASE),
                             ("deferred", [r.defer_ms for r in rows], C_DEFER)):
        pfig.add_trace(go.Bar(x=cats, y=val, name=arm, marker_color=colour,
                              legendgroup="ms", showlegend=False,
                              hovertemplate="%{x}<br>%{y:,.0f} s<extra>" + arm + "</extra>"),
                       row=1, col=2)
    pfig.update_yaxes(type="log", row=1, col=1, title="total cost (USD)")
    pfig.update_yaxes(type="log", row=1, col=2, title="makespan (seconds)")
    pfig.update_layout(title="Figure 2 — H1 contrast (baseline vs deferred)",
                       barmode="group", template="plotly_white")
    html = _save_html(pfig, out_dir, "02_h1_contrast")
    return [png, html], pfig


# ---------------------------------------------------------------------------
# figure 3 / 9 -- design-space sweep (Pareto + parallel coordinates)
# ---------------------------------------------------------------------------
@dataclass
class DesignPoint:
    n: int
    alpha: int
    branch_levels: int
    branch_fanout: int
    test_level: str
    m: int
    cost: float
    makespan: float
    util: float
    suite_runs: int
    ok: bool
    risk: float = 0.0


def _test_level_code(tl: str) -> int:
    if tl == "all":
        return 0
    if tl == "top":
        return 2
    return 1  # level:L (not used in the sweep, kept for completeness)


def compute_design_grid(M: int,
                        ns: Sequence[int], alphas: Sequence[int],
                        levels: Sequence[int], fanouts: Sequence[int],
                        test_levels: Sequence[str], ms: Sequence[int]
                        ) -> List[DesignPoint]:
    pts: List[DesignPoint] = []
    for n in ns:
        for alpha in alphas:
            for bl in levels:
                for fo in fanouts:
                    for tl in test_levels:
                        for mm in ms:
                            cfg = _workload_config(
                                M, n=n, alpha=alpha, branch_levels=bl,
                                branch_fanout=fo, test_level=tl, m=mm)
                            r = run(cfg)
                            pts.append(DesignPoint(
                                n=n, alpha=alpha, branch_levels=bl,
                                branch_fanout=fo, test_level=tl, m=mm,
                                cost=r.total_cost, makespan=r.makespan,
                                util=_mean_utilisation(r),
                                suite_runs=r.num_suite_runs,
                                ok=not r.violations,
                                risk=r.risk))
    return pts


def _front_2d(points: Sequence[DesignPoint], x_of, y_of, minimize_y: bool = True
              ) -> List[DesignPoint]:
    """Non-dominated set for ``(min x, min y)`` (or ``max y`` when not minimize_y)."""
    if minimize_y:
        pts = sorted(points, key=lambda p: (x_of(p), y_of(p)))
        best = math.inf

        def keep(y: float, b: float) -> bool:
            return y < b - 1e-9
    else:
        pts = sorted(points, key=lambda p: (x_of(p), -y_of(p)))
        best = -math.inf

        def keep(y: float, b: float) -> bool:  # type: ignore[misc]
            return y > b + 1e-9
    front: List[DesignPoint] = []
    for p in pts:
        y = y_of(p)
        if math.isfinite(y) and keep(y, best):
            front.append(p)
            best = y
    return front


def pareto_front(points: Sequence[DesignPoint]) -> List[DesignPoint]:
    """Non-dominated set for (min cost, min makespan)."""
    return _front_2d(points, lambda p: p.cost, lambda p: p.makespan)


def _hover_cols(p: DesignPoint):
    return [p.n, p.alpha, p.branch_levels, p.branch_fanout, p.test_level, p.m,
            round(p.util, 3), p.suite_runs]


# customdata column order produced by ``to_hover``:
# 0 n, 1 alpha, 2 branch_levels, 3 branch_fanout, 4 test_level, 5 cost,
# 6 util, 7 m, 8 suite_runs, 9 makespan, 10 risk
_HOVER_TPL = ("cost=$%{customdata[5]:.3f}<br>makespan=%{customdata[9]:,.0f} s<br>"
              "risk f3=%{customdata[10]:.3f}<br>util=%{customdata[6]:.1%}<br>"
              "n=%{customdata[0]}, alpha=%{customdata[1]}, "
              "levels=%{customdata[2]}, fanout=%{customdata[3]}, "
              "test=%{customdata[4]}, m=%{customdata[7]}, suites=%{customdata[8]}"
              "<extra>%{fullData.name}</extra>")


def render_pareto(points: List[DesignPoint], out_dir: Path):
    """Two panels: the requested cost-vs-makespan front (which collapses), and a
    companion makespan-vs-utilisation front -- the one *implemented* objective
    pair that genuinely trades (spec f1 vs f5)."""
    front_cm = pareto_front(points)
    front_mu = _front_2d(points, lambda p: p.makespan, lambda p: p.util,
                         minimize_y=False)
    front_cr = _front_2d(points, lambda p: p.cost,
                         lambda p: getattr(p, "risk", 0.0))

    def to_hover(ps):
        return [[p.n, p.alpha, p.branch_levels, p.branch_fanout, p.test_level,
                 p.cost, p.util, p.m, p.suite_runs, p.makespan,
                 getattr(p, "risk", 0.0)] for p in ps]

    # ---- matplotlib PNG ---------------------------------------------------
    fig, (ax1, ax2, ax3) = plt.subplots(1, 3, figsize=(18.0, 5.8))

    # panel (a): cost vs makespan -- the requested view
    ax1.scatter([p.cost for p in points], [p.makespan for p in points],
                s=24, color=C_GRID, alpha=0.55, edgecolor="white", linewidth=0.3,
                label=f"design sweep ({len(points)})")
    ax1.scatter([p.cost for p in front_cm], [p.makespan for p in front_cm],
                s=170, marker="*", color=C_FRONT, edgecolor="#333", linewidth=0.6,
                zorder=5, label=f"non-dominated frontier ({len(front_cm)} pt)")
    corner = front_cm[0] if front_cm else min(points, key=lambda p: p.cost)
    ax1.annotate(
        f"min-cost AND min-makespan corner\n(n={corner.n}, α={corner.alpha}, "
        f"L={corner.branch_levels},\nfanout={corner.branch_fanout}, "
        f"{corner.test_level}, m={corner.m})",
        (corner.cost, corner.makespan), textcoords="offset points",
        xytext=(14, 22), fontsize=8,
        arrowprops=dict(arrowstyle="->", color="#555", lw=1.0))
    ax1.text(0.02, 0.98,
             "RQ9 finding (resolved): the cost↔makespan front is now\n"
             "non-degenerate — the per-agent occupancy cost ($/agent-second)\n"
             "makes buying makespan with more agents cost more, so both\n"
             "directions are non-dominated.",
             transform=ax1.transAxes, va="top", ha="left", fontsize=8.3,
             bbox=dict(boxstyle="round,pad=0.4", fc="#eaf7ef", ec="#7fc79a"))
    ax1.set_xlabel("total cost  (USD)")
    ax1.set_ylabel("makespan  (seconds)")
    ax1.set_title(f"(a) cost vs makespan — non-dominated ({len(front_cm)} pts)")
    ax1.legend(loc="lower right", fontsize=8.5)

    # panel (b): makespan vs utilisation -- a real implemented trade-off
    ax2.scatter([p.makespan for p in points], [p.util for p in points],
                s=24, color=C_GRID, alpha=0.55, edgecolor="white", linewidth=0.3,
                label=f"design sweep ({len(points)})")
    fr = sorted(front_mu, key=lambda p: p.makespan)
    ax2.plot([p.makespan for p in fr], [p.util for p in fr], "-",
             color=C_FRONT, lw=2, zorder=2)
    ax2.scatter([p.makespan for p in fr], [p.util for p in fr], s=55,
                color=C_FRONT, edgecolor="white", zorder=4,
                label=f"non-dominated frontier ({len(front_mu)} pts)")
    ax2.text(0.98, 0.03,
             "the pair that trades: more agents buy\n"
             "makespan with utilisation. This is the\n"
             "model's true implemented 2-objective surface.",
             transform=ax2.transAxes, va="bottom", ha="right", fontsize=8.3,
             bbox=dict(boxstyle="round,pad=0.4", fc="#eaf3f8", ec="#87b6cc"))
    ax2.set_xlabel("makespan  (seconds)")
    ax2.set_ylabel("mean agent utilisation  (busy / (m·makespan), fraction)")
    ax2.set_ylim(0, 1.05)
    ax2.set_title("(b) makespan vs utilisation — trade-off (f1 vs f5)")
    ax2.legend(loc="upper right", fontsize=8.5)

    # panel (c): cost vs risk -- the f3 objective (rework + blast radius)
    ax3.scatter([p.cost for p in points], [getattr(p, "risk", 0.0) for p in points],
                s=24, color=C_GRID, alpha=0.55, edgecolor="white", linewidth=0.3,
                label=f"design sweep ({len(points)})")
    fr = sorted(front_cr, key=lambda p: p.cost)
    ax3.plot([p.cost for p in fr], [getattr(p, "risk", 0.0) for p in fr], "-",
             color=C_FRONT, lw=2, zorder=2)
    ax3.scatter([p.cost for p in fr], [getattr(p, "risk", 0.0) for p in fr], s=55,
                color=C_FRONT, edgecolor="white", zorder=4,
                label=f"non-dominated frontier ({len(front_cr)} pts)")
    ax3.text(0.98, 0.03,
             "deferral is cheaper AND faster but raises f3:\n"
             "fewer, later suite runs widen the blast radius\n"
             "and add expected rework. A real cost↔risk trade.",
             transform=ax3.transAxes, va="bottom", ha="right", fontsize=8.3,
             bbox=dict(boxstyle="round,pad=0.4", fc="#fdf1e3", ec="#e0b980"))
    ax3.set_xlabel("total cost  (USD)")
    ax3.set_ylabel("risk  f3  (rho·blast·conflict + p·rework)")
    ax3.set_title("(c) cost vs risk — the f3 objective")
    ax3.legend(loc="upper left", fontsize=8.5)

    fig.suptitle(f"Figure 3 — Pareto surfaces over the {len(points)}-point design sweep "
                 f"(M swept, supported knobs only)", fontweight="bold", fontsize=12.5)
    png = _save_png(fig, out_dir, "03_pareto_front")

    # ---- plotly HTML ------------------------------------------------------
    pfig = make_subplots(rows=1, cols=3,
                         subplot_titles=("cost vs makespan (non-dominated)",
                                         "makespan vs utilisation",
                                         "cost vs risk (f3)"))
    pfig.add_trace(go.Scatter(
        x=[p.cost for p in points], y=[p.makespan for p in points], mode="markers",
        name="design sweep", marker=dict(size=6, color=C_GRID, opacity=0.6),
        customdata=to_hover(points), hovertemplate=_HOVER_TPL), row=1, col=1)
    pfig.add_trace(go.Scatter(
        x=[p.cost for p in front_cm], y=[p.makespan for p in front_cm],
        mode="markers", name="front (cost, makespan)",
        marker=dict(size=15, symbol="star", color=C_FRONT, line=dict(color="#333", width=0.6)),
        customdata=to_hover(front_cm), hovertemplate=_HOVER_TPL), row=1, col=1)
    pfig.add_trace(go.Scatter(
        x=[p.makespan for p in points], y=[p.util for p in points], mode="markers",
        name="design sweep", marker=dict(size=6, color=C_GRID, opacity=0.6),
        showlegend=False, customdata=to_hover(points),
        hovertemplate=_HOVER_TPL), row=1, col=2)
    pfig.add_trace(go.Scatter(
        x=[p.makespan for p in fr], y=[p.util for p in fr], mode="lines+markers",
        name="front (makespan, utilisation)", line=dict(color=C_FRONT, width=2.5),
        marker=dict(size=8, color=C_FRONT), customdata=to_hover(fr),
        hovertemplate=_HOVER_TPL), row=1, col=2)
    # panel (c): cost vs risk (f3)
    pfig.add_trace(go.Scatter(
        x=[p.cost for p in points], y=[getattr(p, "risk", 0.0) for p in points],
        mode="markers", name="design sweep", marker=dict(size=6, color=C_GRID, opacity=0.6),
        showlegend=False, customdata=to_hover(points),
        hovertemplate=_HOVER_TPL), row=1, col=3)
    frr = sorted(front_cr, key=lambda p: p.cost)
    pfig.add_trace(go.Scatter(
        x=[p.cost for p in frr], y=[getattr(p, "risk", 0.0) for p in frr],
        mode="lines+markers", name="front (cost, risk)",
        line=dict(color=C_FRONT, width=2.5), marker=dict(size=8, color=C_FRONT),
        customdata=to_hover(frr), hovertemplate=_HOVER_TPL), row=1, col=3)
    pfig.update_xaxes(title_text="total cost (USD)", row=1, col=1)
    pfig.update_yaxes(title_text="makespan (seconds)", row=1, col=1)
    pfig.update_xaxes(title_text="makespan (seconds)", row=1, col=2)
    pfig.update_yaxes(title_text="mean agent utilisation", row=1, col=2)
    pfig.update_xaxes(title_text="total cost (USD)", row=1, col=3)
    pfig.update_yaxes(title_text="risk f3", row=1, col=3)
    pfig.update_layout(title="Figure 3 — Pareto surfaces: cost/makespan and cost/risk "
                             "(f3) trade, plus makespan/utilisation",
                       template="plotly_white")
    html = _save_html(pfig, out_dir, "03_pareto_front")
    return [png, html], pfig


def render_parallel_coords(points: List[DesignPoint], out_dir: Path):
    dims = ["n", "alpha", "branch_levels", "branch_fanout", "m", "test_level"]
    raw = [[p.n, p.alpha, p.branch_levels, p.branch_fanout, p.m,
            _test_level_code(p.test_level)] for p in points]
    costs = [p.cost for p in points]
    ms = [p.makespan for p in points]
    all_dims = dims + ["cost", "makespan"]
    arr = np.array([r + [c, s] for r, c, s in zip(raw, costs, ms)], dtype=float)

    # ---- matplotlib PNG ---------------------------------------------------
    fig, ax = plt.subplots(figsize=(11.5, 6.0))
    mins = arr.min(axis=0)
    maxs = arr.max(axis=0)
    rng = np.where(maxs - mins == 0, 1.0, maxs - mins)
    norm = (arr - mins) / rng
    x = np.arange(len(all_dims))
    cmap = plt.cm.viridis
    cnorm = plt.Normalize(min(costs), max(costs))
    for i in range(len(points)):
        ax.plot(x, norm[i], color=cmap(cnorm(costs[i])), alpha=0.30, lw=0.7)
    for xi in x:
        ax.axvline(xi, color="#999", lw=0.6, alpha=0.6)
    ax.set_xticks(x)
    ax.set_xticklabels(all_dims)
    ax.set_yticks([])
    ax.set_ylim(-0.05, 1.05)
    ylab = 1.0
    for xi, name in enumerate(all_dims):
        if name in ("n", "alpha", "branch_levels", "branch_fanout", "m"):
            ax.text(xi, ylab + 0.02, f"{int(mins[xi])}", ha="center", fontsize=7, color="#333")
            ax.text(xi, -0.07, f"{int(maxs[xi])}", ha="center", fontsize=7, color="#333")
        elif name == "test_level":
            ax.text(xi, ylab + 0.02, "all", ha="center", fontsize=7, color="#333")
            ax.text(xi, -0.07, "top", ha="center", fontsize=7, color="#333")
    sm = plt.cm.ScalarMappable(cmap=cmap, norm=cnorm)
    cb = fig.colorbar(sm, ax=ax, pad=0.01)
    cb.set_label("total cost (USD)")
    ax.set_title("Figure 9 — parallel coordinates: supported knobs -> (cost, makespan)")
    png = _save_png(fig, out_dir, "09_parallel_coordinates")

    # ---- plotly HTML ------------------------------------------------------
    pfig = go.Figure(go.Parcoords(
        line=dict(color=costs, colorscale="Viridis", showscale=True,
                  colorbar=dict(title="cost (USD)")),
        dimensions=[dict(label=d, values=arr[:, i], range=[mins[i], maxs[i]])
                    for i, d in enumerate(all_dims)]))
    pfig.update_layout(title="Figure 9 — parallel coordinates (knobs -> cost, makespan)",
                       template="plotly_white", height=620)
    html = _save_html(pfig, out_dir, "09_parallel_coordinates")
    return [png, html], pfig


# ---------------------------------------------------------------------------
# figure 4 -- interaction heatmap (branch_levels x test_level)
# ---------------------------------------------------------------------------
def compute_interaction(M: int, levels: Sequence[int], test_levels: Sequence[str]
                        ) -> Tuple[np.ndarray, np.ndarray]:
    cost = np.full((len(levels), len(test_levels)), np.nan)
    msk = np.full((len(levels), len(test_levels)), np.nan)
    for i, bl in enumerate(levels):
        for j, tl in enumerate(test_levels):
            try:
                cfg = _workload_config(M, branch_levels=bl, test_level=tl)
                r = run(cfg)
            except ValueError:
                continue  # e.g. level:2 is invalid at branch_levels=1
            cost[i, j] = r.total_cost
            msk[i, j] = r.makespan
    return cost, msk


def _heatmap_ax(ax, grid, levels, test_levels, title, cbar_label, cmap, fmt):
    cm = plt.get_cmap(cmap).with_extremes(bad="#ececec")
    masked = np.ma.masked_invalid(grid)
    im = ax.imshow(masked, cmap=cm, aspect="auto")
    ax.set_xticks(range(len(test_levels)))
    ax.set_xticklabels(test_levels)
    ax.set_yticks(range(len(levels)))
    ax.set_yticklabels([f"L{l}" for l in levels])
    ax.set_xlabel("test_level  — which merges trigger a suite run")
    ax.set_ylabel("branch_levels  — merge-tree depth")
    ax.set_title(title)
    finite = grid[np.isfinite(grid)]
    lo, hi = (finite.min(), finite.max()) if finite.size else (0, 1)
    for i in range(len(levels)):
        for j in range(len(test_levels)):
            v = grid[i, j]
            if not np.isfinite(v):
                ax.text(j, i, "n/a", ha="center", va="center", fontsize=8, color="#999")
                continue
            frac = 0.0 if hi == lo else (v - lo) / (hi - lo)
            ax.text(j, i, fmt(v), ha="center", va="center", fontsize=8.5,
                    color="white" if frac > 0.6 else "#222")
    cb = ax.figure.colorbar(im, ax=ax, pad=0.02)
    cb.set_label(cbar_label)
    ax.grid(False)


def render_interaction_heatmap(M: int, levels: Sequence[int],
                               test_levels: Sequence[str], out_dir: Path):
    cost, msk = compute_interaction(M, levels, test_levels)
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(12.0, 4.6))
    _heatmap_ax(a1, cost, levels, test_levels, "total cost", "cost (USD)", "YlOrRd",
                lambda v: f"{v:,.3f}")
    _heatmap_ax(a2, msk, levels, test_levels, "makespan", "makespan (seconds)", "YlGnBu",
                lambda v: f"{v:,.0f}")
    fig.suptitle(f"Figure 4 — interaction phase diagram over "
                 f"(branch_levels x test_level) at M={M}", fontweight="bold", fontsize=12.5)
    png = _save_png(fig, out_dir, "04_interaction_heatmap")

    pfig = make_subplots(rows=1, cols=2,
                         subplot_titles=("total cost (USD)", "makespan (seconds)"),
                         horizontal_spacing=0.14)
    for col, (grid, cscale, unit) in enumerate(
            ((cost, "YlOrRd", "$%{z:.3f}"), (msk, "YlGnBu", "%{z:,.0f} s")), start=1):
        pfig.add_trace(go.Heatmap(
            z=grid, x=list(test_levels), y=[f"L{l}" for l in levels],
            colorscale=cscale, colorbar=dict(x=0.45 if col == 1 else 1.0),
            hovertemplate="levels=%{y}<br>test_level=%{x}<br>" + unit + "<extra></extra>"),
            row=1, col=col)
    for col, grid in ((1, cost), (2, msk)):
        finite = grid[np.isfinite(grid)]
        if finite.size:
            pfig.add_trace(go.Scatter(
                x=np.repeat(list(test_levels), len(levels)),
                y=np.tile([f"L{l}" for l in levels], len(test_levels)),
                mode="text",
                text=[(f"{v:,.3f}" if v < 10 else f"{v:,.0f}") if np.isfinite(v) else ""
                      for v in grid.T.ravel()],
                textfont=dict(size=10, color="#333"), showlegend=False),
                row=1, col=col)
    pfig.update_xaxes(title_text="test_level", row=1, col=1)
    pfig.update_xaxes(title_text="test_level", row=1, col=2)
    pfig.update_yaxes(title_text="branch_levels", row=1, col=1)
    pfig.update_layout(title=f"Figure 4 — interaction heatmap (M={M})",
                       template="plotly_white")
    html = _save_html(pfig, out_dir, "04_interaction_heatmap")
    return [png, html], pfig


# ---------------------------------------------------------------------------
# figure 5 -- tornado (one-at-a-time sensitivity on total cost)
# ---------------------------------------------------------------------------
@dataclass
class TornadoRow:
    label: str
    low: float
    high: float
    base: float

    @property
    def spread(self) -> float:
        return abs(self.high - self.low)


def compute_tornado(base_cfg: PipelineConfig,
                    specs: Sequence[Tuple[str, str, object, object]]
                    ) -> Tuple[float, List[TornadoRow]]:
    base = run(base_cfg).total_cost
    rows: List[TornadoRow] = []
    for label, kw, lo, hi in specs:
        lo_c = run(replace(base_cfg, **{kw: lo})).total_cost
        hi_c = run(replace(base_cfg, **{kw: hi})).total_cost
        rows.append(TornadoRow(label=label, low=lo_c, high=hi_c, base=base))
    rows.sort(key=lambda r: r.spread, reverse=True)
    return base, rows


def render_tornado(base: float, rows: List[TornadoRow], out_dir: Path):
    labels = [r.label for r in rows]
    lows_chg = [r.low - base for r in rows]
    highs_chg = [r.high - base for r in rows]

    # ---- matplotlib PNG ---------------------------------------------------
    fig, ax = plt.subplots(figsize=(9.4, 5.6))
    y = np.arange(len(rows))
    left = np.minimum(lows_chg, highs_chg)
    width = np.abs(np.array(highs_chg) - np.array(lows_chg))
    ax.barh(y, width, left=left, color=C_DEFER, alpha=0.85, edgecolor="white")
    ax.axvline(0, color="#333", lw=1.3)
    ax.set_yticks(y)
    ax.set_yticklabels(labels)
    ax.invert_yaxis()
    for yi, r in zip(y, rows):
        ax.text(r.low - base, yi, f" {_fmt_usd(r.low)}" if r.low <= r.high else f"{_fmt_usd(r.low)} ",
                va="center", ha="right" if r.low <= r.high else "left", fontsize=7.5, color="#333")
        ax.text(r.high - base, yi, f" {_fmt_usd(r.high)}" if r.high >= r.low else f"{_fmt_usd(r.high)} ",
                va="center", ha="left" if r.high >= r.low else "right", fontsize=7.5, color="#333")
    ax.set_xlabel("change in total cost vs base  (USD)")
    ax.set_title("Figure 5 — tornado: one-at-a-time knob sensitivity of total cost\n"
                 f"base total cost = {_fmt_usd(base)}  (labels show absolute cost at each level)")
    lo_end = np.minimum(lows_chg, highs_chg)
    hi_end = np.maximum(lows_chg, highs_chg)
    xmin, xmax = min(lo_end.min(), 0.0), max(hi_end.max(), 0.0)
    span = (xmax - xmin) or 1.0
    ax.set_xlim(xmin - 0.26 * span, xmax + 0.10 * span)
    png = _save_png(fig, out_dir, "05_tornado_sensitivity")

    # ---- plotly HTML ------------------------------------------------------
    pfig = go.Figure(go.Bar(
        y=labels, x=width, base=left, orientation="h", marker_color=C_DEFER,
        customdata=list(zip([r.low for r in rows], [r.high for r in rows],
                            [r.base for r in rows])),
        hovertemplate=("low=%{customdata[0]:.3f}<br>high=%{customdata[1]:.3f}<br>"
                       "base=%{customdata[2]:.3f}<extra></extra>")))
    pfig.add_vline(x=0, line_color="#333")
    pfig.update_xaxes(title="change in total cost vs base (USD)")
    pfig.update_layout(title=f"Figure 5 — tornado sensitivity (base cost {_fmt_usd(base)})",
                       template="plotly_white", height=560)
    html = _save_html(pfig, out_dir, "05_tornado_sensitivity")
    return [png, html], pfig


# ---------------------------------------------------------------------------
# figure 6 -- compounding suite (C9)
# ---------------------------------------------------------------------------
@dataclass
class CompoundingData:
    acc_ac: List[int]
    per_run_cost: List[float]
    per_run_time: List[float]
    runs: List[int]
    cum_cost: List[float]
    cum_time: List[float]
    c_suite: float
    c_a: float
    t_suite: float
    e: float


def compute_compounding(cfg: PipelineConfig, max_runs: int) -> CompoundingData:
    max_n = cfg.alpha * max_runs
    acc_ac = list(range(0, max_n + 1))
    per_run_cost = [cfg.c_suite + N * cfg.c_a for N in acc_ac]
    per_run_time = [cfg.t_suite + N * cfg.e for N in acc_ac]
    runs = list(range(1, max_runs + 1))
    # each accumulating run i inherits i*alpha ACs (C9 lands one bucket per run)
    cum_cost = [sum(cfg.c_suite + (i * cfg.alpha) * cfg.c_a for i in range(1, R + 1))
                for R in runs]
    cum_time = [sum(cfg.t_suite + (i * cfg.alpha) * cfg.e for i in range(1, R + 1))
                for R in runs]
    return CompoundingData(acc_ac, per_run_cost, per_run_time, runs, cum_cost, cum_time,
                           cfg.c_suite, cfg.c_a, cfg.t_suite, cfg.e)


def render_compounding(d: CompoundingData, out_dir: Path):
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(12.0, 4.9))
    # panel A: a single run -- linear with intercept
    a1.plot(d.acc_ac, d.per_run_cost, color=C_BASE, lw=2, label="cost / run (USD)")
    a1.set_xlabel("accumulated acceptance criteria in the run  (count)")
    a1.set_ylabel("cost of one suite run  (USD)", color=C_BASE)
    a1.tick_params(axis="y", labelcolor=C_BASE)
    a1b = a1.twinx()
    a1b.plot(d.acc_ac, d.per_run_time, color=C_DEFER, lw=2, ls="--", label="time / run (s)")
    a1b.set_ylabel("duration of one suite run  (seconds)", color=C_DEFER)
    a1b.tick_params(axis="y", labelcolor=C_DEFER)
    a1b.grid(False)
    a1.set_title(f"(a) one run:  cost = {'$'}{d.c_suite} + N·{'$'}{d.c_a}\n"
                 f"time = {d.t_suite:g}s + N·{d.e:g}s   (linear with intercept)")
    # panel B: cumulative over an accumulating run sequence -- superlinear
    a2.plot(d.runs, d.cum_cost, color=C_BASE, lw=2, marker="o", ms=4,
            label="cumulative cost (USD)")
    a2.set_xlabel("number of accumulating suite runs  (count)")
    a2.set_ylabel("cumulative suite cost  (USD)", color=C_BASE)
    a2.tick_params(axis="y", labelcolor=C_BASE)
    a2b = a2.twinx()
    a2b.plot(d.runs, d.cum_time, color=C_DEFER, lw=2, ls="--", marker="s", ms=4,
             label="cumulative time (s)")
    a2b.set_ylabel("cumulative suite time  (seconds)", color=C_DEFER)
    a2b.tick_params(axis="y", labelcolor=C_DEFER)
    a2b.grid(False)
    a2.set_title("(b) a run sequence:  total ∝ R(R+1)/2\n(superlinear — why deferral pays)")
    fig.suptitle("Figure 6 — the compounding suite (spec C9)", fontweight="bold",
                 fontsize=12.5, y=0.98)
    # twin-axis labels of the two panels would otherwise collide in the middle
    fig.subplots_adjust(left=0.07, right=0.93, top=0.78, bottom=0.14, wspace=0.60)
    png = _save_png(fig, out_dir, "06_compounding_suite")

    pfig = make_subplots(rows=1, cols=2, specs=[[{"secondary_y": True}, {"secondary_y": True}]],
                         subplot_titles=("one run vs accumulated ACs (linear)",
                                         "cumulative across an accumulating run sequence (superlinear)"))
    pfig.add_trace(go.Scatter(x=d.acc_ac, y=d.per_run_cost, name="cost / run",
                              line=dict(color=C_BASE, width=2)), row=1, col=1, secondary_y=False)
    pfig.add_trace(go.Scatter(x=d.acc_ac, y=d.per_run_time, name="time / run",
                              line=dict(color=C_DEFER, width=2, dash="dash")),
                   row=1, col=1, secondary_y=True)
    pfig.add_trace(go.Scatter(x=d.runs, y=d.cum_cost, name="cumulative cost",
                              line=dict(color=C_BASE, width=2), marker=dict(size=5)),
                   row=1, col=2, secondary_y=False)
    pfig.add_trace(go.Scatter(x=d.runs, y=d.cum_time, name="cumulative time",
                              line=dict(color=C_DEFER, width=2, dash="dash"),
                              marker=dict(size=5)), row=1, col=2, secondary_y=True)
    pfig.update_xaxes(title_text="accumulated ACs", row=1, col=1)
    pfig.update_xaxes(title_text="accumulating runs", row=1, col=2)
    pfig.update_yaxes(title_text="cost (USD)", row=1, col=1, secondary_y=False)
    pfig.update_yaxes(title_text="time (s)", row=1, col=1, secondary_y=True)
    pfig.update_yaxes(title_text="cumulative cost (USD)", row=1, col=2, secondary_y=False)
    pfig.update_yaxes(title_text="cumulative time (s)", row=1, col=2, secondary_y=True)
    pfig.update_layout(title="Figure 6 — compounding suite (C9)", template="plotly_white",
                       legend=dict(orientation="h", y=-0.18))
    html = _save_html(pfig, out_dir, "06_compounding_suite")
    return [png, html], pfig


# ---------------------------------------------------------------------------
# figure 7 -- small multiples (objectives vs n, faceted by branch level)
# ---------------------------------------------------------------------------
def compute_small_multiples(M: int, levels: Sequence[int], nmax: int
                            ) -> Dict[int, List[Tuple[int, float, float]]]:
    data: Dict[int, List[Tuple[int, float, float]]] = {}
    for bl in levels:
        rows: List[Tuple[int, float, float]] = []
        for n in range(1, nmax + 1):
            cfg = _workload_config(M, n=n, branch_levels=bl)
            r = run(cfg)
            rows.append((n, r.total_cost, r.makespan))
        data[bl] = rows
    return data


def render_small_multiples(M: int, data: Dict[int, List[Tuple[int, float, float]]],
                           out_dir: Path):
    levels = list(data.keys())
    fig, axes = plt.subplots(len(levels), 2, figsize=(11.0, 2.5 * len(levels)),
                             sharex=True)
    if len(levels) == 1:
        axes = np.array([axes])
    for i, bl in enumerate(levels):
        rows = data[bl]
        ns = [r[0] for r in rows]
        costs = [r[1] for r in rows]
        ms = [r[2] for r in rows]
        a_c, a_m = axes[i, 0], axes[i, 1]
        a_c.plot(ns, costs, color=C_BASE, lw=2, marker="o", ms=3.5)
        n_star = ns[int(np.argmin(costs))]
        a_c.axvline(n_star, color=C_ACCENT, lw=1.2, ls=":")
        a_c.annotate(f"n*={n_star}", (n_star, min(costs)), textcoords="offset points",
                     xytext=(6, 6), fontsize=8, color=C_ACCENT)
        a_c.set_ylabel(f"L{bl}\ncost (USD)", fontsize=9)
        a_m.plot(ns, ms, color=C_DEFER, lw=2, marker="o", ms=3.5)
        a_m.set_ylabel(f"L{bl}\nmakespan (s)", fontsize=9)
        for a in (a_c, a_m):
            a.grid(True, alpha=0.25)
        if i == 0:
            a_c.set_title("total cost vs n")
            a_m.set_title("makespan vs n")
        if i == len(levels) - 1:
            a_c.set_xlabel("n — tickets per bucket  (count)")
            a_m.set_xlabel("n — tickets per bucket  (count)")
    fig.suptitle(f"Figure 7 — small multiples: objectives vs n, faceted by branch level "
                 f"(M={M})", fontweight="bold", fontsize=12.5)
    png = _save_png(fig, out_dir, "07_small_multiples")

    # plotly: one figure, facet rows, cost + makespan as separate mini-plots
    pfig = make_subplots(rows=len(levels), cols=2, shared_xaxes=True,
                         vertical_spacing=0.05, horizontal_spacing=0.09,
                         row_titles=[f"L{bl}" for bl in levels],
                         subplot_titles=[t for bl in levels
                                         for t in ("cost (USD)", "makespan (s)")])
    for i, bl in enumerate(levels, start=1):
        rows = data[bl]
        pfig.add_trace(go.Scatter(x=[r[0] for r in rows], y=[r[1] for r in rows],
                                  mode="lines+markers", line=dict(color=C_BASE),
                                  name=f"L{bl} cost", showlegend=False,
                                  hovertemplate="n=%{x}<br>$%{y:.4f}<extra></extra>"),
                       row=i, col=1)
        pfig.add_trace(go.Scatter(x=[r[0] for r in rows], y=[r[2] for r in rows],
                                  mode="lines+markers", line=dict(color=C_DEFER),
                                  name=f"L{bl} makespan", showlegend=False,
                                  hovertemplate="n=%{x}<br>%{y:,.0f} s<extra></extra>"),
                       row=i, col=2)
    pfig.update_xaxes(title_text="n (tickets/bucket)", row=len(levels), col=1)
    pfig.update_xaxes(title_text="n (tickets/bucket)", row=len(levels), col=2)
    pfig.update_layout(title=f"Figure 7 — small multiples: objectives vs n (M={M})",
                       template="plotly_white", height=230 * len(levels))
    html = _save_html(pfig, out_dir, "07_small_multiples")
    return [png, html], pfig


# ---------------------------------------------------------------------------
# figure 8 -- Gantt + agent utilisation
# ---------------------------------------------------------------------------
def _agent_utilisation(res: SimulationResult) -> Tuple[List[int], List[float]]:
    busy: Dict[int, float] = {}
    for r in res.records:
        busy[r.agent_id] = busy.get(r.agent_id, 0.0) + r.duration
    agents = sorted(busy)
    horizon = max(res.makespan, 1e-9)
    return agents, [busy[a] / horizon for a in agents]


def render_gantt(res: SimulationResult, out_dir: Path):
    agents, util = _agent_utilisation(res)
    kinds = sorted({r.kind for r in res.records},
                   key=lambda k: list(KIND_COLORS).index(k) if k in KIND_COLORS else 99)

    # ---- matplotlib PNG ---------------------------------------------------
    fig, (a1, a2) = plt.subplots(2, 1, figsize=(12.5, 8.0),
                                 gridspec_kw={"height_ratios": [3, 1]})
    for kind in kinds:
        recs = [r for r in res.records if r.kind == kind]
        left = [r.start for r in recs]
        width = [max(r.duration, 1e-6) for r in recs]
        y = [r.agent_id for r in recs]
        a1.barh(y, width, left=left, height=0.7, color=KIND_COLORS.get(kind, "#999"),
                edgecolor="white", linewidth=0.3, label=kind)
    a1.set_yticks(agents)
    a1.set_yticklabels([f"agent {a}" for a in agents])
    a1.invert_yaxis()
    a1.set_xlabel("time  (seconds)")
    a1.set_title(f"Figure 8 — schedule: task timeline per agent "
                 f"(M={res.config.M}, n={res.config.n}, L={res.branch_levels}, "
                 f"test={res.test_level}, m={res.config.m}; makespan={res.makespan:,.0f} s)")
    kind_handles, kind_labels = a1.get_legend_handles_labels()
    a2.bar([f"agent {a}" for a in agents], util, color=C_DEFER, alpha=0.9)
    mean_u = sum(util) / len(util) if util else 0.0
    a2.axhline(mean_u, color=C_BASE, ls="--", lw=1.4,
               label=f"mean {mean_u:.1%}")
    for i, u in enumerate(util):
        a2.text(i, u, f"{u:.1%}", ha="center", va="bottom", fontsize=8)
    a2.set_ylim(0, 1.05)
    a2.set_ylabel("utilisation\n(busy / makespan)")
    a2.set_title("agent utilisation")
    a2.legend(loc="upper right")
    # task-kind legend below the whole figure so it never occludes the bars
    fig.legend(kind_handles, kind_labels, loc="lower center", ncol=6, fontsize=8,
               frameon=False, bbox_to_anchor=(0.5, -0.01))
    fig.subplots_adjust(top=0.93, bottom=0.11, hspace=0.55)
    png = _save_png(fig, out_dir, "08_gantt_utilisation")

    # ---- plotly HTML ------------------------------------------------------
    pfig = make_subplots(rows=2, cols=1, row_heights=[0.72, 0.28], vertical_spacing=0.12,
                         subplot_titles=("task timeline per agent", "agent utilisation"))
    for kind in kinds:
        recs = [r for r in res.records if r.kind == kind]
        pfig.add_trace(go.Bar(
            y=[f"agent {r.agent_id}" for r in recs],
            x=[max(r.duration, 1e-6) for r in recs],
            base=[r.start for r in recs], orientation="h",
            name=kind, marker_color=KIND_COLORS.get(kind, "#999"),
            customdata=[[r.start, r.finish, r.ticket if r.ticket is not None else -1,
                         r.ac] for r in recs],
            hovertemplate=("start=%{customdata[0]:,.0f}s  finish=%{customdata[1]:,.0f}s<br>"
                           "ticket=%{customdata[2]}  ac=%{customdata[3]}"
                           "<extra>" + kind + "</extra>")), row=1, col=1)
    pfig.add_trace(go.Bar(x=[f"agent {a}" for a in agents], y=util,
                          marker_color=C_DEFER, name="utilisation", showlegend=False,
                          hovertemplate="%{x}<br>%{y:.1%}<extra></extra>"), row=2, col=1)
    pfig.update_yaxes(autorange="reversed", title_text="", row=1, col=1)
    pfig.update_xaxes(title_text="time (seconds)", row=1, col=1)
    pfig.update_yaxes(title_text="busy / makespan", range=[0, 1.05], row=2, col=1)
    pfig.update_layout(barmode="overlay", template="plotly_white",
                       title="Figure 8 — schedule + utilisation "
                             f"(makespan {res.makespan:,.0f} s, mean util {mean_u:.1%})",
                       height=760, legend=dict(orientation="h", y=-0.08))
    html = _save_html(pfig, out_dir, "08_gantt_utilisation")
    return [png, html], pfig


# ---------------------------------------------------------------------------
# figure 10 -- interactive dashboard (tabbed)
# ---------------------------------------------------------------------------
_DASHBOARD_CSS = """
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;
     margin:0;background:#fafafa;color:#222}
header{padding:18px 26px 6px}
header h1{margin:0 0 4px;font-size:20px}
header p{margin:0;color:#555;font-size:13px;max-width:1100px}
.tabs{display:flex;flex-wrap:wrap;gap:6px;padding:12px 26px 0}
.tabbtn{border:1px solid #ccc;background:#fff;border-radius:6px 6px 0 0;
        padding:7px 12px;cursor:pointer;font-size:13px}
.tabbtn:hover{background:#f0f0f0}
.tabbtn.active{background:#2e86ab;color:#fff;border-color:#2e86ab}
.tabwrap{padding:0 26px 26px}
.tab{border:1px solid #ddd;background:#fff;border-radius:0 6px 6px 6px;padding:8px}
"""
_DASHBOARD_JS = """
function showTab(i){
  document.querySelectorAll('.tab').forEach(function(el,j){
    el.style.display = (j===i)?'block':'none';});
  document.querySelectorAll('.tabbtn').forEach(function(el,j){
    if(j===i){el.classList.add('active');}else{el.classList.remove('active');}});
}
"""


def render_dashboard(out_dir: Path, rendered: List["Rendered"]) -> Path:
    tabs = [r for r in rendered if r.plotly is not None]
    buttons, divs = [], []
    for i, r in enumerate(tabs):
        divs.append(
            f'<div class="tab" style="display:{"block" if i == 0 else "none"}">'
            + pio.to_html(r.plotly, full_html=False, include_plotlyjs=False)
            + "</div>")
        active = " active" if i == 0 else ""
        buttons.append(f'<button class="tabbtn{active}" onclick="showTab({i})">'
                       f'{r.title}</button>')
    html = (
        "<!doctype html><html lang='en'><head><meta charset='utf-8'>"
        "<title>pipeline-sim — interactive plot pack</title>"
        "<script src='plotly.min.js'></script>"
        f"<style>{_DASHBOARD_CSS}</style></head><body>"
        "<header><h1>pipeline-sim — interactive dashboard</h1>"
        "<p>Rendered from the deterministic simulator (spec 10 plot pack). "
        "Hover, zoom and pan are live. Only implemented knobs are shown "
        "(n, alpha, branch_levels, branch_fanout, test_level, test_exec, m); "
        "unimplemented knobs (sigma, role partition, file isolation, rework, "
        "stochastic) are omitted by design.</p></header>"
        f"<div class='tabs'>{''.join(buttons)}</div>"
        f"<div class='tabwrap'>{''.join(divs)}</div>"
        f"<script>{_DASHBOARD_JS}</script></body></html>")
    p = out_dir / "10_dashboard.html"
    p.write_text(html, encoding="utf-8")
    return p


# ---------------------------------------------------------------------------
# orchestration
# ---------------------------------------------------------------------------
@dataclass
class Rendered:
    key: str
    title: str
    paths: List[Path]
    plotly: Optional[go.Figure] = None


#: figure keys in dashboard order
ORDER = ["sqrt", "h1", "pareto", "heatmap", "tornado", "compounding",
         "small_multiples", "gantt", "parcoords"]

_TITLES = {
    "sqrt": "1 · sqrt-scaling",
    "h1": "2 · H1 contrast",
    "pareto": "3 · Pareto front",
    "heatmap": "4 · interaction heatmap",
    "tornado": "5 · tornado sensitivity",
    "compounding": "6 · compounding suite",
    "small_multiples": "7 · small multiples",
    "gantt": "8 · Gantt + utilisation",
    "parcoords": "9 · parallel coordinates",
}


@dataclass
class _Sizes:
    sqrt_Ms: Sequence[int]
    h1_Ms: Sequence[int]
    M_grid: int
    grid_ns: Sequence[int]
    grid_alphas: Sequence[int]
    grid_levels: Sequence[int]
    grid_fanouts: Sequence[int]
    grid_tls: Sequence[str]
    grid_ms: Sequence[int]
    heat_M: int
    heat_levels: Sequence[int]
    heat_tls: Sequence[str]
    torn_M: int
    compound_runs: int
    sm_M: int
    sm_levels: Sequence[int]
    sm_nmax: int
    gantt_cfg: "PipelineConfig"


def _sizes(quick: bool) -> _Sizes:
    if quick:
        return _Sizes(
            sqrt_Ms=(8, 16), h1_Ms=(8, 16),
            M_grid=12, grid_ns=(2, 4), grid_alphas=(1, 2), grid_levels=(1, 2),
            grid_fanouts=(2,), grid_tls=("all", "top"), grid_ms=(2, 4),
            heat_M=12, heat_levels=(1, 2), heat_tls=("all", "level:2", "top"),
            torn_M=12, compound_runs=8, sm_M=8, sm_levels=(1, 2), sm_nmax=4,
            gantt_cfg=PipelineConfig(W_tot=80.0, w=10.0, n=4, alpha=2, m=3,
                                     branch_levels=2, test_level="all"),
        )
    return _Sizes(
        sqrt_Ms=(16, 24, 32, 48, 64, 96, 128), h1_Ms=(8, 16, 32, 64, 80),
        M_grid=40, grid_ns=(2, 4, 8), grid_alphas=(1, 2, 3), grid_levels=(1, 2, 3),
        grid_fanouts=(2, 3), grid_tls=("all", "top"), grid_ms=(2, 4, 8),
        heat_M=40, heat_levels=(1, 2, 3, 4), heat_tls=("all", "level:2", "top"),
        torn_M=40, compound_runs=40, sm_M=40, sm_levels=(1, 2, 3, 4), sm_nmax=20,
        gantt_cfg=PipelineConfig(W_tot=400.0, w=10.0, n=5, alpha=2, m=4,
                                 branch_levels=2, test_level="all"),
    )


def generate_all(out_dir: Path = DEFAULT_PLOTS_DIR, quick: bool = False,
                 only: Optional[Sequence[str]] = None) -> List[Rendered]:
    """Render the requested figures; return the :class:`Rendered` records."""
    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    _style()

    keys = [k for k in ORDER if (only is None or k in only)] if only is not None \
        else list(ORDER)
    want_dash = (only is None) or ("dashboard" in only) or ("all" in only)
    sz = _sizes(quick)

    # shared plotly.js so every HTML (and the dashboard) works offline
    (out_dir / "plotly.min.js").write_text(get_plotlyjs(), encoding="utf-8")

    rendered: List[Rendered] = []

    if "sqrt" in keys:
        paths, pf = render_sqrt_scaling(compute_sqrt_scaling(sz.sqrt_Ms), out_dir)
        rendered.append(Rendered("sqrt", _TITLES["sqrt"], paths, pf))

    if "h1" in keys:
        paths, pf = render_h1_contrast(compute_h1(sz.h1_Ms), out_dir)
        rendered.append(Rendered("h1", _TITLES["h1"], paths, pf))

    grid: Optional[List[DesignPoint]] = None
    if "pareto" in keys or "parcoords" in keys:
        grid = compute_design_grid(sz.M_grid, sz.grid_ns, sz.grid_alphas,
                                   sz.grid_levels, sz.grid_fanouts, sz.grid_tls,
                                   sz.grid_ms)
    if "pareto" in keys:
        paths, pf = render_pareto(grid or [], out_dir)
        rendered.append(Rendered("pareto", _TITLES["pareto"], paths, pf))

    if "heatmap" in keys:
        paths, pf = render_interaction_heatmap(sz.heat_M, sz.heat_levels,
                                               sz.heat_tls, out_dir)
        rendered.append(Rendered("heatmap", _TITLES["heatmap"], paths, pf))

    if "tornado" in keys:
        base_cfg = _workload_config(sz.torn_M, n=5, alpha=2, branch_levels=2,
                                    test_level="all", test_exec="full_suite", m=4)
        base, rows = compute_tornado(base_cfg, TORNADO_SPECS)
        paths, pf = render_tornado(base, rows, out_dir)
        rendered.append(Rendered("tornado", _TITLES["tornado"], paths, pf))

    if "compounding" in keys:
        d = compute_compounding(_workload_config(sz.torn_M), sz.compound_runs)
        paths, pf = render_compounding(d, out_dir)
        rendered.append(Rendered("compounding", _TITLES["compounding"], paths, pf))

    if "small_multiples" in keys:
        data = compute_small_multiples(sz.sm_M, sz.sm_levels, sz.sm_nmax)
        paths, pf = render_small_multiples(sz.sm_M, data, out_dir)
        rendered.append(Rendered("small_multiples", _TITLES["small_multiples"], paths, pf))

    if "gantt" in keys:
        res = run(sz.gantt_cfg)
        paths, pf = render_gantt(res, out_dir)
        rendered.append(Rendered("gantt", _TITLES["gantt"], paths, pf))

    if "parcoords" in keys:
        paths, pf = render_parallel_coords(grid or [], out_dir)
        rendered.append(Rendered("parcoords", _TITLES["parcoords"], paths, pf))

    if want_dash and rendered:
        path = render_dashboard(out_dir, rendered)
        rendered.append(Rendered("dashboard", "10 · dashboard", [path], None))

    return rendered


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="pipeline_sim.plots",
        description="Render the spec-10 plot pack (matplotlib PNG + plotly HTML).")
    p.add_argument("--out", default=str(DEFAULT_PLOTS_DIR),
                   help="output directory (default tools/pipeline-sim/plots)")
    p.add_argument("--quick", action="store_true",
                   help="tiny/fast pack for smoke-testing the render path")
    p.add_argument("--only", nargs="*", default=None,
                   help="subset of figures: " + " ".join(ORDER) + " dashboard")
    return p


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _build_parser().parse_args(argv)
    rendered = generate_all(Path(args.out), quick=args.quick, only=args.only)

    total = 0
    print(f"pipeline-sim plot pack -> {Path(args.out).resolve()}")
    print("-" * 78)
    for r in rendered:
        for p in r.paths:
            size = p.stat().st_size
            total += 1
            print(f"  [{r.key:15s}] {p.name:28s} {size:>10,} bytes")
    shared = Path(args.out) / "plotly.min.js"
    if shared.exists():
        print(f"  [shared]          {shared.name:28s} {shared.stat().st_size:>10,} bytes")
    print("-" * 78)
    print(f"{total} figure file(s) written")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
