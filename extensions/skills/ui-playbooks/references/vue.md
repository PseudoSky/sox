# Vue Playbook

For Vue 3 and Nuxt 3. Extends the shared principles in `SKILL.md`.

## Checklist

- Vue 3 best practices; Composition API preferred over Options API for new code.
- TypeScript integrated throughout; components tested against the floor.
- Bundle optimized; SSR/SSG configured where the app needs it.
- Accessibility verified with a real engine.
- Performance budget met.

## Patterns

- **Composition API** — `setup`, `ref`, `reactive`, `computed`, `watch`/`watchEffect`,
  lifecycle hooks, `provide`/`inject`, and composables for reusable logic.
- **Reactivity mastery** — `ref` vs `reactive`, shallow refs, computed caching, `watch`
  vs `watchEffect` semantics, effect scopes for teardown, custom reactivity, and memory
  management (unsubscribe in scope dispose).
- **State** — Pinia stores with typed state, getters, and actions; keep server state in
  Nuxt's data layer.
- **Nuxt 3** — universal rendering, file-based routing, auto-imports, server API routes,
  Nitro, `useFetch`/`useAsyncData` for data, SEO/head management, and deployment presets.
- **Component patterns** — composables, renderless components, scoped slots, dynamic and
  async components, `Teleport`, and transitions.
- **Ecosystem** — VueUse for utilities, Vue Router, Pinia, Vite, and a component library
  (Vuetify/Quasar) only if it matches the design system.

## TypeScript integration

- Typed props (`defineProps`), typed emits (`defineEmits`), typed refs, typed composable
  return values, and typed stores. Strict mode, no `any` at the boundary.

## Performance

- Lazy-load routes and heavy components, use `<Suspense>` and async components, keep
  reactivity shallow where deep reactivity is unnecessary, and analyze the bundle.

## Testing

- Vue Test Utils + Vitest for component tests; assert emitted events and rendered output;
  Cypress/Playwright for E2E.

## Enterprise patterns

- Micro-frontends, shared design systems, and a plugin architecture for cross-cutting
  concerns. Prefer Composition API and TS strict; enforce ESLint Vue rules.
