"""Configuration objects for the pipeline simulator.

This module is the single home of the model's input vector ("theta" from
Appendix A of ``docs/pipeline-simulation-spec.md``, revised 2026-10-05).

Two axes that M1 conflated -- and that this revision keeps orthogonal
--------------------------------------------------------------------
* A **bucket** is a *group of tickets* and nothing else: a planning /
  assignment unit.  It is NOT a git term and NOT a merge unit (spec 1.1,
  OPEN-8, backlog 47bf572f).  Bucket size is ``n``.
* A **merge structure** is an independent tree over *work units* (one work
  unit per ticket).  Its depth is ``branch_levels`` and its fanout is
  ``branch_fanout``.  It has no dependence on ``n``.

The old ``branch`` knob (flat / hierarchical / serial) is retained for
backward compatibility only; the canonical knobs are ``branch_levels`` and
``branch_fanout``.  See :meth:`PipelineConfig.resolved_branch_levels`.

Time model (spec 3.2, 4-f1, C17)
--------------------------------
``t_dispatch`` once per fresh agent start (here: one dispatch per bucket
assignment); ``t_op[tau]`` per operation (the :class:`TaskDurations` table);
``t_suite`` per suite *launch*; ``e`` per acceptance criterion executed.
Makespan includes all of these plus resource / queue waits.

Cost model (spec 4-f2)
----------------------
``c_dispatch`` per dispatch; ``c_op[tau]`` per operation; the **compounding**
test term ``c_suite + sum(c_a over accumulated ACs)`` per suite run; and the
holding term ``c_wip * n * horizon``.  All defaults are **calibrated to real
Oct-2026 prices** -- Appendix C of the spec: LLM token costs from DeepSeek V4.1
Flash (``P_IN`` / ``P_OUT`` below) and CI runner rates from GitHub Actions
Linux.  The suite is a first-order cost at real prices once a few levels of
testing accumulate (one 200-AC run ~= $0.55 vs ~$0.05 of LLM cost for a whole
ticket), which is what makes deferral (H1) worth measuring.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field, replace
from typing import TYPE_CHECKING, Dict, List, Mapping, Optional, Tuple

from .alpha import AcDistribution

if TYPE_CHECKING:  # pragma: no cover - import cycle guard for type checkers only
    from .taskgraph import TaskGraphSpec, TaskGraphValidation

Branch = str            # "flat" | "hierarchical" | "serial" (legacy)
TestExec = str          # "full_suite" | "affected_only"
TestLevel = str         # "all" | "top" | "level:<L>"
FileRegime = str        # "no_edges" | "fragmented" | "one_component"
MergeOrder = str        # only "natural" implemented


def parse_test_level(test_level: str, branch_levels: int) -> Tuple[str, int]:
    """Validate ``test_level`` and return ``(mode, L)``.

    * ``"all"``        -> ``("all", 1)``     tests at every merge.
    * ``"top"``        -> ``("top", branch_levels)`` tests at top-level merges.
    * ``"level:L"``    -> ``("level", L)``   tests at merges of tier >= ``L``.
    * ``"none"``       -> ``("none", 0)``    no per-merge suite run at all; used
      with a release gate (``release_gate``) so the gate may be the ONLY test
      run in the extreme (spec 5.2 / 10.2).  Not advertised in the UI.

    The family is monotone: ``level:1`` is identical to ``all`` and
    ``level:branch_levels`` is identical to ``top``.  ``1 <= L <= branch_levels``
    is enforced (a level above the root would select no merge and violate C10).
    """
    if test_level == "none":
        return "none", 0
    if test_level == "all":
        return "all", 1
    if test_level == "top":
        return "top", branch_levels
    if test_level.startswith("level:"):
        try:
            level = int(test_level.split(":", 1)[1])
        except ValueError as exc:  # pragma: no cover - defensive
            raise ValueError(f"bad test_level {test_level!r}: {exc}") from exc
        if not (1 <= level <= branch_levels):
            raise ValueError(
                f"test_level {test_level!r}: L must be in [1, branch_levels="
                f"{branch_levels}] (spec C10: >=1 test before release)"
            )
        return "level", level
    raise ValueError(
        f"unknown test_level {test_level!r}; expected 'all', 'top' or 'level:L'"
    )


# ---------------------------------------------------------------------------
# Price basis (Oct 2026 measured -- OFF-PEAK is the default)   [spec App. C]
# ---------------------------------------------------------------------------
# DeepSeek V4.1 Flash bills PEAK rates only during 01:00-04:00 and 06:00-10:00
# UTC Mon-Fri and OFF-PEAK (exactly half) at all other times.  The operator's
# real runs bill OFF-PEAK (spec Appendix C, "REAL MEASURED NUMBERS"), so
# off-peak is the DEFAULT basis; the peak card is retained as a selectable
# basis (``price_basis="peak"`` / :func:`prices_for`).
P_IN_PEAK = 0.30 / 1_000_000          # USD/input token, peak     = 3.0e-7
P_OUT_PEAK = 1.20 / 1_000_000         # USD/output token, peak    = 1.2e-6
P_CACHE_READ_PEAK = 0.006 / 1_000_000  # USD/cache-read token, peak

P_IN_OFFPEAK = 0.15 / 1_000_000       # USD/input token, off-peak = 1.5e-7
P_OUT_OFFPEAK = 0.60 / 1_000_000      # USD/output token, off-peak= 6.0e-7
P_CACHE_READ_OFFPEAK = 0.003 / 1_000_000  # USD/cache-read, off-peak = 3.0e-9

PRICE_BASIS_DEFAULT = "off_peak"
PRICE_BASIS: Mapping[str, Tuple[float, float, float]] = {
    "off_peak": (P_IN_OFFPEAK, P_OUT_OFFPEAK, P_CACHE_READ_OFFPEAK),
    "peak": (P_IN_PEAK, P_OUT_PEAK, P_CACHE_READ_PEAK),
}

# Effective (default-basis) rates.  The historical names ``P_IN`` / ``P_OUT``
# are kept as the OFF-PEAK effective values, so every existing call site keeps
# working while the default silently moves to the measured off-peak card.
P_IN = P_IN_OFFPEAK
P_OUT = P_OUT_OFFPEAK
P_CACHE_READ = P_CACHE_READ_OFFPEAK
P_REASONING = P_OUT                   # reasoning is billed at the output rate


def prices_for(basis: str = PRICE_BASIS_DEFAULT) -> Tuple[float, float, float]:
    """``(p_in, p_out, p_cache_read)`` USD/token for the given price basis."""
    try:
        return PRICE_BASIS[basis]
    except KeyError as exc:
        raise ValueError(
            f"unknown price basis {basis!r}; expected one of {sorted(PRICE_BASIS)}"
        ) from exc


# ---------------------------------------------------------------------------
# Measured reasoning + cache-read volume (spec Appendix C measured block; the
# operator's own ``opencode.db``, 2026-10-05).
# ---------------------------------------------------------------------------
# Two cost classes the old model omitted.  Per model STEP the store averages
# ~493 output tokens, ~619 reasoning tokens and ~186k cache-read tokens (a
# replayed-context read).  Because both reasoning and cache-read scale with the
# number of model steps -- which generation length stands in for -- we charge
# each OPERATION ``reasoning = RATIO * out_tok`` at the output rate and
# ``cache_read = RATIO * out_tok`` at the cache-read rate.  These ratios are
# exactly ``REASONING_TOK_PER_STEP / OUTPUT_TOK_PER_STEP`` etc., so the model
# reproduces the measured cost mix (reasoning ~19.7 %, cache-read ~28.9 %).
OUTPUT_TOK_PER_STEP = 493.0
REASONING_TOK_PER_STEP = 619.0
CACHE_READ_TOK_PER_STEP = 186_443.0
REASONING_PER_OUTPUT = REASONING_TOK_PER_STEP / OUTPUT_TOK_PER_STEP      # ~1.256
CACHE_READ_PER_OUTPUT = CACHE_READ_TOK_PER_STEP / OUTPUT_TOK_PER_STEP    # ~378.2

#: The four billed LLM classes, in the order the composition is reported.
LLM_COST_CLASSES = ("input", "output", "reasoning", "cache_read")

# ---------------------------------------------------------------------------
# Appendix C cost decomposition (avoids double-counting)          [b46a5f8f]
# ---------------------------------------------------------------------------
# The three LLM-token pools are DISJOINT (spec Appendix C, "COST
# DECOMPOSITION"):
#
#   * DISPATCH_SCHEMA_TOKENS -- the system prompt + tool schemas, paid ONCE per
#     fresh agent start (``c_dispatch``).  Not per operation.
#   * TOOL_CALL_TOKENS      -- the result payload of ONE tool call, paid per
#     call (``OC``); the count of calls is ``O_nu`` for the task instance.
#   * per-operation ``in_tok``/``out_tok`` -- the operation's OWN input and
#     generation tokens (plus the derived reasoning / cache-read charges),
#     EXCLUDING both of the above.
#
# Making the constant explicit (and deriving ``c_dispatch``/``OC`` from it) is
# the reconciliation: schema/boot tokens can only ever be charged through the
# dispatch term, and tool-result tokens only through the tool term, so the
# per-op tokens cannot silently re-include them.
DISPATCH_SCHEMA_TOKENS = 14_470      # MEASURED first-step input (was 12,000)
TOOL_CALL_TOKENS = 950               # MEASURED ~950 tok/call  (was 1,000)
DISPATCH_FIRST_STEP_COST = 0.0022    # MEASURED $/fire       (spec App. C)
TOOL_CALL_COST = 0.000143            # MEASURED $/call       (spec App. C)


def llm_cost(in_tok: float, out_tok: float,
             reasoning_tok: Optional[float] = None,
             cache_read_tok: Optional[float] = None,
             basis: str = PRICE_BASIS_DEFAULT) -> float:
    """Full MEASURED LLM cost of one operation from its token magnitudes.

    ``in_tok * P_IN + out_tok * P_OUT + reasoning * P_OUT + cache_read *
    P_CACHE_READ`` at ``basis``.  When ``reasoning_tok`` / ``cache_read_tok``
    are omitted they default to the measured per-step ratios applied to
    ``out_tok`` (:data:`REASONING_PER_OUTPUT` / :data:`CACHE_READ_PER_OUTPUT`),
    so the two previously-unmodelled classes are charged automatically.  Pass
    explicit counts to override (e.g. an operation with no replayed context
    passes ``cache_read_tok=0``).
    """
    p_in, p_out, p_cache = prices_for(basis)
    if reasoning_tok is None:
        reasoning_tok = REASONING_PER_OUTPUT * out_tok
    if cache_read_tok is None:
        cache_read_tok = CACHE_READ_PER_OUTPUT * out_tok
    return (in_tok * p_in + out_tok * p_out
            + reasoning_tok * p_out + cache_read_tok * p_cache)


def llm_cost_components(in_tok: float, out_tok: float,
                        reasoning_tok: Optional[float] = None,
                        cache_read_tok: Optional[float] = None,
                        basis: str = PRICE_BASIS_DEFAULT) -> Dict[str, float]:
    """:func:`llm_cost` split into its four billed classes (USD).

    Keys are :data:`LLM_COST_CLASSES`; the values sum to :func:`llm_cost` at
    the same arguments.  This is what the engine rolls up into the
    input/output/reasoning/cache-read composition.
    """
    p_in, p_out, p_cache = prices_for(basis)
    if reasoning_tok is None:
        reasoning_tok = REASONING_PER_OUTPUT * out_tok
    if cache_read_tok is None:
        cache_read_tok = CACHE_READ_PER_OUTPUT * out_tok
    return {
        "input": in_tok * p_in,
        "output": out_tok * p_out,
        "reasoning": reasoning_tok * p_out,
        "cache_read": cache_read_tok * p_cache,
    }


@dataclass(frozen=True)
class TaskTokens:
    """Per-operation token magnitudes ``(in_tok, out_tok)`` (Appendix C).

    **These are the operation's OWN tokens only**: by the Appendix C cost
    decomposition (:data:`DISPATCH_SCHEMA_TOKENS` / :data:`TOOL_CALL_TOKENS`)
    they EXCLUDE the system-prompt + tool-schema tokens (charged once per fresh
    agent start through ``c_dispatch``) and the tool-CALL RESULT tokens (charged
    per call through ``O_nu * OC``).  The three terms are disjoint, so the
    per-op cost, the dispatch term and the tool term cannot double-count.

    These are the raw calibration inputs; :class:`TaskOpCost` derives the token
    price (USD) from them via :func:`llm_cost`.
    """

    impl: Tuple[int, int] = (30_000, 6_000)
    test_write_per_ac: Tuple[int, int] = (12_000, 4_000)
    test_run_per_ac: Tuple[int, int] = (2_000, 1_000)   # + CI (per-AC c_a)
    merge: Tuple[int, int] = (10_000, 2_000)            # + CI (c_merge)
    setup: Tuple[int, int] = (1_000, 200)               # + CI (c_wt)
    pre_release: Tuple[int, int] = (5_000, 1_000)       # + CI
    release: Tuple[int, int] = (2_000, 500)             # + CI
    triage: Tuple[int, int] = (5_000, 1_000)
    spec: Tuple[int, int] = (10_000, 3_000)
    # The remaining spec-3.3 catalogue rows.  Now instantiated by the engine
    # when active (spec 3.3 / Appendix C / Appendix D).
    intake: Tuple[int, int] = (2_000, 1_000)
    routing: Tuple[int, int] = (2_000, 500)
    plan: Tuple[int, int] = (10_000, 2_000)
    review: Tuple[int, int] = (20_000, 2_000)
    review_routing: Tuple[int, int] = (2_000, 500)
    main_build: Tuple[int, int] = (3_000, 500)          # + CI (main-build CI)
    post_verify: Tuple[int, int] = (2_000, 500)


DEFAULT_TOKENS = TaskTokens()


@dataclass(frozen=True)
class TaskDurations:
    """``t_op[tau]`` -- deterministic per-operation durations (spec A2).

    Calibrated to the seconds column of Appendix C.  Test *execution* is not
    here: a suite run's duration is ``t_suite`` plus ``e`` per acceptance
    criterion, so C9 (compounding suite) reads directly off the parameters the
    spec names.
    """

    impl: float = 600.0              # implement one ticket
    test_write_per_ac: float = 180.0  # write one acceptance-criterion test
    merge: float = 120.0             # merge_resolve (worktree -> target)
    setup: float = 20.0              # git worktree setup / branch provisioning
    pre_release: float = 180.0       # pre-release gates
    release: float = 60.0            # release
    triage: float = 60.0             # optional gate
    spec: float = 120.0              # optional gate
    # Remaining Appendix C catalogue rows (spec 3.3): now instantiated by the
    # engine (seconds column of Appendix C).
    intake: float = 30.0             # ticket intake
    routing: float = 15.0            # ticket routing
    plan: float = 120.0              # execution plan / bucketing (per bucket)
    review: float = 240.0            # code review (per ticket)
    review_routing: float = 30.0     # review routing (per review)
    main_build: float = 300.0        # main build (per merge-to-main)
    post_verify: float = 120.0       # post-release verification (global)


@dataclass(frozen=True)
class TaskOpCost:
    """``c_op[tau]`` -- LLM token cost of one operation of type tau (spec 4-f2).

    Defaults are derived from :class:`TaskTokens` at the Appendix C prices
    (``P_IN`` / ``P_OUT``), so the token magnitudes are the single source of
    truth.  The CI component of an operation (``c_wt`` / ``c_merge`` / the
    per-AC ``c_a``) lives in :class:`PipelineConfig`, never here, so it cannot
    be double-counted.
    """

    impl: float = field(default_factory=lambda: llm_cost(*DEFAULT_TOKENS.impl))
    test_write_per_ac: float = field(
        default_factory=lambda: llm_cost(*DEFAULT_TOKENS.test_write_per_ac)
    )
    test_run_per_ac: float = field(
        default_factory=lambda: llm_cost(*DEFAULT_TOKENS.test_run_per_ac)
    )
    merge: float = field(default_factory=lambda: llm_cost(*DEFAULT_TOKENS.merge))
    setup: float = field(default_factory=lambda: llm_cost(*DEFAULT_TOKENS.setup))
    pre_release: float = field(
        default_factory=lambda: llm_cost(*DEFAULT_TOKENS.pre_release)
    )
    release: float = field(default_factory=lambda: llm_cost(*DEFAULT_TOKENS.release))
    triage: float = field(default_factory=lambda: llm_cost(*DEFAULT_TOKENS.triage))
    spec: float = field(default_factory=lambda: llm_cost(*DEFAULT_TOKENS.spec))
    # catalogue-only rows (Appendix C/D); kept symmetric with TaskTokens.
    intake: float = field(default_factory=lambda: llm_cost(*DEFAULT_TOKENS.intake))
    routing: float = field(default_factory=lambda: llm_cost(*DEFAULT_TOKENS.routing))
    plan: float = field(default_factory=lambda: llm_cost(*DEFAULT_TOKENS.plan))
    review: float = field(default_factory=lambda: llm_cost(*DEFAULT_TOKENS.review))
    review_routing: float = field(
        default_factory=lambda: llm_cost(*DEFAULT_TOKENS.review_routing)
    )
    main_build: float = field(default_factory=lambda: llm_cost(*DEFAULT_TOKENS.main_build))
    post_verify: float = field(default_factory=lambda: llm_cost(*DEFAULT_TOKENS.post_verify))


def derive_op_costs(tokens: TaskTokens,
                    basis: str = PRICE_BASIS_DEFAULT) -> TaskOpCost:
    """Build a :class:`TaskOpCost` from token magnitudes at the given price basis.

    Use this instead of hand-writing ``c_op`` values so the token counts remain
    the single source of truth: ``derive_op_costs(TaskTokens())`` reproduces the
    measured LLM-cost column exactly (guarded by ``tests/test_calibration.py``).
    ``basis`` selects the peak/off-peak card (default: measured off-peak).
    """
    return TaskOpCost(
        impl=llm_cost(*tokens.impl, basis=basis),
        test_write_per_ac=llm_cost(*tokens.test_write_per_ac, basis=basis),
        test_run_per_ac=llm_cost(*tokens.test_run_per_ac, basis=basis),
        merge=llm_cost(*tokens.merge, basis=basis),
        setup=llm_cost(*tokens.setup, basis=basis),
        pre_release=llm_cost(*tokens.pre_release, basis=basis),
        release=llm_cost(*tokens.release, basis=basis),
        triage=llm_cost(*tokens.triage, basis=basis),
        spec=llm_cost(*tokens.spec, basis=basis),
        intake=llm_cost(*tokens.intake, basis=basis),
        routing=llm_cost(*tokens.routing, basis=basis),
        plan=llm_cost(*tokens.plan, basis=basis),
        review=llm_cost(*tokens.review, basis=basis),
        review_routing=llm_cost(*tokens.review_routing, basis=basis),
        main_build=llm_cost(*tokens.main_build, basis=basis),
        post_verify=llm_cost(*tokens.post_verify, basis=basis),
    )


@dataclass(frozen=True)
class ToolCalls:
    """``O_nu`` -- tool calls per task instance (spec 3.2).

    For per-AC tasks the value is multiplied by the number of acceptance
    criteria the task touches.  Appendix C calibrates ``OC`` (the per-call
    price) but does not give per-operation call *counts*, so these remain a
    model-internal estimate, unchanged by the calibration.
    """

    impl: int = 8
    test_write_per_ac: int = 1
    test_run_per_ac: int = 1
    suite_per_ac: int = 1
    merge: int = 3
    setup: int = 1
    pre_release: int = 5
    release: int = 2
    triage: int = 1
    spec: int = 2
    # Remaining catalogue rows (model-internal O_nu estimates; Appendix C prices
    # OC but does not give per-operation call counts -- see BL b46a5f8f).
    intake: int = 1
    routing: int = 1
    plan: int = 2
    review: int = 4
    review_routing: int = 1
    main_build: int = 2
    post_verify: int = 1
    # A1 rework: an extra implement pass + a reconfirm/re-review per bucket.
    rework_impl: int = 8
    rework_confirm: int = 4


@dataclass(frozen=True)
class PipelineConfig:
    """The full simulator input ("theta" from Appendix A)."""

    # --- workload inputs -------------------------------------------------
    W_tot: float = 600.0
    w: float = 10.0

    # --- sizing ----------------------------------------------------------
    n: int = 5                  # tickets per bucket (GROUP SIZE, independent)
    #: Scalar AC-per-ticket (the *uniform* / legacy mode; spec C4).
    #: Used for every ticket ONLY when :attr:`ac_distribution` is ``None``.
    alpha: int = 2              # AC per ticket (uniform fallback)
    #: Per-ticket acceptance-criteria DISTRIBUTION (spec C4 revised; Appendix
    #: E).  When set, the ACTUAL per-ticket AC count comes from this 0-heavy
    #: distribution and ``alpha`` is ignored -- a 0-AC ticket generates no
    #: test-write / test-run work.  ``None`` (the dataclass default) preserves
    #: the legacy uniform behaviour for every explicit ``alpha=…`` construction;
    #: the shipped app / CLI scenario enables :data:`~pipeline_sim.alpha.REAL_AC_DISTRIBUTION`.
    ac_distribution: Optional[AcDistribution] = None

    # --- merge structure (INDEPENDENT of bucketing; spec 1.1 / 3.4) ------
    branch_levels: int = 1      # depth of the merge tree (>= 1)
    branch_fanout: int = 2      # children per branch node (>= 2)
    branch: Branch = "flat"     # LEGACY; superseded by branch_levels/fanout

    # --- testing policy (spec C10, C18, H1) ------------------------------
    test_level: TestLevel = "all"   # all | top | level:L | none
    test_exec: TestExec = "full_suite"   # full_suite | affected_only

    # --- operator topology variants (spec 5.2) ---------------------------
    # ``plan`` placement is a VARIANT: before routing (default; the plan is a
    # bucketing step after intake) or before implement.  When placed before
    # implement, implementation's rework odds increase (the plan is late, so
    # more implementation churn) -- modelled by ``plan_rework_multiplier``.
    plan_position: str = "before_routing"   # before_routing | before_implement
    plan_rework_multiplier: float = 2.0     # p_eff = min(1, p * mult) when before_implement

    # ``release gate`` is a FULL suite run (spec 5.2): it may sit BEFORE
    # merge-to-main (on the branch) or ON main, and may be the only test run.
    # Remediating a failure found on a branch is cheap; on main it needs a NEW
    # branch, so ``c_gate_rework_main`` > ``c_gate_rework_branch``.
    release_gate: str = "off"               # off | branch | main
    c_gate_rework_branch: float = 0.020     # expected remediation on an L2 branch
    c_gate_rework_main: float = 0.100       # expected remediation on main (new branch)

    # --- agents / order --------------------------------------------------
    m: int = 4
    sigma: MergeOrder = "natural"

    #: Concurrency cap on BUCKETS in flight at once (a resource/assignment-level
    #: limit).  A bucket occupies one slot from its first task start to its last
    #: task finish; ``max_parallel_buckets`` slots bound how many buckets may
    #: progress concurrently.  ``None`` (the default) = unlimited, so existing
    #: behaviour is unchanged.  Independent of ``m``: ``m`` caps *tasks* in
    #: flight, this caps *buckets* (a coarser, assignment-level cap).
    #:
    #: NOTE (spec Appendix E.1): this is NOT a file-overlap bound.  The real
    #: serializer is the component dependency DAG (publish order), modelled in
    #: :mod:`pipeline_sim.deps`; the file-overlap graph is a *citation artifact*
    #: (shared evidence/meta files) and must never be used to limit parallelism.
    max_parallel_buckets: Optional[int] = None

    # --- quality / risk (stored; rework not in the deterministic scope) --
    p: float = 0.1
    rho: float = 0.5

    # --- TIME model (spec 3.2 / 4-f1 / C17; Appendix C) ------------------
    t_dispatch: float = 3.0     # fixed latency to start a fresh agent
    t_suite: float = 30.0       # fixed overhead to LAUNCH one suite run
    e: float = 20.0             # per-AC test execution time (Appendix C)
    var_e: float = 0.0          # stored only; stochastic durations deferred

    # --- COST model (spec 4-f2; Appendix C measured, USD) ----------------
    #: Price basis for every LLM term: "off_peak" (MEASURED default) or "peak".
    #: The shipped ``c_op`` / ``c_dispatch`` / ``OC`` defaults are the off-peak
    #: card; :meth:`repriced` re-derives them at the other basis.
    price_basis: str = PRICE_BASIS_DEFAULT
    #: MEASURED token cost per fresh agent dispatch (14,470 first-step input
    #: tokens x P_IN), derived so it cannot drift from the constant.
    c_dispatch: float = field(
        default_factory=lambda: DISPATCH_SCHEMA_TOKENS * P_IN
    )
    c_suite: float = 0.008      # fixed cost per suite run (1 min CI @ $0.008/min)
    c_a: float = 0.0027         # per-AC test cost (20 s CI @ $0.008/min)
    c_wt: float = 0.003         # worktree / branch provisioning CI cost
    c_merge: float = 0.016      # merge CI cost (merge_resolve)
    c_main_build: float = 0.040  # main-build CI, per merge-to-main (Appendix D)
    #: Holding / open-bucket carrying cost per bucket per unit time.  Rebalanced
    #: to be FIRST-ORDER (spec §4 NOTE / OPEN-7): with the old rounding-error
    #: default (1e-3) the ∝ n holding term was invisible next to c_agent, cost
    #: simply tracked makespan, and the bucket-size optimum collapsed to the
    #: largest bucket ("max out the knob").  Calibrated against :attr:`c_bucket`
    #: so the ∝ 1/n setup and ∝ n holding terms balance at n* ~ sqrt(M).
    c_wip: float = 0.30
    horizon: float = 1.0        # planning horizon T for the holding term (spec f2)
    #: MEASURED cost per tool call (950 tok x P_IN), derived from the constant.
    OC: float = field(default_factory=lambda: TOOL_CALL_TOKENS * P_IN)
    # Parallelism cost (spec 4-f2 [fix]): cost per agent per unit of OCCUPIED
    # time.  ``agent_seconds`` is the sum over agents of their occupied span
    # (first task start -> last task finish, idle waits included); the pool of
    # ``m`` agents is provisioned for the horizon, so buying makespan with more
    # agents costs more -- the trade that closes the cost-vs-makespan front.
    #
    # Derivation (Appendix C): the GitHub Actions Linux 2-core rate is
    # $0.008/min; an agent slot is ~0.375x a runner-minute => $0.003/agent-min
    # = $5.0e-5/agent-second.  At realistic pipeline makespans this is a
    # first-order term (e.g. 300 agent-seconds = $0.015, ~4x the c_dispatch
    # charge), never a rounding error.
    c_agent: float = 0.00005    # USD per agent-second of occupied time

    # --- FIRST-ORDER costs of the depth / bucket / deferral knobs ---------
    # (spec §4 NOTE + OPEN-7).  The three structural knobs -- branch depth,
    # bucket size and test deferral -- previously had NO first-order cost of
    # their own: c_wt/c_merge are a rounding error next to c_agent, the holding
    # term was 1e-3, and gate rework was flat.  Every one of them therefore
    # reduced BOTH cost and makespan (cost simply tracked makespan) and the
    # design-space optimum collapsed to a corner -- "max out the knobs".  These
    # fields give each knob a cost that GROWS with it, so each optimum is
    # interior (the previous behaviour is recovered by setting them to 0).
    #
    #: Per-BRANCH (per merge-tree node) cost: worktree provision + merge +
    #: coordination, BEYOND the measured CI increments in ``c_wt``/``c_merge``.
    #: It is charged PER WORK UNIT the node integrates (``Σ_nodes |tickets|``),
    #: not once per node: coordinating a merge of 8 tickets costs ~8x one of 1
    #: ticket.  Because every ticket is counted once per level it rises through
    #: (its leaf + each ancestor), ``Σ_nodes |tickets| = M · levels``, so a
    #: deeper tree pays a first-order, workload-scaled coordination cost.  This
    #: is what gives the branch-depth optimum an INTERIOR solution: the extra
    #: levels buy fewer/larger suites but each costs more coordination, and the
    #: two balance at an optimal depth rather than "max out the knob".
    c_branch: float = 0.03
    #: Additional per-branch cost per TIER of merge depth, also charged per work
    #: unit a node integrates (``Σ_nodes |tickets| · tier``).  Coordination
    #: climbs as higher merges integrate larger subtrees, so deeper trees get
    #: progressively dearer -- the second half of the interior-depth pressure.
    c_level: float = 0.02
    #: Per-BUCKET fixed setup cost (planning / assignment / coordination).  This
    #: is the ``K`` of the square-root batch law (``n* = sqrt(2 K M / (h T))``):
    #: the term ∝ 1/n that the ``c_wip`` holding term (∝ n) balances.  Without a
    #: first-order ``K`` the bucket optimum degenerates to one giant bucket.
    c_bucket: float = 0.20
    #: Release-gate remediation that GROWS with test deferral (spec 5.2): when
    #: testing is postponed, more issues are resolved at once in a bigger, later
    #: gate, so remediation is dearer.  Charged as
    #: ``rate * deferral_levels * (M * alpha)`` -- i.e. per deferred merge level
    #: PER ACCUMULATED ACCEPTANCE CRITERION resolved at the gate (the bigger the
    #: deferred batch, the more issues it exposes at once).  Scaling by the
    #: workload keeps the effect size-invariant; without it deferral is strictly
    #: cheaper AND faster (a free lunch) and test timing is fully deferred.  At
    #: this magnitude the test-timing optimum is INTERIOR: partial deferral
    #: (e.g. ``level:2``) beats both testing at every merge and testing only at
    #: the top, because the marginal remediation of one more deferred level
    #: overtakes the marginal suite saving.
    c_gate_rework_per_deferred_ac: float = 0.010

    # Legacy cost parameters (superseded by c_dispatch / c_op); default 0 so
    # they do not double-count.  Retained for theta-shape compatibility.
    c_sys: float = 0.0
    c_0: float = 0.0

    # --- optional gates (y) ----------------------------------------------
    y_triage: bool = False
    y_spec: bool = False

    # --- editable task graph (spec 3.6 / C19 / C20) ----------------------
    # ``T_active``: the subset of the 16 spec-3.3 task types active in this
    # scenario.  ``P``: precedence edges over the active task types (a DAG).
    # Both default to ``None`` -> the current fixed graph (DEFAULT_TASK_GRAPH),
    # so existing behaviour and tests are unchanged unless explicitly
    # overridden.  When ``T_active`` is supplied it is authoritative for the two
    # optional gates (a listed ``triage`` / ``spec`` turns the gate on).
    T_active: Optional[Tuple[str, ...]] = None
    P: Optional[Tuple[Tuple[str, str], ...]] = None

    # Custom task types (spec 3.6: "may add custom task types").  Each entry is
    # a :class:`pipeline_sim.taskgraph.TaskType` carrying the §3.6 schema.  They
    # join the catalogue for validation (C19/C20), occurrences, the Appendix-D
    # expected-cost roll-up, the engine's graph, and the editor.  Default empty
    # -> behaviour unchanged.  Stored loosely typed to keep config free of an
    # import cycle (``taskgraph`` imports ``config``).
    custom_task_types: Tuple = ()

    # --- file-conflict regime (G_X) --------------------------------------
    file_regime: FileRegime = "fragmented"
    gx_params: Mapping[str, float] = field(default_factory=dict)

    # --- agent-role partition (Pi_R); C15 deferred -----------------------
    role_partition: Mapping[str, tuple[str, ...]] = field(default_factory=dict)

    # --- objective weights (stored; scalarisation is a later milestone) --
    w1: float = 1.0
    w2: float = 1.0
    w3: float = 1.0

    # --- duration / tool-call / op-cost tables ---------------------------
    durations: TaskDurations = field(default_factory=TaskDurations)
    tool_calls: ToolCalls = field(default_factory=ToolCalls)
    #: Per-operation token magnitudes.  The single source of truth for the
    #: engine's input/output/reasoning/cache-read composition (spec App. C).
    tokens: TaskTokens = field(default_factory=TaskTokens)
    c_op: TaskOpCost = field(default_factory=TaskOpCost)
    #: OPTIONAL explicit per-operation token quad
    #: ``((kind, (in, out, reasoning, cache_read)), ...)`` from the real
    #: agent-event calibration (:mod:`pipeline_sim.events`).  When set the engine
    #: splits an operation's LLM cost by these MEASURED magnitudes instead of the
    #: flat per-step ratios, so the run's input/output/reasoning/cache-read
    #: composition matches the event stream.  A hashable tuple keeps
    #: :class:`PipelineConfig` hashable (it is a frozen dataclass).  ``None`` (the
    #: default) preserves the existing ratio-based behaviour exactly.
    op_event_profiles: Optional[
        Tuple[Tuple[str, Tuple[float, float, float, float]], ...]
    ] = None

    # --- reproducibility -------------------------------------------------
    seed: int = 0

    # ------------------------------------------------------------------
    @property
    def M(self) -> int:
        """Total tickets = W_tot / w (spec 3.1)."""
        return int(round(self.W_tot / self.w))

    @property
    def num_buckets(self) -> int:
        """``b = ceil(M / n)`` -- the last bucket may be short of ``n``."""
        if self.n <= 0:
            raise ValueError("bucket size n must be >= 1")
        return math.ceil(self.M / self.n)

    @property
    def mean_bucket_size(self) -> float:
        return self.M / self.num_buckets

    # ------------------------------------------------------------------
    # acceptance criteria (spec C4 revised -- a distribution, not a floor)
    # ------------------------------------------------------------------
    @property
    def uses_ac_distribution(self) -> bool:
        """True iff the per-ticket AC count is drawn from a distribution."""
        return self.ac_distribution is not None

    def ac_counts(self, M: Optional[int] = None) -> List[int]:
        """Per-ticket acceptance-criteria counts, length ``M`` (default ``cfg.M``).

        * **distribution mode** (``ac_distribution`` set) -> a seeded draw from
          the 0-heavy :class:`~pipeline_sim.alpha.AcDistribution`;
        * **uniform mode** (``None``) -> ``[alpha] * M``, unchanged.

        Deterministic for a given ``(M, seed)``, so the task-graph builder and
        the engine always agree on the vector.
        """
        m = self.M if M is None else int(M)
        if m <= 0:
            return []
        if self.ac_distribution is not None:
            return self.ac_distribution.sample_counts(m, self.seed)
        return [int(self.alpha)] * m

    def total_ac(self, M: Optional[int] = None) -> int:
        """Total acceptance criteria across all tickets (``sum(ac_counts)``)."""
        return int(sum(self.ac_counts(M)))

    def ac_model_label(self) -> str:
        """Plain-English description of the AC model (UI / report / docs)."""
        if self.ac_distribution is not None:
            return self.ac_distribution.describe()
        return f"{self.alpha} AC per ticket (uniform)"

    def prices(self) -> Tuple[float, float, float]:
        """``(p_in, p_out, p_cache_read)`` USD/token at this config's basis."""
        return prices_for(self.price_basis)

    def repriced(self, basis: str) -> "PipelineConfig":
        """A copy re-derived at the peak/off-peak ``basis`` (spec App. C switch).

        Re-derives every LLM term -- ``c_op`` (from :data:`DEFAULT_TOKENS`),
        ``c_dispatch`` and ``OC`` -- at the requested price basis, and records
        it on ``price_basis``.  A no-op when ``basis`` already matches.
        """
        p_in = prices_for(basis)[0]
        return replace(
            self,
            price_basis=basis,
            c_op=derive_op_costs(DEFAULT_TOKENS, basis=basis),
            c_dispatch=DISPATCH_SCHEMA_TOKENS * p_in,
            OC=TOOL_CALL_TOKENS * p_in,
        )

    def resolved_branch_levels(self) -> int:
        """The merge-tree depth actually used.

        ``branch_levels`` is canonical.  When it is left at its default of 1
        and the legacy ``branch`` knob names a non-flat structure, map the
        legacy value: ``hierarchical`` -> 2, ``serial`` -> 1 (a legacy chain of
        *buckets* has no independent-tree equivalent; it degrades to flat).
        """
        if self.branch_levels != 1:
            return self.branch_levels
        if self.branch == "hierarchical":
            return 2
        return 1

    def resolved_test_level(self) -> Tuple[str, int]:
        return parse_test_level(
            self.test_level, self.resolved_branch_levels()
        )

    def effective_rework_p(self) -> float:
        """Per-bucket rework probability actually used (spec 5.2).

        When ``plan`` is placed **before implement** the plan arrives late, so
        implementation's rework odds increase by ``plan_rework_multiplier``
        (clamped at 1.0).  Otherwise the base ``p`` is used unchanged, so the
        default behaviour is preserved.
        """
        if self.plan_position == "before_implement":
            return min(1.0, self.p * self.plan_rework_multiplier)
        return self.p

    def resolve_task_graph(self) -> "TaskGraphSpec":
        """The scenario's task graph (``T_active`` + ``P``), or the default.

        Local import of :mod:`pipeline_sim.taskgraph` keeps the import graph
        acyclic (``taskgraph`` imports ``config``).
        """
        from .taskgraph import spec_from_config

        return spec_from_config(self)

    def task_graph_validation(self) -> "TaskGraphValidation":
        """C19/C20 validation of the resolved task graph (spec 3.6)."""
        from .taskgraph import validate_task_graph

        return validate_task_graph(self.resolve_task_graph(), cfg=self)

    def validate(self) -> None:
        if self.M <= 0:
            raise ValueError("M = W_tot / w must yield at least one ticket")
        if self.n <= 0:
            raise ValueError("bucket size n must be >= 1")
        # C4 REVISED (spec Appendix E): alpha is a DISTRIBUTION dominated by 0,
        # not a floor.  With a distribution the scalar ``alpha`` is ignored
        # (0 is legal); the legacy uniform mode keeps its >= 1 floor so existing
        # scalar configs are unchanged.
        if self.alpha < 0:
            raise ValueError(
                "alpha (AC per ticket) must be >= 0 (spec C4 revised)"
            )
        if self.ac_distribution is None and self.alpha < 1:
            raise ValueError(
                "alpha (AC per ticket) must be >= 1 in uniform mode; set "
                "ac_distribution for the 0-heavy real distribution "
                "(spec C4 revised / Appendix E)"
            )
        if self.m < 1:
            raise ValueError("agent count m must be >= 1")
        if self.max_parallel_buckets is not None and self.max_parallel_buckets < 1:
            raise ValueError(
                "max_parallel_buckets must be >= 1 or None (unlimited) (spec 1.1)"
            )
        if self.e <= 0:
            raise ValueError("test execution time e must be > 0")
        if self.t_suite < 0:
            raise ValueError("t_suite must be >= 0")
        if not (0.0 <= self.p <= 1.0):
            raise ValueError("rework probability p must be in [0, 1] (spec A1)")
        if self.rho < 0:
            raise ValueError("blast-radius coefficient rho must be >= 0 (spec f3)")
        if self.c_agent < 0:
            raise ValueError("c_agent (parallelism cost) must be >= 0 (spec 4-f2)")
        if self.c_branch < 0 or self.c_level < 0:
            raise ValueError(
                "c_branch / c_level (per-branch cost) must be >= 0 (spec §4 NOTE)"
            )
        if self.c_bucket < 0:
            raise ValueError(
                "c_bucket (per-bucket setup cost) must be >= 0 (spec §4 NOTE / OPEN-7)"
            )
        if self.c_gate_rework_per_deferred_ac < 0:
            raise ValueError(
                "c_gate_rework_per_deferred_ac must be >= 0 (spec 5.2 deferral cost)"
            )
        if self.price_basis not in PRICE_BASIS:
            raise ValueError(
                f"unknown price_basis {self.price_basis!r}; expected one of "
                f"{sorted(PRICE_BASIS)} (spec Appendix C)"
            )
        if self.branch not in ("flat", "hierarchical", "serial"):
            raise ValueError(f"unknown branch structure: {self.branch!r}")
        if self.branch_levels < 1:
            raise ValueError("branch_levels must be >= 1 (spec 3.4)")
        if self.branch_fanout < 2:
            raise ValueError("branch_fanout must be >= 2 (spec 3.4)")
        if self.test_exec not in ("full_suite", "affected_only"):
            raise ValueError(f"unknown test_exec: {self.test_exec!r}")
        # operator topology variants (spec 5.2)
        if self.plan_position not in ("before_routing", "before_implement"):
            raise ValueError(
                f"unknown plan_position {self.plan_position!r}; expected "
                "'before_routing' or 'before_implement' (spec 5.2)"
            )
        if self.plan_rework_multiplier < 1.0:
            raise ValueError(
                "plan_rework_multiplier must be >= 1.0 (it can only INCREASE "
                "rework odds when plan is placed before implement; spec 5.2)"
            )
        if self.release_gate not in ("off", "branch", "main"):
            raise ValueError(
                f"unknown release_gate {self.release_gate!r}; expected "
                "'off', 'branch' or 'main' (spec 5.2)"
            )
        if self.c_gate_rework_branch < 0 or self.c_gate_rework_main < 0:
            raise ValueError("release-gate remediation costs must be >= 0")
        if self.c_gate_rework_main < self.c_gate_rework_branch:
            raise ValueError(
                "c_gate_rework_main must be >= c_gate_rework_branch: remediating "
                "a failure on main needs a NEW branch, so it is more expensive "
                "(spec 5.2)"
            )
        if self.test_level == "none" and self.release_gate == "off":
            raise ValueError(
                "test_level='none' with release_gate='off' would run no test at "
                "all, violating C10; enable a release gate (spec 5.2)"
            )
        # raises on a malformed test_level
        self.resolved_test_level()
        if self.sigma != "natural":
            raise NotImplementedError(
                "Only the 'natural' merge order is implemented; "
                f"sigma={self.sigma!r} requires the search milestone."
            )
        if self.role_partition:
            raise NotImplementedError(
                "Agent-role partition (Pi_R / constraint C15) is outside the "
                "implemented constraint set; a homogeneous agent pool is used."
            )
        # custom task types (spec 3.6): unique ids, no collision with the
        # catalogue, and a known scope.
        if self.custom_task_types:
            from .taskgraph import CATALOGUE_IDS, SCOPE_LABELS, normalize_scope

            seen: set = set()
            for ct in self.custom_task_types:
                cid = getattr(ct, "id", None)
                if not cid:
                    raise ValueError("custom task type requires a non-empty id")
                if cid in CATALOGUE_IDS:
                    raise ValueError(
                        f"custom task type id {cid!r} collides with the catalogue"
                    )
                if cid in seen:
                    raise ValueError(f"duplicate custom task type id {cid!r}")
                seen.add(cid)
                if normalize_scope(getattr(ct, "scope", "")) not in SCOPE_LABELS:
                    raise ValueError(
                        f"custom task type {cid!r}: unknown scope "
                        f"{getattr(ct, 'scope', None)!r}"
                    )
        # spec 3.6 / C19: reject a cyclic orchestration of the task graph.  Only
        # checked when the graph is overridden -- the default graph is known-good
        # and skipping it keeps the hot path (every run) unchanged.
        if (self.T_active is not None or self.P is not None
                or self.custom_task_types):
            report = self.task_graph_validation()
            if not report.ok:
                raise ValueError(
                    "task graph invalid (spec C19/C20): " + "; ".join(report.errors)
                )
