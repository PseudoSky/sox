# Implementation Spec — BUG-WORKSPACE-GEN-006: `@adhd/workspace-codegen-nx:plugin` emits stale configs

- **Bug:** `FEATURE.md:1-19` · **Contract:** `docs/acceptance.md` (AC-1..AC-13) · **Worktree:** `/Users/nix/dev/sdlc-experiments/arm-rf/rf-run` (branch `arm-rf-manual-20260803`, HEAD `6f4d2c38`)
- **Implementer:** typescript agent (repo `AGENTS.md` applies). This spec leaves zero ambiguity: every path, import specifier, and interface signature is final.

## 1. Overview

Fix the shared scaffold codepath of `workspace-codegen-nx` so every `plugin` (and inherited `node`/`shared` vite) scaffold ships: (a) the real `tools/vite-plugins/externalize.mjs` + `vitest-pool-defaults.mjs` imports and `poolOptions` wiring, (b) in-tree `{projectRoot}/dist` build output in both `vite.config.ts` (`outDir`) and `project.json` (`outputPath`), and (c) an explicit `@nx/vite:test` `test` target. All three live in `packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts`; the plugin tier (`plugin/generator.ts`) delegates there unchanged. The fix is proven by an updated `base/generator.spec.ts` (the stale-path assertion flips to the new path and becomes a negative-control guard), a new committed `plugin/generator.spec.ts` (in-memory Tree with teeth), and the probe-package build/test/verify flow from `docs/acceptance.md` §4.

## 2. Resolved questions

