# browser-testing

> A live-browser testing and debugging playbook for front-end UI work, driven by Google's `chrome-devtools-mcp`.

## Overview

Instructs an agent to verify and debug UI in a real browser through the `chrome-devtools` MCP
server: interaction/smoke tests, console and network debugging, Core Web Vitals performance
traces, accessibility audits, responsive/theme emulation, and visual regression. Ships six
playbooks plus a full tool catalog and server configuration reference.

## Requires

The `chrome-devtools` MCP server (`ChromeDevTools/chrome-devtools-mcp`). Without it the
`mcp__chrome-devtools__*` tools are absent — see `references/config.md` to register it.

## Contents

- `SKILL.md` — the playbook (core discipline + Playbooks A–F + hard rules).
- `references/tool-reference.md` — every tool with parameters and CWV thresholds.
- `references/config.md` — server setup, flags, isolation, troubleshooting.

## Usage

```
soxe install browser-testing --host opencode --scope user
soxe install browser-testing --host claude --scope user
```

## License

MIT
