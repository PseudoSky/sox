"""Tests for the instance-level (ACTUAL) flow graph + the bucket concurrency cap.

Two things the UI now depends on and that must not regress:

1. **Instance flow differs across configurations.**  The old comparison rendered
   the fixed 16-box *type* graph, so every variant looked identical.  These
   tests prove the instance graph (nodes = task instances, merge tree by level)
   is genuinely different for different configs -- ``depth 1 vs depth 3`` and
   ``n=2 vs n=5``.
2. **``max_parallel_buckets`` is a real cap.**  With it set, the observed peak
   number of buckets in flight is bounded by it, and it is a strict no-op when
   unset (so the default simulation is unchanged).
"""

from __future__ import annotations

import pytest

from pipeline_sim import PipelineConfig, run
from pipeline_sim.instance import (
    build_instance_graph,
    instance_counts,
    instance_level_rows,
    instance_signature,
    instance_to_dot,
)


def _cfg(**kw) -> PipelineConfig:
    base = dict(W_tot=200.0, w=10.0, n=5, alpha=2, branch_levels=1, m=4)
    base.update(kw)
    return PipelineConfig(**base)


# ---------------------------------------------------------------------------
# instance graph: shape differs across configs (the headline fix)
# ---------------------------------------------------------------------------
def test_signature_and_dot_differ_across_configs():
    a = _cfg(n=2, alpha=2, branch_levels=1, branch_fanout=2)   # M=20 -> 10 buckets
    b = _cfg(n=5, alpha=2, branch_levels=3, branch_fanout=2)   # M=20 -> 4 buckets, 3 levels
    iga = build_instance_graph(a, detail="tasks")
    igb = build_instance_graph(b, detail="tasks")

    assert instance_signature(iga) != instance_signature(igb)
    assert instance_to_dot(iga) != instance_to_dot(igb)
    # concrete structural differences
    ca, cb = instance_counts(iga), instance_counts(igb)
    assert ca["buckets"] == 10 and cb["buckets"] == 4
    assert ca["levels"] == 1 and cb["levels"] == 3
    assert ca["merge_nodes"] == 20 and cb["merge_nodes"] == 35


def test_n_drives_bucket_count_and_tickets_stay_constant():
    for n, expect_buckets in ((2, 10), (4, 5), (5, 4), (20, 1)):
        ig = build_instance_graph(_cfg(n=n), detail="structural")
        c = instance_counts(ig)
        assert c["tickets"] == 20
        assert c["buckets"] == expect_buckets
        assert sum(c["per_bucket"]) == 20


def test_depth_drives_merge_levels_and_branch_counts():
    # M=20, fan-out 2 -> L1=20, L2=10, L3=5, then main.
    ig = build_instance_graph(_cfg(branch_levels=3, branch_fanout=2),
                              detail="structural")
    rows = {r["Level"]: r for r in instance_level_rows(ig)}
    assert rows["L1"]["Branches"] == 20
    assert rows["L2"]["Branches"] == 10
    assert rows["L3"]["Branches"] == 5
    assert rows["main"]["Role"] == "root (main line)"
    # every level covers all M tickets via its subtrees
    for lvl in ("L1", "L2", "L3"):
        assert rows[lvl]["Tickets covered"] == 20
    assert rows["L1"]["Suite runs here"] == 20   # test_level "all"


def test_flat_vs_hierarchical_have_different_merge_shapes():
    flat = build_instance_graph(_cfg(branch_levels=1), detail="structural")
    hier = build_instance_graph(_cfg(branch_levels=2), detail="structural")
    assert instance_signature(flat) != instance_signature(hier)
    # flat: every node is a top merge (20 nodes); hier: 20 leaves + 10 internal
    assert instance_counts(flat)["merge_nodes"] == 20
    assert instance_counts(hier)["merge_nodes"] == 30


def test_structural_and_tasks_detail_differ():
    cfg = _cfg()
    tasks = build_instance_graph(cfg, detail="tasks")
    structural = build_instance_graph(cfg, detail="structural")
    assert tasks.detail == "tasks" and structural.detail == "structural"
    # tasks mode has one node per instantiated task; structural is compact
    assert len(tasks.nodes) > len(structural.nodes)
    assert len(tasks.edges) > len(structural.edges)
    assert instance_signature(tasks) == instance_signature(structural)


