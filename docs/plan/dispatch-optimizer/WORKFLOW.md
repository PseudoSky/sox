# Planning Workflow

The planning playbook is one approach built on top of the dag.json primitive
language. The planning process is itself a plan — each step is a milestone with
operations that mutate the implementation dag.json into existence. That plan can
be dispatched, retried, and corrected using the same orchestrator as any other.

The system (dag.json) is general-purpose. This playbook is a pattern. Any
other approach — spike-first, test-driven, incremental scope — is equally
expressible using the same primitives.

---

## The Planning Plan

Each playbook step is a milestone. Its operations are mutations to the
implementation dag.json: creating plan-level fields, adding milestone entries,
grounding operations, wiring dependencies. The guard on each planning milestone
verifies the implementation dag.json is in the expected state before proceeding.

```jsonc
// The Planning Plan
// Executor: workflow:plan-builder
// Output artifact: docs/plan/<slug>/dag.json

{
  "schema_version": 4,
  "plan_kind": "greenfield",
  "description": "Author the implementation plan for <goal>",
  "problem": "No dispatchable plan exists for <goal>",
  "approach": "Structured authoring: goal → decompose → ground → resolve unknowns → contracts → dependencies → sequencing → validate",
  "executor": "workflow:plan-builder",
  "executor_model": "Sonnet",
  "executor_effort": "medium",
  "terminal": "plan-ready",
  "phases": ["define", "structure", "refine", "validate"],

  "milestones": {

    // ── STEP 1: Q&A to define goal + demo ────────────────────────────────────
    "goal-defined": {
      "description": "description, problem, approach, terminal, and phases are written into the implementation dag.json",
      "rationale": "All decomposition and grounding steps depend on knowing what done looks like. The terminal milestone is the invariant that guides all other decisions.",
      "authored_by": "workflow:workflow-architect",
      "pending": null,
      "triggered_by": null,
      "phase": "define",
      "depends_on": [],
      "agent": "workflow:plan-builder",
      "model": "Sonnet",
      "effort": "medium",
      "two_stage": false,
      "read_only": [],
      "guard": "node scripts/validate-dag.js --check goal docs/plan/<slug>/dag.json"
    },

    // ── STEP 2: Decompose into subproblems ────────────────────────────────────
    "milestones-decomposed": {
      "description": "milestones{} is populated with one entry per independent unit of work; each has description, rationale, depends_on, and guard",
      "rationale": "Decomposition converts the goal into a DAG of usable outcomes. Each milestone is a node. Guards define verifiable success per node before operations are specified.",
      "authored_by": "workflow:workflow-architect",
      "pending": null,
      "triggered_by": null,
      "phase": "define",
      "depends_on": ["goal-defined"],
      "agent": "workflow:plan-builder",
      "model": "Sonnet",
      "effort": "high",
      "two_stage": false,
      "read_only": [],
      "guard": "node scripts/validate-dag.js --check milestones docs/plan/<slug>/dag.json"
    },

    // ── STEP 3: Ground in current assets ──────────────────────────────────────
    "milestones-grounded": {
      "description": "Every non-resolver milestone has at least one operation with file, symbol, action, provenance, and confidence set",
      "rationale": "Grounding converts subproblem descriptions into file-level change specs. It surfaces what actually needs to change — and what is currently unknown.",
      "authored_by": "workflow:workflow-architect",
      "pending": null,
      "triggered_by": null,
      "phase": "structure",
      "depends_on": ["milestones-decomposed"],
      "agent": "workflow:plan-builder",
      "model": "Sonnet",
      "effort": "high",
      "two_stage": false,
      "read_only": [],
      "guard": "node scripts/validate-dag.js --check grounded docs/plan/<slug>/dag.json"
    },

    // ── STEP 4: Resolve ungrounded subproblems ────────────────────────────────
    "unknowns-identified": {
      "description": "Milestones that cannot be grounded have pending set to the blocking question; resolver milestones (research, discovery) are added as upstream dependencies",
      "rationale": "Ungrounded milestones cannot be dispatched safely. Setting pending blocks the orchestrator until a resolver fills the missing information and triggers a replan.",
      "authored_by": "workflow:workflow-architect",
      "pending": null,
      "triggered_by": null,
      "phase": "structure",
      "depends_on": ["milestones-grounded"],
      "agent": "workflow:plan-builder",
      "model": "Sonnet",
      "effort": "medium",
      "two_stage": false,
      "read_only": [],
      "guard": "node scripts/validate-dag.js --check unknowns docs/plan/<slug>/dag.json"
    },

    // ── STEP 5: Define task contracts ─────────────────────────────────────────
    "contracts-defined": {
      "description": "Every operation on a milestone with pending: null has shape.ops[] describing exact output: field names, types, positions, and required status for each delta",
      "rationale": "Contracts let the orchestrator verify operations without reading code. The executor's prompt is generated from shape.ops[]; imprecise shape = imprecise execution.",
      "authored_by": "workflow:workflow-architect",
      "pending": null,
      "triggered_by": null,
      "phase": "refine",
      "depends_on": ["unknowns-identified"],
      "agent": "workflow:plan-builder",
      "model": "Sonnet",
      "effort": "high",
      "two_stage": false,
      "read_only": [],
      "guard": "node scripts/validate-dag.js --check contracts docs/plan/<slug>/dag.json"
    },

    // ── STEP 6: Wire dependencies and blast radius ────────────────────────────
    "dependencies-wired": {
      "description": "All milestone.depends_on and operation.depends_on edges are set; the DAG is acyclic and every path reaches the terminal",
      "rationale": "Ordering determines which milestones run in parallel, which are gates, and what a failure means downstream. Wrong edges = wrong wave assignments = wasted dispatches.",
      "authored_by": "workflow:workflow-architect",
      "pending": null,
      "triggered_by": null,
      "phase": "refine",
      "depends_on": ["contracts-defined"],
      "agent": "workflow:plan-builder",
      "model": "Sonnet",
      "effort": "medium",
      "two_stage": false,
      "read_only": [],
      "guard": "node scripts/validate-dag.js --check deps docs/plan/<slug>/dag.json"
    },

    // ── STEP 7: Determine sequencing and scope boundaries ─────────────────────
    "sequencing-final": {
      "description": "Every milestone has phase, agent, model, and effort assigned; phases[] ordering reflects intended execution sequence",
      "rationale": "Model and effort drive the token budget the optimizer uses per dispatch. Phase assignment controls wave grouping. Without these, the optimizer cannot pack or cost-estimate.",
      "authored_by": "workflow:workflow-architect",
      "pending": null,
      "triggered_by": null,
      "phase": "refine",
      "depends_on": ["dependencies-wired"],
      "agent": "workflow:plan-builder",
      "model": "Haiku",
      "effort": "low",
      "two_stage": false,
      "read_only": [],
      "guard": "node scripts/validate-dag.js --check sequencing docs/plan/<slug>/dag.json"
    },

    // ── TERMINAL: Plan validated ───────────────────────────────────────────────
    // Steps 8–11 (context derivation, dispatch, verify, correct) are not planning
    // milestones. They are orchestrator behavior, recorded in dispatch_log[] of
    // the implementation dag.json as it executes.
    "plan-ready": {
      "description": "Implementation dag.json passes strict validation: no milestones with pending set that lack resolver upstreams; all operations on milestones with pending: null have shape; all deps wired; DAG acyclic",
      "rationale": "Terminal validation catches inconsistency introduced across authoring steps before dispatching expensive implementation work.",
      "authored_by": "workflow:workflow-architect",
      "pending": null,
      "triggered_by": null,
      "phase": "validate",
      "depends_on": ["sequencing-final"],
      "agent": null,   // guard-only; no executor needed
      "model": null,
      "effort": null,
      "two_stage": false,
      "read_only": [],
      "guard": "node scripts/validate-dag.js --strict docs/plan/<slug>/dag.json"
    }

  },

  "operations": [

    // ── goal-defined ──────────────────────────────────────────────────────────
    {
      "id": "goal-defined.1",
      "milestone": "goal-defined",
      "depends_on": [],
      "action": "create",
      "file": "docs/plan/<slug>/dag.json",
      "symbol": null,
      "authored_by": "workflow:workflow-architect",
      "status": "pending",
      "shape": {
        "kind": "config",
        "ops": [
          { "op": "set-key", "target": "schema_version", "to": "4" },
          { "op": "set-key", "target": "plan_kind",      "to": "brownfield | greenfield" },
          { "op": "set-key", "target": "description",    "to": "<one-line summary>" },
          { "op": "set-key", "target": "problem",        "to": "<what is missing or broken>" },
          { "op": "set-key", "target": "approach",       "to": "<chosen strategy>" },
          { "op": "set-key", "target": "terminal",       "to": "<final milestone slug>" },
          { "op": "set-key", "target": "phases",         "to": "[<ordered phases>]" }
        ]
      },
      "guard": null,
      "ki_estimate": 400,
      "ki_source": "estimate"
    },

    // ── milestones-decomposed ─────────────────────────────────────────────────
    // One add-entry per subproblem. The plan-builder authors N of these during
    // dispatch — the exact count is unknown at planning time. The shape below is
    // the template for each entry.
    {
      "id": "milestones-decomposed.1",
      "milestone": "milestones-decomposed",
      "depends_on": ["goal-defined.1"],
      "action": "modify-body",
      "file": "docs/plan/<slug>/dag.json",
      "symbol": null,
      "authored_by": "workflow:workflow-architect",
      "status": "pending",
      "shape": {
        "kind": "config",
        "ops": [
          { "op": "add-entry", "target": "milestones.<slug>", "to": "{ description, rationale, depends_on, guard, pending: null }" }
        ]
      },
      "guard": null,
      "ki_estimate": 1200,
      "ki_source": "estimate"
    },

    // ── milestones-grounded ───────────────────────────────────────────────────
    {
      "id": "milestones-grounded.1",
      "milestone": "milestones-grounded",
      "depends_on": ["milestones-decomposed.1"],
      "action": "modify-body",
      "file": "docs/plan/<slug>/dag.json",
      "symbol": null,
      "authored_by": "workflow:workflow-architect",
      "status": "pending",
      "shape": {
        "kind": "config",
        "ops": [
          // One add-entry per operation authored. For each subproblem:
          // file, symbol, action, provenance, confidence — but no shape yet.
          { "op": "add-entry", "target": "operations[]", "to": "{ id, milestone, action, file, symbol, provenance, confidence }" }
        ]
      },
      "guard": null,
      "ki_estimate": 1800,
      "ki_source": "estimate"
    },

    // ── unknowns-identified ───────────────────────────────────────────────────
    {
      "id": "unknowns-identified.1",
      "milestone": "unknowns-identified",
      "depends_on": ["milestones-grounded.1"],
      "action": "modify-body",
      "file": "docs/plan/<slug>/dag.json",
      "symbol": null,
      "authored_by": "workflow:workflow-architect",
      "status": "pending",
      "shape": {
        "kind": "config",
        "ops": [
          // For each ungrounded milestone: set pending to the blocking question
          { "op": "update-entry", "target": "milestones.<slug>.pending",   "to": "<blocking question>" },
          // Add a resolver milestone (research / discovery) as upstream dep
          { "op": "add-entry",    "target": "milestones.<resolver-slug>",  "to": "{ description, depends_on: [], agent, guard, pending: null }" },
          { "op": "update-entry", "target": "milestones.<slug>.depends_on","to": "[\"<resolver-slug>\", ...]" }
        ]
      },
      "guard": null,
      "ki_estimate": 600,
      "ki_source": "estimate"
    },

    // ── contracts-defined ─────────────────────────────────────────────────────
    {
      "id": "contracts-defined.1",
      "milestone": "contracts-defined",
      "depends_on": ["unknowns-identified.1"],
      "action": "modify-body",
      "file": "docs/plan/<slug>/dag.json",
      "symbol": null,
      "authored_by": "workflow:workflow-architect",
      "status": "pending",
      "shape": {
        "kind": "config",
        "ops": [
          // For each operation on a milestone with pending: null: fill shape.ops[]
          { "op": "update-entry", "target": "operations[<id>].shape", "to": "{ kind, ops: [{ op, target, to, required }] }" }
        ]
      },
      "guard": null,
      "ki_estimate": 2400,
      "ki_source": "estimate"
    },

    // ── dependencies-wired ────────────────────────────────────────────────────
    {
      "id": "dependencies-wired.1",
      "milestone": "dependencies-wired",
      "depends_on": ["contracts-defined.1"],
      "action": "modify-body",
      "file": "docs/plan/<slug>/dag.json",
      "symbol": null,
      "authored_by": "workflow:workflow-architect",
      "status": "pending",
      "shape": {
        "kind": "config",
        "ops": [
          { "op": "update-entry", "target": "milestones.<slug>.depends_on", "to": "[\"<slug>\", ...]" },
          { "op": "update-entry", "target": "operations[<id>].depends_on",  "to": "[\"<op-id>\", ...]" }
        ]
      },
      "guard": null,
      "ki_estimate": 800,
      "ki_source": "estimate"
    },

    // ── sequencing-final ──────────────────────────────────────────────────────
    {
      "id": "sequencing-final.1",
      "milestone": "sequencing-final",
      "depends_on": ["dependencies-wired.1"],
      "action": "modify-body",
      "file": "docs/plan/<slug>/dag.json",
      "symbol": null,
      "authored_by": "workflow:workflow-architect",
      "status": "pending",
      "shape": {
        "kind": "config",
        "ops": [
          { "op": "update-entry", "target": "milestones.<slug>.phase",  "to": "<phase>" },
          { "op": "update-entry", "target": "milestones.<slug>.agent",  "to": "<executor-agent-slug>" },
          { "op": "update-entry", "target": "milestones.<slug>.model",  "to": "Haiku | Sonnet | Opus" },
          { "op": "update-entry", "target": "milestones.<slug>.effort", "to": "low | medium | high | xhigh | max" }
        ]
      },
      "guard": null,
      "ki_estimate": 600,
      "ki_source": "estimate"
    }

    // plan-ready has no operations — it is a guard-only terminal milestone.
    // The synthesized plan-ready.guard op runs validate-dag.js --strict.

  ],

  "dispatch_log": []
}
```

