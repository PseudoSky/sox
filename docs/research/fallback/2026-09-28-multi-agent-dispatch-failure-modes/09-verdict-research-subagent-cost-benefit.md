---
name: "Verdict — cost/benefit of a dedicated research subagent vs inline research"
topic: "tool-catalog"
tags: ["agent:approved", "research-subagent", "cost-benefit", "context-isolation", "verdict"]
summary: "Verdict: a dedicated, READ-ONLY research subagent is the well-founded choice, on ONE measured benefit — context isolation — not on any measured dollar saving. Anthropic: subagents keep investigative work out of the coordinator's history; multi-agent costs ~15x tokens but wins on breadth-first work (90.2% on an internal eval). Cognition endorses the isolation benefit while warning against parallel MUTATING agents. Counter-evidence: Tran & Kiela (2026) show single-agent matches/beats multi-agent under EQUAL token budgets. No public dollar-denominated A/B of subagent-research-vs-inline was found — that is a gap."
importance: 8
data_quality: "estimated"
type: "production-implementation"
---

# Verdict (RQ6)

## What the evidence actually supports

**FOR a research subagent (context isolation, not throughput):**
- **Cognition** (verified, B-primary): the subagent's benefit is that *"all the subagent's investigative work
  does not need to remain in the history of the main agent, allowing for longer traces."*
- **Anthropic** (verified, B-primary): subagents *"facilitate compression by operating in parallel with their
  own context windows ... before condensing the most important tokens for the lead research agent"*; plus the
  filesystem-handoff anti-"game-of-telephone" pattern.
- **Context degradation** (Liu et al., TACL 2024, **Grade A**): performance degrades with long/irrelevant
  context — a mechanical reason inline research damages the coordinator.

**COUNTER (be skeptical of the multi-agent premium):**
- **Tran & Kiela, arXiv:2604.02460 (2026, preprint, Grade B):** under **equal thinking-token budgets**,
  single-agent systems *"consistently match or outperform"* multi-agent systems on multi-hop reasoning; *"many
  reported advantages of multi-agent systems are better explained by unaccounted computation and context
  effects."* → Multi-agent is not magically better; it is often just *more compute*.
- **Anthropic itself:** multi-agent uses **~15× chat tokens**; secondary reporting of Claude Code docs
  (**Grade C**) states sub-agents *"can burn 7× more tokens than a normal session."*
- **Anthropic adverse-domain note:** coding has *"fewer truly parallelizable tasks than research."*

## The synthesis (verdict)

A **stateless, read-only research subagent answering a well-defined question** is the shape both Cognition and
Anthropic endorse, and it directly attacks the caller's orchestrator-loop context-growth cost (figure 3). The
benefit is **context isolation / coordinator-context preservation**, and it is *conditional on a clean
handoff*: the subagent must return a compressed finding, and large artifacts should go to a filesystem, not
through the coordinator's history. The benefit is NOT "more capability per token" — that claim is refuted by
the equal-budget study.

## What the evidence does NOT settle (explicit gap)

**No public, dollar-denominated, controlled A/B of "delegate research to a subagent" vs "do it inline" was
found.** The available numbers are token-multipliers (4×, 7×, 15×) and quality deltas (90.2%), never a
cost-per-completed-research-task comparison. A caller wanting a defensible cost/benefit for *their* system must
measure it; the literature gives direction, not a figure.
