# Dispatch Optimizer

Token-cost-aware batch assignment optimizer for plan DAGs. Replaces the
prose-only `reduction_ratio` gate in `compile-wave.js` with a formally-grounded
scheduler that accounts for base dispatch overhead, shared source file bytes,
and prompt-caching architecture.

---

## Is this a waste of time? — LangChain overlap analysis

*Written 2026-06-28. Unverified claims are marked `[unverified: <reason>]`.*

The question is worth answering directly because LangChain (specifically
LangGraph) has real overlap with what this system does.

### What LangGraph actually covers

- Graph-based workflow execution with dependency ordering `[unverified: based on public documentation as of early 2026; feature set may have changed]`
- State persistence and resumability `[unverified: same caveat]`
- Multi-agent coordination and parallel task dispatch `[unverified: same caveat]`
- Human-in-the-loop via `interrupt()` `[unverified: this API exists but its exact semantics for our HITL pattern are unverified]`
- Token tracking via LangSmith `[unverified: LangSmith exists and tracks usage, but whether it tracks at the granularity we need — per-turn, per-op, aggregatable by milestone — is unverified]`

That is real overlap. If the goal is "orchestrate a multi-step agentic
pipeline," LangGraph is more mature and has a larger ecosystem than anything
we would build here. `[unverified: "more mature" and "larger ecosystem" are comparative claims we have not benchmarked]`

### What this system has that LangGraph does not

**Claim 1 — The `dag.json` document model.**
LangGraph graphs are defined in code (Python or JavaScript). `[unverified: LangGraph may support serialised graph definitions or JSON-based graph specs that we are not aware of]` Our DAG is structured *data* — authored in a planning conversation, stored as a versioned file, diffable, human-readable, and executable by a different agent than the one who authored it. This is a deliberate design property (D-01 through D-13 in DECISIONS.md), not a consequence of implementation language.

**Claim 2 — Formal token-cost optimizer.**
LangGraph has no concept of B (base dispatch overhead per model call), Sᵢ
(shared source file bytes across milestone pairs), Kᵢ (per-milestone output
token estimate), or Sentinel-Fanout caching architecture. `[unverified: we have not audited LangGraph's internals or roadmap for cost-optimization features; this claim is based on public-facing documentation and the absence of any mention of batch-assignment optimization in the LangGraph docs we have read]`

It does not compute optimal milestone packing. `[unverified: same caveat]` It
fires tasks. The Tree DP / Simulated Annealing / HLFET algorithm selection
implemented here (SCOPE.md §B2) is grounded in primary literature and addresses
a formally NP-hard problem with polynomial special cases. Whether any existing
orchestration framework implements comparable optimization is unverified.

The savings are concrete and independently sourced:
- Sentinel-Fanout caching: 5.8× cheaper base overhead at N=10 parallel tasks
  (sourced: Anthropic pricing model, arxiv 2601.06007, memory UID
  `01KW50BWG71JE21QNFNT5ESRRZ`)
- Context window degradation: −41.7pp MMLU at 7,500 tokens for merged
  multi-task prompts (sourced: arxiv 2510.05381, memory UID `01KW50ABQ5RK6QCM52AT3Y7698`)
- Tool pruning: 62% cost reduction cited from GitHub Engineering `[unverified: this figure appears in our research notes but we have not read the primary source directly; treat as directionally correct, not a precise benchmark]`

**Claim 3 — The `shape.ops[]` verification contract.**
Each operation carries a structured spec that serves today as (a) prompt
precision for the executing agent and (b) a gitnexus AST verification contract
post-execution, and is reserved as (c) a future machine-execution spec when an
AST executor exists (D-04, D-05 in DECISIONS.md). This pattern is absent from
LangChain. `[unverified: we have not done an exhaustive audit of LangChain's tool/agent spec ecosystem; a plugin or extension providing similar verification may exist]`

### Honest conclusion

**This is not a waste of time, but the value is more specific than it looks.**

The `dag.json` document model, the formal cost optimizer, and the
`shape.ops[]` verification contract are the differentiating pieces. The
execution runtime — running tasks, handling retries, persisting state —
is where LangGraph is stronger. `[unverified: "stronger" is a comparative judgment; LangGraph's retry and state-persistence semantics have not been benchmarked against our requirements]`

The pragmatic architecture is:

```
dag.json  →  snapshot()  →  optimize()  →  DispatchUnit[]
                                                  ↓
                                      LangGraph or agent-mcp
                                       (execution layer)
```

The planning and scheduling layer (everything above the arrow) is novel work.
The execution layer below is not — and should not be built from scratch if
LangGraph covers the requirements.

**The question to answer before continuing:** do LangGraph's state persistence
and human-in-the-loop semantics match the `pending` gate model (D-01, D-08)?
Specifically: can a LangGraph graph be interrupted mid-execution, have a
milestone's `pending` field cleared by an external actor, and resume from
exactly that point without re-running completed nodes? If yes, LangGraph is
the right execution layer. If its resumption model is coarser, the dispatcher
core (the non-LLM orchestration engine in the adhd-build plan) remains
necessary.

---

## What this system does

Given a `dag.json` plan document, the compiler produces two artifacts:

**`snapshot(dag)`** — a fully-derived execution view of the plan:
- Wave assignments (topological sort)
- Per-milestone `eligible`, `status`, `ki_estimate`, `tokens_estimated`
- `pairwise_overlap` matrix (prospective + actual)
- `open_questions[]` derived from all `pending != null` milestones

**`optimize(snapshot)`** — the optimal dispatch plan for the current cycle:
- Partitions eligible milestones by shape.kind family and model tier
- Selects algorithm by DAG structure and N (Bitmask DP / Tree DP / SA / HLFET)
- Packs milestones into `DispatchUnit[]` that minimise total token cost
- Applies Sentinel-Fanout grouping for prompt-cache warm-up
- Each `DispatchUnit` is fully self-contained: compiled prompt, resolved
  provider config, `agent_name`, `resolved_max_tokens`, `background: true`

---

## Files

| File | Purpose |
|---|---|
| `PROPOSED_DAG_STRUCTURE.md` | Complete dag.json + snapshot schema, all fields annotated |
| `DECISIONS.md` | 17 design decisions with rationale and ruled-out alternatives |
| `SCOPE.md` | Cost model, algorithm selection, N1/N2 function specs |
| `LOG.md` | Running session log — steps taken, tests run, learnings |
| `src/dag/types.ts` | TypeScript types for all schema entities |
| `src/dag/io.ts` | `readDag` / `writeDag` / `appendDispatchLog` |
| `src/dag/validate.ts` | Structural validators for dag.json and snapshot |
| `src/compiler.ts` | `snapshot()` and `optimize()` implementations |
| `src/run.ts` | Runner — executes compiler against a dag.json for inspection |
| `run-output.txt` | Output of running against `docs/plan/adhd-build/dag.json` |

---

## Open backlog

See `BACKLOG.md` (repo root) BL-102 through BL-107 for known gaps.
`mcp_servers: null` in every `DispatchUnit` (BL-105) is the highest-priority
blocker — without it the orchestrator cannot create the agent-mcp agent
definition and the dispatch fails end-to-end.
