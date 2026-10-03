# ui-playbooks

> Per-stack UI playbooks (React, Vue, Angular, Expo) plus design-system and visual-language guidance, loaded on demand by the `ui` agent.

## Overview

The framework-specific half of the `ui` agent. `SKILL.md` is a short index plus the
shared, framework-neutral principles; each stack's depth lives one level deep in
`references/`. Load only the reference the task needs.

## Contents

- `references/design-system.md` — tokens, theming, component libraries, DESIGN.md →
  implementation, design QA.
- `references/react.md` — React 18+/Next.js/Remix.
- `references/vue.md` — Vue 3/Nuxt 3.
- `references/angular.md` — Angular 15+/RxJS/NgRx/Nx.
- `references/expo.md` — Expo SDK 52+/React Native 0.76+.

Harvested from the claude-agents language specialists and the agency-agents design
catalogue.

## Usage

```bash
soxe install ui-playbooks --host opencode --scope user
```

## License

MIT
