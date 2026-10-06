"""Editable task graph over the 16 spec-3.3 task types (spec 3.6, C19/C20).

Spec 3.6 makes the task set a *user-editable input*::

    T_active   subset of the 16 task types ACTIVE in this scenario
    P          precedence relation over ACTIVE task instances -- a DAG

The 16 task types of spec 3.3 are a **catalogue**.  This module is the
catalogue, the default precedence graph, the C19/C20 validator, and the
Appendix-D expected-cost roll-up (``expected_cost_per_item``).

Defaults preserve current behaviour
-----------------------------------
:data:`DEFAULT_TASK_GRAPH` activates all 16 catalogue types with the canonical
pipeline edges.  When a :class:`~pipeline_sim.config.PipelineConfig` carries no
``T_active``/``P`` override, :func:`spec_from_config` returns that default and
nothing downstream changes.  The two optional gates (``triage`` / ``spec``)
still follow the config's ``y_triage`` / ``y_spec`` flags in the default case;
an explicit ``T_active`` override becomes authoritative for them.

Simulator coverage vs the catalogue
-----------------------------------
The SimPy engine currently *instantiates* only a subset of the catalogue
(``triage``, ``spec``, ``implement``, ``test_write``, ``test_run``, ``wt_setup``,
``merge_resolve``, ``gates``, ``release``).  Every :class:`TaskType` carries an
``implemented`` flag; ``expected_cost_per_item`` reports the full declared graph
regardless, so a scenario that enables a catalogue-only type is cost-accounted
here even though the engine does not yet realise it.  This is surfaced, never
hidden.

Costs
-----
Per-fire cost is the Appendix D ``total$/fire`` column: the LLM token cost at
the Appendix C prices (:func:`~pipeline_sim.config.llm_cost` over the raw token
magnitudes in :class:`~pipeline_sim.config.TaskTokens`) plus the per-fire CI
component.  Occurrence counts are derived from the realised structure
(``M``, ``alpha``, buckets, merge-tree nodes, selected suite nodes) so the
roll-up cannot drift from the model.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Dict, Iterator, List, Optional, Sequence, Tuple

from .config import DEFAULT_TOKENS, PipelineConfig, llm_cost
from .model import build_branch_tree, select_suite_nodes

# ---------------------------------------------------------------------------
# the catalogue (spec 3.3 + Appendix D)
# ---------------------------------------------------------------------------
#: Occurrence scope -- how many times a task type fires in a scenario.
SCOPE_LABELS: Dict[str, str] = {
    "per_ticket": "per ticket",
    "per_ac": "per acceptance criterion",
    "per_bucket": "per bucket",
    "per_review": "per review",
    "per_worktree": "per worktree",
    "per_merge_node": "per merge node",
    "per_merge_to_main": "per merge-to-main",
    "global": "global (once)",
}

#: The spec-3.6 TaskType ``scope`` vocabulary -> the internal occurrence key.
#: Catalogue entries already use the internal key; custom types (spec 3.6) use
#: the short enum.
SCOPE_ALIASES: Dict[str, str] = {
    "ticket": "per_ticket",
    "ac": "per_ac",
    "bucket": "per_bucket",
    "review": "per_review",
    "worktree": "per_worktree",
    "merge_node": "per_merge_node",
    "merge_to_main": "per_merge_to_main",
    "global": "global",
}


def normalize_scope(scope: str) -> str:
    """Map a spec-3.6 scope name (``ticket``) or internal key to the internal key."""
    return SCOPE_ALIASES.get(scope, scope)


@dataclass(frozen=True)
class TaskType:
    """One task type -- catalogue (spec 3.3) or custom (spec 3.6).

    The catalogue fixes ``token_field`` + ``ci_per_fire`` so the Appendix-D cost
    is derived from :class:`~pipeline_sim.config.TaskTokens` (single source of
    truth).  A custom type may instead carry explicit ``in_tok``/``out_tok`` or
    an explicit ``c_op`` (USD), its own ``t_op`` duration, ``tool_calls`` and
    default predecessor/successor edges -- exactly the schema of spec 3.6.

    Fields after ``note`` were added additively so the existing catalogue
    construction (positional through ``note``) is unchanged.
    """

    id: str
    label: str
    scope: str
    token_field: str
    ci_per_fire: float = 0.0
    implemented: bool = False
    optional: bool = False
    note: str = ""

    # --- spec 3.6 schema (custom types; catalogue leaves them defaulted) -----
    name: str = ""                       # display name (falls back to ``label``)
    phase: str = ""                      # intake|planning|build|verify|vcs|...
    t_op: float = 0.0                    # operation duration, seconds
    in_tok: Optional[int] = None         # op-own tokens (Appendix C decomposition)
    out_tok: Optional[int] = None
    c_op: Optional[float] = None         # explicit USD override
    tool_calls: int = 0                  # O_nu per fire
    default_predecessors: Tuple[str, ...] = ()
    default_successors: Tuple[str, ...] = ()
    custom: bool = False                 # True for spec-3.6 user-added types

    def scope_key(self) -> str:
        """Internal occurrence key (``per_ticket`` …) for this type's scope."""
        return normalize_scope(self.scope)

    @property
    def display_name(self) -> str:
        return self.name or self.label

    @property
    def llm_per_fire(self) -> float:
        if self.c_op is not None:
            return self.c_op
        if self.in_tok is not None or self.out_tok is not None:
            return llm_cost(self.in_tok or 0, self.out_tok or 0)
        if self.token_field:
            return llm_cost(*getattr(DEFAULT_TOKENS, self.token_field))
        return 0.0

    @property
    def per_fire(self) -> float:
        """Appendix D ``total$/fire`` = LLM token cost + CI component."""
        return self.llm_per_fire + self.ci_per_fire


