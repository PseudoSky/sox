# Dispatch Optimizer — Running Log

Progress log for the dispatch-optimizer design and implementation work.
Each entry: what was done, what was tested, what was learned.
Append-only. Newest entries at the bottom.

---

## Session 1 — Schema design (2026-06-27)

### What we did

**Started from:** `compile-wave.js` (prior system) which computed a prose-only
`reduction_ratio` that missed base dispatch overhead B and source file bytes Sᵢ.
The gap was recorded in memory (UID `01KW3F0GA02V058ZHDTDPJ4EEB`).

**Research phase:** 9 research agents, 576K tokens, topic
`multi-agent-dispatch-optimization`. Produced UIDs now indexed in SCOPE.md
§Research Memory Index. Key findings:
- The problem is formally NP-hard (APX-hard) but forest/series-parallel DAGs —
  the expected common case — admit an exact polynomial Tree DP (O(N²·W)).
- Three objectives (minimize B, Sᵢ, Kᵢ) collapse to one objective + one
  feasibility constraint. No multi-objective solver needed.
- Sentinel-Fanout caching (Anthropic) makes it cheaper to *split* small tasks
  than merge them — the opposite of the uncached heuristic.
- Context window degradation in merged multi-task prompts is steep: −41.7pp
  MMLU at 7,500 tokens for Claude Sonnet. Effective W is ~50% of nominal.

**Schema design:** authored `PROPOSED_DAG_STRUCTURE.md` and `DECISIONS.md`
through multiple iterations. Key decisions reached:

| Decision | What we settled on |
|---|---|
| D-01 | `pending` is the sole dispatch gate (no `finalized` field) |
| D-02 | Planning IS a dispatch (kind: "planning" in dispatch_log) |
| D-03 | Two op types: `tool-call` and `generative` (not 3) |
| D-04 | `shape` is executor-agnostic; `type` is the executor selector |
| D-05 | `shape.ops[]` serves 3 roles: prompt precision + gitnexus verification + future AST execution |
| D-06 | `shape.kind` extended with `doc` and `structured-output` |
| D-07 | `eligible` requires `pending == null` AND all deps complete AND no dep failed |
| D-08 | `pending-surfaced` as intermediate milestone status (deps done, pending != null) |
| D-09 | `pairwise_overlap` computed in two passes: prospective (op.file targets) + actual (artifact bytes) |
| D-10 | `open_questions[]` is a first-class snapshot field |
| D-11 | `dispatch_units[].milestones` is plural (optimizer can pack) |
| D-12 | Guard-only milestones (agent: null + no ops) = zero-cost class |
| D-13 | dag-mutation actions are `tool-call` operations |

**SCOPE.md:** complete rewrite to reflect schema progress. Added §Terminology
Mapping (old compile-wave.js terms → new schema equivalents), and §Next:
Implementation with full specs for `snapshot()` and `optimize()`.

### What we tested

Nothing runnable yet — schema + algorithm design only.

### Learnings

- The "3 types" proposal (generative-structured / generative-unstructured /
  tool-call) was correctly compressed to 2. Structured/unstructured is a
  property of `shape`, not a top-level type discriminant.
- The `doc` and `structured-output` shape kinds were missing from the initial
  design. Without them, `compilePrompt()` couldn't be deterministic from dag
  fields alone — it would need agent-type-specific knowledge at compile time.
- Code kinds cannot be `tool-call` today (AST inference while planning is an
  unknown). The validator must reject `type: "tool-call"` on code kinds until
  an AST executor is registered. `shape.ops[]` still serves present-day value
  as (1) prompt precision and (2) gitnexus verification contract.

---

## Session 2 — Provider integration audit (2026-06-27)

### What we did

Read `/Users/nix/dev/node/adhd/packages/ai/agent-mcp/README.md` (741 lines)
in full. Identified gaps between the DispatchUnit spec and what agent-mcp
actually needs to fire a dispatch.

**Gaps found:**
- `provider` block missing — agent-mcp needs real provider config (type,
  model_id, env_secret, base_url, timeout_ms, retry_config), not a tier name.
- `agent_name` missing — agent-mcp uses a named agent definition, not a raw
  model call. The tier abstraction (`"Sonnet"`) must resolve to a real agent.
- `resolved_max_tokens` missing — per-effort-tier token limit for the provider.
- `background: true` — always required for parallel dispatch.
- `remote_task_id` — agent-mcp returns a task_id on submission; distinct from
  our dispatch_log UUID. Needed to poll `result`.
- `result` — the agent's final answer on task completion.

