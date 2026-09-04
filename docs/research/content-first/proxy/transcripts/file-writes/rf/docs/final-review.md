# Final Review — BUG-WORKSPACE-GEN-006 (`@adhd/workspace-codegen-nx:plugin` stale generator configs)

- **Stage:** 5/5 FINAL REVIEW (RF arm)
- **Commit under review:** `fa470a4f` (`feat(workspace-codegen-nx): FEAT-012 fix BUG-WORKSPACE-GEN-006 stale plugin generator configs`)
- **Chain documents:** `FEATURE.md` (bug) · `docs/acceptance.md` (AC-1..AC-13) · `docs/spec.md` (implementation spec) · `docs/review.md` (REVIEW/VERIFY stage, verdict **PASS-WITH-NITS**, 13/13 AC PASS)
- **Worktree:** `/Users/nix/dev/sdlc-experiments/arm-rf/rf-run`, branch `arm-rf-manual-20260803`, HEAD `fa470a4f`
- **Reviewed:** 2026-08-03 by the product agent. Independent file reads and greps only (no gate re-runs; recorded exit codes in `docs/review.md:21-33` are trusted as primary evidence).

---

## 1. Verdict (TL;DR)

**Feature resolved — ship it.** The delivered implementation resolves BUG-WORKSPACE-GEN-006 as described in FEATURE.md: all three stale artifacts (vite import path, in-tree dist, missing test target) are fixed in the shared scaffold codepath, proven by 13/13 acceptance criteria with real exit codes and committed regression tests with teeth. Both implementer deviations are correct and necessary — one of them (deviation 1) corrects a factually wrong claim in the spec rather than papering over it. Nothing in the delivered scope rises to a P0 action; follow-ups are the 5-package retro-fix, one regression-test gap, and a set of P2 hygiene items.

---

## 2. Assessment

### 2.1 Does the implementation resolve BUG-WORKSPACE-GEN-006?

**Yes — all three artifacts, explicitly.**

| Artifact (FEATURE.md) | Fix location (commit fa470a4f) | Acceptance | Independent verification |
|---|---|---|---|
| 1. Stale vite import path (`tools/vite-external-deps.mjs`) | `shared/generator.ts:175` now emits `import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs';` + `vitest-pool-defaults.mjs` import in the node/shared branch | AC-2 PASS | Diff read; both tools verified present (`tools/vite-plugins/externalize.mjs:58` exports `externalizeRealDeps`, `tools/vite-plugins/vitest-pool-defaults.mjs:32` exports `vitestPoolOptions`); `base/generator.spec.ts:44` updated to the new path (negative-control guard). |
| 2. Pre-migration workspace-root dist (`outDir: ../../../dist/...` + `outputPath: dist/packages/...`) | `shared/generator.ts:134-142` (outDir regex → `'dist'`, runs before the `emptyOutDir` insert) + `patchProjectJsonTargets` at `:195-218` (build target overwritten wholesale with `outputPath: ${dir}/dist`) | AC-4, AC-5 PASS | Diff read matches spec §3.1(b)/(d) shapes; review recorded in-tree dist artifacts present and `dist/packages/` absent (`docs/review.md:48`). |
| 3. Missing `test` target | `patchProjectJsonTargets` sets `targets.test = { executor: '@nx/vite:test', outputs: ['{workspaceRoot}/coverage/<dir>'], options: { configFile: '<dir>/vite.config.ts' } }` | AC-9, AC-10 PASS | Diff read; teeth proven by the Q6 mechanism — `plugin/generator.spec.ts:41-61` registers `@nx/vite/plugin` in the in-memory tree's `nx.json` so the vitest generator's auto-target is suppressed and pre-fix the assertion fails (`docs/review.md:105`). |

The plugin tier delegates to the shared codepath unchanged (`plugin/generator.ts` untouched, verified in commit `--name-status`), so all other node/shared tiers inherit the corrected templates — as acceptance §3 scoped.

### 2.2 Deviations (both accepted by REVIEW; independently assessed as correct)

