# Research trace — opencode agent dispatching surface

- Date: 2026-10-02
- Question: full dispatching surface available to an agent inside opencode — (a) child status check, (b) mid-run send/receive message.
- Method: primary-source binary inspection (`strings` on opencode 1.18.32), `opencode --help` + subcommand help, sandboxed `sqlite3` reads of `~/.local/share/opencode/opencode.db`, package source read of @adhd/agent-mcp 2.3.4 + this repo's `libs/host-registry/src/agent-mcp.ts`, one DuckDuckGo call for the Claude Code naming yardstick.

## Metrics
- Search terms executed: 1/9 (single targeted DDG call for the yardstick; remainder primary-source)
- Phases: generalization + memory-ping + primary probes = complete for an evidence-report
- Findings written to memory: 3 episodes (task tool, agent-mcp verbs, mechanisms)
- Rate limit / block events: 0
- Anomaly: optional `memory_recall` prior-art lookup TIMED OUT (`E_STORE_OPERATION_TIMEOUT`, `BUG-MEMORYSERVER-WEDGES-SILENTLY-NO-SELF-RECOVERY-001`). `memory_ping` was ok. Not retried (optional step).

## What worked
- `strings` + `rg -o '.{0,N}pattern.{0,N}'` against the 144 MB compiled binary was the decisive technique — schema, routes, hooks, and the background-injection function were all recovered verbatim.
- Reading the installed agent-mcp package (src/server.js, llms.txt, drizzle/*.sql) gave authoritative verb + DDL evidence that the binary alone could not.
- Negative evidence was chased explicitly: `rg -i "sendmessage|send_message|steer|mid-run|inject"` across the agent-mcp package proved the absence of a mid-run message verb rather than assuming it.

## Corrections to initial priors
- Prior: opencode probably had a built-in child-status/message tool analogous to Claude Code. Corrected: it does not; the entire surface is out-of-band (HTTP/SSE/ACP/CLI/plugin).
- Prior: agent-mcp's `task_resume` might be a general mid-run steer. Corrected: it only supplies the human reply to an `awaiting_input` HITL suspension.

## Process failures
- None material. Optional memory recall timed out (server wedge, not a method error).

## Next-run improvement
- Probe the live `opencode serve` route set with curl against a running server to promote the route list from "present in binary" to "confirmed reachable".
