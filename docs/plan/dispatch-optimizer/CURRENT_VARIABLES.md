# Dispatch optimizer — current plan-state-machine variables

> **Source:** `categories/workflow/skills/plan-state-machine/SKILL.md`, `METRICS.md`,
> `templates/dag.template.json`, `templates/state.template.json`, and
> `scripts/compile-wave.js` (read directly, 2026-06-27).
>
> **Scope:** every field available to an optimizer at plan-compile time or post-execution.
> The "relative doc path" column uses the prefix `docs/plan/<plan-slug>/` by convention.
> Fields outside the plan dir (metrics sink, plan-index) are noted explicitly.
>
> **Importance key:** High = feeds the primary objective or a hard constraint directly;
> Medium = improves estimate accuracy or enables secondary optimizations; Low = diagnostic /
> quality signal, not on the critical path of the optimizer.

---

## Part 1 — DAG structure (`dag.json`)

These are the optimizer's primary inputs: the graph topology, file sets, and per-state metadata
available before any dispatch occurs.

| Variable name | Mathematical variable | Summary | Relative doc path | JSON path | Description | Importance |
|---|---|---|---|---|---|---|
| State dependency edges | E | DAG edge set (the partial order) | `dag.json` | `$.nodes[*].depends_on[]` | Array of upstream state slugs that must complete before this one. Defines the partial order used by Tree DP, CP-SAT, and HLFET. Determines whether the DAG is a forest, series-parallel, or general DAG — the structural classification that selects the algorithm tier. | High |
| State artifact files | Sᵢ | Source file set for state i (write side) | `dag.json` | `$.nodes[<slug>].artifacts[]` | Files produced or **mutated** by this state. Stored as glob patterns or explicit paths. Must be expanded to a flat file list before computing |Sᵢ ∩ Sⱼ|. Currently **not expanded** in compile-wave.js — this is Gap 2 in SCOPE.md. | High |
| State read-only files | Sᵢ (supplement) | Source file set for state i (read side) | `dag.json` | `$.nodes[<slug>].read_only[]` | Files the state reads but does not mutate. Also part of Sᵢ — an executor reads these files, paying their token cost. Both `artifacts` and `read_only` must be unioned to compute the full Sᵢ. | High |
| State kind | — | Execution class (work / audit / review) | `dag.json` | `$.nodes[<slug>].kind` | Enum: `work` \| `audit` \| `review`. Audit states are mandatory barrier hold-points — they cannot be batched with work states and act as hard synchronization points in the schedule. The optimizer must treat audit nodes as isolated single-state batches. | High |
| Task model tier | B_tier | Executor model for cost tier routing | `dag.json` | `$.nodes[<slug>].tasks[*].model` | `Haiku` \| `Sonnet` \| `Opus`. Maps to different B values (base dispatch overhead). Opus dispatches carry larger system prompts and tool schemas. An optimizer that ignores model tier conflates fundamentally different cost classes. | High |
| Task writes set | W_task | File write set for a single task | `dag.json` | `$.nodes[<slug>].tasks[*].writes[]` | Files this individual task writes. The primary parallel-safety predicate: two tasks with overlapping `writes` must serialize or worktree-isolate. compile-wave.js uses disjoint `writes` to derive parallel-safe waves within a state. | High |
| Task intra-wave needs | E_task | Intra-wave dependency edges | `dag.json` | `$.nodes[<slug>].tasks[*].needs[]` | Task ID / state slug / file name dependencies within a state's task board. The task-level DAG used by `compile-task.js --board` to derive parallel-safe waves within a single state. Feed into the intra-state scheduling sub-problem. | Medium |
| Task effort hint | Kᵢ (signal) | Qualitative difficulty signal | `dag.json` | `$.nodes[<slug>].tasks[*].effort` | `easy` \| `medium` \| `hard`. Qualitative effort estimate. Use to calibrate Ki when no historical actuals exist for a state's executor type. Can be encoded as a multiplier: easy=0.5×, medium=1×, hard=1.75× the base byte-ratio estimate. | Medium |
| Two-stage flag | — | Two-pass dispatch multiplier | `dag.json` | `$.nodes[<slug>].tasks[*].two_stage` | Bool. If `true`, the task dispatches in two passes (spec generation → application). Effective cost ≈ 2× Ki. The optimizer must treat these as split tasks whose combined token budget is additive. | Medium |
| Two-stage eligible | — | Two-stage opt-in gate | `dag.json` | `$.nodes[<slug>].tasks[*].eligible` | Bool (default `false`). Opt-in gate for the two-stage harness. If `false` (with reason), the task cannot be two-staged even if effort is `hard`. Relevant to a splitting heuristic. | Low |
| Task criteria links | — | Acceptance criterion IDs this task proves | `dag.json` | `$.nodes[<slug>].tasks[*].criteria[]` | Criterion IDs (`[slug.N]`) this task satisfies. Not directly relevant to cost, but used by the audit reconciler to verify coverage. Provides an indirect lower bound on the task's scope. | Low |
| State phase label | — | Phase grouping for the state | `dag.json` | `$.nodes[<slug>].phase` | Ordered phase name (e.g. `foundation`, `convergence`). Phases imply a coarse ordering: all states in phase N must precede phase N+1. Series-parallel structure often follows phase boundaries — detect this to select the Tree DP path. | Medium |
| State context file path | — | Path to the work-order prose file | `dag.json` | `$.nodes[<slug>].context` | Relative path to the context file for this state (e.g. `contexts/core-types.md`). Used by compile-task.js to read the prose content for Ki estimation and deduplication. | High |
| State notes | Kᵢ (minor) | Resume context / executor notes | `dag.json` | `$.nodes[<slug>].notes` | Brief prose field: footguns, ordering constraints, non-obvious decisions. Small Ki component (typically ≤500 bytes). Included in the compiled work-order packet. | Low |
| Symbol changes | — | Declared symbol mutations | `dag.json` | `$.nodes[<slug>].changes.{deletes,resigns,renames,adds_set_members}[]` | Declared symbol-level mutations. Used by gap-check.js `--discover` to verify caller coverage. Not directly relevant to token cost, but the presence of `deletes` / `resigns` implies callers that must be in other states' `read_only` sets — indirect Si dependency. | Low |
| Plan kind | — | Greenfield vs. brownfield | `dag.json` | `$.plan_kind` | `brownfield` \| `greenfield`. Brownfield plans have high Si (existing file reads); greenfield plans have low Si (no existing code to read). Affects prior on file-overlap density. | Low |
| Phase list | — | Ordered phase sequence | `dag.json` | `$.phases[]` | Ordered array of phase names. A plan with K phases where each phase is a linear chain is a forest DAG — the polynomial Tree DP special case. Detect: if every state's `depends_on` references only states in prior phases, the DAG is a forest. | Medium |
| Terminal state slug | — | Terminal state identifier | `dag.json` | `$.terminal` | The slug of the `done` terminal state. Needed by HLFET to compute critical-path length from each node to the sink. | Low |
| Plan executor agent | — | Default executor type | `dag.json` | `$.executor` | e.g. `sox-active:<agent-name>`. Determines the base B value for states without per-task model overrides. | Medium |