| # | Question | Decision | Rationale |
|---|---|---|---|
| Q1 | Test-target patch mechanism in the generator | New `patchProjectJsonTargets(tree, dir)` JSON-patch function in `shared/generator.ts` (house style: `readJson`/`writeJson`, same as `patchReleasePublish` at `generator.ts:172-181`), called from `scaffoldGenerator` after `patchViteConfig` (`generator.ts:117`). It **overwrites** `targets.build` and sets `targets.test` to the reference shapes (see §3). | The `@nx/vite` vitest generator only adds a `test` target when the `@nx/vite/plugin` is **not** registered (`node_modules/@nx/vite/src/generators/vitest/vitest-generator.js:47-52`); this repo registers it (`nx.json:60-67`), so the target never lands — the exact observed bug (`FEATURE.md:15`). The raw `@nx/js` build target (`node_modules/@nx/js/src/generators/library/library.js:130-139`) also carries `main`/`tsConfig`/`assets` options the reference lacks and an `outputPath` of `dist/packages/<group>/<pkg>` (`library.js:568-577`) — overwrite-wholesale removes both problems at once. |
| Q2 | vitest-pool-defaults / coverage parity | Add `import { vitestPoolOptions } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';` and `poolOptions: vitestPoolOptions` (first key of the `test` block) in the **same `platform === 'node' \|\| platform === 'shared'` branch** as the externalize patch. Leave `coverage` as `@nx/vite` generates it (`provider: 'v8'`, `reportsDirectory: '../../../coverage/<projectRoot>'`) and mirror it in `project.json` `test.outputs` as `{workspaceRoot}/coverage/<projectRoot>` so nx's cached outputs match the coverage dir. | The healthy reference's load-bearing test-block fields are `poolOptions`/`environment`/`include` (`apigen-plugin-batch/vite.config.ts:44,49,50`). The reference's `coverage/packages/apigen/plugins/batch` path segment (`:53`) is a hand-edit artifact, not load-bearing; the generated pair (`../../../coverage/<projectRoot>` + `{workspaceRoot}/coverage/<projectRoot>`) is internally consistent, which is what nx caching requires. Scoping poolOptions to node/shared matches AC-3's "where applicable" language and keeps `platform:browser` untouched (`base/generator.spec.ts:66-80` stays green). |
| Q3 | Orphaned `tools/nx-plugins/verify-dist-load/plugin.js` | **Deferred to a separate ticket.** No code touched. The live `verify-dist-load` wiring is the inference in `tools/nx-plugins/build/plugin.js:89` (registered `nx.json:88`); `verify-dist-load/plugin.js` is not registered in `nx.json:34-99` and references a non-existent `scripts/verify-dist-load.mjs` (dead code). Matches `docs/acceptance.md:125`. |
| Q4 | Orphaned `tools/nx-plugins/` references in stale comments (~17 `vite.config.ts` files) | **Deferred.** Comment-only debt, no behavior impact (`docs/acceptance.md:124`). Exception: the stale comment *inside the spec file we are already editing* (`base/generator.spec.ts:11`) is corrected in the same commit to keep the file coherent. |
| Q5 | `base/generator.spec.ts:44` stale-path assertion | **Updated in the same commit** to `import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';`. The `platform:browser` case (`base/generator.spec.ts:66-80`) needs **no change**: poolOptions/vitest-pool imports are scoped to node/shared (Q2), so `not.toContain('externalizeRealDeps')` and `external: []` remain true. | AC-12/AC-13: the suite goes red if the template fix and the spec update are not shipped together (`docs/acceptance.md:107,117`). |
| Q6 | Regression-spec location and how to get "teeth" on the test-target artifact | New `plugin/generator.spec.ts`. **Crucially**, `beforeEach` writes `@nx/vite/plugin` into the in-memory tree's `nx.json` (`plugins: [{ plugin: '@nx/vite/plugin', options: { buildTargetName: 'build', testTargetName: 'test', serveTargetName: 'serve', previewTargetName: 'preview', serveStaticTargetName: 'serve-static' } }]` — mirroring `nx.json:60-67`) **before** running the generator. | In a bare `createTreeWithEmptyWorkspace()` (no plugins), the `@nx/vite` vitest generator *adds* a `test` target (`vitest-generator.js:47-52`), so a naive test-target assertion would pass **pre-fix** (no teeth). Registering the plugin reproduces the real worktree condition: pre-fix the generated `project.json` has **no** `test` target and `outputPath: "dist/packages/..."`, so all three artifact assertions fail when the fix is reverted. `base/generator.spec.ts` and `types/generator.spec.ts` are **not** changed in this way — they keep their current empty-workspace pattern. |
| Q7 | Does `environment: 'node'` / the vitest `include` pattern need a patch? | **No.** `@nx/js` libraryGenerator defaults `testEnvironment` to `'node'` (`node_modules/@nx/js/src/generators/library/schema.json:71`) and `@nx/vite` emits the exact AC-3 include pattern (`node_modules/@nx/vite/src/utils/generator-utils.js:339`). The plugin spec asserts them as regression guards only. |
| Q8 | Does the scaffolded package have a runnable test file for AC-10? | **Yes, already.** `@nx/js` writes `src/lib/<pkg>.spec.ts`; it is deleted only when `unitTestRunner === 'none'` (`library.js:345-348`), and vite bundling defaults it to `vitest` (`library.js:491-493`). The `test` include `src/**/*.{test,spec}...` (`vite.config.ts:31` of the generator project, and the generated one) matches it. |
| Q9 | Entrypoint safety of the new project.json patch | `patchProjectJsonTargets` must **only** act when `projectJson.targets?.build?.executor === '@nx/vite:build'`; otherwise early-return. | `scaffoldGenerator` runs its post-gen patches for every tier including `entrypoint`, whose `project.json` build uses `nx:run-commands` (`shared/generator.ts:202-219`). Overwriting that with `@nx/vite:build` would break entrypoint scaffolds. `patchViteConfig` is already entrypoint-safe via the `tree.exists(vitePath)` guard (`generator.ts:127-128`); the new function needs the executor guard. |
| Q10 | `--access public` / `--publish true` variants | No changes. Schema already accepts them (`plugin/schema.json:27-37`); output not verified (`docs/acceptance.md:129`). |

## 3. Exact file changes

Blast radius (gitnexus): `patchViteConfig` upstream → only `scaffoldGenerator` (risk LOW); `scaffoldGenerator` upstream → all 9 tier generators (`base`/`core`/`engine`/`store`/`plugin`/`generator`/`query`/`types`/`entrypoint`), risk MEDIUM. Acceptance verification is scoped to the `plugin` tier; other tiers inherit the corrected templates via the shared codepath but get no new acceptance checks (`docs/acceptance.md:123`).

### 3.1 `packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts` (modify) — AC-2, AC-3, AC-4, AC-5, AC-9

**(a) Call site** — after line 117 (`patchViteConfig(tree, projectRoot, platform);`) add:

```ts
  patchProjectJsonTargets(tree, projectRoot);
```

