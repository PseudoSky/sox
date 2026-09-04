# Review — BUG-WORKSPACE-GEN-006 (`@adhd/workspace-codegen-nx:plugin` stale generator configs)

- **Reviewer:** review agent (RF-arm REVIEW/VERIFY stage)
- **Commit under review:** `fa470a4f` (`feat(workspace-codegen-nx): FEAT-012 fix BUG-WORKSPACE-GEN-006 stale plugin generator configs`)
- **Worktree:** `/Users/nix/dev/sdlc-experiments/arm-rf/rf-run`, branch `arm-rf-manual-20260803`
- **Reviewed:** 2026-08-03. Working tree was clean at review start and is clean at review end.
- **Contract:** `docs/acceptance.md` (AC-1..AC-13) · **Spec:** `docs/spec.md`

## Verdict

**PASS-WITH-NITS**

All 13 acceptance criteria verified PASS with real command exit codes; both implementer deviations are correct, necessary, and complete; the committed regression specs have teeth. Remaining observations are cosmetic/optional and do not gate acceptance.

---

## Gates table

All commands run from the worktree root **without** `--skip-nx-cache` (repo rule). "Cache replay" entries mean nx restored outputs from the local cache because inputs matched a prior identical run (legitimate per `docs/acceptance.md:194`); where stated, independent uncached evidence was obtained by invoking vitest directly (bypasses the nx cache without touching it).

| Command | Real exit code | Executed fresh or cache replay | Notes |
|---|---|---|---|
| `npx nx build workspace-codegen-nx` | 0 | cache replay (3/3 tasks) | `Successfully ran target build`; tsc compile step replayed. Cache inputs are source-hashed; tree was clean at fa470a4f, so the hit is valid. |
| `npx nx test workspace-codegen-nx` | 0 | cache replay (3/3 tasks) | **Independently re-verified uncached** with `npx vitest run --config packages/workspace/workspace-codegen-nx/vite.config.ts` → **3 test files, 12 tests, all passed** (plugin spec 5, types spec 4, base spec 3). Genuinely green, not just cached. |
| `npx nx lint workspace-codegen-nx` | 0 | cache replay (2/2 tasks) | `✔ All files pass linting`. |
| `npx nx g …:plugin --name ac-probe … --dry-run` (AC-1a) | 0 | fresh | `Scaffolding apigen-plugin-ac-probe` + full CREATE list; no files written. |
| `npx nx g …:plugin --name ac-probe …` (AC-1a real) | 0 | fresh | Mutated exactly two paths: `packages/apigen/apigen-plugin-ac-probe/` (new) + `tsconfig.base.json` (mapping added). |
| `npx nx build apigen-plugin-ac-probe` (AC-6) | 0 | cache replay (1/1) | `✓ built in 334ms`; dist artifacts verified present in-tree (below). |
| `npx nx run apigen-plugin-ac-probe:assets` (AC-7) | 0 | cache replay (2/2) | The exact target that previously failed `assets: no dist for … (build first)`; now green. |
| `npx nx run apigen-plugin-ac-probe:verify-dist-load` (AC-8) | 0 | 2 of 4 tasks fresh | Executor output: `verify-dist-load: all 2 entry point(s) loaded cleanly for packages/apigen/apigen-plugin-ac-probe.` |
| `npx nx test apigen-plugin-ac-probe` (AC-10) | 0 | cache replay (3/3) | Reporter: `Test Files 1 passed (1)`, `Tests 1 passed (1)`. **Uncached confirm:** `npx vitest run --config packages/apigen/apigen-plugin-ac-probe/vite.config.ts` → 1/1 passed, `environment 0ms` (node env, no jsdom). |
| `npx nx lint apigen-plugin-ac-probe` (AC-11) | 0 | cache replay (2/2) | lint green; `sync-deps` (targetDefault) no-oped cleanly. |
| `npx nx g …:entrypoint --name rf-entry-check --dry-run` (safety) | 0 | fresh | Entrypoint tier unaffected by both new patches (dry-run, no files written, tree clean after). |

---

## Acceptance criteria table

Probe identity `<probe>` = `ac-probe` → package `apigen-plugin-ac-probe` at `packages/apigen/apigen-plugin-ac-probe/`. All content checks are file reads (per `docs/acceptance.md:13`), all command gates are exit codes.