---

## Part 2 — Runtime state (`state.json`)

Live execution state — available to the orchestrator at wave-dispatch time.

| Variable name | Mathematical variable | Summary | Relative doc path | JSON path | Description | Importance |
|---|---|---|---|---|---|---|
| Orchestrator cursor | — | Next state to dispatch | `state.json` | `$.current_state` | The slug of the current active state. The orchestrator's resumable pointer — determines which states are eligible for dispatch in the next wave. | High |
| Per-state execution status | — | Pending / in_progress / complete / blocked | `state.json` | `$.states[<slug>].status` | `pending` \| `in_progress` \| `complete` \| `blocked`. Only `pending` states with satisfied `depends_on` are eligible for dispatch. The optimizer's feasibility filter. | High |
| State start timestamp | tᵢ_start | Wall-clock start time | `state.json` | `$.states[<slug>].started_at` | ISO-8601 timestamp when the executor started this state. Used to compute wall_clock_s when `done_at` is also present. | Medium |
| State done timestamp | tᵢ_done | Wall-clock completion time | `state.json` | `$.states[<slug>].done_at` | ISO-8601 timestamp when the state completed. Together with `started_at`, gives actual execution duration tᵢ = done_at − started_at. The most accurate scheduling cost signal available after first execution. | Medium |
| State start git SHA | — | Git reference at work start | `state.json` | `$.states[<slug>].start_ref` | Git SHA when the executor began. Required for training-record extraction. Present only in non-degraded records (the executor ran `state-transition.js --start`). | Low |
| State end git SHA | — | Git reference at work completion | `state.json` | `$.states[<slug>].end_ref` | Git SHA when the executor completed. Together with `start_ref`, bounds the actual diff. | Low |
| Transition log | — | Per-state completed transition history | `state.json` | `$.transition_log[*]` | Append-only array: `{ts, from, to, start_ref, end_ref, audit_exit, criteria_passed, criteria_total, by, note}` per transition. Historical execution record — use to reconstruct actual wall_clock_s and audit quality for Ki calibration. | Medium |
| Amendment log | — | Rework events per state | `state.json` | `$.amendment_log[*].{state,class,type,reason}` | Per-amendment record. `class`: `executor` (minor fix) or `planner` (scope error → state blocked). Planner-class amendments are stronger signals that Ki was underestimated or that W was violated. | Medium |
| Skill version stamp | — | Plugin identity that authored the plan | `state.json` | `$.authored_with.{plugin,version,hash}` | The skill plugin version that built the plan. A drift signal: a plan authored with an old skill version may not have DAG fields the optimizer expects (e.g., `tasks[]` was added in a later version). | Low |