When the planning plan's `plan-ready` guard passes, the implementation dag.json
exists, is fully specified, and is ready to dispatch. Steps 8–11 of the playbook
(context derivation, dispatch, verify, correct) are orchestrator behavior —
recorded in `dispatch_log[]` of the implementation dag.json as it runs.

---

## Mapping to dag.json Primitives

| Playbook step | Planning milestone | Produces in implementation dag.json |
|---|---|---|
| Define goal + demo | `goal-defined` | `description`, `problem`, `approach`, `terminal`, `phases` |
| Decompose subproblems | `milestones-decomposed` | `milestones{}` — one entry per subproblem; `pending: null` initially |
| Ground in assets | `milestones-grounded` | `operations[]` — `file`, `symbol`, `action`, `provenance`, `confidence` |
| Identify unknowns | `unknowns-identified` | `pending: "<question>"` on ungrounded milestones; resolver milestones added with `depends_on` |
| Define contracts | `contracts-defined` | `operations[].shape.ops[]` — typed deltas per change |
| Wire dependencies | `dependencies-wired` | `milestone.depends_on`, `operation.depends_on` |
| Sequencing + scope | `sequencing-final` | `milestone.phase`, `.agent`, `.model`, `.effort` |
| Context derivation | _(system behavior)_ | `contexts/<slug>.md` generated by orchestrator at dispatch time from dag.json fields |
| Dispatch | _(orchestrator)_ | `dispatch_log[]` entries appended per API call |
| Verify | _(orchestrator)_ | `dispatch_log[].results[].guard_result` |
| Correct | _(orchestrator)_ | Injected milestones with `triggered_by` set to the failing dispatch |

