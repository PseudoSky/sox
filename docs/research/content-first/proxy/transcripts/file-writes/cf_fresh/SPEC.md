# Implementation Spec — BUG-WORKSPACE-GEN-006: workspace-codegen-nx generator emits stale configs

- **Author:** architect · **Date:** 2026-08-04 · **Source:** `FEATURE.md` + `ACCEPTANCE.md` (AC-1..AC-8) + `TODO.md`
- **Implementer:** typescript agent (next) · **Verifier:** review agent (after)
- **Reference convention (mirror EXACTLY):** `packages/apigen/apigen-plugin-batch/{project.json,vite.config.ts}`; second confirm: `packages/apigen/apigen-plugin-jsonschema/{project.json,vite.config.ts}` (hand-migrated sibling).

## Summary

Replace the fragile regex-surgery approach in `shared/generator.ts` (`patchViteConfig`, `patchReleasePublish`) with **canonical template emission**: after `@nx/js:libraryGenerator` scaffolds a package, the generator OVERWRITES `vite.config.ts` with a deterministic, parameterized copy of the `apigen-plugin-batch` template (in-tree dist, real `tools/vite-plugins/*` imports) and REWRITES `project.json` targets (build outputPath → `{projectRoot}/dist`, emit a `test` target, emit `nx-release-publish`). Same root-cause family: `scaffoldEntrypoint`'s tsconfig `outDir` moves in-tree. Rationale: the generator has drifted from repo conventions exactly because it string-patches whatever `@nx/js:libraryGenerator` emits; owning the emitted template makes output deterministic and stops the drift class, not just this instance.

## Files

| Path | Change | Read tokens | Output tokens |
|------|--------|-------------|---------------|
| `packages/workspace/workspace-codegen-nx/src/generators/shared/templates.ts` | create | 0 | ~180 |
| `packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts` | modify | ~230 (already read) | ~160 |
| `packages/workspace/workspace-codegen-nx/src/generators/base/generator.spec.ts` | modify | ~80 (already read) | ~40 |
| `packages/workspace/workspace-codegen-nx/src/generators/plugin/generator.spec.ts` | create | 0 | ~90 |
| `packages/workspace/workspace-codegen-nx/src/generators/entrypoint/generator.spec.ts` | create | 0 | ~50 |
| `nx.json` | modify | ~10 (already read) | ~3 |

## Interface changes

### New: `src/generators/shared/templates.ts`

Exports one builder (pure function of `projectRoot`, `projectName`, `platform`, `rel` = relative path from `projectRoot` to workspace root, e.g. `../../../` for `packages/<g>/<pkg>`, `../../` for `entrypoint/<name>`):

```typescript
export function canonicalViteConfig(opts: {
  projectRoot: string;   // e.g. 'packages/apigen/apigen-plugin-batch'
  projectName: string;   // e.g. 'apigen-plugin-batch'
  platform: 'node' | 'browser' | 'shared';
  rel: string;           // e.g. '../../../'
}): string;
```

Returns the FULL `vite.config.ts` text (not a patch). Node/shared platform (this is the file verbatim, parameterized):

```ts
/// <reference types='vitest' />
import { defineConfig } from 'vite';
import dts from 'vite-plugin-dts';
import * as path from 'path';
import { nxViteTsPaths } from '@nx/vite/plugins/nx-tsconfig-paths.plugin';
import { externalizeRealDeps } from '<rel>tools/vite-plugins/externalize.mjs';
import { vitestPoolOptions } from '<rel>tools/vite-plugins/vitest-pool-defaults.mjs';

export default defineConfig({
  root: __dirname,
  cacheDir: '<rel>node_modules/.vite/<projectRoot>',
  plugins: [
    nxViteTsPaths(),
    dts({ entryRoot: 'src', tsconfigPath: path.join(__dirname, 'tsconfig.lib.json') }),
  ],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    reportCompressedSize: true,
    commonjsOptions: { transformMixedEsModules: true },
    lib: { entry: 'src/index.ts', name: '<projectName>', fileName: 'index', formats: ['es', 'cjs'] },
    rollupOptions: { external: externalizeRealDeps(__dirname) },
  },
  test: {
    poolOptions: vitestPoolOptions,
    globals: true,
    cache: { dir: '<rel>node_modules/.vitest' },
    environment: 'node',
    include: ['src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}'],
    reporters: ['default'],
    coverage: { reportsDirectory: '<rel>coverage/<projectRoot>', provider: 'v8' },
  },
});
```

