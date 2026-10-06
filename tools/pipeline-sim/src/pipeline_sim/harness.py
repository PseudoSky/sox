"""Run harness: execute a config and report the headline responses, plus the
H1 contrast harness (spec 7.4 X2, 7.6 V7, L8).

Required outputs: makespan, total cost, number of suite runs, number of merges.
The report also surfaces the critical-path lower bound, the cost breakdown and
any constraint violations, so a run is self-documenting.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass, replace
from typing import List, Optional, Sequence, Tuple

from .alpha import (
    REAL_AC_DISTRIBUTION,
    REAL_OPEN_BACKLOG,
    REAL_SPRINT_BATCH_MAX,
    REAL_SPRINT_BATCH_MIN,
    REAL_TICKET_KIND_MIX,
)
from .config import (
    DISPATCH_SCHEMA_TOKENS,
    LLM_COST_CLASSES,
    P_IN,
    TOOL_CALL_TOKENS,
    PipelineConfig,
)
from .distributions import MEASURED_COST_COMPOSITION
from .deps import format_convoy, format_publish_graph, measured_graph
from .engine import SimulationResult, run
from .events import (
    event_calibrated,
    format_event_report,
)

_COST_KEYS = ("tool", "dispatch", "op", "worktree", "merge", "branch", "bucket",
              "suite", "holding", "agent", "rework", "gate_rework", "spawn",
              "instruction")


def run_and_report(cfg: PipelineConfig) -> SimulationResult:
    """Run one realisation.  (Thin alias kept explicit for the README/harness.)"""
    return run(cfg)


def real_workload_note(cfg: PipelineConfig) -> str:
    """Plain-English framing of the ticket count against the real backlog.

    The simulator's ``M`` maps directly to a TICKET COUNT.  A sprint-sized
    batch is ~40-60 tickets; the operator's full open backlog is
    :data:`~pipeline_sim.alpha.REAL_OPEN_BACKLOG` (880).
    """
    m = cfg.M
    if m <= REAL_SPRINT_BATCH_MAX:
        return (f"sprint-sized batch ({REAL_SPRINT_BATCH_MIN}-"
                f"{REAL_SPRINT_BATCH_MAX}); the full open backlog is "
                f"{REAL_OPEN_BACKLOG} tickets")
    if m <= REAL_OPEN_BACKLOG:
        return f"part of the {REAL_OPEN_BACKLOG}-ticket open backlog"
    return f"beyond the real open backlog ({REAL_OPEN_BACKLOG} tickets)"


def format_ticket_mix() -> str:
    """The real ticket-kind mix (spec Appendix E) -- documented CONTEXT.

    The simulator treats tickets homogeneously (one work-per-ticket), so the
    mix explains why a real workload is bug-heavy rather than parameterising a
    per-kind cost the model does not have.
    """
    total = sum(REAL_TICKET_KIND_MIX.values())
    parts = ", ".join(
        f"{kind} {100.0 * share / total:.0f}%"
        for kind, share in REAL_TICKET_KIND_MIX.items()
    )
    return f"real ticket mix (context, not a cost axis): {parts}"


def format_ac_histogram(counts: Sequence[int]) -> str:
    """The REALISED per-ticket AC histogram (proves the 0-heavy distribution)."""
    from .alpha import AcDistribution

    n = len(counts)
    if n == 0:
        return "(no tickets)"
    h = AcDistribution.histogram(list(counts))
    zero = h.get(0, 0)
    parts = ", ".join(f"{k} AC x{v}" for k, v in sorted(h.items()))
    return f"{n - zero}/{n} tickets carry >0 ACs  [{parts}]"


def format_report(cfg: PipelineConfig, res: SimulationResult) -> str:
    lines: List[str] = []
    lines.append("=" * 68)
    lines.append("Pipeline simulation - deterministic run")
    lines.append("=" * 68)
    lines.append(
        f"workload   W_tot={cfg.W_tot:g} w={cfg.w:g}  ->  M={cfg.M} tickets, "
        f"n={cfg.n} buckets={res.graph.num_buckets}"
    )
    alpha_txt = "dist (0-heavy)" if cfg.uses_ac_distribution else str(cfg.alpha)
    lines.append(
        f"structure  branch_levels={res.branch_levels} "
        f"branch_fanout={cfg.branch_fanout} m={cfg.m} "
        f"test_level={res.test_level} test_exec={cfg.test_exec} alpha={alpha_txt}"
    )
    lines.append(f"tickets    {cfg.M} tickets  ({real_workload_note(cfg)})")
    lines.append(f"AC model   {cfg.ac_model_label()}")
    if getattr(cfg, "op_event_profiles", None):
        lines.append(
            "spend      EVENT-CALIBRATED: per-op cost/time from the real "
            "agent-event stream (agent-dashboard/public/events.json)"
        )
    lines.append(f"mix        {format_ticket_mix()}")
    counts = (res.graph.ac_counts if res.graph is not None
              else cfg.ac_counts())
    lines.append(f"AC realised {format_ac_histogram(counts)}")
    lines.append("-" * 68)
    lines.append(f"makespan            = {res.makespan:.3f}")
    lines.append(f"total cost          = {res.total_cost:.3f}")
    lines.append(f"# suite runs        = {res.num_suite_runs}")
    lines.append(f"# merges            = {res.num_merges}")
    lines.append(f"# dispatches        = {res.num_dispatches}")
    lines.append("-" * 68)
    lines.append(f"critical path (LB)  = {res.critical_path:.3f}"
                 f"   [makespan >= LB: {res.makespan + 1e-9 >= res.critical_path}]")
    lines.append(f"# worktrees         = {res.num_worktrees}")
    lines.append(f"# tasks             = {res.num_tasks}")
    lines.append(f"# agent spawns      = {res.spawns}")
    lines.append(f"risk f3             = {res.risk:.4f}"
                 f"   [blast_radius={res.blast_radius:.2f}"
                 f" conflict_rate={res.conflict_rate:.3f}"
                 f" deferral={res.deferral} rework_buckets={res.rework_buckets}]")
    lines.append(f"agent-seconds       = {res.agent_seconds:,.0f}")
    lines.append("cost breakdown:")
    for key in _COST_KEYS:
        lines.append(f"    {key:<12} = {res.cost_breakdown.get(key, 0.0):.3f}")
    lines.extend(_llm_composition_lines(res))
    lines.append(f"constraint checks   = "
                 f"{'OK' if not res.violations else str(len(res.violations)) + ' VIOLATION(S)'}")
    for v in res.violations:
        lines.append(f"    ! {v}")
    lines.append("=" * 68)
    return "\n".join(lines)


def _llm_composition_lines(res: SimulationResult) -> List[str]:
    """The measured input/output/reasoning/cache-read split of the LLM spend.

    The reference column is the operator's ``opencode.db`` composition by
    default; when the run is event-calibrated (``cfg.op_event_profiles``) it is
    the real agent-event stream's own composition, so the run is compared against
    the exact data that calibrated it.
    """
    classes = getattr(res, "llm_cost_classes", {}) or {}
    shares = getattr(res, "llm_cost_class_shares", {}) or {}
    cfg = getattr(res, "config", None)
    if getattr(cfg, "op_event_profiles", None):
        from .events import composition_rows
        reference = {r["class"]: 100.0 * r["share"]
                     for r in composition_rows()}
        ref_label = "event stream"
    else:
        reference = {k: 100.0 * v
                     for k, v in MEASURED_COST_COMPOSITION.items()}
        ref_label = "measured"
    out = ["LLM cost composition (share of LLM spend):"]
    for key in LLM_COST_CLASSES:
        usd = classes.get(key, 0.0)
        pct = 100.0 * shares.get(key, 0.0)
        out.append(
            f"    {key:<11} = {usd:8.4f}  {pct:5.1f}%   "
            f"({ref_label} {reference.get(key, 0.0):4.1f}%)"
        )
    return out


def format_measured_distributions() -> str:
    """Render the operator's measured distributions (spec Appendix C).

    Point estimates are replaced by p50/p90 so the ~30x run-to-run spread is
    visible; the model's ``c_dispatch`` / ``OC`` are calibrated to the medians.
    """
    from .distributions import MEASURED, MEASURED_TOTALS

    lines = ["=" * 68]
    lines.append("MEASURED DISTRIBUTIONS (operator opencode.db, 2026-10-05)")
    lines.append(
        f"  {MEASURED_TOTALS['model_steps']:,.0f} steps / "
        f"{MEASURED_TOTALS['dispatches']:,.0f} dispatches / "
        f"${MEASURED_TOTALS['total_cost_usd']:,.2f} over "
        f"{MEASURED_TOTALS['months']:g} months"
    )
    lines.append("-" * 68)
    lines.append(f"{'measurement':<34}{'p50':>10}{'p90':>10}{'max':>12}")
    for name, q in MEASURED.items():
        p90 = f"{q.p90:,.4g}" if q.p90 is not None else "-"
        mx = f"{q.maximum:,.4g}" if q.maximum is not None else "-"
        lines.append(f"{name:<34}{q.p50:>10,.4g}{p90:>10}{mx:>12}")
    lines.append("=" * 68)
    return "\n".join(lines)


def sweep_n(cfg: PipelineConfig, n_values: Sequence[int]) -> List[Tuple[int, SimulationResult]]:
    """Run the pipeline once per candidate bucket size."""
    out: List[Tuple[int, SimulationResult]] = []
    for n in n_values:
        if n < 1 or n > cfg.M:
            continue
        out.append((n, run(replace(cfg, n=n))))
    return out


def cost_optimal_n(cfg: PipelineConfig, n_values: Optional[Sequence[int]] = None
                   ) -> Tuple[int, SimulationResult, List[Tuple[int, SimulationResult]]]:
    """Return the ``n`` minimising total cost, its result, and the full sweep."""
    if n_values is None:
        n_values = range(1, cfg.M + 1)
    sweep = sweep_n(cfg, n_values)
    best_n, best = min(sweep, key=lambda kv: kv[1].total_cost)
    return best_n, best, sweep


def format_sweep(cfg: PipelineConfig, sweep: List[Tuple[int, SimulationResult]]) -> str:
    lines = ["   n   buckets   makespan      total_cost    suite_runs  merges"]
    best_n = min(sweep, key=lambda kv: kv[1].total_cost)[0]
    for n, r in sweep:
        marker = " *" if n == best_n else "  "
        lines.append(
            f"{n:4d}{marker} {r.graph.num_buckets:6d}   {r.makespan:9.3f}  "
            f"{r.total_cost:11.3f}   {r.num_suite_runs:8d}  {r.num_merges:6d}"
        )
    lines.append(f"   (* = cost-optimal bucket size n* = {best_n})")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# H1 contrast harness (spec 7.4 X2 / 7.6 V7 / L8)
# ---------------------------------------------------------------------------
@dataclass
class H1Contrast:
    """The paired H1 experiment: test-every-merge vs defer-to-top."""

    baseline: SimulationResult     # branch_levels=1, test_level=all
    deferred: SimulationResult     # branch_levels>1, test_level=top

    @property
    def cost_delta(self) -> float:
        """deferred - baseline (negative == deferral is cheaper)."""
        return self.deferred.total_cost - self.baseline.total_cost

    @property
    def makespan_delta(self) -> float:
        """deferred - baseline (negative == deferral is faster)."""
        return self.deferred.makespan - self.baseline.makespan

    @property
    def suite_runs_delta(self) -> int:
        """deferred - baseline (negative == deferral runs fewer suites)."""
        return self.deferred.num_suite_runs - self.baseline.num_suite_runs

    @property
    def mechanism_holds(self) -> bool:
        """V7: deferring tests must reduce the number of suite runs."""
        return self.suite_runs_delta < 0

    @property
    def h1_holds(self) -> bool:
        """L8/H1: deferral reduces BOTH total cost AND makespan."""
        return self.mechanism_holds and self.cost_delta < 0 and self.makespan_delta < 0


def run_h1_contrast(cfg: PipelineConfig, deferred_levels: int = 2) -> H1Contrast:
    """Run the H1 contrast (spec 7.4 X2).

    Arm A (baseline): ``branch_levels=1``, ``test_level="all"`` -- test at every
    merge, flat tree.  Arm B (deferred): ``branch_levels=deferred_levels>1``,
    ``test_level="top"`` -- postpone tests to top-level merges only.
    """
    if deferred_levels < 2:
        raise ValueError("deferred_levels must be >= 2 for the H1 contrast")
    baseline = run(replace(cfg, branch_levels=1, test_level="all"))
    deferred = run(replace(cfg, branch_levels=deferred_levels, test_level="top"))
    return H1Contrast(baseline=baseline, deferred=deferred)


def format_h1_contrast(c: H1Contrast) -> str:
    b, d = c.baseline, c.deferred
    lines: List[str] = []
    lines.append("=" * 68)
    lines.append("H1 CONTRAST (spec 7.4 X2 / 7.6 V7 / L8)")
    lines.append("  A baseline : branch_levels=1, test_level=all  (test every merge)")
    lines.append("  B deferred : branch_levels>1, test_level=top  (postpone to top)")
    lines.append("=" * 68)
    lines.append(f"{'response':<18}{'A baseline':>16}{'B deferred':>16}{'delta (B-A)':>16}")
    lines.append("-" * 68)
    lines.append(f"{'total cost':<18}{b.total_cost:>16.3f}{d.total_cost:>16.3f}"
                 f"{c.cost_delta:>+16.3f}")
    lines.append(f"{'makespan':<18}{b.makespan:>16.3f}{d.makespan:>16.3f}"
                 f"{c.makespan_delta:>+16.3f}")
    lines.append(f"{'# suite runs':<18}{b.num_suite_runs:>16d}{d.num_suite_runs:>16d}"
                 f"{c.suite_runs_delta:>+16d}")
    lines.append(f"{'# merges':<18}{b.num_merges:>16d}{d.num_merges:>16d}"
                 f"{d.num_merges - b.num_merges:>+16d}")
    lines.append(f"{'# dispatches':<18}{b.num_dispatches:>16d}{d.num_dispatches:>16d}"
                 f"{d.num_dispatches - b.num_dispatches:>+16d}")
    lines.append("-" * 68)
    lines.append(f"mechanism (V7: deferral reduces suite runs) = "
                 f"{'HOLDS' if c.mechanism_holds else 'FAILS'}")
    lines.append(f"cost delta sign                             = "
                 f"{'negative (cheaper)' if c.cost_delta < 0 else 'non-negative'}")
    lines.append(f"makespan delta sign                         = "
                 f"{'negative (faster)' if c.makespan_delta < 0 else 'non-negative'}")
    lines.append(f"H1 (L8: both cost and makespan decrease)    = "
                 f"{'HOLDS' if c.h1_holds else 'DOES NOT HOLD'}")
    for name, r in (("baseline", b), ("deferred", d)):
        if r.violations:
            lines.append(f"    ! {name} violations: {r.violations}")
    lines.append("=" * 68)
    return "\n".join(lines)


def _build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="pipeline_sim",
        description="Deterministic discrete-event simulation of an agentic "
                    "software-delivery pipeline.",
    )
    p.add_argument("--W-tot", type=float, default=PipelineConfig.W_tot)
    p.add_argument("--w", type=float, default=PipelineConfig.w)
    p.add_argument("--n", type=int, default=PipelineConfig.n)
    p.add_argument("--alpha", type=int, default=PipelineConfig.alpha,
                   help="AC per ticket for --ac-mode=uniform (fallback)")
    p.add_argument("--ac-mode", choices=["real", "uniform"], default="real",
                   help="Acceptance-criteria model (spec C4 revised): 'real' "
                        "(default) = the 0-heavy real-backlog distribution, "
                        "where the modal ticket has 0 ACs; 'uniform' = --alpha "
                        "for every ticket")
    p.add_argument("--branch", choices=["flat", "hierarchical", "serial"],
                   default=PipelineConfig.branch, help="LEGACY alias")
    p.add_argument("--branch-levels", type=int, default=PipelineConfig.branch_levels,
                   help="merge-tree depth (>=1); 1 = flat")
    p.add_argument("--branch-fanout", type=int, default=PipelineConfig.branch_fanout)
    p.add_argument("--test-level", default=PipelineConfig.test_level,
                   help="all | top | level:L  (spec C10/C18)")
    p.add_argument("--m", type=int, default=PipelineConfig.m)
    p.add_argument("--e", type=float, default=PipelineConfig.e)
    p.add_argument("--test-exec", choices=["full_suite", "affected_only"],
                   default=PipelineConfig.test_exec)
    p.add_argument("--t-dispatch", type=float, default=PipelineConfig.t_dispatch)
    p.add_argument("--t-suite", type=float, default=PipelineConfig.t_suite)
    # None -> use the model default at the chosen --price-basis (so the basis
    # switch is not silently clobbered by an argparse default).
    p.add_argument("--c-dispatch", type=float, default=None)
    p.add_argument("--c-suite", type=float, default=PipelineConfig.c_suite)
    p.add_argument("--c-a", type=float, default=PipelineConfig.c_a)
    p.add_argument("--OC", type=float, default=None)
    p.add_argument("--c-wt", type=float, default=PipelineConfig.c_wt)
    p.add_argument("--c-merge", type=float, default=PipelineConfig.c_merge)
    p.add_argument("--c-wip", type=float, default=PipelineConfig.c_wip)
    p.add_argument("--price-basis", choices=["off_peak", "peak"],
                   default=PipelineConfig.price_basis,
                   help="LLM price card: measured off-peak (default) or peak")
    p.add_argument("--deferred-levels", type=int, default=2,
                   help="branch_levels for the deferred arm of --h1-contrast")
    p.add_argument("--sweep-n", action="store_true",
                   help="sweep n over 1..M and report the cost-optimal size")
    p.add_argument("--h1-contrast", action="store_true",
                   help="run the H1 contrast harness (spec 7.4 X2)")
    p.add_argument("--publish-graph", action="store_true",
                   help="print the measured cross-component publish graph "
                        "(spec Appendix E.2): waves, critical path, chokepoints, "
                        "and the chokepoint convoys")
    p.add_argument("--events", action="store_true",
                   help="print the real agent-event spend calibration "
                        "(per-agent / per-task / per-event distributions + the "
                        "op -> real-agent mapping) and exit")
    p.add_argument("--event-calibrated", action="store_true",
                   help="drive the run's spend forecast from the real "
                        "agent-event profiles (replaces the Appendix-C "
                        "placeholders and each cold start)")
    p.add_argument("--event-unit", choices=["run", "event"], default="run",
                   help="event-calibration unit: 'run' (a real agent run, "
                        "default) or 'event' (the per-row marginal operation)")
    return p


def _config_from_args(args: argparse.Namespace) -> PipelineConfig:
    cfg = PipelineConfig(
        W_tot=args.W_tot, w=args.w, n=args.n, alpha=args.alpha,
        ac_distribution=(REAL_AC_DISTRIBUTION if args.ac_mode == "real" else None),
        branch=args.branch, branch_levels=args.branch_levels,
        branch_fanout=args.branch_fanout, test_level=args.test_level,
        m=args.m, e=args.e, test_exec=args.test_exec,
        t_dispatch=args.t_dispatch, t_suite=args.t_suite,
        c_suite=args.c_suite, c_a=args.c_a,
        c_wt=args.c_wt, c_merge=args.c_merge, c_wip=args.c_wip,
        price_basis=args.price_basis,
    )
    # The peak/off-peak switch re-derives every LLM term; explicit CLI overrides
    # for the two derived terms win over it.
    if args.price_basis != PipelineConfig.price_basis:
        cfg = cfg.repriced(args.price_basis)
    if args.c_dispatch is not None or args.OC is not None:
        p_in = cfg.prices()[0]
        cfg = replace(
            cfg,
            c_dispatch=(args.c_dispatch if args.c_dispatch is not None
                        else DISPATCH_SCHEMA_TOKENS * p_in),
            OC=(args.OC if args.OC is not None else TOOL_CALL_TOKENS * p_in),
        )
    return cfg


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = _build_parser().parse_args(argv)

    if args.events:
        print(format_event_report())
        return 0

    if args.publish_graph:
        graph = measured_graph()
        summary = graph.summary(chokepoint_limit=6)
        print(format_publish_graph(summary, chokepoint_limit=6))
        print()
        for name, _size in summary.chokepoints:
            print(format_convoy(graph.convoy(name)))
            print()
        return 0 if summary.acyclic else 1

    cfg = _config_from_args(args)
    if args.event_calibrated:
        cfg = event_calibrated(cfg, unit=args.event_unit)

    if args.h1_contrast:
        contrast = run_h1_contrast(cfg, deferred_levels=args.deferred_levels)
        print(format_h1_contrast(contrast))
        ok = contrast.mechanism_holds and not contrast.baseline.violations \
            and not contrast.deferred.violations
        return 0 if ok else 1

    if args.sweep_n:
        n_star, best, sweep = cost_optimal_n(cfg)
        print(format_sweep(cfg, sweep))
        print()
        print(format_report(replace(cfg, n=n_star), best))
        return 0 if not best.violations else 1

    res = run(cfg)
    print(format_report(cfg, res))
    print()
    if getattr(cfg, "op_event_profiles", None):
        print(format_event_report())
        print()
    print(format_measured_distributions())
    return 0 if not res.violations else 1