Steps 8–11 are not authored milestones — they are the orchestrator's execution loop.

---

## Example: Add fastembed to memory-server

This walkthrough shows the implementation dag.json — the output of the planning
plan — executing. T0 is the state when the planning plan's `plan-ready` guard
passes. T1–T6 show the orchestrator driving it to completion.

Phases: **research → interface → implementation**

Milestones:
1. `embedding-approach-decided` — research
2. `embed-interface-defined` — interface
3. `recall-signature-updated` — interface
4. `embed-worker-implemented` — implementation
5. `write-path-wired` — implementation
6. `recall-wired` — implementation
7. `bundle-correct` — implementation

---

### T0 — Plan initialized

The planning plan has completed. The research milestone is fully specified.
Interface and implementation milestones exist as stubs — enough structure to
define the graph, but operations are not yet authored because they depend on
research findings not yet available.

```jsonc
// dag.json at T0

{
  "schema_version": 4,
  "plan_kind": "brownfield",
  "description": "Add real vector embeddings to memory-server via fastembed",
  "problem": "memory-server stores zero-vectors; recall is BM25-only with no semantic similarity",
  "approach": "Research model options → define EmbedWorker contract in memory-core → implement FastEmbedWorker → wire write and recall paths → fix native binding bundling",
  "executor": "workflow:plan-orchestrator",
  "terminal": "bundle-correct",
  "phases": ["research", "interface", "implementation"],

  "milestones": {

    // ── FULLY SPECIFIED ───────────────────────────────────────────────────────

    "embedding-approach-decided": {
      "description": "Written record of: chosen model, its dimensionality, cold-start latency, worker thread API shape, and fallback behavior when model is unavailable",
      "rationale": "Interface milestone cannot choose column type or field types without knowing dimensionality. Implementation cannot choose threading model without knowing fastembed's worker constraints. Both milestones blocked on this.",
      "authored_by": "workflow:plan-builder",
      "pending": null,
      "triggered_by": null,
      "phase": "research",
      "depends_on": [],
      "agent": "workflow:workflow-researcher",
      "model": "Sonnet",
      "effort": "high",
      "two_stage": false,
      "read_only": [],
      "guard": "grep -c '^## ' contexts/embedding-research.md | awk '{exit ($1 < 4)}'"
    },

    // ── PROVISIONAL STUBS ─────────────────────────────────────────────────────
    // Enough structure to define the graph. Operations to be filled by replan.

    "embed-interface-defined": {
      "description": "memory-core exports EmbedWorker interface; Episode type includes embedding field; schema has embedding column",
      "rationale": "Separating interface from implementation lets consumers typecheck before FastEmbedWorker exists",
      "authored_by": "workflow:plan-builder",
      "pending": "dimensionality from research (determines Float32Array type and BLOB column size); worker thread API shape (determines EmbedWorker.embed() signature)",
      "triggered_by": null,
      "phase": "interface",
      "depends_on": ["embedding-approach-decided"],
      "agent": null,
      "model": "Sonnet",
      "effort": "medium",
      "two_stage": false,
      "read_only": [],
      "guard": "npx nx typecheck memory-core"
    },

    "recall-signature-updated": {
      "description": "memory_recall MCP tool schema accepts vector_weight and text_weight params",
      "rationale": "Callers can update against the new signature before the implementation exists",
      "authored_by": "workflow:plan-builder",
      "pending": "parameter names and types confirmed from research findings",
      "triggered_by": null,
      "phase": "interface",
      "depends_on": ["embed-interface-defined"],
      "agent": null,
      "model": "Haiku",
      "effort": "low",
      "two_stage": false,
      "read_only": [],
      "guard": "npx nx build memory-server"
    }

    // ... bundle-correct and remaining implementation milestones as stubs
  },

  "operations": [
    // Only the research milestone has operations at T0.
    // Milestones with pending set have no operations yet.
    {
      "id": "embedding-approach-decided.1",
      "milestone": "embedding-approach-decided",
      "depends_on": [],
      "action": "create",
      "file": "contexts/embedding-research.md",
      "symbol": null,
      "authored_by": "workflow:plan-builder",
      "status": "pending",
      "shape": {
        "kind": "doc",
        "ops": [
          { "op": "add-section", "target": "Decision",    "to": null },
          { "op": "add-section", "target": "Model",       "to": null },
          { "op": "add-section", "target": "Performance", "to": null },
          { "op": "add-section", "target": "Fallback",    "to": null }
        ]
      },
      "guard": null,
      "ki_estimate": null,
      "ki_source": null
    }
  ],

  "dispatch_log": []
}
```

