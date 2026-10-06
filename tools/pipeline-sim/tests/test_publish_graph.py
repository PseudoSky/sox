"""Cross-component dependency / publishing graph (spec Appendix E.2).

These pin the MEASURED graph and the publish-scheduling arithmetic the model
now computes:

* the measured graph reproduces spec §E.2 exactly (75 components, 67 edges, 27
  strict cascade edges, zero cycles, 6 publish waves, the critical path, ~44
  independent components, the chokepoint list);
* the per-change **publish set** = the changed component + its transitive
  dependents;
* the **publish waves** are a correct topological layering (every producer in a
  strictly earlier wave than its consumers);
* the **convoy** is the serialized release-stage layering of a chokepoint's
  publish set;
* file overlap is NOT a parallelism bound (spec §E.1).
"""

from __future__ import annotations

import pytest

from pipeline_sim.deps import (
    MEASURED_CHOKEPOINTS,
    MEASURED_COMPONENTS,
    MEASURED_COMPONENT_COUNT,
    MEASURED_CRITICAL_PATH,
    MEASURED_EDGES,
    MEASURED_EDGE_COUNT,
    MEASURED_PARALLEL_WIDTH,
    MEASURED_STRICT_EDGE_COUNT,
    MEASURED_STRICT_WAVE_SIZES,
    MEASURED_WAVE_SIZES,
    Component,
    ComponentGraph,
    Dependency,
    format_convoy,
    format_publish_graph,
    longest_path,
    measured_graph,
    topological_order,
    topological_waves,
)


@pytest.fixture(scope="module")
def graph() -> ComponentGraph:
    return measured_graph()


# ---------------------------------------------------------------------------
# the measured graph reproduces spec §E.2
# ---------------------------------------------------------------------------
def test_measured_table_shape():
    assert len(MEASURED_COMPONENTS) == MEASURED_COMPONENT_COUNT == 75
    assert len(MEASURED_EDGES) == MEASURED_EDGE_COUNT == 67
    # ids are unique
    ids = [c.id for c in MEASURED_COMPONENTS]
    assert len(set(ids)) == len(ids)
    # 30 publishable @adhd/sox-* components
    assert sum(c.publishable for c in MEASURED_COMPONENTS) == 30


def test_measured_graph_headline_matches_spec(graph: ComponentGraph):
    s = graph.summary()
    assert s.components == 75
    assert s.edges == 67
    assert s.strict_edges == MEASURED_STRICT_EDGE_COUNT == 27
    assert s.acyclic
    # 6 serial publish waves, L0=53 ... L5=4
    assert s.wave_sizes == MEASURED_WAVE_SIZES == (53, 5, 6, 4, 3, 4)
    # strict changesets cascade = 2 waves
    assert tuple(len(w) for w in s.strict_waves) == MEASURED_STRICT_WAVE_SIZES == (69, 6)
    # the release critical path (the spec's measured 6-node chain)
    assert s.critical_path == MEASURED_CRITICAL_PATH
    assert s.critical_path_length == 6
    # effective parallel width = the independent components
    assert s.parallel_width == MEASURED_PARALLEL_WIDTH == 44


def test_measured_chokepoints_match_spec(graph: ComponentGraph):
    assert dict(graph.chokepoints(limit=6)) == dict(MEASURED_CHOKEPOINTS)
    # the exact reference sizes: telemetry 19 ... embedding-provider 10
    tops = dict(graph.chokepoints(limit=6))
    assert tops == {
        "telemetry": 19,
        "store-adapter": 15,
        "listen-guard": 15,
        "service-proxy": 12,
        "graph-store": 11,
        "embedding-provider": 10,
    }


def test_graph_is_acyclic_and_topo_order_is_producer_first(graph: ComponentGraph):
    order = graph.publish_order()
    assert set(order) == set(graph.ids)
    pos = {n: i for i, n in enumerate(order)}
    for e in graph.edges:
        assert pos[e.producer] < pos[e.consumer], f"{e} not producer-first"


def test_publish_waves_are_a_valid_layering(graph: ComponentGraph):
    waves = graph.publish_waves()
    level = {n: i for i, w in enumerate(waves) for n in w}
    assert set(level) == set(graph.ids)
    # every producer is in a strictly earlier wave than each of its consumers
    for e in graph.edges:
        assert level[e.producer] < level[e.consumer]
    # every wave except the first is non-empty and the sizes match the spec
    assert tuple(len(w) for w in waves) == MEASURED_WAVE_SIZES


# ---------------------------------------------------------------------------
# per-change PUBLISH SET
# ---------------------------------------------------------------------------
def test_publish_set_is_changed_plus_transitive_dependents(graph: ComponentGraph):
    for changed in graph.ids:
        members = set(graph.publish_set(changed))
        expected = {changed} | set(graph.dependents(changed, transitive=True))
        assert members == expected
        assert changed in members
        assert graph.publish_set_size(changed) == len(members)
        # a producer of the changed component is upstream -- never republished
        for producer in graph.dependencies(changed):
            assert producer not in members or producer in expected


def test_publish_set_sizes_are_the_measured_chokepoints(graph: ComponentGraph):
    assert graph.publish_set_size("telemetry") == 19
    assert graph.publish_set_size("store-adapter") == 15
    assert graph.publish_set_size("listen-guard") == 15
    assert graph.publish_set_size("service-proxy") == 12
    assert graph.publish_set_size("graph-store") == 11
    assert graph.publish_set_size("embedding-provider") == 10
    # an independent component publishes only itself
    indep = graph.independent()
    assert indep
    assert graph.publish_set_size(indep[0]) == 1