**(b) `patchViteConfig` — outDir fix (new block at the top of the function, before the existing `emptyOutDir` insert at `generator.ts:133-135`)** — replaces the pre-migration workspace-root `outDir` (`../../../dist/packages/<group>/<pkg>`, emitted by `node_modules/@nx/vite/src/utils/generator-utils.js:284`) with the in-tree `'dist'`. Idempotent (no match when already `'dist'`), and it must run **first** so the `emptyOutDir` regex (`generator.ts:134`) and the copy-readme plugin's outDir read (`generator.ts:139`) both see `'dist'`:

```ts
  // In-tree dist (BUG-WORKSPACE-GEN-006): the @nx/vite template emits a
  // workspace-root escape `outDir: '../../../dist/packages/...'`; the repo
  // migrated to {projectRoot}/dist (see apigen-plugin-batch/vite.config.ts:22).
  content = content.replace(
    /outDir:\s*['"]\.\.\/(?:\.\.\/)+dist[^'"]*['"]/,
    `outDir: 'dist'`
  );
```

**(c) `patchViteConfig` — replace the node/shared branch (current `generator.ts:159-167`)** so the import points at the real tools and the test block gets pool options. The regex anchor (the `nxViteTsPaths` import line) is unchanged; only the injected import path changes, and a second import + `poolOptions` insert are added **inside the same branch**:

```ts
  if (platform === 'node' || platform === 'shared') {
    if (!content.includes('externalizeRealDeps')) {
      content = content.replace(
        /(import \{ nxViteTsPaths \} from '@nx\/vite\/plugins\/nx-tsconfig-paths\.plugin';\n)/,
        `$1import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';\nimport { vitestPoolOptions } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';\n`
      );
    }
    content = content.replace(/external:\s*\[\]/, 'external: externalizeRealDeps(__dirname)');
    if (!content.includes('poolOptions: vitestPoolOptions')) {
      content = content.replace(/(test:\s*\{\n)/, `$1    poolOptions: vitestPoolOptions,\n`);
    }
  }
```

- Export names verified: `externalizeRealDeps` (`tools/vite-plugins/externalize.mjs:58`) and `vitestPoolOptions` (`tools/vite-plugins/vitest-pool-defaults.mjs:32`). Import specifiers are relative file paths (matches the healthy reference `apigen-plugin-batch/vite.config.ts:6,8` and the hand-fixed `apigen-plugin-logger/vite.config.ts:6,8`); no package-name import is involved.
- The `poolOptions` regex cannot collide with the `include` pattern `{test,spec}` (no `test:` colon there) and is guarded for idempotency.

**(d) New function `patchProjectJsonTargets`** (place after `patchViteConfig`, before `patchReleasePublish`; same style as `patchReleasePublish` at `generator.ts:172-181`):

```ts
function patchProjectJsonTargets(tree: Tree, dir: string) {
  const projectPath = joinPathFragments(dir, 'project.json');
  if (!tree.exists(projectPath)) return;
  const projectJson = readJson(tree, projectPath);
  // Entrypoint scaffolds use `nx:run-commands` — never overwrite those.
  if (projectJson?.targets?.build?.executor !== '@nx/vite:build') return;
  projectJson.targets = projectJson.targets ?? {};
  projectJson.targets.build = {
    executor: '@nx/vite:build',
    outputs: ['{options.outputPath}'],
    options: {
      outputPath: `${dir}/dist`,
      emptyOutDir: true,
    },
  };
  projectJson.targets.test = {
    executor: '@nx/vite:test',
    outputs: [`{workspaceRoot}/coverage/${dir}`],
    options: {
      configFile: `${dir}/vite.config.ts`,
    },
  };
  writeJson(tree, projectPath, projectJson);
}
```

- Shape matches the reference `apigen-plugin-batch/project.json:22-38` (build) and `:30-38` (test). The raw `@nx/js` build target (`library.js:130-139`) is replaced wholesale, dropping `main`/`tsConfig`/`assets`/stale `outputPath`; the `@nx/vite:build` executor does not need them (`node_modules/@nx/vite/src/executors/build/build.impl.js:33` falls back to `getProjectTsConfigPath` when `tsConfig` is absent).
- `lint` and `nx-release-publish` targets are left untouched (`patchReleasePublish` at `generator.ts:118,172-181` keeps its job of adding `dependsOn: ['build','test']`).
- `test.outputs` = `{workspaceRoot}/coverage/<dir>` is the same directory the generated vite `coverage.reportsDirectory` (`../../../coverage/<dir>`) resolves to, so nx caching and coverage land in the same place (Q2).

