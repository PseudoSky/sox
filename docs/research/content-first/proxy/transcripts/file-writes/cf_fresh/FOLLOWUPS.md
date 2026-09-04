# Final Review & Follow-Ups — BUG-WORKSPACE-GEN-006 (workspace-codegen-nx plugin generator emits stale configs)

- **Owner:** product agent · **Date:** 2026-08-04 · **Stage:** 5 of 5 (final review)
- **Verdict from stage 4:** `VERDICT: PASS` (see `VERIFICATION.md`)
- **Pipeline monitor:** `TODO.md` — all rows complete.

## 1. Final assessment — implementation vs acceptance criteria

All 8 acceptance criteria (ACCEPTANCE.md) verified PASS by the review agent in stage 4, with evidence recorded in `VERIFICATION.md`:

| AC | Criterion | Verdict | Evidence |
|----|-----------|---------|----------|
| AC-1 | real `tools/vite-plugins/*` imports, no stale path | PASS | real-scaffold `vite.config.ts` + spec assertions + negative control |
| AC-2 | in-tree dist (`{projectRoot}/dist`), `assets` gate works | PASS | real scaffold `outputPath`/`outDir`/`root`; `nx run :assets` exit 0 |
| AC-3 | runnable `test` target | PASS | emitted `test` target; `nx test` on scaffold exit 0 |
| AC-4 | FEATURE repro, zero manual repair, all 5 gates | PASS | build/test/lint/assets/verify-dist-load all exit 0 (independently re-run by review) |
| AC-5 | regression teeth | PASS | **negative control executed**: reintroduced stale import → plugin spec 1 failed/4; restored → 13/13 green |
| AC-6 | entrypoint scaffold in-tree dist | PASS | entrypoint spec (2 tests) + source fix |
| AC-7 | `nx.json` sharedGlobals covers `vitest-pool-defaults.mjs` | PASS | `nx.json:29` |
| AC-8 | no stale-path guidance survives in emitted template | PASS (adjudicated) | grep hits are comments + negative assertions + gitignored dist only |

The fix went beyond the three FEATURE defects in-scope and closed a 4th same-family stale artifact discovered during implementation (`release.version.generatorOptions.packageRoot: "dist/{projectRoot}"` → `{projectRoot}`, WSGEN-ADJ-002) — documented and spec-asserted.

**Verdict: the feature is complete, verified, and shippable within this pipeline's scope.** The generator now emits deterministic, migration-correct configs mirroring `apigen-plugin-batch`; every future scaffold builds/tests/lints/passes `verify-dist-load` with zero manual repair.

## 2. Validated-product inventory

| Ticket | Feature | Verification run | Ship date | Still working |
|--------|---------|------------------|-----------|---------------|
| BUG-WORKSPACE-GEN-006 | Canonical template emission in `@adhd/workspace-codegen-nx` (plugin/base/entrypoint scaffolds: in-tree dist, real `tools/vite-plugins/*` imports, `test` target, publish gate) | `npx nx test/lint/build workspace-codegen-nx` (13/13, exit 0) + AC-4 real scaffold (5 gates exit 0) + AC-5 negative control (spec went red on reintroduced bug) | 2026-08-04 | YES — verified post-fix; re-verify after any future `@nx/js:libraryGenerator` upgrade (see FU-02) |

## 3. Follow-up action items (rolling roadmap queue)

Each item has objective acceptance criteria per the product ownership contract. Priorities use real impact/effort from this session.

### FU-01 — Migrate `test.cache.dir` → Vite `cacheDir` in the canonical template + reference packages (WSGEN-ADJ-003)
- **Severity/priority:** P2 · **Effort:** S · **Owner:** typescript
- **Problem:** the canonical template's `test.cache.dir` triggers vitest's `"cache.dir" is deprecated` warning on every test run; every future scaffold propagates it. The reference packages (`apigen-plugin-batch`, `apigen-plugin-jsonschema`) carry the same shape, so the deprecation is repo-convention-wide.
- **Acceptance criteria:**
  - `canonicalViteConfig` emits the vitest 5-era `cacheDir` form (or drops the deprecated `test.cache.dir`) in `templates.ts`.
  - Both reference packages updated to the same form; `nx test` on each shows no `cache.dir is deprecated` warning.
  - `npx nx test workspace-codegen-nx` → 13/13, exit 0.
- **Verification:** `nx test` exit codes + warning-string absence in output.

### FU-02 — Re-verify generator output after any `@nx/js:libraryGenerator` / Nx upgrade
- **Severity/priority:** P2 (process) · **Effort:** S per upgrade · **Owner:** devops/CI
- **Problem:** the original drift arose because `libraryGenerator` output changed under the generator (regex patches silently missed). The canonical-template design stops the drift class for *this* Nx version, but the next Nx major can change `libraryGenerator`'s emitted shape again (this session observed the Nx 19 name-derivation warning during scaffolding).
- **Acceptance criteria:**
  - After any Nx upgrade, `npx nx test workspace-codegen-nx` (generator spec suite) runs in CI and stays green.
  - A CI job scaffolds a throwaway plugin + entrypoint and runs build/test/verify-dist-load (the AC-4 gate) as a regression probe.
- **Verification:** CI job exit codes; generator suite green post-upgrade.