---

## Part 3 — Context files (`contexts/`)

The prose content read by compile-task.js to build each state's work-order packet. These
are the primary Ki and shared-set (Sᵢ) sources.

| Variable name | Mathematical variable | Summary | Relative doc path | JSON path | Description | Importance |
|---|---|---|---|---|---|---|
| Context file byte length | Kᵢ (prose proxy) | Per-state work-order prose size | `contexts/<slug>.md` | — (byte length of the file) | The full work-order text for a state. `byte_length / chars_per_token(prose)` ≈ prose token estimate for Kᵢ. The single cheapest Kᵢ proxy available at planning time — no LLM call required. Measured by `emit-state-metrics.js` as `context_file_bytes`. | High |
| Shared invariants content | ∩(inv) | Shared [inv:] strings | `contexts/_shared.md` | — (parsed [inv:] blocks) | The `[inv:]` entries from `_shared.md`. These appear in **every** executor's prompt — they are the shared-set component that compile-wave.js deduplicates across a wave. Byte length = `shared_md_bytes` in the metrics record. | High |
| Read-only snapshot paths | Sᵢ (file paths) | Actual file paths to be read | `contexts/<slug>.md` | — (parsed `read_only_snapshots[].path`) | The actual file paths in the state's `read_only_snapshots` list (populated at compile-task time from `dag.json` `read_only` + `start_ref` expansion). The real Sᵢ — these are the per-file reads that get deduplicated across states in the same wave. | High |
| Reference citation count | \|ref_i\| | Number of [ref:X] citations in state i | `contexts/<slug>.md` | — (count of `[ref:X]` occurrences) | The number of reference pattern citations. Each cited reference body is resolved from `references.json` and included in the work-order. Shared references across a wave are deduplicated by compile-wave.js. | Medium |

---

## Part 4 — compile-wave.js `--stats` output

Computed output of the current optimizer. These are the metrics compile-wave.js already emits
and the gap the SCOPE.md identifies.

