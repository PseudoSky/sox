"""Cross-component dependency / **publishing** graph (spec Appendix E.2).

The real serializer of an agentic-delivery pipeline is **not** file overlap.
Spec Appendix E.1 corrects the original model: the file-overlap graph (tickets
sharing a citation/body path) is a **citation artifact** -- shared evidence and
meta files (``CHANGELOG.md``, ``AGENTS.md``, ``apps/sox/src/main.ts``) -- and
must NOT be used to bound parallelism.

**Framing (corrected): the dependency DAG orders the PUBLISH stage, NOT
implementation.**  Within a project, component changes do **not** publish
between them: components are parallel-compatible (file-separated by design) and
their *implementation* runs concurrently.  Ordering is forced only when a
component **consumes a PUBLISHED (cross-project) artifact** -- the producer must
publish before the consumer builds against it.  So the DAG is a *release-stage*
(sequencing) graph, never an implementation schedule; see
:data:`PUBLISH_STAGE_FRAMING`.

The measured graph (spec §E.2, read-only 2026-10-05)
----------------------------------------------------
Source: the ``package.json`` ``workspace:`` edges plus the Nx project graph for
the ``sox-ecosystem`` monorepo.  :data:`MEASURED_COMPONENTS` / :data:`MEASURED_EDGES`
are that graph as an editable data table -- one row per component and one row
per ``(consumer, producer)`` edge (``consumer`` depends on ``producer``).

* **75 components** (every workspace package, including the private root); 30
  are publishable ``@adhd/sox-*``.
* **67 build/consume edges** (any ``workspace:`` range; ``A depends on B``).
* **27 strict changesets-cascade edges** (``workspace:*`` exact pin only).
* **Zero cycles** -- the publish order is a valid topological sort.

The scheduling model
--------------------
* Components publish **in dependency order**: an edge ``A -> B`` (A depends on
  B) forces ``B`` to publish before ``A`` can consume it.
* These edges give the **publish waves** (topological levels).  The full graph
  is **6 waves** (``L0=53 ... L5=4``); the strict cascade is **2 waves**.
* On a change, the **publish set** is the changed component plus its transitive
  dependents -- everything that must republish behind it.  A change to a
  **chokepoint** (``telemetry`` / ``store-adapter`` / ``listen-guard``) drags up
  to 14-19 downstream publishes into a serial **convoy**.
* Components with no dependency in or out are **independent** and always run in
  parallel: the **effective parallel width** is ~44 components -- not the 75-way
  component count, because the release is governed by the **6-wave critical
  path**.

Usage
-----
    from pipeline_sim.deps import measured_graph

    g = measured_graph()
    g.publish_waves()                      # 6 waves of component ids
    g.critical_path()                      # the release critical path
    g.publish_set("telemetry")             # 19 components (incl. the change)
    g.convoy("telemetry")                  # the serialized release stages
"""

from __future__ import annotations

from bisect import insort
from dataclasses import dataclass
from typing import Dict, FrozenSet, Iterable, Mapping, Optional, Sequence, Tuple


# ---------------------------------------------------------------------------
# provenance (spec Appendix E.2 -- measured, read-only 2026-10-05)
# ---------------------------------------------------------------------------
MEASURED_GRAPH_SOURCE = (
    "package.json workspace: edges + Nx project graph (spec Appendix E.2, "
    "read-only 2026-10-05)"
)
MEASURED_COMPONENT_COUNT = 75
MEASURED_EDGE_COUNT = 67
MEASURED_STRICT_EDGE_COUNT = 27

#: The corrected framing, stated once and surfaced in the report / app so no
#: reader can mistake this DAG for an implementation schedule.
PUBLISH_STAGE_FRAMING = (
    "The dependency DAG orders the PUBLISH stage, not implementation. Within a "
    "project, component changes do NOT publish between them: components are "
    "parallel-compatible (file-separated by design) and their implementation "
    "runs concurrently. Ordering is enforced only when a component CONSUMES a "
    "PUBLISHED (cross-project) artifact -- the producer must publish before the "
    "consumer can build against it. File overlap never bounds parallelism."
)

