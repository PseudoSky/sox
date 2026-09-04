# Acceptance Criteria — BUG-WORKSPACE-GEN-006

- **Feature/Bug:** `@adhd/workspace-codegen-nx:plugin` generator emits three stale artifacts when scaffolding a new plugin package (stale vite tools import path, pre-migration workspace-root dist layout, missing `test` target).
- **Human ID:** BUG-WORKSPACE-GEN-006
- **Kind:** BUG · **Priority:** MEDIUM · **Status:** OPEN
- **Reference package (the "healthy" contract):** `packages/apigen/apigen-plugin-batch/` (`project.json`, `vite.config.ts`, `package.json`, `src/test/plugin.spec.ts`).
- **Worktree under test:** `/Users/nix/dev/sdlc-experiments/arm-rf/rf-run` (branch `arm-rf-manual-20260803`, HEAD `6f4d2c38`).

## 1. Overview

This fix repairs the `plugin` tier of the `@adhd/workspace-codegen-nx` generator so that a freshly scaffolded plugin package ships build/test/verify configuration that works out of the box, without the hand repair currently required after every scaffold. The consumer is any developer or agent who runs `npx nx g @adhd/workspace-codegen-nx:plugin …` — the bug was discovered exactly that way during FEAT-002 (scaffold of `apigen-plugin-ir-cache` at commit `79aa19f5^`): the generated `vite.config.ts` imported `externalizeRealDeps` from a non-existent `tools/vite-external-deps.mjs`, the generated `project.json`/vite build emitted to the pre-migration workspace-root `dist/` (breaking the injected `assets`/`verify-dist-load` targets), and the generated `project.json` had no `test` target, so `npx nx test <scaffolded-package>` failed. The fix must make generated output match what the healthy reference package `apigen-plugin-batch` does: real vite-tools import paths, in-tree `{projectRoot}/dist` build output, and a working `@nx/vite:test` target — proven by both live generation and committed template regression tests.

All criteria below are **binary**: each is PASS or FAIL based on a file-content read, a file-existence check, or a command exit code. Command outcomes are gated on **exit codes** (never `| grep` on stdout); template content is verified by **reading the generated files** at the exact paths listed.

## 2. Acceptance Criteria

Each criterion uses the probe scaffold identity `<probe>` = a unique bare name (e.g. `ac-probe`) generated with `--group apigen --nxLayer logic --platform node`, yielding the package `apigen-plugin-<probe>` at `packages/apigen/apigen-plugin-<probe>/` (see Verification plan §4.2 for the exact invocation and cleanup contract).

### AC-1 — Scaffold identity is unchanged (preserved behavior)

PASS when a dry-run of `npx nx g @adhd/workspace-codegen-nx:plugin --name <probe> --group apigen --nxLayer logic --platform node --dry-run` exits 0 **and** a real generation creates a package whose identity exactly matches the reference package's shape:

- Directory: `packages/apigen/apigen-plugin-<probe>/` (the generator composes `<group>-plugin-<name>`, never `apigen-plugin-apigen-plugin-<probe>`).
- `project.json` → `"name": "apigen-plugin-<probe>"`.
- `package.json` → `"name": "@adhd/apigen-plugin-<probe>"`.
- Tags exactly: `domain:apigen`, `pkg-kind:plugin`, `pkg-class:optional`, `layer:logic`, `platform:node`, `access:domain`.
- Source layout mirrors the reference: `src/index.ts`, `src/lib/`, `src/test/` (or `src/lib/*.spec.ts` per the generator's existing pattern), `tsconfig.lib.json`, `tsconfig.spec.json`, `.eslintrc.json`, `README.md`.
- `tsconfig.base.json` gains the path mapping `@adhd/apigen-plugin-<probe>` → `./packages/apigen/apigen-plugin-<probe>/src/index.ts` (and no other mapping).

Rationale: the fix changes *configuration templates*, not package identity. Name/directory/tag composition must not regress (reference: `packages/apigen/apigen-plugin-batch/project.json:1-20`).

### AC-2 — `vite.config.ts` imports `externalizeRealDeps` from the real path

PASS when the generated `packages/apigen/apigen-plugin-<probe>/vite.config.ts` satisfies **all** of:

- Contains the exact import: `import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';`
- Does **not** contain the string `tools/vite-external-deps.mjs` anywhere in the file (the non-existent pre-migration path).
- Contains `external: externalizeRealDeps(__dirname)` in `build.rollupOptions` (i.e., the template's `external: []` is replaced for `platform:node`/`platform:shared`).

Reference: `packages/apigen/apigen-plugin-batch/vite.config.ts:6` (import) and `:39` (external call). Current broken template: `packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts:163`.

### AC-3 — `vite.config.ts` test block is wired to the real vitest-pool defaults and node environment

PASS when the generated `vite.config.ts` `test` block matches the reference package's test block on the load-bearing fields:

- Contains `import { vitestPoolOptions } from '../../../tools/vite-plugins/vitest-pool-defaults.mjs';`
- Contains `poolOptions: vitestPoolOptions`.
- Contains `environment: 'node'`.
- Contains the vitest `include` pattern `src/**/*.{test,spec}.{js,mjs,cjs,ts,mts,cts,jsx,tsx}` (or equivalent that matches the generated spec files under `src/`).

Reference: `packages/apigen/apigen-plugin-batch/vite.config.ts:8` (import), `:44` (poolOptions), `:49` (environment), `:50` (include). "Where applicable" = every `platform:node`/`platform:shared` vite library the shared codepath scaffolds, per the fix direction in FEATURE.md item (a).

### AC-4 — Build output is in-tree: vite `outDir`

PASS when the generated `vite.config.ts` `build.outDir` is exactly `'dist'` (relative to the project root, in-tree) — and the file does **not** contain any `outDir` value matching `(\.\./)+dist/` (workspace-root-relative escape). Reference: `packages/apigen/apigen-plugin-batch/vite.config.ts:22`.

### AC-5 — Build output is in-tree: `project.json` `outputPath`

PASS when the generated `packages/apigen/apigen-plugin-<probe>/project.json` build target reads:

- `"executor": "@nx/vite:build"`
- `"outputPath": "packages/apigen/apigen-plugin-<probe>/dist"` (project-root-relative, in-tree) — and does **not** contain `dist/packages/` (the pre-migration workspace-root layout).

Reference: `packages/apigen/apigen-plugin-batch/project.json:22-28`.

### AC-6 — `npx nx build <scaffolded-package>` succeeds and emits in-tree

PASS when `npx nx build apigen-plugin-<probe>` exits 0 **and** all of these files exist afterward:

- `packages/apigen/apigen-plugin-<probe>/dist/index.js`
- `packages/apigen/apigen-plugin-<probe>/dist/index.mjs`
- `packages/apigen/apigen-plugin-<probe>/dist/index.d.ts`

(Do **not** pass `--skip-nx-cache` — repo rule; a normal cached build is the correct proof.) The workspace-root layout `dist/packages/apigen/apigen-plugin-<probe>/` must NOT be created.

### AC-7 — `assets` target works on the fresh package

PASS when `npx nx run apigen-plugin-<probe>:assets` exits 0. This is the exact target that previously failed with `assets: no dist for … (build first)` because the build landed outside `{projectRoot}/dist`; the assets executor reads `{projectRoot}/dist` in-tree (`tools/nx-plugins/assets/executors/copy/impl.js:28-31`).

### AC-8 — `verify-dist-load` works on the fresh package

PASS when `npx nx run apigen-plugin-<probe>:verify-dist-load` exits 0. The `@adhd/nx-build:verify` executor (inferred by `tools/nx-plugins/build/plugin.js:89`) depends on `build` + `dist-manifest` and loads the built in-tree `{projectRoot}/dist` entry points the way a real consumer does; it must not fail on a missing/empty in-tree dist.

### AC-9 — `project.json` has a `test` target wired to the generated vite config

PASS when the generated `project.json` contains:

- `"test": { "executor": "@nx/vite:test", "options": { "configFile": "packages/apigen/apigen-plugin-<probe>/vite.config.ts" } }` (optionally plus the standard `outputs`/coverage config).

Reference: `packages/apigen/apigen-plugin-batch/project.json:30-38`.

### AC-10 — `npx nx test <scaffolded-package>` runs and exits 0

PASS when `npx nx test apigen-plugin-<probe>` exits 0 **and** the test reporter output reports the generated spec file(s) executed (≥1 test file matched and ≥1 test passed — in this repo vitest exits non-zero with "No test files found" when nothing matches, so exit 0 implies tests actually ran; corroborate with the `Tests  N passed` line, but the exit code is the gate). This proves the previously-orphaned vite `test` block is now invoked via nx.

### AC-11 — `npx nx lint <scaffolded-package>` exits 0

PASS when `npx nx lint apigen-plugin-<probe>` exits 0 (generated `.eslintrc.json` + repo eslint config lint clean; `lint` depends on `sync-deps` per `nx.json` targetDefaults, which must no-op cleanly for the fresh package). Optional-but-encouraged: `npx nx affected -t lint --base=HEAD` also green for the generated package.

### AC-12 — `workspace-codegen-nx` itself builds and tests clean after the fix

PASS when, from the worktree root:

- `npx nx build workspace-codegen-nx` exits 0, **and**
- `npx nx test workspace-codegen-nx` exits 0.

The test run executes the project's committed generator specs (see AC-13) — including the **updated** `base/generator.spec.ts`, which currently asserts the stale path at `base/generator.spec.ts:44` and must be updated in the same commit as the template fix (otherwise this suite goes red and the fix is not shippable).

### AC-13 — Committed template regression tests prove the three artifacts (with teeth)

PASS when a committed vitest spec (a new `plugin/generator.spec.ts`, or an equivalent extension of the existing generator specs) runs the **real plugin generator** against an in-memory Tree (`createTreeWithEmptyWorkspace()` from `@nx/devkit/testing`, the same pattern as `base/generator.spec.ts` / `types/generator.spec.ts`) and asserts **all three** artifact fixes, each as a negative-control-verifiable assertion:

1. **Import path:** the generated `vite.config.ts` contains `../../../tools/vite-plugins/externalize.mjs` **and** does not contain `tools/vite-external-deps.mjs`; the `external: externalizeRealDeps(__dirname)` call is present.
2. **In-tree dist:** the generated `project.json` build `outputPath` is project-root-relative (`…/dist`, not `dist/packages/…`) and the generated vite `build.outDir` is `dist` (not a `../../../dist` escape).
3. **Test target:** the generated `project.json` has a `test` target with executor `@nx/vite:test`.

Plus: the existing `base/generator.spec.ts:44` stale-path assertion is updated to the new import path in the same commit (its `platform:browser` case asserting `external: []` untouched must stay green). **Teeth proof (must be demonstrated by the implementer during development, and the assertion content is reviewer-verifiable by reading the spec):** reverting the template import path / outputPath / test-target changes makes the corresponding assertion fail — the test is red when the bug is reintroduced. The tests run by default (no env gate), are deterministic (in-memory tree, no filesystem), and live under the vitest `include` pattern of `workspace-codegen-nx`.

## 3. Out of Scope

This fix does **not** cover, and none of the following may block acceptance:

- **Other generator tiers** (`base`/`core`/`engine`/`store`/`generator`/`query`/`types`/`entrypoint`): the template fix lives in the shared codepath (`shared/generator.ts`), so node/shared tiers inherit the corrected import path — but acceptance verification is scoped to the `plugin` tier. The other tiers' existing specs (`base`, `types`) must remain green (covered by AC-12/AC-13) but get no new acceptance checks.
- **Stale comment references** to `tools/vite-external-deps.mjs` in ~17 existing `vite.config.ts` files (e.g. `packages/apigen/apigen-plugin-api-express/vite.config.ts:36`) — comment-only debt pointing at the moved file; no behavior impact.
- **Orphaned plugin file** `tools/nx-plugins/verify-dist-load/plugin.js` — references a non-existent `scripts/verify-dist-load.mjs` and the pre-migration `{workspaceRoot}/dist/<root>/**` cache inputs, and is **not registered** in `nx.json` (the live `verify-dist-load` wiring is `tools/nx-plugins/build/plugin.js:89` + `executors/verify/`). Dead code; deletion or repair is a separate ticket.
- **Historical text** in `BACKLOG.md:174` (INVESTIGATION-BUILD-TOOL-001 notes naming the old path) — history, leave as-is.
- **Docs rewrites** (AGENTS.md, `docs/contributing/`, package-naming docs) and **CHANGELOG/RELEASE** entries — the implementing agent's normal docs duties, but not acceptance-gated here.
- **Unrelated package health** — e.g. `BUG-WORKSPACE-NO-LINKING-001` (4 packages on `@nx/js:tsc` with no real workspace linking), the publish pipeline's `version`/`reconcile`/`publish-hygiene`/`publish` targets, and any non-plugin packages' build/test state.
- **`--access public` / `--publish true` variants** — acceptance uses defaults (`access:domain`, no publish tag); those flags must still be accepted by the schema but their output is not verified here.

## 4. Verification Plan

A reviewer (human or agent) runs the following from `/Users/nix/dev/sdlc-experiments/arm-rf/rf-run` (branch `arm-rf-manual-20260803`). **Rule: every command's PASS verdict is its exit code; never `… | grep -q` the stdout. File-content and file-existence checks are done by reading the generated files with a read tool, not by grepping command output.**

### 4.0 Prerequisites

- `node_modules/` present in the worktree (required for `lint`'s `sync-deps` dependency — `BUG-REPO-PRECOMMIT-DEPCHECK-STRIPS-USED-DEPS-001`).
- Pick a unique probe name with no collision, e.g. `ac-probe`. Record it; every path below uses it.
- **Generation location note:** the generator's output path is fixed by the repo scaffolding convention — it always writes `packages/<group>/<group>-plugin-<name>/` (there is no target-dir option; see AGENTS.md §1 and `shared/generator.ts:48-51`). It cannot target `tmp/` directly. `tmp/` remains the canonical scratch root per AGENTS.md §10; a throwaway git worktree under `.worktrees/` (repo-endorsed isolation) is the zero-risk alternative — but a *fresh* worktree needs `corepack pnpm install` before any `lint`-dependent command, so the in-tree-probe-with-targeted-cleanup path below is the practical default here. The committed regression test (AC-13) is the primary, repeatable proof and touches no filesystem at all.

### 4.1 AC-1a — Dry-run

```bash
npx nx g @adhd/workspace-codegen-nx:plugin --name ac-probe --group apigen --nxLayer logic --platform node --dry-run
```

PASS = exit 0, output shows `Scaffolding apigen-plugin-ac-probe` and the `CREATE packages/apigen/apigen-plugin-ac-probe/…` list (no file is written in dry-run). Note: if a stale generated package already exists at that path, delete it first (targeted `rm -rf packages/apigen/apigen-plugin-ac-probe` — explicit path, not variable-derived).

### 4.2 Real generation + cleanup protocol

```bash
npx nx g @adhd/workspace-codegen-nx:plugin --name ac-probe --group apigen --nxLayer logic --platform node
```

This is the only step that mutates the tree: it creates `packages/apigen/apigen-plugin-ac-probe/` and updates `tsconfig.base.json` (adds the path mapping). **Cleanup after ALL checks pass (mandatory):**

```bash
rm -rf packages/apigen/apigen-plugin-ac-probe
git restore tsconfig.base.json
git status --short   # must show no stray changes beyond pre-existing ones
```

(`rm -rf` of one explicit, literal path and a single-file `git restore` are both within repo rules; `git clean -fd` and whole-tree restores are forbidden.) The verification must not be left with a scaffolded package in the tree.

### 4.3 AC-1b → AC-5, AC-9 — Generated-content reads (after 4.2's generation)

Read these files with a file-read tool and assert the stated content (binary PASS/FAIL per bullet):

| Criterion | File to read | Assertion |
|---|---|---|
| AC-1b | `packages/apigen/apigen-plugin-ac-probe/project.json` | `name: apigen-plugin-ac-probe`; tags exactly `[domain:apigen, pkg-kind:plugin, pkg-class:optional, layer:logic, platform:node, access:domain]` |
| AC-1b | `packages/apigen/apigen-plugin-ac-probe/package.json` | `name: @adhd/apigen-plugin-ac-probe`; `main`/`module`/`types` point into `./dist/…` |
| AC-1b | `tsconfig.base.json` | contains `"@adhd/apigen-plugin-ac-probe": ["./packages/apigen/apigen-plugin-ac-probe/src/index.ts"]` and nothing else new |
| AC-2 | `…/vite.config.ts` | contains `tools/vite-plugins/externalize.mjs` import; does **not** contain `tools/vite-external-deps.mjs`; contains `external: externalizeRealDeps(__dirname)` |
| AC-3 | `…/vite.config.ts` | contains `tools/vite-plugins/vitest-pool-defaults.mjs` import, `poolOptions: vitestPoolOptions`, `environment: 'node'`, and a `src/**/*.{test,spec}` include |
| AC-4 | `…/vite.config.ts` | `build.outDir` is `'dist'`; no `(\.\./)+dist` outDir |
| AC-5 | `…/project.json` | build `outputPath` = `packages/apigen/apigen-plugin-ac-probe/dist`; no `dist/packages/` |
| AC-9 | `…/project.json` | `test` target exists with executor `@nx/vite:test` and `configFile` = `packages/apigen/apigen-plugin-ac-probe/vite.config.ts` |

### 4.4 AC-6 → AC-8, AC-10, AC-11 — Command gates (exit codes only)

```bash
npx nx build apigen-plugin-ac-probe                      # AC-6: exit 0
test -f packages/apigen/apigen-plugin-ac-probe/dist/index.js    # AC-6: file exists
test -f packages/apigen/apigen-plugin-ac-probe/dist/index.mjs   # AC-6: file exists
test -f packages/apigen/apigen-plugin-ac-probe/dist/index.d.ts  # AC-6: file exists
test ! -d dist/packages/apigen/apigen-plugin-ac-probe           # AC-6: stale layout NOT created
npx nx run apigen-plugin-ac-probe:assets                # AC-7: exit 0 (was: assets: no dist … build first)
npx nx run apigen-plugin-ac-probe:verify-dist-load      # AC-8: exit 0 (drives build+dist-manifest+load of in-tree dist)
npx nx test apigen-plugin-ac-probe                      # AC-10: exit 0; reporter shows ≥1 test file ran (e.g. "Tests  1 passed")
npx nx lint apigen-plugin-ac-probe                      # AC-11: exit 0
```

Do not pass `--skip-nx-cache` anywhere (repo rule — it corrupts the cache and can restore stale dist over fresh output). A normal cached run is the correct proof.

### 4.5 AC-12 — Generator project itself

```bash
npx nx build workspace-codegen-nx   # exit 0
npx nx test workspace-codegen-nx    # exit 0 — runs base/types specs incl. the UPDATED base spec (new import path) and the new plugin spec
```

### 4.6 AC-13 — Regression-test review

- Read `packages/workspace/workspace-codegen-nx/src/generators/plugin/generator.spec.ts` (or the equivalent committed spec) and confirm it drives the real `plugin` generator on an in-memory Tree and asserts (1) the `tools/vite-plugins/externalize.mjs` import + absence of `tools/vite-external-deps.mjs`, (2) in-tree `outputPath`/`outDir`, (3) the `@nx/vite:test` target — and that `base/generator.spec.ts:44` now asserts the new import path.
- Negative-control spot-check (implementer must demonstrate during development, reviewer may re-verify by temporarily reverting one template line in a scratch worktree, re-running `npx nx test workspace-codegen-nx`, and confirming red): reintroducing `../../../tools/vite-external-deps.mjs'` fails the suite.
- The tests are default-running (no env gate) and deterministic (in-memory tree).

## 5. Sources

- `FEATURE.md:1-19` — bug statement, discovered-state evidence (`apigen-plugin-ir-cache` pre-fix at `79aa19f5^`), fix direction (a)/(b)/(c).
- `packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts:159-166` — current stale template: `tools/vite-external-deps.mjs` import + `external:` replacement, no outDir/outputPath/test-target patch.
- `packages/workspace/workspace-codegen-nx/src/generators/plugin/generator.ts:13-16` + `plugin/schema.json` — plugin tier delegates to shared scaffold; schema requires `name/group/nxLayer/platform`.
- `packages/apigen/apigen-plugin-batch/project.json:1-56` — reference: tags, `@nx/vite:build` with in-tree `outputPath`, `@nx/vite:test` target, `nx-release-publish.dependsOn`.
- `packages/apigen/apigen-plugin-batch/vite.config.ts:1-57` — reference: `tools/vite-plugins/externalize.mjs` + `vitest-pool-defaults.mjs` imports, `outDir: 'dist'`, `environment: 'node'`, poolOptions.
- `tools/vite-plugins/externalize.mjs` + `tools/vite-plugins/vitest-pool-defaults.mjs` — the real tools (verified present); `tools/vite-external-deps.mjs` verified absent.
- `tools/nx-plugins/assets/executors/copy/impl.js:28-31` — assets reads `{projectRoot}/dist`, fails `no dist … (build first)` when absent.
- `tools/nx-plugins/build/plugin.js:86-109` — inferred `verify-dist-load` (`@adhd/nx-build:verify`, dependsOn build+dist-manifest), `assets`/`dist-manifest` wiring; in-tree-dist contract.
- `nx.json` (targetDefaults: test→lint/^build; lint→sync-deps; registered plugins incl. `./tools/nx-plugins/build/plugin.js`; `verify-dist-load/plugin.js` NOT registered).
- `packages/workspace/workspace-codegen-nx/src/generators/base/generator.spec.ts:44` — existing spec asserts the STALE path (must be updated with the fix).
- `packages/workspace/workspace-codegen-nx/src/generators/types/generator.spec.ts` — established in-memory-Tree generator-spec pattern.
- Dry-run executed 2026-08-03 on this worktree (validated invocation, name composition, tag set, CREATE list).