**Added to the schema:**
- `providers` block in dag.json mapping Haiku/Sonnet/Opus → full provider config
- `effort_max_tokens` block: `{ low:1024, medium:4096, high:8192, xhigh:16384, max:32768 }`
- Rewrote `dispatch_units` section of PROPOSED_DAG_STRUCTURE.md — DispatchUnit
  is now fully self-contained (orchestrator reads it and fires without touching
  any other file)

**Added decisions D-14–D-17:**

| Decision | What we settled on |
|---|---|
| D-14 | External sequencing — never use agent-mcp `depends_on`; our wave scheduler owns sequencing |
| D-15 | Ephemeral tasks (`agent_name`, not `session_id`) — one-shot per unit |
| D-16 | `effort_max_tokens` maps effort tier → provider `maxTokens`; lives in dag.json |
| D-17 | `providers` resolution; `env_secret` is an env var NAME not a key value; `claudecli` env_secret is null |

### What we tested

Nothing runnable yet.

### Learnings

- agent-mcp's `depends_on` feature for DAG fan-in looks tempting but would
  create a second sequencing channel that could diverge from the snapshot's
  wave assignment. Decision: never use it. Our `eligible` flag owns sequencing.
- `env_secret` is a name, not a value — the env var name (e.g.
  `ADHD_AGENT_ANTHROPIC_SECRET`) is stored in the dag; the orchestrator reads
  `process.env[env_secret]` at dispatch time. Storing actual keys in dag.json
  would be a security bug.

---

## Session 3 — TypeScript implementation (2026-06-28)

### What we did

Dispatched a `typescript-pro` agent to implement the full compiler pipeline.

**Files created (3,132 lines):**
- `src/dag/types.ts` (660 lines) — complete type system, discriminated `Shape`
  union, `WRITE_CLASS_ACTIONS` set, all dag/snapshot/dispatch types
- `src/dag/io.ts` (114 lines) — `readDag` / `writeDag` / `appendDispatchLog`,
  atomic writes via temp-file + rename
- `src/dag/validate.ts` (325 lines) — `validateDagJson` + `validateSnapshot`,
  D-07 invariant enforcement
- `src/compiler.ts` (2,033 lines) — `snapshot()` and `optimize()` with all
  four algorithm implementations (Bitmask DP, Tree DP, Simulated Annealing,
  HLFET) plus Sentinel-Fanout grouping

**Notable design decision the agent had to make:** `optimize()` takes
`DagSnapshot` but needs `dag.providers` and `dag.effort_max_tokens` to
assemble self-contained DispatchUnits. A `snapshotWithDag()` convenience
wrapper attaches these as `_`-prefixed fields on the snapshot via an
intersection type, preserving the function signature from SCOPE.md §N2.

**7 stubs documented inline** (see BL-105): `blast_radius`, `from/breaking/severity`,
`conflict`, `attempt_count`, `tokens_actual` per-op, `mcp_servers`,
`raised_at_dispatch/raised_at_turn`.

### What we tested

Nothing yet — implementation complete but not run.

### Learnings

- Having a fully specified SCOPE.md §N1/N2 with ordered computation steps and
  exact field derivation rules let the implementation agent produce correct
  code on the first pass with no back-and-forth. The spec investment paid off.
- The 4 algorithm implementations (Bitmask DP / Tree DP / SA / HLFET) needed
  explicit algorithm selection logic. The agent correctly implemented partition
  by `"${family}:${model}"` — milestones of same kind family but different
  model tiers never share a dispatch unit.

---

## Session 4 — First run against test dag (2026-06-28)

### What we did

Created `src/run.ts` and ran the compiler against
`docs/plan/adhd-build/dag.json` (the adhd-build plan, 13 milestones, 15
operations, 1 dispatch log entry).

**The adhd-build dag predates three schema additions:**
1. Operation `type` field (→ BL-101)
2. `providers` block
3. `effort_max_tokens` block
4. `optimization.b_per_tier`, `context_window_per_tier`, `sentinel_fanout`

Applied backward-compat patches in `run.ts` before calling `snapshotWithDag()`.

### What the output showed

```
Milestones: 13 | Wave 0: 2 | Wave 1: 4 | Wave 2: 2 | Wave 3: 2 | Wave 4: 2 | Wave 5: 1
Eligible (wave 0): dag-schema, scope-authored
Open questions: 5 (all surfaced=false — upstream deps not yet complete)
Dispatch units: 2
  [prewarm] dag-schema.dispatch.0    model=Sonnet tokens_est=6425 fits=true
  [payload] scope-authored.dispatch.1 model=null   tokens_est=null fits=true
```

### Bug found and fixed

**BL-101:** `normalizeOperations()` returned the raw array without defaulting
missing `type` fields. Every op had `op.type === undefined`, so `compilePrompt()`
saw `milestoneOps.some(op => op.type === "generative") === false` for every
milestone and returned `null`.

