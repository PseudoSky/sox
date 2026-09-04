# Acceptance Criteria — BUG-WORKSPACE-GEN-006 (workspace-codegen-nx plugin generator emits stale configs)

- **Human ID:** BUG-WORKSPACE-GEN-006
- **Kind:** BUG · **Priority:** MEDIUM · **Status:** OPEN
- **Owner (AC author):** product agent · **Date:** 2026-08-04
- **Source:** `FEATURE.md` (worktree root) · **Pipeline monitor:** `TODO.md`
- **Reference package (the convention to mirror):** `packages/apigen/apigen-plugin-batch` (project.json + vite.config.ts)

## User story

As a repo developer who scaffolds a new plugin package with
`npx nx g @adhd/workspace-codegen-nx:plugin --name <x> --group <g> --nxLayer logic --platform node`,
I get a package that builds, tests, lints, and passes `verify-dist-load` with **zero manual repair**,
so that a scaffolded package matches the repo's post-migration conventions (in-tree dist, real
`tools/vite-plugins/*` imports, a runnable `test` target) exactly like `apigen-plugin-batch` does today.

## Acceptance criteria (each falsifiable; verification = real nx targets, exit codes, not grep)

### AC-1 — Generated `vite.config.ts` imports the real `tools/vite-plugins/*` modules
- **Given** the plugin generator scaffolds `--name ir-cache --group apigen --nxLayer logic --platform node`
- **Then** the emitted `vite.config.ts` contains `import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';`
  and `import { vitestPoolOptions } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';`,
  wires `external: externalizeRealDeps(__dirname)` in `rollupOptions`, and sets `poolOptions: vitestPoolOptions` in the `test` block.
- **And** the emitted config contains **no** occurrence of `tools/vite-external-deps.mjs` (the nonexistent path).
- **Falsifiable:** `npx nx test workspace-codegen-nx` exits 0 with a generator spec asserting the three positive strings and the one negative.
- **Reference:** `packages/apigen/apigen-plugin-batch/vite.config.ts:6,8,39,44`.

### AC-2 — Generated `project.json` + vite config emit IN-TREE dist (never workspace-root `dist/`)
- **Then** the emitted `project.json` `build.outputPath` is the package's own `dist` (i.e. `packages/<group>/<group>-plugin-<name>/dist`, `{projectRoot}/dist` form),
  and the emitted `vite.config.ts` sets `root: __dirname` and `build.outDir: 'dist'`.
- **And** neither the emitted `project.json` nor `vite.config.ts` contains `dist/packages/...` or `../../../dist/...` paths.
- **Falsifiable:** `npx nx build <scaffolded>` exits 0 and produces `{projectRoot}/dist/index.js`; `npx nx run <scaffolded>:assets` exits 0
  (the `assets` executor fails with `assets: no dist ... (build first)` iff the build did not land in `{projectRoot}/dist` — `tools/nx-plugins/assets/executors/copy/impl.js:26-28`).
- **Reference:** `packages/apigen/apigen-plugin-batch/project.json:26`, `vite.config.ts:11,22`.

### AC-3 — Generated `project.json` carries a runnable `test` target
- **Then** the emitted `project.json` has a `test` target: `@nx/vite:test` with `configFile` pointing at the emitted `vite.config.ts`
  (mirroring `apigen-plugin-batch/project.json:30-38`).
- **And** a freshly scaffolded plugin passes `npx nx test <scaffolded>` → exit 0 (generator emits a placeholder spec if the base scaffold emits none,
  so a fresh scaffold is green with no manual file additions).
- **Falsifiable:** `npx nx test <scaffolded>` exits 0; `npx nx show project <scaffolded> --json` lists a `test` target.
- **Reference:** `packages/apigen/apigen-plugin-batch/project.json:30-38`; FEATURE defect (c) — `vite.config` already carries a test block but no nx target invokes it.

### AC-4 — The FEATURE's exact reproduction needs zero manual repair end-to-end
- **Given** the exact FEATURE command: `npx nx g @adhd/workspace-codegen-nx:plugin --name ir-cache --group apigen --nxLayer logic --platform node`
- **Then**, with no manual edits, all of these exit 0: `npx nx build apigen-plugin-ir-cache`, `npx nx test apigen-plugin-ir-cache`,
  `npx nx lint apigen-plugin-ir-cache`, `npx nx run apigen-plugin-ir-cache:assets`, `npx nx run apigen-plugin-ir-cache:verify-dist-load`.
- **Falsifiable:** exit codes observed; this is the umbrella acceptance criterion that the three stale-artifact defects (FEATURE items 1-3) are gone together.

### AC-5 — Regression teeth: the generator spec suite asserts the NEW conventions and rejects the stale ones
- **Then** the updated generator spec suite (including the existing `src/generators/base/generator.spec.ts`) asserts AC-1/AC-2/AC-3's positive strings
  for `platform:node` and `platform:shared` scaffolds, and asserts the stale path `tools/vite-external-deps.mjs` and stale `dist/packages/`/`dist/entrypoint` layouts are **absent**.
- **And** the existing stale-path assertion at `src/generators/base/generator.spec.ts:44` is updated in the same commit as the fix
  (it currently asserts the bug; left untouched it flips red the moment the generator is fixed).