### FU-03 — Repo-wide audit of `release.version.generatorOptions.packageRoot` for remaining `dist/{projectRoot}` values (WSGEN-ADJ-002 follow-up)
- **Severity/priority:** P3 · **Effort:** M · **Owner:** typescript
- **Problem:** the generator now rewrites the 4th stale artifact it emits, but existing packages scaffolded before the fix may carry `"packageRoot": "dist/{projectRoot}"` in their `release.version.generatorOptions` (the same family as FEATURE defect b). The FEATURE's non-goals excluded migrating already-scaffolded packages, but a detection sweep is cheap.
- **Acceptance criteria:**
  - `grep -rl '"packageRoot": "dist/' packages/ entrypoint/` run against the repo; every hit either fixed to `{projectRoot}` or explicitly filed.
  - Zero un-filed `dist/{projectRoot}` packageRoot values in tracked manifests.
- **Verification:** grep audit + fixed-count recorded.

### FU-04 — File WSGEN-ADJ-001/002/003 + AC-8 adjudication through the proper backlog channel
- **Severity/priority:** P2 (process) · **Effort:** S · **Owner:** product/backlog
- **Problem:** the repo's `BACKLOG.md` is a generated projection of the `backlog` CLI graph; session rules forbade calling the backlog CLI, so this pipeline's findings were recorded in `TODO.md` (`WSGEN-ADJ-001/002/003`) rather than filed. They must be entered via the `backlog` CLI/MCP in a session that may call it.
- **Acceptance criteria:**
  - `WSGEN-ADJ-001` (entrypoint stale dist — now FIXED in-pass; log as resolved/closed with the fix reference), `WSGEN-ADJ-002` (4th stale artifact — fixed in-pass), `WSGEN-ADJ-003` (cache.dir deprecation — FU-01) exist in the backlog graph.
  - AC-8's falsifiable-clause wording corrected in ACCEPTANCE.md to "no emitted-template reference survives" (it currently demands a literal grep-zero that the AC-5 negative controls make impossible). — **DONE 2026-08-04, product stage 5: ACCEPTANCE.md AC-8 rewritten (see the "Correction 2026-08-04" note in that section); this acceptance criterion is closed.**
- **Verification:** `backlog` CLI query returns the three items; ACCEPTANCE.md wording updated (the wording half is done and verified by reading ACCEPTANCE.md post-edit).

### FU-05 — Clean up dead `rel` entrypoint branch in `patchViteConfig`
- **Severity/priority:** P3 (hygiene) · **Effort:** S · **Owner:** typescript
- **Problem:** review found the `dir.startsWith('entrypoint/') ? '../../' : '../../../'` branch in `patchViteConfig` (generator.ts:134) is dead code — entrypoint scaffolds never have a `vite.config.ts`, so the function returns at the existence guard first. Harmless, kept for defensive symmetry.
- **Acceptance criteria:** simplify to a single `'../../../'` with a comment, or keep with an explicit "entrypoints never reach this" note; `npx nx test workspace-codegen-nx` stays 13/13.
- **Verification:** nx test exit 0.

### FU-06 — Correct stale `dist/...` references in unrelated docs
- **Severity/priority:** P3 (doc debt) · **Effort:** M · **Owner:** docs
- **Problem:** ACCEPTANCE.md non-goals explicitly deferred repo-wide stale `dist/packages|dist/entrypoint` references in unrelated docs (e.g. `entrypoint/dispatch-cli/docs/marketing/*`, `docs/plan/*`, root `package.json` `logs:agent` → `dist/packages/ai/...`). These are pre-existing and not produced by this generator.
- **Acceptance criteria:** a tracked doc-debt pass (or per-file fixes) repoints stale references to current in-tree paths; no new stale-reference introductions.
- **Verification:** grep audit against `dist/packages|dist/entrypoint` in tracked docs; drift record.

## 4. Learnings (feedback loop — ownership contract §5)

- **The recurrence root cause was architectural, and the fix is durable:** the generator drifted because it regex-patched `@nx/js:libraryGenerator` output; every migration changed the base scaffold and the regexes silently missed. Replacing patch-and-drift with deterministic canonical-template emission (the architect's key decision, SPEC.md §Summary) fixes the *class*, not just this instance. Validation: the real-scaffold probe immediately surfaced a **4th** stale artifact (`release.packageRoot`) and a `},,` double-comma template defect that substring assertions stayed green against — both caught only because the verification standard demands real-component proof, not unit-test proxy (AGENTS.md §7).
- **AC-5's teeth requirement earned its keep:** the negative-control run (reintroduce the bug → spec goes red) proved the suite actually guards the contract. Without it, the substring assertions could have stayed green against a malformed artifact (as the `},,` incident demonstrated).
- **AC wording lesson:** AC-8's literal "grep returns nothing" falsifiable check was impossible to satisfy *because* the AC-5 negative controls must name the stale string to assert its absence. Future acceptance criteria should phrase absence-checks as "no surviving reference in *emitted/production* surfaces" to avoid self-contradictory falsifiability (recorded in FU-04).
- **Adoption signal:** the fix is a generator behavior change — adoption is "every future scaffold." The validated-product inventory entry + FU-02's CI probe are the standing proof mechanism; there is no user-facing metric beyond green scaffolding.

## 5. Scope notes (no un-flagged scope cuts)

- All 8 ACs shipped in full; AC-6 pulled the adjacent entrypoint staleness (WSGEN-ADJ-001) into the same pass at ~zero marginal cost per the "do the whole thing" standard.
- Explicitly deferred (each logged above, none hidden): vitest `cache.dir` migration (FU-01), Nx-upgrade regression probe (FU-02), repo-wide `packageRoot` audit (FU-03), backlog filing (FU-04), dead-branch hygiene (FU-05), unrelated doc debt (FU-06).