| Criterion | Result | Evidence |
|---|---|---|
| AC-1 — Scaffold identity unchanged | **PASS** | Dry-run exit 0; real gen exit 0. Directory `packages/apigen/apigen-plugin-ac-probe/` (no double-prefix). `project.json:2` `"name": "apigen-plugin-ac-probe"`; `package.json:2` `"name": "@adhd/apigen-plugin-ac-probe"`; `project.json:14-21` tags exactly `[domain:apigen, pkg-kind:plugin, pkg-class:optional, layer:logic, platform:node, access:domain]`. Layout: `src/index.ts`, `src/lib/`, `src/lib/apigen-apigen-plugin-ac-probe.spec.ts`, `tsconfig.lib.json`, `tsconfig.spec.json`, `.eslintrc.json`, `README.md` all created. `tsconfig.base.json` diff shows exactly one new mapping `@adhd/apigen-plugin-ac-probe → ./packages/apigen/apigen-plugin-ac-probe/src/index.ts`. |
| AC-2 — `externalizeRealDeps` from real path | **PASS** | Generated `vite.config.ts:6` `import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';`; string `tools/vite-external-deps.mjs` absent from the whole file; `:47` `external: externalizeRealDeps(__dirname)`. |
| AC-3 — test block wired to vitest-pool defaults + node env | **PASS** | `vite.config.ts:7` vitest-pool-defaults import; `:52` `poolOptions: vitestPoolOptions` (first key of `test`); `:57` `environment: 'node'`; `:58` include `src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}`. Matches reference `apigen-plugin-batch/vite.config.ts:44,49,50`. |
| AC-4 — vite `outDir` in-tree | **PASS** | `vite.config.ts:30` `outDir: 'dist'`; no `(\.\./)+dist` outDir anywhere. |
| AC-5 — `project.json` `outputPath` in-tree | **PASS** | `project.json:24-29` build = `@nx/vite:build`, `outputPath: "packages/apigen/apigen-plugin-ac-probe/dist"`; string `dist/packages/` absent. |
| AC-6 — `npx nx build <pkg>` succeeds, emits in-tree | **PASS** | `nx build apigen-plugin-ac-probe` exit 0. `dist/index.js`, `dist/index.mjs`, `dist/index.d.ts` all exist (each `test -f` 0). `dist/packages/apigen/apigen-plugin-ac-probe/` NOT created (`test ! -d` 0). Built CJS entry confirmed real (`exports.apigenApigenPluginAcProbe` present). |
| AC-7 — `assets` target works | **PASS** | `npx nx run apigen-plugin-ac-probe:assets` exit 0 (previously failing target). |
| AC-8 — `verify-dist-load` works | **PASS** | `npx nx run apigen-plugin-ac-probe:verify-dist-load` exit 0; both entry points loaded cleanly from in-tree dist. |
| AC-9 — `test` target present | **PASS** | `project.json:40-48` `"test": { "executor": "@nx/vite:test", "outputs": ["{workspaceRoot}/coverage/packages/apigen/apigen-plugin-ac-probe"], "options": { "configFile": "packages/apigen/apigen-plugin-ac-probe/vite.config.ts" } }` — matches reference shape `apigen-plugin-batch/project.json:30-38`. |
| AC-10 — `npx nx test <pkg>` runs, exit 0 | **PASS** | `nx test apigen-plugin-ac-probe` exit 0; reporter `Tests 1 passed (1)` (≥1 file, ≥1 test). Uncached vitest re-run 1/1 passed. |
| AC-11 — `npx nx lint <pkg>` exit 0 | **PASS** | `nx lint apigen-plugin-ac-probe` exit 0. |
| AC-12 — generator project builds and tests clean | **PASS** | `nx build workspace-codegen-nx` 0; `nx test workspace-codegen-nx` 0 + uncached vitest 3 files/12 tests passed (includes updated `base` spec and new `plugin` spec). |
| AC-13 — committed regression tests with teeth | **PASS** | New `plugin/generator.spec.ts` (5 tests) drives the real plugin generator on an in-memory Tree and asserts all three artifacts with negative-controls (see Teeth assessment below). `base/generator.spec.ts:44` updated to the new import path (same commit); `base/generator.spec.ts:11` doc comment corrected; browser case (`:66-80`) untouched and green (12/12 uncached). |

**AC summary: 13/13 PASS.**

---

## Spec conformance (§3 change items)

