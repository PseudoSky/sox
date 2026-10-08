---
"@adhd/sox-cli": minor
"@adhd/sox-host-registry": minor
"@adhd/sox-install-engine": minor
"@adhd/sox-manifest": minor
---

Install/uninstall safety, host-attributed uninstall, and fail-closed agent-mcp web-tool rendering (tickets 6fd94192, 6c9fbf52, e46db6ed, e00c47bb).

**manifest** — `validate` now rejects unknown keys in the `agent` block (closed key set `AGENT_IR_KEYS`, plus `AGENT_IR_TOOL_REF_KEYS` for symbolic tool refs); the JSON-schema `additionalProperties: false` was never executed before. `agent.steps` must be a positive integer. New exports: `AGENT_IR_KEYS`, `AGENT_IR_TOOL_REF_KEYS`.

**install-engine** — install refuses an existing destination that no ledger entry owns, before any write (agent, skill and hook; BUG-028), and `--force` adopts it with a warning. Uninstall is host-attributed: `uninstall --host X` reverses only that host, shared targets survive until the last claiming host is removed (order-independent), and an unsafe uninstall raises `UninstallAbortedError`; project-scope ledger resolution is fixed. `ownership.json` saves are serialized with an O_EXCL lock file (`withFileLockSync`, `OwnershipLockTimeoutError`), fixing a lost-update race.

**host-registry** — the agent-mcp renderer treats an explicit single web-tool deny with the sibling allowed as `nativeWebTools: false` (fail-closed) and records a `dropped` loss; an explicit `render.agent-mcp.nativeWebTools` override records `covered-by-override`. Both web tools denied with unspecified `tools` is closed too. Migration note: `docs/spec/agent-mcp-renderer-fidelity.md`.

**cli** — `uninstall --host <h>` takes exactly one host; MCP project-sync and trust reversals use the host(s) actually being removed instead of the record's last writer; previously untraced catches now log, and `uninstall` reports aborts and any reversals already completed.
