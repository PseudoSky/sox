---
name: "Proportional brief design + the context cost of delegation"
topic: "tool-catalog"
tags: ["pattern:recommended", "brief-design", "delegation", "context-cost", "proportionality"]
summary: "Briefs must scale with task complexity, not be uniform: Anthropic's production system encodes explicit scaling rules (1 agent/3-10 calls for simple fact-finding; 2-4 subagents/10-15 calls for comparisons; >10 subagents for complex research) and finds that vague short briefs cause duplicated/misinterpreted work. Each brief needs objective + output format + tools/sources + task boundaries. Delegation is expensive because the orchestrator's context grows monotonically (cache-read accumulation); subagent context isolation is the benefit, but the round-trip is the cost."
importance: 8
data_quality: "estimated"
type: "best-practice"
---

# Finding (RQ4 — brief/dispatch design and delegation context cost)

## The proportionality heuristic (verified first-party)

**Anthropic, "How we built our multi-agent research system"** (fetched live, HTTP 200, 2025-06-13):
the system embeds **explicit scaling rules in the prompt**:

> *"Simple fact-finding requires just 1 agent with 3-10 tool calls, direct comparisons might need 2-4
> subagents with 10-15 calls each, and complex research might use more than 10 subagents with clearly divided
> responsibilities. These explicit guidelines help the lead agent allocate resources efficiently and prevent
> overinvestment in simple queries, which was a common failure mode in our early versions."*

→ The heuristic is **effort ∝ task complexity/ambiguity**, expressed as *number of agents × calls*, not a fixed
brief template. **Grade B-primary.**

## Brief content (what a brief must carry)

Same source: *"Each subagent needs an objective, an output format, guidance on the tools and sources to use,
and clear task boundaries. Without detailed task descriptions, agents duplicate work, leave gaps, or fail to
find necessary information."* It documents the failure of **too-short briefs**: allowing the lead to say only
*"research the semiconductor shortage"* led subagents to *"misinterpret the task or perform the exact same
searches as other agents."*

→ **Brief length is not the metric; brief *completeness relative to the task's degrees of freedom* is.** A
fixed-playbook operator with zero design freedom needs a short brief; an implementer with many degrees of
freedom needs a rich one. **Uniform median length across both (the caller's figure 4) is the anti-pattern.**
Convergent with Addy Osmani's "write a good spec for AI agents" (**Grade B-primary**): *"just enough nuance
(structure, style, testing, boundaries) to guide the AI."*

## Why delegation / round-trips are expensive

- **Anthropic (same post, verified):** *"agents typically use about 4× more tokens than chat interactions,
  and multi-agent systems use about 15× more tokens than chats."* And **token usage by itself explains 80% of
  performance variance** (BrowseComp).
- **Orchestrator-loop cost specifically.** The caller's figure (3) — a main-thread loop over 3,469 turns /
  460.6M **cache-read** tokens — is the signature of a monotonic-context loop: each turn re-reads the whole
  accumulated context. Anthropic's own mitigation is explicit: *"if the context window exceeds 200,000 tokens
  it will be truncated and it is important to retain the plan"* → they persist the plan to memory, spawn fresh
  subagents with clean contexts, and
  **have subagents write large outputs to a filesystem and pass back lightweight references** ("Subagent output
  to a filesystem to minimize the 'game of telephone'") to avoid copying large outputs through the
  coordinator's history.
- **Context degradation with length** (why heavy inline work hurts the coordinator): **Liu et al., "Lost in
  the Middle" (TACL 2024, ACL Anthology 2024.tacl-1.9; peer-reviewed, ~6.6k citations)** — *"performance can
  degrade significantly when changing the position of relevant information."* **Grade A.** Corroborated by
  Chroma's "Context Rot" research (**Grade B-primary**, read partially): performance degrades as input length
  grows.
- **Subagent token overhead is real, not free:** secondary reporting (**Grade C**) of Anthropic's Claude Code
  docs states sub-agents *"can burn 7× more tokens than a normal session."*

## Corroboration from MAST

**FM-1.1 "Disobey task specification" (11.8%)** and **FM-1.2 "Disobey role specification" (1.5%)** are the
taxonomy's names for brief-induced failure — the top system-design failure mode. **FM-1.4 "Loss of
conversation history"** is the monotonic-context failure.

## Weaknesses

- "Scale effort to complexity" requires the orchestrator to *judge* complexity; a mis-judgment either
  over-spends or under-delegates. Anthropic reports agents *"struggle to judge appropriate effort"* — the rule
  is a scaffold, not a solution.
- The 7× subagent-overhead figure is a secondary citation of Anthropic docs; treat as MEDIUM confidence.