- **Deviation 1 — `environment: 'jsdom' → 'node'` patch (`shared/generator.ts:182-189`).** The spec's Q7 answer ("No patch needed; @nx/js defaults testEnvironment to 'node'") was **factually wrong for this call path**: the programmatic `libraryGenerator(tree, schema)` spread never coerces schema defaults (`node_modules/@nx/js/src/generators/library/library.js:18-26`), and `@nx/vite` emits `environment: '${options.testEnvironment ?? 'jsdom'}'` — so the raw scaffold genuinely emits `jsdom`, violating AC-3's `environment: 'node'` requirement. The patch restores the spec's stated intent (FEATURE.md fix direction (a) names "environment node"). It is scoped to node/shared (browser packages correctly keep `jsdom` — verified: `ui-react-base-hooks/vite.config.ts:55`, `ui-react-base-storybook/vite.config.ts:54`) and idempotent. **Bonus teeth:** `plugin/generator.spec.ts:89` asserts `environment: 'node'`, so even the review's flagged "brittle regex" risk (silent no-op if `@nx/vite` changes its default string) is caught by a committed red test — the no-op would leave the generated file without `environment: 'node'`.
- **Deviation 2 — `patchPackageJsonEntries` (`shared/generator.ts:220-232`).** AC-1b (§4.3 table) requires generated `package.json` `main`/`module`/`types` to point into `./dist/…`; the spec §3 omitted any package.json patch, and raw `@nx/js` vite-bundler emit produces root-relative `./index.js`/`./index.mjs`/`./index.d.ts` — broken on publish. The patch writes `./dist/index.js`/`./dist/index.mjs`/`./dist/index.d.ts`, deletes `typings`, sets `types`, and is guarded for entrypoints (`main === undefined` → return) and idempotency (`main.includes('dist')` → return). Correct and necessary. Its one gap — no committed regression test — is P1-2 below.

### 2.3 Quality of the chain's outputs

| Chain artifact | Quality assessment |
|---|---|
| **`docs/acceptance.md`** | Strong. Binary PASS/FAIL criteria, exit-code-gated commands (never grep-on-stdout), exact file paths, a reference "healthy contract" package, an explicit generation-location and cleanup contract, and an honest out-of-scope section that names the exact debt items (stale comments, orphaned plugin, historical BACKLOG text). Minor imprecision: §3 counts "~17" stale comment refs; verified count is 16 `vite.config.ts` files (+3 refs elsewhere in docs, 19 repo-wide) — immaterial. |
| **`docs/spec.md`** | Good but with two factual gaps, both caught downstream rather than by the spec itself: (1) Q7's `testEnvironment: 'node'` claim is wrong for the programmatic call path (deviation 1); (2) §3 omits the `package.json` entry patch its own AC-1b contract requires (deviation 2). The "leaves zero ambiguity" claim (§1) was therefore not quite true — the implementer had to deviate to satisfy the acceptance contract. Otherwise §3's shapes (regexes, function signatures, call-site ordering) matched the shipped code byte-for-byte, and the Q6 teeth mechanism design was genuinely clever. |
| **Implementation (commit fa470a4f)** | Clean. Exactly the 6 files scoped; `shared/generator.ts` matches spec §3.1(a)-(d) plus the two deviations; idempotency guards throughout; entrypoint safety preserved (executor guard + `main === undefined` guard, both independently exercised by a real entrypoint dry-run in review). Commit message follows convention. |
| **`docs/review.md`** | Excellent. 13/13 ACs with real exit codes, explicit cache-replay disclosure plus independent uncached vitest corroboration (12/12 generator suite, 1/1 probe), node_modules-verified deviation analysis, per-assertion teeth mapping, and a clean hand-off "Notes for the final-review stage" section that anticipated several of the P2 items below. |

---

## 3. Follow-up action items

### P0 — none

Nothing in the delivered scope rises to P0: all 13 ACs pass, no gate failure, no data loss, no security issue, no blocked downstream path. The two deviations are correct, and the only missing committed test (deviation 2) is covered at probe level (AC-1b) today, so it degrades regression-hardening, not current correctness.

### P1 — next increment

