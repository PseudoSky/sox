"""Streamlit UI for the pipeline simulator -- a *task-flow* explorer, not a knob form.

The point of the model (spec 10.1) is to *explore* the design space and answer the
questions in spec §2, not to hand-set cryptic knobs.  This UI is built around three
plain-language ideas:

* **Design** -- the task flow (DAG) and its dependencies, edited directly: one row
  per task with an on/off toggle, a "Depends on" picker, a remove button and an
  **Edit** popup (cost + duration + dependencies).
* **Results** -- the discovered optimal configuration's *flow* plus a plain-language
  "what this variant suggests" read-out, and charts that each answer a named question.
* **Answers** -- the user's questions (spec §2 RQ1-RQ11) each with the numbers and a
  one-line conclusion.

Every cryptic symbol has been replaced by a plain-English label; the model is
untouched (this file only *reads* the package).  Advanced numeric parameters live
behind one collapsed **Advanced** expander with plain names and units.

Run::

    cd tools/pipeline-sim
    streamlit run app.py
"""

from __future__ import annotations

import logging
import math
import sys
from dataclasses import replace
from pathlib import Path

import streamlit as st

# Import the package whether it is pip-installed (editable) or only present
# under ./src -- so `streamlit run app.py` works from a clean checkout.
_HERE = Path(__file__).resolve().parent
_SRC = _HERE / "src"
if _SRC.is_dir() and str(_SRC) not in sys.path:
    sys.path.insert(0, str(_SRC))

import pandas as pd  # noqa: E402

from pipeline_sim.alpha import (  # noqa: E402
    REAL_AC_DISTRIBUTION,
    REAL_OPEN_BACKLOG,
    REAL_SPRINT_BATCH_MAX,
    REAL_SPRINT_BATCH_MIN,
)
from pipeline_sim.analytics import analytic_bucket_size  # noqa: E402
from pipeline_sim.config import (  # noqa: E402
    DISPATCH_SCHEMA_TOKENS,
    LLM_COST_CLASSES,
    P_IN,
    TOOL_CALL_TOKENS,
    PipelineConfig,
    TaskDurations,
    TaskOpCost,
)
from pipeline_sim.distributions import (  # noqa: E402
    MEASURED_COST_COMPOSITION,
    rows as measured_distribution_rows,
)
from pipeline_sim.deps import (  # noqa: E402
    MEASURED_GRAPH_SOURCE,
    PUBLISH_STAGE_FRAMING,
    format_convoy,
    measured_graph,
)
from pipeline_sim.events import (  # noqa: E402
    event_calibrated,
    source_available,
    format_agent_table as format_event_agent_table,
    format_distributions as format_event_distributions,
    format_op_table as format_event_op_table,
    format_provenance as format_event_provenance,
    format_task_table as format_event_task_table,
)
from pipeline_sim.engine import run  # noqa: E402
from pipeline_sim.instance import (  # noqa: E402
    build_instance_graph,
    instance_counts,
    instance_level_rows,
    instance_signature,
    instance_to_dot,
)
from pipeline_sim.explore import (  # noqa: E402
    SearchDomain,
    SweepPoint,
    pareto_front_cost_makespan,
    pareto_front_cost_risk,
    pareto_front_time_risk,
    run_sweep,
    valid_test_levels,
    weighted_score,
)
from pipeline_sim.harness import run_h1_contrast  # noqa: E402
from pipeline_sim.synthesis import (  # noqa: E402
    deltas_vs_primary,
    describe_config,
    format_deltas,
    synthesis_table,
)
from pipeline_sim.taskgraph import (  # noqa: E402
    DEFAULT_EDGES,
    TASK_TYPE_BY_ID,
    TaskType,
    catalogue_for,
    effective_active,
    expected_cost_per_item,
    llm_per_fire,
    occurrence_counts,
    type_map,
    validate_task_graph,
)

# ---------------------------------------------------------------------------
# plotting layer is optional (the `viz` extra).  Imported once, guarded, so the
# task-graph editor still works if matplotlib/plotly are absent.
# ---------------------------------------------------------------------------
_VIZ_ERROR: str | None = None
try:
    import plotly.graph_objects as go  # noqa: E402
    from plotly.subplots import make_subplots  # noqa: E402

    from pipeline_sim.plots import KIND_COLORS, _agent_utilisation  # noqa: E402
except ImportError as exc:  # pragma: no cover - exercised only without [viz]
    _VIZ_ERROR = str(exc)


C_BASE = "#d1495b"
C_DEFER = "#2e86ab"
C_GRID = "#b9b9b9"
C_FRONT = "#e07a5f"
C_OPT = "#111111"

TITLE = "pipeline-sim — design-space explorer"