#: The reference chokepoints the measured graph yields (spec §E.2), as
#: ``(component, publish-set size)`` -- the changed component plus its
#: transitive dependents.  Order is largest-first (ties by component id).
MEASURED_CHOKEPOINTS: Tuple[Tuple[str, int], ...] = (
    ("telemetry", 19),
    ("store-adapter", 15),
    ("listen-guard", 15),
    ("service-proxy", 12),
    ("graph-store", 11),
    ("embedding-provider", 10),
)

#: The measured release critical path (spec §E.2).
MEASURED_CRITICAL_PATH: Tuple[str, ...] = (
    "listen-guard", "service-proxy", "embedding-provider", "hybrid-search",
    "memory-core", "extension-memory-flush",
)

#: The measured full-graph publish-wave *sizes* (spec §E.2: ``L0=53 ... L5=4``).
MEASURED_WAVE_SIZES: Tuple[int, ...] = (53, 5, 6, 4, 3, 4)
#: The measured strict-cascade wave sizes (spec §E.2: 2 waves).
MEASURED_STRICT_WAVE_SIZES: Tuple[int, ...] = (69, 6)
#: The measured effective parallel width: independent components (spec §E.2 ~44).
MEASURED_PARALLEL_WIDTH = 44


# ---------------------------------------------------------------------------
# the measured data table (editable)
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Component:
    """One workspace package in the measured component graph.

    ``id`` is the short component id (``@adhd/sox-`` stripped); ``package`` the
    full package name; ``area`` the factual workspace area the package lives in
    (the coarse "project" grouping -- ``libs`` / ``extensions`` / ``apps`` /
    ``packages`` / ``tools`` / ``root``); ``publishable`` whether it is a
    non-private package.
    """

    id: str
    package: str
    area: str
    publishable: bool


@dataclass(frozen=True)
class Dependency:
    """A build/consume edge: ``consumer`` depends on ``producer``.

    ``strict`` is True iff the range is an exact ``workspace:*`` pin -- the
    changesets cascade edge.  A non-strict edge still forces a rebuild/republish
    of the consumer under the conservative full-graph scheduling rule (spec
    §E.2).
    """

    consumer: str
    producer: str
    strict: bool = False