#: The 16 spec-3.3 task types, in catalogue order.  Every type active in a
#: scenario is now instantiated by the engine (spec 3.3, BL 51ec18ef/f3a9eeb5).
TASK_TYPES: Tuple[TaskType, ...] = (
    TaskType("intake", "Ticket intake", "per_ticket", "intake",
             implemented=True, name="Ticket intake", phase="intake"),
    TaskType("routing", "Ticket routing", "per_ticket", "routing",
             implemented=True, name="Ticket routing", phase="intake"),
    TaskType("triage", "Triage (optional)", "per_ticket", "triage",
             implemented=True, optional=True, name="Triage", phase="intake",
             note="gate: cfg.y_triage / T_active"),
    TaskType("spec", "Spec (optional)", "per_ticket", "spec",
             implemented=True, optional=True, name="Spec", phase="intake",
             note="gate: cfg.y_spec / T_active"),
    TaskType("plan", "Execution plan (bucketing)", "per_bucket", "plan",
             implemented=True, name="Execution plan", phase="planning"),
    TaskType("implement", "Implementation", "per_ticket", "impl",
             implemented=True, name="Implementation", phase="build"),
    TaskType("test_write", "Test writing", "per_ac", "test_write_per_ac",
             implemented=True, name="Test writing", phase="build"),
    TaskType("test_run", "Test running", "per_ac", "test_run_per_ac",
             ci_per_fire=0.0027, implemented=True, name="Test running",
             phase="verify"),
    TaskType("review", "Code review", "per_ticket", "review",
             implemented=True, name="Code review", phase="verify"),
    TaskType("review_routing", "Review routing", "per_review", "review_routing",
             implemented=True, name="Review routing", phase="verify"),
    TaskType("wt_setup", "Git worktree setup", "per_worktree", "setup",
             ci_per_fire=0.003, implemented=True, name="Git worktree setup",
             phase="vcs", note="engine kind 'setup'"),
    TaskType("merge_resolve", "Worktree merge + resolution", "per_merge_node", "merge",
             ci_per_fire=0.016, implemented=True, name="Worktree merge + resolution",
             phase="vcs", note="engine kind 'merge'"),
    TaskType("main_build", "Main build", "per_merge_to_main", "main_build",
             ci_per_fire=0.040, implemented=True, name="Main build",
             phase="integrate"),
    TaskType("gates", "Pre-release gates", "global", "pre_release",
             implemented=True, name="Pre-release gates", phase="release",
             note="engine kind 'pre_release'"),
    TaskType("release", "Release", "global", "release", implemented=True,
             name="Release", phase="release"),
    TaskType("post_verify", "Post-release verification", "global", "post_verify",
             implemented=True, name="Post-release verification", phase="release"),
)

