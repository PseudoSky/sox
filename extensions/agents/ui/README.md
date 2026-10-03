# ui

> Senior UI engineer: design systems, components, styling, theming, accessibility, and front-end performance across React, Vue, Angular, and Expo/React Native.

## Overview

A framework-agnostic UI engineering agent. The core system prompt holds the
framework-neutral contracts, capability domains, process, and definition of done;
stack-specific depth loads on demand from the `ui-playbooks` skill (React, Vue,
Angular, Expo, design-system). Live-browser verification loads from the
`browser-testing` skill when the Chrome DevTools MCP is available.

Harvested from the claude-agents frontend/design specialists and the agency-agents
design + engineering catalogues, then distilled. The core system prompt was selected
by a blind three-judge A/B panel over three variants (capability-first, workflow-first,
contract-first) and synthesised from the winners' best features.

## When to use

Building or changing user-facing interface code: components, design systems, styling,
theming, accessibility, or front-end performance.

## Runtime

`declarative` — the host reads `ui.md` and injects it as an agent definition.
No process is spawned.

## Dependencies

- `ui-playbooks` — per-stack playbooks (React, Vue, Angular, Expo, design-system).
- `browser-testing` — live-browser testing/debugging playbook via Chrome DevTools MCP.

## Usage

```bash
soxe install ui --host opencode --scope user
soxe install ui-playbooks --host opencode --scope user
soxe install browser-testing --host opencode --scope user
```

## License

MIT
