# Goal: adhd-build

## Problem

Agent-based planning fails at scale in ten specific ways:

1. Plans can't be reliably resumed — they live in agent context or a single file that another agent must reconstruct from scratch
2. Plan shapes vary wildly — every agent that writes a plan invents its own format
3. Agents rarely complete a full plan on their own — they run out of context or drift
4. Completion is not verifiable — there is no programmatic way to confirm a plan step actually succeeded
5. Goals are lost as agent context continuously overflows — long-running plans lose their original intent
6. Different specialist agents are better suited to different sub-problems — but plans don't route to them
7. Different effort levels are appropriate for different sub-problems — but plans apply uniform effort everywhere
8. Many operations agents perform could have been automated — the agent knew what it needed to do from the start but had to do it manually anyway
9. There is no way to adjust total resource consumption of a plan
10. There is no way to optimize an agent's context other than compaction or starting fresh

## Goal

Build a CLI tool (`adhd-build`) backed by a self-contained, self-documenting, self-driving plan structure where:

- Agents only do what they do best: answer questions
- All orchestration, sequencing, state management, and dispatch is handled by a non-LLM layer
- The plan is fully resumable from its own file at any point in execution
- Completion is programmatically verifiable at the operation level
- Resource consumption (model tier, effort, parallelism) is explicitly controlled per sub-problem
- Specialist agents can be routed to specific milestones
- Operations that can be automated are automated — agents are not asked to do mechanical work

## Constraints

- The dispatcher must be non-LLM — it reads a dag.json and drives execution without calling a model
- LLM calls are only for: generating questions, generating milestone structures, executing operations
- The plan structure (dag.json) is the single source of truth — no separate state file
- The system must be resumable: re-running adhd-build on an existing plan slug continues from current state, it does not restart
- Guards are the verification mechanism — every meaningful milestone has a shell command that proves it

## Non-Goals

- This is not a general workflow engine — it is specifically for authoring and executing LLM-driven implementation plans
- This is not a multi-user system
- OS-level sandboxing of agent processes is out of scope
