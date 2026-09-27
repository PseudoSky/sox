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

`declarative` — the extension is authored once as a prose-only `agent.md` plus the host-agnostic
`agent` IR in `extension.json`; the host header is rendered per host at install time (see
`docs/spec/cross-platform-install-rendering.md`). No process is spawned.

The agent is multi-host: `install.hosts` covers `claude` and `opencode`. Tool callable names are
resolved from the live tool list at runtime (the search MCP and memory MCP prefixes vary by
host/registration) — see the "Tool naming" section in `agent.md`.

## Capabilities

- Tool calling: yes
- Search MCP (web + registry providers): yes
- Memory MCP (recall/write episodes): yes
- Backlog MCP (file deferrals/bugs): yes

## Source

Authored as a single host-agnostic definition: `agent.md` is the prose body (no frontmatter), and
`extension.json` carries the `agent` IR plus per-host `render` overrides. The host header is rendered
at install time, so there is no hand-authored per-host copy to drift. Port provenance is recorded in
`CHANGELOG.md`.

## Usage

```bash
soxe install researcher --host claude --scope user
soxe install researcher --host codex --scope user
soxe install researcher --host opencode --scope user
```

## License

MIT