TASK_TYPE_IDS: Tuple[str, ...] = tuple(t.id for t in TASK_TYPES)
TASK_TYPE_BY_ID: Dict[str, TaskType] = {t.id: t for t in TASK_TYPES}
CATALOGUE_IDS: frozenset = frozenset(TASK_TYPE_IDS)


def catalogue_for(cfg=None) -> Tuple[TaskType, ...]:
    """The catalogue plus any custom task types carried by ``cfg`` (spec 3.6)."""
    custom = tuple(getattr(cfg, "custom_task_types", ()) or ()) if cfg is not None else ()
    return TASK_TYPES + custom if custom else TASK_TYPES


def type_map(cfg=None) -> Dict[str, TaskType]:
    """``id -> TaskType`` over :func:`catalogue_for`."""
    return {t.id: t for t in catalogue_for(cfg)}


def custom_edges(cfg) -> Tuple[Tuple[str, str], ...]:
    """Default precedence edges contributed by custom task types (spec 3.6)."""
    out: List[Tuple[str, str]] = []
    for ct in (getattr(cfg, "custom_task_types", ()) or ()):
        for p in ct.default_predecessors:
            out.append((p, ct.id))
        for s in ct.default_successors:
            out.append((ct.id, s))
    return tuple(out)


# ---------------------------------------------------------------------------
# default precedence graph (the OPERATOR topology, spec 5.2; type level)
# ---------------------------------------------------------------------------
#: Canonical pipeline edges -- the operator's intended flow (spec 5.2)::
#:
#:     intake -> {triage, spec}             triage and spec run in PARALLEL
#:     {triage, spec} -> routing
#:     routing -> {implement, test_write}   implement and test-write in PARALLEL
#:     implement -> review                  review depends on implementation ONLY
#:     test_write -> test_run               test_run depends on test-write (NOT impl)
#:     {review, test_run} -> merge-to-main  BOTH must finish before the merge
#:     merge-to-main -> [release gate] -> release
#:
#: ``merge-to-main`` is the catalogue's ``merge_resolve`` (+ ``main_build``);
#: ``release gate`` is ``gates`` (a full suite run may sit there, spec 10.2/5.2).
#: ``plan`` is deliberately absent: its placement is a VARIANT (before routing
#: or before implement, ``cfg.plan_position``) and is wired by the engine.
DEFAULT_EDGES: Tuple[Tuple[str, str], ...] = (
    # intake -> {triage, spec}   (PARALLEL)
    ("intake", "triage"),
    ("intake", "spec"),
    # {triage, spec} -> routing.  ``intake -> routing`` is the canonical
    # fallback when both optional gates are toggled off (the engine wires it
    # directly), so the type-level graph stays connected.
    ("triage", "routing"),
    ("spec", "routing"),
    ("intake", "routing"),
    # routing -> {implement, test_write}   (PARALLEL)
    ("routing", "implement"),
    ("routing", "test_write"),
    # implement -> review   (review depends on IMPLEMENT ONLY)
    ("implement", "review"),
    # test_write -> test_run   (NOT implement; C6 relaxed per 5.2)
    ("test_write", "test_run"),
    # {review, test_run} -> merge-to-main
    ("review", "merge_resolve"),
    ("test_run", "merge_resolve"),
    # review routing is a catalogue side-task of the review pipeline
    ("review", "review_routing"),
    ("review_routing", "merge_resolve"),
    # worktree setup precedes its merge; merge-to-main builds on main
    ("wt_setup", "merge_resolve"),
    ("merge_resolve", "main_build"),
    # merge-to-main -> [release gate] -> release
    ("merge_resolve", "gates"),     # literal "merge-to-main -> [release gate]"
    ("main_build", "gates"),
    ("gates", "release"),
    ("release", "post_verify"),
)