#: The 75 measured components (spec §E.2).  Editable data table.
MEASURED_COMPONENTS: Tuple[Component, ...] = (
    Component("analysis", "@adhd/sox-analysis", "libs", True),
    Component("authoring", "@adhd/sox-authoring", "libs", True),
    Component("baseline-capture", "@adhd/sox-baseline-capture", "tools", False),
    Component("blob-store", "@adhd/sox-blob-store", "libs", True),
    Component("claim-verification", "@adhd/sox-claim-verification", "libs", True),
    Component("cli", "@adhd/sox-cli", "apps", True),
    Component("embedding-provider", "@adhd/sox-embedding-provider", "libs", True),
    Component("exp", "exp", "libs", False),
    Component("extension-agent-manager", "@adhd/sox-extension-agent-manager", "extensions", False),
    Component("extension-agent-safety-audit", "@adhd/sox-extension-agent-safety-audit", "extensions", False),
    Component("extension-architect", "@adhd/sox-extension-architect", "extensions", False),
    Component("extension-architect-decision", "@adhd/sox-extension-architect-decision", "extensions", False),
    Component("extension-backlog-intake", "@adhd/sox-extension-backlog-intake", "extensions", False),
    Component("extension-backlog-operator", "@adhd/sox-extension-backlog-operator", "extensions", False),
    Component("extension-browser-testing", "@adhd/sox-extension-browser-testing", "extensions", False),
    Component("extension-debug", "@adhd/sox-extension-debug", "extensions", False),
    Component("extension-definition-of-ready", "@adhd/sox-extension-definition-of-ready", "extensions", False),
    Component("extension-demo-creator", "@adhd/sox-extension-demo-creator", "extensions", False),
    Component("extension-devops", "@adhd/sox-extension-devops", "extensions", False),
    Component("extension-di-command", "@adhd/sox-extension-di-command", "extensions", False),
    Component("extension-dispatch-contract", "@adhd/sox-extension-dispatch-contract", "extensions", False),
    Component("extension-dispatch-direct", "@adhd/sox-extension-dispatch-direct", "extensions", False),
    Component("extension-dispatch-plan", "@adhd/sox-extension-dispatch-plan", "extensions", False),
    Component("extension-dispatch-priority", "@adhd/sox-extension-dispatch-priority", "extensions", False),
    Component("extension-dispatch-status", "@adhd/sox-extension-dispatch-status", "extensions", False),
    Component("extension-dispatch-triage", "@adhd/sox-extension-dispatch-triage", "extensions", False),
    Component("extension-dispatcher", "@adhd/sox-extension-dispatcher", "extensions", False),
    Component("extension-doc-cartographer", "@adhd/sox-extension-doc-cartographer", "extensions", False),
    Component("extension-doc-consumer", "@adhd/sox-extension-doc-consumer", "extensions", False),
    Component("extension-doc-evangelist", "@adhd/sox-extension-doc-evangelist", "extensions", False),
    Component("extension-doc-reviewer", "@adhd/sox-extension-doc-reviewer", "extensions", False),
    Component("extension-doc-steward", "@adhd/sox-extension-doc-steward", "extensions", False),
    Component("extension-git-manager", "@adhd/sox-extension-git-manager", "extensions", False),
    Component("extension-iterative-research-refinement", "@adhd/sox-extension-iterative-research-refinement", "extensions", False),
    Component("extension-memory-cli", "@adhd/sox-extension-memory-cli", "extensions", True),
    Component("extension-memory-flush", "@adhd/sox-extension-memory-flush", "extensions", True),
    Component("extension-memory-server", "@adhd/sox-extension-memory-server", "extensions", True),
    Component("extension-memory-usage", "@adhd/sox-extension-memory-usage", "extensions", True),
    Component("extension-performance", "@adhd/sox-extension-performance", "extensions", False),
    Component("extension-performance-engineer", "@adhd/sox-extension-performance-engineer", "extensions", False),
    Component("extension-product", "@adhd/sox-extension-product", "extensions", False),
    Component("extension-project", "@adhd/sox-extension-project", "extensions", False),
    Component("extension-qa", "@adhd/sox-extension-qa", "extensions", False),
    Component("extension-research", "@adhd/sox-extension-research", "extensions", False),
    Component("extension-researcher", "@adhd/sox-extension-researcher", "extensions", False),
    Component("extension-security", "@adhd/sox-extension-security", "extensions", False),
    Component("extension-sox-ingest", "@adhd/sox-extension-sox-ingest", "extensions", False),
    Component("extension-sox-memory-bundle", "@adhd/sox-extension-sox-memory-bundle", "extensions", True),
    Component("extension-tokenguard", "@adhd/sox-extension-tokenguard", "extensions", False),
    Component("extension-tui-design", "@adhd/sox-extension-tui-design", "extensions", False),
    Component("extension-typescript", "@adhd/sox-extension-typescript", "extensions", False),
    Component("extension-ui", "@adhd/sox-extension-ui", "extensions", False),
    Component("extension-ui-playbooks", "@adhd/sox-extension-ui-playbooks", "extensions", False),
    Component("graph-store", "@adhd/sox-graph-store", "libs", True),
    Component("graph-store-conformance-consumer", "graph-store-conformance-consumer", "libs", False),
    Component("host-registry", "@adhd/sox-host-registry", "libs", True),
    Component("host-runtime", "@adhd/sox-host-runtime", "libs", True),
    Component("hybrid-search", "@adhd/sox-hybrid-search", "libs", True),
    Component("ingest", "@adhd/sox-ingest", "libs", True),
    Component("install-engine", "@adhd/sox-install-engine", "libs", True),
    Component("listen-guard", "@adhd/sox-listen-guard", "libs", True),
    Component("manifest", "@adhd/sox-manifest", "libs", True),
    Component("mcp-runtime", "@adhd/sox-mcp-runtime", "libs", True),
    Component("memory-core", "@adhd/sox-memory-core", "libs", True),
    Component("nx", "@adhd/sox-nx", "packages", False),
    Component("registry", "@adhd/sox-registry", "libs", True),
    Component("semantic", "@adhd/sox-semantic", "libs", True),
    Component("service-proxy", "@adhd/sox-service-proxy", "libs", True),
    Component("source-provider", "@adhd/sox-source-provider", "libs", True),
    Component("sox-ecosystem", "sox-ecosystem", "root", False),
    Component("store-adapter", "@adhd/sox-store-adapter", "libs", True),
    Component("task-queue", "@adhd/sox-task-queue", "libs", True),
    Component("telemetry", "@adhd/sox-telemetry", "libs", True),
    Component("tokenguard-core", "@adhd/sox-tokenguard-core", "libs", True),
    Component("vector-store", "@adhd/sox-vector-store", "libs", True),
)