| Variable name | Mathematical variable | Summary | Relative doc path | JSON path | Description | Importance |
|---|---|---|---|---|---|---|
| Total work-order bytes | Σ(Si+Ki) proxy | Sum of all full work-orders (no merging) | — (stdout of `--stats`) | `$.total_work_order_bytes` | Total bytes if each state in the wave received its full unshared work-order independently. Proxy for Σᵢ(Sᵢ + Kᵢ) but **excludes B** (the fixed base overhead per dispatch). This omission is Gap 1 in SCOPE.md. | High |
| Wave pack bytes | \|∪Sᵢ\| proxy | Bytes of shared context pack | — (stdout of `--stats`) | `$.wave_pack_bytes` | Bytes of the shared wave context pack — invariants, references, and snapshots that appear in ≥2 states. Proxy for the shared-set cost: \|∪Sᵢ\|. The key savings term in the merge objective. | High |
| Total with pack + deltas | Σ(merged cost) | Merged total bytes | — (stdout of `--stats`) | `$.total_with_pack_and_deltas_bytes` | Actual total bytes dispatched with wave deduplication: `wave_pack_bytes + Σ(delta_bytes per state)`. The optimizer's output cost metric. | High |
| Reduction ratio | ρ | Pack savings fraction | — (stdout of `--stats`) | `$.reduction_ratio` | `1 − total_with_pack_and_deltas / total_work_order_bytes`. The current optimizer's single output metric. **Measures prose/ref/snapshot overlap only** — does not include B savings from batch merging (Gap 1) or file-byte overlap from Sᵢ (Gap 2). | High |
| Shared invariant count | \|∩(inv)\| | Number of shared invariants | — (stdout of `--stats`) | `$.shared_invariants` | Count of `[inv:]` strings appearing in ≥2 states' packets. A cheap proxy for shared-set density before expanding file contents. | Medium |
| Shared reference count | \|∩(ref)\| | Number of shared references | — (stdout of `--stats`) | `$.shared_refs` | Count of `[ref:X]` entries shared across ≥2 states. Each shared ref saves its body bytes for every additional state beyond the first. Typically 50–500 bytes per shared ref. | Medium |
| Shared snapshot count | \|∩(snap)\| | Number of shared file snapshots | — (stdout of `--stats`) | `$.shared_snapshots` | Count of file snapshots shared across ≥2 states. Each shared snapshot can save hundreds to thousands of bytes (file content). The **highest-value deduplication target** in the current model. | High |
| Wave slug list | — | Ordered slug list for the wave | — (stdout of `--stats`) | `$.slugs[]` | The slugs included in the wave. Needed to reconstruct which states were batched together for cost attribution. | Low |
| Failed slug list | — | Slugs that failed to compile | — (stdout of `--stats`) | `$.failed_slugs[]` | Slugs where compile-task.js returned an error. These states cannot be included in the wave — the optimizer must handle partial compilation. | Medium |

---

## Part 5 — Historical metrics (`metrics-aggregate.jsonl`)

Post-execution actuals written by `emit-state-metrics.js`. These are the calibration source
for the optimizer's Ki estimates. Written to the durable sink at:
`$AGENT_FORGE_SINK/data/training/metrics-aggregate.jsonl` and per-state at
`$AGENT_FORGE_SINK/plan-executions/<plan>-<slug>-metrics.jsonl`.

