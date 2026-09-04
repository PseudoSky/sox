# Research trace — 2026-08-05 — Sequenced Nx 18->19/20 then pnpm 8/9->10 upgrade

## Metrics

| Metric | Baseline | Result | Delta | Target | Status |
|---|---|---|---|---|---|
| Search terms executed | 0 | 20 | 20 | >=9 | PASS |
| Phases completed (1-6) | 0 | 6 | 6 | 6 | PASS |
| Tools approved/blocked | 0 | 5 (4 approved, 1 blocked) | 5 | >=3 | PASS |
| Confidence-labeled claims | 0 | 2 | 2 | >=1 | PASS |
| Sources verified per approved tool | 0 | >=2 | — | >=2 | PASS |
| Rate limit / block events | 0 | 1 | 1 | <=2 | PASS |

Promotion gate: PASS. Run is COMPLETE.

## What worked
- Nx release/support-policy page (v20/v21 LTS, v22 Current; Nx 19 unsupported) — decisive for the landing-major recommendation.
- CreateNodes API compatibility KB page — exact per-major plugin API matrix; drove the "land on 20, not 21" recommendation.
- npm registry (dist-tags, engines, scripts) for pnpm/Nx/package scripts — fast, verifiable, exact.
- Nx issue pages via webfetch (github MCP was rate-limited) — #33458/#28991/#22874 gave the lockfile-v9 bug timeline.
- pnpm settings pages (10.x + current) — confirmed camelCase keys incl. Workspace Settings (linkWorkspacePackages, preferWorkspacePackages).

## What failed / surprises
- github_get_issue MCP: API rate limit exceeded (1 event) → substituted webfetch on github.com issue pages. Fine.
- GitHub code-search (`repo:pnpm/pnpm type:code`) returned `empty` for preferWorkspacePackages/linkWorkspacePackages — misleading; unauthenticated GitHub code search returns empty, NOT evidence of absence. Cross-checked against pnpm docs which confirm both keys exist (Workspace Settings section).
- pnpm 10 blog URL guess (pnpm.io/blog/2025/01/08/pnpm-10) 404'd → used docs + Kelen third-party highlights instead.
- pnpm#9274 (pnpm 9 ignores nodeLinker in workspace yaml): could not independently verify issue content; user-provided, behaviorally consistent with pnpm 10 docs. MEDIUM confidence, flagged.
- Nx 19.5 as fix-point for #22874 is inferred from the "Nx v19.5 — Pnpm v9 Support" changelog entry + npm version existence. MEDIUM confidence.

## Corrections to initial assumptions
- Nx 19 is NOT a safe landing target (already unsupported Aug 2026) — expected "19 or 20", corrected to "20 LTS minimum, 19 unsupported".
- pnpm 11 exists (11.20.0) and removes package.json#pnpm config + splits .npmrc — pnpm 10 is the correct stop for this migration; 11 is a future step.
- better-sqlite3 v13 has NO install script (prebuilds) — no onlyBuiltDependencies entry needed; esbuild DOES need one (postinstall).
- allowBuilds map (pnpm 10.26+) deprecates onlyBuiltDependencies — use the map for forward compatibility with pnpm 11.

## Process failure classifications
- Source selection (near-miss, no shipped error): unauthenticated code-search `empty` almost treated as absence; verified against primary docs. Actionable improvement: before concluding a key/symbol doesn't exist from a code-search `empty`, check primary documentation.

## Unresolved / LOW-confidence items
- pnpm#9274 exact content (user-provided) — MEDIUM confidence, flagged in memory episode content.
- Nx 19.5 exact fix-point for #22874 — MEDIUM.