#: The 67 measured build/consume edges (spec §E.2), as ``Dependency`` rows.
#: ``A depends on B`` -> B must publish before A.  Editable data table.
MEASURED_EDGES: Tuple[Dependency, ...] = (
    Dependency("analysis", "graph-store"),
    Dependency("analysis", "store-adapter"),
    Dependency("analysis", "vector-store"),
    Dependency("baseline-capture", "memory-core"),
    Dependency("baseline-capture", "store-adapter"),
    Dependency("blob-store", "store-adapter"),
    Dependency("claim-verification", "blob-store"),
    Dependency("claim-verification", "embedding-provider"),
    Dependency("claim-verification", "hybrid-search"),
    Dependency("cli", "authoring"),
    Dependency("cli", "embedding-provider"),
    Dependency("cli", "host-registry"),
    Dependency("cli", "host-runtime"),
    Dependency("cli", "install-engine"),
    Dependency("cli", "listen-guard"),
    Dependency("cli", "manifest"),
    Dependency("cli", "mcp-runtime"),
    Dependency("cli", "registry"),
    Dependency("cli", "service-proxy"),
    Dependency("cli", "telemetry"),
    Dependency("embedding-provider", "service-proxy"),
    Dependency("embedding-provider", "telemetry"),
    Dependency("extension-memory-cli", "embedding-provider"),
    Dependency("extension-memory-cli", "memory-core"),
    Dependency("extension-memory-cli", "service-proxy"),
    Dependency("extension-memory-cli", "store-adapter"),
    Dependency("extension-memory-cli", "telemetry"),
    Dependency("extension-memory-flush", "memory-core"),
    Dependency("extension-memory-flush", "store-adapter"),
    Dependency("extension-memory-flush", "telemetry"),
    Dependency("extension-memory-server", "mcp-runtime"),
    Dependency("extension-memory-server", "memory-core"),
    Dependency("extension-memory-server", "service-proxy"),
    Dependency("extension-memory-server", "store-adapter"),
    Dependency("extension-memory-server", "telemetry"),
    Dependency("extension-tokenguard", "listen-guard"),
    Dependency("extension-tokenguard", "tokenguard-core"),
    Dependency("graph-store", "store-adapter"),
    Dependency("graph-store", "telemetry"),
    Dependency("host-runtime", "listen-guard"),
    Dependency("hybrid-search", "embedding-provider"),
    Dependency("hybrid-search", "graph-store"),
    Dependency("hybrid-search", "store-adapter"),
    Dependency("hybrid-search", "vector-store"),
    Dependency("mcp-runtime", "host-runtime"),
    Dependency("mcp-runtime", "listen-guard"),
    Dependency("mcp-runtime", "service-proxy"),
    Dependency("mcp-runtime", "telemetry"),
    Dependency("memory-core", "analysis"),
    Dependency("memory-core", "embedding-provider"),
    Dependency("memory-core", "graph-store"),
    Dependency("memory-core", "hybrid-search"),
    Dependency("memory-core", "ingest"),
    Dependency("memory-core", "store-adapter"),
    Dependency("memory-core", "telemetry"),
    Dependency("nx", "authoring"),
    Dependency("semantic", "embedding-provider"),
    Dependency("semantic", "graph-store"),
    Dependency("semantic", "hybrid-search"),
    Dependency("semantic", "store-adapter"),
    Dependency("semantic", "vector-store"),
    Dependency("service-proxy", "listen-guard"),
    Dependency("sox-ecosystem", "graph-store"),
    Dependency("sox-ecosystem", "store-adapter"),
    Dependency("store-adapter", "telemetry"),
    Dependency("task-queue", "store-adapter"),
    Dependency("vector-store", "store-adapter"),
)

