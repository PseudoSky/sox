"""Task-graph construction: tickets -> buckets (planning) + an independent
merge tree (branch structure) -> precedence DAG.

The two axes (spec 1.1 / OPEN-8, backlog 47bf572f)
--------------------------------------------------
* **Bucket** = a *group of tickets*: a planning / assignment unit only.  It
  incurs one dispatch (a fresh agent assignment, C17) and carries the per-batch
  setup term the sqrt(M) batch law needs.  It is NOT a merge unit.
* **Merge structure** = an independent tree over *work units* (one per ticket).
  Its depth is ``branch_levels`` and its fanout ``branch_fanout``; neither
  depends on the bucket size ``n``.

Tree shape
----------
Leaves are ticket work units.  Bottom-up, every ``branch_levels`` stages the
nodes are grouped ``branch_fanout`` at a time to form the next stage; the
top-stage nodes all merge to ``main``.  ``branch_levels == 1`` is therefore
flat (every work unit merges straight to main).  Each non-root node performs
exactly one merge into its parent.

Synchronisation constraints implemented in the DAG
--------------------------------------------------
* C5  the merge structure is a tree rooted at main (one parent per node).
* C6  a ticket's test-run follows both its implementation and its test-writing.
* C7  a merge follows all of its children's merges (and, for a leaf, its work).
* C8  release follows every merge, every suite, and the pre-release gates.
* C10 (generalised) a suite run occurs at every merge node selected by
  ``test_level``; at least one test occurs before release.
* C12 all of the above are DAG edges (``preds`` / ``succs``).
* C17 one dispatch (fresh agent start) per bucket, before any of its work.
* C18 deferral is allowed -- no constraint forces a suite below the chosen
  test level.
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Any, Dict, Iterator, List, Optional, Tuple

from .config import PipelineConfig


def partition_tickets(M: int, n: int) -> List[List[int]]:
    """C1: split ``M`` tickets into consecutive buckets of size ``n``.

    The final bucket may be short when ``n`` does not divide ``M``.
    """
    if n <= 0:
        raise ValueError("bucket size n must be >= 1")
    return [list(range(i, min(i + n, M))) for i in range(0, M, n)]


def _chunk(seq: List, size: int) -> Iterator[List]:
    for i in range(0, len(seq), size):
        yield seq[i:i + size]


@dataclass(repr=False)
class Task:
    """One task instance ``(tau, ticket, ac, branch, agent)`` of spec 3.3.

    ``repr=False``: a task's ``preds``/``succs`` form a cyclic object graph
    (each predecessor points back at this task), so the generated dataclass
    ``__repr__`` never terminates.  ``object.__repr__`` is safe and bounded.
    """

    tid: int
    kind: str
    ticket: Optional[int]
    bucket: Optional[int]
    duration: float
    duration_is_dynamic: bool
    tool_calls: float
    tool_calls_is_dynamic: bool
    needs_main: bool          # acquires the single-capacity main resource (C16)
    is_main_merge: bool       # a top-level merge (into main)
    unit_ac: int              # ACs this merge consolidates (its subtree)
    merge_tier: int = 0       # merge stage (1 = leaf merge); 0 = not a merge

    # precedence (C12)
    preds: List["Task"] = field(default_factory=list)
    succs: List["Task"] = field(default_factory=list)

    # the merge node this task belongs to (merge/suite tasks)
    merge_node: Optional["MergeNode"] = None
    # the merge that triggered this suite run; set on suite tasks
    trigger: Optional["Task"] = None

    # runtime state, filled by the engine
    start: Optional[float] = None
    finish: Optional[float] = None
    agent_id: Optional[int] = None
    snapshot_ac: Optional[int] = None    # C9: suite size fixed at merge completion
    done_event: Optional[Any] = None


@dataclass(repr=False)
class MergeNode:
    """A node of the independent merge tree (spec C5).

    ``repr=False``: ``parent``/``children`` are mutually referential, so the
    generated dataclass ``__repr__`` recurses forever; ``object.__repr__`` is
    safe and bounded.
    """

    label: str
    tier: int
    tickets: List[int]
    children: List["MergeNode"] = field(default_factory=list)
    parent: Optional["MergeNode"] = None
    is_main: bool = False
    is_top: bool = False          # merges directly into main

    unit_ac: int = 0              # ACs in this node's subtree (affected_only)
    landed_ac: int = 0            # runtime: ACs consolidated into this node

    setup: Optional[Task] = None
    merge: Optional[Task] = None
    suite: Optional[Task] = None


@dataclass(repr=False)
class TaskGraph:
    """The instantiated scenario graph.

    ``repr=False``: it holds the cyclic ``Task`` / ``MergeNode`` object graph,
    so the generated dataclass ``__repr__`` never terminates.
    """

    tasks: List[Task]
    buckets: List[List[int]]
    merge_nodes: List[MergeNode]     # every non-root node (in build order)
    top_nodes: List[MergeNode]       # nodes whose parent is main
    suite_nodes: List[MergeNode]     # nodes selected by test_level
    main: MergeNode
    bucket_of: Dict[int, int]
    M: int
    alpha: int
    num_worktrees: int
    num_merges: int
    num_main_merges: int
    num_dispatches: int

    #: buckets that drew a rework event (A1, per bucket, probability p_eff).
    rework_buckets: List[int] = field(default_factory=list)
    #: the release-gate suite task (spec 5.2), or ``None`` when ``release_gate``
    #: is ``off``.  It is a ``suite`` kind but not tied to a merge node.
    gate_suite: Optional[Task] = None
    #: per-ticket acceptance-criteria counts actually realised (spec C4 revised;
    #: length ``M``; 0 for the modal real ticket).
    ac_counts: List[int] = field(default_factory=list)
    #: total realised acceptance criteria (``sum(ac_counts)``).
    total_ac: int = 0

    def by_kind(self, kind: str) -> List[Task]:
        return [t for t in self.tasks if t.kind == kind]

    @property
    def num_buckets(self) -> int:
        return len(self.buckets)

    @property
    def units(self) -> List[MergeUnitView]:
        return [MergeUnitView(n) for n in self.merge_nodes]


@dataclass
class MergeUnitView:
    """Backward-compatible view exposing ``setup``/``merge``/``suite``/``is_main``."""

    node: MergeNode

    @property
    def buckets(self) -> List[int]:
        return self.node.tickets

    @property
    def children(self) -> List[MergeNode]:
        return self.node.children

    @property
    def is_main(self) -> bool:
        return self.node.is_top

    @property
    def setup(self) -> Optional[Task]:
        return self.node.setup

    @property
    def merge(self) -> Optional[Task]:
        return self.node.merge

    @property
    def suite(self) -> Optional[Task]:
        return self.node.suite


def build_branch_tree(M: int, levels: int, fanout: int) -> tuple[MergeNode, List[MergeNode], List[MergeNode]]:
    """Build the independent merge tree over ``M`` ticket work units.

    Returns ``(main, non_root_nodes_in_build_order, top_nodes)``.  ``levels`` is
    the number of merge stages from a leaf to main; ``levels == 1`` is flat.
    """
    leaves = [
        MergeNode(label=f"w{t}", tier=1, tickets=[t])
        for t in range(M)
    ]
    non_root: List[MergeNode] = list(leaves)
    level_nodes: List[MergeNode] = leaves
    for stage in range(2, levels + 1):
        parents: List[MergeNode] = []
        for gi, chunk in enumerate(_chunk(level_nodes, fanout)):
            node = MergeNode(
                label=f"L{stage}_{gi}",
                tier=stage,
                tickets=[t for c in chunk for t in c.tickets],
                children=list(chunk),
            )
            for child in chunk:
                child.parent = node
            parents.append(node)
        non_root.extend(parents)
        level_nodes = parents

    main = MergeNode(label="main", tier=levels + 1, tickets=list(range(M)),
                     children=list(level_nodes), is_main=True)
    for node in level_nodes:
        node.parent = main
        node.is_top = True
    return main, non_root, level_nodes


def select_suite_nodes(non_root: List[MergeNode], mode: str, level: int) -> List[MergeNode]:
    """Which merge nodes trigger a suite run (spec C10 / C18, knob test_level)."""
    if mode == "none":
        # no per-merge suite run at all -- testing is deferred to the release
        # gate (spec 5.2); C10 is then satisfied by the gate (or rejected).
        return []
    if mode == "all":
        return list(non_root)
    if mode == "top":
        return [n for n in non_root if n.is_top]
    if mode == "level":
        return [n for n in non_root if n.tier >= level]
    raise ValueError(f"unknown test-level mode: {mode!r}")


def build_task_graph(cfg: PipelineConfig) -> TaskGraph:
    """Instantiate the scenario DAG.

    Every **active** catalogue type (spec 3.3) and every **custom** type (spec
    3.6) is instantiated so a run incurs its calibrated ``t_op`` / cost (BL
    51ec18ef / f3a9eeb5); the merge tree stays independent of bucket size; and
    per-bucket rework is sampled with a seed-seeded RNG (A1) so the arms of a
    comparison share common random numbers.
    """
    cfg.validate()
    # Local import keeps the module graph acyclic (``taskgraph`` imports this
    # module at import time).
    from .taskgraph import catalogue_for, effective_active, type_map

    M = cfg.M
    # Per-ticket acceptance criteria (spec C4 revised): a 0-heavy distribution
    # in the shipped scenario, or `[alpha]*M` in the legacy uniform mode.  A
    # 0-AC ticket instantiates NO test-write / test-run task (it generates no
    # test work) -- the whole point of modelling alpha as a distribution.
    ac_list = cfg.ac_counts(M)
    buckets = partition_tickets(M, cfg.n)
    bucket_of: Dict[int, int] = {}
    for bi, bucket in enumerate(buckets):
        for t in bucket:
            bucket_of[t] = bi

    active = effective_active(cfg)                 # frozenset of type ids
    types = type_map(cfg)
    custom_types = tuple(getattr(cfg, "custom_task_types", ()) or ())

    def on(kind: str) -> bool:
        return kind in active

    tasks: List[Task] = []

    def new(kind: str, *, ticket: Optional[int] = None, bucket: Optional[int] = None,
            duration: float = 0.0, dyn_dur: bool = False, tool: float = 0.0,
            dyn_tool: bool = False, needs_main: bool = False,
            is_main_merge: bool = False, unit_ac: int = 0, merge_tier: int = 0,
            merge_node: Optional[MergeNode] = None) -> Task:
        t = Task(
            tid=len(tasks), kind=kind, ticket=ticket, bucket=bucket,
            duration=duration, duration_is_dynamic=dyn_dur, tool_calls=tool,
            tool_calls_is_dynamic=dyn_tool, needs_main=needs_main,
            is_main_merge=is_main_merge, unit_ac=unit_ac, merge_tier=merge_tier,
            merge_node=merge_node,
        )
        tasks.append(t)
        return t

    def edge(a: Task, b: Task) -> None:
        if b in a.succs:          # dedupe (custom wiring can re-derive an edge)
            return
        a.succs.append(b)
        b.preds.append(a)

    d = cfg.durations
    tc = cfg.tool_calls

    # ---- per-bucket dispatch (C17: a fresh agent start per bucket) -------
    dispatch_of: Dict[int, Task] = {}
    for bi in range(len(buckets)):
        dispatch_of[bi] = new(
            "dispatch", bucket=bi, duration=cfg.t_dispatch, tool=0.0,
        )

    # instances keyed by type id for custom-type wiring (scope compatibility)
    inst: Dict[str, List[Tuple[tuple, Task]]] = {}

    def record(kind: str, key: tuple, task: Task) -> None:
        inst.setdefault(kind, []).append((key, task))

    # ---- plan (per bucket): placement is a VARIANT (spec 5.2) -----------
    # Created up front so it can gate ``routing`` (before_routing) or the
    # build phase (before_implement).
    plan_of: Dict[int, Task] = {}
    if on("plan"):
        for bi, bucket in enumerate(buckets):
            p = new("plan", bucket=bi, duration=d.plan, tool=tc.plan)
            plan_of[bi] = p
            record("plan", ("b", bi), p)

    # ---- per-ticket head chain: intake -> {triage, spec} -> routing ------
    # Operator topology (spec 5.2): triage and spec run in PARALLEL after
    # intake; routing waits on BOTH.  A missing gate simply drops its edge.
    ticket_pre: Dict[int, Optional[Task]] = {}   # head tail (routing or gate)
    pre_build_of: Dict[int, Optional[Task]] = {}
    for t in range(M):
        b = bucket_of[t]
        front: Optional[Task] = None
        if on("intake"):
            front = new("intake", ticket=t, bucket=b, duration=d.intake, tool=tc.intake)
            record("intake", ("t", t), front)
        gate_tasks: List[Task] = []
        if on("triage"):
            g = new("triage", ticket=t, bucket=b, duration=d.triage, tool=tc.triage)
            if front is not None:
                edge(front, g)
            record("triage", ("t", t), g)
            gate_tasks.append(g)
        if on("spec"):
            g = new("spec", ticket=t, bucket=b, duration=d.spec, tool=tc.spec)
            if front is not None:
                edge(front, g)
            record("spec", ("t", t), g)
            gate_tasks.append(g)
        routing: Optional[Task] = None
        if on("routing"):
            routing = new("routing", ticket=t, bucket=b,
                          duration=d.routing, tool=tc.routing)
            for p in (gate_tasks or ([front] if front is not None else [])):
                edge(p, routing)
            record("routing", ("t", t), routing)
        head_tail = routing or (gate_tasks[-1] if gate_tasks else front)
        ticket_pre[t] = head_tail

        # C17: the bucket's dispatch precedes this ticket's first head task.
        for src in (front, *gate_tasks, routing):
            if src is not None and not src.preds:
                edge(dispatch_of[b], src)

        # ---- plan placement variant (spec 5.2) ----
        p = plan_of.get(b)
        if p is not None:
            if cfg.plan_position == "before_routing":
                if front is not None:
                    edge(front, p)          # plan after intake, before routing
                if routing is not None:
                    edge(p, routing)
            else:  # before_implement
                if head_tail is not None:
                    edge(head_tail, p)      # plan after routing, gates the build

        if p is not None and cfg.plan_position == "before_implement":
            pre_build_of[t] = p
        elif p is not None and cfg.plan_position == "before_routing" and routing is None:
            pre_build_of[t] = p
        else:
            pre_build_of[t] = head_tail

    # ---- per-ticket build/verify: routing -> {impl, test_write} ----------
    ticket_tails: Dict[int, List[Task]] = {}
    for t in range(M):
        b = bucket_of[t]
        pre = pre_build_of[t]
        ac = int(ac_list[t]) if t < len(ac_list) else int(cfg.alpha)

        impl = None
        if on("implement"):
            impl = new("impl", ticket=t, bucket=b, duration=d.impl, tool=tc.impl)
            if pre is not None:
                edge(pre, impl)
            record("implement", ("t", t), impl)

        # test writing is independent of implementation (C6 orders the *run*).
        # A 0-AC ticket writes NO tests (spec C4 revised / Appendix E): the task
        # is not instantiated, so it costs no time, tokens, or agent occupancy.
        twrites = None
        if on("test_write") and ac > 0:
            twrites = new(
                "test_write", ticket=t, bucket=b,
                duration=ac * d.test_write_per_ac,
                tool=ac * tc.test_write_per_ac,
                unit_ac=ac,
            )
            if pre is not None:
                edge(pre, twrites)
            record("test_write", ("t", t), twrites)

        # C6 (RELAXED per spec 5.2): test-run waits only on ALL of the ticket's
        # test-writes -- NOT on the implementation.  A 0-AC ticket runs NO tests.
        trun = None
        if ac > 0:
            trun = new(
                "test_run", ticket=t, bucket=b,
                duration=ac * cfg.e,
                tool=ac * tc.test_run_per_ac,
                unit_ac=ac,
            )
            if twrites is not None:
                edge(twrites, trun)
            elif pre is not None:
                edge(pre, trun)
            record("test_run", ("t", t), trun)

        # review depends on IMPLEMENT ONLY (spec 5.2)
        review = None
        if on("review"):
            review = new("review", ticket=t, bucket=b, duration=d.review, tool=tc.review)
            src = impl if impl is not None else pre
            if src is not None:
                edge(src, review)
            record("review", ("t", t), review)
        rr = None
        if on("review_routing"):
            rr = new("review_routing", ticket=t, bucket=b,
                     duration=d.review_routing, tool=tc.review_routing)
            src = review if review is not None else pre
            if src is not None:
                edge(src, rr)
            record("review_routing", ("t", t), rr)
        # The ticket's TAILS feed its merge (+ any rework / release gate):
        # {review, test_run} are both tails; a 0-AC / no-review ticket falls
        # back to its implementation, else its head, so the merge is never
        # left orphaned.
        tails: List[Task] = []
        if trun is not None:
            tails.append(trun)
        review_tail = rr or review
        if review_tail is not None:
            tails.append(review_tail)
        if not tails:
            anchor = impl if impl is not None else pre
            if anchor is not None:
                tails.append(anchor)
        ticket_tails[t] = tails

    # ---- independent merge tree (C5) ------------------------------------
    levels = cfg.resolved_branch_levels()
    main, non_root, top_nodes = build_branch_tree(M, levels, cfg.branch_fanout)
    node_by_label = {n.label: n for n in non_root}
    leaf_of: Dict[int, MergeNode] = {}

    for node in non_root:
        node.unit_ac = sum(ac_list[t] for t in node.tickets)
        node.setup = new(
            "setup", bucket=(node.tickets[0] if len(node.tickets) == 1 else None),
            duration=d.setup, tool=tc.setup, merge_tier=node.tier,
            merge_node=node,
        )
        record("wt_setup", ("n", node.label), node.setup)
        um = new(
            "merge",
            duration=d.merge,
            tool=tc.merge,
            needs_main=node.is_top,           # C16
            is_main_merge=node.is_top,
            unit_ac=node.unit_ac,
            merge_tier=node.tier,
            merge_node=node,
        )
        node.merge = um
        record("merge_resolve", ("n", node.label), um)
        edge(node.setup, um)
        if node.children:
            # C7: a merge follows all of its children's merges
            for child in node.children:
                assert child.merge is not None
                edge(child.merge, um)
        else:
            # a leaf merge follows ALL of the ticket's tails (review, test_run)
            # via its setup -- {review, test_run} -> merge-to-main (spec 5.2).
            # A 0-AC / no-review ticket has no such tail; its setup then waits
            # on the ticket's head or its bucket dispatch, never orphaned.
            ticket = node.tickets[0]
            leaf_of[ticket] = node
            tails = ticket_tails[ticket]
            if tails:
                for tail in tails:
                    edge(tail, node.setup)
            else:
                edge(dispatch_of[bucket_of[ticket]], node.setup)

    # ---- A1 rework: per bucket, probability p_eff, one extra implement pass +
    # reconfirm.  Seeded -> deterministic realisation and common random
    # numbers across the arms of a comparison.  ``p_eff`` is raised when the
    # plan is placed before implement (spec 5.2).
    rng = random.Random(cfg.seed)
    rework_buckets: List[int] = []
    render_p = cfg.effective_rework_p()
    for bi, bucket in enumerate(buckets):
        if rng.random() < render_p:
            rework_buckets.append(bi)
            rimpl = new("rework_impl", bucket=bi, duration=d.impl, tool=tc.rework_impl)
            rconf = new("rework_confirm", bucket=bi,
                        duration=d.review + d.review_routing,
                        tool=tc.rework_confirm)
            edge(rimpl, rconf)
            for t in bucket:
                tails = ticket_tails[t]
                if tails:
                    for tail in tails:
                        edge(tail, rimpl)
                else:
                    edge(dispatch_of[bi], rimpl)
                leaf = leaf_of.get(t)
                if leaf is not None and leaf.setup is not None:
                    edge(rconf, leaf.setup)

    # ---- suite runs selected by test_level (C10 generalised / C18) ------
    mode, level = cfg.resolved_test_level()
    suite_nodes = select_suite_nodes(non_root, mode, level)
    for node in suite_nodes:
        assert node.merge is not None
        us = new(
            "suite",
            duration=0.0, dyn_dur=True,
            tool=0.0, dyn_tool=True,
            is_main_merge=node.is_top,
            unit_ac=node.unit_ac,
            merge_tier=node.tier,
            merge_node=node,
        )
        us.trigger = node.merge
        node.suite = us
        edge(node.merge, us)

    # ---- main build (per merge-to-main) ---------------------------------
    main_build_tasks: List[Task] = []
    if on("main_build"):
        for node in top_nodes:
            assert node.merge is not None
            mb = new("main_build", duration=d.main_build, tool=tc.main_build,
                     is_main_merge=True, unit_ac=node.unit_ac, merge_tier=node.tier,
                     merge_node=node)
            edge(node.merge, mb)
            record("main_build", ("n", node.label), mb)
            main_build_tasks.append(mb)

    # ---- release gate (spec 5.2): a FULL suite run that may sit BEFORE
    # merge-to-main (on the branch) or ON main, and may be the ONLY test run.
    gate_suite: Optional[Task] = None
    if cfg.release_gate != "off":
        gate_suite = new(
            "suite", duration=0.0, dyn_dur=True, tool=0.0, dyn_tool=True,
            is_main_merge=(cfg.release_gate == "main"),
            unit_ac=sum(ac_list), merge_tier=levels,
        )
        gate_suite.trigger = None          # not a per-merge suite: full workload
        if cfg.release_gate == "branch":
            # BEFORE merge-to-main: every ticket's tails feed the gate, and the
            # gate must finish before any top merge lands on main.  A ticket
            # with no tail falls back to its bucket dispatch.
            for t in range(M):
                tails = ticket_tails[t]
                if tails:
                    for tail in tails:
                        edge(tail, gate_suite)
                else:
                    edge(dispatch_of[bucket_of[t]], gate_suite)
            for node in top_nodes:
                assert node.merge is not None
                edge(gate_suite, node.merge)
        else:  # ON main: the gate follows the merge-to-main builds.
            if main_build_tasks:
                for mb in main_build_tasks:
                    edge(mb, gate_suite)
            else:
                for node in top_nodes:
                    assert node.merge is not None
                    edge(node.merge, gate_suite)

    # ---- release barrier (C8) + post-verify -----------------------------
    pre = new("pre_release", duration=d.pre_release, tool=tc.pre_release)
    for node in non_root:
        assert node.merge is not None
        edge(node.merge, pre)
        if node.suite is not None:
            edge(node.suite, pre)           # validation must finish before gates
    for mb in main_build_tasks:
        edge(mb, pre)
    if gate_suite is not None and cfg.release_gate == "main":
        edge(gate_suite, pre)               # release waits on the on-main gate
    record("gates", ("g",), pre)
    rel = new("release", duration=d.release, tool=tc.release)
    edge(pre, rel)
    record("release", ("g",), rel)
    if on("post_verify"):
        pv = new("post_verify", duration=d.post_verify, tool=tc.post_verify)
        edge(rel, pv)
        record("post_verify", ("g",), pv)

    # ---- custom task types (spec 3.6) -----------------------------------
    _instantiate_custom(cfg, custom_types, active, buckets, bucket_of,
                        non_root, top_nodes, node_by_label, new, edge, record, inst,
                        ac_list)

    return TaskGraph(
        tasks=tasks,
        buckets=buckets,
        merge_nodes=non_root,
        top_nodes=top_nodes,
        suite_nodes=suite_nodes,
        main=main,
        bucket_of=bucket_of,
        M=M,
        alpha=cfg.alpha,
        num_worktrees=len(non_root),
        num_merges=len(non_root),
        num_main_merges=len(top_nodes),
        num_dispatches=len(buckets),
        rework_buckets=rework_buckets,
        gate_suite=gate_suite,
        ac_counts=ac_list,
        total_ac=sum(ac_list),
    )


# ---------------------------------------------------------------------------
# custom task types (spec 3.6): generic instantiation + scope-keyed wiring
# ---------------------------------------------------------------------------
#: Scope key for each catalogue type (custom types carry their own ``scope``).
_CATALOGUE_SCOPE: Dict[str, str] = {
    "intake": "per_ticket",
    "routing": "per_ticket",
    "triage": "per_ticket",
    "spec": "per_ticket",
    "plan": "per_bucket",
    "implement": "per_ticket",
    "test_write": "per_ac",
    "test_run": "per_ac",
    "review": "per_ticket",
    "review_routing": "per_review",
    "wt_setup": "per_worktree",
    "merge_resolve": "per_merge_node",
    "main_build": "per_merge_to_main",
    "gates": "global",
    "release": "global",
    "post_verify": "global",
}


def _custom_instance_keys(scope_key: str, *, M: int, ac_counts: List[int],
                          buckets: List[List[int]], non_root: List[MergeNode],
                          top_nodes: List[MergeNode]) -> List[tuple]:
    """The occurrence keys at which a custom type of ``scope_key`` fires.

    ``per_ac`` uses the REALISED per-ticket AC vector (spec C4 revised), so a
    0-AC ticket fires no per-AC custom task.
    """
    if scope_key in ("per_ticket", "per_review"):
        return [("t", t) for t in range(M)]
    if scope_key == "per_ac":
        return [("t", t) for t in range(M)
                for _ in range(int(ac_counts[t]) if t < len(ac_counts) else 0)]
    if scope_key == "per_bucket":
        return [("b", b) for b in range(len(buckets))]
    if scope_key in ("per_worktree", "per_merge_node"):
        return [("n", n.label) for n in non_root]
    if scope_key == "per_merge_to_main":
        return [("n", n.label) for n in top_nodes]
    if scope_key == "global":
        return [("g",)]
    return []


def _compatible(p_scope: str, p_key: tuple, c_scope: str, c_key: tuple,
                bucket_of: Dict[int, int], node_by_label: Dict[str, MergeNode]) -> bool:
    """Should an instance of a predecessor type connect to a custom instance?

    Matched by scope and occurrence key, with the natural finer/coarser
    containment (ticket <-> bucket, ticket <-> merge node, anything -> global).
    """
    if p_scope == "global":
        return True
    if p_scope == c_scope and p_key == c_key:
        return True
    p_t = p_key[1] if p_key and p_key[0] == "t" else None
    c_t = c_key[1] if c_key and c_key[0] == "t" else None
    if p_scope in ("per_ticket", "per_ac") and c_scope in ("per_ticket", "per_ac"):
        return p_key == c_key
    if p_scope in ("per_ticket", "per_ac") and c_scope == "per_bucket":
        return p_t is not None and bucket_of.get(p_t) == c_key[1]
    if p_scope == "per_bucket" and c_scope in ("per_ticket", "per_ac"):
        return c_t is not None and bucket_of.get(c_t) == p_key[1]
    if p_scope in ("per_ticket", "per_ac", "per_bucket") and c_scope == "global":
        return True
    if p_scope in ("per_worktree", "per_merge_node") and c_scope in ("per_ticket", "per_ac"):
        node = node_by_label.get(p_key[1])
        return node is not None and c_t in node.tickets
    if p_scope in ("per_ticket", "per_ac") and c_scope in ("per_worktree", "per_merge_node"):
        node = node_by_label.get(c_key[1])
        return node is not None and p_t in node.tickets
    if p_scope in ("per_worktree", "per_merge_node", "per_merge_to_main") \
            and c_scope == "global":
        return True
    if p_scope == "per_merge_to_main" and c_scope in ("per_merge_node",):
        return p_key == c_key
    return False


def _instantiate_custom(cfg: PipelineConfig, custom_types, active, buckets,
                        bucket_of, non_root, top_nodes, node_by_label,
                        new, edge, record, inst, ac_counts) -> None:
    """Instantiate active custom task types and wire their precedence edges."""
    if not custom_types:
        return
    from .taskgraph import normalize_scope

    M = cfg.M
    by_id = {ct.id: ct for ct in custom_types}

    def scope_of(type_id: str) -> str:
        ct = by_id.get(type_id)
        if ct is not None:
            return normalize_scope(ct.scope)
        return _CATALOGUE_SCOPE.get(type_id, "global")

    # 1. create the instances
    for ct in custom_types:
        if ct.id not in active:
            continue
        scope_key = normalize_scope(ct.scope)
        keys = _custom_instance_keys(scope_key, M=M, ac_counts=ac_counts,
                                     buckets=buckets,
                                     non_root=non_root, top_nodes=top_nodes)
        for key in keys:
            ticket = key[1] if key[0] == "t" else None
            if key[0] == "b":
                bucket = key[1]
            elif ticket is not None:
                bucket = bucket_of.get(ticket)
            else:
                bucket = None
            node = new(ct.id, ticket=ticket, bucket=bucket,
                       duration=ct.t_op, tool=ct.tool_calls)
            record(ct.id, key, node)

    # 2. wire default predecessor / successor edges
    for ct in custom_types:
        if ct.id not in active:
            continue
        c_scope = normalize_scope(ct.scope)
        for key, ctask in inst.get(ct.id, []):
            for pid in ct.default_predecessors:
                for pkey, ptask in inst.get(pid, []):
                    if _compatible(scope_of(pid), pkey, c_scope, key,
                                   bucket_of, node_by_label):
                        edge(ptask, ctask)
            for sid in ct.default_successors:
                for skey, stask in inst.get(sid, []):
                    if _compatible(c_scope, key, scope_of(sid), skey,
                                   bucket_of, node_by_label):
                        edge(ctask, stask)