### 3.2 `packages/workspace/workspace-codegen-nx/src/generators/base/generator.spec.ts` (modify) — AC-12, AC-13

- **Line 44**: change the asserted import string
  `"import { externalizeRealDeps } from '../../../tools/vite-external-deps.mjs';"` →
  `"import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';"`.
- **Line 11** (doc comment): update `tools/vite-external-deps.mjs` → `tools/vite-plugins/externalize.mjs`.
- **No other changes.** The `platform:node` case (`:31-49`) still sees the externalize import + `external: externalizeRealDeps(__dirname)` (still emitted, now from the right path); the `platform:shared` case (`:51-64`) still sees `external:`; the `platform:browser` case (`:66-80`) is untouched because the new vitest-pool additions are node/shared-scoped (Q2) — `not.toContain('externalizeRealDeps')` and `external: []` stay green.
- This file becomes the negative-control regression guard: reintroducing the stale import path turns this suite red (AC-13, `docs/acceptance.md:206`).

### 3.3 `packages/workspace/workspace-codegen-nx/src/generators/plugin/generator.spec.ts` (create) — AC-13

New committed vitest spec (see §4 for the full assertion list). Pattern: `createTreeWithEmptyWorkspace()` from `@nx/devkit/testing` (same as `base/generator.spec.ts:20` / `types/generator.spec.ts:15`), **plus** the `@nx/vite/plugin` registration in the tree's `nx.json` in `beforeEach` (Q6), then drive the real `pluginGenerator` (`./generator`) with `{ name: 'ac-probe', group: 'apigen', nxLayer: 'logic', platform: 'node' }` and read generated files at `packages/apigen/apigen-plugin-ac-probe/…`. It runs by default (matches the project's vitest include `src/**/*.{test,spec}...` — `packages/workspace/workspace-codegen-nx/vite.config.ts:31`) and is deterministic (in-memory, no filesystem).

### 3.4 Unchanged (verified — do not touch)

- `packages/workspace/workspace-codegen-nx/src/generators/plugin/generator.ts:13-16` — thin delegate to `scaffoldGenerator`; no change.
- `packages/workspace/workspace-codegen-nx/src/generators/plugin/schema.json` — schema already correct (`required: name/group/nxLayer/platform`, `access`/`publish` optional).
- `packages/workspace/workspace-codegen-nx/src/generators/types/generator.spec.ts` — established pattern reference; no change.
- `packages/apigen/apigen-plugin-batch/{project.json,vite.config.ts}` and `packages/apigen/apigen-plugin-logger/vite.config.ts` — healthy references; **read-only**.
- `tools/vite-plugins/*.mjs`, `tools/nx-plugins/**` — no changes (Q3/Q4).

## 4. Package and test structure

### 4.1 Spec files

| Path | Change | Asserts |
|---|---|---|
| `src/generators/base/generator.spec.ts` | modify | new import path (line 44) — the stale-path negative-control guard; browser case untouched |
| `src/generators/plugin/generator.spec.ts` | create | the three AC-13 artifacts + AC-3 test-block wiring, with teeth |

### 4.2 `plugin/generator.spec.ts` — exact assertions (each is a file-content read on the in-memory tree)

`const root = 'packages/apigen/apigen-plugin-ac-probe';` after `await pluginGenerator(tree, { name: 'ac-probe', group: 'apigen', nxLayer: 'logic', platform: 'node' });`

1. **Import path (AC-2/AC-13.1):** `tree.read(\`${root}/vite.config.ts\`, 'utf-8')` contains `'../../../tools/vite-plugins/externalize.mjs'`, **does not** contain `'tools/vite-external-deps.mjs'`, and contains `'external: externalizeRealDeps(__dirname)'`. Reverting the template import path fails this assertion.
2. **Vitest pool + environment (AC-3):** contains `'../../../tools/vite-plugins/vitest-pool-defaults.mjs'`, `'poolOptions: vitestPoolOptions'`, `"environment: 'node'"`, and the include pattern `'src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'`.
3. **In-tree vite outDir (AC-4/AC-13.2):** contains `outDir: 'dist'` and **does not** match `/\.\.\/dist/` (no `../../../dist` escape).
4. **In-tree project.json outputPath (AC-5/AC-13.2):** `readJson(tree, \`${root}/project.json\`)` → `targets.build.executor === '@nx/vite:build'` and `targets.build.options.outputPath === 'packages/apigen/apigen-plugin-ac-probe/dist'`; assert `JSON.stringify(projectJson)` does **not** contain `'dist/packages/'`. Reverting the outputPath patch fails this assertion.
5. **Test target (AC-9/AC-13.3):** `targets.test.executor === '@nx/vite:test'` and `targets.test.options.configFile === 'packages/apigen/apigen-plugin-ac-probe/vite.config.ts'`. Because `@nx/vite/plugin` is registered in the tree (Q6), pre-fix there is **no** `test` target → reverting the patch fails this assertion.