logger = logging.getLogger("pipeline_sim.app")
# Ensure the app's own diagnostics are observable in the server log.  Streamlit
# configures only its own loggers; without a handler a bare logger drops INFO
# messages (Python's last-resort handler emits WARNING+ only), so the load/sweep
# diagnostics below would be invisible.  Idempotent and additive.
if not logger.handlers:
    _app_handler = logging.StreamHandler()
    _app_handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s: %(message)s")
    )
    logger.addHandler(_app_handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False

#: The editor starts from the *effective* default graph: the catalogue minus the
#: two optional gates, whose flags default off.
_DEFAULT_EFFECTIVE_ACTIVE: tuple[str, ...] = tuple(
    sorted(effective_active(PipelineConfig()))
)

# ===========================================================================
# plain-English labels (spec §3.1 / §3.4 symbols -> words)
# ===========================================================================
LABEL = {
    "W_tot": "Total workload (work units = tickets × work per ticket)",
    "n": "Bucket size (tickets per bucket)",
    "w": "Work per ticket",
    "alpha": "Acceptance criteria per ticket (uniform AC target)",
    "ac_distribution": "Real acceptance-criteria distribution (0-heavy, modal ticket = 0)",
    "branch_levels": "Branch depth (merge hierarchy levels)",
    "branch_fanout": "Branch fan-out",
    "test_level": "When to run the full suite",
    "test_exec": "Test scope",
    "m": "Number of agents",
    "max_parallel_buckets": "Parallelizable buckets",
    "T_active": "Enabled tasks",
    "P": "Dependencies",
    "cost": "Cost ($)",
    "makespan": "Time (end-to-end)",
    "risk": "Risk",
}

#: Plain-words tooltip for every knob / field the UI exposes.  ``st.*`` inputs
#: take ``help=HELP[key]`` so no field is ever left unexplained.
HELP = {
    "W_tot": (
        "Abstract units of work.  It is a size dial, and it maps directly to a "
        "TICKET COUNT: Tickets = Total workload ÷ Work per ticket.  A sprint "
        "batch is ~40-60 tickets; the real open backlog is 880.  At the "
        "defaults (600 ÷ 10) you get 60 tickets."
    ),
    "w": (
        "Work units carried by a single ticket.  Raising it means FEWER tickets "
        "(Tickets = Total workload ÷ Work per ticket), so each ticket is bigger."
    ),
    "alpha": (
        "Acceptance criteria written for each ticket in UNIFORM mode.  More "
        "criteria mean more test-writing and test-running work per ticket (and "
        "a bigger suite).  Ignored while the real 0-heavy distribution is on."
    ),
    "ac_distribution": (
        "Model per-ticket acceptance criteria as the REAL backlog's 0-heavy "
        "distribution instead of a uniform count: ~93% of real tickets carry "
        "ZERO acceptance criteria, and a ~7% tail carries ~3-5 (median 4), so "
        "the expected count is ~0.3 per ticket.  A 0-AC ticket generates no "
        "test-writing or test-running work at all.  When ON, the uniform AC "
        "target below is ignored."
    ),
    "n": (
        "How many tickets are planned and assigned together as one bucket.  A "
        "bucket is a PLANNING unit only -- it is not a merge unit and does not "
        "change the merge tree.  1 = one bucket per ticket."
    ),
    "branch_levels": (
        "Depth of the merge tree.  1 = flat: every ticket's work merges straight "
        "to main.  2+ = internal stages (L1 leaf worktrees → L2 → … → main), "
        "merged branch_fanout at a time."
    ),
    "branch_fanout": (
        "How many branches are merged together at each level: 2 = pairwise "
        "merges, 3 = three at a time, and so on."
    ),
    "test_level": (
        "Which merges trigger a full test-suite run: every merge, only "
        "top-level merges, or every merge from a given tier upward."
    ),
    "test_exec": (
        "How much of the suite runs: the full accumulated suite (compounding), "
        "or only the acceptance criteria the merge touched (affected only)."
    ),
    "m": (
        "Number of agents (workers) that may run tasks in parallel.  More agents "
        "shorten the end-to-end time but add a parallelism/carrying cost."
    ),
    "max_parallel_buckets": (
        "Maximum number of buckets allowed to be in flight at the same time -- an "
        "assignment-level concurrency cap.  0 = unlimited.  This is coarser than "
        "the agent count: it limits whole buckets, not individual tasks.  It is "
        "NOT a file-overlap bound (spec E.1): the real serializer is the "
        "component dependency (publish) graph."
    ),
    "w_cost": ("Objective weight on cost when ranking discovered configurations "
               "(ranking only; it never changes a simulation)."),
    "w_time": ("Objective weight on end-to-end time when ranking discovered "
               "configurations (ranking only)."),
    "w_risk": ("Objective weight on risk when ranking discovered configurations "
               "(ranking only)."),
    "adv_t_dispatch": "Fixed latency to start a fresh agent (one dispatch per bucket).",
    "adv_t_suite": "Fixed overhead to LAUNCH one suite run, before executing any AC.",
    "adv_e": "Seconds of test execution per acceptance criterion.",
    "adv_c_dispatch": "LLM cost of starting a fresh agent (system prompt + tool schemas), per dispatch.",
    "adv_c_suite": "Fixed CI cost of one suite run (the suite's launch).",
    "adv_c_a": "CI cost per acceptance criterion executed in a suite run.",
    "adv_c_wt": "CI cost of provisioning one git worktree / branch.",
    "adv_c_merge": "CI cost of one worktree merge + resolution.",
    "adv_c_main_build": "CI cost of one main build (per merge-to-main).",
    "adv_c_wip": "Carrying (holding) cost per bucket per unit time.",
    "adv_horizon": "Planning horizon used by the holding term (fixed input, not the realised makespan).",
    "adv_OC": "LLM cost of one tool call (the result payload).",
    "adv_c_agent": "Cost per agent per second of occupied time (parallelism cost).",
    "adv_p": "Probability that a bucket needs a rework pass (extra implement + reconfirm).",
    "adv_rho": "Blast-radius coefficient: how widely a change tends to affect other work.",
    "adv_file_regime": "File-conflict regime used for the conflict-rate estimate.",
    "adv_seed": "Random seed for the deterministic rework realisation (same seed = same draw).",
}

_TEST_LEVEL_PLAIN = {
    "all": "every merge",
    "top": "top level only",
}
_TEST_EXEC_PLAIN = {
    "full_suite": "full suite",
    "affected_only": "affected only",
}


def _plain_test_level(tl: str) -> str:
    if tl in _TEST_LEVEL_PLAIN:
        return _TEST_LEVEL_PLAIN[tl]
    if isinstance(tl, str) and tl.startswith("level:"):
        return f"from tier {tl.split(':', 1)[1]} up"
    return str(tl)


def _plain_test_exec(te: str) -> str:
    return _TEST_EXEC_PLAIN.get(te, str(te))


# ===========================================================================
# task-id -> config-table field (so Edit's duration / cost overrides reach the
# model through the *existing* dataclasses; the model itself is untouched)
# ===========================================================================
_TASK_DUR_FIELD = {
    "intake": "intake",
    "routing": "routing",
    "triage": "triage",
    "spec": "spec",
    "plan": "plan",
    "implement": "impl",
    "test_write": "test_write_per_ac",
    "review": "review",
    "review_routing": "review_routing",
    "wt_setup": "setup",
    "merge_resolve": "merge",
    "main_build": "main_build",
    "gates": "pre_release",
    "release": "release",
    "post_verify": "post_verify",
}
_TASK_COST_FIELD = {**_TASK_DUR_FIELD, "test_run": "test_run_per_ac"}


# ===========================================================================
# session state
# ===========================================================================
def _init_state() -> None:
    ss = st.session_state
    ss.setdefault("tg_active", list(_DEFAULT_EFFECTIVE_ACTIVE))
    ss.setdefault("tg_edges", list(DEFAULT_EDGES))
    ss.setdefault("tg_custom_text", "")     # custom task types (spec 3.6), one per line
    ss.setdefault("dep_gen", 0)             # bumps to reset dependency widgets
    ss.setdefault("ov_cost", {})            # task_id -> cost per fire (USD) override
    ss.setdefault("ov_dur", {})             # task_id -> duration (seconds) override
    ss.setdefault("ov_deps", {})            # task_id -> tuple(predicate task ids)
    ss.setdefault("results", None)          # list[SweepPoint]
    ss.setdefault("domain", None)           # SearchDomain used for `results`
    ss.setdefault("result_base", None)      # base PipelineConfig used
    ss.setdefault("scenario", None)         # (PipelineConfig, SimulationResult)
    ss.setdefault("sweep_skipped", 0)       # count of invalid/unschedulable combos
    ss.setdefault("sweep_skipped_samples", [])   # short reasons for the first few


def _parse_custom_types(text: str) -> tuple[TaskType, ...]:
    """Parse the custom-task-type editor (spec 3.6), one line per type.

    Format::

        id, label, scope, t_op, in_tok, out_tok, predecessors, successors, optional

    ``scope`` in ticket|ac|bucket|merge_node|worktree|global; predecessor/
    successor lists are ``|``-separated task ids.  Blank lines and ``#`` lines
    are ignored.  Malformed lines are skipped.
    """
    out: list[TaskType] = []
    for line in (text or "").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = [p.strip() for p in line.split(",")]
        if len(parts) < 4 or not parts[0]:
            continue
        pid, label, scope, t_op = parts[0], parts[1], parts[2], parts[3]

        def _int(i, d=0):
            try:
                return int(float(parts[i]))
            except (IndexError, ValueError):
                return d

        preds = tuple(p for p in (parts[6].split("|") if len(parts) > 6 else []) if p)
        succs = tuple(s for s in (parts[7].split("|") if len(parts) > 7 else []) if s)
        optional = len(parts) > 8 and parts[8].lower() in ("1", "true", "yes")
        try:
            t_op_f = float(t_op)
        except ValueError:
            t_op_f = 0.0
        out.append(TaskType(
            id=pid, label=label or pid, scope=scope, token_field="",
            t_op=t_op_f, in_tok=_int(4), out_tok=_int(5), tool_calls=0,
            default_predecessors=preds, default_successors=succs,
            optional=optional, custom=True, implemented=True,
            name=label or pid,
        ))
    return tuple(out)


def _custom_types() -> tuple[TaskType, ...]:
    try:
        return _parse_custom_types(st.session_state.get("tg_custom_text", ""))
    except Exception:  # noqa: BLE001 - a malformed line must never crash the app
        return ()


def _task_map() -> dict[str, TaskType]:
    """id -> TaskType over catalogue + custom types."""
    try:
        return {t.id: t for t in catalogue_for(PipelineConfig(custom_task_types=_custom_types()))}
    except Exception:  # noqa: BLE001
        return dict(TASK_TYPE_BY_ID)


def _current_spec():
    from pipeline_sim.taskgraph import TaskGraphSpec

    custom_ids = {ct.id for ct in _custom_types()}
    active = tuple(sorted(set(st.session_state.tg_active) | custom_ids))
    edges = tuple(st.session_state.tg_edges)
    return TaskGraphSpec(active=active, edges=edges)


def _preds_of(tid: str) -> list[str]:
    tmap = _task_map()
    return [a for (a, b) in st.session_state.tg_edges if b == tid and a in tmap]


def _apply_overrides(cfg: PipelineConfig) -> PipelineConfig:
    """Layer the Edit-dialog cost/duration overrides onto a config.

    Uses the *existing* ``TaskDurations`` / ``TaskOpCost`` dataclasses (the model
    is untouched).  The cost override is the Appendix-D per-fire figure; the
    operation-cost field stores the LLM part (per-fire minus the per-fire CI
    component, which the model charges separately), clamped at 0.
    """
    ss = st.session_state
    tmap = _task_map()
    durations = cfg.durations
    c_op = cfg.c_op
    for tid, secs in ss.get("ov_dur", {}).items():
        field = _TASK_DUR_FIELD.get(tid)
        if field:
            durations = replace(durations, **{field: float(secs)})
    for tid, per_fire in ss.get("ov_cost", {}).items():
        field = _TASK_COST_FIELD.get(tid)
        if field:
            ci = float(getattr(tmap.get(tid), "ci_per_fire", 0.0) or 0.0)
            c_op = replace(c_op, **{field: max(0.0, float(per_fire) - ci)})
    return replace(cfg, durations=durations, c_op=c_op)


def _base_cfg() -> PipelineConfig:
    """The scenario config: edited task graph + workload + Advanced parameters."""
    ss = st.session_state
    spec = _current_spec()
    cfg = PipelineConfig(
        # Default 600 (M=60): large enough that multi-level branching is a real
        # trade-off, so the discovered optima are interior rather than pinned to
        # a boundary (a 20-ticket workload does not warrant a deep tree -- the
        # model correctly says so, but it makes for an uninformative explorer).
        W_tot=float(ss.get("W_tot", 600.0)),
        w=float(ss.get("w", 10.0)),
        # spec C4 revised / Appendix E: the shipped app scenario uses the REAL
        # 0-heavy acceptance-criteria distribution (the modal ticket has 0 ACs)
        # unless the user turns it off for a uniform-alpha comparison.
        ac_distribution=(
            REAL_AC_DISTRIBUTION if ss.get("ac_distribution", True) else None
        ),
        T_active=spec.active,
        P=spec.edges,
        custom_task_types=_custom_types(),
        # Concurrency cap on buckets in flight (0 in the UI == unlimited).
        max_parallel_buckets=(
            int(ss.get("max_parallel_buckets", 0)) or None
        ),
        # Advanced (plain-named, unit-labelled) parameters
        t_dispatch=float(ss.get("adv_t_dispatch", 3.0)),
        t_suite=float(ss.get("adv_t_suite", 30.0)),
        e=float(ss.get("adv_e", 20.0)),
        c_dispatch=float(ss.get("adv_c_dispatch", DISPATCH_SCHEMA_TOKENS * P_IN)),
        c_suite=float(ss.get("adv_c_suite", 0.008)),
        c_a=float(ss.get("adv_c_a", 0.0027)),
        c_wt=float(ss.get("adv_c_wt", 0.003)),
        c_merge=float(ss.get("adv_c_merge", 0.016)),
        c_main_build=float(ss.get("adv_c_main_build", 0.040)),
        # First-order knob costs (spec §4 NOTE / OPEN-7).  These MUST come from
        # the model defaults: the old UI hard-coded c_wip=0.001 (a rounding
        # error next to c_agent), which switched the ∝n holding term off and
        # collapsed the bucket-size optimum to the largest bucket ("max out the
        # knob").  Defaulting them to PipelineConfig keeps the app's discovered
        # optima interior, as the model validates them.
        c_wip=float(ss.get("adv_c_wip", PipelineConfig.c_wip)),
        c_bucket=float(ss.get("adv_c_bucket", PipelineConfig.c_bucket)),
        c_branch=float(ss.get("adv_c_branch", PipelineConfig.c_branch)),
        c_level=float(ss.get("adv_c_level", PipelineConfig.c_level)),
        c_gate_rework_per_deferred_ac=float(
            ss.get("adv_c_gate_rework_per_deferred_ac",
                   PipelineConfig.c_gate_rework_per_deferred_ac)),
        horizon=float(ss.get("adv_horizon", 1.0)),
        OC=float(ss.get("adv_OC", TOOL_CALL_TOKENS * P_IN)),
        c_agent=float(ss.get("adv_c_agent", 0.00005)),
        p=float(ss.get("adv_p", 0.1)),
        rho=float(ss.get("adv_rho", 0.5)),
        file_regime=str(ss.get("adv_file_regime", "fragmented")),
        w1=float(ss.get("adv_w_cost", 1.0)),
        w2=float(ss.get("adv_w_time", 1.0)),
        w3=float(ss.get("adv_w_risk", 1.0)),
        seed=int(ss.get("adv_seed", 0)),
    )
    cfg = _apply_overrides(cfg)
    # OPTIONAL: drive the spend forecast from the real agent-event profiles
    # (per-op cost/time + cold start).  Off by default -> the model's shipped
    # calibration is unchanged; a pure additive overlay when on.
    if ss.get("event_calibrated", False):
        cfg = event_calibrated(cfg, unit=str(ss.get("event_unit", "run")))
    return cfg


# ===========================================================================
# small parsing / formatting helpers
# ===========================================================================
def _ints(text: str, fallback: tuple[int, ...], lo: int = 1) -> tuple[int, ...]:
    out: list[int] = []
    for tok in str(text).replace(" ", "").split(","):
        if not tok:
            continue
        try:
            v = int(tok)
        except ValueError:
            continue
        if v >= lo and v not in out:
            out.append(v)
    return tuple(out) if out else fallback


def _fmt_usd(x: float) -> str:
    return f"${x:,.4f}" if abs(x) < 1 else f"${x:,.2f}"


def _fmt_s(x: float) -> str:
    return f"{x:,.0f} s"


def _dot_label(text: str) -> str:
    return str(text).replace('"', "'")


def _per_fire(tmap: dict, tid: str, cfg: PipelineConfig | None = None) -> float:
    """Anticipated $/fire for a task, honouring the Edit-dialog override.

    When ``cfg`` is given the LLM component is read from ``cfg.c_op`` (so a
    calibrated config — e.g. the real agent-event spend — is reflected in the DAG
    cost preview); otherwise the shipped Appendix-D value is used.
    """
    t = tmap.get(tid)
    if t is None:
        return 0.0
    override = st.session_state.get("ov_cost", {}).get(tid)
    if override is not None:
        return float(override)
    if cfg is not None:
        ci = float(getattr(t, "ci_per_fire", 0.0) or 0.0)
        return llm_per_fire(cfg, t) + ci
    return float(getattr(t, "per_fire", 0.0) or 0.0)


def _dag_total(spec, cfg: PipelineConfig) -> float:
    """The DAG's anticipated total cost = Σ over nodes (occurrences × $/fire)."""
    try:
        counts = _occurrence_counts_cached(cfg, spec)
    except Exception:  # noqa: BLE001 - never crash the preview on a bad graph
        counts = {}
    tmap = type_map(cfg)
    return sum(counts.get(t.id, 0) * _per_fire(tmap, t.id, cfg)
               for t in catalogue_for(cfg) if t.id in spec.active_set())


def _topology_extra_edges(spec, cfg: PipelineConfig) -> list[tuple[str, str]]:
    """Type-level edges implied by operator-topology variants (spec 5.2).

    ``plan`` placement and the release gate live in the *engine* graph, not the
    catalogue's fixed edges, so the DAG preview adds them explicitly: the plan
    attaches before routing / before implement, and the release gate attaches a
    full suite run at ``gates``.
    """
    active = spec.active_set()
    extra: list[tuple[str, str]] = []
    if "plan" in active:
        if cfg.plan_position == "before_routing":
            extra += [("intake", "plan"), ("plan", "routing")]
        else:
            extra += [("routing", "plan"), ("plan", "implement"),
                      ("plan", "test_write")]
    if cfg.release_gate != "off":
        if cfg.release_gate == "branch":
            extra += [("test_run", "gates")]
        else:  # on main
            extra += [("main_build", "gates")]
    return [(a, b) for a, b in extra if a in active and b in active]


def _flow_dot(spec, cfg: PipelineConfig, *, vertical: bool = True,
              annotate: bool = False, diff_against=None,
              show_total: bool = False) -> str:
    """A Graphviz DOT rendering of the task flow.

    ``vertical`` orients it top-to-bottom (the requested DAG orientation);
    ``annotate`` adds each task's occurrence count, Appendix-D $/fire and the
    node's **anticipated cost** (occurrences × $/fire) -- the spec-10.2 cost
    preview; ``show_total`` prints the DAG total.  ``diff_against`` is a
    ``(primary_spec, primary_cfg)`` pair: nodes/edges absent from the primary
    are highlighted green (spec 10.2 variant comparison).
    """
    tmap = type_map(cfg)
    active = spec.active_set()
    try:
        counts = _occurrence_counts_cached(cfg, spec)
    except Exception:  # noqa: BLE001 - never crash the preview on a bad graph
        counts = {}
    primary_active = None
    primary_struct: set = set()
    extra_edges = _topology_extra_edges(spec, cfg)
    if diff_against is not None:
        pspec, pcfg = diff_against
        primary_active = pspec.active_set()
        primary_struct = set(pspec.effective_edges()) | set(
            _topology_extra_edges(pspec, pcfg))
    # every edge this DAG draws: fixed catalogue edges + variant-specific ones
    drawn_edges = list(spec.effective_edges()) + extra_edges
    changed_edges = {e for e in drawn_edges if e not in primary_struct} \
        if diff_against is not None else set()
    highlight_nodes: set = set()
    if diff_against is not None:
        highlight_nodes |= (spec.active_set() - primary_active)
        # the variant-anchor nodes whose placement changed (plan / release gate)
        if "plan" in spec.active_set() and cfg.plan_position != pcfg.plan_position:
            highlight_nodes.add("plan")
        if cfg.release_gate != pcfg.release_gate and cfg.release_gate != "off":
            highlight_nodes.add("gates")
    rankdir = "TB" if vertical else "LR"
    parts = [
        "digraph flow {",
        f'  rankdir="{rankdir}";',
        '  node [shape=box, style="rounded,filled", fontname="Helvetica",'
        ' fillcolor="#eef3f7", color="#7a9bb5", margin="0.13,0.07"];',
        '  edge [color="#9aa7b1"];',
    ]
    total = 0.0
    for t in catalogue_for(cfg):
        if t.id not in active:
            continue
        per_fire = _per_fire(tmap, t.id, cfg)
        occ = counts.get(t.id, 0)
        subtotal = per_fire * occ
        total += subtotal
        added = ((primary_active is not None and t.id not in primary_active)
                 or t.id in highlight_nodes)
        if t.custom:
            fill, border = "#e8f7ee", "#7fc79a"
        elif added:
            fill, border = "#d6f5de", "#1f9d55"        # ADDED vs primary
        elif not t.implemented:
            fill, border = "#fdf1e3", "#e0b980"
        elif t.optional:
            fill, border = "#f3e8ff", "#b98fdb"
        else:
            fill, border = "#eef3f7", "#7a9bb5"
        if annotate:
            label = (f"{t.display_name}\\n{occ:,}×  ${per_fire:.4f}/fire"
                     f"\\n= ${subtotal:.4f}")
        else:
            label = t.display_name
        parts.append(
            f'  "{t.id}" [label="{_dot_label(label)}", fillcolor="{fill}", color="{border}"];'
        )
    seen_edges: set = set()
    for a, b in drawn_edges:
        if (a, b) in seen_edges or a not in active or b not in active:
            continue
        seen_edges.add((a, b))
        if (a, b) in changed_edges:
            parts.append(f'  "{a}" -> "{b}" [color="#1f9d55", penwidth=1.8];')
        else:
            parts.append(f'  "{a}" -> "{b}";')
    if show_total:
        parts.append(
            f'  labelloc="t"; fontname="Helvetica"; labelfontsize=13;'
            f' label="DAG total ≈ ${total:.4f}   ({len(active)} tasks)";'
        )
    parts.append("}")
    return "\n".join(parts)


# ===========================================================================
# TAB 0 -- Design: task DAG (left, vertical) + dependency editor (right)
# ===========================================================================
def _remove_task(tid: str) -> None:
    """Delete a task from the working graph and drop every edge that touches it.

    The next render detects the graph changed (see ``_render_dependency_editor``)
    and re-keys the row widgets, so the deletion sticks across runs.
    """
    ss = st.session_state
    ss.tg_active = [x for x in ss.tg_active if x != tid]
    ss.tg_edges = [e for e in ss.tg_edges if tid not in e]


@st.dialog("Edit task — cost, duration & dependencies")
def _edit_task_dialog(tid: str) -> None:
    ss = st.session_state
    tmap = _task_map()
    t = tmap.get(tid)
    if t is None:
        st.error("Unknown task.")
        return
    st.markdown(f"#### {t.display_name}")

    ci = float(getattr(t, "ci_per_fire", 0.0) or 0.0)
    cur_cost = float(ss.get("ov_cost", {}).get(tid, t.per_fire))
    default_dur = _default_duration(tid)
    cur_dur = float(ss.get("ov_dur", {}).get(tid, default_dur))

    st.caption(
        "Figures are the Appendix-D planning values.  The model charges any CI "
        "component (suite / merge / main-build) separately, so the engine per-fire "
        "for CI tasks differs slightly from the total shown here."
    )
    cost = st.number_input(
        "Cost per fire ($)", min_value=0.0, value=cur_cost,
        step=0.0001, format="%.4f", key=f"edc_{tid}",
    )
    dur = st.number_input(
        "Duration (seconds)", min_value=0.0, value=cur_dur,
        step=1.0, key=f"edd_{tid}",
        help="Ignored for test runs, whose duration is the compounding suite.",
    )
    options = [o for o in tmap if o != tid]
    deps = st.multiselect(
        "Depends on (this task can only happen after…)",
        options=options, default=[p for p in _preds_of(tid) if p in options],
        format_func=lambda i: tmap[i].display_name, key=f"eddeps_{tid}",
    )

    c_apply, c_reset, _ = st.columns([1, 1, 3])
    if c_apply.button("Apply", type="primary", key=f"edapply_{tid}"):
        ov_cost = dict(ss.get("ov_cost", {}))
        ov_dur = dict(ss.get("ov_dur", {}))
        ov_deps = dict(ss.get("ov_deps", {}))
        ov_cost[tid] = float(cost)
        ov_dur[tid] = float(dur)
        ov_deps[tid] = tuple(deps)
        ss.ov_cost, ss.ov_dur, ss.ov_deps = ov_cost, ov_dur, ov_deps
        # rewire this task's incoming edges; the next render re-keys the row.
        ss.tg_edges = [e for e in ss.tg_edges if e[1] != tid] + [(p, tid) for p in deps]
        st.rerun()
    if c_reset.button("Reset to calibration", key=f"edreset_{tid}"):
        for d in ("ov_cost", "ov_dur", "ov_deps"):
            ss.get(d, {}).pop(tid, None)
        ss.tg_edges = ([e for e in ss.tg_edges if e[1] != tid]
                       + [(p, tid) for p in _default_preds_of(tid)])
        st.rerun()


def _default_duration(tid: str) -> float:
    field = _TASK_DUR_FIELD.get(tid)
    if not field:
        return 0.0
    d = TaskDurations()
    return float(getattr(d, field, 0.0))


def _default_preds_of(tid: str) -> list[str]:
    """Canvas-default predecessors of a task (catalogue edges + custom types)."""
    preds = [a for (a, b) in DEFAULT_EDGES if b == tid]
    for ct in _custom_types():
        if ct.id == tid:
            preds.extend(ct.default_predecessors)
    return preds


def _render_dependency_editor() -> None:
    ss = st.session_state
    st.markdown("#### Dependencies")
    st.caption(
        "Toggle a task on/off · choose what each task waits for · **✕** removes "
        "a task · **Edit** opens its cost & dependency editor."
    )
    tmap = _task_map()
    all_ids = list(tmap)

    # Detect an external change to the graph (a Remove click, an Edit-dialog
    # Apply, or an injected/session_state edit).  Re-keying the row widgets on
    # such a change makes the new state take effect instead of being masked by
    # the previous run's widget values.
    last = ss.get("_dep_written")
    if (last is None
            or list(ss.tg_active) != list(last[0])
            or list(ss.tg_edges) != list(last[1])):
        ss.dep_gen = int(ss.get("dep_gen", 0)) + 1
    gen = int(ss.get("dep_gen", 0))

    active = set(ss.tg_active) | {ct.id for ct in _custom_types()}

    row_enabled: dict[str, bool] = {}
    row_deps: dict[str, list[str]] = {}

    for tid in all_ids:
        t = tmap[tid]
        c = st.columns([0.5, 2.1, 3.0, 0.45, 0.7])
        enabled = c[0].toggle(
            "On", value=(tid in active), key=f"en_{tid}_{gen}",
            label_visibility="collapsed", help=f"Enable / disable {t.display_name}",
        )
        suffix = "" if (t.implemented or t.custom) else " · catalogue-only"
        c[1].markdown(f"**{t.display_name}**{suffix}")
        preds = _preds_of(tid)
        options = [o for o in all_ids if o != tid]
        sel = c[2].multiselect(
            "Depends on", options=options,
            default=[p for p in preds if p in options],
            key=f"dep_{tid}_{gen}",
            format_func=lambda i: tmap[i].display_name,
            label_visibility="collapsed", placeholder="starts immediately",
        )
        if c[3].button("✕", key=f"rm_{tid}", help=f"Remove {t.display_name} from the flow"):
            _remove_task(tid)
            st.rerun()
        if c[4].button("Edit", key=f"edit_{tid}", help=f"Edit cost & dependencies of {t.display_name}"):
            _edit_task_dialog(tid)
        row_enabled[tid] = bool(enabled)
        row_deps[tid] = [p for p in sel if p in tmap]

    # Rebuild the edge set from the rows.  Every task (enabled or not) keeps its
    # declared dependencies so a dormant edge survives a re-enable; the engine's
    # effective graph filters by the active set.
    new_edges: list[tuple[str, str]] = []
    for tid in all_ids:
        for p in row_deps[tid]:
            new_edges.append((p, tid))
    new_active = [tid for tid in all_ids if row_enabled[tid]]
    if new_edges != list(ss.tg_edges):
        ss.tg_edges = new_edges
    if set(new_active) != set(ss.tg_active):
        ss.tg_active = new_active
    # Record what this render wrote, so the next run can tell our own output
    # apart from an external change.
    ss["_dep_written"] = (list(ss.tg_active), list(ss.tg_edges))


def _render_dag_panel() -> None:
    ss = st.session_state
    st.markdown("#### Task flow (vertical) + cost preview")
    spec = _current_spec()
    cfg = _base_cfg()
    st.graphviz_chart(
        _flow_dot(spec, cfg, vertical=True, annotate=True, show_total=True),
        width="stretch",
    )
    st.caption(
        f"{len(spec.active)} enabled tasks · {len(spec.effective_edges())} dependencies · "
        "top-to-bottom = the order work must happen in.  Each node shows its "
        "occurrence count, $/fire and **anticipated cost** (occurrences × $/fire); "
        f"the DAG total is **{_fmt_usd(_dag_total(spec, cfg))}**."
    )


def _render_validation_panel() -> None:
    st.markdown("#### Validation")
    spec = _current_spec()
    report = _validate_cached(spec, _base_cfg())
    if report.ok:
        if report.warnings:
            st.success("Valid — the flow is acyclic (C19) and runnable.")
        else:
            st.success(
                "Valid — acyclic (C19) and every required dependency is present (C20)."
            )
    for e in report.errors:
        st.error(e)
    for w in report.warnings:
        st.warning(w)
    return report


def _render_cost_panel() -> None:
    st.markdown("#### Expected cost per task (Appendix-D planning roll-up)")
    try:
        cfg = _base_cfg()
        rep = _expected_cost_cached(cfg)
    except Exception as exc:  # noqa: BLE001 - surfaced to the user, not swallowed
        st.error(f"Could not compute expected cost: {exc}")
        return
    tmap = _task_map()
    rows = []
    for r in rep.rows:
        per_fire = r.per_fire
        if r.id in st.session_state.get("ov_cost", {}):
            per_fire = float(st.session_state.ov_cost[r.id])
        rows.append({
            "Task": r.label,
            "How often": r.scope,
            "$ per fire": per_fire,
            "Occurrences": r.occurrences if r.occurrences else 0,
            "Subtotal $": per_fire * (r.occurrences if r.occurrences else 0),
            "Simulated": "yes" if (tmap.get(r.id) and (tmap[r.id].implemented or tmap[r.id].custom)) else "costed only",
            "Enabled": r.occurrences > 0,
        })
    st.dataframe(
        pd.DataFrame(rows), width="stretch", hide_index=True,
        column_config={
            "$ per fire": st.column_config.NumberColumn(format="$%.4f"),
            "Subtotal $": st.column_config.NumberColumn(format="$%.4f"),
        },
    )
    m1, m2, m3, m4 = st.columns(4)
    m1.metric("Tickets (M)", cfg.M)
    m2.metric("Enabled tasks", len(_current_spec().active))
    m3.metric("Dependencies", len(_current_spec().effective_edges()))
    m4.metric("Expected cost", _fmt_usd(rep.total))
    st.caption(
        "Rows marked *costed only* are accounted for in the plan but not yet "
        "instantiated by the simulation engine.  Edit a row's cost/duration from "
        "the Dependencies panel above."
    )
    _render_measured_distributions()


def _render_measured_distributions() -> None:
    """The operator's measured distributions + LLM cost mix (spec App. C).

    Point estimates hide a ~30x run-to-run spread; p50/p90 do not.
    """
    with st.expander("Measured cost distributions (operator opencode.db, 2026-10-05)"):
        st.caption(
            "The model's point estimates are calibrated to these medians. "
            "Reasoning is billed at the output rate; cache-read at "
            "$0.003/M off-peak."
        )
        st.dataframe(
            pd.DataFrame(measured_distribution_rows()),
            width="stretch", hide_index=True,
        )
        st.markdown("**Measured LLM cost composition**")
        comp = pd.DataFrame([
            {"class": k, "measured share": 100.0 * MEASURED_COST_COMPOSITION.get(k, 0.0)}
            for k in LLM_COST_CLASSES
        ])
        st.dataframe(
            comp, width="stretch", hide_index=True,
            column_config={
                "measured share": st.column_config.NumberColumn(format="%.1f%%"),
            },
        )


def _render_custom_types_expander() -> None:
    with st.expander("Add custom task types (spec §3.6)"):
        st.text_area(
            "Custom task types",
            key="tg_custom_text",
            height=72,
            placeholder="e.g. security_scan, Security scan, ticket, 45, 4000, 1000, implement, test_run, true",
            label_visibility="collapsed",
        )
        st.caption(
            "One per line: `id, label, scope, t_op, in_tok, out_tok, "
            "predecessors|, successors|, optional`."
        )


def _render_publish_graph_panel() -> None:
    """The MEASURED cross-component publishing graph (spec Appendix E.2).

    This is the *real* serializer of a release.  Components publish in
    dependency order; a change republishes the changed component plus its
    transitive **dependents**; and the release is governed by the 6-wave
    critical path -- **not** by file overlap (spec E.1: the file-overlap graph
    is a citation artifact).
    """
    st.subheader("Publish graph — the measured cross-component structure")
    st.caption(
        "Spec Appendix E.2 (measured from `package.json` `workspace:` edges plus "
        "the Nx project graph).  A dependency edge (A depends on B) forces B to "
        "publish before A.  Parallelism = components except across dependency "
        "edges; a change's **publish set** = the changed component + its "
        "transitive dependents.  File overlap does **not** limit parallelism."
    )
    st.info("**Framing:** " + PUBLISH_STAGE_FRAMING)
    graph = measured_graph()
    summary = graph.summary(chokepoint_limit=6)

    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Components", summary.components)
    c2.metric("Dependency edges", summary.edges)
    c3.metric("Publish waves", len(summary.waves))
    c4.metric("Parallel width", summary.parallel_width)

    st.markdown(
        f"**Release critical path** ({summary.critical_path_length} nodes): "
        + " → ".join(f"`{n}`" for n in summary.critical_path)
    )
    st.caption(
        f"source: {MEASURED_GRAPH_SOURCE} · {summary.strict_edges} strict "
        f"changesets-cascade edges · strict cascade = {len(summary.strict_waves)} "
        f"waves · {'acyclic' if summary.acyclic else 'CYCLIC'}"
    )

    st.markdown("**Publish waves** (topological levels; each wave runs in parallel)")
    st.dataframe(
        pd.DataFrame([
            {"wave": i, "components": len(w), "publishes": ", ".join(w)}
            for i, w in enumerate(summary.waves)
        ]),
        use_container_width=True, hide_index=True,
    )

    choke_rows = []
    for name, size in summary.chokepoints:
        plan = graph.convoy(name)
        choke_rows.append({
            "chokepoint": name,
            "publish-set size": size,
            "downstream dependents": plan.dependents,
            "convoy stages": plan.depth,
        })
    st.markdown(
        "**Top chokepoints** — a change forces *publish-set size* publishes "
        "(the change + transitive dependents), serialized into *convoy stages*."
    )
    st.dataframe(pd.DataFrame(choke_rows), use_container_width=True, hide_index=True)

    for name, size in summary.chokepoints[:3]:
        plan = graph.convoy(name)
        with st.expander(f"Convoy — change `{name}` → {size} publishes over "
                         f"{plan.depth} stage(s)"):
            st.dataframe(
                pd.DataFrame([
                    {"stage": i, "publishes": ", ".join(w)}
                    for i, w in enumerate(plan.waves)
                ]),
                use_container_width=True, hide_index=True,
            )
            st.caption(format_convoy(plan).splitlines()[0])


def _render_event_calibration_panel() -> None:
    """The REAL agent-event spend calibration (agent-dashboard event stream).

    Read-only provenance of the per-agent / per-task / per-event distributions
    and the op -> real-agent mapping the *Calibrate spend to the real
    agent-event stream* toggle drives the forecast from.  Additive: it only
    *reads* the committed extraction snapshot.
    """
    st.subheader("Event-data calibration — the real agent spend")
    try:
        prov = format_event_provenance()
        op_tbl = format_event_op_table()
        agent_tbl = format_event_agent_table(limit=20)
        task_tbl = format_event_task_table(limit=12)
        dist_tbl = format_event_distributions()
    except Exception:  # noqa: BLE001 - a missing snapshot must not crash the page
        logger.exception("event-calibration panel failed to load")
        st.warning("The event-calibration snapshot could not be loaded.")
        return
    st.code(prov, language="text")
    on = bool(st.session_state.get("event_calibrated", False))
    unit = str(st.session_state.get("event_unit", "run"))
    if on:
        unit_label = "per agent run" if unit == "run" else "per event row"
        st.success(f"RUNS ARE EVENT-CALIBRATED — unit: **{unit}** ({unit_label}).")
    else:
        st.caption("Runs currently use the model's shipped calibration.  Enable "
                   "**Calibrate spend to the real agent-event stream** in the "
                   "sidebar's Advanced section to drive the forecast from this "
                   "data.")
    st.markdown("**Op → real agent(s)** — each operation's measured per-fire "
                "cost/time (mean of the mapped agents' real runs).")
    st.code(op_tbl, language="text")
    col_a, col_t = st.columns(2)
    with col_a:
        st.markdown("**Per-agent** (mean per real agent run)")
        st.code(agent_tbl, language="text")
    with col_t:
        st.markdown("**Per-task** (aggregate per task label)")
        st.code(task_tbl, language="text")
    with st.expander("Per-agent / per-task / per-event distributions (p50/p90/mean)"):
        st.code(dist_tbl, language="text")
    src = "present" if source_available() else "not on this machine"
    st.caption(f"Raw source: `agent-dashboard/public/events.json` ({src}); "
               f"the committed extraction snapshot is `events_snapshot.json`.")


def _render_design_tab() -> None:
    st.subheader("Design the flow")
    st.caption(
        "Left: the task flow, top-to-bottom.  Right: the dependency editor — one "
        "row per task.  The flow is validated live (acyclic dependencies; required "
        "ones present)."
    )
    col_dag, col_editor = st.columns([1.15, 1.15], gap="large")
    # Render the editor first (right column) so the DAG on the left reflects any
    # change made in this same run.
    with col_editor:
        _render_dependency_editor()
    with col_dag:
        _render_dag_panel()
    st.divider()
    rep_col, val_col = st.columns([1.4, 1])
    with val_col:
        _render_validation_panel()
        _render_custom_types_expander()
    with rep_col:
        _render_cost_panel()
    st.divider()
    _render_publish_graph_panel()
    st.divider()
    _render_event_calibration_panel()


# ===========================================================================
# SIDEBAR -- every design-space knob lives here (the main body has no knobs)
# ===========================================================================
def _base_for_domain(domain: SearchDomain) -> PipelineConfig:
    """The representative base config for a sweep domain (its first grid point).

    The domain's first value on each axis picks the realised structure the
    results refer back to (the engine itself is swept by :func:`run_sweep`).
    """
    base = _base_cfg()
    return replace(base, n=domain.ns[0], alpha=domain.alphas[0],
                   branch_levels=domain.branch_levels[0],
                   branch_fanout=domain.branch_fanouts[0],
                   test_level=domain.test_levels[0],
                   test_exec=domain.test_execs[0], m=domain.ms[0])


def _store_sweep(domain: SearchDomain, points: list[SweepPoint]) -> None:
    st.session_state.results = points
    st.session_state.domain = domain
    st.session_state.result_base = _base_for_domain(domain)


def _run_sweep_into_state(domain: SearchDomain) -> None:
    """Evaluate the whole design space and store the results dataset.

    Crash-proof by construction: ``run_sweep`` skips (and records) every
    invalid/unschedulable configuration rather than aborting, and the whole call
    is additionally guarded so even an unforeseen failure leaves the app alive
    (an empty result set, not a traceback).
    """
    base = _base_for_domain(domain)
    progress = st.progress(0.0, text="running the sweep…")
    total = domain.effective_size()
    logger.info("explicit full sweep requested: evaluating %d combinations", total)

    def _cb(i: int, n: int) -> None:
        progress.progress(min(1.0, i / max(n, 1)), text=f"running… {i}/{n}")

    skipped: list[tuple[PipelineConfig, str]] = []
    try:
        with st.spinner("Evaluating every combination…"):
            points = run_sweep(base, domain, progress=_cb, skipped=skipped)
    except Exception:  # noqa: BLE001 - the sweep must never crash the app
        logger.exception("the full sweep failed unexpectedly")
        progress.empty()
        st.error("The sweep failed unexpectedly and no results were stored — "
                 "see the log for the traceback. Nothing else was affected.")
        return
    progress.progress(1.0, text=f"done — {len(points)} feasible configurations")
    _store_sweep(domain, points)
    # Surface (never hide) what was dropped, so the numbers stay trustworthy.
    st.session_state.sweep_skipped = len(skipped)
    st.session_state.sweep_skipped_samples = [
        f"{reason}" for _cfg, reason in skipped[:5]
    ]


# NOTE: there is deliberately NO sweep-on-load here.  The old code ran the whole
# design space automatically on page load (~7 s for the 540-combination default
# domain) and could wedge/crash a fresh session.  The landing page now renders a
# small CURATED default set instead (:func:`_default_discovery`), and the FULL
# sweep runs ONLY when the user presses **Run the sweep** (see ``main``).


def _render_sidebar() -> SearchDomain:
    """Draw the whole control surface in the sidebar and return the domain.

    Every design-space knob -- bucket size, work per ticket, AC target, branch
    depth, branch fan-out, when to run the full suite, test scope, number of
    agents, the objective weights, and (behind the Advanced expander at the very
    bottom) the numeric parameters -- lives here.  The Scenario knobs live here
    too, so the main body carries no knob controls at all.
    """
    with st.sidebar:
        # ---- workload -------------------------------------------------
        st.header("Workload")
        st.number_input(LABEL["W_tot"], min_value=10.0, value=600.0,
                        step=10.0, key="W_tot", help=HELP["W_tot"])
        _m_now = int(round(st.session_state.W_tot /
                           (st.session_state.get("w", 10.0) or 10.0)))
        st.caption(
            f"**Tickets = {_m_now}**  → each becomes its own work unit and "
            f"merge-tree leaf.  (Sprint-sized batch is "
            f"{REAL_SPRINT_BATCH_MIN}-{REAL_SPRINT_BATCH_MAX}; the full open "
            f"backlog is {REAL_OPEN_BACKLOG}.)"
        )
        st.checkbox(LABEL["ac_distribution"], value=True, key="ac_distribution",
                    help=HELP["ac_distribution"])
        st.caption(
            "ON: " + REAL_AC_DISTRIBUTION.describe() + "."
        )

        # ---- design space ---------------------------------------------
        st.divider()
        st.header("Design space")
        st.caption("Give each knob a set of candidate values; **Run the sweep** "
                   "evaluates every combination.")

        # The default level sets are tuned to the INTERIOR design region (see the
        # curated default discovered set below): bucket sizes straddle sqrt(M)
        # for the default M=60 workload, branch depth is the flat/hierarchical
        # pair, and the test policy offers the full deferral spectrum so the H1
        # "partial deferral" question is answerable out of the box.
        ns = _ints(st.text_input(f"{LABEL['n']}", "3, 5, 8", key="dom_n",
                                 help=HELP["n"]), (3, 5, 8))
        st.number_input(f"{LABEL['w']}", min_value=1.0, value=10.0, step=1.0,
                        key="w", help=HELP["w"])
        # AC target: 2 is the realistic default (Appendix-D median); the list
        # still spans 1..3 so the cost-only AC response is visible on a Run.
        alphas = _ints(st.text_input(f"{LABEL['alpha']}", "1, 2, 3", key="dom_alpha",
                                     help=HELP["alpha"]), (1, 2, 3))
        levels = _ints(
            st.text_input(f"{LABEL['branch_levels']}", "1, 2",
                          key="dom_branch_levels", help=HELP["branch_levels"]),
            (1, 2),
        )
        fanouts = _ints(
            st.text_input(f"{LABEL['branch_fanout']}", "2",
                          key="dom_branch_fanout", help=HELP["branch_fanout"]),
            (2,),
        )
        tl_options = valid_test_levels(levels)
        test_levels = st.multiselect(
            LABEL["test_level"], options=tl_options,
            default=[t for t in ("all", "level:2", "top") if t in tl_options],
            format_func=_plain_test_level, key="dom_test_level",
            help=HELP["test_level"],
        )
        # Re-filter on EVERY render: shrinking the depth set shrinks the options,
        # and a value selected under the old set must not survive it (a stale
        # ``level:3`` with depth {1,2} is exactly the impossible combo that used
        # to reach the engine).  The domain is therefore valid by construction.
        test_levels = [t for t in test_levels if t in set(tl_options)]
        test_execs = st.multiselect(
            LABEL["test_exec"], options=["full_suite", "affected_only"],
            default=["full_suite"], format_func=_plain_test_exec, key="dom_test_exec",
            help=HELP["test_exec"],
        )
        ms = _ints(st.text_input(f"{LABEL['m']}", "2, 4, 8", key="dom_m",
                                 help=HELP["m"]), (2, 4, 8))
        if not test_levels:
            test_levels = ["all"]
        if not test_execs:
            test_execs = ["full_suite"]

        # A single-value knob (not a swept axis): the bucket concurrency cap.
        # Default 2 exercises the cap on the landing page (an INTERIOR, non-
        # trivial concurrency limit) rather than leaving it unlimited (0).
        st.number_input(
            LABEL["max_parallel_buckets"], min_value=0, max_value=1000, value=2,
            step=1, key="max_parallel_buckets", help=HELP["max_parallel_buckets"],
        )
        st.caption("0 = unlimited.  A cap serialises whole buckets (coarser than "
                   "the agent count, which caps individual tasks).")

        # ---- objective weights (ranking only) -------------------------
        st.divider()
        st.subheader("Objective weights")
        st.caption("Used only to rank and colour the discovered configurations.")
        st.number_input("Objective weight — cost", min_value=0.0, value=1.0, step=0.1,
                        key="adv_w_cost", help=HELP["w_cost"])
        st.number_input("Objective weight — time", min_value=0.0, value=1.0, step=0.1,
                        key="adv_w_time", help=HELP["w_time"])
        st.number_input("Objective weight — risk", min_value=0.0, value=1.0, step=0.1,
                        key="adv_w_risk", help=HELP["w_risk"])

        domain = SearchDomain(
            ns=ns, alphas=alphas, branch_levels=levels, branch_fanouts=fanouts,
            test_levels=tuple(test_levels), test_execs=tuple(test_execs), ms=ms,
            w1=float(st.session_state.get("adv_w_cost", 1.0)),
            w2=float(st.session_state.get("adv_w_time", 1.0)),
            w3=float(st.session_state.get("adv_w_risk", 1.0)),
        )

        # ---- run the sweep --------------------------------------------
        st.divider()
        raw_size = domain.size()
        eff_size = domain.effective_size()
        st.info(f"Design space: **{eff_size:,}** runnable combinations."
                + (f"  ({raw_size - eff_size:,} impossible `level:L` combos "
                   "excluded up front.)" if eff_size < raw_size else ""))
        if eff_size > 20000:
            st.warning("Large design space — the sweep is exhaustive and may take a while.")
        spec = _current_spec()
        try:
            report = _validate_cached(spec, _base_cfg())
            run_disabled = not report.ok
        except Exception:  # noqa: BLE001 - a broken graph must disable RUN, not crash the page
            logger.exception("task-graph validation failed while drawing the sidebar")
            report = None
            run_disabled = True
        if st.button("Run the sweep", key="run_sweep", type="primary", disabled=run_disabled):
            _run_sweep_into_state(domain)
        if run_disabled:
            st.error("Fix the flow errors (C19) in the **Design & dependencies** tab "
                     "before running.")
        elif st.session_state.results:
            st.success(
                f"{len(st.session_state.results)} results stored — see the **Discovered "
                "configurations** and **Results** tabs."
            )
        # An impossible/unschedulable combination is skipped, never fatal; say so
        # rather than dropping it silently.
        n_skip = int(st.session_state.get("sweep_skipped", 0) or 0)
        if n_skip:
            st.warning(f"{n_skip:,} of {raw_size:,} combinations were invalid or "
                       "unschedulable and were **skipped** (the sweep still ran).")
            samples = st.session_state.get("sweep_skipped_samples", [])
            if samples:
                with st.expander("Why some combinations were skipped"):
                    for s in samples:
                        st.caption(f"• {s}")

        # ---- scenario (one forced configuration) ----------------------
        with st.expander("Scenario — force one configuration"):
            # The scenario defaults describe the INTERIOR point this app was
            # tuned for: depth 2, a mid-range bucket size (5), ~2 ACs, pairwise
            # merges, PARTIAL test deferral (suite at tier >= 2), 4 agents.
            sc_levels = st.number_input(LABEL["branch_levels"], min_value=1, max_value=8,
                                        value=2, key="sc_levels", help=HELP["branch_levels"])
            st.number_input(LABEL["n"], min_value=1, max_value=1000, value=5,
                            key="sc_n", help=HELP["n"])
            st.number_input(LABEL["alpha"], min_value=1, max_value=20, value=2,
                            key="sc_alpha", help=HELP["alpha"])
            st.number_input(LABEL["branch_fanout"], min_value=2, max_value=10, value=2,
                            key="sc_fanout", help=HELP["branch_fanout"])
            _sc_tl_opts = valid_test_levels((int(sc_levels),))
            st.selectbox(
                LABEL["test_level"], _sc_tl_opts,
                index=(_sc_tl_opts.index("level:2") if "level:2" in _sc_tl_opts else 0),
                format_func=_plain_test_level, key="sc_tl", help=HELP["test_level"],
            )
            st.selectbox(LABEL["test_exec"], ["full_suite", "affected_only"],
                         format_func=_plain_test_exec, key="sc_te", help=HELP["test_exec"])
            st.number_input(LABEL["m"], min_value=1, max_value=200, value=4,
                            key="sc_m", help=HELP["m"])

        # ---- advanced numeric parameters (bottom of the sidebar) ------
        with st.expander("Advanced (numeric parameters — plain names + units)"):
            # Real agent-event spend calibration (additive; off by default).
            st.checkbox(
                "Calibrate spend to the real agent-event stream",
                key="event_calibrated",
                help="Replace the Appendix-C placeholder per-op token estimates "
                     "with the real per-agent profiles (and each agent's measured "
                     "cold-start system prompt) from the agent-dashboard event "
                     "stream.  See the **Design & dependencies** tab's "
                     "*Event-data calibration* panel.",
            )
            st.radio(
                "Calibration unit", ("run", "event"), key="event_unit",
                horizontal=True, format_func=lambda u: (
                    "per agent run" if u == "run" else "per event row"),
                help="'run' = one real agent run (default); 'event' = one "
                     "recorded event row (the finer marginal operation).",
            )
            st.divider()
            a1, a2, a3 = st.columns(3)
            a1.number_input("Fixed latency to start a fresh agent (s)", min_value=0.0,
                            value=3.0, step=1.0, key="adv_t_dispatch",
                            help=HELP["adv_t_dispatch"])
            a1.number_input("Suite launch overhead (s)", min_value=0.0,
                            value=30.0, step=5.0, key="adv_t_suite",
                            help=HELP["adv_t_suite"])
            a1.number_input("Test execution time per acceptance criterion (s)",
                            min_value=0.1, value=20.0, step=1.0, key="adv_e",
                            help=HELP["adv_e"])
            a1.number_input("Agent dispatch cost ($)", min_value=0.0,
                            value=DISPATCH_SCHEMA_TOKENS * P_IN,
                            step=0.0001, format="%.4f", key="adv_c_dispatch",
                            help=HELP["adv_c_dispatch"])
            a1.number_input("Suite base cost ($ per run)", min_value=0.0,
                            value=0.008, step=0.001, format="%.4f", key="adv_c_suite",
                            help=HELP["adv_c_suite"])
            a1.number_input("Test cost per acceptance criterion ($)", min_value=0.0,
                            value=0.0027, step=0.0001, format="%.4f", key="adv_c_a",
                            help=HELP["adv_c_a"])

            a2.number_input("Worktree setup cost ($)", min_value=0.0,
                            value=0.003, step=0.001, format="%.4f", key="adv_c_wt",
                            help=HELP["adv_c_wt"])
            a2.number_input("Merge cost ($)", min_value=0.0,
                            value=0.016, step=0.001, format="%.4f", key="adv_c_merge",
                            help=HELP["adv_c_merge"])
            a2.number_input("Main-build cost ($)", min_value=0.0,
                            value=0.040, step=0.001, format="%.4f", key="adv_c_main_build",
                            help=HELP["adv_c_main_build"])
            a2.number_input("Holding cost ($ per bucket per unit time)", min_value=0.0,
                            value=PipelineConfig.c_wip, step=0.05, format="%.4f",
                            key="adv_c_wip", help=HELP["adv_c_wip"])
            a2.number_input("Per-bucket setup cost ($)", min_value=0.0,
                            value=PipelineConfig.c_bucket, step=0.05, format="%.4f",
                            key="adv_c_bucket",
                            help="Per-bucket planning/assignment cost — the K of "
                                 "the sqrt(M) batch law.")
            a2.number_input("Planning horizon (time units)", min_value=0.1,
                            value=1.0, step=0.5, key="adv_horizon",
                            help=HELP["adv_horizon"])
            a2.number_input("Tool-call cost ($)", min_value=0.0,
                            value=TOOL_CALL_TOKENS * P_IN,
                            step=0.0001, format="%.4f", key="adv_OC",
                            help=HELP["adv_OC"])

            a3.number_input("Parallelism cost ($ per agent-second)", min_value=0.0,
                            value=0.00005, step=0.00001, format="%.5f", key="adv_c_agent",
                            help=HELP["adv_c_agent"])
            a3.number_input("Per-branch coordination ($ per work unit)", min_value=0.0,
                            value=PipelineConfig.c_branch, step=0.01, format="%.4f",
                            key="adv_c_branch",
                            help="Worktree + merge + coordination charged for every "
                                 "work unit a merge node integrates — gives depth an "
                                 "interior optimum.")
            a3.number_input("Per-branch × level ($ per unit per level)", min_value=0.0,
                            value=PipelineConfig.c_level, step=0.01, format="%.4f",
                            key="adv_c_level",
                            help="Extra coordination per work unit per merge tier — "
                                 "higher merges integrate larger subtrees.")
            a3.number_input("Gate remediation per deferred AC ($)", min_value=0.0,
                            value=PipelineConfig.c_gate_rework_per_deferred_ac,
                            step=0.002, format="%.4f",
                            key="adv_c_gate_rework_per_deferred_ac",
                            help="Release-gate rework that grows with deferral — a "
                                 "later, bigger gate resolves more issues at once, so "
                                 "deferral is not a free lunch.")
            a3.number_input("Rework probability (0-1)", min_value=0.0, max_value=1.0,
                            value=0.1, step=0.05, key="adv_p", help=HELP["adv_p"])
            a3.number_input("Blast-radius coefficient", min_value=0.0,
                            value=0.5, step=0.1, key="adv_rho", help=HELP["adv_rho"])
            a3.selectbox("File-conflict regime",
                         options=("no_edges", "fragmented", "one_component"),
                         index=1, key="adv_file_regime", help=HELP["adv_file_regime"])
            a3.number_input("Random seed", min_value=0, value=0, step=1, key="adv_seed",
                            help=HELP["adv_seed"])
    return domain


# ===========================================================================
# shared result helpers
# ===========================================================================
def _risk_of(p) -> float:
    return float(getattr(p, "risk", 0.0))


def _cfg_of_point(base: PipelineConfig, p: SweepPoint) -> PipelineConfig:
    return replace(base, n=p.n, alpha=p.alpha, branch_levels=p.branch_levels,
                   branch_fanout=p.branch_fanout, test_level=p.test_level,
                   test_exec=p.test_exec, m=p.m)


def _objective_weights() -> tuple[float, float, float]:
    """The current objective weights (cost, time, risk) from the sidebar."""
    ss = st.session_state
    return (float(ss.get("adv_w_cost", 1.0)),
            float(ss.get("adv_w_time", 1.0)),
            float(ss.get("adv_w_risk", 1.0)))


def _ranked_points(points: list[SweepPoint]) -> list[SweepPoint]:
    """The points sorted best-first by the weighted (cost, time, risk) score."""
    if not points:
        return []
    costs = [p.cost for p in points]
    ms = [p.makespan for p in points]
    risks = [_risk_of(p) for p in points]
    wc, wt, wr = _objective_weights()

    def norm(v: float, arr: list[float]) -> float:
        lo, hi = min(arr), max(arr)
        return 0.0 if hi <= lo else (v - lo) / (hi - lo)

    def score(p: SweepPoint) -> float:
        return (wc * norm(p.cost, costs) + wt * norm(p.makespan, ms)
                + wr * norm(_risk_of(p), risks))

    return sorted(points, key=score)


def _best_point(points: list[SweepPoint]) -> SweepPoint:
    """The point minimising the advanced-weighted (cost, time, risk) score."""
    return _ranked_points(points)[0]


def _run_quiet(cfg: PipelineConfig):
    """Run a config, returning ``None`` if it cannot be realised (never raise).

    ``ValueError`` is the engine's explicit "invalid / unschedulable" signal.
    Any other engine failure is logged and swallowed too: a single un-runnable
    variant must never take down a page or a chart.
    """
    try:
        cfg.validate()
        return run(cfg)
    except ValueError:
        return None
    except Exception:  # noqa: BLE001 - a bad variant must never crash the UI
        logger.exception("engine run failed for %r", cfg)
        return None


def _group_min(points: list[SweepPoint], attr: str, value_attr: str) -> dict:
    out: dict = {}
    for p in points:
        key = getattr(p, attr)
        v = getattr(p, value_attr)
        out[key] = min(out.get(key, v), v)
    return out


# ===========================================================================
# memoisation of the PURE, EXPENSIVE evaluations (rerun-leak fix)
#
# Every tab body executes on EVERY Streamlit rerun, so the landing page's
# variant comparison and the Answers/Results tabs were re-running the engine
# (``run`` -> ``build_task_graph``) and rebuilding the instance flow graphs on
# each rerun with unchanged inputs.  Those evaluations are pure functions of a
# :class:`PipelineConfig`, so the results are memoised on a STABLE signature --
# the config's dataclass ``repr`` (never ``id()``, time, or any per-rerun
# value).  The caches live in ``st.session_state`` (so a rerun reuses them) and
# are each bounded, so nothing accumulates without limit.
# ===========================================================================
#: Upper bound on every memo cache -- several times the largest set the app
#: evaluates in one render (curated set + structural variants + top points).
_CACHE_MAX_ENTRIES = 64

# Flip to True to log every cache miss that triggers an engine run.
_CACHE_DEBUG = False


def _cfg_key(cfg: PipelineConfig) -> str:
    """A STABLE signature for a config: its dataclass ``repr``.

    ``PipelineConfig`` is a frozen dataclass, so ``repr`` is deterministic over
    its fields and identical for equal configs -- unlike ``id()`` (changes per
    rerun) or ``hash`` (unavailable: the config carries dict fields).
    """
    return repr(cfg)


def _cache_bucket(name: str) -> dict:
    """The bounded ``st.session_state`` dict backing one memo cache."""
    ss = st.session_state
    bucket = ss.get(name)
    if not isinstance(bucket, dict):
        bucket = {}
        ss[name] = bucket
    return bucket


def _cache_store(bucket: dict, key, value) -> None:
    """Insert ``value`` and evict the oldest entries beyond the bound."""
    bucket[key] = value
    while len(bucket) > _CACHE_MAX_ENTRIES:
        bucket.pop(next(iter(bucket)))


def _run_cached(cfg: PipelineConfig):
    """``run`` memoised on ``repr(cfg)`` -- returns the same result per config.

    Equivalent to :func:`_run_quiet` (``None`` for an invalid config), but a
    rerun with an unchanged config reuses the prior evaluation instead of
    instantiating a fresh task graph + SimPy event set.  ``None`` is cached too,
    so a permanently-invalid variant is not retried on every rerun.
    """
    bucket = _cache_bucket("_run_cache")
    key = _cfg_key(cfg)
    if key in bucket:
        return bucket[key]
    if _CACHE_DEBUG:
        logger.info("run cache MISS: %s", key)
    result = _run_quiet(cfg)
    _cache_store(bucket, key, result)
    return result


def _instance_graph_cached(cfg: PipelineConfig, res, *, detail: str = "tasks"):
    """``build_instance_graph`` memoised on ``(repr(cfg), detail, has_res)``.

    The engine result passed for a config is always that config's deterministic
    run (:func:`_run_cached`), so the shape it produces is fully determined by
    ``(repr(cfg), detail)`` plus whether a run was supplied; the graph is a
    pure derivation and is safe to reuse unchanged across reruns.
    """
    bucket = _cache_bucket("_instance_graph_cache")
    key = (repr(cfg), detail, res is not None)
    if key in bucket:
        return bucket[key]
    ig = build_instance_graph(cfg, res, detail=detail)
    _cache_store(bucket, key, ig)
    return ig


def _evaluate_configs_cached(base: PipelineConfig, knobs) -> list[SweepPoint]:
    """``_evaluate_configs`` memoised on ``(repr(base), knobs)``."""
    bucket = _cache_bucket("_curated_cache")
    key = (repr(base), knobs)
    if key in bucket:
        return bucket[key]
    pts = _evaluate_configs(base, knobs)
    _cache_store(bucket, key, pts)
    return pts


def _h1_cached(base: PipelineConfig, deferred_levels: int):
    """``run_h1_contrast`` memoised on ``(repr(base), deferred_levels)``."""
    bucket = _cache_bucket("_h1_cache")
    key = (repr(base), int(deferred_levels))
    if key in bucket:
        return bucket[key]
    res = run_h1_contrast(base, deferred_levels=deferred_levels)
    _cache_store(bucket, key, res)
    return res


def _occurrence_counts_cached(cfg: PipelineConfig, spec):
    """``occurrence_counts`` memoised on ``(repr(cfg), repr(spec))``."""
    bucket = _cache_bucket("_occurrence_cache")
    key = (repr(cfg), repr(spec))
    if key in bucket:
        return bucket[key]
    counts = occurrence_counts(cfg, spec)
    _cache_store(bucket, key, counts)
    return counts


def _expected_cost_cached(cfg: PipelineConfig):
    """``expected_cost_per_item`` memoised on ``repr(cfg)``."""
    bucket = _cache_bucket("_expected_cost_cache")
    key = repr(cfg)
    if key in bucket:
        return bucket[key]
    rep = expected_cost_per_item(cfg)
    _cache_store(bucket, key, rep)
    return rep


def _validate_cached(spec, cfg: PipelineConfig):
    """``validate_task_graph`` memoised on ``(repr(cfg), repr(spec))``."""
    bucket = _cache_bucket("_validate_cache")
    key = (repr(cfg), repr(spec))
    if key in bucket:
        return bucket[key]
    rep = validate_task_graph(spec, cfg=cfg)
    _cache_store(bucket, key, rep)
    return rep


# ===========================================================================
# Instance-level flow (the REAL, instantiated graph -- not the type graph)
# ===========================================================================
def _render_instance_panel(cfg: PipelineConfig, res, *, key_prefix: str,
                           show_controls: bool = True) -> None:
    """Render the actual instantiated flow + the per-level "what happens here" panel.

    Nodes are the tasks the engine really creates (labelled by task and, when a
    run is supplied, the agent that ran it); branch/merge nodes are laid out by
    LEVEL.  The graph therefore shows the duplication (``M`` tickets → ``M``
    work units) and the branching (depth × fan-out) that the fixed type graph
    hides -- two different configs produce visibly different graphs.
    """
    st.markdown("#### Instance flow — the real, instantiated graph")
    st.caption(
        "The ACTUAL flow this configuration builds (not the fixed 16-box type "
        "graph): one node per task the engine instantiates, labelled by its task "
        "and (after a run) the agent that ran it, clustered by bucket.  Merge "
        "nodes are laid out by LEVEL — **L1** leaf worktrees (one per ticket) → "
        "**L2** → … → **main**."
    )
    colour_by, detail = "kind", "tasks"
    if show_controls:
        c1, c2 = st.columns(2)
        colour_choice = c1.radio(
            "Colour nodes by", ["task type", "branch level"],
            horizontal=True, key=f"{key_prefix}_colour",
            help="Colour each node by its task type, or by the merge/branch level it sits at.",
        )
        detail_choice = c2.radio(
            "Detail", ["every task (agents)", "compact (buckets & branches)"],
            horizontal=True, key=f"{key_prefix}_detail",
            help="Every task instance (the real flow, including agents) or a "
                 "compact schematic of buckets, tickets and branches.",
        )
        colour_by = "kind" if colour_choice.startswith("task") else "level"
        detail = "tasks" if detail_choice.startswith("every") else "structural"
    ig = _instance_graph_cached(cfg, res, detail=detail)
    st.graphviz_chart(instance_to_dot(ig, colour_by=colour_by), width="stretch")

    c = instance_counts(ig)
    m = st.columns(5)
    m[0].metric("Tickets", c.get("tickets"))
    m[1].metric("Buckets", c.get("buckets"))
    m[2].metric("Merge levels", c.get("levels"))
    m[3].metric("Worktrees", c.get("merge_nodes"))
    m[4].metric("Task instances", c.get("tasks"))

    st.markdown("##### What work happens at each branching level")
    st.dataframe(pd.DataFrame(instance_level_rows(ig)), hide_index=True,
                 width="stretch")
    cap = c.get("max_parallel_buckets")
    cap_txt = (f"bucket cap **{cap}** (peak observed {c.get('peak_parallel_buckets')})"
               if cap else f"buckets uncapped (peak observed {c.get('peak_parallel_buckets')})")
    st.caption(
        f"fan-out {c.get('fanout')} · {c.get('leaf_worktrees')} leaf worktrees (L1) · "
        f"{c.get('top_merges')} top merges → main · {c.get('suites')} suite runs · {cap_txt}"
    )


def _variant_field_rows(cfg: PipelineConfig, res) -> list[dict]:
    """The exact real-world configuration as a LABELLED FIELD TABLE.

    Every knob with its value plus the derived counts (tickets, buckets, branch
    depth/fan-out, agents, test policy, dispatches, suites, tasks) -- not prose.
    """
    ig = _instance_graph_cached(cfg, res, detail="structural")
    c = instance_counts(ig)
    cap = c.get("max_parallel_buckets")
    suite_runs = c.get("suite_runs_actual", c.get("suites"))
    rows: list[tuple] = [
        ("Total workload (work units)", f"{cfg.W_tot:g}",
         "Abstract size dial — not hours or tokens."),
        ("Work per ticket", f"{cfg.w:g}", "Work units one ticket carries."),
        ("Tickets (M = workload ÷ work)", f"{cfg.M}",
         "Each ticket becomes its own work unit and merge-tree leaf."),
        ("Bucket size (tickets per bucket)", f"{cfg.n}",
         "Tickets planned and assigned together — a planning unit, NOT a merge unit."),
        ("Buckets", f"{c.get('buckets')}",
         f"ceil(M / n); sizes {list(c.get('per_bucket') or [])}."),
        ("AC per ticket (α)", f"{cfg.alpha}", "Acceptance criteria written per ticket."),
        ("Branch depth (merge levels)", f"{c.get('levels')}",
         "L1 leaf worktrees → … → main."),
        ("Branch fan-out", f"{c.get('fanout')}", "Branches merged together at each level."),
        ("Leaf worktrees (L1)", f"{c.get('leaf_worktrees')}", "One per ticket."),
        ("Merge nodes (worktrees)", f"{c.get('merge_nodes')}",
         "Every non-root merge-tree node is one worktree."),
        ("Top merges → main", f"{c.get('top_merges')}",
         "Merges that land on main (serialised, C16)."),
        ("Agents (m)", f"{cfg.m}", "Parallel workers."),
        ("Parallelizable buckets", ("unlimited" if not cap else str(cap)),
         "Cap on buckets in flight at once (0 = unlimited)."),
        ("When to test", _plain_test_level(cfg.test_level),
         "Which merges trigger a full suite run."),
        ("Test scope", _plain_test_exec(cfg.test_exec),
         "Full accumulated suite vs affected-only."),
        ("Plan placement", cfg.plan_position.replace("_", " "),
         "Before routing (default) or before implement (raises rework odds)."),
        ("Release gate", cfg.release_gate, "off · branch · main."),
        ("Dispatches", f"{c.get('dispatches')}", "One fresh agent start per bucket (C17)."),
        ("Suite runs", f"{suite_runs}", "Runs selected by the test policy (+ any release gate)."),
        ("Task instances", f"{c.get('tasks')}", "Every task the engine instantiates."),
    ]
    if res is not None:
        rows += [
            ("Cost ($)", _fmt_usd(res.total_cost), "Engine total for this configuration."),
            ("End-to-end time", _fmt_s(res.makespan), "Makespan including all waits."),
            ("Risk", f"{res.risk:.3f}", "Blast-radius risk objective."),
            ("Peak buckets in flight", f"{res.peak_parallel_buckets}",
             "Observed bucket concurrency in the run."),
        ]
    return [{"Field": f, "Value": v, "What it means": d} for f, v, d in rows]


# ===========================================================================
# TAB 0 (landing) -- Discovered configurations
#
# The first page presents the configurations the sweep discovered -- the Pareto
# frontier plus the top performers -- as cards and tables, with the knobs that
# produced each one and its Cost / Time / Risk / Suite-run metrics.  Before any
# sweep has run there is no ``results`` dataset, so a modest **default** design
# space is evaluated once and cached; the landing page therefore shows real
# discovered configurations on first load instead of an empty editor.
# ===========================================================================
#: The curated default configurations shown on the landing page BEFORE any sweep.
#: A fixed handful (NOT a grid), each a single fast engine run (~15 ms), so first
#: paint costs ~0.15 s instead of the ~7 s / 540-combination exhaustive sweep the
#: app used to run automatically on load.
#:
#: WHY each axis sits where it does -- the goal is to exercise the INTERIOR
#: design region and exhibit a REAL trade rather than trivial/boundary results:
#:
#: * workload ``W_tot=600, w=10`` -> ``M = 60`` tickets: a realistic mid-size
#:   work item, and large enough that branching is a genuine trade-off (a
#:   20-ticket workload does not warrant a deep tree -- the model correctly says
#:   so, but it makes for an uninformative explorer).
#: * ``alpha=2`` -> ~2 acceptance criteria per ticket (the Appendix-D median).
#: * ``n in {3, 5, 8}`` -> brackets ``sqrt(M) = 7.7``, so the ~sqrt(M) batch-law
#:   optimum is INTERIOR; 5 is the mid-range default.  (The old default domain
#:   {2,4,8,10} put the answer on the bound -- "max out the knob".)
#: * ``branch_levels in {1, 2}`` -> flat vs the depth-2 hierarchical default.
#: * ``test_level all | level:2 | top`` -> the full deferral spectrum;
#:   ``level:2`` is PARTIAL deferral (suite at tier >= 2), the interior H1 point.
#: * ``m in {2, 4, 8}`` -> 4 agents is the default; 2 and 8 bracket the
#:   parallelism trade so the agent chart is not a single bar.
_CURATED_DEFAULT_KNOBS: tuple[tuple[int, int, int, int, str, str, int], ...] = (
    # (n, alpha, branch_levels, branch_fanout, test_level, test_exec, m)
    (5, 2, 2, 2, "level:2", "full_suite", 4),   # THE default: the interior point
    (5, 2, 2, 2, "all",     "full_suite", 4),   # test every merge (H1 baseline)
    (5, 2, 2, 2, "top",     "full_suite", 4),   # defer all the way to the top
    (3, 2, 2, 2, "level:2", "full_suite", 4),   # smaller buckets (setup-bound)
    (8, 2, 2, 2, "level:2", "full_suite", 4),   # larger buckets (holding-bound)
    (5, 2, 1, 2, "all",     "full_suite", 4),   # flat tree, test every merge
    (5, 2, 1, 2, "top",     "full_suite", 4),   # flat tree, defer to top
    (5, 2, 2, 2, "level:2", "full_suite", 2),   # fewer agents
    (5, 2, 2, 2, "level:2", "full_suite", 8),   # more agents
    (10, 2, 2, 2, "level:2", "full_suite", 4),  # very large buckets (boundary)
)


def _evaluate_configs(
    base: PipelineConfig,
    knobs: tuple[tuple[int, int, int, int, str, str, int], ...],
) -> list[SweepPoint]:
    """Evaluate an explicit list of knob tuples into :class:`SweepPoint` objects.

    Field-for-field compatible with :func:`pipeline_sim.explore.run_sweep`, so
    the points are interchangeable everywhere the sweep's output is consumed,
    but this evaluates a *fixed curated list* rather than a Cartesian domain.  A
    config the engine rejects for ANY reason (e.g. ``level:2`` on a flat depth-1
    tree, or an unschedulable bucket cap) is logged and skipped -- never fatal.
    """
    pts: list[SweepPoint] = []
    for (n, alpha, branch_levels, branch_fanout, test_level, test_exec, m) in knobs:
        try:
            cfg = replace(
                base, n=int(n), alpha=int(alpha),
                branch_levels=int(branch_levels), branch_fanout=int(branch_fanout),
                test_level=str(test_level), test_exec=str(test_exec), m=int(m),
            )
            res = _run_cached(cfg)
        except Exception as exc:  # noqa: BLE001 - one bad curated point is not fatal
            logger.warning("curated default skipped (n=%s L=%s %s): %s: %s",
                           n, branch_levels, test_level, type(exc).__name__, exc)
            continue
        busy: dict[int, float] = {}
        for r in res.records:
            busy[r.agent_id] = busy.get(r.agent_id, 0.0) + r.duration
        horizon = max(res.makespan, 1e-9)
        util = sum(busy.values()) / (res.config.m * horizon)
        pts.append(SweepPoint(
            index=len(pts), n=cfg.n, alpha=cfg.alpha,
            branch_levels=res.branch_levels, branch_fanout=cfg.branch_fanout,
            test_level=cfg.test_level, test_exec=cfg.test_exec, m=cfg.m,
            cost=res.total_cost, makespan=res.makespan, util=util,
            suite_runs=res.num_suite_runs, num_merges=res.num_merges,
            num_dispatches=res.num_dispatches, ok=not res.violations,
            risk=res.risk, violations=tuple(res.violations),
            breakdown=dict(res.cost_breakdown),
        ))
    return pts


_METRIC_COLUMN_CONFIG = {
    "Cost ($)": st.column_config.NumberColumn(format="$%.4f"),
    "Time (s)": st.column_config.NumberColumn(format="%.0f"),
    "Risk": st.column_config.NumberColumn(format="%.4f"),
}


def _default_discovery() -> list[SweepPoint]:
    """The curated default configurations for the landing page (cached per base).

    Evaluates :data:`_CURATED_DEFAULT_KNOBS` once and remembers the result keyed
    by the base config's ``repr``, so edits to the flow / workload / advanced
    parameters refresh it but ordinary reruns do not recompute it.  It never runs
    the full sweep and never raises -- a bad flow yields an empty, not a broken,
    page.
    """
    ss = st.session_state
    try:
        base = _base_cfg()
    except Exception:  # noqa: BLE001 - never let the landing page crash
        logger.exception("could not build the base config for the default set")
        return []
    sig = repr(base)
    cached = ss.get("discovered_default")
    if cached is not None and cached[0] == sig:
        return cached[1]
    logger.info(
        "landing: evaluating the curated default set (%d configurations); "
        "the full sweep runs only when the user presses 'Run the sweep'",
        len(_CURATED_DEFAULT_KNOBS),
    )
    try:
        pts = _evaluate_configs_cached(base, _CURATED_DEFAULT_KNOBS)
    except Exception:  # noqa: BLE001 - a bad flow yields an empty, not a broken, page
        logger.exception("curated default evaluation failed")
        pts = []
    ss.discovered_default = (sig, pts)
    return pts


def _points_for_discovery() -> tuple[list[SweepPoint], str]:
    """The configurations the landing page shows, and where they came from.

    ``"sweep"`` when the user has pressed **Run the sweep** and it populated
    ``results``; otherwise ``"default"`` for the small curated pre-sweep set
    (:func:`_default_discovery`) -- never the full sweep.
    """
    pts = st.session_state.get("results")
    if pts:
        return list(pts), "sweep"
    return _default_discovery(), "default"


def _knob_rows(points: list[SweepPoint], frontier_ids: set) -> list[dict]:
    """Rows for the configuration tables: knobs first, then metrics."""
    return [{
        "Bucket size": p.n,
        "AC target": p.alpha,
        "Branch depth": p.branch_levels,
        "Branch fan-out": p.branch_fanout,
        "When to test": _plain_test_level(p.test_level),
        "Test scope": _plain_test_exec(p.test_exec),
        "Agents": p.m,
        "Cost ($)": p.cost,
        "Time (s)": p.makespan,
        "Risk": _risk_of(p),
        "Suite runs": p.suite_runs,
        "Pareto": "★" if id(p) in frontier_ids else "",
    } for p in points]


def _render_discovered_tab() -> None:
    st.subheader("Discovered configurations")
    st.caption(
        "The dispatch configurations found so far — the Pareto frontier and the "
        "top performers — each with the knobs that produced it and its Cost, Time, "
        "Risk and Suite-run metrics.  On first load this is a small CURATED set "
        "that exercises the interior design region; press **Run the sweep** in the "
        "sidebar to evaluate your full design space.  At the bottom, each top "
        "variant is drawn as its ACTUAL **instance-level flow** side by side, so "
        "different configurations visibly differ."
    )

    points, source = _points_for_discovery()
    if not points:
        st.info(
            "No runnable configurations yet — the current task flow has errors.  Fix "
            "them in **Design & dependencies**, then press **Run the sweep** in the "
            "sidebar."
        )
        return

    base = st.session_state.get("result_base") or _base_cfg()
    if source == "sweep":
        domain = st.session_state.get("domain")
        size = domain.size() if domain else len(points)
        st.caption(
            f"{len(points)} feasible configurations discovered · design space "
            f"{size:,} · M = {base.M} tickets"
        )
    else:
        st.info(
            f"Showing **{len(points)} default-discovered configurations** from the "
            f"curated default set ({len(_CURATED_DEFAULT_KNOBS)} configurations, "
            "evaluated on load).  The full sweep does NOT run automatically — press "
            "**Run the sweep** in the sidebar to evaluate your own design space."
        )

    ranked = _ranked_points(points)
    best = ranked[0]
    cheapest = min(points, key=lambda p: p.cost)
    fastest = min(points, key=lambda p: p.makespan)
    lowest_risk = min(points, key=lambda p: _risk_of(p))

    m1, m2, m3, m4 = st.columns(4)
    m1.metric("Best overall cost", _fmt_usd(best.cost))
    m2.metric("Cheapest", _fmt_usd(cheapest.cost))
    m3.metric("Fastest", _fmt_s(fastest.makespan))
    m4.metric("Lowest risk", f"{_risk_of(lowest_risk):.3f}")

    st.markdown("#### Top performers")
    top = ranked[:4]
    cols = st.columns(len(top), gap="small")
    for col, p in zip(cols, top):
        with col:
            st.markdown(
                f"**#{p.index}** — bucket {p.n}, AC {p.alpha}, "
                f"depth {p.branch_levels}, fan-out {p.branch_fanout}  \n"
                f"tests {_plain_test_level(p.test_level)} · "
                f"{_plain_test_exec(p.test_exec)} · {p.m} agents"
            )
            c1, c2 = st.columns(2)
            c1.metric("Cost", _fmt_usd(p.cost))
            c2.metric("Time", _fmt_s(p.makespan))
            c3, c4 = st.columns(2)
            c3.metric("Risk", f"{_risk_of(p):.3f}")
            c4.metric("Suite runs", p.suite_runs)

    front = sorted(pareto_front_cost_makespan(points), key=lambda p: p.cost)
    frontier_ids = {id(p) for p in front}
    st.markdown(f"#### Pareto frontier — cost vs time ({len(front)} configuration(s))")
    st.dataframe(
        pd.DataFrame(_knob_rows(front, frontier_ids)),
        hide_index=True, width="stretch",
        column_config=_METRIC_COLUMN_CONFIG,
    )

    shown = ranked[:10]
    st.markdown(f"#### Top performers (ranked, showing {len(shown)})")
    st.dataframe(
        pd.DataFrame(_knob_rows(shown, frontier_ids)),
        hide_index=True, width="stretch",
        column_config=_METRIC_COLUMN_CONFIG,
    )

    if not _VIZ_ERROR and len(points) > 1:
        st.markdown("#### Frontier at a glance")
        st.plotly_chart(_fig_cost_time(points, best), key="fig_discovered")

    st.divider()
    _render_variant_comparison(base, points)

    st.caption(
        "This is discovery output.  The task-flow and dependency editor is on the "
        "**Design & dependencies** tab."
    )


# ===========================================================================
# charts (each tied to a named question; every one carries its takeaway)
# ===========================================================================
def _fig_cost_time(points: list[SweepPoint], highlight: SweepPoint | None = None) -> go.Figure:
    fig = go.Figure()
    fig.add_trace(go.Scatter(
        x=[p.cost for p in points], y=[p.makespan for p in points],
        mode="markers", name="configurations",
        marker=dict(size=8, color=C_GRID, opacity=0.7,
                    line=dict(color="#777", width=0.4)),
        customdata=[[p.n, p.alpha, p.branch_levels, _plain_test_level(p.test_level), p.m]
                    for p in points],
        hovertemplate=("bucket %{customdata[0]} · AC %{customdata[1]} · "
                       "depth %{customdata[2]} · test %{customdata[3]} · agents %{customdata[4]}"
                       "<br>cost $%{x:.4f} · time %{y:,.0f}s<extra></extra>"),
    ))
    front = pareto_front_cost_makespan(points)
    front = sorted(front, key=lambda p: p.cost)
    fig.add_trace(go.Scatter(
        x=[p.cost for p in front], y=[p.makespan for p in front],
        mode="lines+markers", name=f"best trade-offs ({len(front)})",
        line=dict(color=C_FRONT, width=2.5),
        marker=dict(size=13, symbol="star", color=C_FRONT,
                    line=dict(color="#333", width=0.6)),
    ))
    if highlight is not None:
        fig.add_trace(go.Scatter(
            x=[highlight.cost], y=[highlight.makespan], mode="markers",
            name="discovered optimum",
            marker=dict(size=18, symbol="x", color=C_OPT),
        ))
    fig.update_layout(
        template="plotly_white", height=430,
        xaxis_title=LABEL["cost"], yaxis_title=f"{LABEL['makespan']} (seconds)",
        title="Q1/Q9/Q10 — cost vs end-to-end time",
    )
    return fig


def _fig_h1(points: list[SweepPoint]) -> go.Figure:
    groups = sorted({(p.branch_levels, p.test_level) for p in points})
    labels = [f"depth {lv} · test {_plain_test_level(tl)}" for lv, tl in groups]
    cost = [min(p.cost for p in points if p.branch_levels == lv and p.test_level == tl)
            for lv, tl in groups]
    ms = [min(p.makespan for p in points if p.branch_levels == lv and p.test_level == tl)
          for lv, tl in groups]
    fig = make_subplots(specs=[[{"secondary_y": True}]])
    fig.add_trace(go.Bar(x=labels, y=cost, name=LABEL["cost"], marker_color=C_DEFER),
                  secondary_y=False)
    fig.add_trace(go.Scatter(x=labels, y=ms, name=LABEL["makespan"], mode="lines+markers",
                             marker=dict(color=C_BASE, size=10)), secondary_y=True)
    fig.update_yaxes(title_text=LABEL["cost"], secondary_y=False)
    fig.update_yaxes(title_text=f"{LABEL['makespan']} (s)", secondary_y=True)
    fig.update_layout(template="plotly_white", height=430,
                      title="Q4/Q9 — when to test & branch depth (H1)",
                      xaxis_tickangle=-25, legend=dict(orientation="h"))
    return fig


def _fig_bucket(points: list[SweepPoint], M: int) -> go.Figure:
    ns = sorted({p.n for p in points})
    cost = [_group_min([p for p in points if p.n == n], "n", "cost")[n] for n in ns]
    fig = go.Figure()
    fig.add_trace(go.Scatter(x=ns, y=cost, mode="lines+markers", name="min cost",
                             line=dict(color=C_BASE, width=2.5), marker=dict(size=10)))
    sqrt_m = math.sqrt(M) if M > 0 else 0.0
    if sqrt_m:
        fig.add_vline(x=sqrt_m, line_dash="dash", line_color=C_DEFER,
                      annotation_text=f"√M = {sqrt_m:.1f}", annotation_position="top")
    fig.update_layout(template="plotly_white", height=400,
                      xaxis_title=LABEL["n"], yaxis_title=LABEL["cost"],
                      title="Q1/Q5 — bucket size vs cost (is it ~√M?)")
    return fig


def _fig_alpha(points: list[SweepPoint]) -> go.Figure:
    alphas = sorted({p.alpha for p in points})
    cost = [_group_min([p for p in points if p.alpha == a], "alpha", "cost")[a] for a in alphas]
    fig = go.Figure(go.Bar(x=[str(a) for a in alphas], y=cost, marker_color=C_DEFER,
                           text=[_fmt_usd(c) for c in cost], textposition="auto"))
    fig.update_layout(template="plotly_white", height=400,
                      xaxis_title=LABEL["alpha"], yaxis_title=LABEL["cost"],
                      title="Q3 — acceptance-criteria target vs cost")
    return fig


def _fig_agents(points: list[SweepPoint]) -> go.Figure:
    ms = sorted({p.m for p in points})
    cost = [_group_min([p for p in points if p.m == m], "m", "cost")[m] for m in ms]
    makespan = [_group_min([p for p in points if p.m == m], "m", "makespan")[m] for m in ms]
    fig = make_subplots(specs=[[{"secondary_y": True}]])
    fig.add_trace(go.Bar(x=[str(m) for m in ms], y=cost, name=LABEL["cost"],
                         marker_color=C_DEFER), secondary_y=False)
    fig.add_trace(go.Scatter(x=[str(m) for m in ms], y=makespan, name=LABEL["makespan"],
                             mode="lines+markers", marker=dict(color=C_BASE, size=10)),
                  secondary_y=True)
    fig.update_yaxes(title_text=LABEL["cost"], secondary_y=False)
    fig.update_yaxes(title_text=f"{LABEL['makespan']} (s)", secondary_y=True)
    fig.update_layout(template="plotly_white", height=400,
                      xaxis_title=LABEL["m"], title="Q8 — number of agents vs cost & time")
    return fig


def _fig_tradeoffs(points: list[SweepPoint]) -> go.Figure:
    fig = make_subplots(rows=1, cols=2,
                        subplot_titles=("cost vs risk", "time vs risk"))
    cr = sorted(pareto_front_cost_risk(points), key=lambda p: p.cost)
    tr = sorted(pareto_front_time_risk(points), key=lambda p: p.makespan)
    fig.add_trace(go.Scatter(x=[p.cost for p in points], y=[_risk_of(p) for p in points],
                             mode="markers", name="configurations",
                             marker=dict(size=7, color=C_GRID, opacity=0.7)), row=1, col=1)
    fig.add_trace(go.Scatter(x=[p.cost for p in cr], y=[_risk_of(p) for p in cr],
                             mode="lines+markers", name=f"front ({len(cr)})",
                             line=dict(color=C_FRONT, width=2.5)), row=1, col=1)
    fig.add_trace(go.Scatter(x=[p.makespan for p in points], y=[_risk_of(p) for p in points],
                             mode="markers", name="configurations", showlegend=False,
                             marker=dict(size=7, color=C_GRID, opacity=0.7)), row=1, col=2)
    fig.add_trace(go.Scatter(x=[p.makespan for p in tr], y=[_risk_of(p) for p in tr],
                             mode="lines+markers", name=f"front ({len(tr)})",
                             line=dict(color=C_FRONT, width=2.5)), row=1, col=2)
    fig.update_xaxes(title_text=LABEL["cost"], row=1, col=1)
    fig.update_yaxes(title_text=LABEL["risk"], row=1, col=1)
    fig.update_xaxes(title_text=f"{LABEL['makespan']} (s)", row=1, col=2)
    fig.update_yaxes(title_text=LABEL["risk"], row=1, col=2)
    fig.update_layout(template="plotly_white", height=430,
                      title="Q10 — objective trade-offs (Pareto surfaces)")
    return fig


def _fig_gantt(res) -> go.Figure:
    agents, util = _agent_utilisation(res)
    kinds = sorted({r.kind for r in res.records},
                   key=lambda k: list(KIND_COLORS).index(k) if k in KIND_COLORS else 99)
    fig = make_subplots(rows=2, cols=1, row_heights=[0.72, 0.28], vertical_spacing=0.13,
                        subplot_titles=("task timeline per agent", "agent utilisation"))
    for kind in kinds:
        recs = [r for r in res.records if r.kind == kind]
        fig.add_trace(go.Bar(
            y=[f"agent {r.agent_id}" for r in recs],
            x=[max(r.duration, 1e-6) for r in recs],
            base=[r.start for r in recs], orientation="h", name=kind,
            marker_color=KIND_COLORS.get(kind, "#999"),
            customdata=[[r.start, r.finish] for r in recs],
            hovertemplate="start=%{customdata[0]:,.0f}s finish=%{customdata[1]:,.0f}s"
                          "<extra>" + kind + "</extra>"), row=1, col=1)
    fig.add_trace(go.Bar(x=[f"agent {a}" for a in agents], y=util, name="utilisation",
                         marker_color=C_DEFER, showlegend=False,
                         hovertemplate="%{x}<br>%{y:.1%}<extra></extra>"), row=2, col=1)
    fig.update_yaxes(autorange="reversed", row=1, col=1)
    fig.update_xaxes(title_text="time (s)", row=1, col=1)
    fig.update_yaxes(title_text="busy / makespan", range=[0, 1.05], row=2, col=1)
    fig.update_layout(barmode="overlay", template="plotly_white", height=650)
    return fig


# ===========================================================================
# Variant comparison (spec §10.2 item 2): top INSTANCE flows side by side
# ===========================================================================
def _structural_variants(base: PipelineConfig) -> list[tuple[str, PipelineConfig]]:
    """DAG variants that differ structurally from the primary (baseline) graph.

    These exercise the operator-topology variants of spec §5.2 -- ``plan``
    placement, the release gate, deferring the suite, and the optional gates --
    so their DAGs differ in tasks and/or edges, which the comparison highlights.
    """
    out: list[tuple[str, PipelineConfig]] = [("Primary (baseline)", base)]
    if base.plan_position != "before_implement":
        out.append(("Plan before implement (↑ rework odds)",
                    replace(base, plan_position="before_implement")))
    if base.release_gate != "branch":
        out.append(("Release gate on branch",
                    replace(base, release_gate="branch")))
    if base.release_gate != "main":
        out.append(("Release gate on main (new-branch remediation)",
                    replace(base, release_gate="main")))
    levels = max(2, base.resolved_branch_levels())
    if base.test_level != "top" or base.resolved_branch_levels() < 2:
        out.append((f"Defer tests to top (depth {levels})",
                    replace(base, branch_levels=levels, test_level="top")))
    if not (base.y_triage or base.y_spec) and base.T_active is not None:
        out.append(("Add triage + spec gates",
                    replace(base,
                            T_active=tuple(sorted(set(base.T_active) | {"triage", "spec"})),
                            P=DEFAULT_EDGES)))
    return out


def _diff_summary(pspec, pcfg: PipelineConfig,
                  spec, cfg: PipelineConfig) -> str:
    """Human-readable differences of a variant DAG from the primary DAG."""
    pa, sa = pspec.active_set(), spec.active_set()
    pe, se = set(pspec.effective_edges()), set(spec.effective_edges())
    bits: list[str] = []
    added_n = sorted(sa - pa)
    removed_n = sorted(pa - sa)
    added_e = sorted(se - pe)
    removed_e = sorted(pe - se)
    if added_n:
        bits.append("+ tasks: " + ", ".join(added_n))
    if removed_n:
        bits.append("− tasks: " + ", ".join(removed_n))
    if added_e:
        bits.append("+ edges: " + ", ".join(f"{a}→{b}" for a, b in added_e))
    if removed_e:
        bits.append("− edges: " + ", ".join(f"{a}→{b}" for a, b in removed_e))
    knobs = []
    for attr in ("plan_position", "release_gate", "test_level",
                 "branch_levels", "branch_fanout", "n", "alpha", "m"):
        pv, sv = getattr(pcfg, attr, None), getattr(cfg, attr, None)
        if pv != sv:
            knobs.append(f"{attr}: {pv}→{sv}")
    if knobs:
        bits.append(" · ".join(knobs))
    return "  \n".join(bits)


def _render_variant_comparison(base: PipelineConfig, points) -> None:
    """Render the top variants as INSTANCE-level flows side by side (spec 10.2).

    The old comparison drew the *fixed type graph*, so every variant looked
    identical.  Each column now draws the ACTUAL instantiated flow for that
    configuration, so bucket count, merge depth/fan-out and the selected suite
    nodes make the graphs visibly different.
    """
    st.markdown("#### Variant comparison — top INSTANCE flows, side by side")
    st.caption(
        "Each column is the ACTUAL flow a configuration instantiates — nodes are "
        "tasks (labelled by task and, after a run, the agent that ran it), "
        "clustered by bucket, with merge levels **L1 → L2 → … → main**.  Different "
        "configs produce visibly different graphs: bucket count, merge depth and "
        "fan-out all change the shape."
    )
    primary_res = _run_cached(base)
    primary_sig = (instance_signature(_instance_graph_cached(base, primary_res))
                   if primary_res is not None else None)

    candidates = _structural_variants(base)
    if points:
        best = _best_point(points)
        nearest = sorted(points, key=lambda p: (abs(p.cost - best.cost)
                                                + abs(p.makespan - best.makespan)))[:3]
        for p in nearest:
            candidates.append((
                f"Discovered #{p.index}: n={p.n} α={p.alpha} L={p.branch_levels} "
                f"{_plain_test_level(p.test_level)} m={p.m}",
                _cfg_of_point(base, p),
            ))

    # Evaluate every candidate variant once.
    evaluated: list[tuple[str, PipelineConfig, object]] = []
    seen: set = set()
    for label, cfg in candidates:
        key = (cfg.T_active, cfg.P, cfg.plan_position, cfg.release_gate,
               cfg.test_level, cfg.branch_levels, cfg.branch_fanout,
               cfg.n, cfg.alpha, cfg.m, cfg.y_triage, cfg.y_spec)
        if key in seen:
            continue
        seen.add(key)
        res = _run_cached(cfg)
        if res is None:
            continue
        evaluated.append((label, cfg, res))

    # Rank the non-primary variants by the same weighted (cost, time, risk) score.
    others = [e for e in evaluated if e[1] is not base]
    if others:
        costs = [e[2].total_cost for e in others] + ([primary_res.total_cost] if primary_res else [])
        times = [e[2].makespan for e in others] + ([primary_res.makespan] if primary_res else [])
        risks = [e[2].risk for e in others] + ([primary_res.risk] if primary_res else [])

        def _norm(v, arr):
            lo, hi = min(arr), max(arr)
            return 0.0 if hi <= lo else (v - lo) / (hi - lo)

        wc = float(st.session_state.get("adv_w_cost", 1.0))
        wt = float(st.session_state.get("adv_w_time", 1.0))
        wr = float(st.session_state.get("adv_w_risk", 1.0))
        others.sort(key=lambda e: (wc * _norm(e[2].total_cost, costs)
                                   + wt * _norm(e[2].makespan, times)
                                   + wr * _norm(e[2].risk, risks)))

    shown: list[tuple[str, PipelineConfig, object]] = []
    if primary_res is not None:
        shown.append(("Primary (baseline)", base, primary_res))
    shown += others[:max(0, 3)]
    if not shown:
        st.info("No runnable variants for the current flow.")
        return

    cols = st.columns(len(shown), gap="small")
    for col, (label, cfg, res) in zip(cols, shown):
        with col:
            st.markdown(f"**{label}**")
            ig = _instance_graph_cached(cfg, res, detail="tasks")
            st.graphviz_chart(instance_to_dot(ig, colour_by="kind"),
                              width="stretch")
            c = instance_counts(ig)
            st.markdown(
                f"Cost **{_fmt_usd(res.total_cost)}**  \n"
                f"Time **{_fmt_s(res.makespan)}**  \n"
                f"Risk **{res.risk:.3f}**  \n"
                f"Suite runs **{res.num_suite_runs}**"
            )
            same = (primary_sig is not None
                    and instance_signature(ig) == primary_sig)
            st.caption(
                f"shape: {'same as primary' if same else 'DIFFERS from primary'} · "
                f"{c.get('buckets')} buckets · {c.get('merge_nodes')} merge nodes · "
                f"{c.get('levels')} levels · fan-out {c.get('fanout')} · "
                f"{c.get('suites')} suites · {c.get('tasks')} tasks"
            )
            diff = _diff_summary(base.resolve_task_graph(), base,
                                 cfg.resolve_task_graph(), cfg)
            if diff:
                st.caption(diff)


def _variant_records(base: PipelineConfig, points, limit: int = 6):
    """``(label, cfg, res)`` records for the primary + top-ranked variants."""
    primary_res = _run_cached(base)
    if primary_res is None:
        return []
    records: list[tuple[str, PipelineConfig, object]] = [
        ("Primary (baseline)", base, primary_res)]
    seen: set = set()
    for p in _ranked_points(points)[:limit]:
        key = (p.n, p.alpha, p.branch_levels, p.branch_fanout,
               p.test_level, p.test_exec, p.m)
        if key in seen:
            continue
        seen.add(key)
        cfg = _cfg_of_point(base, p)
        r = _run_cached(cfg)
        if r is not None:
            records.append((p.label(), cfg, r))
    return records


def _render_synthesis_section(base: PipelineConfig, points, cfg_opt,
                              res_opt) -> None:
    """Synthesis v2 (spec §10.2 item 3): for the discovered optimum, explain
    EVERY knob (Field / Value / What-it-means) and show the DELTAS vs the
    PRIMARY baseline (% faster / cheaper / safer / overall)."""
    st.markdown("#### Synthesis — every knob, and the deltas vs the primary")
    st.caption(
        "For the discovered optimum: **every** design option (bucket size, work "
        "per ticket, AC target, branch depth/fan-out, test timing/scope, agents, "
        "parallelizable buckets, plan placement, release gate, objective "
        "weights) with its value and plain-language meaning — plus the change "
        "against the PRIMARY (baseline), where positive always means better."
    )
    records = _variant_records(base, points)
    if not records or res_opt is None:
        st.info("Run the sweep to populate the synthesis.")
        return
    primary_res = records[0][2]
    w = _objective_weights()

    left, right = st.columns([1.3, 1], gap="large")
    with left:
        st.markdown("**Every option for the discovered optimum**")
        st.dataframe(pd.DataFrame(describe_config(cfg_opt, res_opt)),
                     hide_index=True, width="stretch")
    with right:
        st.markdown("**Deltas vs the PRIMARY (baseline)**")
        d = deltas_vs_primary(primary_res, res_opt, w)
        m1, m2 = st.columns(2)
        m1.metric("% faster", f"{d['pct_faster']:+.1f}%")
        m2.metric("% cheaper", f"{d['pct_cheaper']:+.1f}%")
        m3, m4 = st.columns(2)
        m3.metric("% safer", f"{d['pct_safer']:+.1f}%")
        m4.metric("% overall", f"{d['pct_overall']:+.1f}%")
        st.caption(f"**{format_deltas(d)}**  \n"
                   "Positive = better (cost, time and risk all lower-is-better). "
                   "Overall is the weighted mean of the three, using the sidebar "
                   "objective weights.")

        st.markdown("**Every optimal configuration vs the primary**")
        table = synthesis_table(base, records, w)
        st.dataframe(
            pd.DataFrame([{
                "Configuration": t["label"],
                "% faster": f"{t['pct_faster']:+.1f}%",
                "% cheaper": f"{t['pct_cheaper']:+.1f}%",
                "% safer": f"{t['pct_safer']:+.1f}%",
                "% overall": f"{t['pct_overall']:+.1f}%",
            } for t in table]),
            hide_index=True, width="stretch",
        )


# ===========================================================================
# TAB 2 -- Results: the discovered optimum + question-tied charts
# ===========================================================================
def _render_results_tab() -> None:
    st.subheader("Results — what the sweep discovered")
    if _VIZ_ERROR:
        st.warning(f"Charts need the `viz` extra: {_VIZ_ERROR}")
    points = st.session_state.results
    base = st.session_state.result_base
    domain = st.session_state.domain
    if not points:
        st.info("No results yet — set a design space and press **Run the sweep**.")
        return

    best = _best_point(points)
    cfg_opt = _cfg_of_point(base, best)
    res_opt = _run_cached(cfg_opt)

    st.caption(f"{len(points)} feasible configurations · "
               f"design space {domain.size():,} · M = {base.M} tickets")

    left, right = st.columns([1.25, 1], gap="large")
    with left:
        if res_opt is not None:
            _render_instance_panel(cfg_opt, res_opt, key_prefix="res_opt")
        else:
            st.info("Could not realise the discovered optimum for annotation.")
    with right:
        st.markdown("#### What this variant suggests")
        st.caption(
            "The EXACT real-world configuration the discovered optimum selects, "
            "every knob with its value plus the derived counts — not prose."
        )
        if res_opt is not None:
            st.dataframe(
                pd.DataFrame(_variant_field_rows(cfg_opt, res_opt)),
                hide_index=True, width="stretch",
            )
            m1, m2, m3 = st.columns(3)
            m1.metric(LABEL["cost"], _fmt_usd(res_opt.total_cost))
            m2.metric("End-to-end time", _fmt_s(res_opt.makespan))
            m3.metric("Suite runs", res_opt.num_suite_runs)

    st.divider()

    _render_synthesis_section(base, points, cfg_opt, res_opt)

    st.divider()

    st.markdown("#### Cost vs end-to-end time")
    st.plotly_chart(_fig_cost_time(points, best), key="fig_cost_time")
    front = pareto_front_cost_makespan(points)
    cheapest = min(points, key=lambda p: p.cost)
    fastest = min(points, key=lambda p: p.makespan)
    st.caption(
        f"**Takeaway:** {len(front)} configuration(s) are non-dominated. Cheapest is "
        f"{_fmt_usd(cheapest.cost)}; fastest is {_fmt_s(fastest.makespan)}. "
        "Lower-left is better."
    )

    st.markdown("#### When to test & branch depth (H1)")
    st.plotly_chart(_fig_h1(points), key="fig_h1")
    st.caption(
        "**Takeaway:** compare 'test every merge' at depth 1 against deeper trees "
        "with tests deferred to the top — the core H1 question (does deferral cut "
        "cost AND time?)."
    )

    st.markdown("#### Bucket size vs cost")
    st.plotly_chart(_fig_bucket(points, base.M), key="fig_bucket")
    sqrt_m = math.sqrt(base.M) if base.M > 0 else 0.0
    st.caption(
        f"**Takeaway:** the cost-minimising bucket size {'tracks' if sqrt_m else 'vs'} "
        f"√M ≈ {sqrt_m:.1f} (batch/EOQ law). A single bucket means one giant batch; "
        "too small means paying the per-bucket setup every time."
    )

    c_l, c_r = st.columns(2)
    with c_l:
        st.markdown("#### AC target vs cost")
        st.plotly_chart(_fig_alpha(points), key="fig_alpha")
        st.caption("**Takeaway:** more acceptance criteria per ticket raise test cost; "
                   "quality (f4) is not yet modelled, so this is a cost-only view.")
    with c_r:
        st.markdown("#### Number of agents")
        st.plotly_chart(_fig_agents(points), key="fig_agents")
        st.caption("**Takeaway:** more agents shorten time but cost more (parallelism "
                   "cost) — look for an interior optimum.")

    st.markdown("#### Objective trade-offs")
    st.plotly_chart(_fig_tradeoffs(points), key="fig_tradeoffs")
    st.caption(
        f"**Takeaway:** cost↔risk front has "
        f"{len(pareto_front_cost_risk(points))} point(s); time↔risk has "
        f"{len(pareto_front_time_risk(points))}. Deferring testing is cheaper/faster "
        "but carries more risk — this surface is where you choose."
    )

    st.markdown("#### All configurations (ranked)")
    ranges = {
        "makespan": (min(p.makespan for p in points), max(p.makespan for p in points)),
        "cost": (min(p.cost for p in points), max(p.cost for p in points)),
        "util": (min(p.util for p in points), max(p.util for p in points)),
    }
    ranked = sorted(points, key=lambda p: weighted_score(p, domain, ranges))
    st.dataframe(
        pd.DataFrame([{
            "Bucket size": p.n, "AC target": p.alpha, "Branch depth": p.branch_levels,
            "Branch fan-out": p.branch_fanout,
            "When to test": _plain_test_level(p.test_level),
            "Test scope": _plain_test_exec(p.test_exec), "Agents": p.m,
            "Cost ($)": p.cost, "Time (s)": p.makespan, "Risk": _risk_of(p),
            "Suite runs": p.suite_runs,
        } for p in ranked]),
        hide_index=True, width="stretch",
        column_config={
            "Cost ($)": st.column_config.NumberColumn(format="$%.4f"),
            "Time (s)": st.column_config.NumberColumn(format="%.0f"),
            "Risk": st.column_config.NumberColumn(format="%.4f"),
        },
    )


# ===========================================================================
# TAB 3 -- Answers: the user's questions, numbers + one-line conclusion
# ===========================================================================
def _render_answers_tab() -> None:
    st.subheader("Answers — the questions, with numbers")
    points = st.session_state.results
    base = st.session_state.result_base
    if not points:
        st.info("Run a sweep first; then every question below is answered from the "
                "results plus a few targeted runs.")
        return

    best = _best_point(points)
    M = base.M
    sqrt_m = math.sqrt(M) if M > 0 else 0.0
    answers: list[tuple[str, str, str]] = []

    # ---- Q1 optimal bucket size / sqrt(M) --------------------------------
    ratio = best.n / sqrt_m if sqrt_m else float("nan")
    if 0.5 <= ratio <= 2.0:
        v = f"Optimal bucket size **{best.n}**; √M = {sqrt_m:.1f} for M = {M} (ratio {ratio:.2f})."
        c = "Yes — the optimum is roughly √M, consistent with the square-root batch law."
    else:
        v = (f"Optimal bucket size **{best.n}**; √M = {sqrt_m:.1f} (ratio {ratio:.2f}); "
             f"analytic estimate {analytic_bucket_size(base, base.horizon):.1f}.")
        c = ("Not close to √M on this sampled space — widen the bucket-size set to test "
             "the law.")
    answers.append(("What is the optimal bucket size? Is it ~√(total tickets)?", v, c))

    # ---- Q2 sensitivity to ticket sizing ---------------------------------
    ws = sorted({max(1.0, base.w / 2.0), base.w, base.w * 2.0})
    rows = []
    for w in ws:
        Mw = int(round(base.W_tot / w))
        if Mw < 1:
            continue
        cfg = replace(base, w=w, n=max(1, min(best.n, Mw)), alpha=best.alpha,
                      branch_levels=best.branch_levels, branch_fanout=best.branch_fanout,
                      test_level=best.test_level, test_exec=best.test_exec, m=best.m)
        r = _run_cached(cfg)
        if r is not None:
            rows.append((w, Mw, r.total_cost))
    if len(rows) >= 2:
        v = ("Work per ticket → total cost: " +
             ", ".join(f"w={w:g} (M={mw}) → {_fmt_usd(c)}" for w, mw, c in rows) + ".")
        c = ("Larger tickets mean fewer of them, so the workload is cheaper overall, "
             "but the optimal bucket size shifts with √M.")
    else:
        v = "Could not vary ticket sizing on this configuration."
        c = "Enter a valid work-per-ticket value."
    answers.append(("How sensitive is the optimum to ticket sizing?", v, c))

    # ---- Q3 optimal AC target --------------------------------------------
    by_alpha: dict[int, list[SweepPoint]] = {}
    for p in points:
        by_alpha.setdefault(p.alpha, []).append(p)
    best_alpha = min(by_alpha, key=lambda a: min(x.cost for x in by_alpha[a]))
    v = (f"Cost-minimising AC target is **{best_alpha}**; " +
         ", ".join(f"AC {a} → {_fmt_usd(min(x.cost for x in by_alpha[a]))}" for a in sorted(by_alpha)) + ".")
    c = "More acceptance criteria per ticket cost more; quality (f4) is not modelled, so this is cost-only."
    answers.append(("What AC target per ticket is optimal?", v, c))

    # ---- Q4 hierarchical vs flat branching -------------------------------
    flat = [p for p in points if p.branch_levels == 1]
    hier = [p for p in points if p.branch_levels > 1]
    if flat and hier:
        fc, fm = min(p.cost for p in flat), min(p.makespan for p in flat)
        hc, hm = min(p.cost for p in hier), min(p.makespan for p in hier)
        winner = "hierarchical" if (hc, hm) <= (fc, fm) else "flat"
        v = (f"Flat (depth 1): {_fmt_usd(fc)}, {_fmt_s(fm)}.  "
             f"Hierarchical (depth > 1): {_fmt_usd(hc)}, {_fmt_s(hm)}.")
        c = (f"{winner.capitalize()} branching wins on this space; hierarchical buys time "
             "once the compounding suite is deferred to top-level merges.")
    else:
        v = "This space did not include both flat and hierarchical depths."
        c = "Add branch depth values {1, 2, …} to compare."
    answers.append(("Hierarchical vs flat branching — and when?", v, c))

    # ---- Q5 bucketing vs per-ticket --------------------------------------
    per_ticket = _run_cached(replace(
        base, n=1, alpha=best.alpha, branch_levels=best.branch_levels,
        branch_fanout=best.branch_fanout, test_level=best.test_level,
        test_exec=best.test_exec, m=best.m))
    if per_ticket is not None:
        v = (f"Optimal bucketing (size {best.n}): {_fmt_usd(min(p.cost for p in points))}.  "
             f"Per-ticket (size 1): {_fmt_usd(per_ticket.total_cost)}.")
        c = ("Bucketing is cheaper than per-ticket here." if per_ticket.total_cost >
             min(p.cost for p in points) else
             "With these parameters per-ticket is already competitive.")
    else:
        v, c = "Per-ticket run not available.", "—"
    answers.append(("Bucketing vs per-ticket — which is more efficient?", v, c))

    # ---- Q6 agent/task specialisation (honest: not modelled) --------------
    answers.append((
        "What is the best agent/task specialisation?",
        "The simulator uses a **homogeneous agent pool**; agent-role partition "
        "(specialisation) is not implemented (spec C15 deferred).",
        "Not answerable from this model yet — every agent can run every task.",
    ))

    # ---- Q7 merge order (honest: not modelled) ---------------------------
    answers.append((
        "Does merge order matter?",
        "Only the **natural** merge order is implemented; the alternatives "
        "(largest-last / smallest-first / random) raise NotImplementedError.",
        "Not measurable in this model yet — merge order is fixed.",
    ))

    # ---- Q8 optimal number of agents -------------------------------------
    ms_set = sorted({p.m for p in points})
    if len(ms_set) > 1:
        best_m = min(ms_set, key=lambda m: min(p.cost for p in points if p.m == m))
        v = (f"Cost-minimising agent count is **{best_m}**; " +
             ", ".join(f"m={m} → {_fmt_usd(min(p.cost for p in points if p.m == m))}" for m in ms_set) + ".")
        c = ("There is an interior optimum — too few agents queue, too many cost too "
             "much parallelism." if best_m not in (min(ms_set), max(ms_set)) else
             "The sampled optimum sits at an edge — widen the agent-count set.")
    else:
        rows = []
        for m in (2, 4, 8):
            r = _run_cached(replace(base, n=best.n, alpha=best.alpha,
                                    branch_levels=best.branch_levels,
                                    branch_fanout=best.branch_fanout,
                                    test_level=best.test_level,
                                    test_exec=best.test_exec, m=m))
            if r is not None:
                rows.append((m, r.total_cost, r.makespan))
        best_m = min(rows, key=lambda x: x[1])[0] if rows else 4
        v = ("Agent count sweep: " +
             ", ".join(f"m={m} → {_fmt_usd(c)}, {_fmt_s(t)}" for m, c, t in rows) + ".")
        c = f"Optimal agent count ≈ **{best_m}**; more agents buy time at a parallelism cost."
    answers.append(("What is the optimal number of agents?", v, c))

    # ---- Q9 H1: does deferring testing cut cost AND time -----------------
    deferred_levels = max(2, max(p.branch_levels for p in points))
    base_opt = replace(base, n=best.n, alpha=best.alpha,
                       branch_fanout=best.branch_fanout, m=best.m,
                       test_exec=best.test_exec)
    try:
        contrast = _h1_cached(base_opt, deferred_levels)
        holds = contrast.h1_holds
        v = (f"Test every merge: {_fmt_usd(contrast.baseline.total_cost)}, "
             f"{_fmt_s(contrast.baseline.makespan)}, {contrast.baseline.num_suite_runs} suites.  "
             f"Defer to top (depth {deferred_levels}): {_fmt_usd(contrast.deferred.total_cost)}, "
             f"{_fmt_s(contrast.deferred.makespan)}, {contrast.deferred.num_suite_runs} suites.")
        c = ("Yes — deferring testing reduces BOTH total cost and end-to-end time." if holds
             else "Not on these parameters — the two objectives do not both improve.")
    except Exception as exc:  # noqa: BLE001 - never crash the Answers tab
        logger.warning("H1 contrast unavailable: %s: %s", type(exc).__name__, exc)
        v, c = f"H1 contrast unavailable: {exc}", "—"
    answers.append(("Does deferring testing cut cost AND end-to-end time?", v, c))

    # ---- Q10 objective trade-offs / Pareto surface -----------------------
    f_ct = pareto_front_cost_makespan(points)
    f_cr = pareto_front_cost_risk(points)
    f_tr = pareto_front_time_risk(points)
    v = (f"Non-dominated configurations — cost↔time: {len(f_ct)}, cost↔risk: {len(f_cr)}, "
         f"time↔risk: {len(f_tr)}.")
    c = ("The genuinely trading pair is time vs risk (and time vs cost once parallelism "
         "is charged): deferral is cheaper and faster but riskier.")
    answers.append(("What are the objective trade-offs (the Pareto surface)?", v, c))

    for i, (q, val, concl) in enumerate(answers, start=1):
        st.markdown(f"**Q{i}. {q}**")
        st.markdown(val)
        st.markdown(f"→ *{concl}*")
        if i != len(answers):
            st.divider()


# ===========================================================================
# TAB 4 -- Scenario: force one config and compare it to the frontier
# ===========================================================================
def _render_scenario_tab() -> None:
    st.subheader("Scenario — force one configuration and compare")
    st.caption("Set one specific configuration (e.g. current practice) in the sidebar's "
               "**Scenario** panel and place it against the discovered trade-offs.")
    ss = st.session_state
    if st.button("Run scenario", key="btn_scenario", type="primary"):
        cfg = replace(_base_cfg(), n=int(ss.get("sc_n", 5)),
                      alpha=int(ss.get("sc_alpha", 2)),
                      branch_levels=int(ss.get("sc_levels", 1)),
                      branch_fanout=int(ss.get("sc_fanout", 2)),
                      test_level=ss.get("sc_tl", "all"),
                      test_exec=ss.get("sc_te", "full_suite"),
                      m=int(ss.get("sc_m", 4)))
        try:
            st.session_state.scenario = (cfg, _run_cached(cfg))
        except Exception as exc:  # noqa: BLE001 - a bad scenario must never crash the tab
            logger.warning("scenario run rejected (%s): %s", type(exc).__name__, exc)
            st.error(f"Invalid scenario: {exc}")

    if st.session_state.scenario:
        cfg, res = st.session_state.scenario
        m1, m2, m3 = st.columns(3)
        m1.metric("Scenario cost", _fmt_usd(res.total_cost))
        m2.metric("Scenario time", _fmt_s(res.makespan))
        m3.metric("Suite runs", res.num_suite_runs)
        for v in res.violations:
            st.error(v)
        points = st.session_state.results
        if points and not _VIZ_ERROR:
            fig = _fig_cost_time(points)
            fig.add_trace(go.Scatter(x=[res.total_cost], y=[res.makespan], mode="markers",
                                     name="scenario", marker=dict(size=18, symbol="x", color=C_OPT)))
            st.plotly_chart(fig, key="fig_scenario")
        elif not points:
            st.info("Run a sweep to plot the frontier.")
        if not _VIZ_ERROR:
            st.markdown("#### Scenario timeline")
            st.plotly_chart(_fig_gantt(res), key="fig_scenario_gantt")


# ===========================================================================
# main
# ===========================================================================
def _render_tab_safely(label: str, render) -> None:
    """Run a tab body; a render error is reported, never allowed to crash the app.

    Requirement (2026-10-05): every tab and every chart must render without an
    unhandled exception.  A failure in one tab must not take down the other four,
    so the error is logged with its traceback and surfaced inline instead.
    """
    try:
        render()
    except Exception as exc:  # noqa: BLE001 - this guard IS the fail-safe
        logger.exception("tab %r failed to render", label)
        st.error(
            f"The {label} view failed to render ({type(exc).__name__}: {exc}). "
            "The other tabs are unaffected."
        )


def main() -> None:
    st.set_page_config(page_title=TITLE, layout="wide")
    _init_state()

    st.title(TITLE)
    st.caption(
        "Discrete-event simulation of an agentic software-delivery pipeline "
        "(spec 2026-10-05).  Every design-space knob lives in the sidebar; the "
        "landing page shows the discovered configurations, and the flow editor and "
        "plain-language answers follow."
    )

    # The whole control surface (all knobs + Run) is drawn in the sidebar before
    # the tabs, so a sweep kicked off there is reflected in the same render.
    _render_sidebar()

    # NOTE: no sweep runs on load.  The landing page renders a small CURATED
    # default set (:func:`_default_discovery`) which is cheap and can never
    # raise; the FULL sweep runs ONLY when the user presses **Run the sweep**.
    tabs = st.tabs([
        "Discovered configurations",
        "Design & dependencies",
        "Results",
        "Answers",
        "Scenario",
    ])
    renderers = [
        ("Discovered configurations", _render_discovered_tab),
        ("Design & dependencies", _render_design_tab),
        ("Results", _render_results_tab),
        ("Answers", _render_answers_tab),
        ("Scenario", _render_scenario_tab),
    ]
    for tab, (label, render) in zip(tabs, renderers):
        with tab:
            _render_tab_safely(label, render)


main()
