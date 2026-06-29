# Planning Session — adhd-build
dispatch_id: plan-session-001
agent: workflow:plan-builder
model: claude-opus-4-5
provider: anthropic
effort: high
started_at: 2026-06-27

## Turns

| # | From    | Summary |
|---|---------|---------|
| 1 | planner | "What are we building?" |
| 2 | user    | Described 10 failure modes of current agent-based planning; goal is a self-driving, self-documenting, self-contained plan structure where agents only answer questions |
| 3 | planner | Asked for the demo — who initiates, where does the plan live, what does an agent receive and give back, what proves done |
| 4 | user    | Provided 19-step demo sequence: adhd-build <path> → scaffold → ground-plan dispatch → Q&A loop (answer/skip/recommend) → milestones summary → execute or amend → parallel dispatch → completion |
| 5 | planner | Asked: brownfield or greenfield? And: where does the "recommend answer" come from? |
| 6 | user    | Greenfield (start from scratch). Suggested answers come from the dispatched agent's structured output — propagated by CLI, not a separate call |
| 7 | planner | Asked: what is the runtime target / language? |
| 8 | user    | Language doesn't matter — planner chooses |
| 9 | planner | Proposed decomposition (7 milestones); presented to user for feedback |
| 10 | user   | Challenged: "you don't need to research anything? you're able to design all of that without looking up any 3rd party tools?" — correction triggered |
| 11 | planner | Acknowledged missing research phase; added 4 research milestones as blocking upstreams; wrote initial dag.json with empty operations[] |
| 12 | user   | "I noticed that your dag wrote 0 operations, does that mean nothing will be produced?" — correction triggered |
| 13 | planner | Acknowledged missing operations; authored 19 operations covering scope-authored, research milestones, dag-schema (7 ops), scaffolding (2 ops); left pending milestones without operations explicitly |
| 14 | user   | "I noticed that you didn't create the scope document or demo document that would feed the dispatches you planned" — correction triggered |
| 15 | planner | Acknowledged missing scope artifacts; created GOAL.md and DEMO.md; added scope-authored milestone as wave-0 gate; wired read_only on all research milestones |
| 16 | user   | Asked to move test-dag.json to docs/plan/adhd-build/dag.json and remove comments |
| 17 | planner | Moved file; removed comments; updated amend-interface.pending to record the unanswered playbook question |
| 18 | user   | "I noticed that you didn't add the question you asked to the dag document — why is that?" |
| 19 | planner | Acknowledged; noted the planning session IS a dispatch; proposed planning_log as a first-class field |
| 20 | user   | "Planning is a dispatch so every turn here you should consider to be a dispatched operation. Store unanswered and answered questions to a log." |

## Questions Raised

### Q1 — What are we building?
- **Asked at turn:** 1
- **Answered at turn:** 2
- **Status:** resolved
- **Answer:** A CLI tool (adhd-build) backed by a self-driving dag.json plan structure. Agents only answer questions. All orchestration is non-LLM.

### Q2 — What does "done" look like as a demo?
- **Asked at turn:** 3
- **Answered at turn:** 4
- **Status:** resolved
- **Answer:** 19-step demo sequence — see docs/plan/adhd-build/DEMO.md

### Q3 — Brownfield or greenfield?
- **Asked at turn:** 5
- **Answered at turn:** 6
- **Status:** resolved
- **Answer:** Greenfield. Prior implementations exist but starting from scratch is fine.

### Q4 — Where does the "recommend answer" come from?
- **Asked at turn:** 5
- **Answered at turn:** 6
- **Status:** resolved
- **Answer:** The dispatched ground-plan agent returns questions with suggested answers in its structured output. The CLI renders the suggestion; no second LLM call needed.

### Q5 — What is the runtime target / language?
- **Asked at turn:** 7
- **Answered at turn:** 8
- **Status:** resolved
- **Answer:** Language doesn't matter; planner's choice. (TypeScript/Node selected by planner.)

### Q6 — Are playbooks named built-in patterns the system ships with, or files the user authors?
- **Asked at turn:** 17 (surfaced in amend-interface.pending)
- **Answered at turn:** —
- **Status:** UNANSWERED — blocks amend-interface operations from being authored
- **Blocking:** amend-interface milestone (pending field set)

## Corrections Received

| Turn | Correction | Effect on dag.json |
|------|-----------|-------------------|
| 10 | Missing research phase | Added research-cli-ux, research-llm-structured-output, research-dag-orchestration, research-parallel-llm-dispatch milestones; wired as blocking upstreams |
| 12 | Empty operations[] | Authored 19 operations across scope-authored, research milestones, dag-schema, scaffolding |
| 14 | Missing scope documents | Created GOAL.md + DEMO.md; added scope-authored milestone as wave-0 gate; wired read_only on all research milestones |
| 18 | Q&A not recorded in dag | This log; dispatch_log[] entry added to dag.json |

## Operations Produced

| op_id | file | status |
|-------|------|--------|
| scope-authored.1 | docs/plan/adhd-build/GOAL.md | complete |
| scope-authored.2 | docs/plan/adhd-build/DEMO.md | complete |
| research-cli-ux.1 | docs/plan/adhd-build/research/cli-ux.md | pending |
| research-llm-structured-output.1 | docs/plan/adhd-build/research/structured-output.md | pending |
| research-dag-orchestration.1 | docs/plan/adhd-build/research/dag-orchestration.md | pending |
| research-parallel-llm-dispatch.1 | docs/plan/adhd-build/research/parallel-dispatch.md | pending |
| dag-schema.1 | src/dag/types.ts — DagJson | pending |
| dag-schema.2 | src/dag/types.ts — Milestone | pending |
| dag-schema.3 | src/dag/types.ts — Operation | pending |
| dag-schema.4 | src/dag/io.ts — readDag | pending |
| dag-schema.5 | src/dag/io.ts — writeDag | pending |
| dag-schema.6 | src/dag/io.ts — appendDispatch | pending |
| dag-schema.7 | src/dag/validate.ts — validateDag | pending |
| scaffolding.1 | bin/adhd-build | pending |
| scaffolding.2 | src/scaffold.ts — scaffold | pending |

## Notes

- WARN: Q6 (playbook format) unanswered — amend-interface cannot be fully scoped until resolved
- WARN: dispatcher-core, llm-adapter, ground-plan-agent, cli-shell, amend-interface, system-end-to-end have no operations authored — pending research resolutions
- INFO: scope-authored.1 and scope-authored.2 are marked complete — files exist on disk; guard passes immediately without dispatch
