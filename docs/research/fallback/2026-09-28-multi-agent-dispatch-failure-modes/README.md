---
title: Fallback research findings — multi-agent dispatch failure modes & research-subagent cost/benefit
date: 2026-09-28
agent: researcher
status: IN-MEMORY
ingested_at: 2026-09-29T03:34:38Z
ingested_into: /Users/nix/.memory/memory.db
ingested_by: agent-manager
ingest_note: "Written as episodes 01M3NKN3DM464REF46F0QEGQ9N … 01M3NKP7CEBWPND5WTV3YJ1KYK. Note: agent_id is null on these episodes — memory_write_batch carries no attributable author, so they are not reachable by agent_id-scoped recall."
engagement: "Generalize the failure modes of a multi-agent dispatch process and the cost/benefit of a dedicated research subagent; graded, sourced findings to inform a dispatcher/orchestrator agent spec."
---

# Why this directory exists

The researcher agent's required Phase-3 memory probe could not be run when this research was executed:
the `memory-server` MCP was absent from that runtime's tool list, so no `memory_ping`, `memory_recall`, or
`memory_write` was callable. Per the researcher spec, an absent MCP must not be silently skipped, so the
findings were written here as YAML-frontmatter + markdown, shaped exactly like a `memory_write` payload.

**These findings are in memory** — ingested 2026-09-29 into `/Users/nix/.memory/memory.db` (explicit
`db_path`; the default store is *not* the user store). This directory remains as the provenance record and
as the fallback for any host where the MCP is still unreachable.

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
