# Demo: adhd-build end-to-end

This is the target demo. The system is done when this sequence works exactly as described.

## Setup

User has written a goal file at `~/projects/my-idea/GOAL.md` describing what they want to build.

## The Run

```
$ adhd-build ~/projects/my-idea/GOAL.md
```

```
Generating plan my-idea...
  ✓ docs/plan/my-idea/ created
  ✓ dag.json initialized

Dispatching milestone: ground-plan
  ⠸ Thinking...

Ground-plan complete. 16 questions to resolve.
```

The system displays questions one at a time, each with a suggested answer derived from the goal file:

```
Question 1 of 16
─────────────────────────────────────────────────────
What is the primary programming language for the implementation?

Suggested: TypeScript (inferred from project context)

> [A]ccept suggestion  [T]ype answer  [S]kip
```

User answers each question (accept suggested / type custom / skip). Skipped questions are non-blocking — they surface again later.

```
16/16 questions resolved (14 answered, 2 skipped)

Dispatching ground-plan with answers...
  ⠸ Planning...

6 milestones created:
  1. dag-schema         Define TypeScript types and io layer        [research]
  2. dispatcher-core    Non-LLM orchestration engine                [core]
  3. llm-adapter        LLM call + structured response layer        [core]
  4. cli-shell          Interactive shell surface                   [cli]
  5. ground-plan-agent  Planning prompt + structured output spec    [dispatch]
  6. system-e2e         End-to-end integration test                 [integration]

Execute or amend?
> [E]xecute  [A]mend
```

User chooses to amend:

```
> A

Amendment: apply playbook before which milestone?
> dispatcher-core

Which playbook?
> project-idea-validation

Dispatching amendment...
  ⠸ Applying playbook...

4 milestones inserted before dispatcher-core:
  research-cli-ux               CLI library decision
  research-structured-output    LLM output format decision
  research-dag-orchestration    Build vs adopt decision
  research-parallel-dispatch    Concurrency model decision

Updated milestone list:
  1. dag-schema                 ...
  2. research-cli-ux            ...  [blocks dispatcher-core]
  3. research-structured-output ...  [blocks dispatcher-core]
  4. research-dag-orchestration ...  [blocks dispatcher-core]
  5. research-parallel-dispatch ...  [blocks dispatcher-core]
  6. dispatcher-core            ...  [pending: 4 blocking entries]
  ... (remaining milestones)

Execute or amend?
> [E]xecute  [A]mend
```

User executes:

```
> E

Dispatching 2 parallel milestones: research-cli-ux, research-structured-output
  ⠸ research-cli-ux            running...
  ⠸ research-structured-output running...

  ✓ research-cli-ux            complete
    Decision: Clack (@clack/prompts) — handles Q&A loop, spinners, and confirm
              prompts natively. No bespoke construction needed.

  ✓ research-structured-output complete
    Decision: Tool use over JSON mode — more reliable, enforces schema at the
              API layer. Question schema: { id, text, suggested, answer | null }.

Dispatching 2 parallel milestones: research-dag-orchestration, research-parallel-dispatch
  ⠸ research-dag-orchestration  running...
  ⠸ research-parallel-dispatch  running...

  ✓ research-dag-orchestration  complete
    Decision: Build from scratch — existing tools (Temporal, BullMQ) are
              over-engineered for single-machine LLM dispatch. Core is ~200 LOC.

  ✓ research-parallel-dispatch  complete
    Decision: Promise.all with a semaphore — worker threads add overhead for
              I/O-bound LLM calls. Back-pressure via configurable concurrency cap.

4 blocking entries resolved. Unblocking dispatcher-core...

There are 2 pending questions (non-blocking):
  Q: Are playbooks named built-ins or user-authored files?
  Q: What is the maximum concurrency for parallel milestone dispatch?

> [A]nswer now  [S]kip
```

User answers both, system continues dispatching remaining milestones sequentially and in parallel per the DAG.

```
Dispatching: dispatcher-core
  ⠸ Running...
  ✓ dispatcher-core complete
    Guard passed: npx tsx scripts/test-dispatcher.ts exit 0
    Summary: topological sort + wave executor + dag.json state writer implemented.
             Handles parallel dispatch, failure isolation, and non-blocking question
             surfacing.

Dispatching: llm-adapter
  ⠸ Running...
  ✓ llm-adapter complete
    Guard passed.
    Summary: tool-use adapter wrapping Anthropic SDK. Retries on schema mismatch.
             Dry-run mode for testing without API calls.

... (remaining milestones complete)

Plan complete.
  Terminal milestone: system-e2e ✓
  Guard: npx tsx scripts/test-e2e.ts exit 0
  
  Total dispatches: 14
  Total tokens:     ~180,000
  Elapsed:          4m 32s
```

## What Proves It's Done

1. `adhd-build ~/projects/my-idea/GOAL.md` runs without error on a clean directory
2. Re-running the same command after interruption resumes from the last completed operation
3. A guard failure on any milestone halts execution, surfaces the error, and waits for correction before retrying
4. The final `docs/plan/my-idea/dag.json` contains a complete `dispatch_log[]` with one entry per API call, token counts per turn, and `guard_result: "pass"` on the terminal milestone
5. Non-blocking questions surface during execution without halting the dispatch wave