**Fix:** `normalizeOperations()` now maps ops with `type === undefined` to
`{ ...op, type: "generative" }`. One-line fix, applied to the right chokepoint
— all consumers get normalized ops automatically.

### Learnings

- D-07 is working correctly: only the 2 wave-0 milestones with `pending == null`
  and no unmet deps are eligible. The other 11 correctly show `eligible=false`.
- D-08 is working: 5 open questions are all `surfaced=false` because their
  blocking milestones have incomplete upstream deps (can't surface until the
  blocker is actually reachable).
- Sentinel-Fanout correctly designated `dag-schema` (6,425 tokens) as `prewarm`
  and `scope-authored` as `payload`.
- `scope-authored.dispatch.1` has `model=null`, `provider.type=undefined`,
  `agent_name=""` — this is correct data for a guard-only milestone (D-12),
  but the orchestrator has no typed signal to distinguish it from a broken
  provider config. → BL-102.
- The backward-compat patches in `run.ts` are a smell — they should live in
  `readDag()`. → BL-107.

---

## Session 5 — Full prompt inspection + live Haiku dispatch (2026-06-28)

### What we did

**Inspected the compiled prompt for `dag-schema.dispatch.0`** — verified it is
fully deterministic from dag fields:
- Milestone description + rationale as context
- 7 ops rendered as structured `action symbol → type` instruction lists
- Guard command at the bottom

**Copied the compiled prompt to a real dispatch:** copied `dag-schema` context
to `/tmp/adhd-build-dag-schema/` and dispatched a Haiku model agent with the
prompt verbatim, instructing it to write output to that tmp directory.

### What the Haiku agent produced (531 lines, 3 files)

| File | Lines | Notes |
|---|---|---|
| `src/dag/types.ts` | 260 | All fields present; DFS cycle detection correct; 4 invariants enforced |
| `src/dag/io.ts` | 102 | readDag/writeDag/appendDispatch; parent dir creation |
| `src/dag/validate.ts` | 171 | Clean validation engine |

**The dispatch worked** — the agent produced valid, compilable TypeScript with
correct structure from the compiled prompt alone, with no other context.

### Two semantic gaps surfaced (→ BL-104)

1. **`OperationShape`** — the op spec said `add-field "shape" → OperationShape | null`
   without describing `OperationShape`'s internals. The agent generated a simple
   enum `("read-only" | "write" | "transform" | ...)` instead of the rich
   polymorphic shape object `{ kind, ops[], description, objective, schema }`.

2. **`DispatchEntry`** — op spec said `add-field "dispatch_log" → DispatchEntry[]`
   without drilling into entry sub-fields. Agent generated a minimal
   `{ milestone, timestamp, dispatched_by, model, effort, notes }` instead of
   the full `{ id, kind, milestone_slugs[], turns[], results[], started_at, ... }`.

### Learnings

- **The prompt IS self-sufficient for well-specified ops.** Every op where the
  target type was a primitive or a named enum produced exactly the right output.
  The gaps only occurred where the target type was itself a complex interface
  that wasn't described in any op spec.
- **The fix is in authoring, not the compiler.** `compilePrompt()` can only
  inline what's in the dag. Op specs for complex-typed fields need a
  `type_spec: { field: type }[]` sub-block, or a recursive op that describes
  the interface's own fields. → BL-104.
- **Haiku is viable for code-generation milestones from well-specified prompts.**
  42K tokens, 14 tool uses, 154 seconds. The cost delta from Sonnet is real and
  worthwhile for ops where the spec is complete.
- **The meta-circularity held:** the adhd-build plan's `dag-schema` milestone
  describes creating `types.ts`, `io.ts`, `validate.ts` — exactly what the
  dispatch-optimizer compiler itself implements. Running the compiled prompt
  through a Haiku agent produced a structurally similar (though independently
  authored) second implementation of the same contracts.

---

## Outstanding (open BL items as of 2026-06-28)

| BL | Severity | Summary |
|---|---|---|
| BL-101 | ~~Fixed~~ | `normalizeOperations()` no `type` default |
| BL-102 | MEDIUM | Guard-only milestones: no `execution_mode` signal in DispatchUnit |
| BL-103 | LOW | `snapshot_version` always 1 — no increment mechanism |
| BL-104 | MEDIUM | `compilePrompt()` doesn't inline nested interface sub-shapes |
| BL-105 | MEDIUM (mcp_servers HIGH) | 7 stubs in compiler.ts — `mcp_servers` blocks real dispatch |
| BL-106 | LOW | `b_per_tier` cold-start not seeded → `tokens_estimated: null` on fresh plans |
| BL-107 | LOW | Backward-compat patches in `run.ts` should be in `readDag()` |
