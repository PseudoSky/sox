---
name: "Cognition — Don't Build Multi-Agents (and the follow-up)"
topic: "tool-catalog"
tags: ["use-case:reference", "cognition", "context-engineering", "context-isolation", "counterpoint"]
summary: "Cognition's argument against multi-agent architectures for long-running agents, on two principles: (1) share context (full traces), (2) actions carry implicit decisions. Parallel subagents that cannot see each other make conflicting implicit decisions, producing fragile systems. Crucially, the post still endorses the CONTEXT-OFFLOAD benefit of a subagent: in Claude Code, the subagent's investigative work 'does not need to remain in the history of the main agent, allowing for longer traces'. A follow-up ('Multi-Agents: What's Actually Working', 2026) refines the position toward one stateful main loop + stateless narrow workers."
importance: 8
data_quality: "verified"
type: "production-implementation"
metrics_source:
  main_post: "https://cognition.ai/blog/dont-build-multi-agents (fetched 2026-09-28, HTTP 200; by Walden Yan, 2025-06-12)"
  follow_up: "https://cognition.ai/blog/... (title confirmed via search 2026-04-22; direct URL 404 on guessed slug)"
---

# Use case (RQ4 + RQ6 counterpoint)

**Source:** Cognition, "Don't Build Multi-Agents" (Walden Yan, 2025-06-12). Fetched full text live (HTTP 200).
**Grade B-primary.**

## The two principles (verbatim structure)

1. **Share context and full agent traces, not just individual messages.**
2. **Actions carry implicit decisions, and conflicting decisions carry bad results.**

The failure: two parallel subagents each make unstated style/interface choices; the coordinator must reconcile
mutually-inconsistent work (*"subagent 1 ... started building a background that looks like Super Mario Bros."*).
Cognition's verdict for 2025: multi-agent collaboration *"only results in fragile systems"* because
"decision-making ends up being too dispersed."

## The nuance most people miss — subagents still pay for context isolation

The post explicitly endorses the *context-offload* benefit:

> *"The benefit of having a subagent in this case is that all the subagent's investigative work does not need
> to remain in the history of the main agent, allowing for longer traces before running out of context."*

And it notes Claude Code (as of June 2025) *"never does work in parallel with the subtask agent, and the
subtask agent is usually only tasked with answering a question, not writing any code."*

→ **This is the direct answer to RQ6's "researcher subagent vs inline": the strongest first-party argument FOR
a research subagent is context isolation (keeping investigative noise out of the coordinator's history), NOT
parallelism or throughput.** The strongest argument AGAINST is that parallel *mutating* agents make
conflicting implicit decisions. A read-only research subagent is on the safe side of that line.

## The follow-up (position refinement)

Cognition, "Multi-Agents: What's Actually Working" (2026-04-22, confirmed via search; title/date):
parallel agents *"make implicit choices about style, edge cases, and code patterns"* that conflicted. Walden
Yan on X: *"The setups that actually work all seem to share the same property: one main loop carries state,
subagents are stateless workers with narrow [scope]."* (**Grade B/C** — follow-up body not fetched, 404 on the
guessed URL.)

## Key takeaway

A **stateless, read-only research subagent answering a well-defined question** is exactly the shape Cognition
blesses. The caller's cost concern is about orchestrator-loop context growth — precisely the cost the subagent
pattern exists to avoid. The danger is delegating *mutating* work in parallel.