Teeth proof (required during development, `docs/acceptance.md:206`): temporarily revert one template line (`../../../tools/vite-plugins/externalize.mjs` → `../../../tools/vite-external-deps.mjs`, or the outputPath/test-target patch), run `npx nx test workspace-codegen-nx`, confirm red, restore.

### 4.3 Verification commands (run from `/Users/nix/dev/sdlc-experiments/arm-rf/rf-run`; **never** `--skip-nx-cache` — repo rule)

Generator project (AC-12):

```bash
npx nx build workspace-codegen-nx     # exit 0
npx nx test workspace-codegen-nx      # exit 0 — runs updated base spec + new plugin spec
npx nx lint workspace-codegen-nx      # exit 0
```

Probe-package flow (AC-1a → AC-11; use a unique probe name, e.g. `ac-probe`; `--dry-run` first, then real generation; cleanup afterwards):

```bash
npx nx g @adhd/workspace-codegen-nx:plugin --name ac-probe --group apigen --nxLayer logic --platform node --dry-run   # AC-1a: exit 0
npx nx g @adhd/workspace-codegen-nx:plugin --name ac-probe --group apigen --nxLayer logic --platform node              # only mutating step
# read generated files (AC-1b, AC-2..AC-5, AC-9): packages/apigen/apigen-plugin-ac-probe/{project.json,package.json,vite.config.ts}; tsconfig.base.json mapping
npx nx build apigen-plugin-ac-probe                          # AC-6: exit 0
test -f packages/apigen/apigen-plugin-ac-probe/dist/index.js    # AC-6
test -f packages/apigen/apigen-plugin-ac-probe/dist/index.mjs   # AC-6
test -f packages/apigen/apigen-plugin-ac-probe/dist/index.d.ts  # AC-6
test ! -d dist/packages/apigen/apigen-plugin-ac-probe           # AC-6: stale layout absent
npx nx run apigen-plugin-ac-probe:assets                # AC-7: exit 0 (was: assets: no dist … build first)
npx nx run apigen-plugin-ac-probe:verify-dist-load      # AC-8: exit 0 (drives build + dist-manifest + in-tree dist load)
npx nx test apigen-plugin-ac-probe                      # AC-10: exit 0, ≥1 spec file ran
npx nx lint apigen-plugin-ac-probe                      # AC-11: exit 0
# mandatory cleanup
rm -rf packages/apigen/apigen-plugin-ac-probe
git restore tsconfig.base.json
git status --short   # no stray changes
```

## 5. Out of scope

Mirrors `docs/acceptance.md:119-129`:

- Other generator tiers (`base`/`core`/`engine`/`store`/`generator`/`query`/`types`/`entrypoint`): they inherit the corrected shared templates, but acceptance is scoped to `plugin`; only their existing specs must stay green (AC-12/AC-13).
- Stale comment references to `tools/vite-external-deps.mjs` in ~17 existing `vite.config.ts` files — comment-only debt; no behavior impact. (Exception: the comment inside `base/generator.spec.ts:11`, a file we are already editing, is corrected.)
- **Orphaned `tools/nx-plugins/verify-dist-load/plugin.js`** — references a non-existent `scripts/verify-dist-load.mjs` and pre-migration cache inputs; not registered in `nx.json`; dead code. **Explicitly deferred to a separate ticket** (do not delete or repair here).
- Historical text in `BACKLOG.md:174` (INVESTIGATION-BUILD-TOOL-001 notes) — leave as-is.
- Docs rewrites (AGENTS.md, `docs/contributing/`) and CHANGELOG/RELEASE entries — the implementer's normal duties, not acceptance-gated.
- Unrelated package health (`BUG-WORKSPACE-NO-LINKING-001`, publish-pipeline targets, non-plugin packages' build/test state).
- `--access public` / `--publish true` variants — accepted by the schema, output not verified.
