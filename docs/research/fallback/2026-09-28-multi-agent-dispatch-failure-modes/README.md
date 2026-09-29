---
title: Fallback research findings — multi-agent dispatch failure modes & research-subagent cost/benefit
date: 2026-09-28
agent: researcher
status: NOT-IN-MEMORY
reason_memory_unavailable: "memory-server MCP not registered in this host's tool list (no memory_ping/memory_recall/memory_write callables). Fallback protocol activated per researcher spec."
engagement: "Generalize the failure modes of a multi-agent dispatch process and the cost/benefit of a dedicated research subagent; graded, sourced findings to inform a dispatcher/orchestrator agent spec."
---

# Why this directory exists

The researcher agent's required Phase-3 memory probe could not be run: **the `memory-server` MCP is not
present in this runtime's tool list.** No `memory_ping`, `memory_recall`, or `memory_write` callable exists.
Per the researcher spec, an absent MCP must not be silently skipped, so findings were written here as
YAML-frontmatter + markdown, shaped exactly like a `memory_write` payload, so a later pass can ingest them
verbatim once the memory server is reachable.

**These findings are NOT in memory and will not surface in a future recall until they are ingested.**

Contract:
- One file per finding (`NN-<slug>.md`).
- Each file's body mirrors the research spec's tool / pattern / use-case / verdict shape.
- `data_quality` is `verified` only where every number came from a live tool call; otherwise `estimated`.
- Provenance for every fetched source is the URL actually fetched (status 200), not a search snippet.

Files:
- `01-tools-cost-governance.md` — tool catalog: cost attribution / budget enforcement substrate
- `02-pattern-review-gate-convergence.md` — severity-gated gates that converge
- `03-pattern-scope-control-triage.md` — bounding "file every discovered issue"
- `04-pattern-brief-design-delegation-cost.md` — brief proportionality + delegation context cost
- `05-pattern-revision-pinning-self-assessment.md` — cite-the-revision / stale-proposal prevention
- `06-usecase-anthropic-multiagent-research.md`
- `07-usecase-cognition-dont-build-multiagents.md`
- `08-usecase-mast-taxonomy.md`
- `09-verdict-research-subagent-cost-benefit.md`
- `10-corroboration-7-figures.md` — which of the caller's 7 self-reported figures are externally corroborated
