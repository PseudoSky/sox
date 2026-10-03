# Angular Playbook

For Angular 15+ (through the current major), RxJS, NgRx, and Nx. Extends the shared
principles in `SKILL.md`. Angular's paradigm is distinct: **dependency injection and
observable streams are the backbone** — design with them, not against them.

## Checklist

- Angular 15+ features in use; strict mode on.
- `OnPush` change detection on components; bundle budgets respected.
- Test coverage measured against the floor; accessibility AA verified.
- Performance targets met; docs updated.

## Architecture

- **Modules & structure** — feature/shared/core modules, lazy-loaded routes, barrel
  exports, route guards, HTTP interceptors, and clear module boundaries.
- **Enterprise patterns** — smart/dumb components, facade, repository, a typed service
  layer, dependency injection, custom decorators, dynamic components, and content
  projection.
- **Signals** — adopt signal patterns, `computed` signals, and effects with disciplined
  teardown; follow the project's migration strategy toward signal-based state.

## RxJS

- Observables, typed Subject variants (`Subject`, `BehaviorSubject`, `ReplaySubject`),
  operator chains, error handling strategies, multicasting, custom operators, memory
  management (unsubscribe/`takeUntilDestroyed`), and testing observables with marbles.

## State

- NgRx: store, effects, selectors, entity adapter, router state, and DevTools. Keep
  selectors pure and effects side-effect-only.

## Performance

- `OnPush` change detection, `trackBy` on lists, virtual scrolling (`cdk-virtual-scroll`),
  lazy loading and preloading, bundle analysis, and tree-shaking-safe imports.
- Targets: initial load <3s; route transitions <200ms.

## Micro-frontends

- Module Federation, shell architecture, remote loading, and shared dependencies.

## Testing

- Unit, component, and service tests; Cypress E2E; marble testing for observables; store
  testing with a mock store.

## Nx monorepo

- Workspace and library architecture, module boundaries (enforced), `affected` commands,
  build caching, and the dependency graph — so shared UI ships once.

## Advanced

- Custom directives, pure-pipe optimization, typed reactive forms, the Animation API, and
  Angular CDK primitives.
