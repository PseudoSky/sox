"""The SimPy discrete-event engine.

Agents are modelled as a :class:`simpy.Store` of ``m`` agent tokens -- acquiring
a token is acquiring an agent (constraint C11: an agent runs at most one task).
``main`` is a :class:`simpy.Resource` of capacity 1 (constraint C16: one merge to
main at a time).  Only *top-level* merge nodes need ``main``; internal branch
merges happen off-main and can proceed in parallel -- this is where a multi-level
branch tree buys its time.

Every task is a process that (1) waits for all precedence predecessors, (2)
acquires an agent, (3) for top merges also acquires the main resource, (4)
sleeps for its duration, then (5) signals completion.

The compounding suite (C9)
--------------------------
A suite run's size is the AC count "landed so far".  Landing is *per target*:
when a merge node ``X`` completes, ``X.unit_ac`` ACs land into ``X.parent`` and
``X``'s suite snapshot is fixed at ``X.parent.landed_ac`` (so nested subtrees are
never double-counted).  Suite cost is ``c_suite + snapshot_ac * c_a`` and suite
time is ``t_suite + snapshot_ac * e`` -- both calibrated to real CI prices
(Appendix C), so the suite is a first-order cost once a few levels of testing
accumulate and deferral (H1) is measurable.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import simpy

from .analytics import (
    blast_radius,
    branch_coordination_cost,
    conflict_rate,
    critical_path_bound,
    deferral_levels,
    risk_objective,
)
from .config import LLM_COST_CLASSES, PipelineConfig, llm_cost_components
from .model import Task, TaskGraph, build_task_graph


@dataclass
class TaskRecord:
    tid: int
    kind: str
    ticket: Optional[int]
    start: float
    finish: float
    agent_id: int
    duration: float
    tool_calls: float
    is_main_merge: bool
    ac: int = 0
    merge_tier: int = 0


@dataclass(repr=False)
class SimulationResult:
    """The outcome of one run.

    ``repr=False``: the result carries the cyclic ``TaskGraph`` object graph, so
    the generated dataclass ``__repr__`` never terminates (and pytest's
    assertion introspection calls ``repr`` on operands of a failed comparison).
    """

    makespan: float
    total_cost: float
    cost_breakdown: Dict[str, float]
    num_suite_runs: int
    num_merges: int
    num_main_merges: int
    num_worktrees: int
    num_dispatches: int
    num_tasks: int
    spawns: int
    branch_levels: int
    test_level: str
    critical_path: float
    violations: List[str]
    config: PipelineConfig
    graph: TaskGraph
    records: List[TaskRecord] = field(default_factory=list)
    # f3 risk objective + its components (spec section 4, [fix])
    risk: float = 0.0
    blast_radius: float = 0.0
    conflict_rate: float = 0.0
    deferral: int = 0
    rework_buckets: int = 0
    # f2 parallelism cost: total agent-seconds of occupied time
    agent_seconds: float = 0.0
    #: The configured cap on buckets in flight at once (``None`` = unlimited).
    max_parallel_buckets: Optional[int] = None
    #: The OBSERVED peak number of buckets that were simultaneously in flight
    #: (<= the configured cap when one is set).
    peak_parallel_buckets: int = 0
    # Appendix C measured LLM classes: USD and shares of the LLM-only total
    # (input / output / reasoning / cache-read).  Disjoint from
    # ``cost_breakdown`` (which also carries the CI terms); these are a VIEW of
    # the LLM spend already inside the op / dispatch / tool lines.
    llm_cost_classes: Dict[str, float] = field(default_factory=dict)
    llm_cost_class_shares: Dict[str, float] = field(default_factory=dict)

    def summary(self) -> Dict[str, float]:
        return {
            "makespan": self.makespan,
            "total_cost": self.total_cost,
            "risk": self.risk,
            "num_suite_runs": self.num_suite_runs,
            "num_merges": self.num_merges,
            "num_dispatches": self.num_dispatches,
            "critical_path": self.critical_path,
        }


class _State:
    def __init__(self) -> None:
        self.used_agents: set = set()
        self.records: List[TaskRecord] = []


def _bucket_of_task(task: Task, bucket_of: Dict[int, int]) -> Optional[int]:
    """The bucket a task instance belongs to, or ``None`` if it is shared.

    Membership is derived from *ticket* identity, never from ``Task.bucket``
    directly: that field is overloaded (a leaf ``setup`` stores its ticket index
    there, while ``dispatch`` / ``plan`` / ``rework`` store a real bucket index),
    so trusting it would mis-assign leaf worktrees.

    * a per-ticket task (``task.ticket`` set) -> its ticket's bucket;
    * a *leaf* merge-tree node's task (one ticket's worktree: setup / merge /
      suite / main-build) -> that ticket's bucket;
    * a per-bucket task with no ticket and no merge node (dispatch / plan /
      rework) -> ``task.bucket``, already a bucket index;
    * everything else (internal / top merges, multi-ticket suites, the global
      release tasks) spans buckets -> ``None`` (not gated).
    """
    if task.ticket is not None:
        return bucket_of.get(task.ticket)
    node = task.merge_node
    if node is not None and not node.is_main:
        if len(node.tickets) == 1:
            return bucket_of.get(node.tickets[0])
        return None
    return task.bucket


def _peak_concurrent_buckets(graph: TaskGraph,
                             records: List[TaskRecord]) -> int:
    """Observed peak number of buckets simultaneously in flight.

    A bucket is in flight from the first start to the last finish of any task
    that belongs to it (its per-ticket work + its leaf merge).  A sweep-line over
    those per-bucket spans yields the peak overlap; it is <= the configured cap
    whenever :attr:`PipelineConfig.max_parallel_buckets` is set.
    """
    by_tid = {r.tid: r for r in records}
    spans: Dict[int, List[float]] = {}
    for t in graph.tasks:
        b = _bucket_of_task(t, graph.bucket_of)
        r = by_tid.get(t.tid)
        if b is None or r is None:
            continue
        if b in spans:
            spans[b][0] = min(spans[b][0], r.start)
            spans[b][1] = max(spans[b][1], r.finish)
        else:
            spans[b] = [r.start, r.finish]
    events: List[tuple] = []
    for lo, hi in spans.values():
        events.append((lo, 1))
        events.append((hi, -1))
    events.sort()
    cur = peak = 0
    for _, delta in events:
        cur += delta
        peak = max(peak, cur)
    return peak


def _suite_ac(task: Task, cfg: PipelineConfig) -> int:
    """C9: acceptance criteria a suite run exercises.

    * ``full_suite``    -> the ACs landed so far into the suite's *target*
      (``snapshot_ac``, fixed on the triggering merge when it completed;
      monotone in completion order).
    * ``affected_only`` -> only the AC this merge introduces (no compounding).
    """
    if cfg.test_exec == "full_suite":
        trigger = task.trigger
        if trigger is not None and trigger.snapshot_ac is not None:
            return trigger.snapshot_ac
    return task.unit_ac


def _op_cost(kind: str, cfg: PipelineConfig,
             ac: Optional[int] = None) -> float:
    """``c_op[tau]`` for one operation of the given task kind.

    These are the operation's OWN tokens (Appendix C cost decomposition); the
    dispatch-schema and tool-call-result pools are charged separately, so this
    term never double-counts them (BL b46a5f8f).  Custom kinds take their
    declared ``per_fire`` (LLM + CI) as their operation cost.

    ``ac`` is the realised acceptance-criteria count for a per-ticket
    ``test_write`` / ``test_run`` task (spec C4 revised); when omitted the
    legacy uniform ``cfg.alpha`` is used, so scalar callers are unchanged.
    """
    per_ac = cfg.alpha if ac is None else int(ac)
    c = cfg.c_op
    builtin = {
        "impl": c.impl,
        "test_write": c.test_write_per_ac * per_ac,
        "test_run": c.test_run_per_ac * per_ac,
        "merge": c.merge,
        "setup": c.setup,
        "pre_release": c.pre_release,
        "release": c.release,
        "triage": c.triage,
        "spec": c.spec,
        "intake": c.intake,
        "routing": c.routing,
        "plan": c.plan,
        "review": c.review,
        "review_routing": c.review_routing,
        "main_build": c.main_build,
        "post_verify": c.post_verify,
        # A1 rework: an extra implement pass + a reconfirm/re-review
        "rework_impl": c.impl,
        "rework_confirm": c.review + c.review_routing,
    }
    if kind in builtin:
        return builtin[kind]
    # custom task type (spec 3.6): its declared per-fire cost
    from .taskgraph import type_map

    ct = type_map(cfg).get(kind)
    if ct is not None:
        return ct.per_fire
    return 0.0  # dispatch / suite carry their own dedicated cost terms


def _op_token_pair(kind: str, cfg: PipelineConfig):
    """``(in_tok, out_tok)`` for one operation kind, or ``None``.

    Uses the config's :class:`~pipeline_sim.config.TaskTokens` table (the single
    source of truth for the per-op magnitudes).  Dispatch / suite have no
    per-op tokens -- their dedicated terms are charged separately.
    """
    t = cfg.tokens
    pairs = {
        "impl": t.impl,
        "test_write": t.test_write_per_ac,
        "test_run": t.test_run_per_ac,
        "merge": t.merge,
        "setup": t.setup,
        "pre_release": t.pre_release,
        "release": t.release,
        "triage": t.triage,
        "spec": t.spec,
        "intake": t.intake,
        "routing": t.routing,
        "plan": t.plan,
        "review": t.review,
        "review_routing": t.review_routing,
        "main_build": t.main_build,
        "post_verify": t.post_verify,
        # A1 rework: an extra implement pass + a reconfirm/re-review
        "rework_impl": t.impl,
    }
    if kind == "rework_confirm":
        return (t.review[0] + t.review_routing[0],
                t.review[1] + t.review_routing[1])
    if kind in pairs:
        return pairs[kind]
    # custom task type (spec 3.6): its declared token magnitudes, if any.
    from .taskgraph import type_map

    ct = type_map(cfg).get(kind)
    if ct is not None and (ct.in_tok is not None or ct.out_tok is not None):
        return (ct.in_tok or 0, ct.out_tok or 0)
    return None


def _op_event_quad(kind: str, cfg: PipelineConfig):
    """The MEASURED per-op token quad ``(in, out, reasoning, cache_read)``.

    Consulted from ``cfg.op_event_profiles`` (the real agent-event calibration,
    :mod:`pipeline_sim.events`) when present; ``None`` otherwise so the
    ratio-based behaviour is unchanged by default.
    """
    profiles = getattr(cfg, "op_event_profiles", None)
    if not profiles:
        return None
    for k, quad in profiles:
        if k == kind:
            return quad
    return None


def _op_class_costs(kind: str, cfg: PipelineConfig,
                    ac: Optional[int] = None) -> Dict[str, float]:
    """The four measured LLM classes for one operation, summing to ``_op_cost``.

    The class *proportions* come from the token pair (:func:`llm_cost_components`
    at the config's price basis) -- or, when the real agent-event calibration is
    attached (``cfg.op_event_profiles``), from its MEASURED
    reasoning/cache-read magnitudes; the class *total* is the config's ``c_op``
    so a manually-overridden ``c_op`` is still split faithfully.  A kind with no
    token pair (dispatch / suite) falls back to a single ``input`` bucketed by
    its own cost.  ``ac`` forwards the realised per-ticket AC count (C4 revised).
    """
    total = _op_cost(kind, cfg, ac)
    zero = {k: 0.0 for k in LLM_COST_CLASSES}
    quad = _op_event_quad(kind, cfg)
    if quad is not None:
        comp = llm_cost_components(quad[0], quad[1],
                                   reasoning_tok=quad[2],
                                   cache_read_tok=quad[3],
                                   basis=cfg.price_basis)
    else:
        pair = _op_token_pair(kind, cfg)
        if pair is None or total == 0.0:
            zero["input"] = total
            return zero
        comp = llm_cost_components(pair[0], pair[1], basis=cfg.price_basis)
    denom = sum(comp.values())
    if total == 0.0 or denom <= 0:
        zero["input"] = total
        return zero
    return {k: total * comp[k] / denom for k in LLM_COST_CLASSES}


def _execute(env: simpy.Environment, task: Task, cfg: PipelineConfig,
             state: _State, agent_id: int):
    ac = 0
    if task.duration_is_dynamic:
        ac = _suite_ac(task, cfg)
        task.duration = cfg.t_suite + ac * cfg.e          # C9 compounding
        task.tool_calls = ac * cfg.tool_calls.suite_per_ac
    elif task.kind in ("test_write", "test_run"):
        # the ticket's realised AC count (spec C4 revised): carried on the task
        # so the op-cost term scales with THIS ticket, not a global scalar.
        ac = task.unit_ac
    task.start = env.now
    task.agent_id = agent_id
    yield env.timeout(task.duration)
    task.finish = env.now
    if task.kind == "merge" and task.merge_node is not None:
        node = task.merge_node
        if node.parent is not None:
            node.parent.landed_ac += node.unit_ac          # C9 landing (per target)
            task.snapshot_ac = node.parent.landed_ac
    state.records.append(TaskRecord(
        tid=task.tid, kind=task.kind, ticket=task.ticket,
        start=task.start, finish=task.finish, agent_id=agent_id,
        duration=task.duration, tool_calls=task.tool_calls,
        is_main_merge=task.is_main_merge, ac=ac, merge_tier=task.merge_tier,
    ))


def _task_process(env: simpy.Environment, task: Task, pool: simpy.Store,
                  main_res: simpy.Resource, cfg: PipelineConfig, state: _State, *,
                  bucket_events: Optional[Dict[int, Any]] = None,
                  bucket_of: Optional[Dict[int, int]] = None):
    if task.preds:
        yield env.all_of([p.done_event for p in task.preds])
    # Bucket concurrency cap: a per-bucket task waits until its bucket holds a
    # slot.  ``bucket_events`` is only non-empty when a cap is configured.
    if bucket_events is not None and bucket_of is not None:
        b = _bucket_of_task(task, bucket_of)
        if b is not None and b in bucket_events:
            yield bucket_events[b]
    agent_id = yield pool.get()                             # acquire an agent (C11)
    state.used_agents.add(agent_id)
    try:
        if task.needs_main:
            with main_res.request() as req:                 # serialise main (C16)
                yield req
                yield from _execute(env, task, cfg, state, agent_id)
        else:
            yield from _execute(env, task, cfg, state, agent_id)
    finally:
        yield pool.put(agent_id)
    task.done_event.succeed()


def run(cfg: PipelineConfig) -> SimulationResult:
    """Run one deterministic realisation of the pipeline and total its cost."""
    cfg.validate()
    graph = build_task_graph(cfg)

    env = simpy.Environment()
    pool = simpy.Store(env, capacity=cfg.m)
    for i in range(cfg.m):
        pool.put(i)                                         # a pool of m agents
    main_res = simpy.Resource(env, capacity=1)              # C16
    state = _State()

    for task in graph.tasks:
        task.done_event = env.event()

    # ---- bucket concurrency cap (spec 1.1) -------------------------------
    # When ``max_parallel_buckets`` is set below the bucket count, each bucket
    # holds one slot of a ``max_parallel_buckets``-capacity resource for its
    # whole lifetime; per-bucket tasks wait for their bucket's slot.  A bucket's
    # lifetime is its first task start -> its last task finish.  With no cap (or
    # a cap >= the bucket count) this is a no-op and behaviour is unchanged.
    bucket_events: Dict[int, Any] = {}
    bucket_of = graph.bucket_of
    gate = cfg.max_parallel_buckets
    if gate is not None and 1 <= gate < len(graph.buckets):
        bucket_res = simpy.Resource(env, capacity=gate)
        bucket_tasks: Dict[int, List[Task]] = {}
        for task in graph.tasks:
            b = _bucket_of_task(task, bucket_of)
            if b is not None:
                bucket_tasks.setdefault(b, []).append(task)
        for b in range(len(graph.buckets)):
            bucket_events[b] = env.event()

        def _bucket_holder(b: int, tasks: List[Task]):
            req = bucket_res.request()
            yield req
            bucket_events[b].succeed()
            yield env.all_of([t.done_event for t in tasks])
            bucket_res.release(req)

        for b, tasks in bucket_tasks.items():
            env.process(_bucket_holder(b, tasks))

    for task in graph.tasks:
        env.process(_task_process(env, task, pool, main_res, cfg, state,
                                  bucket_events=bucket_events or None,
                                  bucket_of=bucket_of))

    env.run()

    # A realised run must execute EVERY task.  SimPy drains its event queue when
    # no further progress is possible; that only happens here when the bucket
    # concurrency cap (``max_parallel_buckets``) deadlocks against a GLOBAL task
    # that sits upstream of every bucket -- e.g. a branch release-gate on a flat
    # tree: the gate needs every ticket's tails, but each bucket's leaf merge
    # waits on the gate, and only ``cap`` buckets may hold a slot at once, so no
    # bucket can ever finish.  Returning the partial realisation would corrupt
    # every metric and later raise obscurely in constraint verification; reject
    # it explicitly instead, so ``run_sweep`` (which skips ``ValueError``) and
    # the UI's quiet runner can drop the unschedulable configuration cleanly.
    stalled = [t for t in graph.tasks if not t.done_event.triggered]
    if stalled:
        kinds = ", ".join(sorted({t.kind for t in stalled}))
        raise ValueError(
            f"configuration did not complete: {len(stalled)} of {len(graph.tasks)} "
            f"tasks never ran (kinds: {kinds}); the bucket cap "
            f"max_parallel_buckets={cfg.max_parallel_buckets} cannot schedule a "
            "global task that every bucket depends on."
        )

    records = state.records
    makespan = max((r.finish for r in records), default=0.0)
    peak_buckets = _peak_concurrent_buckets(graph, records)

    # ---- occupied agent-seconds (f2 parallelism / occupancy cost) --------
    # Each agent is charged for the wall-clock from its first task start to its
    # last task finish, idle waits included: the pool of m agents is provisioned
    # for the horizon, so buying makespan with more agents costs more.  Total
    # agent-seconds of *task-duration* alone is invariant to m and would not
    # create that trade-off (verified: 2026-10-05).
    span: Dict[int, List[float]] = {}
    for r in records:
        lo, hi = span.get(r.agent_id, [r.start, r.finish])
        span[r.agent_id] = [min(lo, r.start), max(hi, r.finish)]
    agent_seconds = sum(hi - lo for lo, hi in span.values())

    # ---- cost (spec f2) --------------------------------------------------
    tool_cost = sum(r.tool_calls for r in records) * cfg.OC
    dispatch_cost = cfg.c_dispatch * graph.num_dispatches
    rework_kinds = ("rework_impl", "rework_confirm")
    op_cost = sum(_op_cost(r.kind, cfg, r.ac) for r in records
                  if r.kind not in rework_kinds)
    rework_cost = sum(_op_cost(r.kind, cfg, r.ac) for r in records
                      if r.kind in rework_kinds)
    worktree_cost = cfg.c_wt * graph.num_worktrees
    # merge_resolve CI (c_merge) + the separate main-build CI (c_main_build,
    # Appendix D "$0.040 per merge-to-main"); both fold into the merge line.
    n_main_builds = sum(1 for r in records if r.kind == "main_build")
    merge_cost = cfg.c_merge * graph.num_merges + cfg.c_main_build * n_main_builds
    # FIRST-ORDER per-BRANCH cost (spec §4 NOTE): worktree + merge + coordination
    # beyond the measured CI increments, charged PER WORK UNIT each merge-tree
    # node integrates (``Σ_nodes |tickets|``) and again per unit per TIER.  This
    # is what makes the branch-DEPTH optimum INTERIOR -- a deeper tree adds
    # levels whose merges integrate ever larger subtrees, so coordination grows
    # with depth while the (deferred) suite saving shrinks; the two balance at an
    # optimal depth instead of a boundary.  ``Σ_nodes |tickets| = M · levels``, so
    # the cost is workload-scaled and the optimum depth is size-invariant.
    n_merges = sum(1 for r in records if r.kind == "merge")
    branch_cost = branch_coordination_cost(cfg, graph.merge_nodes)
    # FIRST-ORDER per-BUCKET setup cost: the K of the sqrt(M) batch law (∝1/n),
    # balanced by the c_wip holding term (∝n) -- restores an interior n*.
    bucket_cost = cfg.c_bucket * graph.num_buckets
    agent_cost = cfg.c_agent * agent_seconds
    suite_runs = [r for r in records if r.kind == "suite"]
    # COMPOUNDING test term: c_suite + sum of c_a over accumulated ACs.
    suite_cost = sum(cfg.c_suite + r.ac * cfg.c_a for r in suite_runs)
    # EOQ holding counterpart: bucket size x planning horizon (spec f2
    # ``c_wip * n * horizon``).  ``horizon`` is a fixed planning horizon (the
    # same T the analytic batch law uses), NOT the realised makespan: coupling
    # it to makespan makes the term ∝ n·T(M), and under a compounding suite
    # T grows with M, which collapses L1 (n* ~ sqrt(M)) to a constant.
    holding_cost = cfg.c_wip * cfg.n * cfg.horizon
    # release-gate remediation (spec 5.2): fixing a gate failure found on main
    # needs a NEW branch, so ``c_gate_rework_main`` > ``c_gate_rework_branch``.
    # It GROWS with test deferral: a later, bigger gate resolves more issues at
    # once, so deferring is no longer a free lunch (spec §4 NOTE / part 1).
    deferral = deferral_levels(cfg)
    gate_rework_cost = 0.0
    if graph.gate_suite is not None:
        gate_base = (
            cfg.c_gate_rework_branch if cfg.release_gate == "branch"
            else cfg.c_gate_rework_main
        )
        gate_rework_cost = gate_base * (1.0 + deferral)
    if deferral > 0:
        # C10 mandates a pre-release test even with no explicit gate; when
        # testing is deferred, that pre-release validation is the effective
        # gate and its remediation grows with how much was deferred into it:
        # ``rate * deferral * (accumulated ACs resolved at the gate)``.
        gate_rework_cost += (cfg.c_gate_rework_per_deferred_ac * deferral
                             * cfg.total_ac())
    # legacy terms (default 0; retained for theta-shape compatibility)
    spawn_cost = cfg.c_sys * len(state.used_agents)
    instruction_cost = cfg.c_0 * len(records)
    breakdown = {
        "tool": tool_cost,
        "dispatch": dispatch_cost,
        "op": op_cost,
        "worktree": worktree_cost,
        "merge": merge_cost,
        "branch": branch_cost,
        "bucket": bucket_cost,
        "suite": suite_cost,
        "holding": holding_cost,
        "agent": agent_cost,
        "rework": rework_cost,
        "gate_rework": gate_rework_cost,
        "spawn": spawn_cost,
        "instruction": instruction_cost,
    }
    total_cost = sum(breakdown.values())

    # ---- Appendix C measured LLM composition (a VIEW, no double-count) ----
    # The op pool splits into input/output/reasoning/cache-read; the dispatch
    # and tool pools are input-only.  CI terms are excluded (they are not LLM).
    llm_cost_classes = {k: 0.0 for k in LLM_COST_CLASSES}
    for r in records:
        for cls, value in _op_class_costs(r.kind, cfg, r.ac).items():
            llm_cost_classes[cls] += value
    llm_cost_classes["input"] += dispatch_cost + tool_cost
    llm_total = sum(llm_cost_classes.values())
    llm_cost_class_shares = {
        k: (v / llm_total if llm_total > 0 else 0.0)
        for k, v in llm_cost_classes.items()
    }

    min_suite = min((n.unit_ac for n in graph.merge_nodes), default=cfg.alpha) * cfg.e
    min_suite += cfg.t_suite
    cp = critical_path_bound(graph.tasks, min_suite_duration=min_suite)

    violations = verify_constraints(cfg, graph, records)

    return SimulationResult(
        makespan=makespan,
        total_cost=total_cost,
        cost_breakdown=breakdown,
        num_suite_runs=len(suite_runs),
        num_merges=sum(1 for r in records if r.kind == "merge"),
        num_main_merges=graph.num_main_merges,
        num_worktrees=graph.num_worktrees,
        num_dispatches=graph.num_dispatches,
        num_tasks=len(records),
        spawns=len(state.used_agents),
        branch_levels=cfg.resolved_branch_levels(),
        test_level=cfg.test_level,
        critical_path=cp,
        violations=violations,
        config=cfg,
        graph=graph,
        records=records,
        risk=risk_objective(cfg),
        blast_radius=blast_radius(cfg.resolved_branch_levels(), deferral_levels(cfg)),
        conflict_rate=conflict_rate(cfg),
        deferral=deferral_levels(cfg),
        rework_buckets=len(graph.rework_buckets),
        agent_seconds=agent_seconds,
        max_parallel_buckets=cfg.max_parallel_buckets,
        peak_parallel_buckets=peak_buckets,
        llm_cost_classes=llm_cost_classes,
        llm_cost_class_shares=llm_cost_class_shares,
    )


# ---------------------------------------------------------------------------
# constraint verification -- evidence that the run respected C1/C6..C12/C16/C17
# ---------------------------------------------------------------------------
def verify_constraints(cfg: PipelineConfig, graph: TaskGraph,
                       records: List[TaskRecord]) -> List[str]:
    by_tid = {r.tid: r for r in records}
    bad: List[str] = []

    # C1: bucket sizes
    for bi, bucket in enumerate(graph.buckets):
        if bi < len(graph.buckets) - 1 and len(bucket) != cfg.n:
            bad.append(f"C1: bucket {bi} size {len(bucket)} != n={cfg.n}")
        if not (1 <= len(bucket) <= cfg.n):
            bad.append(f"C1: bucket {bi} has illegal size {len(bucket)}")

    # C12 (and via it C6/C7/C8/C17): every precedence edge is respected
    for t in graph.tasks:
        for p in t.preds:
            pr, tr = by_tid.get(p.tid), by_tid.get(t.tid)
            if pr and tr and pr.finish > tr.start + 1e-9:
                bad.append(
                    f"C12: {p.kind}->{t.kind} violated "
                    f"(tf={pr.finish:.3f} > ts={tr.start:.3f})"
                )

    # C6 (RELAXED per spec 5.2): a test-run starts after its ticket's
    # test-writes ONLY -- it no longer waits on the implementation.
    for t in graph.tasks:
        if t.kind != "test_run":
            continue
        for p in t.preds:
            if p.ticket == t.ticket and p.kind == "test_write":
                pr, tr = by_tid[p.tid], by_tid[t.tid]
                if pr.finish > tr.start + 1e-9:
                    bad.append(f"C6: test_run{t.ticket} starts before test_write")

    # C8 explicitly
    release = next((r for r in records if r.kind == "release"), None)
    if release is not None:
        for r in records:
            if r.kind == "merge" and r.is_main_merge and r.finish > release.start + 1e-9:
                bad.append("C8: release starts before a main merge")
            if r.kind == "pre_release" and r.finish > release.start + 1e-9:
                bad.append("C8: release starts before pre-release gates")

    # C11: no agent runs two tasks at once
    by_agent: Dict[int, List[TaskRecord]] = {}
    for r in records:
        by_agent.setdefault(r.agent_id, []).append(r)
    for agent, rs in by_agent.items():
        rs.sort(key=lambda r: r.start)
        for a, b in zip(rs, rs[1:]):
            if a.finish > b.start + 1e-9:
                bad.append(f"C11: agent {agent} overlaps {a.kind} and {b.kind}")

    # C16: top (main) merges are serialised
    mains = sorted((r for r in records if r.kind == "merge" and r.is_main_merge),
                   key=lambda r: r.start)
    for a, b in zip(mains, mains[1:]):
        if a.finish > b.start + 1e-9:
            bad.append(f"C16: main merges overlap ({a.start}..{a.finish}, {b.start})")

    # C9: on the main line, full-suite durations are monotonically increasing.
    # Top merges are serialised (C16), so ordering by merge completion == order
    # of the cumulative snapshot each top suite inherited.
    if cfg.test_exec == "full_suite":
        pairs = [
            (r.finish, r.duration)
            for r in records
            if r.kind == "suite" and r.is_main_merge
        ]
        pairs.sort(key=lambda p: p[0])
        durs = [d for _, d in pairs]
        if any(b < a - 1e-9 for a, b in zip(durs, durs[1:])):
            bad.append("C9: full-suite durations are not monotonically increasing")

    # C10 (generalised) + C18: suite runs occur exactly at the selected nodes
    # plus the optional release gate, and at least one test occurs before
    # release.
    actual_suites = sum(1 for r in records if r.kind == "suite")
    expected_suites = len(graph.suite_nodes) + (1 if graph.gate_suite is not None else 0)
    if actual_suites != expected_suites:
        bad.append(
            f"C10: {actual_suites} suite runs != {expected_suites} "
            f"(selected merge nodes + release gate; test_level={cfg.test_level!r})"
        )
    if actual_suites < 1:
        bad.append("C10: no suite run before release")
    if len(graph.suite_nodes) > len(graph.merge_nodes):
        bad.append("C18: test policy scheduled more suites than merges exist")

    # C17: every merge starts only after the work below it finished (edges cover
    # this via C12); additionally the merge count equals the tree size.
    if sum(1 for r in records if r.kind == "merge") != len(graph.merge_nodes):
        bad.append("C5/C7: merge count != number of non-root merge-tree nodes")

    return bad
