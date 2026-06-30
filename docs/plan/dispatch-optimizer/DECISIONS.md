# Dispatch Optimizer — Design Decisions

Semantic decisions established during design sessions. Each entry records what
was decided, why, and what it rules out. Ordered by session date.

---

## D-01 — `pending` is the sole dispatch gate

**Decision:** A milestone's `pending` field is the only authored gate controlling
whether the orchestrator may dispatch it. `pending: null` = ready.
`pending: "<question>"` = blocked until a replan clears it.

**Ruled out:** A separate `finalized: boolean` field. Having two fields
(`status: provisional|final` and `finalized`) created a collision with the
derived execution `status` field. `pending` carries the same information with
no collision — a milestone is always mutable until its guard passes.

---

## D-02 — Planning is a dispatch

**Decision:** The planning conversation that produces a dag.json is itself a
dispatch and belongs in `dispatch_log[]` as `kind: "planning"`. Every Q&A turn
is a turn entry. Unanswered questions are warn notes. Operations produced during
planning are dag mutations, not codebase mutations.

**Implication:** `dispatch_log[].kind` is required. Without it, planning and
execution costs are indistinguishable and the full history of how a dag was
authored is lost.

---

## D-03 — Two operation types: `tool-call` and `generative`

**Decision:** Every operation has `type: "tool-call" | "generative"`.

`tool-call`: dispatcher executes deterministically with no model call. Covers
guards, file system operations, dag mutations (add-milestone, clear-pending,
append-dispatch-log, set-field), and scaffold commands. `ki_estimate` is
always 0.

`generative`: requires a model call. `shape` defines the content spec, prompt
assembly rule, ki estimation formula, and verification contract.

**Ruled out:** Three types (tool-call, generative-structured, generative-
unstructured). The structured/unstructured distinction is a property of `shape`,
not a top-level type. Collapsing to two types keeps the discriminator clean.

---

## D-04 — `shape` is executor-agnostic; `type` is the executor selector

**Decision:** `shape` is authored once and never changes based on who or what
executes the operation. `type` is what changes when execution capability
improves.

**Concrete implication for code kinds:** Today, `type: "generative"` on a code
kind means a model reads `shape.ops[]` as structured instructions and makes the
change. When an AST executor is registered in the future, `type` flips to
`"tool-call"` — `shape.ops[]` becomes machine input without any re-authoring.

`type: "tool-call"` on code kinds is **reserved/future** and the validator must
reject it until an AST executor is registered.

---

## D-05 — `shape.ops[]` serves three roles for code kinds

**Decision:** For `shape.kind ∈ {function, interface, type, class, enum, const, script}`,
`ops[]` is simultaneously:

1. **Prompt precision** (today): model receives a structured instruction rather
   than prose, producing more reliable structural changes.
2. **gitnexus verification contract** (today): after a generative model makes a
   change, the resulting AST is checked against the authored `ops[]` spec. This
   is the guard for code operations.
3. **Future machine execution spec** (future): same data, `type` flips to
   `"tool-call"` when an AST executor exists.

The data structure is not premature — roles 1 and 2 are present-day value.

---

## D-06 — `shape.kind` extended with `doc` and `structured-output`

**Decision:** Two new shape kinds added to cover non-code generative operations.

`doc`: freeform document. Shape requires `description` (task body),
`objective` (success criterion), and `required_sections[]` (guard grep
targets). `ki_estimate` derived from effort-tier heuristic:
`low→600, medium→1000, high→2000` tokens. Both `description` and `objective`
are required when `kind == "doc"`.

`structured-output`: schema-enforced model output. Shape requires `schema`
(JSON Schema). Dispatcher uses tool-use or constrained-decoding prompt. Model
retries automatically on schema mismatch. `ki_estimate` derived from schema
field count × ~50 tokens per field.

**Effect on prompt compilation:** The dispatcher can now assemble a complete,
deterministic prompt for any generative operation from dag fields alone — no
external prompt template, no agent-type-specific knowledge required at compile
time.

---

## D-07 — `eligible` requires `pending == null`

**Decision:** The correct eligibility rule is:

```
eligible = (pending == null)
         AND all depends_on milestones have status == "complete"
         AND no depends_on milestone has status == "failed"
```

