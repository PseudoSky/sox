# researcher

> Discovery researcher for third-party tools, patterns, and use cases before you build.

## Overview

Generalizes a problem into research questions, sweeps package registries and the web via the
search MCP, grades every source, and writes each finding to memory as a separate episode tagged
`agent:approved` or `agent:blocked`, ending in a build-vs-integrate verdict. Never writes code.

Unlike `workflow-researcher` (workflow-plugin findings) or `research-analyst` (trend synthesis),
it evaluates shippable dependencies — verified registry metrics, an approved/blocked decision per
candidate, and a build-vs-integrate recommendation.

## When to use

Use this agent when you need to discover, grade, and catalog third-party tools, patterns, and
use cases before building. It answers "what should we take off the shelf for X, and is it any
good" — not "what is known about X" (that's `research-analyst`).

## Runtime

`declarative` — the host reads `researcher.md` and injects it as a subagent definition.
No process is spawned. Install target resolved from host-registry at install time.

The agent is multi-host: `install.hosts` covers `claude`, `codex`, and `opencode`. Tool callable
names are resolved from the live tool list at runtime (the search MCP and memory MCP prefixes vary
by host/registration) — see the "Tool naming" section in `researcher.md`.

## Capabilities

- Tool calling: yes
- Search MCP (web + registry providers): yes
- Memory MCP (recall/write episodes): yes
- Backlog MCP (file deferrals/bugs): yes

## Source

Ported from `~/dev/ai/claude-agents/categories/10-research-analysis/researcher.md` (v1.0.1).
Provenance recorded in `extension.json` → `install.source`.

## Usage

```bash
soxe install researcher --host claude --scope user
soxe install researcher --host codex --scope user
soxe install researcher --host opencode --scope user
```

## License

MIT
