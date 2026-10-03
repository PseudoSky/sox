# React Playbook

For React 18+ and the React ecosystem (Next.js, Remix, Vite). Extends the shared
principles in `SKILL.md`.

## Checklist

- React 18+ features in use; components reusable across the app (target >80%).
- Strict TypeScript; props and hooks fully typed; no `any` at the boundary.
- Performance budget met; bundle analyzed and trimmed.
- Component test coverage measured against the floor.
- Accessibility verified with a real engine.
- Shared UI packaged as an Nx library when more than one app consumes it.

## Patterns

- **Component patterns** — compound components, render props, higher-order components,
  custom hooks, context composition (split contexts to limit re-renders), ref forwarding,
  portals, lazy loading via `React.lazy` + Suspense.
- **Hooks mastery** — correct dependency arrays, `useMemo`/`useCallback` only where
  measured, custom hooks for shared logic, stable identities for effect deps.
- **Concurrent features** — `useTransition`, `useDeferredValue`, Suspense for data,
  selective hydration. Reach for them when the interaction is genuinely slow, not by default.
- **State management** — pick the smallest fit: Context for low-frequency shared state,
  Zustand/Jotai/Recoil for client state, TanStack Query / Apollo for server state, Redux
  Toolkit for large apps with complex transitions. Keep local, server, and URL state
  separate; URL state in the URL.
- **Data & forms** — TanStack Query / Apollo + GraphQL Codegen; React Hook Form for forms
  and validation; optimistic updates and offline handling.
- **UI ecosystem** — Framer Motion for motion (reduced-motion aware), Tailwind or a
  CSS-in-JS solution per the existing system, Material-UI / Ant Design only if already in
  the design system.
- **SSR / SSG** — Next.js or Remix for server rendering, server components, streaming SSR,
  and correct hydration boundaries.

## Performance

- Targets: load <2s, time-to-interactive <3s, first contentful paint <1s; Core Web Vitals
  green (LCP, CLS, INP).
- Tools: `React.memo` at measured boundaries, code splitting, `React.lazy`, route-level
  splitting, virtual scrolling for long lists, bundle analysis (`@next/bundle-analyzer`,
  `vite-bundle-visualizer`, `source-map-explorer`).
- Measure before and after; never claim a score you did not observe.

## Testing

- React Testing Library + Jest/Vitest for behavior tests; hook testing via `renderHook`;
  Cypress or Playwright for E2E flows.
- Assert user-visible behavior, not implementation details.

## Process additions

1. Architecture: module and Nx-library boundaries, component structure, state ownership,
   routing, performance goals, test strategy, build config, deployment target.
2. Implement with tests alongside; keep components reusable and packaging shared.
3. Excel: hit the performance targets, keep the test suite green with measured coverage,
   enforce TS strict + ESLint/Prettier + conventional commits.
