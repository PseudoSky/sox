# SCOPE — Plan dispatch optimizer: token-cost model + batch assignment algorithm

**Status:** schema defined · implementation starting · **Date:** 2026-06-27
**Intent:** this SCOPE is the strategic brief a plan-builder turns into an execution-ready
plan-state-machine plan. It is deliberately decision-bearing, not yet sequenced.

**Schema status:** PROPOSED_DAG_STRUCTURE.md is finalized. DECISIONS.md records all
design decisions made. The old `compile-wave.js` / `state.json` / `references.json`
references below have been superseded — see §Terminology Mapping for the equivalents.

---

## Terminology Mapping (old → new)

The schema design sessions replaced the prior plan-state-machine vocabulary. The cost model
math is unchanged; only the data source paths differ.

| Old term | New term | Source in dag.json |
|---|---|---|
| task / node | milestone | `milestones.<slug>` |
| batch | dispatch unit | `snapshot.dispatch_units[]` |
| `dag.json nodes[i].artifacts` (globs) | op.file targets (prospective) | `operations[].file` where type == "generative" |
| `references.json sources[]` | `milestone.read_only[]` | `milestones.<slug>.read_only` |
| `state.json metrics.tokens_actual` | dispatch_log turn tokens | `dispatch_log[].turns[].input_tokens + output_tokens` |
| `state.json metrics.tokens_est` | `milestone.tokens_estimated` | derived in snapshot |
| `compile-wave.js` | `src/compiler.ts` → `optimize()` | see §Next: Implementation |
| work-order | compiled task object (prompt + files + on_complete) | assembled at dispatch time from dispatch unit |
| reduction_ratio | merge savings formula (§A4) | `B + |Sᵢ ∩ Sⱼ| − caching_adjustment` |

---

## Background

`compile-wave.js` (prior system) decided whether to pack two tasks into a single work-order
dispatch using a `reduction_ratio` that measured only shared prose overlap (invariants, refs,
snapshots). This left two categories of savings unquantified:

1. **Base dispatch overhead B** — every dispatch carries a fixed token cost (~27k tokens for a
   full MCP-exposed executor: system prompt + tool schemas + scaffolding) that is paid regardless
   of prose overlap. Merging two tasks with zero shared prose still saves one full B.
2. **Source file bytes Sᵢ** — each executor reads source files. Merging tasks with overlapping
   file sets avoids re-reading shared files. Neither `dag.json artifacts` nor `references.json
   sources[]` are currently used in the merge/pack decision.

Formal node: `01KW3F0GA02V058ZHDTDPJ4EEB` — the lesson recording the gap and the three
unlocked plan fields not currently fed back into optimization.

Research basis: memory topic `multi-agent-dispatch-optimization` (9 research agents, 576K
tokens, June 27 2026 — UIDs in §Research Memory Index).

---

## Goal

Replace the prose-only `reduction_ratio` gate with a **formally-grounded, constraint-satisfying
batch assignment optimizer** that minimizes total token cost across all three cost components
(B, Sᵢ, Kᵢ), respects DAG precedence, enforces a context-window feasibility constraint W,
and exploits prompt-caching architecture.

**Not a research project.** Every algorithm, formula, and threshold below is sourced and
backed by primary literature. The implementation work is engineering, not discovery.

---

## Part A — Formal Cost Model

### A1. Parameters and Variables

| Symbol | Meaning | Source in new schema |
|---|---|---|
| B | Fixed base overhead per dispatch (tokens) | `dag.optimization.b_per_tier[model]` — instrumented once per executor type |
| Sᵢ | Set of source files milestone i must read | `milestone.read_only[]` + `op.file` targets for ops in milestone i |
| Kᵢ | Milestone-specific output tokens | `sum(op.ki_estimate)` across ops in milestone i (see §C3 for derivation per shape.kind) |
| W | Context window limit for merged dispatch | `dag.optimization.context_window_per_tier[model]` — effective limit for merged prompts |
| w | Cache write cost multiplier | Anthropic: 1.25 · OpenAI: 1.0 · Gemini: 1.0 |
| r | Cache read price ratio | Anthropic: 0.10 · OpenAI: 0.50 · Gemini: 0.10 |
| p | Cache hit probability | Naive fan-out: p ≈ 0. **Sentinel-Fanout**: p = (N−1)/N ≈ 90%+ for N≥10 |

