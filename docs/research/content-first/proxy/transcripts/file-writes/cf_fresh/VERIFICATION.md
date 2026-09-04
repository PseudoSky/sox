# Verification Report — BUG-WORKSPACE-GEN-006 (workspace-codegen-nx generator emits stale configs)

- **Reviewer:** review agent · **Date:** 2026-08-04 · **Stage:** 4 of 5
- **Contracts verified against:** `SPEC.md` (192 lines), `ACCEPTANCE.md` (100 lines), `FEATURE.md` (19 lines), `TODO.md`
- **Verdict: `VERDICT: PASS`** — hand off to product (stage 5).

```json
{
  "$schema": "review-report-v1",
  "reviewer": "review",
  "reviewed_at": "2026-08-04T15:1x:00Z",
  "files_reviewed": [
    "packages/workspace/workspace-codegen-nx/src/generators/shared/templates.ts",
    "packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts",
    "packages/workspace/workspace-codegen-nx/src/generators/base/generator.spec.ts",
    "packages/workspace/workspace-codegen-nx/src/generators/plugin/generator.spec.ts",
    "packages/workspace/workspace-codegen-nx/src/generators/entrypoint/generator.spec.ts",
    "nx.json",
    "SPEC.md",
    "ACCEPTANCE.md",
    "TODO.md"
  ],
  "verification": {
    "build": "passed",
    "test": { "passed": 13, "failed": 0 },
    "gitnexus_impact_checked": false
  },
  "findings": [
    {
      "severity": "info",
      "category": "design",
      "file": "packages/workspace/workspace-codegen-nx/src/generators/shared/generator.ts",
      "line": 134,
      "description": "The entrypoint branch of the `rel` computation (`dir.startsWith('entrypoint/') ? '../../' : '../../../'`) is dead code: entrypoint scaffolds never have a `vite.config.ts`, so `patchViteConfig` returns at the existence guard before reaching it. Harmless; kept for defensive symmetry.",
      "fix_sketch": "Optionally simplify to `'../../../'` with a comment that entrypoints never reach this function."
    },
    {
      "severity": "info",
      "category": "spec-compliance",
      "file": "ACCEPTANCE.md",
      "line": 74,
      "description": "AC-8's literal falsifiable check ('grep tools/vite-external-deps in packages/workspace/workspace-codegen-nx returns nothing') cannot hold literally: the AC-5 negative-control assertions MUST name the stale string to assert its absence (base/generator.spec.ts:54, plugin/generator.spec.ts:108), and the source comments document the historical bug. Adjudicated: the intent (no surviving stale path in EMITTED output) is verified — the only remaining source hits are comments + negative assertions; the only other hits are gitignored dist build output.",
      "fix_sketch": "Reword AC-8's falsifiable clause to 'no emitted-template reference survives' (already recorded in TODO.md for product's FOLLOWUPS pass)."
    },
    {
      "severity": "info",
      "category": "design",
      "file": "packages/workspace/workspace-codegen-nx/src/generators/shared/templates.ts",
      "line": 97,
      "description": "The canonical template's `test.cache.dir` triggers vitest's 'cache.dir is deprecated, use cacheDir' warning on every run. Mirrors apigen-plugin-batch/jsonschema verbatim per spec, so the deprecation is repo-convention-wide, not introduced by this fix — but every future scaffold propagates it. Deferred (WSGEN-ADJ-003 in TODO.md); coordinated migration of the template + both reference packages to `cacheDir` is a FOLLOWUPS candidate.",
      "fix_sketch": "Migrate `test.cache.dir` -> top-level Vite `cacheDir` in canonicalViteConfig + apigen-plugin-batch + apigen-plugin-jsonschema in one coordinated change."
    }
  ],
  "summary": { "critical": 0, "high": 0, "medium": 0, "low": 0, "info": 3 },
  "backlog_entries": ["none filed — backlog CLI is forbidden by session rules and BACKLOG.md is a generated projection; findings recorded in TODO.md for product's stage-5 filing"],
  "open_questions": []
}
```

## Acceptance-criteria verdicts (each independently verified this stage)

