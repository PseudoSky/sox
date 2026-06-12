# Audit Hook

> Use this when you need an append-only audit trail of every tool invocation in a session.

## Overview

`audit-hook` binds the `PreToolUse` host lifecycle event and appends one JSON line to a log file for each tool call it intercepts. The log entry contains the event name, an ISO timestamp, and the full payload as received from the host.

The log path is controlled by the `AUDIT_HOOK_LOG` environment variable; when unset it defaults to `~/.sox/audit-hook.log`. The log directory is created automatically on first write. The handler is fully deterministic — it makes no LLM calls and has no external dependencies beyond `node:fs`.

## When to use

- When you need a lightweight, always-on audit record of which tools were called and with what payloads.
- When debugging unexpected tool invocations in a development or staging environment.
- When you need to satisfy an audit or compliance requirement that every tool call is persisted to a file.

Do NOT use this hook as a security gate — it observes calls but cannot block or modify them.

## Lifecycle event

`PreToolUse` — fires before every tool invocation.

## Execution order

`order: 100` — fires early in the hook chain. Hooks run in ascending order; ties are broken lexicographically by id.

## Log format

Each line is a JSON object:

```json
{ "timestamp": "2026-06-08T10:00:00.000Z", "event": "PreToolUse", "payload": { ... } }
```

## Configuration

| Variable          | Default                   | Description                          |
| ----------------- | ------------------------- | ------------------------------------ |
| `AUDIT_HOOK_LOG`  | `~/.sox/audit-hook.log`   | Path where log lines are appended    |

## Constraints

- Deterministic: no LLM calls.
- Side effects (file append) are idempotent across retries for the same event.

## Usage

```bash
sox install audit
```

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT
