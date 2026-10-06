"""Instance-level (ACTUAL) flow graph of one scenario.

The *type-level* catalogue graph (``taskgraph.DEFAULT_EDGES`` /
``DEFAULT_TASK_GRAPH``) is the same 16 boxes for every configuration -- which is
exactly why two variants of it look identical.  This module renders the graph a
:class:`~pipeline_sim.config.PipelineConfig` **actually instantiates**:

* one node per **task instance** (``detail="tasks"``) -- labelled by its task
  and, when a :class:`~pipeline_sim.engine.SimulationResult` is supplied, the
  **agent** that ran it;
* the **DUPLICATION** the model really produces -- ``M`` tickets become ``M``
  work units, each with its own implement / test-write / test-run / review / …
  chain, grouped into ``ceil(M/n)`` buckets;
* the **BRANCHING** -- the independent merge tree by LEVEL: ``L1`` leaf
  worktrees (one per ticket), ``L2`` / ``L3`` … internal merges of
  ``branch_fanout`` children each, then ``main``;
* a compact ``detail="structural"`` mode (one node per bucket / ticket / merge
  node / global stage) for legible side-by-side comparison;
* per-level aggregates (:func:`instance_level_rows`) answering "what work
  happens at each branching level?";
* a structural :func:`instance_signature` so two configurations can be proven
  to differ.

This module only *reads* the model (it calls :func:`~pipeline_sim.model.build_task_graph`),
so it changes no simulation behaviour.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Dict, List, Optional, Tuple

from .config import PipelineConfig
from .model import MergeNode, Task, TaskGraph, build_task_graph

if TYPE_CHECKING:  # pragma: no cover - engine import kept out of the hot path
    from .engine import SimulationResult

# ---------------------------------------------------------------------------
# presentation vocabulary
# ---------------------------------------------------------------------------
#: Short, human label per engine task kind.
KIND_SHORT: Dict[str, str] = {
    "dispatch": "dispatch",
    "plan": "plan",
    "intake": "intake",
    "routing": "routing",
    "triage": "triage",
    "spec": "spec",
    "impl": "implement",
    "test_write": "test-write",
    "test_run": "test-run",
    "review": "review",
    "review_routing": "review-route",
    "setup": "worktree",
    "merge": "merge",
    "suite": "suite",
    "main_build": "main-build",
    "pre_release": "gates",
    "release": "release",
    "post_verify": "post-verify",
    "rework_impl": "rework",
    "rework_confirm": "reconfirm",
}

#: Stable colour per task kind (self-contained; keeps this module viz-free).
KIND_COLOURS: Dict[str, str] = {
    "dispatch": "#8d99ae",
    "plan": "#c8a2c8",
    "intake": "#cfd8dc",
    "routing": "#b0bec5",
    "triage": "#b0b0b0",
    "spec": "#707070",
    "impl": "#2e86ab",
    "test_write": "#5fa8d3",
    "test_run": "#48b1a0",
    "review": "#9b5de5",
    "review_routing": "#b39ddb",
    "setup": "#f4a259",
    "merge": "#e07a5f",
    "suite": "#c44536",
    "main_build": "#8c5a2b",
    "pre_release": "#7b6cf6",
    "release": "#3a0ca3",
    "post_verify": "#5a4bd1",
    "rework_impl": "#d1495b",
    "rework_confirm": "#e57373",
}

#: Sequential fills for merge/branch LEVELS (L1, L2, L3, …).
LEVEL_COLOURS: Tuple[str, ...] = (
    "#cfe3f0", "#a9cfe6", "#7fb3d5", "#5b96c4", "#3f79b0", "#2d5c92",
)
_LEVEL0 = "#eceff1"       # tickets / bucket / generic per-ticket work
_MAIN = "#333333"         # the main line
_GLOBAL = "#f3e8ff"       # global stages (gates / release / post-verify)


def level_colour(level: int, levels: int) -> str:
    """Fill colour for a merge/branch level (0 = non-branch, >levels = main)."""
    if level <= 0:
        return _LEVEL0
    if level > levels:
        return _GLOBAL if level > levels + 1 else _MAIN
    return LEVEL_COLOURS[(level - 1) % len(LEVEL_COLOURS)]


# ---------------------------------------------------------------------------
# data model
# ---------------------------------------------------------------------------
@dataclass
class InstanceNode:
    """One node of the instance graph (a task, ticket, bucket, or branch)."""

    id: str
    kind: str
    label: str
    role: str                 # "task" | "merge" | "suite" | "bucket" | "ticket"
    bucket: Optional[int] = None
    ticket: Optional[int] = None
    level: int = 0            # merge tier for branch nodes; 0 otherwise
    agent: Optional[int] = None
    start: Optional[float] = None
    finish: Optional[float] = None
    ac: int = 0
    tickets: int = 0          # tickets covered (branch / bucket nodes)
    suite: bool = False


@dataclass
class InstanceEdge:
    src: str
    dst: str


@dataclass
class LevelRow:
    """Aggregate of one branching level ("what work happens here?")."""

    level: int
    label: str
    branches: int
    tickets: int
    merges: int
    suites: int
    worktrees: int
    tasks: int
    is_main: bool = False


@dataclass
class InstanceGraph:
    detail: str
    nodes: List[InstanceNode]
    edges: List[InstanceEdge]
    levels: List[LevelRow]
    counts: Dict[str, object] = field(default_factory=dict)
    title: str = ""


# ---------------------------------------------------------------------------
# bucket membership (mirrors the engine's gate)
# ---------------------------------------------------------------------------
def _task_bucket(task: Task, graph: TaskGraph) -> Optional[int]:
    """Bucket membership by ticket identity (``Task.bucket`` is overloaded).

    Mirrors the engine's gate: per-ticket tasks and a leaf worktree's tasks map
    to their ticket's bucket; dispatch / plan / rework already carry a bucket
    index; multi-ticket merge nodes and the global tasks are shared (``None``).
    """
    if task.ticket is not None:
        return graph.bucket_of.get(task.ticket)
    node = task.merge_node
    if node is not None and not node.is_main:
        if len(node.tickets) == 1:
            return graph.bucket_of.get(node.tickets[0])
        return None
    return task.bucket


# ---------------------------------------------------------------------------
# level aggregates
# ---------------------------------------------------------------------------
def _level_rows(graph: TaskGraph, levels: int) -> List[LevelRow]:
    non_root = graph.merge_nodes
    suite_nodes = set(id(n) for n in graph.suite_nodes)
    top = set(id(n) for n in graph.top_nodes)
    rows: List[LevelRow] = []
    for tier in range(1, levels + 1):
        nodes = [n for n in non_root if n.tier == tier]
        suites = sum(1 for n in nodes if id(n) in suite_nodes)
        main_builds = sum(1 for n in nodes if id(n) in top) if tier == levels else 0
        # each node instantiates one worktree-setup + one merge; plus any suite
        # run selected at this tier and (for top merges) a main-build.
        tasks = 2 * len(nodes) + suites + main_builds
        rows.append(LevelRow(
            level=tier, label=f"L{tier}",
            branches=len(nodes),
            tickets=sum(len(n.tickets) for n in nodes),
            merges=len(nodes),
            suites=suites,
            worktrees=len(nodes),
            tasks=tasks,
        ))
    rows.append(LevelRow(
        level=levels + 1, label="main", branches=1, tickets=graph.M,
        merges=0, suites=0, worktrees=0, tasks=0,
        is_main=True,
    ))
    return rows


def _counts(graph: TaskGraph, cfg: PipelineConfig,
            res: "Optional[SimulationResult]") -> Dict[str, object]:
    levels = cfg.resolved_branch_levels()
    leaf = [n for n in graph.merge_nodes if n.tier == 1]
    branch_shape = tuple(
        sum(1 for n in graph.merge_nodes if n.tier == tier)
        for tier in range(1, levels + 1)
    )
    suite_tiers = tuple(
        sum(1 for n in graph.suite_nodes if n.tier == tier)
        for tier in range(1, levels + 1)
    )
    counts: Dict[str, object] = {
        "buckets": len(graph.buckets),
        "tickets": graph.M,
        "per_bucket": [len(b) for b in graph.buckets],
        "levels": levels,
        "fanout": cfg.branch_fanout,
        "n": cfg.n,
        "alpha": cfg.alpha,
        # spec C4 revised: the REALISED total ACs (0-heavy under the default
        # distribution) and a flag saying which AC model produced it.
        "total_ac": graph.total_ac,
        "ac_distribution": cfg.uses_ac_distribution,
        "leaf_worktrees": len(leaf),
        "merge_nodes": len(graph.merge_nodes),
        "top_merges": len(graph.top_nodes),
        "suites": len(graph.suite_nodes),
        "dispatches": graph.num_dispatches,
        "worktrees": graph.num_worktrees,
        "tasks": len(graph.tasks),
        "gate": graph.gate_suite is not None,
        "branch_shape": branch_shape,
        "test_suite_tiers": suite_tiers,
        "test_level": cfg.test_level,
        "test_exec": cfg.test_exec,
        "plan_position": cfg.plan_position,
        "release_gate": cfg.release_gate,
    }
    if res is not None:
        counts.update({
            "agents": res.spawns,
            "suite_runs_actual": res.num_suite_runs,
            "makespan": res.makespan,
            "cost": res.total_cost,
            "peak_parallel_buckets": res.peak_parallel_buckets,
            "max_parallel_buckets": res.max_parallel_buckets,
        })
    return counts


# ---------------------------------------------------------------------------
# builders
# ---------------------------------------------------------------------------
def _build_tasks(graph: TaskGraph, cfg: PipelineConfig,
                 res: "Optional[SimulationResult]") -> InstanceGraph:
    rec_by_tid = {r.tid: r for r in res.records} if res is not None else {}
    nodes: List[InstanceNode] = []
    edges: List[InstanceEdge] = []
    for t in graph.tasks:
        rec = rec_by_tid.get(t.tid)
        is_branch = t.kind in ("merge", "suite") or t.merge_tier > 0
        level = t.merge_tier if is_branch else 0
        role = "merge" if t.kind == "merge" else ("suite" if t.kind == "suite" else "task")
        short = KIND_SHORT.get(t.kind, t.kind)
        bits = [short]
        if t.ticket is not None:
            bits.append(f"t{t.ticket}")
        elif t.bucket is not None:
            bits.append(f"b{t.bucket}")
        if t.merge_tier:
            bits.append(f"L{t.merge_tier}")
        if rec is not None and rec.agent_id is not None:
            bits.append(f"a{rec.agent_id}")
        nodes.append(InstanceNode(
            id=f"t{t.tid}", kind=t.kind, label="\\n".join(bits), role=role,
            bucket=_task_bucket(t, graph), ticket=t.ticket, level=level,
            agent=(rec.agent_id if rec is not None else None),
            start=(rec.start if rec is not None else None),
            finish=(rec.finish if rec is not None else None),
            ac=(t.unit_ac if t.kind == "merge" else 0),
            suite=(t.kind == "suite"),
        ))
    for t in graph.tasks:
        for p in t.preds:
            edges.append(InstanceEdge(f"t{p.tid}", f"t{t.tid}"))
    return InstanceGraph(
        detail="tasks", nodes=nodes, edges=edges,
        levels=_level_rows(graph, cfg.resolved_branch_levels()),
        counts=_counts(graph, cfg, res),
        title=f"M={graph.M} · {len(graph.buckets)} buckets · "
              f"depth {cfg.resolved_branch_levels()} · fan-out {cfg.branch_fanout}",
    )


def _build_structural(graph: TaskGraph, cfg: PipelineConfig,
                      res: "Optional[SimulationResult]") -> InstanceGraph:
    levels = cfg.resolved_branch_levels()
    nodes: List[InstanceNode] = []
    edges: List[InstanceEdge] = []
    suite_ids = {id(n) for n in graph.suite_nodes}

    # buckets and their tickets
    for bi, bucket in enumerate(graph.buckets):
        bid = f"b{bi}"
        nodes.append(InstanceNode(
            id=bid, kind="bucket", role="bucket", level=0, bucket=bi,
            tickets=len(bucket),
            label=f"bucket {bi}\\n{len(bucket)} tickets",
        ))
        for t in bucket:
            tid = f"tk{t}"
            ac_t = (graph.ac_counts[t] if t < len(graph.ac_counts)
                    else cfg.alpha)
            nodes.append(InstanceNode(
                id=tid, kind="ticket", role="ticket", level=0, bucket=bi,
                ticket=t, ac=int(ac_t),
                label=f"ticket {t}\\nα={ac_t} AC",
            ))
            edges.append(InstanceEdge(bid, tid))

    # merge tree by level
    leaf_by_ticket: Dict[int, MergeNode] = {}
    for n in graph.merge_nodes:
        if n.tier == 1 and len(n.tickets) == 1:
            leaf_by_ticket[n.tickets[0]] = n
    for n in graph.merge_nodes:
        nid = f"n{n.label}"
        mark = "\\n(suite)" if id(n) in suite_ids else ""
        nodes.append(InstanceNode(
            id=nid, kind="merge", role="merge", level=n.tier,
            bucket=(graph.bucket_of.get(n.tickets[0]) if len(n.tickets) == 1 else None),
            tickets=len(n.tickets), ac=n.unit_ac, suite=(id(n) in suite_ids),
            label=f"L{n.tier} merge\\n{n.tickets[0] if len(n.tickets) == 1 else len(n.tickets)}"
                  + (" ticket" if len(n.tickets) == 1 else " tickets") + mark,
        ))
        if n.children:
            for child in n.children:
                edges.append(InstanceEdge(f"n{child.label}", nid))
        else:
            for t in n.tickets:
                edges.append(InstanceEdge(f"tk{t}", nid))
    nodes.append(InstanceNode(
        id="main", kind="main", role="merge", level=levels + 1, tickets=graph.M,
        label=f"main\\n{graph.M} tickets",
    ))
    for n in graph.top_nodes:
        edges.append(InstanceEdge(f"n{n.label}", "main"))

    # global stages
    nodes.append(InstanceNode(id="gates", kind="pre_release", role="task",
                              level=levels + 2, label="pre-release gates"))
    nodes.append(InstanceNode(id="release", kind="release", role="task",
                              level=levels + 2, label="release"))
    nodes.append(InstanceNode(id="post", kind="post_verify", role="task",
                              level=levels + 2, label="post-verify"))
    edges.append(InstanceEdge("main", "gates"))
    edges.append(InstanceEdge("gates", "release"))
    edges.append(InstanceEdge("release", "post"))

    return InstanceGraph(
        detail="structural", nodes=nodes, edges=edges,
        levels=_level_rows(graph, levels),
        counts=_counts(graph, cfg, res),
        title=f"M={graph.M} · {len(graph.buckets)} buckets · "
              f"depth {levels} · fan-out {cfg.branch_fanout}",
    )


def build_instance_graph(cfg: PipelineConfig,
                         res: "Optional[SimulationResult]" = None,
                         detail: str = "tasks") -> InstanceGraph:
    """Build the instance-level flow graph for ``cfg``.

    ``detail`` is ``"tasks"`` (one node per task instance -- the real flow) or
    ``"structural"`` (buckets / tickets / merge-tree nodes / global stages).
    ``res`` (optional) supplies agent ids + timings and the observed counts.
    """
    if detail not in ("tasks", "structural"):
        raise ValueError(f"unknown instance detail {detail!r}")
    graph = res.graph if res is not None else build_task_graph(cfg)
    if detail == "tasks":
        return _build_tasks(graph, cfg, res)
    return _build_structural(graph, cfg, res)


# ---------------------------------------------------------------------------
# aggregates for the UI's per-level panel
# ---------------------------------------------------------------------------
def instance_level_rows(ig: InstanceGraph) -> List[Dict[str, object]]:
    """The per-level panel rows as plain dicts (ready for a dataframe)."""
    return [{
        "Level": r.label,
        "Branches": r.branches,
        "Tickets covered": r.tickets,
        "Merges": r.merges,
        "Suite runs here": r.suites,
        "Worktrees": r.worktrees,
        "Task instances here": r.tasks,
        "Role": "root (main line)" if r.is_main else "merge stage",
    } for r in ig.levels]


def instance_counts(ig: InstanceGraph) -> Dict[str, object]:
    return dict(ig.counts)


def instance_signature(ig: InstanceGraph) -> Tuple:
    """A structure fingerprint: equal iff two configs instantiate the same flow.

    Derived purely from the instantiated counts (never from the rendered nodes),
    so it is independent of ``detail`` and excludes timings/agents -- a pure
    *shape* comparison.  It includes the knob values that change the shape, so
    two configs that differ only in, say, ``release_gate`` are still distinct.
    """
    c = ig.counts
    return (
        c.get("n"), c.get("alpha"), c.get("buckets"),
        tuple(c.get("per_bucket") or ()), c.get("levels"), c.get("fanout"),
        tuple(c.get("branch_shape") or ()),
        tuple(c.get("test_suite_tiers") or ()),
        c.get("test_level"), c.get("test_exec"),
        c.get("plan_position"), c.get("release_gate"),
        c.get("merge_nodes"), c.get("top_merges"), c.get("suites"),
        c.get("tasks"),
    )


# ---------------------------------------------------------------------------
# DOT rendering
# ---------------------------------------------------------------------------
def _node_style(node: InstanceNode, colour_by: str, levels: int) -> Tuple[str, str, str]:
    """``(shape, fillcolor, colour)`` for a node."""
    if colour_by == "level":
        fill = level_colour(node.level, levels)
        border = "#555555"
    else:  # by task kind
        fill = KIND_COLOURS.get(node.kind, "#eef3f7")
        border = "#7a9bb5"
    if node.role == "bucket":
        shape = "folder"
    elif node.role == "ticket":
        shape = "ellipse"
    elif node.kind == "main":
        shape = "doubleoctagon"
    elif node.role in ("merge", "suite"):
        shape = "box"
    else:
        shape = "box"
    return shape, fill, border


def instance_to_dot(ig: InstanceGraph, *, colour_by: str = "kind",
                    title: Optional[str] = None) -> str:
    """Render an :class:`InstanceGraph` as Graphviz DOT.

    ``colour_by`` is ``"kind"`` (task type) or ``"level"`` (branch level);
    ``title`` overrides the graph label.
    """
    levels = int(ig.counts.get("levels", 1) or 1)
    parts = [
        "digraph instance {",
        '  rankdir="TB";',
        f'  label="{_esc(title or ig.title)}"; labelloc="t"; fontsize=13;',
        '  node [style="rounded,filled", fontname="Helvetica", margin="0.10,0.05",'
        ' fontsize=10];',
        '  edge [color="#9aa7b1", arrowsize=0.7];',
    ]
    if ig.detail == "tasks":
        # cluster nodes by bucket (bucket=None -> shared / integration stage)
        by_bucket: Dict[Optional[int], List[InstanceNode]] = {}
        for n in ig.nodes:
            by_bucket.setdefault(n.bucket, []).append(n)
        ordered = sorted(by_bucket, key=lambda b: (b is None, b if b is not None else -1))
        for b in ordered:
            members = by_bucket[b]
            name = "shared/integration" if b is None else f"bucket {b}"
            parts.append(f"  subgraph cluster_bucket_{'shared' if b is None else b} {{")
            parts.append(f'    label="{name}"; style="rounded,dashed"; '
                         'color="#c2ccd4"; fontsize=10;')
            for n in members:
                shape, fill, border = _node_style(n, colour_by, levels)
                parts.append(
                    f'    "{n.id}" [shape={shape}, label="{_esc(n.label)}",'
                    f' fillcolor="{fill}", color="{border}"];'
                )
            parts.append("  }")
    else:
        for n in ig.nodes:
            shape, fill, border = _node_style(n, colour_by, levels)
            parts.append(
                f'  "{n.id}" [shape={shape}, label="{_esc(n.label)}",'
                f' fillcolor="{fill}", color="{border}"];'
            )
    for e in ig.edges:
        parts.append(f'  "{e.src}" -> "{e.dst}";')
    parts.append("}")
    return "\n".join(parts)


def _esc(text: str) -> str:
    return str(text).replace('"', "'")