#: C20 -- domain-mandated edges of the operator topology (spec 5.2).  They may
#: be *added to* but never *removed*; ``validate_task_graph`` warns (does not
#: reject) when one is absent.
REQUIRED_EDGES: Tuple[Tuple[str, str], ...] = (
    ("implement", "review"),        # review depends on implementation ONLY
    ("test_write", "test_run"),     # C6 RELAXED: a run follows its tests only
    ("review", "merge_resolve"),    # {review, test_run} -> merge-to-main
    ("test_run", "merge_resolve"),
    ("merge_resolve", "gates"),     # merge-to-main -> [release gate]
    ("gates", "release"),           # [release gate] -> release
)


@dataclass(frozen=True)
class TaskGraphSpec:
    """A concrete scenario task graph (``T_active`` + ``P``)."""

    active: Tuple[str, ...]
    edges: Tuple[Tuple[str, str], ...]

    def active_set(self) -> frozenset:
        return frozenset(self.active)

    def effective_edges(self) -> Tuple[Tuple[str, str], ...]:
        """Edges whose two endpoints are both active (deduped, order-stable)."""
        active = self.active_set()
        seen = set()
        out: List[Tuple[str, str]] = []
        for a, b in self.edges:
            if a in active and b in active and (a, b) not in seen:
                seen.add((a, b))
                out.append((a, b))
        return tuple(out)


#: The default graph: all 16 types active, canonical edges.  This is the
#: "current fixed graph" at the catalogue level; it is what the editor starts
#: from and what a config with no override resolves to.
DEFAULT_TASK_GRAPH = TaskGraphSpec(active=TASK_TYPE_IDS, edges=DEFAULT_EDGES)


def spec_from_config(cfg: PipelineConfig) -> TaskGraphSpec:
    """Resolve ``cfg``'s task graph, falling back to :data:`DEFAULT_TASK_GRAPH`.

    No override (both ``T_active`` and ``P`` ``None``) and no custom types ->
    the default graph, so existing behaviour is unchanged.  A partial override
    (only one of the two) keeps the other half of the default.  Custom task
    types (spec 3.6) are always added to the active set and contribute their
    default predecessor/successor edges.
    """
    custom = tuple(getattr(cfg, "custom_task_types", ()) or ())
    if cfg.T_active is None and cfg.P is None and not custom:
        return DEFAULT_TASK_GRAPH

    if cfg.T_active is not None:
        active = tuple(cfg.T_active)
    elif custom:
        active = DEFAULT_TASK_GRAPH.active
    else:
        active = DEFAULT_TASK_GRAPH.active
    # custom types are explicitly added -> always active unless a T_active
    # override omits them *and* did not intend to include them; keep them in.
    if custom:
        have = set(active)
        active = active + tuple(t.id for t in custom if t.id not in have)

    edges = tuple(cfg.P) if cfg.P is not None else DEFAULT_TASK_GRAPH.edges
    if custom:
        edges = edges + custom_edges(cfg)
    return TaskGraphSpec(active=active, edges=edges)


def effective_active(cfg: PipelineConfig, spec: Optional[TaskGraphSpec] = None
                     ) -> frozenset:
    """The active types that actually fire for ``cfg``.

    In the *default* case (no ``T_active`` override) the optional gates follow
    the config flags: ``triage`` / ``spec`` are dropped from the active set when
    ``y_triage`` / ``y_spec`` is off, exactly matching the engine.  An explicit
    ``T_active`` override is authoritative -- listing a gate turns it on.
    """
    spec = spec or spec_from_config(cfg)
    active = set(spec.active)
    if cfg.T_active is None:
        if not cfg.y_triage:
            active.discard("triage")
        if not cfg.y_spec:
            active.discard("spec")
    return frozenset(active)