**B_eff** (effective base cost under caching):
```
B_eff = B × ((1 − p) × w + p × r)
```
Stored in `snapshot.optimization.b_eff_per_tier[model]`. Null until `b_per_tier` is calibrated.

### A2. Objective Function (Single — Three Objectives Collapse to One)

```
minimize  Σ_b [ B·z[b]  +  Σ_f y[f,b]  +  Σ_i Kᵢ·x[i,b] ]
               base cost   file read cost   per-milestone tokens
```

**Key result:** minimizing total file reads = minimizing redundant reads (same algebraic term).
Minimizing context size per batch is a hard feasibility constraint, not an objective. The three
original objectives reduce to **one objective + one constraint** — no multi-objective solver needed.

### A3. Constraint Set (Full ILP)

Decision variables: `x[i,b] ∈ {0,1}` (milestone→batch), `y[f,b] ∈ {0,1}` (file coverage auxiliary), `z[b] ∈ {0,1}` (batch activation).

```
C1  Σ_b x[i,b] = 1                            ∀i          each milestone in exactly one batch
C2  Σ_f y[f,b] + Σ_i Kᵢ·x[i,b] ≤ W          ∀b          context window (hard feasibility)
C3  y[f,b] ≥ x[i,b]                           ∀i,b,f∈Sᵢ  union lower bound
C4  y[f,b] ≤ Σ_{i: f∈Sᵢ} x[i,b]             ∀f,b        union upper bound (LP tightening)
C5  Σ_b b·x[j,b] − Σ_b b·x[i,b] ≥ 1         ∀(i→j)∈E   DAG precedence via batch-index ordering
C6  x[i,b] ≤ z[b]                             ∀i,b        batch activation
C7  z[b] ≥ z[b+1]                             ∀b          symmetry breaking
```

**Input:** eligible milestones only — those where `snapshot.milestones[slug].eligible == true`
(which requires `pending == null` AND all deps complete — see DECISIONS.md §D-07).

At N=20 milestones, M=100 files, B_max=20 batch slots: **2,420 binary variables**. Gurobi/CPLEX
solve in < 30s; OR-Tools CP-SAT in 1–5s.

### A4. Merge-vs-Split Crossover (Closed Form)

Let X = |Sᵢ ∩ Sⱼ| (file tokens saved by merging milestones i and j).

Without caching — split when: `X > B`

With Anthropic Sentinel-Fanout caching (r=0.1, w=1.25, p=0.9):
```
Split when:  X > B × [0.25 + (N−1) × 0.215]
```

| N batches | Uncached split threshold | Cached threshold | Ratio |
|---|---|---|---|
| 2 | X > B | X > 0.465·B | 2.15× easier to split |
| 4 | X > 3B | X > 0.895·B | 3.35× easier to split |
| 8 | X > 7B | X > 1.755·B | 4.0× easier to split |

**Implication:** the "always merge small tasks" heuristic from the uncached model reverses
under properly-implemented Sentinel-Fanout caching.

*Research nodes: `01KW50B16RKRR3NE4XMDFNVR8J`, `01KW50BWG71JE21QNFNT5ESRRZ`*

---

## Part B — Algorithm Selection

### B1. Complexity Class

Strongly NP-hard, APX-hard (no PTAS). Subsumes bin packing; set-union cost |∪Sᵢ| is
monotone submodular → constrained submodular minimization. Not reducible to a single canonical
problem — combines bin packing (capacity W) + group technology scheduling (shared setup |∪Sᵢ|)
+ DAG precedence.

**Critical exception:** plan DAGs are typically forests or series-parallel (phase → milestone
linear chains with research → implementation → integration topology). For these structures,
a **polynomial-time exact algorithm exists**:

```
Tree DP: O(N²·W) — exact optimal, no NP-hard solver required
```

This is the expected common case. The NP-hard solver is a fallback for pathological DAG shapes.

*Source: arxiv 1905.13740 — "polynomial-time algorithms on series-parallel and convex bipartite partial orders"*

### B2. Algorithm Selection Table

| N milestones | DAG structure | Algorithm | Complexity | Optimality |
|---|---|---|---|---|
| ≤ 20 | Any | Bitmask DP | O(3^N) | Exact |
| ≤ 50 | **Forest / series-parallel** | **Tree DP (bottom-up)** | **O(N²·W)** | **Exact — polynomial** |
| ≤ 50 | General DAG | OR-Tools CP-SAT, 2s limit | 1–5s | Exact or proven near-optimal |
| 50–200 | Any | HLFET warm-start → CP-SAT, 5s | O(N log N) + CP-SAT | ~5% gap |
| > 200 | Any | HLFET (critical-path priority list) | O(N log N) | 2−1/P ratio |
| Any, <100ms budget | Any | HLFET | O(N log N) | 2−1/P ratio |

