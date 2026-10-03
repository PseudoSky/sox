# UI Playbooks

Stack-specific playbooks for the `ui` agent. The agent's core system prompt holds the
framework-neutral capabilities, process, and bar; this skill holds the frameworks.

## How to use

Load the one reference for the stack in hand, plus `design-system` when the task touches
tokens, theming, or a component library. Read only what the task needs — do not load all
playbooks.

| Stack / concern | Reference | Load when |
|---|---|---|
| React 18+ / Next.js / Remix | `references/react.md` | A React or React-ecosystem task |
| Vue 3 / Nuxt 3 | `references/vue.md` | A Vue or Nuxt task |
| Angular 15+ / RxJS / NgRx / Nx | `references/angular.md` | An Angular task |
| Expo SDK 52+ / React Native 0.76+ | `references/expo.md` | A mobile or Expo/RN task |
| Tokens, theming, design systems, DESIGN.md | `references/design-system.md` | Any design-system, token, or visual-language task |

References live one level deep under `references/`. Each holds that stack's capabilities,
idioms, ecosystem, targets, and testing approach.

## Shared principles (apply to every stack)

These are the framework-neutral rules the `ui` agent already enforces — the playbooks
extend them, never override them.

- **Tokens are the contract.** One token source (color, type, spacing, radius, elevation,
  motion) feeds every theme. Consume tokens; never hard-code a design value.
- **Accessibility is a build requirement.** WCAG 2.2 AA: semantic structure, keyboard
  paths, focus management, contrast, screen-reader labels. Verify with a real engine
  (axe/pa11y/Lighthouse), not by inspection.
- **Performance is measured.** Web: Core Web Vitals (LCP, CLS, INP). Native: 60 FPS,
  launch budget. Code-split, lazy-load, memoize where measured, and check the bundle.
- **Tests are behavior-first.** Component/integration tests over snapshot sprawl; coverage
  measured against the ≥85% component floor unless the stack playbook raises it.
- **Types are explicit.** Strict mode, typed props/emits, no `any` at the boundary.
- **Reuse before add.** Extend the existing design system and components; justify any new
  dependency by bundle cost.
- **Never invent a parallel system.** Read the existing design system, component
  inventory, and conventions first; extend them.
- **Every stack renders the same states.** Loading, empty, and error are designed, not
  forgotten.

## Reference map

- `references/design-system.md` — token architecture, theming, component-library structure,
  motion and elevation, design-to-code handoff (DESIGN.md → implementation instructions),
  design QA.
- `references/react.md` — React 18+ patterns, hooks, state/data, performance, SSR, testing,
  monorepo packaging.
- `references/vue.md` — Composition API, reactivity, Pinia, Nuxt 3, component patterns,
  testing, type integration.
- `references/angular.md` — Angular architecture, RxJS, NgRx, signals, DI, micro-frontends,
  Nx, performance.
- `references/expo.md` — Expo Router, native modules, EAS build/update, animations,
  platform-specific concerns, performance, testing.