| Variable name | Mathematical variable | Summary | Relative doc path | JSON path | Description | Importance |
|---|---|---|---|---|---|---|
| Context file bytes (actual) | Kᵢ_prose (actual) | Measured context file size | `$AGENT_FORGE_SINK/…-metrics.jsonl` | `$.context_cost.context_file_bytes` | Byte length of `contexts/<slug>.md` at execution time. The actual Ki prose component. More accurate than the planning-time estimate because it reflects the file as it existed when dispatched. Use to calibrate the `bytes/chars_per_token` ratio per executor type. | High |
| Shared MD bytes (actual) | \|∩(inv)\| (actual bytes) | Measured _shared.md size | `$AGENT_FORGE_SINK/…-metrics.jsonl` | `$.context_cost.shared_md_bytes` | Byte length of `contexts/_shared.md` at execution time. The actual cost of shared invariants per dispatch. Present even in degraded records. | Medium |
| Total input bytes (actual) | Sᵢ+Kᵢ (proxy) | Total bytes sent to executor | `$AGENT_FORGE_SINK/…-metrics.jsonl` | `$.context_cost.total_input_bytes` | Sum of context_file_bytes + shared_md_bytes (+ any additional compiled content). The best available proxy for Sᵢ+Kᵢ when input_tokens_reported is null. | High |
| Input tokens (actual) | Kᵢ (best measure) | Actual LLM input token count | `$AGENT_FORGE_SINK/…-metrics.jsonl` | `$.context_cost.input_tokens_reported` | Actual input tokens from the LLM API response. The **most accurate Ki measurement**. Only populated when the orchestrator passes `--input-tokens`; `null` otherwise (record is then degraded). Currently null in most records — Gap 7 in SCOPE.md. | High |
| Output tokens (actual) | — | Actual LLM output token count | `$AGENT_FORGE_SINK/…-metrics.jsonl` | `$.context_cost.output_tokens_reported` | Actual output tokens. Important for total cost: output tokens are typically 3–5× more expensive per token than input tokens (model-dependent). Null when the orchestrator does not pass `--output-tokens`. | Medium |
| Tool call count | B_tool | Tool invocations per state | `$AGENT_FORGE_SINK/…-metrics.jsonl` | `$.context_cost.tool_call_count` | Number of MCP tool calls made during the state. Tool schema injection is the **dominant B component** — each available (not necessarily invoked) tool adds tokens to the system prompt. Use to calibrate B per executor type and to detect opportunities for tool pruning. | High |
| Wall clock seconds (actual) | tᵢ (actual) | Actual execution duration in seconds | `$AGENT_FORGE_SINK/…-metrics.jsonl` | `$.timing.wall_clock_s` | Actual wall-clock seconds for the state: `done_at − started_at`. The real scheduling cost signal. Use as the weight in HLFET critical-path computation (better than Ki token estimate for scheduling). | High |
| Guard retry count | — | Number of failed guard attempts | `$AGENT_FORGE_SINK/…-metrics.jsonl` | `$.guard.retry_count` | Number of times the guard failed before passing. A quality signal: high retry counts indicate states that were harder than estimated — Ki was underestimated, or W was violated (merged prompt caused instruction following degradation). **Note:** was always null until bug Fix C (METRICS.md §7). | Medium |
| Audit pass rate | — | Fraction of criteria passing | `$AGENT_FORGE_SINK/…-metrics.jsonl` | `$.audit.pass_rate` | `criteria_passed / criteria_total`. Near 1.0 is expected; values < 0.8 indicate semantic errors. Not directly a cost signal, but correlates with executor quality and the need for retry states. | Low |
| Amendment total | — | Rework event count | `$AGENT_FORGE_SINK/…-metrics.jsonl` | `$.amendments.total` | Total amendment events for this state. High counts signal under-specified states (planner-class) or W constraint violations (executor-class: could not complete within the context window). | Medium |
| Amendment by class | — | Planner vs. executor rework split | `$AGENT_FORGE_SINK/…-metrics.jsonl` | `$.amendments.by_class.{executor,planner}` | `executor`: minor fix (the executor noticed something small to correct). `planner`: scope error → state was blocked for replanning. Planner-class > 0 is a strong signal of a poorly scoped state (Ki >> estimated). | Medium |
| Degraded flag | — | Record trust indicator | `$AGENT_FORGE_SINK/…-metrics.jsonl` | `$.degraded` | `true` if any trust precondition failed: no refs, no token telemetry, missing retry count, missing timestamps, or guard not environment-pinned. Degraded records **must not** be used for Ki calibration — they reflect proxy measurements only. | Medium |

---

## Part 6 — Event stream (`events.ndjson`)

Append-only structured event log. The most granular execution-time record.

| Variable name | Mathematical variable | Summary | Relative doc path | JSON path | Description | Importance |
|---|---|---|---|---|---|---|
| Guard retry events | — | Per-retry failure records | `events.ndjson` | `$[?(@.event_type=="guard_retry")]` | Each `guard_retry` event captures the slug, iteration counter, and `detail.guard_command`. More reliable than the metrics `retry_count` field (which was always null before Fix C). Use the event stream to reconstruct actual retry counts for historical Ki calibration. | Medium |
| State start/complete event pair | tᵢ (wall clock) | Timing boundary events | `events.ndjson` | `$[?(@.event_type=="state_start" or @.event_type=="state_complete")].ts` | The `ts` delta between a `state_start` and its matching `state_complete` (same slug) gives wall_clock_s. More reliable than state.json timestamps in degraded records. | Low |
| State blocked events | — | Unsatisfied dependency detections | `events.ndjson` | `$[?(@.event_type=="state_start_blocked")]` | Emitted when a state is dispatched before its `depends_on` are satisfied. Signals an orchestrator scheduling error — the optimizer violated the precedence constraint C5. | Medium |
| DoD confirmed/unconfirmed events | — | Plan-level completion signal | `events.ndjson` | `$[?(@.event_type=="dod_confirmed" or @.event_type=="dod_unconfirmed")]` | Terminal boundary events. `dod_confirmed` = plan succeeded. `dod_unconfirmed` = at least one DoD clause was never proven. **Note:** these were silently dropped before Fix A (METRICS.md §7); present only in plans running skill ≥ the patched version. | Low |