#: The 27 ``workspace:*`` exact-pin edges -- the changesets cascade surface.
STRICT_EDGES: FrozenSet[Tuple[str, str]] = frozenset({
    ("baseline-capture", "memory-core"),
    ("baseline-capture", "store-adapter"),
    ("cli", "authoring"),
    ("cli", "embedding-provider"),
    ("cli", "host-registry"),
    ("cli", "host-runtime"),
    ("cli", "install-engine"),
    ("cli", "manifest"),
    ("cli", "mcp-runtime"),
    ("cli", "registry"),
    ("cli", "service-proxy"),
    ("cli", "telemetry"),
    ("extension-memory-cli", "embedding-provider"),
    ("extension-memory-cli", "memory-core"),
    ("extension-memory-cli", "service-proxy"),
    ("extension-memory-cli", "store-adapter"),
    ("extension-memory-cli", "telemetry"),
    ("extension-memory-flush", "memory-core"),
    ("extension-memory-flush", "store-adapter"),
    ("extension-memory-flush", "telemetry"),
    ("extension-memory-server", "mcp-runtime"),
    ("extension-memory-server", "memory-core"),
    ("extension-memory-server", "service-proxy"),
    ("extension-memory-server", "store-adapter"),
    ("extension-memory-server", "telemetry"),
    ("sox-ecosystem", "graph-store"),
    ("sox-ecosystem", "store-adapter"),
})


# ---------------------------------------------------------------------------
# pure graph algorithms (nodes + a consumer->producers mapping)
# ---------------------------------------------------------------------------
def _reverse(deps: Mapping[str, Iterable[str]]) -> Dict[str, set]:
    rev: Dict[str, set] = {n: set() for n in deps}
    for consumer, producers in deps.items():
        for p in producers:
            rev.setdefault(p, set()).add(consumer)
    return rev


def topological_order(nodes: Sequence[str], deps: Mapping[str, Iterable[str]]) -> Tuple[str, ...]:
    """Kahn sort, producers before consumers (deterministic, lexicographic).

    ``deps[n]`` is the set of producers ``n`` depends on.  Raises ``ValueError``
    on a cycle (the measured graph has none).
    """
    nodes = list(nodes)
    rev = _reverse({n: deps.get(n, ()) for n in nodes})
    indeg: Dict[str, int] = {n: len(set(deps.get(n, ()))) for n in nodes}
    ready = sorted(n for n in nodes if indeg[n] == 0)
    order = []
    while ready:
        n = ready.pop(0)
        order.append(n)
        for c in sorted(rev.get(n, ())):
            indeg[c] -= 1
            if indeg[c] == 0:
                insort(ready, c)
    if len(order) != len(nodes):
        raise ValueError("dependency graph contains a cycle")
    return tuple(order)


def topological_waves(nodes: Sequence[str], deps: Mapping[str, Iterable[str]]
                      ) -> Tuple[Tuple[str, ...], ...]:
    """Longest-path layering: wave ``i`` = components whose longest upstream
    chain ends after ``i`` predecessors.  Producers land in earlier waves."""
    order = topological_order(nodes, deps)
    level: Dict[str, int] = {}
    for n in order:
        producers = deps.get(n, ())
        level[n] = (max(level[p] for p in producers) + 1) if producers else 0
    depth = max(level.values()) if level else -1
    waves: list = [[] for _ in range(depth + 1)]
    for n in sorted(nodes):
        waves[level[n]].append(n)
    return tuple(tuple(w) for w in waves)