# ---------------------------------------------------------------------------
# validation (C19 acyclic, C20 required edges)
# ---------------------------------------------------------------------------
@dataclass
class TaskGraphValidation:
    """Outcome of :func:`validate_task_graph`.

    ``errors`` reject the graph (C19 cycle, unknown type, self-loop).
    ``warnings`` are advisory (C20 missing required edge, dangling edge).
    """

    errors: List[str] = field(default_factory=list)
    warnings: List[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors


def find_cycle(spec: TaskGraphSpec) -> Optional[List[str]]:
    """Return one cycle (as a node list) in the effective graph, else ``None``.

    Iterative tricolour DFS over the effective graph (C19).  Deterministic:
    roots and successors are visited in sorted order, so a malformed graph always
    reports the same cycle.  The returned list starts and ends at the same node.
    """
    active = sorted(spec.active_set())
    succ: Dict[str, List[str]] = {a: [] for a in active}
    for a, b in spec.effective_edges():
        succ[a].append(b)
    for a in active:
        succ[a].sort()

    WHITE, GREY, BLACK = 0, 1, 2
    color: Dict[str, int] = {a: WHITE for a in active}
    for root in active:
        if color[root] != WHITE:
            continue
        color[root] = GREY
        stack: List[str] = [root]
        work: List[Tuple[str, Iterator[str]]] = [(root, iter(succ[root]))]
        while work:
            node, it = work[-1]
            descended = False
            for m in it:                      # resumable iterator
                if color[m] == GREY:          # back edge -> cycle
                    return stack[stack.index(m):] + [m]
                if color[m] == WHITE:
                    color[m] = GREY
                    stack.append(m)
                    work.append((m, iter(succ[m])))
                    descended = True
                    break
            if not descended:
                color[node] = BLACK
                work.pop()
                stack.pop()
    return None


def topological_order(spec: TaskGraphSpec) -> List[str]:
    """A topological order of the active types; raises ``ValueError`` on a cycle."""
    cyc = find_cycle(spec)
    if cyc is not None:
        raise ValueError("precedence graph is cyclic (C19): " + " -> ".join(cyc))
    active = spec.active_set()
    succ: Dict[str, List[str]] = {a: [] for a in active}
    indeg: Dict[str, int] = {a: 0 for a in active}
    for a, b in spec.effective_edges():
        succ[a].append(b)
        indeg[b] += 1
    from collections import deque

    q = deque(sorted(a for a in active if indeg[a] == 0))
    order: List[str] = []
    while q:
        n = q.popleft()
        order.append(n)
        for m in succ[n]:
            indeg[m] -= 1
            if indeg[m] == 0:
                q.append(m)
    return order


def validate_task_graph(spec: TaskGraphSpec, cfg=None) -> TaskGraphValidation:
    """C19/C20 validation -- errors reject, warnings advise.

    ``cfg`` (optional) supplies any custom task types (spec 3.6) beyond the
    16-type catalogue; when omitted only the catalogue is known.
    """
    rep = TaskGraphValidation()
    active = spec.active_set()
    types = type_map(cfg)

    # unknown ids
    for a, b in spec.edges:
        for x in (a, b):
            if x not in types:
                rep.errors.append(f"unknown task type {x!r} (not in the catalogue)")
    for x in spec.active:
        if x not in types:
            rep.errors.append(f"unknown active task type {x!r}")

    # self loops
    for a, b in spec.edges:
        if a == b:
            rep.errors.append(f"self-loop on {a!r}")

    # dangling edges (an endpoint is not active) -- advisory.  An edge into an
    # *optional* gate that is toggled off is expected-dormant (the canonical
    # graph keeps its gate edges), so it is not warned; a dangling edge into a
    # required type is.
    for a, b in spec.edges:
        if a in types and b in types:
            off = a if a not in active else (b if b not in active else None)
            if off is not None and not types[off].optional:
                rep.warnings.append(
                    f"edge {a}->{b} touches inactive type {off!r}; ignored")

    # C19: acyclicity of the effective graph
    cyc = find_cycle(spec)
    if cyc is not None:
        rep.errors.append("C19: precedence graph is cyclic: " + " -> ".join(cyc))

    # C20: the graph must CONTAIN every domain-required edge.  A required edge
    # is unmet either because it was removed outright or because one endpoint is
    # inactive (dropping ``merge_resolve`` while keeping ``release`` violates the
    # "merges -> release" requirement just as surely).
    eff = set(spec.effective_edges())
    for a, b in REQUIRED_EDGES:
        if (a, b) in eff:
            continue
        inactive = [x for x in (a, b) if x not in active]
        if not inactive:
            rep.warnings.append(f"C20: missing domain-required edge {a}->{b}")
        else:
            rep.warnings.append(
                f"C20: domain-required edge {a}->{b} unmet "
                f"(inactive: {', '.join(inactive)})")

    return rep


# ---------------------------------------------------------------------------
# occurrences + Appendix-D expected cost
# ---------------------------------------------------------------------------
def _scope_occurrences(cfg: PipelineConfig, scope_key: str, *,
                       M: int, ac_total: int, buckets: int,
                       work_nodes: int, top_nodes: int) -> int:
    """Occurrences for one scope key (Appendix D "scope" column).

    ``per_ac`` uses the REALISED total AC count (spec C4 revised): under the
    0-heavy distribution a ticket with 0 ACs contributes no per-AC occurrence.
    """
    return {
        "per_ticket": M,
        "per_ac": ac_total,
        "per_bucket": buckets,
        "per_review": M,
        "per_worktree": work_nodes,
        "per_merge_node": work_nodes,
        "per_merge_to_main": top_nodes,
        "global": 1,
    }.get(scope_key, 0)


def _raw_occurrences(cfg: PipelineConfig) -> Dict[str, int]:
    """Unfiltered occurrence count per catalogue/custom type from the structure."""
    M = cfg.M
    # realised total acceptance criteria (spec C4 revised): 0-heavy distribution
    # in the shipped scenario, else M * alpha in the legacy uniform mode.
    ac_total = cfg.total_ac(M)
    b = cfg.num_buckets
    levels = cfg.resolved_branch_levels()
    _main, non_root, top_nodes = build_branch_tree(M, levels, cfg.branch_fanout)
    mode, lvl = cfg.resolved_test_level()
    suite_nodes = select_suite_nodes(non_root, mode, lvl)
    raw: Dict[str, int] = {
        "intake": M,
        "routing": M,
        "triage": M,
        "spec": M,
        "plan": b,
        "implement": M,
        "test_write": ac_total,
        "test_run": ac_total,
        "review": M,
        "review_routing": M,
        "wt_setup": len(non_root),
        "merge_resolve": len(non_root),
        "main_build": len(top_nodes),
        "gates": 1,
        "release": 1,
        "post_verify": 1,
        # not catalogue types -- scenario extras (below)
        "dispatch": b,
        "suite": len(suite_nodes),
    }
    # custom task types (spec 3.6): occurrence from their scope
    for ct in (getattr(cfg, "custom_task_types", ()) or ()):
        raw[ct.id] = _scope_occurrences(
            cfg, ct.scope_key(), M=M, ac_total=ac_total, buckets=b,
            work_nodes=len(non_root), top_nodes=len(top_nodes),
        )
    return raw


def occurrence_counts(cfg: PipelineConfig,
                      spec: Optional[TaskGraphSpec] = None) -> Dict[str, int]:
    """Occurrence count per *active* catalogue/custom type (0 for inactive)."""
    spec = spec or spec_from_config(cfg)
    active = effective_active(cfg, spec)
    raw = _raw_occurrences(cfg)
    known = set(type_map(cfg))
    return {k: (v if k in active else 0) for k, v in raw.items() if k in known}


@dataclass(frozen=True)
class CostRow:
    """One line of the Appendix-D expected-cost roll-up."""

    id: str
    label: str
    scope: str
    per_fire: float
    occurrences: int
    implemented: bool
    note: str = ""

    @property
    def subtotal(self) -> float:
        return self.per_fire * self.occurrences


@dataclass
class ExpectedCostReport:
    """Per-item expected cost + the scenario total (spec Appendix D)."""

    rows: List[CostRow]
    extras: List[CostRow]
    total: float

    @property
    def items_total(self) -> float:
        return sum(r.subtotal for r in self.rows)

    @property
    def extras_total(self) -> float:
        return sum(r.subtotal for r in self.extras)

    def active_rows(self) -> List[CostRow]:
        return [r for r in self.rows if r.occurrences > 0]

    def as_dicts(self) -> List[Dict[str, object]]:
        out: List[Dict[str, object]] = []
        for r in self.rows:
            out.append({
                "task type": r.id,
                "label": r.label,
                "scope": r.scope,
                "implemented": r.implemented,
                "$/fire": round(r.per_fire, 6),
                "occurrences": r.occurrences,
                "subtotal $": round(r.subtotal, 6),
            })
        return out


def expected_cost_per_item(cfg: PipelineConfig,
                           spec: Optional[TaskGraphSpec] = None,
                           *, tool_calls: bool = True) -> ExpectedCostReport:
    """Appendix-D expected cost per active task type + the scenario total.

    ``rows``  one :class:`CostRow` per catalogue type (inactive types carry
    ``occurrences == 0`` and are dropped by :meth:`active_rows`).
    ``extras`` the non-task-type scenario lines: dispatch (fresh agent starts),
    suite runs (compounding, C9), the tool-call term, the rework expectation
    (A1, depth-1 per bucket) and the holding term (spec f2).
    ``total`` items + extras.
    """
    spec = spec or spec_from_config(cfg)
    active = effective_active(cfg, spec)
    counts = occurrence_counts(cfg, spec)

    rows: List[CostRow] = []
    for t in catalogue_for(cfg):
        per_fire = llm_per_fire(cfg, t) + t.ci_per_fire
        rows.append(CostRow(
            id=t.id, label=t.display_name,
            scope=SCOPE_LABELS[t.scope_key()],
            per_fire=per_fire,
            occurrences=counts.get(t.id, 0) if t.id in active else 0,
            implemented=t.implemented or t.custom, note=t.note,
        ))

    extras: List[CostRow] = []

    # dispatch -- one fresh agent start per bucket assignment (C17)
    dispatch_occ = cfg.num_buckets
    extras.append(CostRow(
        id="dispatch", label="Agent dispatch", scope="per fresh agent start",
        per_fire=cfg.c_dispatch, occurrences=dispatch_occ, implemented=True,
        note="C17: one dispatch per bucket assignment",
    ))

    # suite run -- c_suite + accumulated ACs (compounding, C9).  Expected
    # accumulated ACs for a selected node ~= its subtree AC count under
    # full_suite; the conservative (first-order) estimate is c_suite + unit_ac*c_a.
    _, non_root, _ = build_branch_tree(cfg.M, cfg.resolved_branch_levels(),
                                       cfg.branch_fanout)
    # realise each node's subtree AC count from the per-ticket vector (spec C4
    # revised): `build_branch_tree` alone leaves `unit_ac` at 0, which would
    # silently price the compounding suite at 0 ACs.
    _ac_list = cfg.ac_counts(cfg.M)
    for node in non_root:
        node.unit_ac = sum(_ac_list[t] for t in node.tickets)
    mode, lvl = cfg.resolved_test_level()
    suite_nodes = select_suite_nodes(non_root, mode, lvl)
    suite_cost = 0.0
    for node in suite_nodes:
        suite_cost += cfg.c_suite + node.unit_ac * cfg.c_a
    extras.append(CostRow(
        id="suite", label="Suite run (compounding)", scope="per selected merge node",
        per_fire=(suite_cost / len(suite_nodes)) if suite_nodes else 0.0,
        occurrences=len(suite_nodes), implemented=True,
        note="C9: c_suite + accumulated ACs x c_a",
    ))

    # tool calls (informational; Appendix D lists the row but omits it from the
    # printed formula -- included here because the engine charges it)
    if tool_calls:
        tool_total = _expected_tool_cost(cfg, counts)
        extras.append(CostRow(
            id="tool", label="Tool calls", scope="per tool call",
            per_fire=cfg.OC, occurrences=int(round(tool_total / cfg.OC)) if cfg.OC else 0,
            implemented=True, note="O_nu x OC",
        ))

    # rework expectation (A1: bounded depth-1, per bucket)
    rework_per_bucket = sum(
        llm_per_fire(cfg, TASK_TYPE_BY_ID[tid]) + TASK_TYPE_BY_ID[tid].ci_per_fire
        for tid in ("implement", "review", "review_routing")
    )
    extras.append(CostRow(
        id="rework", label="Rework expectation", scope="per bucket x p",
        per_fire=cfg.p * rework_per_bucket, occurrences=cfg.num_buckets,
        implemented=True, note="A1: implement + reconfirm + re-review",
    ))

    # holding term (spec f2: c_wip * n * horizon)
    extras.append(CostRow(
        id="holding", label="Holding", scope="n x horizon",
        per_fire=cfg.c_wip * cfg.n * cfg.horizon, occurrences=1,
        implemented=True, note="fixed planning horizon (spec 4 NOTE)",
    ))

    total = sum(r.subtotal for r in rows) + sum(r.subtotal for r in extras)
    return ExpectedCostReport(rows=rows, extras=extras, total=total)


#: catalogue type id -> the ``TaskOpCost`` field carrying its per-fire LLM cost.
#: Lets the Appendix-D roll-up honour a config's (calibrated) ``c_op`` instead of
#: always reading the shipped ``DEFAULT_TOKENS`` -- so the event-data calibration
#: (``cfg.op_event_profiles``) is reflected in the DAG cost preview.
_OP_COST_FIELD: Dict[str, str] = {
    "implement": "impl",
    "test_write": "test_write_per_ac",
    "test_run": "test_run_per_ac",
    "review": "review",
    "review_routing": "review_routing",
    "plan": "plan",
    "wt_setup": "setup",
    "merge_resolve": "merge",
    "main_build": "main_build",
    "gates": "pre_release",
    "release": "release",
    "post_verify": "post_verify",
    "triage": "triage",
    "spec": "spec",
    "intake": "intake",
    "routing": "routing",
}


def llm_per_fire(cfg: PipelineConfig, t: TaskType) -> float:
    """The LLM $/fire for a task type under ``cfg`` (honours a calibrated c_op).

    Catalogue types read :attr:`~pipeline_sim.config.PipelineConfig.c_op` (the
    single source of truth, which the event calibration re-derives); a custom
    type keeps its own declared ``c_op`` / tokens.  For the default config this
    equals :attr:`TaskType.llm_per_fire` exactly.
    """
    if t.custom:
        return t.llm_per_fire
    field = _OP_COST_FIELD.get(t.id)
    if field:
        return float(getattr(cfg.c_op, field))
    return t.llm_per_fire


#: tool calls per fire for catalogue types (mirrors config.ToolCalls).
_TOOL_CALLS_PER_FIRE: Dict[str, str] = {
    "implement": "impl",
    "test_write": "test_write_per_ac",
    "test_run": "test_run_per_ac",
    "wt_setup": "setup",
    "merge_resolve": "merge",
    "gates": "pre_release",
    "release": "release",
    "triage": "triage",
    "spec": "spec",
    "intake": "intake",
    "routing": "routing",
    "plan": "plan",
    "review": "review",
    "review_routing": "review_routing",
    "main_build": "main_build",
    "post_verify": "post_verify",
}


def _expected_tool_cost(cfg: PipelineConfig, counts: Dict[str, int]) -> float:
    tc = cfg.tool_calls
    total = 0.0
    for t in catalogue_for(cfg):
        n = counts.get(t.id, 0)
        if not n:
            continue
        if t.custom:
            total += t.tool_calls * n
        else:
            field = _TOOL_CALLS_PER_FIRE.get(t.id)
            if field:
                total += getattr(tc, field) * n
    return total * cfg.OC


# ---------------------------------------------------------------------------
# graphviz DOT preview
# ---------------------------------------------------------------------------
def to_dot(spec: TaskGraphSpec, cfg=None) -> str:
    """Render the task graph as a Graphviz DOT string (for the UI preview)."""
    active = spec.active_set()
    types = type_map(cfg)
    lines = ["digraph task_graph {", '  rankdir="LR";',
             '  node [shape=box, style="rounded,filled", fontname="Helvetica",' 
             f' fillcolor="#eef3f7", color="#7a9bb5"];',
             '  edge [color="#9aa7b1"];']
    for t in catalogue_for(cfg):
        if t.id not in active:
            continue
        if t.custom:
            fill, border = "#e8f7ee", "#7fc79a"   # custom (spec 3.6)
        elif not t.implemented:
            fill, border = "#fdf1e3", "#e0b980"   # catalogue-only (not simulated)
        elif t.optional:
            fill, border = "#f3e8ff", "#b98fdb"   # optional gate
        else:
            fill, border = "#eef3f7", "#7a9bb5"   # implemented
        lines.append(
            f'  "{t.id}" [label="{t.display_name}", fillcolor="{fill}", color="{border}"];')
    for a, b in spec.effective_edges():
        lines.append(f'  "{a}" -> "{b}";')
    lines.append("}")
    return "\n".join(lines)