**What the planning plan produced at T0:**
- Plan-level goal, problem, approach
- One fully-specified milestone (research) with operations and guard
- N stubs: description, rationale, phase, depends_on, guard — but `pending` set,
  `operations` empty
- A replan milestone does not appear yet — the orchestrator injects it when research completes

---

### T1 — Research dispatched

Orchestrator sees `embedding-approach-decided` is eligible (`pending: null`,
no dependencies). Packs its single operation into a dispatch unit. Appends to
`dispatch_log`.

```jsonc
// DELTA — what changes in dag.json at T1

// operations[id == "embedding-approach-decided.1"]
"status": "in_progress"  // was "pending"

// dispatch_log — new entry appended
"dispatch_log": [
  {
    "id": "d-001",
    "provider": "anthropic",
    "model": "claude-sonnet-4-5",
    "agent": "workflow:workflow-researcher",
    "effort": "high",
    "started_at": "2026-06-27T10:00:00Z",
    "completed_at": null,
    "operations": ["embedding-approach-decided.1"],
    "turns": [],      // populated as turns complete
    "results": [],    // populated when dispatch closes
    "notes": []
  }
]
```

---

### T2 — Research complete; replan triggered

Agent finishes. dispatch_log entry closes with guard result. Orchestrator
evaluates: research milestone complete, downstream milestones have pending set.
Injects a replan milestone.

