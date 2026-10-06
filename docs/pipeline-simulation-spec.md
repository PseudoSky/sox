# SPEC — Simulation Model of an Agentic Software-Delivery Pipeline

**Nature of the artifact:** a discrete-event simulation plus a design-knob search.
This is **not** an operational scheduler or dispatcher. Nothing is dispatched to
production; the pipeline is instantiated in-simulation purely to compare designs.

**Status:** draft. Contains open assumptions (see §5.1) and unverified derived
results (see §6) that the experiments in §7 are designed to test. Research
findings integrated in §9.

---

## 0. Core hypothesis

> **H1 (deferred testing).** Multi-level branching lets a team *postpone* suite
> runs to higher merge levels. If a full-suite run is expensive and compounds
> (each run re-executes all accumulated ACs), then deferring testing to fewer,
> higher-level runs **decreases both total cost and end-to-end time**, at the
> price of later feedback (higher blast radius / risk).

The model exists to test H1: compare "test at every merge" against "defer tests
to top-level merges", across branch depth, with an expensive compounding suite.

---

## 1. Problem statement

A software-delivery pipeline consists of typed tasks whose execution order is
governed by precedences and synchronization barriers. A pool of agents executes
the tasks; agents may be specialised to subsets of task types. Work is organised
into **buckets** (groups of tickets) and executed on **branch structures** whose
depth and shape are a separate design axis; suite runs may be scheduled at
chosen branch levels. Some stages are optional gates, and the cost/time of
testing compounds as the accumulated suite grows.

**Given** a fixed workload and a set of cost / time / quality parameters,
**choose** the design knobs (bucket size, AC target, branch depth, test level,
agent-role partition, agent count, merge order) that **optimise** a
multi-objective performance vector (makespan, cost, risk, quality) **subject to**
the pipeline's precedence, resource, isolation, and coverage constraints.

### 1.1 Two independent axes (do NOT conflate)

```
BUCKET             a GROUP OF TICKETS -- a planning / assignment unit.
                   NOT a git term, NOT a merge unit.

MERGE STRUCTURE    a tree of branches over work units. Its depth (`branch_levels`),
                   fanout, and unit granularity are their OWN knobs, independent
                   of how tickets are grouped into buckets.
```

M1 conflated these (buckets *were* the merge units). The corrected model keeps
them orthogonal: buckets group tickets; the branch tree defines merges.

---

## 2. Objectives — the questions to answer

```
RQ1  Bucket sizing
     What bucket size n (tickets per group) minimises cost / makespan?
     Is there a sqrt(M) law?

RQ2  Ticket sizing (input)
     How sensitive is the optimum to ticket granularity w?

RQ3  AC target
     What AC count per ticket alpha is optimal (cost vs quality trade-off)?

RQ4  Merge-branching structure  (independent of bucket)
     Does depth > 1 beat flat direct-to-main merging? When?

RQ5  Bucketing efficacy  (independent of branching)
     Is grouping tickets into buckets more efficient than per-ticket?

RQ6  Agent specialisation
     Which task combinations should agents specialise in?

RQ7  Merge sequencing on a single-writer main
     Does merge order affect cost / makespan?

RQ8  Agent count
     Does the fixed-charge dispatch cost give an interior optimum?

RQ9  Objective structure
     What is the true objective set and its Pareto trade-off surface?

RQ10 Methodology
     Does the simulation agree with analytic closed-forms and, on small
     instances, with an exact solver?

RQ11 DEFERRED TESTING  (the core hypothesis H1)
     Does multi-level branching + postponed testing reduce total cost AND
     end-to-end time, versus testing at every merge?
```

---

## 3. Definitions

### 3.1 Sets and symbols

```
M         total tickets = W_tot / w
B         set of buckets (ticket groups); b = |B| = M / n
K_b       tickets in bucket b; |K_b| = n
A_bk      acceptance criteria of ticket (b,k); a 0-heavy distribution (C4)
N         branch tree: nodes are merge points, rooted at main; leaves are work
          units.  depth = branch_levels.  INDEPENDENT of B.
W         set of worktrees/branches (the nodes of N that do work)
R         set of agents
T         set of task types (see 3.3)
F_k       files touched by ticket k
G_X       ticket file-conflict graph: (k,k') edge iff F_k ∩ F_k' != empty
```

### 3.2 Parameters (inputs, not optimised)

```
WORKLOAD / SIZING
  W_tot     total workload
  w         work per ticket            -> M = W_tot / w
  alpha     AC per ticket              (a distribution: mostly 0; see C4/App. E)

TIME (per operation and per dispatch)          << NEW
  t_dispatch   fixed latency to start a FRESH agent (cold start)
  t_op[tau]    duration of one operation of type tau
  t_suite      fixed overhead to LAUNCH one test-suite run
  e            per-AC test execution time  (HIGH; e > 3 s)

COST
  c_dispatch   token cost per fresh agent dispatch   (== c_sys)
  c_op[tau]    token cost of one operation of type tau
  c_suite      fixed cost per test-suite run         (HIGH)
  c_a          per-AC test cost                      (HIGH)
  c_wt         worktree dispatch / setup cost
  c_merge      merge dispatch cost
  c_wip        holding / open-bucket carrying cost per unit per time
  c_agent      cost per agent per unit BUSY time (concurrency / occupancy)   [fix]
  OC           cost per tool call
  O_nu         tool calls for task instance nu

RELIABILITY
  p            per-bucket rework probability (1 impl pass + reconfirm)
  rho          blast-radius coefficient

FILES
  F_k          file sets (defines G_X)
```

**Defaults are calibrated to real prices** (Appendix C): LLM token costs from
DeepSeek V4.1 Flash, CI runner costs from GitHub Actions Linux. Test parameters
are set so the compounding suite is a first-order cost and deferral is
measurable; re-calibrate against your own billing (OPEN-3).

### 3.3 Task types and scopes