**DAG structure detection** runs on `milestone.depends_on` edges for eligible milestones only.
Forest detection: check each node has ≤1 parent. Series-parallel: Valdes-Tarjan-Lawler algorithm.

**HLFET** (Highest Level First with Estimated Times): dispatch milestones in decreasing order of
critical-path distance to the terminal milestone. Achieves the optimal 2−1/P approximation ratio
for list scheduling. O(N log N). Critical-path distance uses `milestone.ki_estimate` as weight.

**Constraint: do not pack milestones of different shape.kind families into one dispatch unit.**
`doc` and `structured-output` dispatch to different prompt modes and cannot share a context
window cleanly. The optimizer treats kind family as a hard partition constraint before packing.

*Source: `01KW50E9YDJYJ14V8ASQ93WKQK`, `01KW50VRD8EHY64ZX6XQZRY6FG`, arxiv 2303.05989*

### B3. Tree DP (Reference Implementation)

```
Input: forest/SP eligible subgraph G=(V,E), overhead B, per-milestone costs Kᵢ,
       file sets Sᵢ (from read_only[] + op.file targets), window W
Output: optimal batch assignment → DispatchUnit[]

1. Topological sort V → [v₁, ..., vN] (leaves first)
2. For each node vᵢ bottom-up:
   dp[vᵢ][S] = min cost to batch vᵢ and its subtree, given S = current batch members
   Decision at each node:
     a) Extend parent's batch if Kᵢ + |∪S ∪ Sᵢ| ≤ W  (no new B; union may grow)
     b) Start new batch (pay B; Sᵢ is the only file set)
   Choose min cost option
3. Return dp[root][∅]
```

---

## Part C — Variable Measurement Infrastructure

The optimizer requires measured values for B, Sᵢ, Kᵢ, and the precomputed overlap matrix.

### C1. B — Base Dispatch Overhead

**Source:** `dag.optimization.b_per_tier[model]` — null until calibrated.
**Calibration:** run a null-task dispatch against each executor type; record actual input
tokens before task content. Cache per executor type in a global
`~/.adhd/dispatch-calibration.json` (B is executor-type-specific, not plan-specific).

**Key finding:** tool schema injection is the dominant B component. A 40-tool MCP server
adds 2,500–3,750 tokens per dispatch whether or not those tools are used. Add a tool-pruning
pass: enumerate which MCP tools each executor agent actually invokes; inject only those.
(GitHub Engineering cut agentic workflow costs 62% through tool pruning alone.)

*Research node: `01KW3FH2GTMQFSTC90CSJ43509`*

### C2. Sᵢ — Source File Sets

