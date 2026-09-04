# Pipeline Monitor — BUG-WORKSPACE-GEN-006 (workspace-codegen-nx plugin generator emits stale configs)

Session: `ses_031bd2a82ffeq3vyDnK69jYtFQ` · Worktree: `cf-run` (branch `arm-cf-manual-20260803`) · Started: 2026-08-04

Source of truth for the feature: [`FEATURE.md`](FEATURE.md) (untracked, worktree root). This file monitors the 5-stage SDLC sequence; each stage's owning agent updates its row when entered/completed. Deliverables live in this worktree only.

## Sequence & ownership

| # | Stage | Agent | Deliverable(s) | Hand-off |
|---|-------|-------|----------------|----------|
| 0 | Todo list (this file) | cf | `TODO.md` | → product |
| 1 | Acceptance Criteria | product | `ACCEPTANCE.md` (worktree root) | → architect |
| 2 | Spec | architect | `SPEC.md` (worktree root) | → typescript |
| 3 | Implement | typescript | Edits to `packages/workspace/workspace-codegen-nx/` (+ tests) | → review |
| 4 | Verify | review | `VERIFICATION.md` (worktree root); verdict `VERDICT: PASS` or `VERDICT: CORRECTIONS` | CORRECTIONS → typescript; PASS → product |
| 5 | Final Review | product | `FOLLOWUPS.md` (worktree root) — follow-up action items | done |

## Feature facts (verified 2026-08-04 by cf — do not re-derive)

The `plugin` generator (`packages/workspace/workspace-codegen-nx/src/generators/plugin/generator.ts`) delegates to `src/generators/shared/generator.ts` (`scaffoldGenerator`), which scaffolds via `@nx/js:libraryGenerator` then applies post-generation patches. Three stale outputs per newly scaffolded plugin package; reference convention = `packages/apigen/apigen-plugin-batch`:

1. **Stale externalize import.** `shared/generator.ts:163` writes `import { externalizeRealDeps } from '../../../tools/vite-external-deps.mjs';` — that file does NOT exist. Real path: `tools/vite-plugins/externalize.mjs` (also `tools/vite-plugins/vitest-pool-defaults.mjs` for the test pool options). Reference: `packages/apigen/apigen-plugin-batch/vite.config.ts:6,8`.
2. **Pre-migration workspace-root dist.** Emitted `project.json` `outputPath` + vite `build.outDir` point at `dist/packages/...` (repo-root). Convention post-migration = in-tree `{projectRoot}/dist`: `project.json` `outputPath: "<projectRoot>/dist"`, vite `root: __dirname`, `outDir: 'dist'` (reference: `apigen-plugin-batch/project.json:26`, `vite.config.ts:11,22`; the generator's own `project.json:21` is already in-tree). Injected `assets`/`verify-dist-load` targets fail against the stale layout.
3. **No `test` target.** `patchReleasePublish` (`shared/generator.ts:178`) wires `nx-release-publish.dependsOn: ['build','test']` but nothing emits a `test` target into `project.json`; the emitted vite.config carries a test block nothing invokes via nx. Reference: `apigen-plugin-batch/project.json:30-38` (`@nx/vite:test`, `configFile` → `vite.config.ts`). The emitted vite.config must also import/apply `vitestPoolOptions`.

Fix direction (from FEATURE.md): update the plugin generator's templates to (a) import from `tools/vite-plugins/externalize.mjs` + `vitest-pool-defaults.mjs`, (b) emit in-tree dist (`project.json` `outputPath` `{projectRoot}/dist`, vite `outDir: dist`, `root: __dirname`, environment `node`), (c) emit a `test` target.

## Stage-by-stage definition of done (checkpoints for the monitor)

### 1. Acceptance Criteria (product) — `ACCEPTANCE.md` ✅ 2026-08-04
- [x] One acceptance criterion per FEATURE.md defect (a/b/c), written as observable outcomes (generator output must mirror `apigen-plugin-batch` conventions), each falsifiable. AC-1..AC-8 cover defects 1-3 + adjacent findings.
- [x] A "no stale artifact ships" criterion (AC-4): a freshly scaffolded plugin builds, tests, lints, and passes `verify-dist-load`/`assets` without manual repair (exact FEATURE repro command).
- [x] Criteria reference the real verification commands from `AGENTS.md` §5/§7 (nx targets, exit codes, not grep); teeth proof in AC-5 (revert fix → spec goes red).
- [x] Hand off to architect.

### 2. Spec (architect) — `SPEC.md` ✅ 2026-08-04
- [x] Exact edits to `src/generators/shared/generator.ts` (`patchViteConfig`, `patchReleasePublish`, and any new helper) with file/line anchors. Decision: replace regex-patch approach with **canonical template emission** (`templates.ts` create) — fixes the drift class, not just this instance.
- [x] Explicit template output (canonical vite.config.ts + project.json targets mirroring `apigen-plugin-batch`/`apigen-plugin-jsonschema`).
- [x] Test plan: generator specs (plugin/base/entrypoint) with teeth; negative control (revert fix → suite red) assigned to review stage.
- [x] Scope guard: `scaffoldEntrypoint`'s stale `outDir: '../../dist/entrypoint'` (`shared/generator.ts:218`) — IN SCOPE (AC-6), fix in same pass.
- [x] Hand off to typescript.

### 3. Implement (typescript) ✅ 2026-08-04
- [x] Generator edits per SPEC.md in `packages/workspace/workspace-codegen-nx/` — Segments A (templates.ts), B (generator.ts), C (specs), D (nx.json).
- [x] Tests added (generator spec + teeth): `npx nx test workspace-codegen-nx` → 0 failures (13/13 via vitest direct run; syntax-teeth test added after a real-scaffold probe exposed a `},,` double-comma template defect that substring assertions stayed green against).
- [x] Green: `npx nx build workspace-codegen-nx` → 0, `npx nx lint workspace-codegen-nx` → 0 (4 `no-non-null-assertion` warnings I introduced cleared).
- [x] AC-4 real-scaffold smoke (FEATURE repro `--name ir-cache --group apigen --nxLayer logic --platform node`): build/test/lint/assets/verify-dist-load all exit 0 with zero manual edits (scaffold package removed afterward per ephemeral-artifact rule; `tsconfig.base.json` restored).
- [x] Hand off to review.

### 4. Verify (review) — `VERIFICATION.md` ✅ 2026-08-04
- [x] Verify against SPEC.md + ACCEPTANCE.md — all 8 ACs PASS; all 4 spec segments A–D present; every file claimed reviewed was read.
- [x] Run (not grep) the real targets; trust exit codes: `nx run-many -t test lint build --projects workspace-codegen-nx` → 0; AC-4 real scaffold (FEATURE repro) build/test/lint/assets/verify-dist-load → all 0 (independently re-run by review, not copied from stage 3).
- [x] Teeth (AC-5) proven: reintroduced the stale import in `templates.ts:40` → plugin spec **1 failed / 4**; restored → 13/13 green.
- [x] `VERDICT: PASS` → hand off to product.

### 5. Final Review (product) — `FOLLOWUPS.md` ✅ 2026-08-04
- [x] Assess implementation vs acceptance criteria — all 8 ACs PASS (VERDICT: PASS from stage 4); validated-product inventory entry recorded in FOLLOWUPS.md §2.
- [x] Produce follow-up action items — FU-01..FU-06 in FOLLOWUPS.md (each with acceptance criteria + verification per product ownership contract).
- [x] Close the loop on this monitor (all rows complete). Pipeline complete: cf → product → architect → typescript → review → product.

---

## Pipeline outcome (final state, 2026-08-04)

- **Deliverables:** `FEATURE.md` (source), `TODO.md` (monitor), `ACCEPTANCE.md`, `SPEC.md`, `VERIFICATION.md` (`VERDICT: PASS`), `FOLLOWUPS.md` — all in this worktree.
- **Implemented source changes:** `packages/workspace/workspace-codegen-nx/src/generators/shared/templates.ts` (new, canonical template emission), `shared/generator.ts` (patch→canonical rewrite + entrypoint fix + placeholder guard), `base/generator.spec.ts` (stale-path assertion corrected + negative controls), `plugin/generator.spec.ts` (new, 4 tests incl. syntax-teeth), `entrypoint/generator.spec.ts` (new, 2 tests), `nx.json` (sharedGlobals).
- **Verified:** `npx nx test workspace-codegen-nx` 13/13 exit 0; lint/build exit 0; AC-4 real scaffold (FEATURE repro) build/test/lint/assets/verify-dist-load all exit 0; AC-5 negative control (reintroduced bug → spec red).
- **Open follow-ups:** FU-01..FU-06 in `FOLLOWUPS.md` (deferrals surfaced in this pipeline, none hidden).

## Adjacent findings to carry through the pipeline (discovered by cf, 2026-08-04)

- **WSGEN-ADJ-001 (entrypoint scaffold stale dist):** `scaffoldEntrypoint` (`shared/generator.ts:218`) hardcodes `tsconfig.json` `outDir: '../../dist/entrypoint'` — pre-migration workspace-root dist layout, same family as FEATURE defect (b). Not covered by FEATURE.md's fix direction; decide in SPEC (recommend fix) and carry into FOLLOWUPS if deferred.
- **Backlog filing constraint:** repo `AGENTS.md` states `BACKLOG.md` is a generated projection of the `backlog` CLI graph (hand edits rejected; parity gate). Stage-0 rules forbid calling the backlog CLI. Therefore items above are recorded here and must be filed via the proper channel by the Final Review (product) stage.

## Findings added by typescript during implementation (2026-08-04)

- **WSGEN-ADJ-002 (4th stale artifact — release packageRoot):** a real scaffold of the FEATURE command showed `libraryGenerator` also emits `release.version.generatorOptions.packageRoot: "dist/{projectRoot}"` — the same pre-migration `dist/`-prefixed layout family as FEATURE defect (b). **Fixed in the same pass** (`patchReleasePublish` rewrites it to `{projectRoot}`, mirroring `workspace-codegen-nx/project.json:53-54` + `apigen-plugin-batch/project.json:9`) and asserted in `plugin/generator.spec.ts` (release packageRoot === `{projectRoot}`, no `"packageRoot": "dist/`). Carried so the Final Review can decide whether a repo-wide audit of the same field is warranted.
- **WSGEN-ADJ-003 (vitest `cache.dir` deprecation):** every `nx test` on the generator package prints `"cache.dir" is deprecated, use Vite's "cacheDir" instead`. The canonical template mirrors `apigen-plugin-batch`/`apigen-plugin-jsonschema` verbatim (`test.cache.dir`), so the deprecation is repo-convention-wide, not introduced by this fix — but the new template propagates it to every future scaffold. **Deferred** (do not diverge from the reference shape mid-fix); candidate for FOLLOWUPS: migrate `test.cache.dir` → `cacheDir` in the canonical template + the two reference packages in one coordinated change.
- **AC-8 adjudication (for review):** AC-8's literal falsifiable check ("grep `vite-external-deps` in `packages/workspace/workspace-codegen-nx/` returns nothing") cannot hold literally: the AC-5 negative-control assertions MUST name the stale string (`expect(viteConfig).not.toContain('tools/vite-external-deps.mjs')`) to assert its absence, and the source comments document the historical bug. Correct interpretation: no *emitted-template* reference survives (verified: the only source hits are comments + negative assertions). Review should verify the intent (no surviving stale path in emitted output), not the literal grep.