def longest_path(nodes: Sequence[str], deps: Mapping[str, Iterable[str]],
                 prefer_terminals: Sequence[str] = ()) -> Tuple[str, ...]:
    """The longest dependency chain (the release critical path).

    Deterministic.  Chains are ranked first by length (longest wins); among
    equal-length chains the one whose terminal appears in ``prefer_terminals``
    wins (so a *measured* reference chain is reproduced verbatim), and any
    remaining ties are broken toward the lexicographically smallest path.

    The tie-break exists because the longest chain is frequently **not unique**:
    the measured graph has four equal-length (6-node) chains ending at
    ``baseline-capture`` and the three memory-bundle extensions.  The spec
    measured ``extension-memory-flush`` as the release critical path, so that
    terminal is preferred by default at the summary level.
    """
    order = topological_order(nodes, deps)
    preferred = {t: i for i, t in enumerate(prefer_terminals)}
    best: Dict[str, Tuple[str, ...]] = {}
    for n in order:
        producers = deps.get(n, ())
        if not producers:
            best[n] = (n,)
        else:
            best[n] = min(
                (best[p] + (n,) for p in producers),
                key=lambda t: (-len(t), t),
            )
    if not best:
        return ()

    def rank(t: Tuple[str, ...]) -> Tuple[int, int, Tuple[str, ...]]:
        # longest first, then preferred terminal (0 = most preferred), then lexical
        return (-len(t), preferred.get(t[-1], len(preferred)), t)

    return min(best.values(), key=rank)


# ---------------------------------------------------------------------------
# the graph object
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class PublishPlan:
    """A single change's release plan: the changed component plus every
    component that must (re)publish behind it, in publish order.

    ``waves`` are the release stages of the induced subgraph -- the **convoy**:
    each stage may run in parallel internally, but a later stage waits for the
    one before it.
    """

    changed: str
    publish_set: Tuple[str, ...]
    waves: Tuple[Tuple[str, ...], ...]

    @property
    def size(self) -> int:
        """Number of publishes the change forces (including itself)."""
        return len(self.publish_set)

    @property
    def dependents(self) -> int:
        """Transitive downstream components (excludes the changed one)."""
        return self.size - 1

    @property
    def depth(self) -> int:
        """Serial release stages in the convoy (>= 1)."""
        return len(self.waves)


