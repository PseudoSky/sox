# pipeline-sim — simulation model of an agentic software-delivery pipeline

A deterministic discrete-event simulation of an agentic software-delivery
pipeline, built with [SimPy](https://simpy.readthedocs.io/) 4.1.2.

This is a **simulation for design comparison**, not an operational dispatcher.
Nothing is dispatched to production; the pipeline exists only inside the
simulation, so designs (bucket size, merge structure, test strategy, agent
count) can be compared under identical conditions.

- Spec: [`docs/pipeline-simulation-spec.md`](../../docs/pipeline-simulation-spec.md)
  (revised 2026-10-05: core hypothesis H1, time model, compounding test cost,
  corrected bucket/merge separation).
- Self-contained Python project — **not** part of the pnpm/nx JS workspace.
- Deterministic skeleton: no stochasticity, no search.

## The two independent axes (spec §1.1, OPEN-8)

Backlog item `47bf572f` recorded that the first model conflated these. They are
now orthogonal:

```
BUCKET             a GROUP OF TICKETS — a planning / assignment unit.
                   NOT a git term, NOT a merge unit.   size = n

MERGE STRUCTURE    an independent tree over WORK UNITS (one per ticket).
                   depth = branch_levels, fanout = branch_fanout.
                   Its shape does not depend on n.  `branch_levels=1` is flat
                   (every work unit merges straight to main).
```

Changing `n` changes only the number of buckets (and hence the per-batch
dispatch / holding trade) — **never** the merge tree.

## Layout

```
tools/pipeline-sim/
  pyproject.toml                    packaging + pytest config (src layout)
  src/pipeline_sim/
    config.py                       PipelineConfig ("theta") + validation
    model.py                        tickets -> buckets + merge tree -> DAG
    engine.py                       SimPy engine + constraint verification
    analytics.py                    sqrt(M) batch law + critical-path bound + G_X
    harness.py                      run harness + H1 contrast + CLI
    plots.py                        spec 10 plot pack (matplotlib PNG + plotly HTML)
    __main__.py                     `python -m pipeline_sim`
  tests/
    test_sqrt_scaling.py            REQUIRED test: cost-optimal n* ~ sqrt(M)
    test_constraints.py             supporting constraint / lower-bound tests
    test_h1_and_separation.py       separation, time/cost model, test_level, H1
    test_plots.py                   plot-pack smoke + correctness (skips w/o viz)
  plots/                            generated figures (git-ignorable output)
```

## Setup

```bash
cd tools/pipeline-sim
python3 -m venv .venv
./.venv/bin/pip install -e .
```

## Run

```bash
# headline report for one config
./.venv/bin/python -m pipeline_sim --W-tot 600 --w 10 --n 5 --alpha 2 --m 4

# the H1 contrast harness (spec 7.4 X2): test-every-merge vs defer-to-top
./.venv/bin/python -m pipeline_sim --W-tot 200 --w 10 --n 5 --m 4 --h1-contrast

# sweep the bucket size and report the cost-optimal n*
./.venv/bin/python -m pipeline_sim --W-tot 200 --w 10 --m 4 --sweep-n
```

The report prints **makespan, total cost, #suite runs, #merges, #dispatches**,
the critical-path lower bound, the cost breakdown and any constraint
violations (`constraint checks = OK` means none). `--h1-contrast` exits non-zero
if the V7 mechanism (deferral reduces suite runs) or any constraint fails.

## Model

### Inputs (`PipelineConfig`, spec Appendix A / §3.2)

`W_tot, w, n, alpha, branch_levels, branch_fanout, test_level, test_exec, m,
sigma, p, rho, t_dispatch, t_suite, e, var_e, price_basis, c_dispatch, c_suite,
c_a, c_wt, c_merge, c_main_build, c_wip, c_bucket, c_branch, c_level,
c_gate_rework_per_deferred_ac, horizon, OC, y_triage, y_spec, file_regime,
role_partition, w1..w3`, plus the `TaskDurations` (`t_op`), `ToolCalls` (`O_nu`),
`TaskTokens` (per-op `(in_tok, out_tok)`) and `TaskOpCost` (`c_op`) tables; the
reasoning/cache-read ratios are the module constants `REASONING_PER_OUTPUT` /
`CACHE_READ_PER_OUTPUT`.
`M = round(W_tot / w)`; `num_buckets = ceil(M / n)`.

All default values are calibrated to **Appendix C** of the spec — real Oct-2026
prices and the operator's own `opencode.db` telemetry.  LLM tokens are DeepSeek
V4.1 Flash at the **measured OFF-PEAK** card — `P_IN`/`P_OUT`/`P_CACHE_READ` =
$0.15 / $0.60 / $0.003 per 1M — plus two classes the old model omitted:
**reasoning** (billed at the output rate) and **cache-read**.  The peak card
($0.30/$1.20/$0.006) is exactly 2× and is selectable via `price_basis="peak"`
or `PipelineConfig.repriced("peak")`.  CI is GitHub Actions Linux ($0.008/min).
The `TaskTokens` table is the single source of truth for the LLM costs:
`TaskOpCost()` is derived from it via `llm_cost(in_tok, out_tok)`, and
`tests/test_calibration.py` pins both halves to the Table.

The legacy `branch` knob is retained for backward compatibility and mapped to
`branch_levels` (`hierarchical` → 2, `serial`/`flat` → 1); the canonical knobs
are `branch_levels` / `branch_fanout`.

### Merge structure (knobs `branch_levels`, `branch_fanout` — spec C5)

Leaves are ticket work units; bottom-up, nodes are grouped `branch_fanout` at a
time to form the next stage, for exactly `branch_levels` stages; the top-stage
nodes all merge to `main`. Each non-root node performs one merge into its
parent, so `#merges = #leaves + #internal nodes` (independent of `n`). Only
**top-level** merges acquire `main` (C16); internal merges run off-main in
parallel.

### Test policy (knob `test_level` — spec C10 / C18)

A suite run occurs at every merge node selected by `test_level`:

| `test_level` | suite runs at |
|---|---|
| `all` | every merge |
| `top` | top-level merges only (postpone to main) |
| `level:L` | merges of tier ≥ `L` (1 = leaves) |

The family is monotone: `level:1` ≡ `all`, `level:branch_levels` ≡ `top`.
Deferral is **allowed** (C18): nothing forces a suite below the chosen level,
and at least one test always occurs before release (C10).  `test_level="none"`
is also accepted (not advertised in the UI): no per-merge suite run at all, so a
release gate may be the **only** test run in the extreme (spec §5.2).

### Operator topology (spec §5.2)

The default task graph is the operator's intended flow, not a linear chain:

```
intake -> {triage, spec}             triage and spec run in PARALLEL
{triage, spec} -> routing
routing -> {implement, test_write}   implement and test-write run in PARALLEL
implement -> review                  review depends on IMPLEMENT ONLY
test_write -> test_run               test_run depends on test-write (NOT impl)
{review, test_run} -> merge-to-main  BOTH must finish before the merge
merge-to-main -> [release gate] -> release
```

- **C6 is relaxed**: `test_run` waits only on all of a ticket's test-writes, not
  on the implementation (`engine.verify_constraints` checks this).
- **`plan` placement is a variant** (`plan_position`): `before_routing` (default)
  or `before_implement`.  Placed late, implementation's **rework odds increase**
  by `plan_rework_multiplier` (`effective_rework_p()`, clamped at 1.0), which
  raises expected rework and the `f3` risk.
- **`release gate`** (`release_gate`): `off` | `branch` | `main`.  A full suite
  run placed **before merge-to-main** (on the branch) or **on main**.  A gate
  failure on a branch is fixed there (`c_gate_rework_branch`); on main it needs a
  **new branch** and costs more (`c_gate_rework_main`, default 5x), modelled as
  the `gate_rework` cost line.  With `test_level="none"` the gate can be the only
  suite run.
- **C9 compounding is kept**: `test_run` re-runs every ticket landed before it.

### Time model (spec §3.2, §4-f1, C17)

```
operation time   t_op[tau]                (the TaskDurations table)
dispatch         t_dispatch  per fresh agent start (one per bucket assignment)
suite launch     t_suite     fixed, per suite run
per-AC test      e           per accumulated AC
makespan         = max finish, including all of the above plus resource waits
```

### Cost model (spec §4-f2)

```
total = Σ tool_calls·OC                                   [tool]
      + c_dispatch · #dispatches                          [one per bucket]
      + Σ c_op[tau]                                       [per operation]
      + c_wt     · #worktrees                             [branch provisioning]
      + c_merge  · #merges
      + Σ over suite runs ( c_suite + accumulated_ac·c_a )  [COMPOUNDING]
      + c_wip · n · horizon                               [holding]
```

Each per-operation `c_op` is the **full measured LLM cost** of one model call:
`input + output + reasoning + cache_read`.  Every operation carries
`reasoning = 1.256 · out_tok` at the output rate and
`cache_read = 378.2 · out_tok` at the cache-read rate (the measured per-step
ratios: ~619 reasoning / ~186k cache-read tokens per ~493 output tokens).  The
engine rolls these into an LLM-only composition (`SimulationResult.
llm_cost_classes` / `llm_cost_class_shares`, and the harness report) so a run's
input / output / reasoning / cache-read mix can be read directly: on the default
workload it is ≈ 33 / 16 / 20 / 31 %, against the measured store's
41 / 16 / 20 / 29 %.

The **compounding test term** is the point: each suite run costs `c_suite`
*plus every accumulated AC*.  Deferring tests to fewer, higher merges pays the
fixed `c_suite` fewer times and re-runs fewer accumulated ACs, so H1's cost
saving is real.  At the Appendix C prices the suite is still first-order once a
few levels accumulate — Appendix C's own sanity check: one full-suite run over
200 ACs ≈ $0.55 vs ≈ $0.05 of LLM cost for a whole ticket — so H1 holds at real
prices, not only at the placeholder magnitudes it was first measured with.

**Compounding is per target (C9).**  When a merge node `X` completes, `X`'s
ACs land into `X.parent` and `X`'s suite snapshot is fixed at
`X.parent.landed_ac` — nested subtrees are never double-counted, and the count
is monotone in completion order.

### Calibration (Appendix C measured, USD / seconds)

`TaskTokens` holds the per-operation `(in_tok, out_tok)` magnitudes; `c_op` is
`llm_cost(in_tok, out_tok)` from them at the **measured off-peak** card
`P_IN = $1.5e-7`, `P_OUT = $6.0e-7`, `P_CACHE_READ = $3.0e-9` (plus the derived
reasoning/cache-read classes above).

| op | in,out (tok) | seconds | LLM `c_op` | + CI |
|---|---|---|---|---|
| implement | 30k, 6k | 600 | $0.01943 | |
| test_write (per AC) | 12k, 4k | 180 | $0.01175 | |
| test_run (per AC) | 2k, 1k | `e` = 20 | $0.00279 | `c_a` $0.0027 |
| merge_resolve | 10k, 2k | 120 | $0.00648 | `c_merge` $0.016 |
| wt_setup | 1k, 0.2k | 20 | $0.00065 | `c_wt` $0.003 |
| gates | 5k, 1k | 180 | $0.00324 | |
| release | 2k, 0.5k | 60 | $0.00154 | |
| triage | 5k, 1k | 60 | $0.00324 | |
| spec | 10k, 3k | 120 | $0.00896 | |

Top-level: `t_dispatch` 3 s / `c_dispatch` **$0.00217** (measured first-step:
14,470 input tokens × off-peak `P_IN`); `t_suite` 30 s / `c_suite` $0.008;
`OC` **$0.000143** per tool call (measured ~950 tok/call).  `horizon` stays a
**fixed** planning horizon (default 1.0), never the realised makespan (spec §4
NOTE).  Appendix C also lists `intake`, `routing`, `plan`, `review`,
`review_route`, `main_build` and `post_verify`; those have no corresponding task
kind in the model, so their cost/time is not incurred (see "Spec ambiguities").

**First-order costs of the structural knobs** (spec §4 NOTE / OPEN-7).  The three
structural knobs — bucket size, branch depth and test deferral — need a cost of
their own that *grows* with the knob, or each is monotone and the design-space
optimum collapses to a corner ("max out the knob").  These are calibrated to be
first-order next to `c_agent` and the compounding suite:

| term | default | what it charges |
|---|---|---|
| `c_wip · n · horizon` | 0.30 | holding the `n` open tickets of a bucket (the `∝n` side of the batch law) |
| `c_bucket` | 0.20 | per-bucket planning/assignment (the `∝1/n` side; the `K` of `n* ~ sqrt(M)`) |
| `c_branch` | 0.03 | per work unit a merge node integrates (`Σ_nodes \|tickets\|`) — depth pressure |
| `c_level` | 0.02 | per work unit **per tier** (`Σ_nodes \|tickets\| · tier`) — higher merges are dearer |
| `c_gate_rework_per_deferred_ac` | 0.010 | release-gate remediation per deferred level **per accumulated AC** — deferral is not a free lunch |

The branch term is charged by the number of tickets a node consolidates, so
`Σ_nodes \|tickets\| = M · levels`: it scales with depth **and** workload, which
is what gives the depth optimum an interior solution rather than a boundary (the
old `c_wt`/`c_merge` were rounding errors next to `c_agent`).  The gate term makes
the *test-timing* optimum interior too: at M = 200, partial deferral (`level:2`)
beats both testing at every merge and deferring to the top.

### Measured distributions (spec Appendix C — `opencode.db`)

Point estimates are calibrated to the **medians** of the operator's own measured
store (184,841 steps / 4,662 dispatches / $354.65 over ~3.2 months); the full
quantiles are exposed (harness `format_measured_distributions()`, the UI
"Measured cost distributions" panel, and `pipeline_sim.distributions`) because
run-to-run spread is ~30×.

| measurement | p50 | p90 | max |
|---|---|---|---|
| per-dispatch cost ($) | 0.0307 | 0.1176 | 20.57 |
| per-step cost ($) | 0.001124 | 0.003247 | 0.266 |
| step fresh input (tok) | 500 | 7,252 | |
| step output (tok) | 220 | 1,049 | |
| step cache-read (tok) | 141,056 | 388,864 | |
| session output (tok) | 9,843 | | |
| session input (tok) | 73,904 | 231,325 | |
| session cold-start prompt (tok) | 55,860 | | |
| dispatch first-step input (tok) | 14,470 | | |
| tool-call payload (tok) | 950 | | |

Measured LLM cost composition: input **40.7 %**, reasoning **19.7 %**,
cache-read **28.9 %**, output **15.8 %**.

### Real agent-event spend calibration (agent-dashboard event stream)

The Appendix-C per-operation token table above is a **placeholder** (the spec
flags it LOW-CONFIDENCE / OPEN-3).  `pipeline_sim.events` replaces it with the
**real per-agent and per-task distributions** extracted from the operator's own
agent telemetry:

```
source   /Users/nix/dev/ai/scratch/agent-dashboard/public/events.json  (READ-ONLY, schema v3)
totals   56,840 event rows · $328.19 billed · 4,055 dispatches · 172,852 steps · 244,324 tool calls
window   ~98 days (2026-06-29 .. 2026-10-04)
```

Priced at the measured **off-peak** card, the four-class model reproduces the
stream's own `cost_usd` to **0.7 %** ($330.64 recomputed vs $328.19 billed) — the
cross-check that the price basis and the four billed classes are right.  The
extraction is committed as a compact snapshot (`events_snapshot.json`, built by
`events.build_snapshot`, the *same* code path as a live `events.extract()`), so
the model carries the calibration without depending on the 40 MB scratch file at
runtime.

Each simulator **operation is mapped to its real agent(s)** and priced as the
mean of their measured runs; the per-agent **cold-start** prompt (system prompt
+ tool schemas, `in + cache_read` at the real rates) calibrates the dispatch:

| op | real agent(s) | measured `$/fire` | seconds | agents |
|---|---|---|---|---|
| implement | `implement`, `backend`, `typescript` | $0.104 | 2,762 | |
| review | `review`, `reviewer` | $0.046 | 572 | |
| plan | `plan-builder`, `plan` | $0.246 | 13,586 | |
| explore | `explore` | $0.022 | 403 | |
| test_write / test_run | `test`, `test-agent` | $0.011 | 208 | per AC |
| debug | `debug` | $0.099 | 1,884 | |
| research | `researcher` | $0.062 | 1,251 | |
| dispatch | `dispatcher` | (cold start) | | |
| backlog | `backlog-operator` | $0.034 | 433 | |

(plus the catalogue: `intake`/`routing`/`triage` → `product`, `spec` →
`architect`, `review_routing` → `reviewer`, `wt_setup`/`merge_resolve` →
`git-manager`, `main_build`/`release` → `devops`, `gates`/`post_verify` → `qa`.)

The overlay is **opt-in and additive** — importing the module never changes the
default config:

```python
from pipeline_sim import PipelineConfig, run, event_calibrated
base = PipelineConfig(n=5, branch_levels=1, test_level="all")
run(event_calibrated(base)).total_cost        # real per-agent forecast
run(event_calibrated(base, unit="event"))     # per-event-row marginal unit
```

```bash
./.venv/bin/python -m pipeline_sim --events                 # the extraction report
./.venv/bin/python -m pipeline_sim --event-calibrated        # run the real forecast
./.venv/bin/python -m pipeline_sim --event-calibrated --event-unit event
```

The app surfaces it on the **Design & dependencies** tab (*Event-data
calibration* panel) and as an **Advanced** toggle.  **Unit caveat:** the stream
has no per-operation boundary markers, so the calibrated unit is a real agent
*run* (one `(session_id, agent)`), which is coarser than a single small op; the
`unit="event"` mode prices the per-event-row marginal operation instead, and the
per-task / per-event distributions are reported alongside.  `event_calibrated`
also sets `cfg.op_event_profiles`, so the engine's LLM composition split matches
the stream class-by-class.

### Resources

- **Agents** — a `simpy.Store` of `m` tokens; acquiring a token is acquiring an
  agent (**C11**).
- **main** — a `simpy.Resource(1)`; one merge to `main` at a time (**C16**).

### `test_exec` (spec assumption A3)

- **`full_suite`** — a suite run exercises every accumulated AC (compounding).
- **`affected_only`** — a suite run exercises only the AC its merge introduces
  (no compounding).

### Constraints implemented

| Constraint | Where |
|---|---|
| C1 bucket size | `model.partition_tickets` |
| C5 branch tree | `model.build_branch_tree` (one parent per node) |
| C6 AC test order (relaxed §5.2) | `test_write` → `test_run` edges only |
| C7 merge after all | children merges (or the leaf's work) → merge |
| C8 release barrier | every merge + suite → `pre_release` → `release` |
| C9 suite compounds | per-target landing accumulator in `engine` |
| C10 test policy | suite tasks at `graph.suite_nodes`; ≥1 before release |
| C11 agent capacity | `simpy.Store` of `m` agents |
| C12 precedence | the DAG edges; verified post-run |
| C16 main unit-capacity | `simpy.Resource(1)` on top merges only |
| C17 dispatch latency | one `dispatch` task per bucket, before its work |
| C18 deferral allowed | no suite below the chosen level is forced |

`engine.verify_constraints` re-checks C1/C5/C6/C8/C9/C10/C11/C12/C16/C17/C18 on
the finished schedule; the harness reports `OK` or the violations.

### Analytic pieces

- `analytics.sqrt_bucket_size(M, K, h, horizon)` = `sqrt(2·K·M / (h·T))`, the
  EOQ/ELSP square-root batch law (spec L1).  `analytic_bucket_size(cfg, T)`
  instantiates it with `K = c_dispatch` (the per-bucket term) and `h = c_wip`.
- `analytics.critical_path_bound(tasks)` — longest path through the precedence
  DAG, using a lower bound on the dynamic suite duration.  Exact lower bound on
  the makespan of any resource-feasible schedule (it relaxes C11/C16).
- `analytics.branch_coordination_cost(cfg, merge_nodes)` — the first-order
  per-branch cost (`c_branch · Σ|tickets| + c_level · Σ|tickets|·tier`) the
  engine charges.

### Cross-component publish graph (spec Appendix E.2)

The real serializer of a release is the **component dependency DAG**, not file
overlap.  Appendix E.1 corrects the original model: the file-overlap graph
(tickets sharing a citation/body path) is a **citation artifact** — shared
evidence/meta files — and must never bound parallelism.

**Framing — the DAG orders the PUBLISH stage, NOT implementation.**  Within a
project, component changes do **not** publish between them: components are
parallel-compatible (file-separated by design) and their *implementation* runs
concurrently.  Ordering is enforced only when a component **consumes a PUBLISHED
(cross-project) artifact** — the producer must publish before the consumer builds
against it.  A dependency edge `A -> B` therefore sequences a *release stage*, not
an implementation schedule; `deps.PUBLISH_STAGE_FRAMING` states this once and
`--publish-graph` prints it.

`pipeline_sim.deps` carries the measured graph as an **editable data table**
(`MEASURED_COMPONENTS` / `MEASURED_EDGES`; `STRICT_EDGES` the 27 `workspace:*`
changesets-cascade edges) and the publish-scheduling arithmetic:

- **75 components · 67 build/consume edges · 27 strict cascade edges · zero
  cycles.**
- **6 publish waves** (`L0=53 … L5=4`); strict cascade = 2 waves.
- **Release critical path** (6 nodes): `listen-guard → service-proxy →
  embedding-provider → hybrid-search → memory-core → extension-memory-flush`.
- **Effective parallel width = 44** independent components (no dependency in or
  out) — not the 75-way component count.
- **Publish set** = the changed component + its transitive **dependents**.
- **Chokepoint convoys**: a change to `telemetry` (19) / `store-adapter` (15) /
  `listen-guard` (15) drags 14-19 downstream publishes into a serial convoy.

```python
from pipeline_sim.deps import measured_graph
g = measured_graph()
g.publish_waves()             # 6 waves
g.critical_path()             # the release critical path
g.publish_set("telemetry")    # 19 components (change + 18 dependents)
g.convoy("telemetry")         # the serialized release stages
g.chokepoints()               # (component, publish-set size) ranked
```

```bash
./.venv/bin/python -m pipeline_sim --publish-graph   # waves + critical path + convoys
```

It is surfaced in the app on the **Design & dependencies** tab (waves, critical
path, top chokepoints, convoy stages). `tests/test_publish_graph.py` pins every
number above to the graph.  `max_parallel_buckets` remains an *assignment-level*
concurrency cap — **not** a file-overlap bound.

### Interior optima (part 1) — the optima are no longer on the bound

With the first-order structural costs above, the cost-optimal **bucket size** and
**branch depth** are interior (a real trade-off), and **test timing** has an
interior optimum at scale.  The measured sweep (M = 60 and M = 200; `m` fixed,
`ns ∈ {1,2,4,5,8,10,14,20,40,100}`):

| workload | bucket optimum n* | depth optimum L* | test-timing optimum |
|---|---|---|---|
| M = 60 | 5 (interior of 1..100) | 2 (interior of 1..4) | all |
| M = 200 | 10 (interior of 1..100) | 3 (interior of 1..4) | `level:2` (partial deferral) |

Before the fix the same sweep put the bucket optimum at the max bound (no ∝n
holding when `c_wip` was a rounding error) and the depth optimum at the max bound
(depth was monotone: it only removed suite runs).  The regression guard is
`tests/test_interior_optima.py`; the app's *curated* default set (below) is
chosen so its own landing-page optimum is interior in both axes.

### Synthesis v2 (spec §10.2 item 3) — every knob + deltas vs the primary

`pipeline_sim.synthesis` (and the **Results** tab) turns a discovered optimum
into:

- **`describe_config(cfg, res)`** — a labelled **Field / Value / What-it-means**
  table of **every** knob (work per ticket, bucket size, AC target, branch
  depth/fan-out, test timing/scope, agents, parallelizable buckets, plan
  placement, release gate, objective weights, derived counts, run metrics), not
  just the branching config.
- **`deltas_vs_primary(primary, res, weights)`** — the **% faster**, **%
  cheaper**, **% safer** and **% overall** (weight-averaged) change against the
  PRIMARY baseline; cost/time/risk are all lower-is-better, so a positive
  percentage always means better.
- **`synthesis_table(primary_cfg, records, weights)`** — one row per optimal
  configuration with its deltas, the PRIMARY marked `baseline`.

```python
from pipeline_sim import PipelineConfig, run, describe_config, deltas_vs_primary
primary = run(PipelineConfig(n=2, branch_levels=1, test_level="all", m=4))
opt     = run(PipelineConfig(n=5, branch_levels=2, test_level="level:2", m=2))
describe_config(opt.config, opt)          # every knob, plain-language
deltas_vs_primary(primary, opt)           # % faster / cheaper / safer / overall
```

## Plot pack (spec §10)

The visualization layer renders the spec's plot pack from the simulator. It is
**additive** — it only reads the model — and lives in two optional
dependencies:

```bash
./.venv/bin/pip install -e '.[viz]'      # matplotlib + plotly
```

```bash
# full pack -> tools/pipeline-sim/plots/
./.venv/bin/python -m pipeline_sim.plots
# tiny/fast pack (smoke), a subset, or a custom output dir
./.venv/bin/python -m pipeline_sim.plots --quick
./.venv/bin/python -m pipeline_sim.plots --only sqrt h1 pareto
./.venv/bin/python -m pipeline_sim.plots --out /tmp/plots
# installed as a console script too:
pipeline-sim-plots
```

Every figure is written as a static **PNG** (matplotlib) and, where sensible, an
interactive **HTML** (plotly, with hover + zoom). All HTML shares a single
`plots/plotly.min.js`, so the pack works **offline**. Figure 10 is a tabbed,
self-contained interactive dashboard linking the rest.

| # | file stem | what it shows | spec |
|---|---|---|---|
| 1 | `01_sqrt_scaling` | `n*` vs `M` on log-log with the fitted exponent + the analytic EOQ curve | L1 |
| 2 | `02_h1_contrast` | paired slope/dumbbell, baseline vs deferred, cost **and** makespan across `M` | H1 / X2 / L8 |
| 3 | `03_pareto_front` | cost-vs-makespan (**non-degenerate**), makespan-vs-utilisation, and cost-vs-risk (`f3`) | RQ9 |
| 4 | `04_interaction_heatmap` | cost/makespan over `(branch_levels × test_level)` — a phase diagram | H1 / X2 |
| 5 | `05_tornado_sensitivity` | one-at-a-time knob effects on total cost | 7.1 |
| 6 | `06_compounding_suite` | per-run (linear) and cumulative (superlinear) suite cost/time | C9 |
| 7 | `07_small_multiples` | cost and makespan vs `n`, faceted by branch level | — |
| 8 | `08_gantt_utilisation` | schedule timeline per agent + utilisation, from one run | — |
| 9 | `09_parallel_coordinates` | supported knobs → (cost, makespan) | — |
| 10 | `10_dashboard` | tabbed interactive HTML linking the above | §9 |

**Only implemented search axes are plotted** (`n`, `alpha`, `branch_levels`,
`branch_fanout`, `test_level`, `test_exec`, `m`). Knobs the model does not
implement — `sigma` merge-order policies, the `role_partition` / Pi_R partition,
`G_X` regime enforcement (C13/C14), and stochastic `var_e` — are deliberately
omitted rather than fabricated. Rework `p`/`rho` and `c_agent` are implemented
and affect every run's cost/risk, but are held at their calibrated defaults
rather than swept as search axes here.

**Why Figure 3 has three panels (and why the front no longer collapses).**
Two additions close the previously-degenerate cost↔makespan front:

* the **parallelism cost** `c_agent` (spec 4-f2, `[fix]`): cost per agent per
  second of *occupied* time (the pool of `m` agents is provisioned for the
  horizon), so buying makespan with more agents costs more;
* the **risk objective** `f3` (spec 4, `[fix]`): `rho · blast_radius(depth,
  deferral) · conflict_rate + p · expected_rework_burden`, so deferring testing
  (cheaper and faster) raises risk.

On a 144-point sweep the cost↔makespan frontier has **5 non-dominated points**
(was 1). Panel (a) is cost↔makespan, panel (b) is makespan↔utilisation
(`f1` vs `f5`), and panel (c) is cost↔risk (`f2` vs `f3`), which trades because
deferral lowers cost but widens the blast radius and adds expected rework.

## Design-space explorer (Streamlit, spec §10.1)

`app.py` is the interactive **design-space explorer**: edit the task graph, bound
the search space, run an exhaustive sweep, then select from the frontier. It is
**additive** — it only reads the package.

```bash
./.venv/bin/pip install -e '.[ui]'        # streamlit + matplotlib + plotly
cd tools/pipeline-sim
./.venv/bin/streamlit run app.py          # serves on http://localhost:8501
```

Two operator-required features are built into the Design and Results tabs
(spec §10.2):

- **Cost preview on the DAG** — every node is annotated with its anticipated
  cost (`occurrences × $/fire`) and the DAG shows the total (Design tab, and the
  discovered optimum in Results).
- **Variant comparison (page 1)** — the top-performing variants are rendered
  **side by side on the first tab** as their ACTUAL **instance-level flows**
  (see below): each variant has a different bucket count / merge depth / fan-out,
  so the graphs are visibly different, and its metrics (cost, end-to-end time,
  risk, suite runs) are shown **below** its graph.

On first load the landing page renders a small **curated default set** of
configurations — a fixed handful (10) chosen to exercise the *interior* design
region — evaluated once and cached.  The **full sweep does NOT run
automatically**: it evaluates the sidebar's Cartesian product only when you
press **Run the sweep**, so a fresh session stays fast (the 540-combination
default grid used to run on every load, ~7 s) and cannot wedge on a large grid.
The Results tab is empty until that first run.

**Default design values, and why.**  The defaults are chosen to exercise the
*interior* of the design region and show a real trade, not a corner:

| default | value | why |
|---|---|---|
| ticket count | `W_tot=600`, `w=10` → **M = 60** tickets | a **sprint-sized batch** (40-60); the operator's full open backlog is **880**. `M` maps directly to a ticket count. |
| AC model | **real 0-heavy distribution** (C4 revised) | the modal real ticket has **0** ACs: ~93 % carry none, a ~7 % tail carries ~3-5 (median 4), E ≈ 0.30. A 0-AC ticket writes and runs **no tests**. Uniform `alpha` is still available as a comparison. |
| bucket size | **5** (set `3,5,8`) | mid-range, and straddles `√M = 7.7`, so the `~√M` optimum is interior |
| branch depth | **2** (domain `1,2`) | hierarchical vs flat is a real trade |
| test timing | **`level:2`** (partial deferral, tier ≥ 2) | the interior H1 point; the domain offers `all`/`level:2`/`top` |
| agents | **4** (domain `2,4,8`) | the parallelism trade; 2 and 8 bracket it |
| parallelizable buckets | **2** | exercises the bucket concurrency cap rather than leaving it unlimited |
| objective weights | **1, 1, 1** | equal weighting, so no objective is silently privileged |

**Acceptance criteria are a distribution, not a floor (C4 revised).**  The spec
originally required `a_bk >= 1` for every ticket.  The operator's real backlog
(spec Appendix E) shows the modal ticket carries **zero** ACs — only ~7 % carry
any, so `E[AC] ≈ 0.30`.  The simulator models `alpha` as a **0-heavy
distribution** (`REAL_AC_DISTRIBUTION`): a seeded, stratified draw where ~93 % of
tickets get 0 and the rest draw a tail of 3-5 (median 4).  A ticket with 0 ACs
instantiates **no** `test_write` / `test_run` task, so the compounding suite is
not overstated for ~93 % of real tickets.  The scalar `alpha` still drives the
**uniform** mode for a backward-compatible comparison (`pipeline-sim
--ac-mode uniform`, or the sidebar toggle).  The reported work-mix (~45 % bug /
20 % BL / 15 % debt / 7 % issue / 13 % feature) is real-backlog *context* — the
simulator deliberately treats tickets homogeneously.

The app has five tabs:

0. **Discovered configurations** — the Pareto frontier and top performers the
   sweep found, plus the **variant comparison** (top variants as instance-level
   flows, side by side).
1. **Design & dependencies** — the task flow (Graphviz, with the **cost
   preview**) and the row-per-task dependency editor: toggle a task on/off,
   choose what it depends on, remove it, or open its **Edit** popup (per-fire
   cost, duration, dependencies). The flow is validated live (**C19** acyclic /
   **C20** required edges), and the Appendix-D expected-cost table shows each
   task's `$/fire`, occurrence count and subtotal with a running total. Custom
   task types (spec §3.6) are added here (one per line:
   `id, label, scope, t_op, in_tok, out_tok, preds|, succs|, optional`).
2. **Results** — the discovered optimum's **instance-level flow** and the
   per-level panel, a labelled **field table** of its exact real-world
   configuration ("what this variant suggests"), and question-tied charts
   (cost↔time, H1 depth×test, bucket size vs √M, AC target, agents, trade-offs).
3. **Answers** — the spec §2 questions, each with the numbers and a one-line
   conclusion.
4. **Scenario** — force one config (e.g. current practice) and overlay it on the
   frontier.

The whole control surface — the design-space level sets for `n`, `alpha`,
`branch_levels`, `branch_fanout`, `test_level`, `test_exec`, `m`, the
**Parallelizable buckets** cap, the objective weights, the Advanced numeric
parameters, and the Scenario values — lives in the **sidebar**; the main body
carries no knob controls. **Run the sweep** evaluates the Cartesian product and
stores the results dataset in `st.session_state`.

The UI is verified headless by `tests/test_app.py`, which drives this exact
script through `streamlit.testing.v1.AppTest`: it asserts the load does **not**
run the full sweep (`results` stays empty; only the curated default set is
evaluated), and that **every tab and every chart** — the landing frontier, the
six Results charts, and the Scenario frontier + Gantt — renders without raising.

### Instance-level flow (the REAL graph) + `max_parallel_buckets`

The catalogue graph (`DEFAULT_EDGES`) is the same 16 boxes for every config —
which is why two variants of it look identical. `pipeline_sim.instance` renders
the graph a `PipelineConfig` **actually instantiates**:

* **`build_instance_graph(cfg, res=None, detail="tasks")`** — one node per task
  instance (`detail="tasks"`), labelled by its task and, when a
  `SimulationResult` is supplied, the **agent** that ran it; edges are the
  model's precedence `preds`; nodes are clustered by **bucket**. The **merge
  tree is laid out by level** — `L1` leaf worktrees (one per ticket) → `L2` →
  … → `main`. `detail="structural"` gives a compact schematic (bucket / ticket /
  merge-node / global stages) for legible side-by-side comparison.
* **`instance_level_rows(ig)`** — the per-level "what work happens here?"
  aggregate: level, `#branches`, `#tickets`, `#merges`, `#suite-runs`, `#tasks`.
* **`instance_to_dot(ig, colour_by="kind"|"level")`** — Graphviz DOT.
* **`instance_signature(ig)`** — a structure fingerprint that is equal iff two
  configs instantiate the same flow (independent of render detail).

Consequently two different configs produce **visibly different** graphs — e.g.
`n=2` gives 10 buckets where `n=5` gives 4, and `branch_levels=1` gives a flat
20-leaf merge where `branch_levels=3` gives L1=20 → L2=10 → L3=5 → main
(`tests/test_instance_flow.py` pins both the shape difference and the DOT
difference).

`PipelineConfig.max_parallel_buckets` (default `None` = unlimited) is a real
**bucket concurrency cap**: with it set, a bucket holds one slot from its first
task start to its last task finish, so at most that many buckets are in flight
at once (the observed peak is reported on `SimulationResult.peak_parallel_buckets`).
It is independent of `m` (which caps individual *tasks*); a cap `>=` the bucket
count is a strict no-op, so the default simulation is unchanged.

### Editable task graph (`T_active` + `P`)

`PipelineConfig` gains two additive fields (both default `None`):

```python
from pipeline_sim import PipelineConfig, DEFAULT_TASK_GRAPH, expected_cost_per_item

cfg = PipelineConfig(
    T_active=("implement", "test_write", "test_run", "wt_setup",
              "merge_resolve", "gates", "release"),
    P=(("implement", "test_run"), ("test_write", "test_run"),
       ("wt_setup", "merge_resolve"), ("merge_resolve", "release")),
)
report = expected_cost_per_item(cfg)     # per active task type: $/fire x occurrences
print(report.total)
```

* **Default = all 16 catalogue types.** With no override, `resolve_task_graph()`
  returns `DEFAULT_TASK_GRAPH` (all 16 spec-3.3 types, canonical edges) and
  **every active type is instantiated by the engine** — including the seven that
  were previously cost-accounted but not simulated (intake, routing, plan,
  review, review-routing, main-build, post-verify). The two optional gates still
  follow `y_triage`/`y_spec`; an explicit `T_active` is authoritative for them.
* **Custom task types (spec §3.6).** `PipelineConfig.custom_task_types` accepts
  `TaskType` instances with their own `id`, `scope` (`ticket|ac|bucket|
  merge_node|worktree|global`), `t_op`, token cost, `tool_calls`, and default
  predecessor/successor edges. They flow into the graph, C19/C20 validation,
  occurrence counts, the Appendix-D expected-cost roll-up, the DAG preview, and
  the editor.
* **Validation.** `validate_task_graph(spec, cfg=...)` returns errors (**C19**
  cycle, unknown type, self-loop) and warnings (**C20** missing domain-required
  edge, dangling edge). `PipelineConfig.validate()` raises on C19; C20 is
  advisory.
* **`expected_cost_per_item(cfg)`** returns a row per catalogue/custom type
  (Appendix-D `$/fire` from the raw Appendix-C tokens + CI, and the occurrence
  count derived from the realised structure) plus the non-task scenario lines
  (dispatch, suite, tool, rework, holding, agent) and the scenario total.

## Tests

```bash
./.venv/bin/pytest -v
```

The suite includes a headless Streamlit smoke test (`tests/test_app.py`) that
drives `app.py` through `streamlit.testing.v1.AppTest`, and
`tests/test_topology.py`, which **names** the operator topology (§5.2) and pins
the two variants (plan placement / raised rework odds; the branch-vs-main
release gate) plus the relaxed C6.

**Note on L1 (`n* ~ sqrt(M)`).**  The parallelism cost `c_agent` charges occupied
agent-seconds (≈ `m·makespan`), so under the calibrated defaults the argmin is
driven by schedule noise and the batch law is masked.  `test_sqrt_scaling.py` and
the BL `f9c92068` tests isolate the per-batch-setup vs holding trade
(`c_agent = 0`) so the square-root law is measured cleanly — see the module
docstring.

## Spec ambiguities hit (and the decisions taken)

1. **Holding horizon (`c_wip · n · horizon`).**  The spec does not say whether
   `horizon` is the realised makespan or a fixed planning horizon.  The first
   model used the makespan.  Under a compounding suite the makespan grows with
   `M`, so the holding term becomes `∝ n·T(M)` and the L1 square-root law
   collapses to a constant `n*`.  Decision: `horizon` is an explicit **fixed
   planning horizon** input (default 1.0), matching the `T` of the EOQ formula
   the spec cites.  *Flagged: if the spec intends a time-coupled holding term,
   L1 must be restated.*

2. **"Fresh agent start" and the `∝1/n` term.**  C17 charges `t_dispatch` /
   `c_dispatch` per fresh agent start.  The model charges one dispatch per
   **bucket** (a bucket is an assignment unit, so assigning it is a fresh agent
   start).  This is what gives the `∝1/n` per-batch setup term the L1 law needs
   (spec §4 NOTE).  *Flagged: an alternative reading is one dispatch per pool
   agent, which carries no `n` dependence.*

3. **`level:L` semantics.**  Read as "suite runs at merges of tier ≥ L", giving
   the monotone family `level:1 ≡ all`, `level:branch_levels ≡ top`.  An
   alternative "exactly tier L" reading is not the one implemented.

4. **Per-operation cost `c_op[tau]`.**  §3.2 lists `c_op[tau]` but the task
   types are only named in §3.3.  Decision: a `TaskOpCost` table keyed by the
   task kinds; `dispatch` and `suite` are excluded (they carry their own
   dedicated `c_dispatch` / `c_suite`+`c_a` terms).  Appendix C splits each
   operation into an LLM part (→ `c_op`) and a CI part (→ `c_merge` / `c_wt` /
   `c_a`), which are kept as separate line items so the merge/setup CI cost is
   never double-counted inside `c_op`.

5. **Appendix C ops with no task kind — now resolved.**  Appendix C also prices
   `intake`, `routing`, `plan`, `review`, `review_route`, `main_build` and
   `post_verify`.  All seven are now first-class catalogue types **instantiated
   by the engine** when active, so their calibrated `t_op` and cost are incurred
   (BL 51ec18ef / f3a9eeb5).

6. **`sigma` (merge order) is still unimplemented** — any value other than
   `"natural"` raises `NotImplementedError` rather than being silently ignored.
   `role_partition` (Pi_R / C15) likewise raises; `G_X` regimes are generated
   for information (`file_conflict_pairs`) and now supply `f3`'s
   `conflict_rate`, but C13/C14 are not enforced.

7. **`p`/`rho` (rework + risk) are now implemented.**  Rework (spec 5.1 A1) fires
   per bucket with probability `p` (seeded RNG → common random numbers across
   comparison arms), adding an extra implement pass + reconfirm; `rho` scales the
   `f3` blast-radius term.  `var_e` (stochastic durations) remains stored but
   unused; `w1..w3` remain ranking weights only.

## Done criteria

| Criterion | Status |
|---|---|
| SimPy-based self-contained package | yes — `src/pipeline_sim`, SimPy 4.1.2 |
| Bucket and merge structure separated | yes — `branch_levels`/`branch_fanout`, independent of `n` |
| Time model (`t_dispatch`/`t_op`/`t_suite`/`e`) | yes — in makespan |
| Cost model with compounding test term + holding | yes — `c_suite + Σc_a`, `c_wip·n·horizon` |
| `test_level` policy with deferral allowed | yes — `all` / `top` / `level:L`, C10/C18 verified |
| Calibrated to Appendix C (real prices) | yes — `tests/test_calibration.py` pins tokens→cost→durations |
| sqrt(M) batch law still holds | yes — `test_sqrt_scaling.py` (exponent ≈ 0.49) |
| H1 contrast harness (X2 / V7 / L8) | yes — holds under calibration; `python -m pipeline_sim --h1-contrast` |
| Rework (A1) + risk objective `f3` | yes — seeded per-bucket rework; `f3 = rho·blast·conflict + p·rework` exposed on the result |
| Parallelism cost `c_agent` | yes — USD per occupied agent-second; closes the cost↔makespan front |
| All 16 catalogue kinds simulated | yes — every active type is instantiated (BL 51ec18ef / f3a9eeb5) |
| Custom task types (spec §3.6) | yes — flow into graph, C19/C20, cost roll-up and the editor |
| Non-degenerate cost↔makespan front | yes — 5 frontier points (was 1) on the 144-point sweep |
| Interior optima (part 1) | yes — bucket n* and depth L* interior at M=60 and M=200; test timing interior at M=200 (`tests/test_interior_optima.py`) |
| Synthesis v2 (spec §10.2 item 3) | yes — `describe_config` (every knob) + `deltas_vs_primary` (% faster/cheaper/safer/overall) + `synthesis_table`; wired into the Results tab |