**P1-1 — Retro-fix the 5 existing node/shared packages still generated/running under `environment: 'jsdom'`**
- **Owner suggestion:** typescript agent (single dispatcher; exactly 5 files — §13 "≤5 items single dispatch is fine"; or `pipeline()` fan-out if parallel speed matters).
- **Repo context:** the same generator node/shared treatment applied to the committed `vite.config.ts` of:
  - `packages/dispatch/dispatch-base-types/vite.config.ts:46` (`platform:shared`, `external: []` at `:36`)
  - `packages/apigen/apigen-base-types/vite.config.ts:55` (`platform:shared`, `external: []` at `:45`)
  - `packages/environment/environment-core-node/vite.config.ts:65` (`platform:node`, `external: [/^node:/]` at `:55`)
  - `packages/environment/environment-builder/vite.config.ts:64` (`platform:node`, `external: [/^node:/]` at `:54`)
  - `packages/environment/environment-base-spec/vite.config.ts:56` (`platform:shared`, `external: []` at `:46`)
- **Scope:** (a) headline fix — `environment: 'jsdom'` → `environment: 'node'` (one line each, matches the generator's new contract); (b) **discovered during final review** — the same sweep should reconcile the `externalizeRealDeps` wiring the generator now emits: 3 of the 5 still carry `external: []` (bundling any real npm dep — the INVESTIGATION-BUILD-TOOL-001 bug class) and 2 use a hand-written `[/^node:/]` that never externalizes real deps. Apply `import { externalizeRealDeps } from '../../../tools/vite-plugins/externalize.mjs'` + `external: externalizeRealDeps(__dirname)` per the reference `apigen-plugin-batch/vite.config.ts:6,39` — but only where the package has runtime deps; a zero-dep pure-types package can stay `external: []`. Per-package judgment.
- **Verification:** each package: `npx nx test <pkg>` exit 0 (env is node, not jsdom — reporter shows `environment 0ms`, no jsdom), `npx nx run <pkg>:verify-dist-load` exit 0 (dist still loads — proves the externalize change didn't bundle-fail), `npx nx lint <pkg>` exit 0.
- **Must NOT touch:** `ui-react-base-hooks/vite.config.ts:55` and `ui-react-base-storybook/vite.config.ts:54` — browser packages that legitimately keep `jsdom`.
- **Citation:** grep of `environment: 'jsdom'` across `packages/**/vite.config.ts` returned exactly these 5 node/shared packages plus the 2 browser ones; platform tags read from each `project.json`; `external:` lines read from each file.

**P1-2 — Add a committed regression test for `patchPackageJsonEntries` (deviation 2)**
- **Owner suggestion:** typescript agent.
- **Repo context:** `packages/workspace/workspace-codegen-nx/src/generators/plugin/generator.spec.ts` (119 lines, 5 tests today) — add a 6th test asserting the generated `package.json` has `main: './dist/index.js'`, `module: './dist/index.mjs'`, `types: './dist/index.d.ts'`, and no `typings` key. **Teeth:** reverting the patch leaves the raw `@nx/js` root-relative entries → red. Optional hardening (cheap, same fixture): assert the entrypoint guard — generate via the entrypoint path and assert its `package.json` is untouched (no `main`).
- **Why now:** today deviation 2 is covered only at probe level (AC-1b §4.3, `docs/review.md:107` "no committed assertion"); a future regression would ship broken publish entries silently.
- **Citation:** `docs/review.md:107,124`; `shared/generator.ts:220-232`.

### P2 — hygiene / debt

**P2-1 — Remove (or repair) orphaned `tools/nx-plugins/verify-dist-load/plugin.js`**
- **Owner suggestion:** refactor agent (separate ticket, explicitly deferred by acceptance §3 and spec Q3).
- **Repo context:** file exists (4.6 KB); references non-existent `scripts/verify-dist-load.mjs` (verified absent); is **not** registered in `nx.json`'s `plugins` list (only `lint`, `build`, `assets`, `deps`, `test` plugin.js files — read `nx.json:66-99`); the `nx.json:163` "verify-dist-load" hit is the `nx-release-publish` `dependsOn` entry, not a plugin registration. Live wiring is the inference in `tools/nx-plugins/build/plugin.js:89`. Pre-deletion step: grep for importers of the orphan path; if none, delete; if some, repair the script reference or fold into the build plugin.
- **Citation:** `docs/review.md:116`; `docs/acceptance.md:125`; `nx.json:66-99,155-168`.

**P2-2 — Stale-comment sweep: 16 `vite.config.ts` files (19 repo-wide refs) naming `tools/vite-external-deps.mjs`**
- **Owner suggestion:** general/typescript agent; mechanical, low-risk.
- **Repo context:** 16 files under `packages/**/vite.config.ts` (verified: all currently in `packages/apigen/`, e.g. `packages/apigen/apigen-plugin-api-express/vite.config.ts:36` — a comment: "see tools/vite-external-deps.mjs"); +3 further refs in docs/other files (19 total, excl. `node_modules`/`.nx/`/`dist/`). Update to `tools/vite-plugins/externalize.mjs`. Comment-only — no behavior impact (verified the sample is inside a comment, not code), but run `nx lint` on touched projects after.
- **Citation:** `docs/review.md:117`; grep count above.

**P2-3 — Decide on generated `package.json` `files`/`publishConfig` for publish-path completeness**
- **Owner suggestion:** product (decision) + backend (implementation) — decision first, then a small generator change.
- **Repo context:** reference `apigen-plugin-batch/package.json:10-18` carries `publishConfig: { "access": "public" }` + `files: ["dist", "CHANGELOG.md"]`; the generated probe `package.json` has neither (deviation-2 nit, `docs/review.md:95,122`). Without `files`, `npm pack` would include `src/`, tsconfigs, etc. Recommended direction: emit `files: ["dist", "CHANGELOG.md"]` unconditionally in `patchPackageJsonEntries`; keep `publishConfig.access` driven by the `--access` flag (default `access:domain` → no public publishConfig) rather than hardcoding public. Ties into the out-of-scope publish pipeline (`docs/acceptance.md:128`).
- **Citation:** `docs/review.md:95,122`; `packages/apigen/apigen-plugin-batch/package.json:10-18`.

**P2-4 — Fold the two accepted deviations back into `docs/spec.md` so the spec is truthful; keep `docs/acceptance.md` in sync**
- **Owner suggestion:** typescript agent (same ticket as the next generator touch) or doc steward.
- **Repo context:** (1) rewrite spec Q7's answer — state that on the programmatic `libraryGenerator` path the `testEnvironment: 'node'` schema default is not applied and `@nx/vite` falls back to `'jsdom'`, hence the jsdom→node patch in the node/shared branch; (2) add `patchPackageJsonEntries` to spec §3.1 (as 3.1(e), with its guards) and the jsdom→node patch to §3.1(c); (3) `docs/acceptance.md` needs no correction (its AC-1b §4.3 row already requires `./dist/…` entries — the spec was the laggard), but re-read it after any generator change to confirm the verification plan still matches.
- **Why:** the spec currently asserts a factually wrong environment behavior and omits a shipped patch; a future implementer re-reading the spec as "zero ambiguity" would be misled (this chain's deviation 1 exists precisely because Q7 was wrong).

**P2-5 — Chain hygiene: commit `docs/review.md` (currently untracked)**
- **Owner suggestion:** whoever closes the chain / the human approver.
- **Repo context:** `git status` shows `docs/review.md` untracked — the REVIEW/VERIFY stage's deliverable was never committed (commit `fa470a4f` contains FEATURE.md, acceptance, spec, and the three source files only). This final-review.md has the same status by design (constraint: no commit from this stage). Recommend committing both chain documents as `docs/` when the chain closes, so the audit trail survives.
- **Citation:** `git status --short` at final-review time.

---

## 4. Chain health

### What went well

- **Teeth-verified committed tests.** AC-13's regression suite is the real deal: `plugin/generator.spec.ts` registers `@nx/vite/plugin` in the in-memory tree's `nx.json` (the Q6 mechanism) so the test-target assertion fails pre-fix; import-path and outputPath assertions map 1:1 to revertable defects; every assertion maps to a red test when the fix is reverted. Independently re-verified green uncached (12/12 across 3 spec files — `docs/review.md:24`).
- **Probe-package proof.** The reviewer drove a real scaffold through build → assets → verify-dist-load → test → lint with exit-code gates, verified in-tree dist files with `test -f`, verified the stale layout's absence, and confirmed the exact previously-failing target (`assets: no dist … build first`) is now green (`docs/review.md:28-33`).
- **Honest deviation reporting.** Both deviations were documented with node_modules-verified mechanisms (the schema-spread behavior, the `?? 'jsdom'` fallback, the plugin-registration skip in the vitest generator). Deviation 1 in particular corrected a wrong spec claim instead of silently "fixing" around it — the right move, and the review judged it on its merits.
- **Reviewer re-verification.** Cache replays were disclosed rather than presented as fresh proof, with independent uncached vitest runs and a fresh `verify-dist-load` invocation as corroboration (`docs/review.md:19,24,31`).
- **Teeth extend to the deviation patches.** Deviation 1's jsdom→node patch has a committed assertion (`plugin/generator.spec.ts:89`) that also catches the flagged "brittle regex" no-op risk — good defense in depth.

### What could improve

- **The spec's factually wrong Q7.** A "leaves zero ambiguity" spec that answers "no patch needed for the environment" when the programmatic path actually emits `jsdom` forced the implementer to deviate. The spec author did not verify the non-CLI call path in `node_modules`; the reviewer had to. Cost: one accepted deviation plus a spec that is still untruthful today (P2-4).
- **The spec omitted a patch its own acceptance contract required.** AC-1b demands `./dist/…` package.json entries; spec §3 has no package.json item. The implementer caught it (deviation 2) — good — but the spec/acceptance contract gap should have been caught at spec-writing time.
- **Minor numeric imprecision** in acceptance §3 ("~17" stale comment refs vs verified 16 vite.config.ts + 3 elsewhere) — immaterial, but the count was checkable at write time.
- **Chain-document commit hygiene.** The REVIEW stage's output (`docs/review.md`) was left untracked; the audit trail only survives if the closing step commits it (P2-5).
- **The 5-package jsdom debt was known pre-fix** and is the natural next increment — the review named it; this final review adds that those packages are also missing the generator's externalize wiring, so the retro-fix ticket should cover both (P1-1).

---

## 5. Sources / evidence

- Commit diff: `git show fa470a4f` (6 files; `shared/generator.ts` +64/−3).
- `shared/generator.ts:117-119,134-142,171-189,195-232` — call sites, outDir patch, node/shared branch (incl. jsdom→node), `patchProjectJsonTargets`, `patchPackageJsonEntries`.
- `plugin/generator.spec.ts:1-119` (5 tests, Q6 plugin-registration teeth); `base/generator.spec.ts:11,44` (updated path + doc comment).
- `tools/vite-plugins/externalize.mjs:58`, `tools/vite-plugins/vitest-pool-defaults.mjs:27,32` — verified exports.
- Grep `environment: 'jsdom'` in `packages/**/vite.config.ts` → 7 files (5 node/shared + 2 browser); per-package `platform:` tags from each `project.json`.
- Grep `vite-external-deps.mjs` → 16 vite.config.ts + 3 other refs (19 repo-wide); sample at `packages/apigen/apigen-plugin-api-express/vite.config.ts:36` (comment).
- `tools/nx-plugins/verify-dist-load/plugin.js` exists; `scripts/verify-dist-load.mjs` absent; `nx.json:66-99` plugins list (no verify-dist-load), `nx.json:163` is `nx-release-publish` dependsOn.
- `packages/apigen/apigen-plugin-batch/package.json:10-18` — `publishConfig` + `files` reference shape.
- `docs/review.md` (verdict PASS-WITH-NITS, gates table, deviations, teeth, notes) and `docs/acceptance.md` §4.3 AC-1b row (package.json `./dist` entries required).
- `git status --short` at final-review time: only `?? docs/review.md` (untracked).

Citations: [active git context: fa470a4f diff, product agent, claude, final-review stage, 1: packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts:117-232, 2: packages/workspace/workspace-codegen-nx/src/generators/plugin/generator.spec.ts:41-118, 3: docs/review.md:19-132, 4: docs/acceptance.md:119-129, 5: nx.json:66-99, 6: tools/vite-plugins/externalize.mjs:58, 7: tools/vite-plugins/vitest-pool-defaults.mjs:32, 8: packages/apigen/apigen-plugin-batch/package.json:10-18]