| AC | Verdict | Evidence (this stage) |
|----|---------|------------------------|
| AC-1 (real `tools/vite-plugins/*` imports, no stale path) | PASS | Real scaffold `vite.config.ts:6-7,39,44` shows `externalizeRealDeps` from `tools/vite-plugins/externalize.mjs` + `vitestPoolOptions` from `vitest-pool-defaults.mjs`; stale-string grep on emitted artifacts returns none (excluding the tsconfig `dist/out-tsc` convention shared by the reference package). |
| AC-2 (in-tree dist; `assets` gate works) | PASS | Real scaffold `project.json` `build.outputPath` = `packages/apigen/apigen-plugin-ir-cache/dist`, `vite.config.ts` `root: __dirname` + `outDir: 'dist'`; `npx nx run apigen-plugin-ir-cache:assets` → exit 0. |
| AC-3 (runnable `test` target) | PASS | Real scaffold `project.json` has `test` (`@nx/vite:test`, configFile → vite.config.ts); `npx nx test apigen-plugin-ir-cache` → exit 0. |
| AC-4 (FEATURE repro, zero manual repair, all 5 gates) | PASS | `npx nx g @adhd/workspace-codegen-nx:plugin --name ir-cache --group apigen --nxLayer logic --platform node` then build=0, test=0, lint=0, assets=0, verify-dist-load=0. Scaffold removed after; tree restored. |
| AC-5 (regression teeth) | PASS | **Negative control executed:** reintroduced the stale import in `templates.ts:40` → `npx vitest run` plugin spec → **1 failed / 4 tests** (the `not.toContain('tools/vite-external-deps.mjs')` assertion caught it). Restored → 13/13 green. Base spec's stale-path assertion (formerly `base/generator.spec.ts:44`) updated in the same change set. |
| AC-6 (entrypoint in-tree dist) | PASS | `entrypoint/generator.spec.ts` (2 tests) asserts tsconfig `outDir: 'dist'` + build `outputs: [{projectRoot}/dist]`; `scaffoldEntrypoint` no longer emits `../../dist/entrypoint`. |
| AC-7 (sharedGlobals covers `vitest-pool-defaults.mjs`) | PASS | `nx.json:29` adds `{workspaceRoot}/tools/vite-plugins/vitest-pool-defaults.mjs` to `sharedGlobals`. |
| AC-8 (no stale-path guidance in generator package) | PASS (adjudicated) | grep hits are (a) gitignored dist build output, (b) source comments documenting the historical bug, (c) negative-control assertions that must name the stale string. No emitted-template reference survives. |

## Spec-compliance (SPEC.md segments A–D)

- **Segment A** `templates.ts` — created: `canonicalViteConfig` + `canonicalTargets` match the spec interface block verbatim (imports, in-tree outDir/root, externalize wiring, poolOptions, `formats: ['es','cjs']`; browser variant keeps `external: []`, no pool override).
- **Segment B** `generator.ts` — `patchViteConfig` replaced by canonical write (regex body deleted); `patchReleasePublish` merges `canonicalTargets` + lint fallback; `scaffoldEntrypoint` outDir `'dist'` + `outputs`; `ensurePlaceholderSpec` added (directory-aware — skips when libraryGenerator already emitted a spec, verified against the real scaffold).
- **Segment C** specs — base spec stale-path assertion corrected; plugin spec (4 tests) + entrypoint spec (2 tests) added; plugin spec includes a syntax-teeth test (no `,,`/`;;`/`[],]`, balanced braces, proper `});` close) that caught the implementer's own `},,` double-comma template defect during development.
- **Segment D** `nx.json` — `vitest-pool-defaults.mjs` added to `sharedGlobals`; single-line change.

## Findings outside the diff (logged to TODO.md, not blocking)

- **WSGEN-ADJ-002 (4th stale artifact, fixed in-pass):** `libraryGenerator` also emits `release.version.generatorOptions.packageRoot: "dist/{projectRoot}"`; `patchReleasePublish` rewrites it to `{projectRoot}` (verified in real scaffold + asserted in plugin spec).
- **WSGEN-ADJ-003 (deferred):** vitest `cache.dir` deprecation — repo-convention-wide; coordinated `cacheDir` migration is a FOLLOWUPS candidate.

## Tooling honesty

`memory_*` MCP, `gitnexus_*` MCP (including `gitnexus_impact`), and `task` (researcher) tools were **not present** in this session's toolset. Memory was not queried and GitNexus impact analysis was not run — the persona's fallback (targeted grep/glob/read) was used throughout, and `gitnexus_impact_checked` is `false` in the report above rather than fabricated. No external vulnerability-class question applied (zero new dependencies; internal generator template), so researcher dispatch was moot.