---

## Part 7 — Reference catalog (`references.json`)

Flat slug-keyed object. Each entry is a reference pattern that states cite with `[ref:slug]`.

| Variable name | Mathematical variable | Summary | Relative doc path | JSON path | Description | Importance |
|---|---|---|---|---|---|---|
| Reference entry count | D | Total idiom count for the plan | `references.json` | `Object.keys($).length` | Total number of reference patterns. Per SKILL.md § Cost, per-plan token cost is O(1) in D (patterns are data pointers, not restated prose). The optimizer may use D as a constant added to each state's Ki (each state loads the full references.json regardless of how many it cites). | Low |
| Reference anchor + rule | — | Canonical idiom source + conformance rule | `references.json` | `$.<ref-slug>.{anchor,rule,discovered_via}` | The anchor symbol/file:line and the mechanical conformance rule. `discovered_via`: `gitnexus` \| `manual`. Not a cost variable, but a correctness one — an unresolved reference (no anchor) is a planning gap. | Low |

---

## Part 8 — Plan index (`../plan-index.json`)

Cross-plan registry written by `plan-index.js`. Located one level above the plan dir.

| Variable name | Mathematical variable | Summary | Relative doc path | JSON path | Description | Importance |
|---|---|---|---|---|---|---|
| Plan mutate set | M_plan | All files mutated across all plan states | `../plan-index.json` | `$.plans[<plan>].mutate_set[]` | Union of all `artifacts` across all states in a plan. Used by `cross-plan-check.js` to detect write conflicts between concurrently executing plans. For the dispatch optimizer: provides the full Sᵢ scope at plan granularity without expanding every state's glob patterns individually. | Medium |

---

## Variables the optimizer needs but that are NOT currently in the plan files

These must be added as part of the SCOPE.md implementation.

| Variable name | Mathematical variable | Why it's missing | Where to add it |
|---|---|---|---|
| Base dispatch overhead | B | compile-wave.js does not measure or model the fixed per-dispatch cost (system prompt + tool schema injection). Gap 1 in SCOPE.md. | Calibrate empirically via `scripts/measure-dispatch-overhead.js`; cache in `dispatch-calibration.json`. |
| Expanded file size bytes | \|Sᵢ\| (in bytes) | `artifacts[]` stores glob patterns, not flat files. Byte sizes of the referenced files are never computed. Gap 2 in SCOPE.md. | Expand globs at plan-compile time; write flat file list + byte sizes to `overlap-matrix.json`. |
| Pairwise file overlap | \|Sᵢ ∩ Sⱼ\| | Not computed anywhere. Current deduplication operates on invariant strings and ref slugs, not file content. Gap 2 in SCOPE.md. | Compute N×N integer overlap matrix from expanded file lists; store in `overlap-matrix.json`. |
| Context window limit W | W | No enforcement. Merged prompts can exceed the effective instruction-following cliff. Gap 5 in SCOPE.md. | Hardcode per-model constants; enforce before merging any two states. |
| Cache hit probability | p | Naive simultaneous fan-out → p ≈ 0. Not modeled. Gap 4 in SCOPE.md. | Implement Sentinel-Fanout dispatch; p = (N−1)/N at design time. |
| Effective base overhead with caching | B_eff | Derived from p, w, r — not computed anywhere. | B_eff = B × [(1−p)×w + p×r]; add to `scripts/sentinel-dispatch.js`. |
| Historical Ki actuals (calibrated) | Kᵢ_cal | `tokens_est` / `input_tokens_reported` exist in metrics but are NOT fed back into planning estimates for future plans. Gap 7 in SCOPE.md. | Read prior `metrics-aggregate.jsonl` at plan-compile time; emit calibration coefficients to `dispatch-calibration.json`. |