def test_tasks_mode_labels_carry_the_agent_after_a_run():
    cfg = _cfg(m=4)
    res = run(cfg)
    ig = build_instance_graph(cfg, res, detail="tasks")
    assert any(n.agent is not None for n in ig.nodes)
    assert instance_counts(ig)["agents"] == res.spawns
    dot = instance_to_dot(ig)
    assert dot.startswith("digraph")
    assert "cluster_bucket_" in dot          # clustered by bucket


def test_unknown_detail_is_rejected():
    import pytest

    with pytest.raises(ValueError):
        build_instance_graph(_cfg(), detail="nope")


# ---------------------------------------------------------------------------
# max_parallel_buckets: a real cap, and a strict no-op when unset
# ---------------------------------------------------------------------------
def test_bucket_cap_bounds_the_observed_peak():
    free = run(_cfg(n=2, m=8))
    assert free.peak_parallel_buckets == 10      # all 10 buckets can overlap
    assert free.max_parallel_buckets is None

    capped1 = run(_cfg(n=2, m=8, max_parallel_buckets=1))
    capped2 = run(_cfg(n=2, m=8, max_parallel_buckets=2))
    assert capped1.peak_parallel_buckets == 1
    assert capped2.peak_parallel_buckets == 2
    assert capped1.max_parallel_buckets == 1
    # capping serialises buckets, so the end-to-end time is not shorter
    assert capped1.makespan >= capped2.makespan >= free.makespan
    assert capped1.violations == [] and capped2.violations == []


def test_bucket_cap_on_a_deep_tree_also_bounds():
    deep = dict(n=5, branch_levels=3, branch_fanout=2, m=8)
    capped = run(_cfg(**deep, max_parallel_buckets=2))
    assert capped.peak_parallel_buckets <= 2
    assert capped.violations == []


def test_cap_ge_bucket_count_is_a_no_op():
    """A cap >= the bucket count disables the gate: identical to uncapped."""
    free = run(_cfg(n=2, m=8))
    capped = run(_cfg(n=2, m=8, max_parallel_buckets=10))
    assert capped.makespan == free.makespan
    assert capped.total_cost == free.total_cost
    assert capped.peak_parallel_buckets == free.peak_parallel_buckets


def test_cap_below_one_is_rejected():
    with pytest.raises(ValueError, match="max_parallel_buckets"):
        _cfg(max_parallel_buckets=0).validate()


def test_bucket_cap_with_branch_gate_is_rejected_not_deadlocked():
    """A branch release-gate on a flat tree under a bucket cap is rejected cleanly.

    RED (before the 2026-10-05 guard): the branch gate is a SINGLE global task
    that every ticket's tails feed and that every top merge (here: every leaf
    merge, because the tree is flat) waits on.  No bucket can finish until the
    gate runs; the gate cannot run until every bucket's tasks run; only ``cap``
    buckets hold a slot -- so SimPy deadlocks, ``run`` returns a PARTIAL
    realisation (604 of 688 tasks unran in the app's M=60 case), and
    ``verify_constraints`` raised ``KeyError`` on an unrealised predecessor.

    GREEN: the engine detects the incomplete realisation and raises a clear
    ``ValueError``, which ``run_sweep`` and the UI's quiet runner already skip.
    """
    cfg = _cfg(n=2, branch_levels=1, release_gate="branch", max_parallel_buckets=2)
    with pytest.raises(ValueError, match="did not complete"):
        run(cfg)

    # the same gate is schedulable when the cap does not straddle it ...
    ok = _cfg(n=2, branch_levels=1, release_gate="branch", max_parallel_buckets=None)
    assert run(ok).violations == []
    # ... or on a hierarchical tree, where only the (few) TOP merges wait on it.
    ok2 = _cfg(n=2, branch_levels=2, release_gate="branch", max_parallel_buckets=2)
    assert run(ok2).violations == []
