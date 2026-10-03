# dispatch-status — what is true right now

The dispatcher's read-only playbook — answer "where are we" for the current run — in-flight and finished dispatches with their verified state, Task-list status, backlog items touched this run, open plans and claims, and unrecorded transitions. Also run before every dispatcher return to prove nothing is orphaned. Dispatches nothing, writes nothing. Load on "status", "what's in flight", "what's left", or at close.

## Sources (read, never infer)

- `TaskList` — every task under this run's root(s), with status.
- Background agents — which dispatches are still running (harness notifications / `mcp__agent-mcp__*` task list) versus returned.
- `Bash git log --oneline -20` and `git status --short` — what merged, what is dirty.
- `backlog-operator: report` filtered to items touched by this run's identity.
- `Glob docs/plan/*/state.json` — open plans, `claimed_by`/`claimed_at`.
- The run's unrecorded-transition list (operator `ESCALATE`s not yet retried successfully).

## Output (to the user, ≤ 150 words + table)

```text
Run <id> · playbook <name>
| task | executor | item | dur | state | verified | note |
|---|---|---|---|---|---|---|
| <bucket> | <agent> | <backlog uid> | <dur_ms or running> | in_progress / done / blocked | pass / fail / partial / — | <blocker or commit> |

In flight: <n> · merged: <n> (<refs>) · blocked: <n>
Backlog touched: <ids + status>
Plans: <slug: state, claim> | none
Unrecorded transitions: <list> | none
New/unacknowledged bugs/deferrals: <list> | none
```

## At close (mandatory before any dispatcher return)

Every task must be `done` or `blocked` with a reason; every background agent
returned or stopped; every unrecorded transition retried once. If any check
fails, fix it (retry, stop, or mark blocked) before returning — never return
with something silently in flight.

## Hard rules

- Read-only: no dispatch, no writes, no Task creation.
- `verified` reflects the dispatcher's own state check, never an executor's `outcome`.
