"""Synthesis (spec §10.2 item 3) — explain EVERY option of an optimal
configuration, and its DELTAS against the PRIMARY (baseline).

Two deliverables, both here so they are testable without Streamlit:

* :func:`describe_config` — a labelled **Field / Value / What-it-means** table
  covering **every** knob (bucket size, work per ticket, AC target, branch
  depth, fan-out, test timing, test scope, agents, parallelizable buckets, plan
  placement, release gate, objective weights, ...), not just the branching
  config.  The "What it means" column is the plain-language role of the knob
  (and, where a count is derived, how it is derived).

* :func:`deltas_vs_primary` — the **% faster**, **% cheaper**, **% safer** and
  the **% overall** (weighted) change of a configuration against the PRIMARY
  baseline.  Lower cost / time / risk are all "better", so a positive delta is
  always an improvement; the overall figure is the weighted mean of the three
  relative improvements (spec §4 permits weighted scalarisation).

The PRIMARY is the baseline configuration (typically the first / current-practice
one); every discovered optimum is described against it.
"""

from __future__ import annotations

from dataclasses import replace
from typing import Dict, List, Optional, Sequence, Tuple

from .config import PipelineConfig
from .engine import SimulationResult
from .model import TaskGraph, build_task_graph

#: Human label for each ``test_level`` value.
_TEST_LEVEL_TEXT = {
    "all": "every merge (test as early as possible)",
    "top": "top-level merges only (defer to main)",
    "none": "no per-merge suite — a release gate is the only test",
}
_TEST_EXEC_TEXT = {
    "full_suite": "full accumulated suite (compounding)",
    "affected_only": "affected tests only (no compounding)",
}
_PLAN_TEXT = {
    "before_routing": "before routing (plan precedes the build; default)",
    "before_implement": "before implement (late plan — raises rework odds)",
}
_GATE_TEXT = {
    "off": "off",
    "branch": "on the branch (cheap remediation)",
    "main": "on main (needs a new branch — dearer remediation)",
}


def _test_level_text(test_level: str) -> str:
    if test_level.startswith("level:"):
        return f"merges of tier ≥ {test_level.split(':', 1)[1]} (partial deferral)"
    return _TEST_LEVEL_TEXT.get(test_level, test_level)


def _graph_of(cfg: PipelineConfig,
              res: Optional[SimulationResult]) -> TaskGraph:
    return res.graph if res is not None else build_task_graph(cfg)


def _fmt_usd(x: float) -> str:
    return f"${x:,.4f}" if abs(x) < 1 else f"${x:,.2f}"


def _ac_value_text(cfg: PipelineConfig) -> str:
    """The AC row's value: the scalar, or the 0-heavy distribution's shape."""
    dist = cfg.ac_distribution
    if dist is None:
        return f"{cfg.alpha}"
    return f"{dist.expected_ac:.2f} mean (0-heavy; modal 0)"


def describe_config(cfg: PipelineConfig,
                    res: Optional[SimulationResult] = None) -> List[Dict[str, str]]:
    """A Field / Value / What-it-means row for EVERY knob of ``cfg``.

    When ``res`` is supplied the run metrics (cost, end-to-end time, risk, peak
    bucket concurrency) are appended.  The table is the spec §10.2 item-3
    read-out: every design option, not just the branching one.
    """
    graph = _graph_of(cfg, res)
    cap = cfg.max_parallel_buckets
    expected_suites = len(graph.suite_nodes) + (1 if graph.gate_suite is not None else 0)
    rows: List[Tuple[str, str, str]] = [
        # --- workload / sizing ------------------------------------------
        ("Total workload (work units)", f"{cfg.W_tot:g}",
         "Abstract size dial — not hours or tokens."),
        ("Work per ticket", f"{cfg.w:g}",
         "Work units one ticket carries; M = workload ÷ work."),
        ("Tickets (M)", f"{cfg.M}",
         "Each ticket is its own work unit and merge-tree leaf."),
        ("Bucket size (tickets per bucket)", f"{cfg.n}",
         "Tickets planned and assigned together. A PLANNING unit, not a merge "
         "unit; larger buckets amortise the per-bucket setup but hold more WIP."),
        ("Buckets", f"{graph.num_buckets}",
         f"ceil(M / n) = ceil({cfg.M}/{cfg.n}); last bucket may be short."),
        ("AC per ticket (α)", _ac_value_text(cfg),
         "Acceptance criteria written and run per ticket; each compounds the "
         "suite, so more ACs raise test cost. Under the real (0-heavy) "
         "distribution the modal ticket has none."),
        # --- merge structure --------------------------------------------
        ("Branch depth (merge levels)", f"{cfg.resolved_branch_levels()}",
         "L1 leaf worktrees → … → main. Deeper trees defer tests to fewer, "
         "larger suites but pay more per-branch coordination."),
        ("Branch fan-out", f"{cfg.branch_fanout}",
         f"Branches merged together at each level."),
        ("Leaf worktrees (L1)", f"{cfg.M}", "One per ticket."),
        ("Merge nodes (worktrees)", f"{graph.num_merges}",
         "Every non-root merge-tree node is one worktree."),
        ("Top merges → main", f"{graph.num_main_merges}",
         "Merges that land on main (serialised, C16)."),
        # --- testing policy ---------------------------------------------
        ("When to test", _test_level_text(cfg.test_level),
         "Which merges trigger a suite run. Deferral runs fewer/cheaper suites "
         "but widens the blast radius (and, past a point, the gate's rework)."),
        ("Test scope", _TEST_EXEC_TEXT.get(cfg.test_exec, cfg.test_exec),
         "Whether a run exercises the whole accumulated suite or only the AC "
         "the merge introduces."),
        ("Expected suite runs", f"{expected_suites}",
         "Merge nodes selected by the test policy, plus any release gate."),
        # --- agents / concurrency ---------------------------------------
        ("Agents (m)", f"{cfg.m}",
         "Parallel workers. More agents buy time at a per-agent-second "
         "parallelism cost; the pool has an interior optimum."),
        ("Parallelizable buckets",
         "unlimited" if not cap else str(cap),
         "Cap on buckets in flight at once (0/None = unlimited)."),
        # --- operator topology ------------------------------------------
        ("Plan placement", _PLAN_TEXT.get(cfg.plan_position, cfg.plan_position),
         "Where the execution plan sits; a late plan raises implementation's "
         "rework odds (plan_rework_multiplier)."),
        ("Release gate", _GATE_TEXT.get(cfg.release_gate, cfg.release_gate),
         "A full suite run that may precede merge-to-main or sit on main; may "
         "be the only test run in the extreme."),
        # --- objective weights ------------------------------------------
        ("Objective weights (cost / time / risk)",
         f"{cfg.w1:g} / {cfg.w2:g} / {cfg.w3:g}",
         "Weights on the scalarisations used to rank and to combine the "
         "per-objective deltas into the overall figure."),
        # --- derived counts ---------------------------------------------
        ("Dispatches", f"{graph.num_dispatches}",
         "One fresh agent start per bucket (C17)."),
        ("Task instances", f"{len(graph.tasks)}",
         "Every task the engine instantiates for this configuration."),
    ]
    if res is not None:
        rows += [
            ("Cost ($)", _fmt_usd(res.total_cost),
             "Engine total for this configuration (compounding suite dominates)."),
            ("End-to-end time (s)", f"{res.makespan:,.0f}",
             "Makespan including dispatch, suite execution and all waits."),
            ("Risk (f3)", f"{res.risk:.4f}",
             f"Blast radius {res.blast_radius:.2f} × conflict "
             f"{res.conflict_rate:.3f} + expected rework."),
            ("Peak buckets in flight", f"{res.peak_parallel_buckets}",
             "Observed bucket concurrency in the run."),
        ]
    return [{"Field": f, "Value": v, "What it means": d} for f, v, d in rows]