```
ATOMIC (16)                                   COMPOSITE (8)
------------------------------------------    ----------------
1  ticket intake                                INTAKE
2  ticket routing
3  triage (optional)                            SHAPING (optional)
4  spec (optional)
5  execution plan (bucketing)                   PLANNING
6  implementation                               IMPLEMENT
7  test writing                                 TEST
8  test running
9  code review                                  REVIEW
10 review routing
11 git worktree setup                           GIT OPS
12 git worktree merge + resolution
13 main build                                   INTEGRATE
14 pre-release gates                            RELEASE
15 release
16 post-release verification
```

A **task instance** is `(tau, ticket, ac, branch, agent)`.

The 16 kinds above are the **DEFAULT catalogue**; custom task types may be added
with their own configuration (§3.6).

### 3.4 Design variables (decision)

```
n              tickets per bucket (GROUP SIZE)        (integer, <= M)
alpha          AC per ticket                          (integer >= 1)
branch_levels  depth of the merge tree                (integer >= 1)
branch_fanout  children per branch node               (integer >= 2)
test_level     which merges trigger a suite run       all | top | level:L
test_exec      full_suite | affected_only
Pi_R           partition of task types into agent roles
m              agent count
sigma          merge order at main (or a policy)
y              optional-gate enable flags (triage, spec)
w1,w2,w3       objective weights
```

`branch_levels` and `test_level` are the knobs that express H1: raising depth
and setting `test_level = top` postpones testing to fewer, higher runs.

### 3.5 Simulated state

```
x(nu,r)   assignment of instance nu to agent r
ts(nu)    start time          tf(nu) finish time
zeta(n)   parent of branch node n
```

### 3.6 Task set and dependency graph (user-editable inputs)

```
T_active   active task types = a subset of the CATALOGUE plus any CUSTOM types
P          precedence relation over ACTIVE task instances -- a DAG
           enable / disable types; add / remove edges; add CUSTOM types
```

The 16 kinds of 3.3 are the **DEFAULT CATALOGUE**. A scenario selects which are
active, how they depend, and **may add custom task types**. Domain-mandated
edges are defaults that may be extended but not removed (C19/C20).

**Task type schema** -- every kind, catalogue or custom, is an instance:

```
TaskType {
  id                      unique key
  name                    display name
  scope                   ticket | ac | bucket | merge_node | worktree | global
  phase                   intake | planning | build | verify | vcs | integrate | release
  optional                bool  (disable-able without breaking C20)
  t_op                    duration, seconds
  cost                    { in_tok, out_tok } tokens, or an explicit c_op (USD)
  tool_calls              O_nu  (tool calls per fire)
  default_predecessors    [task ids]   (seeds the DAG; editable)
  default_successors      [task ids]
}
```

The 16 defaults of 3.3 are this schema instantiated with the Appendix C values;
custom types inherit the same fields and participate in `P` like any other node.
`test_write`/`test_run` keep their per-AC semantics; a custom type's `scope`
determines its occurrence count (Appendix D).

---

## 4. Objectives (multi-objective)

```
f1  makespan  C_max = max over instances of tf, where each instance consumes
               t_dispatch (once per fresh agent) + t_op[tau] (per operation),
               and each suite run consumes t_suite + sum of e_a over its ACs;
               resource/queue waits are additive.

f2  cost      = sum_nu (O_nu * OC)                      [tool / compute]
              + c_dispatch * (#dispatches)
              + sum_tau ( c_op[tau] * count_tau )
              + c_wt   * (#worktrees)
              + c_merge* (#merges)
              + sum over suite runs ( c_suite + sum_{a in accumulated} c_a )
                                                        [TEST: high + compounding]
              + c_wip  * n * horizon                     [holding]
              + c_agent * (total agent-busy time)        [parallelism cost]    [fix]

f3  risk      = rho * blast_radius(branch_depth, deferral) * conflict_rate
              + p * (expected rework burden)              [MUST be implemented] [fix]
f4  quality   = AC coverage, escaped-defect proxy
f5  utilisation = mean agent busy fraction
```

The TEST term is the compounding one: each suite run costs `c_suite` **plus all
accumulated ACs**, so *fewer runs* (deferral) is cheaper. This is what makes H1
testable.

```
min over (n, alpha, branch_levels, branch_fanout, test_level, test_exec,
          Pi_R, m, sigma, y) of ( f1, f2, f3 )   s.t.  quality f4 >= q_min
Report the PARETO FRONT, not a single optimum.
Reductions permitted: weighted scalarisation, epsilon-constraint, lexicographic.
```

**NOTE (batch-law requirement).** L1 (`n* ~ sqrt(M)`) needs BOTH a per-batch
setup term (∝ 1/n) and a holding term (∝ n). The setup term is per-merge
worktree/merge/suite cost; the holding term is `c_wip·n` (or local suite re-runs
on within-branch merges). Without a ∝ n term the optimum degenerates to one
giant bucket. See OPEN-7.