```jsonc
// DELTA — what changes in dag.json at T2

// operations[id == "embedding-approach-decided.1"]
"status": "complete"

// dispatch_log[id == "d-001"] — closed
"completed_at": "2026-06-27T10:18:00Z",
"turns": [
  { "turn": 1, "input_tokens": 4200, "output_tokens": 1800, "t": "2026-06-27T10:09:00Z" },
  { "turn": 2, "input_tokens": 6100, "output_tokens": 3100, "t": "2026-06-27T10:18:00Z" }
],
"results": [
  {
    "op_id": "embedding-approach-decided.1",
    "status": "complete",
    "guard_result": "pass",
    "guard_output": "4\n",
    "guard_ran_at": "2026-06-27T10:18:15Z"
  }
]

// milestones — new replan milestone injected by orchestrator
"replan-post-research": {
  "description": "Clear pending on all interface and implementation milestones using research findings from contexts/embedding-research.md and author their operations",
  "rationale": "Research produced: model=bge-small-en-v1.5, dimensions=384, worker thread required for non-blocking load, fallback=BM25-only when model unavailable. Milestones with pending can now be fully specified.",
  "authored_by": "orchestrator",
  "pending": null,
  "triggered_by": "d-001",   // the completed research dispatch
  "phase": "research",
  "depends_on": ["embedding-approach-decided"],
  "agent": "workflow:plan-builder",
  "model": "Sonnet",
  "effort": "medium",
  "two_stage": false,
  "read_only": ["contexts/embedding-research.md"],
  "guard": "node scripts/validate-dag.js --no-provisional docs/plan/fastembed/dag.json"
}
```

