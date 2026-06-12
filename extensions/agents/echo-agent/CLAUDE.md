# Echo Agent — LLM Guidance

## Purpose

Use this when you need a reference agent to verify tool-calling wiring or test an orchestrator's delegation path — echoes text verbatim via `echo_text` or round-trips a JSON payload via `echo_json`.

## When to delegate to this agent

Delegate to `echo` when:
- You are testing that your orchestrator correctly hands off a task and receives a tool-called response.
- You need a known-good, always-succeeding agent installed to isolate a host-side wiring issue.
- You want to verify that `echo_text` → text echo and `echo_json` → JSON round-trip both work correctly.

Do NOT delegate to this agent for any task that requires meaningful computation, reasoning, or data retrieval. It only echoes — it is a wiring test.

## What this agent does

1. Receives a task description from the host (text string or JSON payload).
2. Routes to `echo_text` for plain text or `echo_json` for structured data, per its system prompt.
3. Returns the echoed value as the tool result.

The system prompt: *"You are a helpful echo agent. When given input, you echo it back using the available tools. Use echo_text to return text verbatim and echo_json to return structured data."*

## Tools required

| Tool name   | When called                         | Returns                            |
| ----------- | ----------------------------------- | ---------------------------------- |
| `echo_text` | Input is a plain text string        | `{ echo: string }` — verbatim      |
| `echo_json` | Input is a JSON-serialisable value  | `{ echo: unknown }` — parsed value, or `{ error, raw }` on bad JSON |

## Constraints

- Requires `tool_calling: true` from the configured provider.
- Makes exactly one tool call per invocation.
- Does NOT make external network calls.

## Handoff protocol

Pass the task as a natural-language description or a JSON string. The agent returns its result as the final assistant message after exactly one tool call.

## Agent id

`echo`