class ComponentGraph:
    """The measured component dependency DAG + publish scheduling.

    ``edges`` are ``(consumer, producer)`` pairs -- consumer depends on
    producer, so producer publishes first.
    """

    def __init__(self, components: Iterable[Component], edges: Iterable[Dependency]):
        self.components: Tuple[Component, ...] = tuple(components)
        self.edges: Tuple[Dependency, ...] = tuple(edges)
        self._by_id: Dict[str, Component] = {c.id: c for c in self.components}
        unknown = {e.consumer for e in self.edges} | {e.producer for e in self.edges}
        unknown -= set(self._by_id)
        if unknown:
            raise ValueError(f"edges reference unknown components: {sorted(unknown)}")
        self._deps: Dict[str, FrozenSet[str]] = {
            c.id: frozenset() for c in self.components
        }
        for e in self.edges:
            self._deps[e.consumer] = self._deps[e.consumer] | {e.producer}
        self._rdeps = {n: frozenset(s) for n, s in _reverse(self._deps).items()}

    # -- identity -----------------------------------------------------------
    @property
    def ids(self) -> Tuple[str, ...]:
        return tuple(c.id for c in self.components)

    def __len__(self) -> int:
        return len(self.components)

    # -- ordering -----------------------------------------------------------
    def is_acyclic(self) -> bool:
        try:
            topological_order(self.ids, self._deps)
            return True
        except ValueError:
            return False

    def publish_order(self) -> Tuple[str, ...]:
        """The full publish order (producers first)."""
        return topological_order(self.ids, self._deps)

    def publish_waves(self) -> Tuple[Tuple[str, ...], ...]:
        """The publish waves (topological levels) of the full graph."""
        return topological_waves(self.ids, self._deps)

    def strict_waves(self) -> Tuple[Tuple[str, ...], ...]:
        """The publish waves when only the strict ``workspace:*`` changesets
        cascade edges are honoured."""
        strict_deps = {c.id: frozenset() for c in self.components}
        for e in self.edges:
            if e.strict or (e.consumer, e.producer) in STRICT_EDGES:
                strict_deps[e.consumer] = strict_deps[e.consumer] | {e.producer}
        return topological_waves(self.ids, strict_deps)

    def critical_path(self, prefer_terminals: Sequence[str] = ()) -> Tuple[str, ...]:
        """The longest dependency chain -- the release critical path.

        ``prefer_terminals`` disambiguates equal-length chains (see
        :func:`longest_path`).
        """
        return longest_path(self.ids, self._deps, prefer_terminals)

    # -- dependencies -------------------------------------------------------
    def dependencies(self, comp: str, transitive: bool = False) -> FrozenSet[str]:
        """Components ``comp`` depends on (upstream)."""
        if comp not in self._by_id:
            raise KeyError(comp)
        if not transitive:
            return self._deps[comp]
        seen: set = set()
        stack = list(self._deps[comp])
        while stack:
            x = stack.pop()
            if x in seen:
                continue
            seen.add(x)
            stack.extend(self._deps[x])
        return frozenset(seen)

    def dependents(self, comp: str, transitive: bool = True) -> FrozenSet[str]:
        """Components that depend on ``comp`` (downstream)."""
        if comp not in self._by_id:
            raise KeyError(comp)
        if not transitive:
            return self._rdeps[comp]
        seen: set = set()
        stack = list(self._rdeps[comp])
        while stack:
            x = stack.pop()
            if x in seen:
                continue
            seen.add(x)
            stack.extend(self._rdeps[x])
        return frozenset(seen)

    # -- change / release ---------------------------------------------------
    def publish_set(self, changed: str) -> Tuple[str, ...]:
        """The changed component plus every transitive dependent, in publish
        order (producers first).  This is what a change republishes."""
        if changed not in self._by_id:
            raise KeyError(changed)
        members = {changed} | set(self.dependents(changed, transitive=True))
        return tuple(n for n in self.publish_order() if n in members)

    def publish_set_size(self, changed: str) -> int:
        return len(self.publish_set(changed))

    def convoy(self, changed: str) -> PublishPlan:
        """The release-stage convoy a change drags behind it.

        The induced subgraph on the publish set, laid out in waves: each wave is
        a set of publishes that may proceed in parallel, and the next wave waits
        for the previous one.  A chokepoint change (``telemetry`` /
        ``store-adapter`` / ``listen-guard``) produces a deep convoy of up to
        14-19 downstream publishes.
        """
        members = set(self.publish_set(changed))
        sub_deps = {
            n: frozenset(p for p in self._deps[n] if p in members)
            for n in members
        }
        waves = topological_waves(sorted(members), sub_deps)
        return PublishPlan(
            changed=changed,
            publish_set=tuple(n for w in waves for n in w),
            waves=waves,
        )

    # -- parallelism --------------------------------------------------------
    def independent(self) -> Tuple[str, ...]:
        """Components with no dependency in or out -- always parallel."""
        return tuple(
            c.id for c in self.components
            if not self._deps[c.id] and not self._rdeps[c.id]
        )

    def parallel_width(self) -> int:
        """Effective parallel width -- the independent-component count."""
        return len(self.independent())

    def chokepoints(self, limit: Optional[int] = None) -> Tuple[Tuple[str, int], ...]:
        """Components whose change forces the most downstream publishes.

        Ranked by publish-set size (including the changed component); ties are
        broken by component id.  This is the measured chokepoint list.
        """
        ranked = sorted(
            ((c.id, self.publish_set_size(c.id)) for c in self.components),
            key=lambda kv: (-kv[1], kv[0]),
        )
        return tuple(ranked if limit is None else ranked[:limit])

    # -- summary ------------------------------------------------------------
    def summary(self, chokepoint_limit: int = 6) -> "GraphSummary":
        waves = self.publish_waves()
        return GraphSummary(
            components=len(self.components),
            edges=len(self.edges),
            strict_edges=sum(1 for e in self.edges if e.strict
                             or (e.consumer, e.producer) in STRICT_EDGES),
            acyclic=self.is_acyclic(),
            waves=waves,
            strict_waves=self.strict_waves(),
            critical_path=self.critical_path(
                prefer_terminals=(MEASURED_CRITICAL_PATH[-1],)
            ),
            independent=self.independent(),
            chokepoints=self.chokepoints(chokepoint_limit),
        )


@dataclass(frozen=True)
class GraphSummary:
    """A computed read-out of the component graph for the app/report."""

    components: int
    edges: int
    strict_edges: int
    acyclic: bool
    waves: Tuple[Tuple[str, ...], ...]
    strict_waves: Tuple[Tuple[str, ...], ...]
    critical_path: Tuple[str, ...]
    independent: Tuple[str, ...]
    chokepoints: Tuple[Tuple[str, int], ...]

    @property
    def wave_sizes(self) -> Tuple[int, ...]:
        return tuple(len(w) for w in self.waves)

    @property
    def parallel_width(self) -> int:
        return len(self.independent)

    @property
    def critical_path_length(self) -> int:
        return len(self.critical_path)


def measured_graph() -> ComponentGraph:
    """The measured spec-§E.2 graph built from the editable data table."""
    return ComponentGraph(MEASURED_COMPONENTS, MEASURED_EDGES)


# ---------------------------------------------------------------------------
# rendering (report / app)
# ---------------------------------------------------------------------------
def format_publish_graph(summary: GraphSummary, chokepoint_limit: int = 6) -> str:
    """Plain-text read-out: waves, critical path, parallel width, chokepoints."""
    lines = ["=" * 68]
    lines.append("CROSS-COMPONENT PUBLISH GRAPH (spec Appendix E.2, measured)")
    lines.append(f"source: {MEASURED_GRAPH_SOURCE}")
    lines.append("framing: " + PUBLISH_STAGE_FRAMING)
    lines.append(
        f"  {summary.components} components · {summary.edges} build/consume edges"
        f" · {summary.strict_edges} strict cascade edges · "
        f"{'acyclic' if summary.acyclic else 'CYCLIC'}"
    )
    lines.append(
        f"  parallel width = {summary.parallel_width} independent components"
    )
    sizes = " ".join(f"L{i}={n}" for i, n in enumerate(summary.wave_sizes))
    lines.append(
        f"  publish waves = {len(summary.waves)}   ({sizes})"
    )
    lines.append(
        "  release critical path = " + " -> ".join(summary.critical_path)
        + f"   ({summary.critical_path_length} nodes)"
    )
    lines.append(
        f"  strict cascade waves = {len(summary.strict_waves)}"
        + "   (" + " ".join(f"L{i}={len(w)}"
                            for i, w in enumerate(summary.strict_waves)) + ")"
    )
    lines.append("top chokepoints (publish-set size = changed + transitive dependents):")
    for name, size in summary.chokepoints[:chokepoint_limit]:
        lines.append(f"    {name:<24} {size:>3} publishes")
    lines.append("=" * 68)
    return "\n".join(lines)


def format_convoy(plan: PublishPlan) -> str:
    """Plain-text read-out of one change's release-stage convoy."""
    lines = [
        f"CHOKEPOINT CONVOY: change '{plan.changed}' -> {plan.size} publishes "
        f"({plan.dependents} downstream + the change) over {plan.depth} serial "
        f"release stage(s)",
    ]
    for i, wave in enumerate(plan.waves):
        lines.append(f"    stage {i}: " + ", ".join(wave))
    return "\n".join(lines)