| Spec §3 item | Present? | Evidence |
|---|---|---|
| 3.1(a) call site — `patchProjectJsonTargets(tree, projectRoot)` after `patchViteConfig` | Yes | `shared/generator.ts:117-118` (plus deviation #2's `patchPackageJsonEntries` at `:119`). |
| 3.1(b) outDir fix at top of `patchViteConfig`, before `emptyOutDir` insert | Yes | `shared/generator.ts:134-142` (runs before `:144-147` emptyOutDir insert and `:149-155` copy-readme plugin — both see `'dist'`). Regex exactly per spec. |
| 3.1(c) node/shared branch: real import path + `vitestPoolOptions` import + `poolOptions` insert | Yes | `shared/generator.ts:171-181`; idempotency guards present; poolOptions inserted as first key of `test` block. |
| 3.1(d) `patchProjectJsonTargets` new function | Yes | `shared/generator.ts:195-218` — matches spec shapes byte-for-byte (build/outputs/options, test/outputs/configFile); executor guard `targets.build.executor !== '@nx/vite:build'` early-returns entrypoint scaffolds. |
| 3.2 `base/generator.spec.ts` line 44 + line 11 | Yes | Both updated in commit (`base/generator.spec.ts:11`, `:44`); no other base-spec changes. |
| 3.3 `plugin/generator.spec.ts` created | Yes | 119 lines, 5 tests; `beforeEach` registers `@nx/vite/plugin` in the in-memory tree's `nx.json` (Q6 teeth mechanism, mirrors `nx.json:60-67`); all five §4.2 assertions present verbatim. |
| 3.4 Unchanged files untouched | Yes | Commit `--name-status` shows only FEATURE.md, docs/acceptance.md, docs/spec.md, base/generator.spec.ts, plugin/generator.spec.ts, shared/generator.ts. `plugin/generator.ts`, `schema.json`, references, `tools/**` untouched. |

---

## Deviations assessment

### Deviation 1 — `environment: 'jsdom' → 'node'` patch (shared/generator.ts:182-189)

**Verdict: ACCEPT.**

- **Claim:** the programmatic `@nx/js` path leaves `testEnvironment` undefined, so `@nx/vite` falls back to `'jsdom'`, violating AC-3.
- **Verified in node_modules:** `libraryGenerator(tree, schema)` spreads the caller's schema directly and never coerces schema defaults (`node_modules/@nx/js/src/generators/library/library.js:18-26`); `normalizeOptions` never defaults `testEnvironment` (grep: only 5 pass-through sites, no default). `@nx/vite` emits `environment: '${options.testEnvironment ?? 'jsdom'}'` (`node_modules/@nx/vite/src/utils/generator-utils.js`). Therefore the raw programmatic scaffold genuinely emits `environment: 'jsdom'` — the spec's Q7 answer ("No patch needed; @nx/js defaults testEnvironment to 'node'") was **factually wrong** for this call path.
- **Necessity:** without the patch, generated `vite.config.ts` would contain `environment: 'jsdom'` and AC-3 (and plugin-spec assertion 2, `plugin/generator.spec.ts:89`) would fail. FEATURE.md's own fix direction (a) listed "environment node" — the implementer restored the spec's intent.
- **Scoped / idempotent:** inside the existing `platform === 'node' || platform === 'shared'` branch only — `platform:browser` untouched (browser packages correctly keep `jsdom`, e.g. `ui-react-base-hooks/vite.config.ts:55`). Guard `!content.includes("environment: 'node'")` + single `jsdom→node` replacement → re-generation is a no-op.
- **Corroboration of the underlying bug's reality:** 5 existing node/shared packages still carry `environment: 'jsdom'` (`dispatch-base-types`, `apigen-base-types`, `environment-core-node`, `environment-builder`, `environment-base-spec` vite.config.ts files) — pre-fix scaffolds; the patch is exactly what they lacked. Retro-fixing those existing packages is out of scope for this commit (acceptance §3) and worth a follow-up ticket.
- **Risk introduced:** low. The regex only matches `'jsdom'`; if a future `@nx/vite` changed its default string, the patch would silently no-op — caught at probe/AC-3 time. No current risk.

### Deviation 2 — `patchPackageJsonEntries` (shared/generator.ts:220-232)

**Verdict: ACCEPT.**

- **Claim:** generated `package.json` must use `./dist/…` main/module/types per repo convention; spec §3 omitted it but AC-1b (§4.3 table) requires it.
- **Verified:** `@nx/js` emits root-relative `main: './index.js'`, `module: './index.mjs'`, `typings: './index.d.ts'` for the vite bundler (`library.js determineEntryFields`, vite case) — broken on publish because the built output lands in `{projectRoot}/dist` (reference: `apigen-plugin-batch/package.json` uses `./dist/index.js`, `./dist/index.mjs`, `./dist/index.d.ts`). The generated probe `package.json:5-7` shows `main/module/types` all `./dist/…` and `typings` removed/`types` set — AC-1b satisfied.
- **Scoped / idempotent:** entrypoint guard (`pkgJson?.main === undefined` → return; entrypoint package.json has no `main`) and idempotency guard (`main.includes('dist')` → return). Verified entrypoint safety with a real `entrypoint` dry-run (exit 0, no crash). Applies uniformly to all non-entrypoint tiers — all of which use the same vite bundler, so all benefit; no tier is diverged by it.
- **Risk introduced:** low. `typeof main === 'string'` is only used in the idempotency guard, so a hypothetical future conditional-exports `main` object would be overwritten — not possible with current `@nx/js` vite output (always a string). One nit: it does not add `files: ["dist", …]` / `publishConfig` (reference has them); those belong to the out-of-scope publish pipeline.

---

## Test teeth assessment (AC-13 / §4.6)

Assessed from the committed assertions (no reverts performed, per review instructions); each maps 1:1 to a revertable defect:

1. **Import path** — `plugin/generator.spec.ts:78-79` asserts `toContain('../../../tools/vite-plugins/externalize.mjs')` + `not.toContain('tools/vite-external-deps.mjs')`; `base/generator.spec.ts:44` asserts the new path. Reverting the template import path ⇒ both go red. Teeth ✓
2. **In-tree dist** — `:99-100` (`outDir: 'dist'`, `not.toMatch(/\.\.\/dist/)`) and `:107-109` (`outputPath === root/dist`, `not.toContain('dist/packages/')`). Reverting either the outDir patch or the outputPath patch ⇒ red. Teeth ✓
3. **Test target** — `:116-117` asserts `targets.test.executor === '@nx/vite:test'`. The `beforeEach` registers `@nx/vite/plugin` (mirroring `nx.json:60-67`), so the `@nx/vite` vitest generator skips adding a `test` target (`node_modules/@nx/vite/src/generators/vitest/vitest-generator.js:47-52`) — pre-fix `targets.test` is `undefined` and the assertion throws/fails. This is the Q6 teeth mechanism; without the plugin registration the assertion would pass pre-fix (no teeth). Teeth ✓
4. **Environment (deviation 1)** — `:89` asserts `environment: 'node'`; reverting the jsdom→node patch ⇒ generated is `'jsdom'` ⇒ red. Teeth ✓
5. **package.json entries (deviation 2)** — **no committed assertion** (AC-13's scope is exactly the three artifacts). Covered only at probe level (AC-1b §4.3). A committed assertion would harden it — NIT, not a failure.

Default-running (vitest include matches), deterministic (in-memory Tree), fresh-verified green (uncached vitest: 12/12).

---

## Notes for the final-review stage

**Pre-existing deferrals (unchanged by this commit, per acceptance §3):**
- **Orphaned `tools/nx-plugins/verify-dist-load/plugin.js`** — references non-existent `scripts/verify-dist-load.mjs` (verified absent) and is NOT registered in `nx.json` (verified: plugins list registers only lint/build/assets/deps/test plugin.js files). Dead code; live `verify-dist-load` wiring is the inference in `tools/nx-plugins/build/plugin.js`. Separate ticket.
- **~16-17 stale `vite-external-deps.mjs` comment references** in existing `vite.config.ts` files (grep count: 16 in `packages/**/vite.config.ts`; acceptance says ~17 — one is likely in `tools/` or a non-vite.config file). Comment-only debt, no behavior impact.
- **Spec Q7 was factually wrong** — `@nx/js`'s `testEnvironment: 'node'` schema default is not applied on the programmatic `libraryGenerator` call path (verified in `node_modules`); deviation #1 is the correction and is correct.

**Residual observations (do not block):**
- 5 existing node/shared packages (`dispatch-base-types`, `apigen-base-types`, `environment-core-node`, `environment-builder`, `environment-base-spec`) still run tests under `environment: 'jsdom'` — pre-fix scaffolds. This commit only fixes new scaffolds; a retro-fix sweep is a natural follow-up ticket.
- Generated `package.json` lacks `files: ["dist", …]` and `publishConfig` that the reference has (raw `@nx/js` emit; publish pipeline out of scope).
- Generated `project.json` `release.version.generatorOptions.packageRoot` is `"dist/{projectRoot}"` (nx default) vs reference's package root — publish-pipeline concern, out of scope.
- `patchPackageJsonEntries` has no committed regression test (see teeth #5).
- The `jsdom→node` regex is brittle to a hypothetical `@nx/vite` default-string change (silent no-op); caught by probe-level AC-3.
- Cosmetic, pre-existing: `@nx/js` derives the internal spec filename as `apigen-apigen-plugin-ac-probe.spec.ts` (dir-leaf + composed name) — runs fine, not introduced here.
- All nx gates were cache-replayed during review (inputs identical to the implementer's runs); independent uncached evidence was obtained via direct vitest runs (generator suite 12/12; probe 1/1) and the fresh verify-dist-load run.
- GitNexus impact analysis corroborates spec §3 blast radius: `patchViteConfig` upstream → 1 caller (`scaffoldGenerator`), LOW; `scaffoldGenerator` upstream → all 9 tier generators, MEDIUM.

**Cleanup confirmation:** probe package `packages/apigen/apigen-plugin-ac-probe/` removed (targeted `rm -r` of the literal path) and `tsconfig.base.json` restored with `git restore`; final `git status` is clean. No files were created in the repo other than `docs/review.md`.

**Open questions:** none — no gate failures, no unmet ACs, no cross-tier breakage observed.