**NOTE (holding horizon).** `horizon` in `c_wip·n·horizon` is a FIXED planning
horizon (a constant input), **not** the realised makespan. If it were the
realised makespan, a compounding suite makes makespan grow with M, so holding
becomes ∝ `n·T(M)` and L1 degenerates to a constant `n*`. This is a modelling
choice (EOQ's `T` is likewise a fixed period); flag if a makespan-varying
horizon is intended.

**NOTE (why `c_agent` + `f3`).** With only the original terms, every
cost-reducer also reduces makespan, so the cost-vs-makespan Pareto front
**collapses to a single point** (observed: 324-point grid -> 1 point). The two
additions close it: `c_agent` makes parallelism cost money (so buying time with
more agents costs more), and the risk objective `f3` makes deferral cost risk
(so buying cheapness with deferral has a downside). Together they yield a real
cost x time x risk frontier.

---

## 5. Constraints

```
C1  bucket size        |K_b| = n,  b = M/n        (bucket = ticket group only)
C2  file-op floor      per ticket >= 4 ops (2 reads + 2 writes: src + test)
C3  tool cost          Cost contribution sum O_nu * OC             (objective)
C4  AC distribution    a_bk is a 0-heavy distribution, NOT a floor: the MODAL
                       ticket carries 0 acceptance criteria (~93% have none; a
                       ~7% tail carries ~3-5, median 4), so E[a_bk] ~= 0.3.  A
                       0-AC ticket generates no test-write / test-run work.
                       (Revised from the earlier "a_bk >= 1" floor -- the real
                       backlog contradicts it; see Appendix E.)
C5  branch tree        N is a tree rooted at main; each node one parent
C6  test order         ts(test_run) >= tf(all test_writes of the ticket)   (see 5.2)
C7  merge after all    a merge node starts only after all its children finish
C8  release barrier    ts(release) >= max( all main merges, pre-release gates )
C9  suite compounds    a suite run's size = all ACs landed so far; cost/time
                       grow monotonically with the run index
C10 test policy        a suite run occurs at every merge node selected by
                       `test_level`; at least one test must occur before release
C11 agent capacity     at any time, an agent runs <= 1 task
C12 precedence         for every edge (u,v): tf(u) <= ts(v)
C13 file isolation     F_b ∩ F_b' = empty for all b != b'   (design intent)
C14 parallel overlap   units run concurrently UNLESS separated by a component
                       DEPENDENCY edge (A depends on B => B publishes first).
                       File overlap does NOT serialize: the file-overlap graph
                       is a citation artifact (Appendices E.1/E.2), never a
                       parallelism bound.
C15 role skill         x(nu,r)=1 requires tau(nu) in skill_set(r)
C16 main unit-capacity one merge to main at a time
C17 dispatch latency   every fresh agent start adds t_dispatch / c_dispatch,
                       even before any operation runs
C18 deferral allowed   testing MAY be postponed: no constraint forces a suite
                       run below `test_level` (this is what H1 exploits)
C19 task graph acyclic P must be a DAG (no cycles); the UI rejects cycles
C20 required edges     P must CONTAIN the domain-mandated edges
                       (impl -> test_run, work -> its merge, merges -> release);
                       user edges may add to, but not remove, these
```

### 5.1 Assumptions register

```
A1  rework is bounded depth-1, per bucket, probability p
A2  task durations: deterministic baseline; stochastic variant (see 7)
A3  test execution: full_suite | affected_only  (affects C9 compounding)
A4  agents have sufficient context (context modelled as dispatch cost c_sys/t_dispatch)
A5  tickets independent except through the COMPONENT dependency / publish DAG
    (intra- and cross-project); the file-overlap graph G_X is a citation
    artifact, not a coupling (Appendix E.1)
A6  G_X static and known (a citation artifact, not a scheduling input)
A7  optional gates (triage, spec) can be on / off
A8  main = serialized merge + pipelined validation
A9  bucket decomposition = a component (or a group within one); components run
    in parallel across the project, projects across the store (Appendix E.1)
A10 the branch tree is independent of the bucket grouping

### 5.2 Intended pipeline topology (operator-specified)

Edges (the operator's intended flow — replaces the linear default):

```
intake -> {triage, spec}             triage and spec run in PARALLEL
{triage, spec} -> routing
routing -> {implement, test_write}   implement and test-write run in PARALLEL
implement -> review                  review depends on implementation ONLY
test_write -> test_run               test_run depends on test-write (NOT implement)
{review, test_run} -> merge-to-main  BOTH must finish before the merge
merge-to-main -> [release gate] -> release
```

Semantics:
- `review` follows `implement` only; it does NOT wait on `test_run`.
- `test_run` follows `test_write`; it must only complete **before merge-to-main**,
  not before review. (This relaxes C6: test_run no longer waits on implement.)
- `test_run` **compounds**: it re-runs every ticket landed before it (C9).
- `plan` (execution plan) is placed either **before routing** or **before
  implement**; when placed before implement, implementation's **rework odds
  increase**.
- `release gate` is a **full test run** that may be placed **before merge-to-main
  or on main**, and may be the **only test run** in the extreme. Remediating a
  failure found by a release gate on an **L2 branch** requires resolving all
  issues there; on **main** it requires a **new branch** and is more expensive.
```

---

## 6. Derived results to test (not assumed)

```
L1   n* ~ sqrt(M)                             (cost-optimal bucket size)
       [anchor: EOQ/ELSP square-root batch law, §9]
       [PRECONDITION: cost must include a ∝ n holding term -- see OPEN-7]
L2   greater branch depth + deferred testing reduces #suite runs
L3   feasible bucketings = coarsenings of G_X components
L4   bucketing never costs parallelism (given file isolation)
L5   merge largest-batch-last minimises cumulative suite cost
L6   agent count has an interior optimum under c_dispatch
L7   optimal roles cluster along barriers
L8   H1: branch_levels>1 and test_level=top reduces BOTH cost and C_max
     versus branch_levels=1, test_level=all (this is the headline claim)
```

These are hypotheses the simulation must confirm or refute.

---

## 7. Experiment design

### 7.1 Factors and levels

```
FACTOR           TYPE       LEVELS
--------------   --------   ------------------------------------------
n                integer    1..M (bounded sweep around sqrt M)
alpha            integer    1..5
branch_levels    integer    {1, 2, 3, 4}
branch_fanout    integer    {2, 3, ...}
test_level       cat        {all, top, level:1..L}
test_exec        cat        {full_suite, affected_only}       [HIGH e]
Pi_R             partition  enumerated (Bell(8)=4,140) or sampled
m                integer    swept
sigma            policy     {natural, largest-last, smallest-first, random}
p, rho           continuous point estimates +/- band
w                input      swept for sensitivity (RQ2)
w1,w2,w3         weights    ~7 samples on the simplex
durations        stochastic deterministic vs stochastic band
file graph G_X   regime     no-edges | fragmented | one component
```

### 7.2 Responses

```
L1 C_max          L2 total Cost        L3 Risk            L4 Quality
L5 utilisation    L6 #suite runs       L7 #dispatches     L8 #test executions
L9 critical-path length (LB)          L10 deferred-test savings vs baseline
```

### 7.3 Comparison / search method

```
- COMMON RANDOM NUMBERS across variants (causal differences, not noise).
- REPLICATIONS: Monte Carlo + confidence intervals.
- PAIRED comparisons, especially the H1 contrast (defer vs test-every-merge).
- METHOD: simulation-optimization (SimPy + ranking-and-selection / OCBA).
- Exact cross-check on small M via CP-SAT (optional).
```

### 7.4 Experiment matrix

```
ID   Varies                                Answers
---  -----------------------------------   ----------------
X1   n                                     RQ1, L1
X2   branch_levels x test_level            RQ4, RQ11, L2, L8   <-- HEADLINE
X3   file graph regime                     RQ5, L3, L4
X4   role partition Pi_R                   RQ6, L7
X5   agent count m                         RQ8, L6
X6   merge order sigma                     RQ7, L5
X7   rework p, rho                         RQ3, RQ9
X8   weights w1,w2,w3                      RQ9
X9   alpha                                 RQ3
X10  ticket sizing w                       RQ2
X11  test_exec {full, affected}            RQ3
X12  branch_fanout                         RQ4
X13  dispatch time/cost sweep              RQ8
```

### 7.5 Execution order

```
STAGE 0  Screening (Sobol) -> keep dominant factors
STAGE 1  H1 CONTRAST: {branch_levels, test_level} grid  (the core experiment)
STAGE 2  Structural: roles (enumerate <=8 types), fanout
STAGE 3  Numeric sweep: n, alpha, m
STAGE 4  Order policy comparison
STAGE 5  Pareto assembly + local refine
```

### 7.6 Validation

```
V1  analytic cross-check   : does sim reproduce L1 (sqrt M)?
V2  CP-SAT cross-check     : small M, sim optimum == exact solver?
V3  lower-bound check      : sim C_max >= critical path
V4  calibration            : one real run in -> predicted vs actual out
V5  reproducibility        : versioned configs + seeds
V6  face validity          : does the policy match practitioner intuition?
V7  H1 sanity              : deferring tests must reduce #suite runs; verify
                             the cost/time delta sign matches the mechanism
```

### 7.7 Success criteria

```
S1  A policy that beats the current-practice baseline without breaking q_min.
S2  Reproduced across seeds (CI excludes baseline).
S3  Consistent with analytic bounds and, on small M, with an exact solver.
S4  H1 resolved: state whether deferred testing reduces cost AND e2e time,
    and under what (branch depth, e, c_suite) conditions.
```

---

## 8. Deliverable of the simulation

```
1. A parameterised simulator (one engine, config-driven).
2. A results dataset { (config, responses) } over the design space.
3. The Pareto front(s) per research question.
4. Tested / refuted status of L1-L8.
5. A recommended POLICY generalising the per-instance optima.
6. A clear verdict on H1 (deferred testing).
```

---

## 9. Integrated research findings

Research run 2026-10-05. Integration rule: **include only what makes the
implementation simpler (less code) or faster.** Everything else is a reference.

### 9.1 Tools

```
INTEGRATE (one dependency + two formulas):
  SimPy (DES engine), the sqrt(M) analytic sizing, a greedy dispatcher.
CONDITIONAL:
  OR-Tools CP-SAT -- exact oracle for small-M validation only.
DO NOT INTEGRATE:
  pymoo, WfCommons/WRENCH, salabim, simoptlib, Mesa, npm DES libs.
```

### 9.2 Patterns / prior art (references)

```
Merge-queue batching     industry analogue of batching merges to cut CI runs;
                         "bisect on failure" = blast radius.  (ref)
Test Impact Analysis     run only affected tests; 60-80% cut, >=95% detection;
                         the alternative to full-suite-per-merge (A3).  (ref)
EOQ / ELSP sqrt law       citable anchor for L1.  (ref)
Fork-join queueing        bounds for split-then-join barriers.  (ref)
Stochastic RCPSP          proactive (buffers) vs reactive (online).  (ref)
Priority-rule RCPSP       fast list-scheduling inner scheduler.  (ref)
CCPM buffer sizing        uncertainty aggregation (risk f3).  (ref)
```

### 9.3 Production evidence

```
Anthropic, "Agentic coding is straining CI": agentic coding raised CI job
volume 25x in 6 months; bottleneck moved to the test-selection service; v0
failed because it needed a SINGLE WRITER.  => our compounding-suite (C9) and
single-writer-main (C16) assumptions are production-observed, and test cost is
the binding constraint in a real agentic pipeline.  Supports H1's premise that
suite cost dominates and deferral matters.
```

### 9.4 Neglected areas now surfaced

```
N1  Workload generation (how M tickets + G_X are produced)
N2  Selective test execution (A3 variant)
N3  Merge-queue batching + bisection as the industrial analogue
N4  Time-buffer / risk under uncertainty (CCPM, SRCPSP)
N5  Deferred testing via multi-level branches (H1) -- the core question
```

---

## 10. Visualization — plot pack

Engine: **matplotlib** (static PNG) + **plotly** (interactive HTML), outputs to
`tools/pipeline-sim/plots/`. Figures (see §9 research for the techniques):

```
1  sqrt-scaling        n* vs M, log-log, fitted exponent (~0.49)      [L1]
2  H1 contrast         paired slope/dumbbell, baseline vs deferred,   [H1]
                       cost and makespan across M
3  Pareto front        cost vs makespan scatter + frontier             [RQ9]
4  interaction heatmap cost/makespan over (branch_levels x test_level) [H1/X2]
5  tornado             one-at-a-time knob effects on total cost        [7.1]
6  compounding curve   suite cost/time vs accumulated ACs              [C9]
7  small multiples     objectives vs n, faceted by branch level
8  Gantt + utilisation schedule timeline with agent utilisation
9  parallel coords     knobs -> (cost, makespan, risk)
10 dashboard           interactive HTML linking the above
```

Justification: Pareto scatter + EAF for the trade-off; tornado then Sobol for
sensitivity; parallel coordinates for the high-dim design space; small multiples
(not animation) for comparison; Gantt + utilisation for the schedule.

### 10.1 UI = design-space EXPLORER, not a knob form

The point of the model is to explore the design space, not to hand-set knobs.
The interactive UI is therefore an explorer:

```
0  EDIT the task graph        toggle ACTIVE task types; add/remove dependency
                              edges; preview the DAG; validate acyclic (C19)
                              + required edges (C20)
1  DEFINE the search domain   set each knob's RANGE / level set, not a value
2  RUN the sweep / optimizer  over the constrained space (small after bounds)
3  VISUALIZE                  Pareto frontier + response surfaces +
                              tornado/Sobol + parallel coordinates
4  DRILL DOWN                 click a discovered point -> inspect its config
                              (knobs shown as a read-out), Gantt, breakdown
5  SCENARIO                   force a specific config (e.g. current practice)
                              and compare it against the frontier
```

The knobs survive as search BOUNDS, as a drill-down read-out, and as scenario
overrides -- never as the primary way the answer is chosen.

### 10.2 Cost preview + variant comparison (operator requirement)

```
1  COST PREVIEW ON THE DAG
   every node is annotated with its ANTICIPATED cost
   (expected $/fire x occurrence count) and the DAG shows the total.

2  VARIANT COMPARISON
   the top-performing discovered DAG variants are rendered SIDE BY SIDE;
   each variant HIGHLIGHTS its differences from the PRIMARY (baseline) DAG;
   each variant's METRICS (cost, end-to-end time, risk, suite runs) are shown
   BELOW its DAG.
```

The DAG is rendered vertically; variants differ by task set / edges / plan
placement / test tier / branch depth.

```
3  SYNTHESIS (per optimal configuration)
   explain EVERY option -- ALL knobs (bucket size, work per ticket, AC target,
   branch depth/fan-out, test timing/scope, agents, parallelizable buckets, plan
   placement, release gate, objective weights), NOT just the branching config.
   For each: the value AND a plain-language meaning / why it is optimal.
   ALSO show the DELTAS vs the PRIMARY (baseline):
     % faster  (end-to-end time)
     % cheaper (cost)
     % safer   (risk)
     % overall (the weighted combination)
```


---

## Appendix A — theta schema

```
theta = (
  W_tot, w,                                   # inputs
  n, alpha,                                   # sizing
  branch_levels, branch_fanout,               # merge structure (independent)
  test_level, test_exec,                      # testing schedule
  Pi_R, m, sigma, y,                          # agents / order / gates
  p, rho,                                     # reliability
  t_dispatch, t_op[], t_suite, e,             # TIME
  c_dispatch, c_op[], c_suite, c_a, c_wt, c_merge, c_wip, OC,   # COST
  w1, w2, w3                                  # objective weights
)
```

## Appendix B — Open items

```
OPEN-1  deterministic vs stochastic task durations (A2)
OPEN-2  full-suite vs affected-tests-only (A3) -- factor X11
OPEN-3  calibration of e, t_op, c_op, c_dispatch, c_suite, c_a, c_wt, c_merge
OPEN-4  quality floor q_min definition
OPEN-5  whether arrivals are modelled (currently fixed batch of M tickets)
OPEN-6  verification of L1-L8 against literature and against an exact solver
OPEN-7  holding / open-bucket cost mechanism for L1's interior optimum:
        (a) local suite runs on within-branch merges, (b) explicit c_wip,
        (c) rework blast-radius superlinearity via rho.  See BL f9c92068.
OPEN-8  bucket vs merge-unit: FIXED in this revision -- bucket = ticket group,
        merge units = branch-tree nodes. M1 must be revised to match.
```

---

## Appendix C — Realistic calibration (USD, seconds)

Price basis (MEASURED — the operator's real billing):
- **LLM:** DeepSeek Flash, OFF-PEAK — input $0.15 / 1M, output $0.60 / 1M,
  cache-read $0.003 / 1M (peak is exactly 2x; the model defaults to off-peak).
  Claude-tier comparison: Sonnet 5 = $2/$10.
- **CI:** GitHub Actions Linux 2-core — $0.006/min; typical job ~9.9 min.
- Live-verified: `api-docs.deepseek.com/quick_start/pricing`,
  `docs.claude.com/en/docs/about-claude/pricing`,
  `developers.openai.com/api/docs/pricing.md`,
  `docs.github.com/en/billing/reference/actions-runner-pricing`;
  measured from the operator's `~/.local/share/opencode/opencode.db` (read-only).

Per-operation token counts in the table further below were **LOW-CONFIDENCE
placeholders** (originally sampled from a 5-task benchmark; real SWE-bench-class
tasks run 1M-3.5M tokens end-to-end). **They are now REPLACED** by the operator's
real agent-event stream (see Appendix F): `pipeline_sim.events` extracts the
per-agent and per-task distributions from `agent-dashboard/public/events.json`
and drives the simulator's spend forecast from them, per-agent cold-start
included. The table below is retained as the documented placeholder it replaced.

**REAL MEASURED NUMBERS — the operator's own `opencode.db` (extracted read-only,
2026-10-05): 184,841 model steps, 4,662 dispatches, ~3.2 months, $354.65 total.**

```
PRICE BASIS (empirically derived; the real runs bill OFF-PEAK):
  deepseek-flash   input $0.15/M    output $0.60/M    cache-read $0.003/M
  (Appendix C's "peak" $0.30/$1.20 is exactly 2x these -> every per-op $ in
   Appendix C/D is ~2x too high.)

DISTRIBUTIONS (replace point estimates with these):
  per DISPATCH  p50 $0.0307  p90 $0.1176  p99 $0.8464  max $20.57  mean $0.0761
  per STEP      p50 $0.001124  p90 $0.003247  p99 $0.013332  max $0.266
  step tokens   fresh input p50 500 / p90 7,252 ; output p50 220 / p90 1,049
                cache-read p50 141,056 / p90 388,864
  session       output p50 9,843 ; input p50 73,904 / p90 231,325

COST COMPOSITION (all four classes now modelled; percentages are INDEPENDENTLY
ROUNDED, so they sum to ~105%):
  input       40.7 %
  reasoning   19.7 %
  cache-read  28.9 %   (34.5 billion tokens)
  output      15.8 %

TOOL CALL   ~950 tok/call (spec's 1,000 OK) ; real cost $0.000143/call
DISPATCH    first-step ~14,470 input tok, ~$0.0022 per fire (vs est $0.0036)
```

**Consequence:** the simulator must add a **reasoning-token rate** and a
**cache-read rate/volume**, or it under-predicts real spend by ~49 % (those two
classes). `e`/`c_a` and per-op token counts should be **distributions**, not
constants (30x run-to-run variance measured).

```
DISPATCH
  c_dispatch = 12,000 tok in * p_in   = $0.0036          t_dispatch = 3 s

PER OPERATION   (in_tok, out_tok, seconds, LLM cost)
  intake          2k,  1k,   30s,  $0.0018
  routing         2k, 0.5k,  15s,  $0.0012
  triage          5k,  1k,   60s,  $0.0027
  spec           10k,  3k,  120s,  $0.0066
  plan           10k,  2k,  120s,  $0.0054
  implement      30k,  6k,  600s,  $0.0162
  test_write     12k,  4k,  180s,  $0.0084
  test_run        2k,  1k,  = e_a, $0.0018 (+ CI)
  review         20k,  2k,  240s,  $0.0084
  review_route    2k,0.5k,   30s,  $0.0012
  wt_setup        1k,0.2k,   20s,  $0.0005 (+ $0.003 CI)
  merge_resolve  10k,  2k,  120s,  $0.0054 (+ $0.016 CI)
  main_build      3k,0.5k,  300s,  $0.0015 (+ $0.040 CI)
  gates           5k,  1k,  180s,  $0.0027 (+ CI)
  release         2k,0.5k,   60s,  $0.0012 (+ CI)
  post_verify     2k,0.5k,  120s,  $0.0012 (+ CI)

TEST (compounding -- first-order, as required)
  e       = 20 s per AC           (acceptance-test exec; > 3 s)
  c_a     = e/60 * rate = 20/60 * 0.008 = $0.0027 per AC
  t_suite = 30 s                  c_suite = 1 min * rate = $0.008 per run
  suite_run_cost = c_suite + sum_{a accumulated} c_a
  suite_run_time = t_suite + sum_{a accumulated} e_a
  => a run over N accumulated ACs costs 0.008 + 0.0027*N USD and
     30 + 20*N seconds.  Late, large, repeated runs DOMINATE the budget.

TOOL CALL
  OC = 1,000 tok * p_in = $0.0003 per tool call

WORKTREE / MERGE / HOLDING
  c_wt  = $0.003     c_merge = $0.016
  c_wip = $0.001 per open unit per second
          (opportunity cost; tunes the interior optimum -- OPEN-7)

COST DECOMPOSITION (avoids double-counting)                 [fix b46a5f8f]
  c_dispatch   covers system prompt + tool schemas, ONCE per fresh agent start
  O_nu * OC    covers tool-CALL RESULT tokens (per call)
  in_tok / out_tok per op cover the operation's own reasoning / generation
               tokens, EXCLUDING the dispatch overhead and tool-call results
  => the three terms are disjoint; do NOT include schema tokens in in_tok

PER-AC SCOPE                                                [fix ws-scope]
  test_write and test_run are PER-AC: multiply by alpha. test_run's CI part is
  the per-AC c_a (e/60 * rate).

SOURCES
  LLM prices       https://benchlm.ai/deepseek/api-pricing            (Oct 2026)
                   https://benchlm.ai/anthropic/api-pricing           (comparison)
  tokens per task  https://www.terseai.org/how-many-tokens-ai-coding-agents-use
                   https://growthengineer.ai/blog/ai-agent-cost-benchmarks
  tool overhead    https://next.redhat.com/2026/04/23/how-sandboxed-python-reduces-tool-schema-overhead-in-ai-agents/
  CI rates         https://docs.github.com/en/billing/reference/actions-runner-pricing
                   https://craci.com/compare/github-actions-runner-providers
```

**Sanity check of the "test cost is high" requirement:** one full-suite run over
200 accumulated ACs = $0.55 and ~67 min -- versus ~$0.05 of LLM cost for a whole
ticket. So the compounding suite is the dominant cost once a few levels of
testing accumulate, which is exactly what makes deferral (H1) worth measuring.

---

## Appendix D — Expected cost per task item

Per-fire cost = LLM token cost + CI cost (Appendix C). "Scope" is how many times
the item fires in a scenario.

```
task type        LLM$     CI$       total$/fire   scope (occurrences)
-------------    ------   -------   -----------   --------------------
intake           0.0018   0         0.0018        per ticket
routing          0.0012   0         0.0012        per ticket
triage (opt)     0.0027   0         0.0027        per ticket
spec (opt)       0.0066   0         0.0066        per ticket
plan             0.0054   0         0.0054        per bucket
implement        0.0162   0         0.0162        per ticket
test_write       0.0084   0         0.0084        per AC
test_run         0.0018   0.0027    0.0045        per AC
review           0.0084   0         0.0084        per ticket
review_routing   0.0012   0         0.0012        per review
wt_setup         0.0005   0.003     0.0035        per worktree
merge_resolve    0.0054   0.016     0.0214        per merge node
main_build       0.0015   0.040     0.0415        per merge-to-main
gates            0.0027   -         0.0027        global
release          0.0012   -         0.0012        global
post_verify      0.0012   -         0.0012        global
agent dispatch   0.0036   0         0.0036        per fresh agent start
tool call (OC)   0.0003   0         0.0003        per tool call
suite run        0.008    Sum c_a   c_suite + N*c_a   per selected merge node
```

Occurrences in a scenario with `M` tickets, `alpha` ACs/ticket, `b` buckets, and
a branch tree with internal nodes `N_nodes`:

```
tickets  = M          ACs = M*alpha
merges   = N_nodes    suite runs = # merge nodes selected by test_level
```

```
Expected total cost =
    sum over ACTIVE task types ( occurrences * total_per_fire )
  + dispatch term (c_dispatch * #fresh agent starts)
  + rework expectation: sum over buckets  p * (implement + reconfirm + re-review)
  + holding: c_wip * n * horizon
```

The UI task-graph editor shows, for each selected task item, its **expected
cost per fire** and its **occurrence count**, with a running scenario total.

---

## Appendix E — Real ticket population (operator's backlog, read-only 2026-10-05)

Source: the `sox-ecosystem` backlog graph.

```
POPULATION   : 1,271 live issues -> 880 open / 391 closed
KINDS        : bug 45% · BL 20% · debt 15% · issue 7% · FEAT 4% · task 3% · other ~6%
PRIORITY     : MEDIUM 41% · HIGH 27% · LOW 23% · CRITICAL 3% · 11% carry none
BODY         : median 1,503 chars; 54% carry a Citations block (~2.2 citations/item)

ACCEPTANCE CRITERIA
  The MODAL ticket carries ZERO explicit acceptance criteria, but the rate is
  ~6%, NOT the 2.4% first reported (that was a HEADING-ANCHORED artifact: a
  title-case "Acceptance Criteria" search matches 0; the true case-insensitive
  literal phrase rate is 5.8%).  ~7.5% carry any AC-ish marker; ~17.4% counting
  weak "must be/have" language.
    - explicit AC section : ~6% of all tickets / ~10% of work-type tickets
    - median 4 criteria among those (range 2-6)
    => expected acceptance-criteria per ticket ~= 0.24-0.3, NOT >= 1.
  The FORMAT has drifted (checkbox lists -> bold-inline "red->green test" ->
  enumerated AC-n / markdown heading; lowercase-c consistently; ZERO Gherkin /
  test-scenario forms), but the ORDER OF MAGNITUDE stands.  Root cause of the
  low rate is the corpus mix (~45% bug/defect + ~15% debt, which carry a repro
  rather than pre-agreed ACs), not under-detection alone.
  CAVEAT: the graph is only ~15 days old (a recent migration), so time-series
  claims are composition-dominated, not authoring drift.

IMPLICATION for the simulator's defaults
  M     ~ 880  (the open / takeable set; a sprint-sized batch is ~40-60)
  alpha ~ 6% of tickets carry ACs (~4 each); ~94% carry none
  MIX   : ~45% bug / 15% debt / 20% BL-family / 7% issue / ~13% feature / ~1% plan
```

**C4 is a DISTRIBUTION, not a floor** (revision applied). The old spec mandated
`a_bk >= 1` for every ticket, but reality is dominated by **0** — the modal
ticket has no acceptance criteria. C4 now models `alpha` as a **0-heavy
distribution** (~93 % of tickets carry none; a ~7 % tail carries ~3-5, median 4;
E[`a_bk`] ~= 0.3), and a 0-AC ticket generates no test-write / test-run work.
Modelling a constant `>= 1` would have the test/suite machinery (which keys off
ACs) overstate the work for ~93 % of real tickets.

### E.1 File-overlap / bucketing (from the tickets' citations + body paths)

```
FILES       1,411 distinct; heavy tail (897 cited by 1 ticket ... 1 by 84).
HOT FILES   turso-adapter.ts 84 · memory-server/index.ts 83 · CHANGELOG.md 81 ·
            apps/sox/main.ts 79 · AGENTS.md 49 · graph-store/index.ts 49 ·
            integrity.ts 39 · CLAUDE.md 38 · sox-telemetry/runtime.ts 38 ·
            install-engine/install.ts 35 · memory-core/recall.ts 35
OVERLAP     ONE GIANT COMPONENT, not fragmented:
  graph (tickets share >=1 file)   tickets w/ overlap   largest component
    all (citations + body)          1072 / 1271          1051  (82.7%)
    citations only, minus meta      700 / 1271            648  (51.0%)
  The `component` FIELD does NOT partition it: 58-70% of conflict edges CROSS
  component boundaries.  Bucketing by component still collides on files.
BUCKETING   CORRECTED (see below): parallelism is governed by PROJECT and
  COMPONENT, NOT by file overlap.  The file-overlap graph above is a CITATION
  artifact (shared evidence/meta files) -- do not use it to bound parallelism.

**Model consequence (CORRECTED).** Parallelism is **not** blocked by file
overlap. The real structure is:

```
  PROJECTS run in PARALLEL            independent streams (e.g. 15 registered
                                      projects) -- must be scheduled in parallel
  COMPONENTS are PARALLEL-COMPATIBLE  within a project; components are
                                      file-separated by design
  PARALLEL UNIT = project x component
  SERIALIZATION only WITHIN a component (and within a ticket's own chain)
```

The cross-component citations observed above are SHARED EVIDENCE / META files
(`CHANGELOG.md`, `AGENTS.md`, `apps/sox/src/main.ts`, `memory-server/index.ts`),
not work overlap -- a citation artifact, not a conflict. So bucket = a component
(or a group within one); buckets (components) run in parallel across the project,
and projects run in parallel across the store. The earlier "one giant overlap
component" must NOT be used to limit parallelism.

**Publishing / dependency model (the real serializer).**

```
FRAMING: the dependency DAG orders the PUBLISH stage, NOT implementation.
- COMPONENTS BELONG TO PROJECTS.
- Within a project, component changes do NOT publish between them: components are
  parallel-compatible (file-separated by design) and their IMPLEMENTATION runs
  concurrently.
- On a change, the PROJECT publishes the AFFECTED ITEMS = the changed component
  plus its transitive DEPENDENTS.
- Components may DEPEND ON EACH OTHER within AND across projects.
=> ordering is enforced only when a component CONSUMES a PUBLISHED (cross-project)
   artifact: the producer must publish before the consumer builds against it.
   Parallelism = components (parallel-compatible) EXCEPT across a dependency edge
   that is being consumed across a publish boundary; a change's PUBLISH SET = the
   changed component + its dependents.
```

So the coupling that sequences is **component dependency (publishing order)** --
enforced across a publish boundary -- **not** file overlap, and it is a
*release-stage* order, never an implementation schedule. The component DEPENDENCY
DAG is the object to measure (publish order, blocking chains, cycles, fan-out).

### E.2 Cross-component dependency / publishing graph (measured, read-only)

Source: `package.json` `workspace:` edges + the Nx project graph for the
`sox-ecosystem` monorepo.

```
SIZE        75 components; 30 publishable @adhd/sox-*
EDGES       67 build/consume edges (any workspace: range; A depends on B)
            27 strict changesets cascade edges (workspace:* exact pin only)
            ZERO cycles -> the publish order is a valid topological sort
WAVES       full build graph  -> 6 serial publish waves (L0=53 ... L5=4)
            strict cascade    -> 2 waves
CRITICAL    listen-guard -> service-proxy -> embedding-provider -> hybrid-search
            -> memory-core -> extension-memory-flush   (6 nodes)
CHOKEPOINTS (a change forces N downstream publishes):
            telemetry 19 · store-adapter 15 · listen-guard 15 · service-proxy 12
            · graph-store 11 · embedding-provider 10
INDEPENDENT ~44 components with no dependency in or out -> always parallel
            (41 extension wrappers) -> effective parallel width ~44
```

**Scheduling rule:** schedule the simulator on the **full build/consume graph**
(conservative): bundled extensions inline their lib members at build time, so a
changed lib forces a rebuild+republish of the bundling extension even through a
`workspace:^` edge that changesets alone would not cascade. Release latency is
governed by the **6-wave critical path**, not the 75-way component count; a
chokepoint change (`telemetry`/`store-adapter`/`listen-guard`) creates a
**convoy** of up to 14-19 downstream publishes behind it.

**Implemented (pipeline-sim).** The graph is the editable data table in
`tools/pipeline-sim/src/pipeline_sim/deps.py` (`MEASURED_COMPONENTS` /
`MEASURED_EDGES` / `STRICT_EDGES` -- one row per component and per
`(consumer, producer)` edge). `measured_graph()` recomputes the **6 publish
waves**, the per-change **publish set** (the changed component + its transitive
dependents), the **release critical path**, the **effective parallel width**
(independent components) and the **chokepoint convoys**; it is surfaced by
`python -m pipeline_sim --publish-graph` and on the app's *Design & dependencies*
tab. `tests/test_publish_graph.py` pins every number above to this graph; the
critical path is disambiguated to the measured `extension-memory-flush` terminal
among the four equal-length (6-node) chains.  The corrected framing
(`deps.PUBLISH_STAGE_FRAMING` — the DAG orders the **PUBLISH stage, not
implementation**) is stated once there and surfaced in `--publish-graph`, the
app's publish panel, and `README.md`.

---

## Appendix F — Real agent-event spend calibration (the event stream)

Source: the operator's own agent telemetry, **READ-ONLY** —
`/Users/nix/dev/ai/scratch/agent-dashboard/public/events.json` (schema v3; the
companion `data/opencode-events.json`, schema v2, is an accepted alternate).

```
POPULATION  56,840 event rows · $328.19 billed · 4,055 dispatches
            172,852 model steps · 244,324 tool calls
WINDOW      ~98 days (2026-06-29 .. 2026-10-04)
SHAPE       one row per (time-bucket, dims) aggregate; tokens_in EXCLUDES
            cache reads, so the four billed classes are disjoint
VALIDATION  cost = in*P_IN + out*P_OUT + reasoning*P_OUT + cache_read*P_CACHE_READ
            at the off-peak card reproduces the stream's cost_usd to 0.7 %
            ($330.64 vs $328.19) -- the price basis and 4-class model are right
COMPOSITION input 36.6 % · output 15.3 % · reasoning 19.1 % · cache-read 29.0 %
```

`tools/pipeline-sim/src/pipeline_sim/events.py` extracts the per-agent and
per-task distributions (cost, `tokens_in/out/reasoning/cache_read`, steps,
`active_ms`, `tool_calls`; p50/p90/mean + counts), the per-event (per-row)
profile, and the per-agent **cold-start** prompt size (`in + cache_read` at the
first event of each session, billed at the real rates).  It commits the
extraction as a compact snapshot (`events_snapshot.json`) and re-derives it
from source for verification (`tests/test_event_calibration.py`).

**Operation → real agent(s)** (the calibrated mapping):

```
impl      -> implement, backend, typescript      review    -> review, reviewer
plan      -> plan-builder, plan                  explore   -> explore
test_*    -> test, test-agent (per AC)           debug     -> debug
research  -> researcher                           dispatch  -> dispatcher
backlog   -> backlog-operator                     spec      -> architect, product
intake/routing/triage -> product                  review_routing -> reviewer
wt_setup/merge_resolve -> git-manager             main_build/release -> devops
gates/post_verify -> qa                            (rework mirrors impl/review)
```

**Overlay.**  `events.event_calibrated(cfg)` is a pure, **additive**
`PipelineConfig` transform: it replaces the Appendix-C placeholder per-op tokens
with the real per-agent profiles, re-derives `c_op`, sets the per-agent cold-start
`c_dispatch`, records `cfg.op_event_profiles` so the engine's LLM composition
split is faithful, and (like `catalogue_per_fire`) propagates into the DAG cost
preview.  The default config is untouched until it is called.  Two units are
offered: `unit="run"` (a real agent run — default) and `unit="event"` (the
per-row marginal operation).  **Unit caveat:** the stream has no per-operation
boundary markers, so a run is coarser than a single small op; the per-event and
per-task measures are reported alongside.

Surfaced by `--events` (the extraction report), `--event-calibrated` /
`--event-unit` (the forecast), and the app's *Event-data calibration* panel.
