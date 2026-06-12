# nx-init — INITIALIZE + CONFIGURE NX

> **Slug is identity.** Immutable. Legacy P1.

**Phase:** foundation · **Depends on:** checkpoint-branch · **Guard:** `bash .workflow/plans/nx-migration/scripts/guards/nx-init.sh`

---

## Goal

Nx is alive in the monorepo: `nx.json` (project graph, target defaults using
`@nx/js:tsc`, named inputs, cache, `release` block), `tsconfig.base.json` (root
path-alias registry for future libs/apps), module-boundary lint
(`@nx/enforce-module-boundaries` with `type:extension`/`type:lib`/`type:app`),
commitlint, and `pnpm-workspace.yaml` extended to host `apps/**`, `libs/**`,
`packages/**`. Existing pnpm workspaces and the existing test suite keep working.
This state enables every later lib/app/generator state.

---

## Semantic Distillation

- **Primitive:** CREATE `nx.json` + config — bootstrap the undifferentiated layer.
- **Reference Pattern:** `pnpm-workspace.yaml`, root `package.json`, ADR-0001
  §Layout mapping + §Architecture (tag scheme, target layout).
- **Delta Spec:** install nx as a **root devDependency only** ([inv:nx-dev-only]);
  write `nx.json` with target defaults, named inputs (production excludes tests),
  cache, and a `release` block (conventional-commits strategy);
  `tsconfig.base.json` (empty paths now, populated by later libs); ESLint config
  with the boundary rule; `commitlint.config.js`; extend `pnpm-workspace.yaml`.
  Do NOT move existing `extensions/` or `scripts/` here.
- **Invariants:** [inv:nx-dev-only]. See `[ref:nx-never-runtime-dep]`.
- **Validation:** `bash .workflow/plans/nx-migration/scripts/guards/nx-init.sh` —
  graph resolves, boundary rule present, release configured, workspace globs, suite green.

---

## Acceptance criteria

- [ ] **[nx-init.1]** `pnpm exec nx show projects` resolves (graph valid).
- [ ] **[nx-init.2]** `@nx/enforce-module-boundaries` appears in the eslint config.
- [ ] **[nx-init.3]** `nx.json` has a `release` block.
- [ ] **[nx-init.4]** `pnpm-workspace.yaml` includes `libs/**` and `apps/**`.
- [ ] **[nx-init.5]** Existing test suite still green (`pnpm test`).
- [ ] **[nx-init.6]** No extension/lib lists `nx`/`@nx/*` under `dependencies`
      ([inv:nx-dev-only]).

---

## Reservations

```text
read_only:  ["scripts",
             "extensions",
             "docs/decisions/0001-nx-and-self-hosting.md"]
mutates:    ["nx.json",
             "tsconfig.base.json",
             "eslint.config.js",
             "commitlint.config.js",
             "pnpm-workspace.yaml",
             "package.json"]
```

---

## Contract Promise

- **Added:** `nx.json`, `tsconfig.base.json`, `eslint.config.js` (boundary rule),
  `commitlint.config.js`; nx + commitlint devDeps in root `package.json`.
- **Modified:** `pnpm-workspace.yaml` (add `apps/**`, `libs/**`, `packages/**`),
  `package.json` (nx scripts + devDeps).
- **Deleted:** none.

---

## Commit points

- [ ] **After nx.json + tsconfig.base.json + workspace globs** — commit:
      `feat(nx-migration): nx-init — nx.json, target defaults, boundaries, release`
- [ ] **After the guard passes** (mandatory) — commit source + `state.json`/`dag.json`:
      `feat(nx-migration): nx-init complete — guard green`

---

## Notes for executor

- Nx is a devDependency only — do NOT add it to any extension's `dependencies`.
- Do NOT move/restructure existing `extensions/` or `scripts/` here (later states).
- Do NOT delete or disable any existing test.
- Capture `$?` directly; never pipe a tested exit ([inv:capture-exit]).

**Mandatory completion step.** Update `state.json` (status, timestamps, log) and
commit (R1) before stopping at the state boundary.
