## dag.json — authored intent + execution log

The persistent document. Authored intent fields are set at plan-creation
time and do not change. The orchestrator appends to `dispatch_log[]` as the
plan runs, and updates `status` on each operation after each dispatch closes.
No separate state.json exists.

```jsonc
{
  "schema_version": 4,
  "plan_kind": "brownfield | greenfield",

  // Self-documentation — makes dag.json readable without any external file
  "description": "<one-line summary of what this plan achieves>",
  "problem": "<what condition or gap this plan addresses>",
  "approach": "<chosen strategy; how the plan gets from current state to goal>",

  "executor": "<agent-slug>",
  "executor_model": "Haiku | Sonnet | Opus",
  "executor_effort": "low | medium | high | xhigh | max",
  "phases": ["<phase-name>"],
  "terminal": "<milestone-slug>",
  "assumed_baseline": ["<plan-name>"],

  "optimization": {
    "sentinel_fanout": {
      "enabled": true,
      "write_multiplier": 1.25,
      "read_multiplier": 0.1,
      "hit_probability": 0.9
    },
    "b_per_tier": {
      "Haiku": "<tokens: integer | null>",
      "Sonnet": "<tokens: integer | null>",
      "Opus": "<tokens: integer | null>"
    },
    "context_window_per_tier": {
      "Haiku": "<tokens: integer | null>",
      "Sonnet": "<tokens: integer | null>",
      "Opus": "<tokens: integer | null>"
    },
    "context_window_override": null,
    "b_override": null
  },

  // Provider resolution table — maps tier names to real provider configs.
  // Authored once per plan; lets a plan run on Anthropic, OpenAI, or a local
  // server without changing milestone-level model/effort fields.
  // The compiler resolves dispatch_unit.provider from this table at optimize()
  // time using milestone.model as the key.
  //
  // type: which agent-mcp provider to use:
  //   "anthropic"  — Anthropic API (sk-ant-api… or OAuth sk-ant-oat…)
  //   "openai"     — OpenAI or any OpenAI-compatible server (LM Studio, Ollama)
  //   "claudecli"  — local `claude` CLI subprocess; no API key needed
  //
  // env_secret: name of the ADHD_AGENT_*-prefixed env var holding the key.
  //   Never the key itself. null for claudecli (uses claude auth).
  // base_url: null = provider default. Set for OpenAI-compatible local servers.
  // timeout_ms: per-dispatch timeout; drives agent-mcp provider.timeoutMs.
  //   Must fit within Sentinel-Fanout TTL (Anthropic: 300s).
  "providers": {
    "Haiku": {
      "type": "anthropic | openai | claudecli",
      "model_id": "<real model id — e.g. claude-haiku-4-5 | gpt-4o-mini>",
      "env_secret": "<ADHD_AGENT_*_SECRET env var name | null>",
      "base_url": "<override URL | null>",
      "timeout_ms": 60000,
      "retry_config": {
        "retries": 3,
        "min_timeout": 1000,
        "max_timeout": 30000,
        "factor": 2
      }
    },
    "Sonnet": {
      "type": "anthropic | openai | claudecli",
      "model_id": "<real model id — e.g. claude-sonnet-4-5 | gpt-4o>",
      "env_secret": "<ADHD_AGENT_*_SECRET env var name | null>",
      "base_url": "<override URL | null>",
      "timeout_ms": 120000,
      "retry_config": {
        "retries": 3,
        "min_timeout": 1000,
        "max_timeout": 30000,
        "factor": 2
      }
    },
    "Opus": {
      "type": "anthropic | openai | claudecli",
      "model_id": "<real model id — e.g. claude-opus-4-5>",
      "env_secret": "<ADHD_AGENT_*_SECRET env var name | null>",
      "base_url": "<override URL | null>",
      "timeout_ms": 300000,
      "retry_config": {
        "retries": 2,
        "min_timeout": 2000,
        "max_timeout": 60000,
        "factor": 2
      }
    }
  },

  // Effort → max_tokens resolution table.
  // Authored per plan to allow tuning. Compiler resolves
  // dispatch_unit.resolved_max_tokens from milestone.effort using this table.
  "effort_max_tokens": {
    "low":    1024,
    "medium": 4096,
    "high":   8192,
    "xhigh":  16384,
    "max":    32768
  },

  "milestones": {
    "<slug>": {
      // What is true when this milestone is complete — plain language.
      // Must be understandable without reading any external file.
      "description": "<what a human would say is done>",

      // Why this milestone exists and why it is structured this way.
      // Captures design reasoning, not execution detail.
      "rationale": "<design reasoning>",

      // Who specified this milestone. git commit covers when.
      "authored_by": "<agent-slug | human>",

      // Dispatch gate: null = ready to dispatch; non-null = blocked.
      // A replan step clears this once the answer is known.
      // The orchestrator never dispatches a milestone where pending != null.
      "pending": "<blocking question | null>",

      // If this milestone was injected mid-execution (not authored upfront),
      // which dispatch_log entry caused the injection.
      "triggered_by": "<dispatch-uuid | null>",

      // Sequencing
      "phase": "<phase-name>",
      "depends_on": ["<slug>"],

      // Execution — agent overrides plan-level executor when set
      "agent": "<executor-agent-slug | null>",
      "model": "Haiku | Sonnet | Opus | null",
      "effort": "low | medium | high | xhigh | max | null",
      "two_stage": false,
      "read_only": ["<file-path>"],

      // Verification — how to confirm the milestone's goal was achieved.
      // Guard-only milestone: when agent == null and no operations are authored
      // for this milestone, the orchestrator runs the guard as a local tool-call
      // and marks complete on pass. Zero model tokens consumed. Use for scope-
      // document existence gates, pre-condition checks, and work completed
      // outside the plan's dispatch cycle (e.g. human-authored artifacts).
      "guard": "<pinned-command | null>"
    }
  },

  "operations": [
    {
      "id": "<milestone-slug>.<n>",
      "milestone": "<slug>",
      "depends_on": ["<op-id>"],
      // Execution mode — which executor the orchestrator routes this to.
      //
      // automated:   runs in-process in the orchestrator itself. No model call,
      //              no MCP call. For shell commands (guard verification),
      //              milestone injection (dag.inject), and barrier polling
      //              (dag.wait). provider: "local", turns: [], ki_estimate: 0.
      //
      // tool-call:   dispatcher routes to an external executor — an MCP server
      //              tool. No model call. For dag mutations (milestone_add,
      //              pending_clear), file system ops, and scaffold commands.
      //
      // generative:  model call required via agent-mcp. shape defines the
      //              content spec, prompt assembly rule, ki estimation formula,
      //              and verification contract.
      //
      // tool-call on code kinds (function|interface|type|...) is RESERVED/FUTURE:
      //   the AST executor does not yet exist. All code kinds are generative today.
      //   When an AST executor is registered, type flips to tool-call without
      //   re-authoring shape — the shape is executor-agnostic by design.
      "type": "automated | tool-call | generative",

      // Semantic label for what this operation does.
      // automated actions:
      //   guard  — shell command that proves milestone completion (exit 0 = pass)
      //   exec   — arbitrary shell command (non-guard)
      //   dag.inject — create a new milestone from template (orchestrator-authored)
      //   dag.wait  — poll a condition (dep threshold, wave threshold) with timeout
      // generative actions:
      //   create | delete | move | rename | modify-signature | modify-body |
      //   add-export | remove-export
      // tool-call actions:
      //   dag.add-milestone | dag.set-field | dag.clear-pending |
      //   dag.append-dispatch-log | fs.move | fs.delete | fs.scaffold
      "action": "create | delete | move | rename | modify-signature | modify-body | add-export | remove-export | guard | exec | dag.add-milestone | dag.set-field | dag.clear-pending | dag.append-dispatch-log | dag.inject | dag.wait | fs.move | fs.delete | fs.scaffold",

      "file": "<file-path | null>",
      "symbol": "<exported-symbol | null>",
      "provenance": "gitnexus | manual | assumed | vendored | null",
      "confidence": "verified | vendored | documented | assumed | null",
      "audit_check": "<criterion-id | null>",
      "criteria": ["<criterion-id>"],

      // tool-call only: which tool to invoke and with what arguments.
      // null for type: "generative".
      "tool": "<tool-id | null>",
      "args": "<object | null>",

      // generative only: content spec, prompt assembly rule, ki estimation
      // formula, and post-execution verification contract.
      // null for type: "tool-call".
      //
      // shape.kind discriminates the content type. Three families:
      //
      // CODE kinds: function | interface | type | class | enum | const | script
      //   ops[] is the structural mutation spec. Serves as:
      //   (a) prompt precision — model receives structured instruction not prose
      //   (b) gitnexus verification — resulting AST checked against authored ops[]
      //   (c) future machine execution — same data, type flips "tool-call"
      //       when AST executor is registered; shape never needs re-authoring
      //   ki_estimate: derived from ops[] complexity via gitnexus
      //
      // CONFIG kinds: config | env | schema | manifest
      //   ops[] for structural mutations (set-key, add-entry, etc.)
      //   ki_estimate: derived from ops[] complexity
      //
      // DOC kind: doc
      //   description + objective + required_sections[] is the full content spec.
      //   Dispatcher compiles: description → task body, objective → success
      //   criterion, required_sections[] → guard grep targets.
      //   description and objective are REQUIRED when kind == "doc".
      //   ki_estimate: effort-tier heuristic (low→600, medium→1000, high→2000)
      //
      // STRUCTURED-OUTPUT kind: structured-output
      //   schema{} is the content spec. Dispatcher uses tool-use or constrained-
      //   decoding prompt. Output parsed against schema; model retries on mismatch.
      //   ki_estimate: schema field count × ~50 tokens per field
      "shape": {

        "kind": "function | interface | type | class | enum | const | script | config | env | schema | manifest | doc | structured-output",

        // CODE and CONFIG kinds: structural mutation spec.
        // null for kind: "doc" and kind: "structured-output".
        "ops": [
          {
            "op": "add-param | remove-param | rename-param | retype-param | change-param-optional | reorder-params | change-return | add-field | remove-field | rename-field | retype-field | change-field-optional | add-generic | remove-generic | constrain-generic | add-extends | remove-extends | set-key | remove-key | rename-key | add-array-item | remove-array-item | add-var | remove-var | rename-var | change-default | add-section | remove-section | rename-section | update-section | add-table | remove-table | add-column | remove-column | rename-column | retype-column | change-nullable | add-index | remove-index | add-entry | remove-entry | update-entry | bump-version | update-checksum",
            "target": "<param-name | field-name | generic-name | key-path | section-heading | var-name | table.column | null>",
            "to": "<type-string | value | name | null>",
            "position": "<integer | null>",
            "required": "<boolean | null>"
          }
        ],

        // DOC kind only: freeform document content spec.
        // description and objective are required when kind == "doc".
        // null for all other kinds.
        "description": "<what the document must contain | null>",
        "objective": "<what done looks like from a reader's perspective | null>",
        "required_sections": ["<## Section heading | null>"],

        // STRUCTURED-OUTPUT kind only: JSON Schema the model output must
        // conform to. Dispatcher uses tool-use or constrained-decoding prompt.
        // null for all other kinds.
        "schema": "<JSON Schema object | null>"

      },

      "to_file": "<file-path | null>",
      "to_symbol": "<symbol | null>",
      "guard": "<pinned-command | null>",

      // Expected output tokens for this operation.
      // Derivation rule depends on shape.kind:
      //   code/config kinds: derived from ops[] complexity via gitnexus
      //   doc: effort-tier heuristic (low→600, medium→1000, high→2000)
      //   structured-output: schema field count × ~50 tokens per field
      //   tool-call (type: "tool-call"): always 0
      "ki_estimate": "<integer | null>",
      "ki_source": "estimate | calibrated | actual | null",

      // ── authorship ────────────────────────────────────────────────────────────
      // Who wrote this operation into the plan. dag.json is committed to git,
      // so the timestamp is the commit — no authored_at field needed.
      "authored_by": "<agent-slug | human>",

      // ── execution state ───────────────────────────────────────────────────────
      // Fast-path status written by the orchestrator after each dispatch closes.
      // Allows topological sort and wave-packing without scanning dispatch_log.
      // Source of truth is dispatch_log[].results — this is a derived cache.
      "status": "pending | in_progress | complete | failed | skipped"
    }
  ],

  // ── dispatch log ──────────────────────────────────────────────────────────────
  // Ordered, append-only ledger of every dispatch the orchestrator has fired.
  // One record per API call (or per local guard execution). Never removed.
  // 1-N operations are packed into each dispatch; per-op outcomes live in results[].
  "dispatch_log": [
    {
      // Stable id generated by the orchestrator at dispatch time.
      // Referenced by snapshot dispatch_units[].dispatch_log_id.
      "id": "<dispatch-uuid>",

      // Dispatch kind — distinguishes the nature of the work in this entry.
      // planning:   produces milestone/operation structures for a new or updated dag;
      //             the dispatch itself IS authorship (turns produce dag mutations)
      // execution:  runs one or more operations against the codebase or filesystem
      // guard:      local-only guard verification; provider is always "local"
      // replan:     triggered by a guard failure; patches dag to correct course
      // correction: triggered by human observation; patches dag structure
      "kind": "planning | execution | guard | replan | correction",

      // Execution context — who ran this call and how.
      // provider:"local" for guard-only dispatches (no model call).
      "provider": "anthropic | openai | deepseek | google | local",
      "model": "<model-id | null>",     // null when provider == "local"
      "agent": "<executor-agent-slug>",
      "effort": "low | medium | high | xhigh | max | null",  // null when provider == "local"

      // Wall-clock window of this dispatch (API call or local execution).
      "started_at": "<ISO timestamp>",
      "completed_at": "<ISO timestamp | null>",   // null while in flight

      // Operations packed into this dispatch, in execution order.
      // Includes synthesized guard ops (action == "guard") when the
      // dispatching mechanism runs the guard as part of closing this dispatch.
      "operations": ["<op-id>"],

      // Per-turn token accounting — one entry per model invocation within
      // this dispatch (tool-call loops each produce a new turn).
      // Empty array for provider:"local" dispatches (no model call).
      // Sum of input_tokens + output_tokens across all turns = total billed.
      "turns": [
        {
          "turn": 1,                        // 1-indexed
          "input_tokens": "<integer>",
          "output_tokens": "<integer>",
          "t": "<ISO timestamp>"            // when this turn completed
        }
      ],

      // Per-operation outcome, written when the dispatch closes.
      // One entry per op-id in operations[]. For guard ops, guard_result
      // and guard_output capture the command exit and output; for non-guard
      // ops they are null.
      "results": [
        {
          "op_id": "<op-id>",
          "status": "complete | failed | skipped",
          "guard_result": "pass | fail | null",
          "guard_output": "<string | null>",    // stdout+stderr, 8 KB cap
          "guard_ran_at": "<ISO timestamp | null>"
        }
      ],

      // Orchestrator annotations — freeform observations appended during or
      // after the dispatch (e.g. unexpected output, partial completion,
      // retry rationale). Not a status field; status is computable from results[].
      "notes": [
        { "level": "info | warn | error", "text": "<string>" }
      ]
    }
  ]
}
```

