---
name: test-agent
description: test-agent extension
tools: Read, Write, Edit, Bash, Glob, Grep
model: sonnet
---

# test-agent

test-agent extension

## When to invoke this agent

<!-- Describe the conditions under which an orchestrator should hand off to this agent. -->

## What this agent does

1. Receives a task description from the host or orchestrator.
2. Uses available tools to complete the task.
3. Returns a structured result to the caller.

## Constraints

- Keep task scope narrow: one goal per delegation.
- Do NOT make external network calls unless explicitly permitted.

## Agent id

`test-agent`