**Bug fixed:** The prior rule only checked for failed deps. A milestone with all
deps complete but `pending != null` would have incorrectly appeared eligible,
causing the orchestrator to attempt dispatch on a blocked milestone.

---

## D-08 — `pending-surfaced` as an intermediate milestone status

**Decision:** A milestone that has all deps complete but `pending != null`
enters status `"pending-surfaced"`. This is distinct from `"pending"` (deps
still incomplete).

**Why it matters:** `pending-surfaced` is the signal for the CLI to surface the
blocking question to the user. The question isn't actionable until deps resolve —
surfacing it earlier wastes user attention. The orchestrator does not dispatch
a `pending-surfaced` milestone; it only surfaces the question.

---

## D-09 — `pairwise_overlap` has two passes

**Decision:** pairwise_overlap is computed in two passes:

**Prospective** (pre-execution): intersection of `op.file` targets across
milestone pairs — computable from dag.json alone before any artifacts exist.
Byte value is 0 (files don't exist yet), but key presence signals shared-
context opportunity to the optimizer on a fresh plan.

**Actual** (post-execution): `sum(bytesize(f))` for the intersection of
completed milestone artifacts — replaces prospective once both milestones
complete.

**Why it matters:** Without prospective overlap, the optimizer has no context-
sharing signal on a fresh plan (all artifacts are empty). The optimizer reads
key presence for packing decisions; byte values for context-window budgeting.

---

## D-10 — `open_questions[]` is a first-class snapshot field

**Decision:** The snapshot carries a top-level `open_questions[]` array derived
from all milestones where `pending != null`. The CLI and orchestrator read this
directly rather than scanning every `milestone.pending` individually.

Fields: `id`, `text`, `blocking` (milestone slug), `surfaced` (boolean — true
when blocking milestone is `pending-surfaced`), `raised_at_dispatch`,
`raised_at_turn`, `answered`, `answer`.

---

## D-11 — `dispatch_units[].milestones` is plural

**Decision:** A dispatch unit may pack multiple milestones when they are same-
wave, same-model, same-agent, and share `read_only[]` context. Field renamed
from `milestone: "<slug>"` to `milestones: ["<slug>"]`.

**Constraint:** The optimizer must not pack milestones of different `shape.kind`
families into one unit — `doc` and `structured-output` dispatch to different
prompt modes and cannot share a context window cleanly.

---

## D-12 — Guard-only milestones are a named class

**Decision:** When a milestone has `agent == null` AND no authored operations,
it is a **guard-only** milestone. The orchestrator runs the guard as a local
`tool-call` and marks complete on pass. Zero model tokens consumed.

**Use cases:** Scope-document existence gates (verify GOAL.md and DEMO.md
exist before any research fires), pre-condition checks, and work completed
outside the plan's dispatch cycle (human-authored artifacts). These milestones
block downstream work at zero cost and need no dispatch unit.

---

## D-13 — dag-mutation actions are `tool-call` operations

**Decision:** Planning and replan dispatches produce dag mutations. These are
`type: "tool-call"` operations with dag-specific `action` values:
`dag.add-milestone`, `dag.set-field`, `dag.clear-pending`,
`dag.append-dispatch-log`.

**Implication:** The dag itself is a first-class mutation target, not just a
state store. Planning dispatches author code-targeted operations AND dag-
targeted operations in the same dispatch log.

---

## D-14 — External sequencing; do not use agent-mcp `depends_on`

**Decision:** Wave scheduling is handled entirely by the snapshot's `eligible`
flag. The orchestrator fires a dispatch unit when `eligible == true` for all
its milestones. agent-mcp's `depends_on` task parameter is never populated.

**Ruled out:** Wiring agent-mcp `depends_on` to encode DAG edges. Doing so would
create a second sequencing channel that could diverge from the snapshot's wave
assignment — two sources of truth for the same constraint. Our wave algorithm
owns sequencing; agent-mcp sees only independent, ready-to-fire tasks.

---

## D-15 — Ephemeral tasks; `agent_name` not `session_id`

**Decision:** Every dispatch unit fires as an ephemeral agent-mcp task using
`agent_name`. Stateful sessions (`session_id`) are not used.

**Rationale:** Plan milestones are independent work units. Each dispatch unit
carries a self-contained, pre-compiled `prompt` with all context inlined. There
is no need for conversational continuity across dispatch units — each fires fresh.
Ephemeral tasks also simplify cleanup: no session lifecycle to manage.

**Implication:** The dispatcher must ensure the named agent exists in agent-mcp
before calling `task` (create with `provider` + `resolved_max_tokens` + system
prompt from the agent catalog if absent; idempotent on re-create).

---

## D-16 — `effort_max_tokens` maps effort tier → provider maxTokens

**Decision:** The `effort_max_tokens` block in dag.json controls how many output
tokens the provider is allowed to generate per turn, keyed by effort tier:

| tier   | max_tokens |
|--------|-----------|
| low    | 1 024     |
| medium | 4 096     |
| high   | 8 192     |
| xhigh  | 16 384    |
| max    | 32 768    |

`DispatchUnit.resolved_max_tokens` is the resolved value for the unit's effort
tier. It is passed to agent-mcp as `provider.maxTokens` in the agent definition.

**Ruled out:** Hardcoding max_tokens in the orchestrator. Keeping it in dag.json
lets the plan author tune token limits per-plan without touching orchestrator code.

---

## D-17 — `providers` block maps tier → full provider config; DispatchUnit is self-contained

**Decision:** dag.json carries a `providers` block mapping tier names (Haiku,
Sonnet, Opus) to complete provider configs: `type`, `model_id`, `env_secret`,
`base_url`, `timeout_ms`, `retry_config`. This config is copied verbatim into
`DispatchUnit.provider` at optimize() time.

**Key field: `env_secret`** is the name of an `ADHD_AGENT_*_SECRET` environment
variable — never the key value itself. The orchestrator reads
`process.env[env_secret]` at dispatch time and passes the value to agent-mcp.

**Goal:** A `DispatchUnit` is fully self-contained. The dispatcher reads the unit,
creates the agent-mcp agent definition from `provider` + `agent_name` +
`resolved_max_tokens`, fires the task with `prompt` and `background: true`, and
stores `remote_task_id`. No other files or config needed.

**`claudecli` provider:** `env_secret` is null — agent-mcp uses the local
`claude` CLI with credentials from the shell environment. No API key required.

---

## D-18 — Third operation type: `automated` (locally-run orchestrator actions)

**Decision:** `type` gains a third discriminant: `"automated"`. These operations
run in-process in the orchestrator — no MCP tool call, no model call. They are
the orchestrator's own machinery made visible as first-class operations.

**Type routing:**

| `type` | Execution location | Token cost | Examples |
|---|---|---|---|
| `generative` | Agent via LLM (agent-mcp `task`) | Model call tokens | Code creation, doc writing, structured output |
| `tool-call` | External MCP server (dispatcher routes to a named tool) | 0 (no model call) | `dag.milestone_add`, `dag.pending_clear`, gitnexus queries via `@adhd/dispatch-tools` |
| `automated` | Orchestrator process itself | 0 | Shell command execution, dag injection, polling barriers |

**`automated` actions:**

| Action | Authored by | When | What the orchestrator does |
|---|---|---|---|
| `exec` | Plan-builder | Planning time (guard commands) | Spawn shell command, capture exit code + output, record in dispatch_log. Guard commands are `type: "automated" action: "exec"`. |
| `dag.inject` | Orchestrator | Runtime (guard failure or replan trigger) | Create a new milestone from a template, set `triggered_by` to the current dispatch UUID, wire `depends_on` edges. The injected milestone's ops are themselves `type: "generative"` or `type: "tool-call"` — `automated` is only the injection act. |
| `dag.wait` | Plan-builder | Planning time (explicit barrier) | Poll a condition (N deps complete, wave threshold, wall-clock timeout) with configurable timeout. Blocks the orchestrator's cycle until satisfied. |

**Not `automated` (orchestrator loop internals):**
These happen between dispatches and are not operation types — they're the
orchestrator's implicit machinery: `snapshot()`, `optimize()`, `validate()`,
`dispatch_log_append`. They are always the same sequence and never vary per plan.
Making them operations would be ceremony without benefit.

**Effect on D-03:** D-03 defined two types (`tool-call` and `generative`).
D-18 adds `automated` as a third. The structured/unstructured distinction remains
a property of `shape`, not a top-level type discriminant (per D-03 rationale).

**Effect on D-12:** Guard-only milestones (`agent == null`, no authored ops)
now have an explicit synthesized operation: `{ type: "automated", action: "exec",
command: milestone.guard }`. The orchestrator no longer treats guards as a special
path — it just routes `automated` operations.

**Effect on D-13:** D-13 says dag-mutation actions are `tool-call` operations.
`dag.inject` is `type: "automated"` because it runs in-process — the orchestrator
mutates the dag it owns. The MCP tools (`@adhd/dispatch-tools`) handle
agent-triggered mutations (`milestone_add`, `pending_clear`, etc.) which remain
`type: "tool-call"` — external tool calls routed to the MCP server.

### Dispatch records for `automated` operations

Every automated operation produces a `dispatch_log` entry. The entry fields
differ by action:

**`exec` (shell command):**
```jsonc
{
  "id": "<dispatch-uuid>",
  "kind": "execution",
  "provider": "local",
  "model": null,
  "agent": null,
  "effort": null,
  "started_at": "<ISO>",
  "completed_at": "<ISO>",
  "operations": ["<milestone>.guard"],
  "turns": [],
  "results": [
    {
      "op_id": "<milestone>.guard",
      "status": "complete",         // command ran to completion
      "guard_result": "pass",       // exit code 0 → pass; non-zero → fail
      "guard_output": "<stdout+stderr, 8 KB cap>",
      "guard_ran_at": "<ISO>"
    }
  ],
  "notes": [
    { "level": "info", "text": "guard command: npx nx build dispatch-spec" }
  ]
}
```
`kind: "execution"` (the dispatch is execution-phase work), `provider: "local"`
(no external API), `turns: []` (no model call). The `guard_result` captures what
was previously the special `kind: "guard"` path.

**`dag.inject` (milestone creation by orchestrator):**
```jsonc
{
  "id": "<dispatch-uuid>",
  "kind": "execution",
  "provider": "local",
  "model": null,
  "agent": null,
  "effort": null,
  "started_at": "<ISO>",
  "completed_at": "<ISO>",
  "operations": ["<triggering-milestone>.inject.0"],
  "turns": [],
  "results": [
    {
      "op_id": "<triggering-milestone>.inject.0",
      "status": "complete",
      "guard_result": null,
      "guard_output": null,
      "guard_ran_at": null
    }
  ],
  "notes": [
    { "level": "info", "text": "injected milestone review-embed-interface (triggered_by: d-007)" }
  ]
}
```
The injected milestone's `triggered_by` field references this dispatch's `id`.
The injected milestone's own operations are `generative` or `tool-call` — they
fire in a subsequent dispatch cycle.

**`dag.wait` (barrier):**
```jsonc
{
  "id": "<dispatch-uuid>",
  "kind": "execution",
  "provider": "local",
  "model": null,
  "agent": null,
  "effort": null,
  "started_at": "<ISO when wait began>",
  "completed_at": "<ISO when condition met | null if timeout>",
  "operations": ["<milestone>.wait.0"],
  "turns": [],
  "results": [
    {
      "op_id": "<milestone>.wait.0",
      "status": "complete",                 // condition met
      "guard_result": null,
      "guard_output": null,
      "guard_ran_at": null
    }
    // or on timeout:
    // { "op_id": "...", "status": "failed", "guard_result": null, ... }
  ],
  "notes": [
    { "level": "info", "text": "waited 23.4s for 3 deps to reach complete (3/3 satisfied)" }
  ]
}
```

**Effect on `kind` enum:** The existing `guard`, `replan`, and `correction`
dispatch kinds are superseded by `type: "automated"` operations within
`kind: "execution"` dispatches. The `kind` field now describes the *phase* of
the plan (planning vs execution) rather than the execution mechanism. The
mechanism is `operation.type`.

---

## Open / deferred

- **AST executor registration mechanism**: how the system knows a `tool-call`
  executor is available for a given code kind. Deferred until capability exists.
- **ki_estimate bootstrap**: seed default values per tier for a fresh plan
  with no calibration data. Currently `tokens_estimated` is always null on
  a new plan.
- **Corrections as structured objects**: corrections (human-triggered dag
  mutations) currently use `kind: "correction"` in dispatch_log. A structured
  `corrections[]` field with back-references to the dispatch that triggered each
  correction is deferred.
- **turn semantics in dispatch_log**: `turns[]` captures token counts but not
  semantic content (which question was raised at which turn). Full Q&A turn
  logging is deferred to the planning session log file rather than dag.json.
