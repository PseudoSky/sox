# Engagement handoff — agent & knowledge infrastructure

**Date:** 2026-09-26 · **Owner:** agent-manager · **Why:** survives a context compaction.
Everything below is either durable already or is the *session state* that would otherwise be lost.

## What is already durable (do not re-derive)

| Thing | Where |
|---|---|
| All findings/bugs/plans filed this session (~25 items) | backlog, project `sox-ecosystem` (+ `adhd`), component `agents` |
| Concept-separation research — 17 episodes | memory, topic `reusable-abstraction-design` |
| git-manager research (tools, patterns, safe-removal test) | memory (episodes `01M3FH…`) |
| `agent-manager` **0.1.4** (`mode: primary → all`) | installed both hosts; verified `agent-manager (all)` |
| `architect` **0.1.4** (SP cross-package fix, A/B-proven) | installed both hosts |
| Researcher refactor draft | `sox-ecosystem/docs/plan/researcher-process-refactor/researcher-v2.md` |
| Case-library storage spec | `sox-ecosystem/docs/plan/case-library-storage-model/case-library-storage-spec.md` |
| git-manager draft | `sox-ecosystem/extensions/agents/git-manager/` |

## Key backlog uids

- **Umbrella plan:** `604e2d4c-b17f-4a74-98f4-dac1ff713576`
- **Plans:** `96d74974` (researcher refactor) · `a2d86395` (case library) · `dbd2d393` (concept-separation → process)
- **git-manager FEATURE:** `cc5a4906-40f2-4d0f-a7fe-6b90e2bf5742` *(superseded `00178643-87ef-47b6-9819-409f746b40dd`; its body carries the draft PROGRESS)*
- **The dispatcher-test set:** blocker `42b0dc25-13ad-4ffc-b670-b6562af6fd85`; blocked items `4fc3704e`, `decda240`, `e5a790a7`, `3ec44b8c`
- **Operator/dispatcher findings (A–G):** `416971f9` (blocked ticket claimable) · `b2e9b451` (claim-before-dispatch) · `2ff739f7` (status rollup) · `2d1f8d3a` (policy vs mechanics) · `8232cc9d` (definition-of-ready gate) · `0abc01ed` (deny unverified sha)
- **Component resolution:** `3b5eaf0b` (registry inert + clustering suggestion) · `1b13913a` (operator has no resolution procedure)

## IN FLIGHT — git-manager agent

Draft created at `extensions/agents/git-manager/` — `extension.json`, `git-manager.md`, `package.json`, `README.md`.
**Structural validation PASSED** (`validate-manifests: OK`). **Not installed, not promoted.**

Remaining gates, in order:
1. **Leakage / second-instance test** — hand a FRESH subagent only the *contract* (no `sox`, no `adhd`, no monorepo) and have it apply the git policy to a differently-shaped project. If it needs the original's specifics, the binding leaked into the contract → rewrite before A/B. *This is the gate the authoring process lacked* (`dbd2d393`); this is its first application.
2. **A/B** — behaviour against the current baseline.
3. **Install + §4 verification** — both hosts, four checks. **No approval given yet.**

## IN FLIGHT — the dispatcher test (owner runs it, separate session)

The four items are blocked by `42b0dc25`; a dispatcher given them **did not discover the blocker** (that failure is what bug `416971f9` records). What that means:
- The four are **absent from `ready`** until `42b0dc25` is resolved.
- `ready` for `sox-ecosystem`/`agents` holds **10** items — never loosen the prompt to "work the ready view".
- When `42b0dc25` resolves, the four re-enter `ready` **if** the blocked-claim bug is fixed; otherwise they may be claimable-but-invisible.

### The two prompts

**(A) Discovery test — use if you want to observe whether it finds the blocker:**
> Work these four ready backlog items to completion — all four, in this run. Project sox-ecosystem, component agents.
> `4fc3704e-56b0-4363-a1fe-ec8a51826f8b` (BUG) · `decda240-0954-4d99-bfc3-6c0e896cc274` (DEBT) · `e5a790a7-ab24-4e1b-89fe-bef94d9511d5` (DEBT) · `3ec44b8c-f6dd-4c67-8a38-eff7e0ba8e0e` (FEATURE)
> Run your normal direct-dispatch playbook end to end — intake, decompose, route each item to the executor that owns it, dispatch, verify every outcome from state, review-gate, merge, resolve. Do not do the work yourself.
> Treat each item as authoritative: it carries its own scope, citations, and requested fix. Derive the artifacts, the change discipline, and the verification standard FROM the item and FROM the executor you route it to — do not assume a particular repo layout, artifact type, or release process beyond what the item states.
> Deliver GENERAL fixes, not one-off patches.
> Done when every item is closed with verification evidence attached, or BLOCKED with a named blocker. Nothing IN_PROGRESS, nothing in flight. Report each uid, what changed, and the evidence you read directly.

**(B) Deterministic — run the blocker first, then the four.** Same body as (A), with this header:
> Work these backlog items to completion in this run. One blocks the rest.
> **Entry point — do this FIRST; all four below are blocked by it:** `42b0dc25-13ad-4ffc-b670-b6562af6fd85` (BUG HIGH) — agent-manager hardcodes repo/git specifics into its findings and briefs. Its required outcome: a fresh agent-manager RE-DEFINES the four items below.
> Then, once it resolves (they re-enter ready): *(the four above)*

## Also pending

- **Researcher refactor:** Loop 3a (fresh-subagent real-execution A/B) — held on memory health.
- **Blind agent-manager review** (the owner's standing condition) — needs a **fresh session**; agent-manager is now `mode: all` but a running session keeps its old definition.
- **Case library:** blocked on `f4fa3a30` (eight memory-core capabilities, external-owner decision).
- **The concept-separation plan** (`dbd2d393`): build the second-instance test first, then the §6 extraction gate.

## Uncommitted (no approval to commit)

`agent-manager` 0.1.4 · `architect` 0.1.4 · `extensions/agents/git-manager/**` · `docs/plan/**` · `tmp/**`.

## Open infrastructure bugs (all filed)

Memory server intermittent; backlog MCP drops mid-session (CLI healthy); `create` dedupe over-fires at 0.8 (forced ~7× this session); search MCP absent for dispatched agents (reproduced twice); `memory_write_batch` drops structured fields; location registry inert (1 location store-wide).