**What happened:** orchestrator is the author of the injected milestone.
`triggered_by` records the causal link to the research dispatch. The replan
milestone has `read_only: ["contexts/embedding-research.md"]` so the plan-builder
receives the research output in its context.

---

### T3 — Replan complete; pending cleared

Plan-builder reads research output and the current dag.json. Fills in operations
for all stubs. Clears `pending` on each.
Writes updated dag.json. Guard on replan milestone confirms no milestones with
pending remain without resolver upstreams.

```jsonc
// DELTA — what changes in dag.json at T3

// milestones — pending cleared on all stubs
"embed-interface-defined":  { "pending": null }
"recall-signature-updated": { "pending": null }
// ... all remaining milestones similarly

// operations — new entries for milestones 2–7, authored by plan-builder
{
  "id": "embed-interface-defined.1",
  "milestone": "embed-interface-defined",
  "depends_on": [],
  "action": "create",
  "file": "libs/memory-core/src/embed.ts",
  "symbol": "EmbedWorker",
  "authored_by": "workflow:plan-builder",
  "status": "pending",
  "shape": {
    "kind": "interface",
    "ops": [
      { "op": "add-field", "target": "embed",      "to": "(text: string) => Promise<Float32Array>", "required": true },
      { "op": "add-field", "target": "ready",      "to": "() => Promise<void>",                     "required": true },
      { "op": "add-field", "target": "dimensions", "to": "number",                                  "required": true }
    ]
  },
  "guard": null,
  "ki_estimate": 800,
  "ki_source": "estimate"
},
{
  "id": "embed-interface-defined.2",
  "milestone": "embed-interface-defined",
  "depends_on": ["embed-interface-defined.1"],
  "action": "modify-signature",
  "file": "libs/memory-core/src/types.ts",
  "symbol": "Episode",
  "authored_by": "workflow:plan-builder",
  "status": "pending",
  // nullable — migration-safe; existing rows get NULL and fall back to BM25-only
  // recall until re-embedded (identified from research: rolling migration required)
  "shape": {
    "kind": "interface",
    "ops": [
      { "op": "add-field", "target": "embedding", "to": "Float32Array | null", "required": false }
    ]
  },
  "guard": null,
  "ki_estimate": 400,
  "ki_source": "estimate"
}
// ... operations for milestones 3–7
```