def test_publish_set_order_is_producer_first(graph: ComponentGraph):
    members = set(graph.publish_set("telemetry"))
    order = [n for n in graph.publish_set("telemetry")]
    pos = {n: i for i, n in enumerate(order)}
    for e in graph.edges:
        if e.consumer in members and e.producer in members:
            assert pos[e.producer] < pos[e.consumer]


def test_only_transitive_dependents_are_in_the_publish_set(graph: ComponentGraph):
    # store-adapter depends on telemetry; a change to store-adapter must NOT
    # republish its upstream producer telemetry.
    assert "telemetry" not in graph.publish_set("store-adapter")
    # but a change to telemetry DOES republish store-adapter
    assert "store-adapter" in graph.publish_set("telemetry")
    # memory-core is a consumer of store-adapter, so it is in store-adapter's set
    assert "memory-core" in graph.publish_set("store-adapter")


# ---------------------------------------------------------------------------
# chokepoint CONVOY
# ---------------------------------------------------------------------------
def test_convoy_stages_partition_the_publish_set(graph: ComponentGraph):
    for changed in ("telemetry", "store-adapter", "listen-guard"):
        plan = graph.convoy(changed)
        assert plan.changed == changed
        assert set(plan.publish_set) == set(graph.publish_set(changed))
        assert plan.size == graph.publish_set_size(changed)
        # the changed component has no in-set producer -> it is stage 0 alone
        assert plan.waves[0] == (changed,)
        # stages are a valid serialization: every in-set producer precedes its
        # in-set consumers
        level = {n: i for i, w in enumerate(plan.waves) for n in w}
        members = set(plan.publish_set)
        for e in graph.edges:
            if e.consumer in members and e.producer in members:
                assert level[e.producer] < level[e.consumer]


def test_convoy_sizes_are_the_14_to_19_downstream_convoy(graph: ComponentGraph):
    # spec §E.2: a chokepoint change drags 14-19 downstream publishes
    assert graph.convoy("telemetry").dependents == 18
    assert graph.convoy("store-adapter").dependents == 14
    assert graph.convoy("listen-guard").dependents == 14
    # every chokepoint convoy is deeper than a single stage (it serializes)
    assert graph.convoy("telemetry").depth >= 2


# ---------------------------------------------------------------------------
# parallelism
# ---------------------------------------------------------------------------
def test_independent_components_have_no_edges_either_way(graph: ComponentGraph):
    indep = set(graph.independent())
    assert len(indep) == 44
    for e in graph.edges:
        assert e.consumer not in indep
        assert e.producer not in indep
    # every non-independent component touches at least one edge
    for n in graph.ids:
        if n not in indep:
            assert graph.dependencies(n) or graph.dependents(n)


def test_parallel_width_is_independent_count(graph: ComponentGraph):
    assert graph.parallel_width() == len(graph.independent()) == 44


# ---------------------------------------------------------------------------
# generic graph algorithms (small hand graphs)
# ---------------------------------------------------------------------------
def test_topological_order_raises_on_cycle():
    deps = {"a": {"b"}, "b": {"a"}}
    with pytest.raises(ValueError):
        topological_order(["a", "b"], deps)
    g = ComponentGraph(
        [Component("a", "a", "libs", True), Component("b", "b", "libs", True)],
        [Dependency("a", "b"), Dependency("b", "a")],
    )
    assert g.is_acyclic() is False


def test_small_chain_publish_set_and_waves():
    # producer <- ... , consumer depends on producer
    g = ComponentGraph(
        [Component(c, c, "libs", True) for c in "abcde"],
        [Dependency("b", "a"), Dependency("c", "b"), Dependency("d", "a"),
         Dependency("e", "d")],
    )
    assert g.publish_waves() == (("a",), ("b", "d"), ("c", "e"))
    assert g.publish_set("a") == ("a", "b", "c", "d", "e")
    assert g.publish_set("c") == ("c",)
    assert g.critical_path() == ("a", "b", "c")
    assert g.parallel_width() == 0


def test_longest_path_prefers_a_named_terminal():
    deps = {"a": set(), "b": set(), "c": {"a", "b"}, "d": {"c"}, "e": {"c"}}
    nodes = list("abcde")
    # d and e are two equal-length (3-node) chains a/b -> c -> {d,e}
    assert len(longest_path(nodes, deps)) == 3
    assert longest_path(nodes, deps, prefer_terminals=("e",))[-1] == "e"
    assert longest_path(nodes, deps)[-1] in {"d", "e"}


def test_graph_rejects_unknown_edge_endpoints():
    with pytest.raises(ValueError):
        ComponentGraph(
            [Component("a", "a", "libs", True)],
            [Dependency("a", "ghost")],
        )


# ---------------------------------------------------------------------------
# rendering
# ---------------------------------------------------------------------------
def test_format_publish_graph_and_convoy_render(graph: ComponentGraph):
    text = format_publish_graph(graph.summary(), chokepoint_limit=6)
    assert "CROSS-COMPONENT PUBLISH GRAPH" in text
    assert "75 components" in text
    assert "67 build/consume edges" in text
    assert "publish waves = 6" in text
    assert "listen-guard -> service-proxy -> embedding-provider -> hybrid-search" in text
    assert "telemetry" in text

    convoy = format_convoy(graph.convoy("telemetry"))
    assert "change 'telemetry' -> 19 publishes" in convoy
    assert "stage 0: telemetry" in convoy