Browser platform: same file but `rollupOptions.external` omitted (leave libraryGenerator's `external: []` semantics — browser libs are consumed by an app bundler), and the `test` block keeps vitest defaults minus `poolOptions`/`environment: 'node'` (browser libs may use jsdom via their own setup; do not invent one). In-tree `root`/`outDir` apply to ALL platforms.

Also export the canonical project.json target shape (plain data, merged into the libraryGenerator-emitted `project.json` by the generator):

```typescript
export function canonicalTargets(projectRoot: string): {
  build: { executor: '@nx/vite:build'; outputs: ['{options.outputPath}'];
           options: { outputPath: '<projectRoot>/dist'; emptyOutDir: true } };
  test:  { executor: '@nx/vite:test'; outputs: ['{workspaceRoot}/coverage/<projectRoot>'];
           options: { configFile: '<projectRoot>/vite.config.ts' } };
  'nx-release-publish': { dependsOn: ['build','test','verify-dist-load','dist-manifest','publish-hygiene'];
           executor: '@nx/js:release-publish'; options: { packageRoot: '{projectRoot}/dist' } };
};
```

### Modify: `src/generators/shared/generator.ts`

- **`patchViteConfig` (lines 126-170) → replaced** by: `tree.write(vitePath, canonicalViteConfig({ projectRoot, projectName, platform, rel }))`. `rel` = `'../../../'` for `packages/<g>/<pkg>` (depth 3), `'../../'` for `entrypoint/<name>` (depth 2). DELETE the regex body entirely (import-replace, `external: []` replace, copy-readme injection, `emptyOutDir` injection).
- **`patchReleasePublish` (lines 172-181) → replaced** by: merge `canonicalTargets(projectRoot)` into the emitted `project.json` `targets` (build/test/nx-release-publish), preserving any other targets libraryGenerator emitted (lint, assets globs). If libraryGenerator did NOT emit a `lint` target, add `{ "lint": { "executor": "@nx/eslint:lint" } }` (mirrors batch — required by AC-4's `nx lint` gate).
- **Emit a placeholder spec** (AC-3): after scaffolding, write `<projectRoot>/src/lib/<name>.spec.ts` with `describe('<name>', () => { it('sanity', () => { expect(true).toBe(true); }); });` so a fresh scaffold passes `nx test` (vitest exits non-zero when zero test files match).
- **`scaffoldEntrypoint` (lines 202-219)**: change tsconfig `outDir` from `'../../dist/entrypoint'` → `'dist'` (in-tree; tsconfig-relative paths resolve against the entrypoint dir, so `tsc -p <root>/tsconfig.json` emits to `<entrypoint>/dist`); add `"outputs": ["{projectRoot}/dist"]` to the project.json `build` target so nx tracks the in-tree output. Keep the `nx:run-commands` tsc executor as-is (executor choice is out of scope).
- Keep unchanged: tags/name/sourceRoot rewrite (89-104), tsconfig.base.json paths (106-114), `ensureReadme` (183-190), `patchEslintrc` (192-200), `patchTsconfigLib` (221-229), `formatFiles`.

## Behavioral changes

- **Plugin/base/core/engine/store/query/generator scaffolds, platform node/shared:** emitted `vite.config.ts` now has `root: __dirname`, `build.outDir: 'dist'`, `external: externalizeRealDeps(__dirname)` (from the REAL `tools/vite-plugins/externalize.mjs`), `poolOptions: vitestPoolOptions` (from `tools/vite-plugins/vitest-pool-defaults.mjs`); emitted `project.json` has build outputPath `{projectRoot}/dist`, a `test` target (`@nx/vite:test` → the same vite.config), and `nx-release-publish` with `packageRoot: {projectRoot}/dist` + full dependsOn. No `tools/vite-external-deps.mjs`, no `dist/packages/...`, no `../../../dist/...` anywhere in emitted output. (Note: cacheDir/coverage paths are mechanically derived from projectRoot; the batch reference's `plugins/batch` cacheDir string is a legacy artifact and is NOT reproduced.)
- **Platform browser scaffolds:** same in-tree `root`/`outDir`/outputPath normalization; no externalize import; no pool override.
- **Entrypoint scaffolds:** build output lands at `entrypoint/<name>/dist` (in-tree) instead of workspace-root `dist/entrypoint`; `project.json` declares `outputs` so nx cache tracks it.
- **Regression teeth:** `base/generator.spec.ts:44` currently asserts the STALE path `'../../../tools/vite-external-deps.mjs'` — update it in the SAME commit (it encodes the bug and flips red the moment the generator is fixed).

## Independent segments

### Segment A: `src/generators/shared/templates.ts` (create)

- **Files:** `packages/workspace/workspace-codegen-nx/src/generators/shared/templates.ts`
- **Dependencies:** none.
- **Read tokens:** 0 — copy the two reference files' shapes (batch vite.config.ts:1-57, project.json:22-55) and parameterize.
- **Output tokens:** ~180.
- **Required context:** none beyond the interface block above.

### Segment B: `src/generators/shared/generator.ts` (modify)

- **Files:** `shared/generator.ts` (lines 34-124 keep; 126-181 replace; 202-219 edit)
- **Dependencies:** Segment A (import `canonicalViteConfig`, `canonicalTargets`).
- **Read tokens:** 0 — full file already read this session (see `TODO.md` verified facts).
- **Output tokens:** ~160.
- **Required context:** the file's current structure (read it if a fresh implementer: lines 1-231).

### Segment C: spec suite (base modify + plugin/entrypoint create)

- **Files:** `base/generator.spec.ts` (modify line 44 + add negative assertions), `plugin/generator.spec.ts` (create), `entrypoint/generator.spec.ts` (create)
- **Dependencies:** Segment B (specs drive the fixed generator).
- **Read tokens:** ~80 (base spec already read; plugin/entrypoint specs mirror its structure).
- **Output tokens:** ~180.
- **Required context:** `base/generator.spec.ts:1-81` as the pattern (createTreeWithEmptyWorkspace + drive generator + assert emitted file strings).

### Segment D: `nx.json` sharedGlobals (modify)

- **Files:** `nx.json` (sharedGlobals array, lines 26-32)
- **Dependencies:** none (AC-7).
- **Read tokens:** 0.
- **Output tokens:** ~3.
- **Required context:** append `"{workspaceRoot}/tools/vite-plugins/vitest-pool-defaults.mjs"` after the existing `externalize.mjs` entry (line 27).

## Execution strategies

### Segment A — templates.ts

1. Copy the exact shape of `packages/apigen/apigen-plugin-batch/vite.config.ts` (lines 1-57) and parameterize: replace `packages/apigen/apigen-plugin-batch` with `<projectRoot>` (cacheDir/coverage), `apigen-plugin-batch` with `<projectName>` (lib.name), `../../../` with `<rel>`, keep every other line byte-identical (incl. `formats: ['es','cjs']`, `entryRoot: 'src'`).
2. Build the `canonicalTargets` object exactly as shown in "Interface changes" (project.json shape matches batch lines 22-55: build `outputs:["{options.outputPath}"]`, test `outputs:["{workspaceRoot}/coverage/..."]`, nx-release-publish `dependsOn` full list + `@nx/js:release-publish` + `packageRoot: "{projectRoot}/dist"`).
3. Browser variant: omit the `rollupOptions` block and the two `tools/vite-plugins` imports + `poolOptions`/`environment: 'node'`; keep in-tree `root`/`outDir`.
4. Export both functions with JSDoc.

### Segment B — generator.ts

1. Add import: `import { canonicalViteConfig, canonicalTargets } from './templates';`
2. Replace the ENTIRE body of `patchViteConfig` with: if `vite.config.ts` exists → `tree.write(vitePath, canonicalViteConfig({ projectRoot, projectName, platform, rel }))` where `rel` = projectRoot.startsWith('entrypoint/') ? '../../' : '../../../'. DELETE the `platform === 'node' || platform === 'shared'` conditional — the template itself branches on platform. Do NOT keep any regex code.
3. Replace `patchReleasePublish` body with: merge `canonicalTargets(projectRoot)` into `projectJson.targets` (spread, so existing targets like lint survive); if no `lint` target survived, add `lint: { executor: '@nx/eslint:lint' }`; writeJson.
4. In `scaffoldGenerator`, after `patchTsconfigLib(tree, projectRoot)`, add: write `<projectRoot>/src/lib/<name>.spec.ts` placeholder (skip if it already exists).
5. In `scaffoldEntrypoint`: tsconfig outDir `'../../dist/entrypoint'` → `'dist'`; add `"outputs": ["{projectRoot}/dist"]` to the project.json build target (build target is currently the `nx:run-commands` tsc target — add outputs to it).
6. Do NOT touch: entrypoint tsconfig `extends`/`include`, tags logic, paths logic, readme, eslintrc, tsconfig.lib patch, formatFiles.

### Segment C — specs

1. `base/generator.spec.ts`: line 44 `expect(viteConfig).toContain("import { externalizeRealDeps } from '../../../tools/vite-external-deps.mjs';")` → `"import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';"`. Add: `expect(viteConfig).not.toContain('tools/vite-external-deps.mjs')` and `expect(viteConfig).toContain("import { vitestPoolOptions } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';")` and `expect(viteConfig).toContain("poolOptions: vitestPoolOptions")` (node + shared cases). Keep the browser case's `external: []` assertion but note the browser template must still contain `outDir: 'dist'`.
2. `plugin/generator.spec.ts` (new): drive the PLUGIN generator (the FEATURE's tier) for `{name:'ir-cache', group:'apigen', nxLayer:'logic', platform:'node'}`; assert emitted `project.json`: `outputPath` === `'packages/apigen/apigen-plugin-ir-cache/dist'`, `targets.test.executor` === `'@nx/vite:test'`, `targets['nx-release-publish'].options.packageRoot` === `'{projectRoot}/dist'`; assert emitted `vite.config.ts` contains the two real imports + `outDir: 'dist'` + `root: __dirname` + `externalizeRealDeps(__dirname)`; assert NEITHER file contains `tools/vite-external-deps.mjs`, `dist/packages/`, `../../../dist/`; assert the placeholder spec file exists.
3. `entrypoint/generator.spec.ts` (new): drive the ENTRYPOINT generator `{name:'foo-cli', ...}`; assert emitted tsconfig has `"outDir": "dist"` (not `../../dist/entrypoint`) and emitted project.json build target declares `outputs` containing `{projectRoot}/dist`.

### Segment D — nx.json

1. Add `"{workspaceRoot}/tools/vite-plugins/vitest-pool-defaults.mjs"` to the `sharedGlobals` array (after line 27's `externalize.mjs` entry). No other change.

## Test cases

### Generator unit tests (`workspace-codegen-nx` suite, run via `npx nx test workspace-codegen-nx`)

- Plugin, platform node: emitted vite.config has real imports + in-tree outDir/root + externalize + poolOptions; project.json has in-tree outputPath + test target + nx-release-publish; NO stale strings (`tools/vite-external-deps.mjs`, `dist/packages/`, `../../../dist/`).
- Plugin, platform shared: same assertions (shared also externalizes).
- Plugin, platform browser: in-tree outDir/root + outputPath; NO externalize import; `external: []` semantics preserved.
- Base generator, platform node: corrected import assertions (replaces the stale-path assertion at line 44).
- Entrypoint: tsconfig `outDir: 'dist'`; project.json build `outputs` includes `{projectRoot}/dist`; no `dist/entrypoint` string.
- **Negative control (teeth, AC-5):** temporarily revert Segment B (restore old patchViteConfig) → suite exits non-zero. The review agent performs this revert-check in stage 4 and records it in `VERIFICATION.md`.

### Verification gates (AC-1..AC-8 — run by review agent in stage 4; implementer runs the unit suite only)

- `npx nx test workspace-codegen-nx` → exit 0 (AC-1, AC-2, AC-3, AC-5, AC-6, AC-7).
- Real scaffold of the FEATURE command (`npx nx g @adhd/workspace-codegen-nx:plugin --name ir-cache --group apigen --nxLayer logic --platform node`), then `npx nx build apigen-plugin-ir-cache`, `npx nx test apigen-plugin-ir-cache`, `npx nx lint apigen-plugin-ir-cache`, `npx nx run apigen-plugin-ir-cache:assets`, `npx nx run apigen-plugin-ir-cache:verify-dist-load` → all exit 0 with NO manual edits (AC-4). Scaffold into a scratch worktree/temp tree so the repo tree is not polluted; the review agent picks the mechanics (`--dry-run` equivalent or a throwaway worktree under `.worktrees/`).
- `grep -r "vite-external-deps" packages/workspace/workspace-codegen-nx/` → no matches (AC-8; audit only, not a gate).
- `nx.json` contains the `vitest-pool-defaults.mjs` sharedGlobal (AC-7).
- Revert-check: old generator → `npx nx test workspace-codegen-nx` non-zero (AC-5 teeth).

## Edge cases / flags

- **CacheDir non-derivability:** batch's `cacheDir: '.../node_modules/.vite/packages/apigen/plugins/batch'` cannot be derived mechanically from `projectRoot` (drops the tier from the name). The template uses `<rel>node_modules/.vite/<projectRoot>` — deterministic and unique; the existing batch string is left untouched.
- **libraryGenerator lint target:** if `@nx/js:libraryGenerator` in this repo's Nx (18.3.4) already emits a `lint` target, Segment B's lint fallback is a no-op — implementer must verify by reading the emitted project.json in a dry run; do not double-add.
- **`verify-dist-load` requires `dist-manifest` to run first** (build plugin dependsOn wiring, `tools/nx-plugins/build/plugin.js:88-89`) — no generator change needed; the emitted package.json `main`/`module`/`types` from libraryGenerator (`publishable: true`) resolve against in-tree `dist/` once build outputPath is corrected.
- **Browser `environment`:** do not fabricate jsdom; leave the test block at vitest defaults for browser scaffolds. If a browser scaffold then fails `nx test` on missing test-setup, that is a separate follow-up (record, don't fix here).
- **Historical records:** CHANGELOG.md/BACKLOG.md mentions of `tools/vite-external-deps.mjs` are history — do NOT edit (AC-8 exemption).