**Source:** `milestone.read_only[]` (explicit paths) + `op.file` targets for all ops in the
milestone where `op.type == "generative"` (prospective — files don't need to exist).

**Overlap computation:**
- Prospective (pre-execution): use op.file targets. Key presence in `snapshot.pairwise_overlap`
  signals shared-context opportunity even when byte values are 0 (files not yet on disk).
- Actual (post-execution): use `milestone.artifacts` byte sizes.

```
// All 1,225 pairs at N=50 → ~25 microseconds on modern hardware
for (i=0; i<N; i++)
  for (j=i+1; j<N; j++)
    overlap[i][j] = intersection(files[i], files[j]).map(f => bytesize(f) || 0)
```

Do **not** use HyperLogLog for intersection: error amplifies by 1/Jaccard.
MinHash k=128 (RMSE ≤ 8.84%) for |Sᵢ| > 500 files only.

*Research node: `01KW50BGA8NF4JZVG3DYAT2Z11`*

### C3. Kᵢ — Per-Milestone Output Token Estimate

**Source:** `sum(op.ki_estimate)` across ops in milestone i.

**Derivation per shape.kind** (applied by `snapshot()` when ki_estimate is null on an op):

```
ki_estimate by shape.kind:
  code kinds (function|interface|type|...):
    derived from ops[] complexity via gitnexus; fallback: ops.length × 200
  config kinds (config|env|schema|manifest):
    ops.length × 100
  doc:
    effort-tier heuristic: low→600, medium→1000, high→2000
  structured-output:
    schema field count × 50
  tool-call (op.type == "tool-call"):
    always 0
```

**Source file bytes** (for context window budget, added to Sᵢ not Kᵢ):
```
tokens_from_files = Σ_{f ∈ read_only[]} (file_bytes(f) / chars_per_token(type(f)))

chars_per_token by file type:
  prose / Markdown:       5.5
  TypeScript / Python:    6.3
  cross-type (default):   4.0  (conservative upper bound)
```

LOC and AST complexity do not improve prediction after controlling for file length.
Byte count is the right proxy (r > 0.98, arxiv 2511.08066).

*Research node: `01KW50BZM0WN896PNW092WME8W`*

### C4. Historical Calibration

**Source:** `dispatch_log[].turns[]` — `input_tokens` and `output_tokens` per turn per dispatch.

At plan-compile time, read prior actuals from `dispatch_log[]` and use as `ki_actual` to
calibrate the per-kind heuristics above. Emit calibration coefficients into the global
`~/.adhd/dispatch-calibration.json`.

Cold-start (no history): use heuristics from §C3 with an explicit 15% upward buffer.

---

## Part D — Prompt Caching Architecture

**Required: Sentinel-Fanout dispatch**
```
Step 1: Pre-warm call — dispatch a null/minimal task to the shared executor type
        Cost: w×B = 1.25B (writes the prefix to KV cache)
Step 2: N−1 actual milestone batches dispatched in parallel
        Each pays r×B = 0.1B (cache read hit)

Total B cost: 1.25B + (N−1)×0.1B
vs. Naive:    N × 1.25B

Savings at N=10: naive = 12.5B → Sentinel = 2.15B (5.8× cheaper on base overhead alone)
Savings at N=4:  naive = 5.0B  → Sentinel = 1.55B (3.2× cheaper)
```

**TTL constraint (Anthropic):** cache expires after 5 minutes. All N-1 parallel batches must
complete before TTL. Wave partition maximum: `W_max = floor(300s / t_exec_per_batch)`.
At typical t_exec ≈ 60s: max 4 batches per Sentinel-Fanout window.

**`sentinel_fanout` in dag.optimization:**
```jsonc
"sentinel_fanout": {
  "enabled": true,
  "write_multiplier": 1.25,   // w
  "read_multiplier": 0.10,    // r
  "hit_probability": 0.90     // p
}
```

`optimize()` reads these values directly from the snapshot's optimization block.

**Provider comparison:**

| Provider | r (read) | w (write) | TTL | Notes |
|---|---|---|---|---|
| Anthropic | 0.10 | 1.25 | 5 min | Highest discount; tight TTL; explicit breakpoints required |
| OpenAI | 0.50 | 1.00 | undisclosed | Half discount; no write surcharge; zero overhead |
| Gemini 2.5 Pro | 0.10 | 1.00 | 1 hour | Comparable discount; most forgiving TTL for phased workflows |

*Research node: `01KW50BWG71JE21QNFNT5ESRRZ`, arxiv 2601.06007*

---

## Part E — Context Window Enforcement

**Enforce W per dispatch unit.** `optimize()` must reject any packing where
`tokens_estimated > context_window_per_tier[model]`.

**Effective W values** (stored in `dag.optimization.context_window_per_tier`):
```
W[claude-sonnet]  = 16,000 tokens  (0.5× single-task window — merged prompts degrade)
W[gpt-4o]         = 16,000 tokens
W[gemini-2.5-pro] = 64,000 tokens
```

**Empirical basis:** Claude-3.5 Sonnet −41.7pp MMLU at 7,500 tokens; −67.6pp at 30K tokens.
Merged multi-task prompts degrade faster than single long prompts due to instruction
interference and "lost in the middle" position penalty (30%+ recall drop for non-primacy/
recency positions). Effective useful context for N-task merged prompt: ~50–60% of the same
token budget on a single-task prompt.

*Research node: `01KW50ABQ5RK6QCM52AT3Y7698`, arxiv 2510.05381, RULER benchmark*

---

## Part F — Success Metrics

Four levels of measurable success, ordered by when each becomes observable.

### F1. Level 1 — Compiler correctness (measurable now)

All assertions checkable from `snapshot()` and `validateDag()` output alone — no dispatch
activity required. These are the golden file gate and the pre-commit check.

| Metric | Assertion | Data source |
|---|---|---|
| D-07 invariant | Zero eligible milestones with `pending != null` | `snapshot.milestones[slug].eligible` |
| D-08 invariant | All milestones with complete deps and `pending != null` → `status == "pending-surfaced"` | same |
| Wave validity | Every milestone's wave > max(wave of deps) | `snapshot.milestones[slug].wave` |
| Snapshot determinism | `snapshot(dag)` called twice produces byte-identical output on all non-timestamp fields | in-process re-run |
| Validation rejection | `validateDag()` returns `valid: false` for every seeded structural violation | unit test suite (6 cases) |

**Gate:** `npx tsx tests/harness.ts` — hard pass/fail. Exits 0 only when all L1 assertions hold
and the snapshot output matches the committed golden exactly.

### F2. Level 2 — Cost model accuracy (unlocked when `tokens_actual` flows back)

Requires `dispatch_log[].turns[].tokens_actual` populated by the orchestrator after real dispatch.

| Metric | Target | Tolerance |
|---|---|---|
| `tokens_estimated` error | ≤ ±20% of `tokens_actual` per unit with `ki_estimate > 0` | P80 across completed units |
| `b_per_tier` calibration | Observed base overhead within ±15% of `b_per_tier[tier]` | Per tier, measured once per executor type |
| Sentinel-Fanout savings | Measured B cost ≤ `1.25B + (N−1)×0.10B` for N≥2 parallel units in same fanout window | Per window in dispatch_log |

### F3. Level 3 — Dispatch pipeline integrity (after BL-105 wired)

| Metric | Target |
|---|---|
| DispatchUnit compilation success rate | 100% — zero eligible milestones produce null prompt or null provider |
| Agent execution success rate | >80% dispatched units produce output passing gitnexus + `validateDag()` |
| Plan advancement rate | ≥1 milestone transitions to `status: "complete"` per dispatch cycle |

### F4. Level 4 — Optimizer vs. naive baseline (comparative; requires L2 + L3 data)

**Naive baseline definition:** one milestone = one agent call, no packing, no Sentinel-Fanout.
```
tokens_naive = sum(b_per_tier[model] + ki_estimate) for each eligible milestone
```
Recorded in the golden at plan-compile time for apples-to-apples comparison.

| Metric | Target | Notes |
|---|---|---|
| Token cost reduction (optimizer vs. naive) | Measurable positive reduction | Expected 40–60% at N≥5 from Sentinel-Fanout alone |
| `fits_context_window` violation rate | 0% — no unit exceeds effective W | Hard constraint enforced in `optimize()` |
| Packing efficiency | `sum(ki_estimate per unit) / W ≥ 0.6` for units with >1 milestone | Measures how fully milestones fill the window |

---

### Golden file format

**Location:** `tests/goldens/<dag-slug>/`

```
tests/goldens/
  adhd-build/
    __meta__.json               # { recorded_at, git_sha, dag_path }
    snapshot.golden.json        # full snapshot output (timestamp fields set to null)
    dispatch-units.golden.json  # DispatchUnit[] including compiled prompts
    metrics.golden.json         # L1 computed values + naive baseline + dispatch unit summary
    prompts/                    # compiled prompts as .md (human-readable diff target)
      dag-schema.dispatch.0.md
  GOLDEN_HISTORY.md             # append-only changelog: one entry per update-goldens run
```

**Update flow:**
```bash
npx tsx tests/update-goldens.ts [dag-slug]   # regenerate + print diff summary; append GOLDEN_HISTORY.md
npx tsx tests/harness.ts                     # compare against goldens; exit 1 on divergence
```

**Commit discipline:** golden files are committed alongside the code change that caused them to
change. `git log tests/goldens/adhd-build/metrics.golden.json` recovers the full metric history
without any custom tooling.

`GOLDEN_HISTORY.md` provides a human-readable cross-commit summary:
```
## 2026-06-28 (abc1234) — initial capture
- dag: docs/plan/adhd-build/dag.json (13 milestones, 15 ops)
- Eligible: 2 | Wave max: 5 | Dispatch units: 2
- Sentinel-Fanout: yes | All L1 pass
- tokens_estimated: null (b_per_tier not yet calibrated)
```

---

## Next: Implementation

The schema is defined. The algorithm is researched. The next two functions to implement
establish the complete compiler pipeline:

### N1. `snapshot(dag: DagJson): DagSnapshot` — `src/compiler.ts`

**Input:** the authored `dag.json` document (read from disk).
**Output:** the fully computed `dag-snapshot.json` — every field annotated as `dag`, `derived`,
`scheduler`, `optimizer`, or `clock` in PROPOSED_DAG_STRUCTURE.md is computed here.

**Does not include `dispatch_units[]`** — those are produced by `optimize()`.

**Computation steps in order:**

1. **Copy dag-level fields** — description, problem, approach, executor, phases, terminal,
   assumed_baseline, optimization block.

2. **Compute `b_eff_per_tier`** — for each tier:
   ```
   b_eff = b_per_tier[tier] × ((1 − p) × w + p × r)
   ```
   Null if `b_per_tier[tier]` is null.

3. **Topological sort** — sort milestones by `depends_on` depth → assign `wave` numbers.
   Milestones with empty `depends_on` get wave 0. Ties within a wave are stable-sorted by
   slug for determinism.

4. **Per-milestone derived fields** (for each slug):
   - `eligible`: `pending == null` AND all deps have `status == "complete"` AND no dep has `status == "failed"`
   - `status`: scan ops and dispatch_log:
     - `complete` if guard op in dispatch_log has `guard_result == "pass"`
     - `failed` if any op has `status: "failed"`
     - `in_progress` if any op is `in_progress`
     - `pending-surfaced` if `eligible == false` AND `pending != null` AND all deps are `complete`
     - `pending` otherwise
   - `started_at`: min `dispatch_log[id].started_at` across all dispatches touching this milestone
   - `completed_at`: `guard_ran_at` from the dispatch_log results entry where guard passed
   - `guard_result`, `guard_output`: from latest guard op result in dispatch_log
   - `artifacts`: union of `op.file` for write-class actions in this milestone
   - `si_bytes`: `sum(stat(f).size for f in artifacts)` — 0 if file doesn't exist yet
   - `ki_estimate`: `sum(op.ki_estimate)` across ops (applying §C3 heuristics for null estimates)
   - `tokens_estimated`: `b_eff_per_tier[resolved_model] + si_bytes_as_tokens + ki_estimate` — null if any input null
   - `tokens_actual`: summed from dispatch_log turn tokens for completed dispatches on this milestone
   - `context`: `"contexts/<slug>.md"` (path, not content)

5. **Per-operation derived fields** (for each op, including synthesized guard ops):
   - `dispatch_ids`, `attempt_count`: scan dispatch_log
   - `guard_result`, `guard_output`, `guard_ran_at`: from latest dispatch result
   - `from`: baseline value from prior completed op on same (file, symbol) or AST read
   - `breaking`, `severity`: deterministic lookup table on (op, required, from→to)
   - `blast_radius`: gitnexus_impact call for current consumers; cross-op scan for future
   - `conflict`: scan same-wave ops for op_key collisions
   - `tokens_actual`: prorated from dispatch token totals by ki_estimate share

6. **`pairwise_overlap`** — for all ordered pairs (i, j):
   - Prospective: `intersection(op.file targets of i, op.file targets of j)` — key populated, bytes 0 if files absent
   - Actual: replace with `sum(stat(f).size)` for intersection of `artifacts[i] ∩ artifacts[j]`

7. **`open_questions[]`** — for each milestone where `pending != null`:
   - Scan dispatch_log notes for the turn and dispatch where question appeared
   - Set `surfaced: milestone.status == "pending-surfaced"`

**Guard:** output snapshot passes a structural validator (all required derived fields present,
no null waves, no eligible milestone with pending != null, all status values valid enum members).

---

### N2. `optimize(snapshot: DagSnapshot): DispatchUnit[]` — `src/compiler.ts`

**Input:** `DagSnapshot` — fully computed snapshot from `snapshot()`.
**Output:** `DispatchUnit[]` — the optimal dispatch plan for the current scheduling cycle.

**Does not mutate `snapshot`.** Returns a new array; caller writes it into the snapshot.

**Computation steps in order:**

1. **Select eligible milestones** — filter `snapshot.milestones` where `eligible == true`
   (by definition: `pending == null` AND all deps complete AND no dep failed).
   If empty, return `[]`.

2. **Partition by shape.kind family** — milestones with different kind families cannot be
   packed together (different prompt modes). Partition into:
   - `code-config`: `shape.kind ∈ {function, interface, type, class, enum, const, script, config, env, schema, manifest}`
   - `doc`: `shape.kind == "doc"`
   - `structured`: `shape.kind == "structured-output"`
   - `tool-call`: all ops are `type: "tool-call"` (guard-only or dag-mutation milestones)
   Run optimizer independently per partition; merge results.

3. **Detect DAG structure** on the eligible subgraph (using `depends_on` edges restricted
   to eligible nodes). Check forest → series-parallel → general DAG in order.

4. **Select algorithm** per §B2 table, using `N = eligible milestone count`.

5. **Run optimizer** with:
   - `B = b_eff_per_tier[milestone.model]` (or `b_per_tier` if `b_eff` is null)
   - `Sᵢ = read_only[] paths + op.file targets` for each milestone
   - `Kᵢ = milestone.ki_estimate`
   - `W = context_window_per_tier[milestone.model]`
   - `pairwise_overlap` from snapshot

6. **Assemble each DispatchUnit** — unit is fully self-contained; orchestrator reads it and
   fires without touching any other file:
   - `id`: `"<primary-milestone-slug>.dispatch.<n>"`
   - `milestones[]`: slugs packed into this unit
   - `operations[]`: all op ids from packed milestones, respecting op-level `depends_on`
   - `model`, `effort`, `two_stage`: from primary milestone (first in `milestones[]`)
   - `provider`: copy `dag.providers[milestone.model]` verbatim — `type`, `model_id`,
     `env_secret` (env var NAME not value), `base_url`, `timeout_ms`, `retry_config`
   - `agent_name`: resolve from `milestone.agent` slug (strip namespace prefix if present;
     e.g. `"workflow:workflow-researcher"` → `"workflow-researcher"`)
   - `mcp_servers`: from agent catalog entry for `milestone.agent`
   - `resolved_max_tokens`: `dag.effort_max_tokens[milestone.effort]`
   - `background`: always `true`
   - `prompt`: compile now from: milestone description/rationale + inlined content of
     `context_files[]` + per-op shape specs (`shape.description`/`objective` for `doc`,
     `shape.ops[]` for code/config, `shape.schema` for structured-output); null if all ops
     are `type: "tool-call"` (no model call needed)
   - `context_files[]`: union of `milestone.context` paths + `read_only[]` + `op.file`
     targets + relevant `blast_radius` files (read at optimize() time for prompt assembly)
   - `si_bytes`: `sum(stat(f).size for f in context_files)` at pack time
   - `tokens_estimated`: `b_eff_per_tier[model] + si_bytes_as_tokens + sum(ki_estimate for ops in unit)`
   - `fits_context_window`: `tokens_estimated <= context_window_per_tier[model]`
   - `dispatch_log_id`, `remote_task_id`, `result`: null (set by orchestrator at dispatch time)
   - `status`: `"pending"`

7. **Apply Sentinel-Fanout grouping** — if `sentinel_fanout.enabled`:
   Group dispatch units into windows of `W_max = floor(300s / t_exec_per_batch)`.
   Within each window, the first unit is the pre-warm call (or the heaviest unit whose
   system prompt serves as the cache anchor).

8. **Validate** — for each unit: `fits_context_window == true`. Split any unit where false
   (re-run optimizer on the overflowing milestone as a singleton).

**Guard:** `sum(tokens_estimated for all units) <= context_window_per_tier[model] × N`
(sanity check — total budget cannot exceed N solo dispatches).

---

## Deliverables (updated)

| Deliverable | Description | Status |
|---|---|---|
| `PROPOSED_DAG_STRUCTURE.md` | Complete dag.json + snapshot schema with all fields annotated | done |
| `DECISIONS.md` | 17 design decisions with rationale and ruled-out alternatives (D-14–D-17: provider integration) | done |
| `src/compiler.ts` → `snapshot()` | Computes all derived snapshot fields from dag.json | **next** |
| `src/compiler.ts` → `optimize()` | Runs algorithm selection + batch assignment → DispatchUnit[] | **next** |
| `src/dag/types.ts` | TypeScript types for DagJson, DagSnapshot, DispatchUnit, all sub-types | pending (dag-schema milestone) |
| `src/dag/io.ts` | readDag, writeDag, appendDispatch | pending |
| `src/dag/validate.ts` | Structural validator for dag.json and snapshot output | pending |
| Calibration utility | Instruments B per executor type; updates `~/.adhd/dispatch-calibration.json` | pending |
| Sentinel-Fanout wrapper | Groups DispatchUnit[] into cache-warm windows | pending (inside optimize()) |

**Removed from deliverables** (superseded by new schema):
- `scripts/compile-wave-v2.js` — replaced by `src/compiler.ts`
- `scripts/build-overlap-matrix.js` — inlined into `snapshot()` as pairwise_overlap step
- `scripts/measure-dispatch-overhead.js` — becomes calibration utility
- `libs/plan-optimizer/` — replaced by `src/compiler.ts`

---

## Open Decisions

1. **CP-SAT solver dependency:** OR-Tools JS binding (`node-or-tools`) is less maintained.
   Options: (a) spawn Python subprocess, (b) `node-or-tools`, (c) simulated annealing in
   pure TS. **Recommendation:** SA in pure TS — achieves 3–8% from CP-SAT optimal at N≤50,
   no Python dep, no native build step.

2. **`b_per_tier` cold-start values:** until `B` is calibrated, `b_eff_per_tier` is null and
   `tokens_estimated` cannot be computed. **Recommendation:** seed defaults
   `{ Haiku: 8000, Sonnet: 15000, Opus: 27000 }` in the schema as the uncalibrated baseline;
   calibration overwrites them.

3. **Sentinel-Fanout TTL handling:** how to handle the 5-minute Anthropic TTL across long-
   running waves. **Recommendation:** wave partition at `W_max = floor(TTL / t_exec)` with
   re-warm between partitions; `t_exec` defaults to 60s until calibrated.

4. **`optimize()` scope — eligible only or all milestones?** Current decision: eligible only.
   This means `optimize()` must be called again after each dispatch closes (re-eligibility).
   Alternative: compute the full multi-wave plan upfront. **Recommendation:** eligible only —
   research completions change Kᵢ for downstream milestones, making upfront full-plan estimates
   unreliable.

---

## Gaps in Prior System (unchanged)

| Gap | Token impact | Fix |
|---|---|---|
| B omitted from cost model | ~54K tokens unquantified across 3 waves | Add B to merge savings: `savings(i,j) = B + \|Si∩Sj\|` |
| Si not expanded from sources | Cannot compute \|Si∩Sj\| at all | Use `read_only[]` + op.file targets in snapshot() |
| Ki missing source file bytes | Underestimates task context | Add `Σ file_bytes/chars_per_token` per milestone |
| Naive simultaneous fan-out (p≈0) | All batches pay full write cost; 3–6× excess B spend | Sentinel-Fanout in optimize() |
| W not validated before dispatch | Merged prompts may exceed quality cliff | `fits_context_window` check in optimize() |
| Level/wave sync forced as barrier | Suboptimal; wastes parallelism | HLFET dispatches as soon as predecessors done |
| tokens_actual not fed back | First-run estimates degrade | Read dispatch_log turns in snapshot() |

---

## Non-Goals

- Building a new executor type or new agent capability
- Cross-plan global scheduling (this optimizer is per-plan)
- GPU-accelerated optimization (unnecessary at N≤50)
- OS-level sandboxing of dispatched agents

---

## Financial-Impact Flags

- **No new AI spend.** All optimization runs at plan-compile time on the orchestrator CPU.
- **B calibration:** one null-task dispatch per executor type, once per calibration cycle.
- **OR-Tools / CP-SAT:** Apache 2.0 open source, no licensing cost.
- **Sentinel-Fanout write surcharge (w=1.25):** recovered on first 2 parallel batches.

---

## Research Memory Index

All supporting research persisted to `~/.memory/memory.db`, topic `multi-agent-dispatch-optimization`.

| Finding | UID |
|---|---|
| Complexity class, polynomial special cases (forest, SP DAG) | `01KW50B16RKRR3NE4XMDFNVR8J` |
| DAG constraint encoding, CP-SAT vs CBC solver comparison | `01KW50E9YDJYJ14V8ASQ93WKQK` |
| Set intersection algorithms (exact vs MinHash vs HLL) | `01KW50BGA8NF4JZVG3DYAT2Z11` |
| Multi-objective → single-objective reduction (Ehrgott) | `01KW509Y9SZRC6417C3B6B0YHZ` |
| Proxy metrics: byte→token ratios, LOC dominance | `01KW50BZM0WN896PNW092WME8W` |
| Context window degradation in merged multi-task prompts | `01KW50ABQ5RK6QCM52AT3Y7698` |
| Prompt caching model: B_eff, Sentinel-Fanout, provider table | `01KW50BWG71JE21QNFNT5ESRRZ` |
| Complete ILP formulation, linearization, solver timing | `01KW50C198S9CMNREVYSPS962D` |
| Greedy approximation algorithms, SA refinement, FGO/GAP | `01KW50VRD8EHY64ZX6XQZRY6FG` |
| Original gap identification (compile-wave.js) | `01KW3F0GA02V058ZHDTDPJ4EEB` |
