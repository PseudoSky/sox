# Changelog

## 0.1.1

- **All three install surfaces declared — claude, opencode, agent-mcp.** `install.hosts` gains `agent-mcp` and `render.agent-mcp` federates the uniform server set (agent, search, memory-server, gitnexus, backlog) into the catalog row, so a task dispatched through agent-mcp has the same tool surface as a native opencode run. `render.opencode` pins its model and `mode: all`.

## 0.1.0

- **Initial release.** Framework-agnostic UI engineer agent harvested from seven
  claude-agents sources (`frontend-developer`, `ui-designer`, `design-bridge`,
  `react-specialist`, `vue-expert`, `angular-architect`, `expo-react-native-expert`)
  and the agency-agents design + engineering catalogues; capabilities and process kept,
  frameworks separated into the `ui-playbooks` skill.
- **Core system prompt selected by blind A/B.** Three core-SP variants (capability-first,
  workflow-first, contract-first) were judged blind by three independent reviewers;
  the capability-first variant won 2 of 3 firsts, and the final prompt synthesises the
  panel's merge guidance (front-loaded non-negotiable contracts, enumerated capability
  domains with named CVW metrics and a11y tooling, an actionable verified process, and a
  "what done means" acceptance checklist).
- **Judge-flagged fixes applied:** WCAG 2.2 AA (2.1 AA as legacy floor); i18n/RTL and
  SSR/SSG-hydration added as platform concerns; Angular's DI/observables paradigm
  pointed to; the coverage floor resolved to one explicit default with a playbook-may-raise
  clause; duplicated reuse/a11y/coverage rules stated once each.
- **`browser-testing` dependency.** The Playbooks section and `dependencies` now route
  live-browser verification to the `browser-testing` skill (Chrome DevTools MCP).