- **Falsifiable (teeth):** reverting the generator fix while keeping the new spec makes `npx nx test workspace-codegen-nx` exit non-zero.

### AC-6 — Same-file adjacent staleness: `scaffoldEntrypoint` also stops emitting pre-migration dist paths
- **Then** the entrypoint scaffold (`scaffoldEntrypoint`, `src/generators/shared/generator.ts:202-219`) no longer emits `outDir: '../../dist/entrypoint'`
  (workspace-root layout); its emitted `tsconfig.json`/`project.json` point build output at the entrypoint's own in-tree dist, consistent with how `entrypoint/apigen-cli`
  and `entrypoint/dispatch-cli` build today (`outputPath` `entrypoint/<name>/dist`).
- **And** the entrypoint generator spec asserts the new path and the absence of `dist/entrypoint`.
- **Falsifiable:** `npx nx test workspace-codegen-nx` exits 0 including an entrypoint-scaffold assertion; a dry-run entrypoint scaffold emits no `../../dist/entrypoint` string.
- **Note:** FEATURE.md scopes the fix to the plugin generator; AC-6 pulls the adjacent same-root-cause staleness in the same source file into the same pass
  (marginal cost ≈ zero; keeps the generator file free of any pre-migration layout).

### AC-7 — Shared-globals cache hashing covers the newly-emitted shared imports
- **Then** `nx.json` `sharedGlobals` (currently `tools/vite-plugins/externalize.mjs`, `copy-readme.mjs`, `tools/nx-plugins/build/**`, `tools/nx-plugins/lint/**`, `.eslintignore` — `nx.json:26-32`)
  also lists `{workspaceRoot}/tools/vite-plugins/vitest-pool-defaults.mjs`, so edits to the pool defaults invalidate every project whose emitted config imports it.
- **Falsifiable:** `nx.json` contains the `vitest-pool-defaults.mjs` sharedGlobal entry; a touch of that file invalidates a dependent project's `test` cache.

### AC-8 — Docs reflect the emitted template; no surviving stale-path guidance in the generator package
- **Then** any generator documentation that describes the emitted template (README of `workspace-codegen-nx`, if present) states the real `tools/vite-plugins/*` imports
  and in-tree dist; nothing in `packages/workspace/workspace-codegen-nx/**` (source, specs, docs) references `tools/vite-external-deps.mjs` or a workspace-root `dist/packages|dist/entrypoint` build layout.
- **Falsifiable:** no *emitted-template* reference to `tools/vite-external-deps.mjs` or a workspace-root `dist/packages|dist/entrypoint` layout survives — verified by inspecting every emitted-file template (`templates.ts`) and the real-scaffold output. (Correction 2026-08-04, per FU-04: a literal grep-zero is not the gate, because the AC-5 negative-control assertions must name the stale string to assert its absence, and source comments document the historical bug; see `VERIFICATION.md` AC-8 adjudication.)
- **Historical records exempt:** `CHANGELOG.md`/`BACKLOG.md` entries describing the 2026-07-20 creation of `tools/vite-external-deps.mjs` are history, not emitted-template guidance — left untouched.

## Traceability (FEATURE defect → AC)

| FEATURE.md defect | Acceptance criteria |
|---|---|
| 1. stale `tools/vite-external-deps.mjs` import (file does not exist) | AC-1, AC-5 |
| 2. pre-migration workspace-root dist (`dist/packages/...` outputPath + `../../../dist/...` outDir; `assets`/`verify-dist-load` fail) | AC-2, AC-4, AC-5 |
| 3. no `test` target in generated `project.json` (vite.config test block orphaned) | AC-3, AC-4, AC-5 |
| — adjacent: entrypoint scaffold `../../dist/entrypoint` (same file, same family) | AC-6 |
| — adjacent: `vitest-pool-defaults.mjs` missing from `nx.json` sharedGlobals | AC-7 |
| — hygiene: stale-path guidance in generator package | AC-8 |

## Non-goals (explicitly out of scope for this pass)

- Migrating already-scaffolded packages (e.g. a pre-existing broken `apigen-plugin-ir-cache` worktree) — this fixes the generator for future scaffolds; existing packages are repaired by re-scaffolding or their owning teams.
- The historical `tools/vite-external-deps.mjs` mention in CHANGELOG.md/BACKLOG.md records.
- Repo-wide stale `dist/...` references in unrelated docs (e.g. `entrypoint/dispatch-cli/docs/marketing/*`, `docs/plan/*`) — pre-existing doc debt, not generated by this generator; candidate for FOLLOWUPS.

## Verification protocol (how stage 4 / review proves each AC)

1. Every functional AC is proven by running the real nx target and keying on the process exit code (`npx nx build|test|lint|run <project>:assets|run <project>:verify-dist-load`).
2. AC-4 is proven by a real (or `--dry-run` + in-memory-tree equivalent per architect's spec) scaffold of `apigen-plugin-ir-cache` and running all five gates; the review agent records each exit code in `VERIFICATION.md`.
3. AC-5's teeth are proven by the review agent reverting the generator fix (or the spec's negative-control variant) and confirming `npx nx test workspace-codegen-nx` goes red.
4. No AC is proven by `grep -q passed` on stdout (repo rule: trust exit codes).
