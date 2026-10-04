# Inter-Agent Artifacts (RETIRED)

**This directory is a retired protocol, kept for historical reference only.** It described the
old `pro` / `implement` / `flash` dispatch model, which no longer exists — none of those agents
is defined anywhere, and nothing reads `dispatch.json`.

The current model: orchestration is owned by the **`dispatcher`** extension
(`extensions/agents/dispatcher/`), which decomposes a direction, dispatches **named registry
agents** (structured extensions under `extensions/agents/`, plus project-scope/built-in agents
opencode enumerates) in the background via the task tool, verifies each outcome from
git/tests/state, and keeps the Task list and backlog graph in sync. The brief/return/telemetry
contract is the **`dispatch-contract`** skill — not the files here.

## Historical contents

- `dispatch.json` — a dispatch plan written by `pro` in the retired model.
- `DISPATCH_TEMPLATE.json` / `REPORT_TEMPLATE.json` — templates for that retired protocol.
- `reports/`, `handoff/`, `reviews/` — per-segment completion reports, inter-agent notes, and
  review artifacts from that era.

Do not extend this protocol; new dispatch work goes through the `dispatcher` extension and the
`dispatch-contract` skill.
