# Changelog

## 0.1.0

- **Initial release.** Per-stack UI playbooks separated from the `ui` agent's core
  system prompt: `references/react.md` (React 18+/Next.js/Remix), `references/vue.md`
  (Vue 3/Nuxt 3), `references/angular.md` (Angular 15+/RxJS/NgRx/Nx), `references/expo.md`
  (Expo SDK 52+/React Native 0.76+), and `references/design-system.md` (tokens, theming,
  component libraries, DESIGN.md translation, design QA).
- Harvested from the claude-agents sources (`react-specialist`, `vue-expert`,
  `angular-architect`, `expo-react-native-expert`, `ui-designer`, `design-bridge`) and the
  agency-agents design catalogue; technical capabilities and process retained, framework
  specifics isolated into this skill.
- `SKILL.md` carries the routing table and the shared framework-neutral principles; the
  references are one level deep per the skill spec.
