# Inter-Agent Artifacts

This directory is the shared coordination surface for subagent dispatches. The `pro` orchestrator writes dispatch plans here; `implement` and `flash` agents read their segments and append completion reports.

## Protocols

### dispatch.json — the active dispatch plan

Written by `pro` before dispatching. Contains the decomposed segments, their assigned agents, dependencies, and expected files.

### reports/ — per-segment completion reports

Written by `implement` or `flash` after completing a segment. Format: `{segment}_{agent}_{timestamp}.json`.

### handoff/ — inter-agent notes

Written by any agent that discovers something another agent needs to know (e.g., "Segment 1 changed the McpConfig interface — Segment 2 needs to re-read internal.ts before building opencode.ts").

## Lifecycle

1. `pro` writes `dispatch.json`
2. `pro` dispatches segments to `implement` / `flash` with the segment spec + path to `dispatch.json`
3. Each agent reads its segment from `dispatch.json`, does the work, writes a report to `reports/`
4. `pro` monitors `reports/` for completions, resolves dependencies, dispatches next wave
5. `pro` writes final `dispatch.json` with `status: "complete"` and all report references