---

### T4 — Interface and early implementation execute cleanly

Milestones 2 and 3 complete. Milestone 4 (`embed-worker-implemented`) is
dispatched. This is normal execution — dispatch_log entries appended, statuses
updated, guards pass.

```jsonc
// DELTA — representative of T4 (milestones 2–3 complete, 4 in flight)

// dispatch_log — milestone 4 dispatch open
{
  "id": "d-007",
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "agent": "workflow:plan-orchestrator",
  "effort": "high",
  "started_at": "2026-06-27T11:30:00Z",
  "completed_at": null,
  "operations": ["embed-worker-implemented.1", "embed-worker-implemented.2"],
  "turns": [],
  "results": [],
  "notes": []
}
```

---

### T5 — Implementation guard fails; design flaw discovered

Milestone 4 guard runs after the dispatch closes. It fails: the test reveals
`FastEmbedWorker` needs a `modelId` property to support model switching, but
`EmbedWorker` (defined in milestone 2) does not expose it. This is not an
execution failure — the agent implemented correctly against the interface it
was given. The interface is wrong.

```jsonc
// DELTA — what changes in dag.json at T5

// dispatch_log[id == "d-007"] — closed with failure
"completed_at": "2026-06-27T11:47:00Z",
"turns": [
  { "turn": 1, "input_tokens": 8200, "output_tokens": 4100, "t": "2026-06-27T11:38:00Z" },
  { "turn": 2, "input_tokens": 11300, "output_tokens": 2800, "t": "2026-06-27T11:47:00Z" }
],
"results": [
  {
    "op_id": "embed-worker-implemented.1",
    "status": "complete",
    "guard_result": null,
    "guard_output": null,
    "guard_ran_at": null
  },
  {
    "op_id": "embed-worker-implemented.2",
    "status": "failed",
    "guard_result": "fail",
    "guard_output": "FAIL embed-worker-implemented\n  FastEmbedWorker requires modelId for model switching\n  EmbedWorker interface does not expose modelId\n  1 test failed",
    "guard_ran_at": "2026-06-27T11:47:30Z"
  }
],
"notes": [
  {
    "level": "error",
    "text": "Guard failure indicates upstream interface gap, not implementation error. EmbedWorker missing modelId. Injecting review and correction milestones before retry."
  }
]

// operations[id == "embed-worker-implemented.2"]
"status": "failed"

// milestones — orchestrator injects two new milestones
"review-embed-interface": {
  "description": "Identify the complete set of corrections needed to EmbedWorker given what FastEmbedWorker implementation requires",
  "rationale": "d-007 guard: FastEmbedWorker requires modelId for model switching but EmbedWorker does not expose it. Additional gaps may exist. Review before correction to avoid another incomplete interface.",
  "authored_by": "orchestrator",
  "pending": null,
  "triggered_by": "d-007",
  "phase": "interface",
  "depends_on": ["embed-interface-defined"],
  "agent": "workflow:plan-builder",
  "model": "Sonnet",
  "effort": "medium",
  "two_stage": false,
  "read_only": [
    "libs/memory-core/src/embed.ts",
    "libs/memory-core/src/embedWorker.ts"
  ],
  "guard": "test -f contexts/review-embed-interface.md"
},

"embed-interface-corrected": {
  "description": "EmbedWorker exposes modelId; all gaps identified in review are addressed; Episode schema updated to match",
  "rationale": "Correction of embed-interface-defined based on review-embed-interface findings. Milestone 4 will retry against this corrected interface.",
  "authored_by": "orchestrator",
  "pending": "exact list of corrections from review-embed-interface",
  "triggered_by": "d-007",
  "phase": "interface",
  "depends_on": ["review-embed-interface"],
  "agent": null,
  "model": "Sonnet",
  "effort": "medium",
  "two_stage": false,
  "read_only": [],
  "guard": "npx nx typecheck memory-core"
}
```

