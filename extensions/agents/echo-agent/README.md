# Echo Agent

> Use this when you need a reference agent to verify tool-calling wiring or test an orchestrator's delegation path.

## Overview

`echo-agent` is the canonical reference agent in the sox-ecosystem. It requires `tool_calling: true` and exposes two tools:

- **`echo_text`** — accepts a `text` string and returns it verbatim: `{ echo: "<input>" }`
- **`echo_json`** — accepts a JSON string (`payload`), parses it, and returns the parsed value: `{ echo: <parsed> }` (or an error if the string is not valid JSON)

Its system prompt instructs the LLM to route text requests to `echo_text` and structured-data requests to `echo_json`. The agent performs no computation beyond echoing — it exists to prove that the agent extension type's tool-calling contract works end to end.

## When to use

- When you need a real agent installed to test that an orchestrator can delegate a task and receive a tool-called response.
- When you want a scaffold to copy-paste for a new tool-calling agent.
- When writing integration tests that need a known-good agent that reliably echoes input through tools.

Do NOT use this agent for tasks that require actual reasoning or data transformation. It is a wiring test, not a useful agent.

## Capabilities

- Tool calling: yes (`requires.tool_calling: true`)
- LLM calls: yes (routes input to tools via the host's configured provider)

## Tools

| Tool name   | Required inputs       | Returns                                   |
| ----------- | --------------------- | ----------------------------------------- |
| `echo_text` | `text` (string)       | `{ echo: string }` — verbatim repeat      |
| `echo_json` | `payload` (JSON string) | `{ echo: unknown }` or `{ error, raw }` |

## Usage

```bash
sox install echo
```

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT
