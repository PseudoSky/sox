---
name: "Anthropic — How we built our multi-agent research system"
topic: "tool-catalog"
tags: ["use-case:reference", "anthropic", "multi-agent", "orchestrator-worker", "cost"]
summary: "Production orchestrator-worker research system. Verified figures: multi-agent (Opus 4 lead + Sonnet 4 subagents) beat single-agent Opus 4 by 90.2% on an internal research eval; multi-agent uses ~15x chat tokens (agents ~4x); token usage alone explains 80% of performance variance; effort scales with query complexity (1 agent/3-10 calls -> >10 subagents). Explicit mitigations for the caller's exact problems: scale-effort rules, persist-plan-to-memory, filesystem handoff to avoid the 'game of telephone', full production tracing, synchronous-execution bottleneck acknowledged."
importance: 8
data_quality: "verified"
type: "production-implementation"
metrics_source:
  url: "https://www.anthropic.com/engineering/multi-agent-research-system"
  fetched: "2026-09-28 (HTTP 200)"
---

# Use case (directly maps to RQ1, RQ4, RQ6)

**Source:** Anthropic Engineering, "How we built our multi-agent research system", published 2025-06-13.
Fetched full text live (HTTP 200). **Grade B-primary** (first-party builder post; the caller instructed
B-primary).

## Verified figures

- Lead Opus 4 + Sonnet 4 subagents **outperformed single-agent Opus 4 by 90.2%** on an internal research eval.
- Three factors explained **95%** of BrowseComp performance variance; **token usage alone explains 80%**.
- **Multi-agent systems use ~15× more tokens than chat**; agents ~**4×** chat.
- Explicit scaling rule: **1 agent / 3-10 tool calls** (simple) → **2-4 subagents / 10-15 calls** (comparison)
  → **>10 subagents** (complex research).

## Explicit mitigations the caller will recognize

- **Scale effort to query complexity** — embedded rules to stop over-delegation ("spawning 50 subagents for
  simple queries" was an early bug).
- **Persist the plan to memory** before context overflow; spawn fresh subagents with clean contexts.
- **Subagent output to a filesystem to minimize the "game of telephone"** — subagents write artifacts and pass
  lightweight references back, avoiding copying large outputs through the coordinator's history. ← *Directly
  addresses orchestration-loop cache-read cost (the caller's figure 3).*
- **Full production tracing** for debugging non-determinism; rainbow deployments for stateful long-running
  agents. ← *Addresses cost/behaviour invisibility (figure 6).*
- **Acknowledged weakness:** synchronous execution is a bottleneck (lead waits for the slowest subagent; cannot
  steer mid-flight).
- **Adverse domain note:** *"most coding tasks involve fewer truly parallelizable tasks than research"* — a
  caution against over-applying the multi-agent pattern to coding dispatch.

## Key takeaway

The highest-value, non-obvious mitigations for the caller's three biggest measured costs (orchestrator loop,
uniform briefs, tier mismatch) are **effort-scaling rules, plan persistence, and filesystem handoff** — all
cheap and first-party-validated. Multi-agent wins are **breadth-first / parallelizable** problems, not
sequential ones.