---

### T6 — Correction applied; plan resumes

Review runs (produces `contexts/review-embed-interface.md` documenting the gaps).
Plan-builder clears `pending` on `embed-interface-corrected` and authors its operations.
Correction milestone executes — adds `modelId` to `EmbedWorker`, updates
`Episode`. Milestone 4 is re-dispatched and its guard passes.

```jsonc
// DELTA — what changes in dag.json at T6

// embed-interface-corrected: pending cleared by plan-builder
"embed-interface-corrected": {
  "pending": null   // was "exact list of corrections from review-embed-interface"
}

// New operations added for the correction
{
  "id": "embed-interface-corrected.1",
  "milestone": "embed-interface-corrected",
  "depends_on": [],
  "action": "modify-signature",
  "file": "libs/memory-core/src/embed.ts",
  "symbol": "EmbedWorker",
  "authored_by": "workflow:plan-builder",
  "status": "pending",
  // identified by review-embed-interface: FastEmbedWorker needs modelId
  // to support switching between bge-small and bge-large without reinstantiation
  "shape": {
    "kind": "interface",
    "ops": [
      { "op": "add-field", "target": "modelId", "to": "string", "required": true }
    ]
  },
  "guard": null,
  "ki_estimate": 300,
  "ki_source": "estimate"
}

// embed-worker-implemented.2 re-dispatched after correction completes
// dispatch_log — new entry for the retry
{
  "id": "d-011",
  "provider": "anthropic",
  "model": "claude-sonnet-4-5",
  "agent": "workflow:plan-orchestrator",
  "effort": "high",
  "started_at": "2026-06-27T13:10:00Z",
  "completed_at": "2026-06-27T13:28:00Z",
  "operations": ["embed-worker-implemented.2"],
  "turns": [
    { "turn": 1, "input_tokens": 7800, "output_tokens": 3200, "t": "2026-06-27T13:18:00Z" },
    { "turn": 2, "input_tokens": 9100, "output_tokens": 1900, "t": "2026-06-27T13:28:00Z" }
  ],
  "results": [
    {
      "op_id": "embed-worker-implemented.2",
      "status": "complete",
      "guard_result": "pass",
      "guard_output": "PASS embed-worker-implemented\n  2 tests passed",
      "guard_ran_at": "2026-06-27T13:28:45Z"
    }
  ],
  "notes": []
}
```

Execution continues through milestones 5–7. Each adds dispatch_log entries and
updates operation statuses. The plan terminates when `bundle-correct`'s guard
passes and its operation results are all `complete`.

---

## What the Example Shows

**The dag.json is the complete record.** At any point in execution, dag.json
contains: the original intent (milestones, operations authored at T0 and T3),
the full execution history (dispatch_log), and the causal chain of any
corrections (triggered_by linking injected milestones to the failing dispatch).

**The playbook steps map to discrete dag.json mutations:**

| Playbook step | dag.json state after |
|---|---|
| Goal + demo defined | Plan-level fields set; `terminal` points to final milestone |
| Subproblems decomposed | `milestones{}` populated; `pending: null` on resolvers, `pending: "<question>"` on dependents |
| Unknowns identified | `pending` set on ungrounded milestones; resolver milestones added |
| Research dispatched | `dispatch_log` entry opened; op `status: "in_progress"` |
| Research complete | `dispatch_log` entry closed with guard result |
| Replan triggered | New replan milestone injected with `triggered_by` |
| Pending cleared | `operations[]` populated; `pending: null` on all stubs |
| Execution dispatches | `dispatch_log` entries appended per wave |
| Guard failure | `dispatch_log` notes; review + correction milestones injected |
| Correction applied | Correction operations authored; `pending` cleared; retry dispatch added |

**Context is never separately authored.** The orchestrator generates context for
each milestone executor from: `description`, `rationale`, `pending`,
`operations[].shape`, `guard`, `read_only`, and the output artifacts of
upstream milestones in `depends_on`. `contexts/<slug>.md` is a generated
artifact, not a source file.

**No special primitives for planning patterns.** `discover`, `replan`,
`review`, `correct` are not milestone kinds — they are work units with
different `agent`, `guard`, and documentation fields. The pattern is the
playbook; the primitive is the work unit.