---

## dag-snapshot.json — fully compiled execution view

Regenerated after every scheduling cycle. Never checked in as source. Every
field is annotated with its generation source. dag.json is now the single
persistent document — it holds both authored intent and the execution log.
No separate state.json exists.

Generation sources:
- `dag` — copied verbatim from dag.json authored fields
- `dispatch_log` — read from dag.json dispatch_log[]; the execution ledger
- `derived:<rule>` — computed deterministically from other snapshot fields
- `gitnexus:<call>` — output of a specific gitnexus tool call
- `scheduler` — assigned by topological sort + wave-packing algorithm
- `optimizer` — created by dispatch optimizer when building dispatch units
- `clock` — system timestamp at snapshot regen time

```jsonc
{
  // clock — ISO timestamp of this regen pass
  "snapshot_at": "<ISO timestamp>",

  // derived: incremented integer, persisted across regens
  "snapshot_version": "<integer>",

  // dag — plan slug (directory name)
  "plan": "<plan-slug>",

  // dag
  "schema_version": 4,
  // dag
  "plan_kind": "brownfield | greenfield",
  // dag
  "description": "<one-line summary>",
  // dag
  "problem": "<what condition or gap this plan addresses>",
  // dag
  "approach": "<chosen strategy>",
  // dag
  "executor": "<agent-slug>",
  // dag
  "executor_model": "Haiku | Sonnet | Opus",
  // dag
  "executor_effort": "low | medium | high | xhigh | max",
  // dag
  "phases": ["<phase-name>"],
  // dag
  "terminal": "<milestone-slug>",
  // dag
  "assumed_baseline": ["<plan-name>"],

  "optimization": {
    // dag
    "sentinel_fanout": {
      "enabled": true,
      "write_multiplier": 1.25,
      "read_multiplier": 0.1,
      "hit_probability": 0.9
    },
    // dag
    "context_window_override": null,
    // dag
    "b_override": null,

    "b_per_tier": {
      // dag — authored; null until calibration updates dag.json directly;
      // updated in place by the calibration pass after observed execution data
      "Haiku": "<tokens: integer | null>",
      "Sonnet": "<tokens: integer | null>",
      "Opus": "<tokens: integer | null>"
    },
    "b_eff_per_tier": {
      // derived: b_per_tier[tier] × ((1 - hit_probability) × write_multiplier
      //          + hit_probability × read_multiplier)
      // null when b_per_tier[tier] is null
      "Haiku": "<tokens: integer | null>",
      "Sonnet": "<tokens: integer | null>",
      "Opus": "<tokens: integer | null>"
    },
    "context_window_per_tier": {
      // dag — authored; set by plan-builder from known model specs at authoring
      // time; context_window_override in dag.json supersedes all tiers if set
      "Haiku": "<tokens: integer | null>",
      "Sonnet": "<tokens: integer | null>",
      "Opus": "<tokens: integer | null>"
    }
  },

  // Two passes, across all ordered pairs (i, j) where i ≠ j:
  //
  // prospective (pre-execution): intersection of op.file targets in milestone_i
  //   and milestone_j — computable from dag.json alone before any artifacts
  //   exist; byte value is 0 (files not yet on disk) but the key presence signals
  //   shared-context opportunity to the optimizer on a fresh plan.
  //
  // actual (post-execution): sum(bytesize(f) for f in artifacts(i) ∩ artifacts(j))
  //   from filesystem stat pass; replaces prospective once both milestones complete.
  //
  // The optimizer reads key presence for packing decisions and byte values for
  // context-window budget calculations.
  "pairwise_overlap": {
    "<slug-i>": {
      "<slug-j>": "<bytes: integer>"
    }
  },

  // ─── MILESTONES ──────────────────────────────────────────────────────────
  // Self-documenting work units (dag.json fields) augmented with derived
  // execution state. Each milestone is: authored intent (description, rationale,
  // authored_by, pending, triggered_by, agent, model, effort, depends_on,
  // guard, two_stage, read_only) + derived scheduling and progress fields.
  // The guard command is synthesized as a guard op (id: <slug>.guard)
  // that depends on all other ops in the milestone; its results entry in
  // dispatch_log[] proves the milestone complete.

  "milestones": {
    "<slug>": {

      // dag
      "description": "<plain language outcome>",
      // dag
      "rationale": "<design reasoning>",
      // dag
      "authored_by": "<agent-slug | human>",
      // dag — dispatch gate: null = eligible; non-null = blocked on this question
      "pending": "<blocking question | null>",
      // dag — null when authored upfront
      "triggered_by": "<dispatch-uuid | null>",
      // dag
      "phase": "<phase-name>",
      // dag
      "depends_on": ["<slug>"],
      // dag — null inherits plan-level executor
      "agent": "<executor-agent-slug | null>",
      // dag
      "model": "Haiku | Sonnet | Opus | null",
      // dag
      "effort": "low | medium | high | xhigh | max | null",
      // dag
      "two_stage": false,
      // dag
      "read_only": ["<file-path>"],
      // dag
      "guard": "<pinned-command | null>",

      // derived: path where the orchestrator writes the generated context
      // document for this milestone's executor; assembled from description,
      // rationale, pending, operations[].shape, guard, read_only, and the
      // output of any upstream milestone this one depends on
      "context": "contexts/<slug>.md",

      // scheduler — wave number assigned by topological sort of milestone
      // depends_on graph; updated each scheduling cycle
      "wave": "<integer>",

      // derived: true iff ALL of the following hold:
      //   (1) pending == null  — no blocking question on this milestone
      //   (2) all depends_on milestones have status == "complete"
      //   (3) no depends_on milestone has status == "failed"
      // A milestone where pending != null is NEVER eligible even if all deps
      // are complete. pending is a hard gate independent of dep graph state.
      "eligible": "<boolean>",

      // derived:
      //   complete:         guard op status == complete AND guard_result == pass
      //   failed:           any op in milestone has status:failed
      //   in_progress:      any op is in_progress
      //   pending-surfaced: eligible == false AND pending != null AND all
      //                     depends_on milestones are complete — deps resolved
      //                     but blocked on a question. CLI surfaces the question
      //                     at this point; orchestrator does not dispatch.
      //   pending:          all other cases (deps incomplete, or pending == null
      //                     but no ops dispatched yet)
      //   skipped:          explicitly skipped by orchestrator
      "status": "pending | pending-surfaced | in_progress | complete | failed | skipped",

      // derived: min(dispatch_log[id].started_at) across all dispatch_log
      // entries in any op's dispatch_ids where op.milestone == this slug;
      // null if no dispatches have fired for this milestone yet
      "started_at": "<ISO timestamp | null>",

      // derived: guard_ran_at from the results entry for the "<slug>.guard"
      // op in the dispatch_log entry where that op's result.status == "complete"
      // and guard_result == "pass"; null until the guard passes
      "completed_at": "<ISO timestamp | null>",

      // derived: results entry for the "<slug>.guard" op in its latest
      // dispatch_log entry; "pending" = guard op has no dispatch yet
      // (distinct from null = this milestone has no guard command configured)
      "guard_result": "pass | fail | pending | null",

      // derived: guard_output from the same results entry;
      // null when the guard has not yet run or no guard is configured
      "guard_output": "<string | null>",

      // derived: union of op.file for ops in this milestone where action ∈
      // {create, modify-signature, modify-body, add-export, remove-export,
      // rename} plus to_file for action == move
      "artifacts": ["<file-path>"],

      // derived: sum(bytesize(f) for f in artifacts) — filesystem stat pass
      "si_bytes": "<integer>",

      // derived: sum(ki_estimate for all ops in this milestone, excluding
      // the synthesized guard op); null if no ops have estimates yet
      "ki_estimate": "<integer | null>",

      // derived: b_eff_per_tier[resolved_model] + si_bytes_as_tokens
      // + ki_estimate; null if any input is null
      "tokens_estimated": "<integer | null>",

      // derived: collect the unique set of dispatch_log ids across all op
      // dispatch_ids where op.milestone == this slug; for each such dispatch
      // where all results[].status are complete, sum
      // turns[].input_tokens + turns[].output_tokens; sum across unique
      // dispatch entries (each API call counted once regardless of how many
      // milestone ops it contained); null if no completed dispatches exist
      "tokens_actual": "<integer | null>"

    }
  },

  // ─── OPERATIONS ──────────────────────────────────────────────────────────
  // Atomic change records. Includes both authored operations from dag.json
  // and one synthesized guard operation per milestone (id: <slug>.guard).
  //
  // Synthesized guard operation shape:
  //   id:         "<slug>.guard"
  //   milestone:  "<slug>"
  //   depends_on: [<all other op ids in the milestone>]
  //   type:       "automated"
  //   action:     "guard"
  //   guard:      <milestone.guard command>
  //   (all other fields: null)
  //
  // The synthesized guard op is the sole source of milestone completion truth.
  // It is type: "automated" — the orchestrator runs it in-process, records
  // the exit code + output in dispatch_log, and marks the milestone complete
  // on exit 0. No model call, no MCP call. provider: "local", turns: [].
  //
  // It has no shape, no blast_radius, no conflict block — only state fields.

  "operations": [
    {

      // dag (or "synthesized" for guard ops)
      "id": "<milestone-slug>.<n>",
      // dag
      "milestone": "<slug>",
      // dag
      "depends_on": ["<op-id>"],
      // dag — see DECISIONS.md D-18 for type routing
      "type": "automated | tool-call | generative",
      // dag
      "action": "create | delete | move | rename | modify-signature | modify-body | add-export | remove-export | guard | exec | dag.add-milestone | dag.set-field | dag.clear-pending | dag.append-dispatch-log | dag.inject | dag.wait | fs.move | fs.delete | fs.scaffold",
      // dag — null for synthesized guard ops and tool-call ops with no file target
      "file": "<file-path | null>",
      // dag
      "symbol": "<exported-symbol | null>",
      // dag
      "provenance": "gitnexus | manual | assumed | vendored | null",
      // dag
      "confidence": "verified | vendored | documented | assumed | null",
      // dag
      "audit_check": "<criterion-id | null>",
      // dag
      "criteria": ["<criterion-id>"],
      // dag — tool-call only; null for generative
      "tool": "<tool-id | null>",
      // dag — tool-call only; null for generative
      "args": "<object | null>",
      // dag
      "guard": "<pinned-command | null>",
      // dag
      "to_file": "<file-path | null>",
      // dag
      "to_symbol": "<symbol | null>",
      // dag
      "ki_estimate": "<integer | null>",
      // dag
      "ki_source": "estimate | calibrated | actual | null",

      "shape": {
        // dag — may be inferred from file extension if absent in dag.json:
        // .ts/.tsx → code kind from AST; .json/.yaml/.toml → config;
        // .md/.rst → doc; .env → env; .sql → schema; extension.json → manifest
        // null for type: "tool-call"
        "kind": "function | interface | type | class | enum | const | script | config | env | schema | manifest | doc | structured-output | null",

        // CODE and CONFIG kinds only: structural mutation spec.
        // For code kinds, ops[] serves as prompt precision (generative today),
        // gitnexus verification contract (always), and future AST machine
        // execution spec (when tool-call executor is registered).
        // null for kind: "doc" and kind: "structured-output".
        "ops": [
          {
            // dag
            "op": "<operation>",
            // dag
            "target": "<named element | null>",
            // dag
            "to": "<type-string | value | name | null>",
            // dag
            "position": "<integer | null>",
            // dag
            "required": "<boolean | null>",

            // derived: topo-walk over completed operations — find the last
            // completed op on the same (file, symbol); use its shape.ops[].to
            // as the current baseline. If no prior op, read from TypeScript AST
            // (ts-morph) or config file at HEAD
            "from": "<type-string | value | name | null>",

            // derived: deterministic lookup table on (op, required, from→to).
            // Never authored. Rules: add-param{required:true}→true,
            // add-param{required:false}→false, remove-param→true,
            // rename-*→true, retype-* narrowing→true, retype-* widening→false,
            // change-return→true, reorder-params→true, add-field{required:false}→false,
            // remove-*→true, remove-var→true, add-var{required:true,no-default}→true,
            // rename-column→true, remove-column→true, add-column{nullable}→false
            "breaking": "<boolean>",

            // derived: same pass as breaking.
            // error = breaking + no safe mitigation path;
            // warning = breaking but sequenceable or consumer-update-only;
            // info = non-breaking
            "severity": "error | warning | info"
          }
        ],

        // DOC kind only: freeform document content spec.
        // Required when kind == "doc". null for all other kinds.
        // description → task body in compiled prompt
        // objective → success criterion in compiled prompt
        // required_sections[] → guard grep targets
        "description": "<what the document must contain | null>",
        "objective": "<what done looks like from a reader's perspective | null>",
        "required_sections": ["<## Section heading | null>"],

        // STRUCTURED-OUTPUT kind only.
        // null for all other kinds.
        "schema": "<JSON Schema object | null>"

      },

      // gitnexus:gitnexus_impact({target:symbol, file, direction:"upstream"})
      // for consumer:"current" entries.
      // derived: cross-op scan — find ops in any milestone with action ∈
      // {create, add-export} whose new symbol references this (file, symbol);
      // those become consumer:"future" entries.
      // Re-run on every snapshot regen: future→current as creator ops complete.
      "blast_radius": [
        {
          "file": "<file-path>",
          "symbol": "<function | class | method | variable>",
          "impact": "implements | calls | imports | extends | re-exports | overrides",
          "consumer": "current | future"
        }
      ],

      // scheduler — populated during wave-candidate analysis.
      // op_key = target::op-category (e.g. "options::param-by-name")
      // resolution derived from breaking + severity of both ops:
      //   same op + same to → safe-merge (deduplicate)
      //   orthogonal op-categories → safe-merge
      //   same op-category + different to → error
      //   one breaking + one non-breaking, same target → warning
      "conflict": {
        "detected": "<boolean>",
        "competing_op": "<op-id | null>",
        "op_key": "<target::op-category | null>",
        "resolution": "safe-merge | warning | error | null"
      },

      // dag — fast-path status; orchestrator writes after each dispatch closes
      "status": "pending | in_progress | complete | failed | skipped",

      // derived: ids of all dispatch_log entries whose operations[] includes
      // this op id, ordered by started_at; the full execution history of
      // this op is the union of results[] entries across these dispatches
      "dispatch_ids": ["<dispatch-uuid>"],

      // derived: count(dispatch_ids); > 1 indicates retries
      "attempt_count": "<integer>",

      // derived: results entry for this op in the latest dispatch_log entry
      // in dispatch_ids where results[op_id == this op].guard_result is
      // non-null; null if no guard has run yet for this op
      "guard_result": "pass | fail | null",
      // derived: guard_output from the same results entry
      "guard_output": "<string | null>",
      // derived: guard_ran_at from the same results entry
      "guard_ran_at": "<ISO timestamp | null>",

      // derived: for each dispatch in dispatch_ids where all results[].status
      // are complete, compute that dispatch's token total as
      // sum(turns[].input_tokens + turns[].output_tokens) × (op.ki_estimate /
      // sum(ki_estimate for ops in that dispatch)); sum across all such dispatches;
      // null if ki_estimate is null for any op in any relevant dispatch
      "tokens_actual": "<integer | null>"

    }
  ],

  // ─── DISPATCH UNITS ──────────────────────────────────────────────────────
  // Optimizer output only. Each unit is one concrete agent-mcp task invocation.
  // Contains everything needed to fire the task without reading any other file.
  // Created fresh each scheduling cycle by optimize(). Never authored.
  //
  // Dispatch flow (non-LLM dispatcher):
  //   1. Read dispatch_unit — all fields pre-resolved, prompt pre-compiled
  //   2. Ensure agent definition exists in agent-mcp (create if absent)
  //   3. Call agent-mcp `task` tool: { agent_name, prompt, background: true }
  //   4. Store returned remote_task_id; poll `result` until terminal status
  //   5. Write dispatch_log entry; update operation statuses; re-run snapshot()
  //
  // Sequencing: the dispatcher fires a unit when its milestones are eligible
  // (snapshot.milestones[slug].eligible == true). agent-mcp `depends_on` is
  // NOT used — sequencing is handled externally by the wave scheduler.
  // Tasks are always ephemeral (agent_name, not session_id) — one-shot per unit.

  "dispatch_units": [
    {

      // optimizer — generated id
      "id": "<milestone-slug>.dispatch.<n>",

      // optimizer — milestones packed into this unit. Usually one. May be
      // multiple when the optimizer packs same-wave, same-model, same-agent
      // milestones with shared context into one context window.
      "milestones": ["<slug>"],

      // optimizer — op ids packed into this unit, respecting op-level depends_on
      // and fitting within context_window_per_tier[model]
      "operations": ["<op-id>"],

      // ── Provider / agent resolution ───────────────────────────────────────
      // Resolved at optimize() time from dag.providers[milestone.model].
      // Everything the dispatcher needs to create the agent-mcp agent definition
      // and fire the task — no further dag reads required.

      // optimizer — resolved from dag.providers[milestone.model].
      // type drives which agent-mcp provider block to use.
      // model_id is the real provider model string (not the tier abstraction).
      "provider": {
        "type": "anthropic | openai | claudecli",
        "model_id": "<real model id — e.g. claude-sonnet-4-5>",
        "env_secret": "<ADHD_AGENT_*_SECRET env var name | null>",
        "base_url": "<override URL | null>",
        "timeout_ms": "<integer>",
        "retry_config": {
          "retries": "<integer>",
          "min_timeout": "<integer>",
          "max_timeout": "<integer>",
          "factor": "<integer>"
        }
      },

      // optimizer — agent-mcp agent name to use for this dispatch.
      // Resolved from milestone.agent slug (e.g. "workflow:workflow-researcher"
      // → "workflow-researcher"). The dispatcher creates the agent definition in
      // agent-mcp if it does not already exist, using provider above +
      // the agent catalog's systemPrompt + mcpServers + permissions.
      "agent_name": "<agent-mcp agent name>",

      // optimizer — MCP servers the agent needs for this dispatch.
      // Resolved from the agent catalog definition for milestone.agent.
      // Passed to agent-mcp agent_create if the agent doesn't exist yet.
      // Format matches agent-mcp mcpServers schema:
      //   { "<name>": { transport, command, args, env } }
      "mcp_servers": "<agent mcpServers object>",

      // optimizer — resolved from dag.effort_max_tokens[milestone.effort].
      // Passed as provider.maxTokens in the agent-mcp agent definition.
      "resolved_max_tokens": "<integer>",

      // optimizer — always true. Tasks fire as background jobs; dispatcher
      // polls result via agent-mcp `result` tool using remote_task_id.
      "background": true,

      // ── Compiled prompt ───────────────────────────────────────────────────
      // Pre-assembled at optimize() time. The dispatcher sends this string
      // verbatim as the `prompt` argument to agent-mcp `task`.
      // Assembled from:
      //   - milestone.description + rationale (context)
      //   - inlined content of context_files[] (read at optimize() time)
      //   - per-op shape specs (ops[].shape.description/objective for doc kind;
      //     ops[].shape.ops[] for code/config kinds;
      //     ops[].shape.schema for structured-output kind)
      //   - guard command (what the agent must ensure passes)
      // Null only if all ops in this unit are type: "tool-call" (no model call).
      "prompt": "<compiled prompt string | null>",

      // ── Context file set ──────────────────────────────────────────────────
      // Files read at optimize() time to assemble prompt. Stored here for
      // cache-invalidation: if any file's mtime changes before dispatch fires,
      // the prompt must be recompiled.
      //   always: milestone.context file (per-milestone prompt template)
      //   always: milestone.read_only[]
      //   always: operation.file for each op in this unit (files being modified)
      //   conditionally: blast_radius[consumer:"current"].file entries
      "context_files": ["<file-path>"],

      // derived: sum(bytesize(f) for f in context_files) — stat at pack time
      "si_bytes": "<integer>",

      // derived: b_eff_per_tier[model] + si_bytes_as_tokens
      //          + sum(ki_estimate for ops in this unit)
      "tokens_estimated": "<integer | null>",

      // derived: tokens_estimated <= context_window_per_tier[model]
      // false triggers optimizer to split this unit further
      "fits_context_window": "<boolean>",

      // derived: milestone.two_stage
      "two_stage": "<boolean>",

      // ── Execution state ───────────────────────────────────────────────────

      // derived: id of the dag.dispatch_log entry written when this unit fires;
      // null until dispatched
      "dispatch_log_id": "<dispatch-uuid | null>",

      // derived: task_id returned by agent-mcp `task` call; distinct from
      // dispatch_log_id (which is our UUID). Used to poll agent-mcp `result`.
      // null until the agent-mcp task call returns.
      "remote_task_id": "<agent-mcp task_id | null>",

      // derived: the agent's final answer from agent-mcp `result`.result.
      // Stored for CLI display and downstream context injection.
      // null until task reaches terminal status.
      "result": "<string | null>",

      // derived:
      //   pending:     remote_task_id is null (not yet fired)
      //   in_progress: remote_task_id set; agent-mcp status is pending|running
      //   complete:    agent-mcp status is completed AND guard passes
      //   failed:      agent-mcp status is failed|cancelled OR guard fails
      "status": "pending | in_progress | complete | failed",

      // derived: when the agent-mcp task call returned (task submitted)
      "started_at": "<ISO timestamp | null>",

      // derived: when agent-mcp status reached a terminal state
      "completed_at": "<ISO timestamp | null>",

      // derived: sum(turns[].input_tokens + turns[].output_tokens) from
      // dispatch_log[dispatch_log_id]
      "tokens_actual": "<integer | null>"

    }
  ],

  // ─── OPEN QUESTIONS ──────────────────────────────────────────────────────
  // Derived from all milestones where pending != null. First-class field so
  // the CLI and orchestrator don't need to scan milestone.pending individually.
  // A question transitions from unsurfaced → surfaced when its blocking
  // milestone reaches status: "pending-surfaced" (deps complete, still blocked).
  // Cleared when a replan or correction dispatch sets milestone.pending = null.

  "open_questions": [
    {
      // derived: stable id assigned at first appearance, e.g. "q1", "q2"
      "id": "<q-id>",

      // dag — verbatim text from milestone.pending
      "text": "<blocking question>",

      // dag — which milestone's pending field this came from
      "blocking": "<milestone-slug>",

      // derived: true when blocking milestone has status == "pending-surfaced"
      // (i.e. all deps complete but pending != null); false while deps are
      // still incomplete — question exists but isn't actionable yet
      "surfaced": "<boolean>",

      // derived: id of the dispatch_log entry where this question first appeared
      // (raised during a planning dispatch or surfaced mid-execution)
      "raised_at_dispatch": "<dispatch-uuid | null>",

      // derived: turn number within that dispatch where question was raised
      "raised_at_turn": "<integer | null>",

      // dag — false until a replan or correction clears milestone.pending
      "answered": "<boolean>",

      // dag — null until answered; set by the replan/correction that clears pending
      "answer": "<string | null>"
    }
  ]

}
```