# ---------------------------------------------------------------------------
# deltas vs the PRIMARY (baseline)
# ---------------------------------------------------------------------------
def _pct_improvement(primary_value: float, value: float) -> float:
    """Relative improvement in [−100, ∞); positive = the new value is lower.

    Cost / time / risk are all "lower is better", so ``(primary − value) /
    |primary| × 100``.  A zero primary contributes 0 (no baseline to improve on).
    """
    if primary_value == 0:
        return 0.0
    return (primary_value - value) / abs(primary_value) * 100.0


def deltas_vs_primary(primary: SimulationResult,
                      res: SimulationResult,
                      weights: Sequence[float] = (1.0, 1.0, 1.0)
                      ) -> Dict[str, float]:
    """% faster / % cheaper / % safer / % overall (weighted) vs ``primary``.

    The overall figure is the weight-averaged relative improvement across the
    three objectives (spec §4 permits weighted scalarisation); weights default
    to equal.  All three objectives are "lower is better", so every positive
    percentage is an improvement.
    """
    pct_time = _pct_improvement(primary.makespan, res.makespan)
    pct_cost = _pct_improvement(primary.total_cost, res.total_cost)
    pct_risk = _pct_improvement(primary.risk, res.risk)
    w_time, w_cost, w_risk = (float(w) for w in weights)
    denom = w_time + w_cost + w_risk
    overall = ((w_time * pct_time + w_cost * pct_cost + w_risk * pct_risk) / denom
               if denom > 0 else 0.0)
    return {
        "pct_faster": pct_time,
        "pct_cheaper": pct_cost,
        "pct_safer": pct_risk,
        "pct_overall": overall,
        "d_cost": res.total_cost - primary.total_cost,
        "d_makespan": res.makespan - primary.makespan,
        "d_risk": res.risk - primary.risk,
        "improved": overall > 1e-12,
    }


def format_deltas(d: Dict[str, float]) -> str:
    """One-line human rendering of :func:`deltas_vs_primary`."""
    return (f"{d['pct_faster']:+.1f}% faster · {d['pct_cheaper']:+.1f}% cheaper · "
            f"{d['pct_safer']:+.1f}% safer · {d['pct_overall']:+.1f}% overall")


def synthesis_table(primary_cfg: PipelineConfig,
                    records: Sequence[Tuple[str, PipelineConfig, SimulationResult]],
                    weights: Sequence[float] = (1.0, 1.0, 1.0)
                    ) -> List[Dict[str, object]]:
    """One row per variant: its deltas against the PRIMARY baseline.

    ``records`` is ``(label, cfg, res)`` triples; the entry whose ``cfg is
    primary_cfg`` (or the first entry when none matches) is the PRIMARY and is
    reported with zero deltas.  Every other row carries a full
    :func:`deltas_vs_primary`.  ``*_cfg``/``*_res`` are kept alongside the
    deltas so a caller can render each variant's knob table too.
    """
    primary = next((r for _, c, r in records if c is primary_cfg),
                   records[0][2] if records else None)
    if primary is None:
        return []
    out: List[Dict[str, object]] = []
    for label, cfg, res in records:
        d = deltas_vs_primary(primary, res, weights)
        out.append({
            "label": label,
            "cfg": cfg,
            "res": res,
            "is_primary": cfg is primary_cfg,
            **d,
            "summary": ("baseline" if cfg is primary_cfg else format_deltas(d)),
        })
    return out
