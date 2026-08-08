/**
 * tools/guards-manifest.mjs — BL-466: single source of truth for the `tools/test-bl*.mjs`
 * regression guards. Read by tools/run-guards.mjs. Do not hand-edit the counts anywhere else
 * (BL-466-a requires this file to be exhaustive against `fs.readdirSync('tools')`).
 *
 * tier 1 — hermetic: scratch dirs (fs.mkdtempSync) or pure in-process imports, no prebuilt
 *          dist/ dependency, no real esbuild build. Safe to run in the invoking checkout.
 * tier 2 — needs a prebuilt dist/ (or invokes a real esbuild build via tools/bundle-extension.cjs).
 *          Must be isolated to a throwaway worktree for local/manual runs (BL-235) except where
 *          `isolable: false` (bl231 — see below).
 *
 * `watch` — repo-relative paths (or path prefixes) that, when part of the staged/changed diff,
 * cause the guard to run under the default filtered `--tier1` mode. A guard's OWN script path is
 * always implicitly part of its own watch set (a guard editing itself always runs) — this is
 * enforced by tools/run-guards.mjs, not encoded here.
 *
 * `needsBuild` — nx project names that must be built (via `nx build <name>`) before the guard can
 * run for real. tools/run-guards.mjs builds these itself; see SPEC-BL-466.md Decision 5.
 *
 * `isolable` — defaults to true. `false` means the guard is structurally unable to run against a
 * worktree-local root (its own path resolution always walks back to the main checkout — see
 * bl231's `git rev-parse --git-common-dir` in test-bl231-cjs-boundary.mjs:49-53) and must always be
 * run in place, never routed through `--isolate-worktree`.
 *
 * `driverArgs` — true means tools/run-guards.mjs must supply extra CLI flags beyond the bare
 * script invocation (bl266 — see SPEC-BL-466.md Decision 6 / tools/run-guards.mjs `buildBl266Args`).
 */

export const GUARDS = [
  // ---------------------------------------------------------------- Tier 1 (13) -----------
  {
    id: 'bl222',
    tier: 1,
    script: 'test-bl222-verify-native-abi.mjs',
    watch: ['tools/verify-native-abi.mjs', 'package.json'],
  },
  {
    id: 'bl407',
    tier: 1,
    script: 'test-bl407-preflight-scoping.mjs',
    watch: ['tools/verify-exports-publint-attw.mjs'],
  },
  {
    id: 'bl409',
    tier: 1,
    script: 'test-bl409-pathspec-commit.mjs',
    // Pins a documented git procedure (pathspec-limited commits), not a specific tool script.
    watch: ['CLAUDE.md'],
  },
  {
    id: 'bl435',
    tier: 1,
    script: 'test-bl435-unguarded-prose.mjs',
    watch: ['tools/plan-status.mjs'],
  },
  {
    id: 'bl446',
    tier: 1,
    script: 'test-bl446-arg-validation.mjs',
    watch: [
      'tools/allocate-bl-id.mjs',
      'tools/check-backlog-markers.mjs',
      'tools/check-bl-id-integrity.mjs',
    ],
  },
  {
    id: 'bl456',
    tier: 1,
    script: 'test-bl456-suite-tree-state.mjs',
    watch: ['tools/check-suite-tree-state.mjs'],
  },
  {
    id: 'bl457',
    tier: 1,
    script: 'test-bl457-amend-shared-index.mjs',
    watch: ['tools/check-amend-shared-index.mjs', 'tools/commit-mine.mjs'],
  },
  {
    id: 'bl463',
    tier: 1,
    script: 'test-bl463-unstage-orphans.mjs',
    watch: ['tools/commit-mine.mjs', 'tools/unstage-orphans.mjs'],
  },
  {
    id: 'bl464',
    tier: 1,
    script: 'test-bl464-duplicate-status-stamp.mjs',
    watch: ['tools/plan-status.mjs'],
  },
  {
    id: 'bl465',
    tier: 1,
    script: 'test-bl465-commit-mine-index-resync.mjs',
    watch: ['tools/commit-mine.mjs'],
  },
  {
    id: 'bl469',
    tier: 1,
    script: 'test-bl469-skip-not-pass.mjs',
    watch: ['tools/test-bl266-bundle-invariants.mjs'],
  },
  {
    id: 'bl466',
    tier: 1,
    script: 'test-bl466-runner-tristate.mjs',
    watch: ['tools/run-guards.mjs', 'tools/guards-manifest.mjs'],
  },

  // ---------------------------------------------------------------- Tier 2 (4) ------------
  {
    id: 'bl214',
    tier: 2,
    script: 'test-bl214-bundle-extension-tsconfig.mjs',
    needsBuild: ['tokenguard-core'],
  },
  {
    id: 'bl231',
    tier: 2,
    isolable: false,
    script: 'test-bl231-cjs-boundary.mjs',
    // Read-only; REPO_ROOT is always the main checkout via `git rev-parse --git-common-dir`
    // (test-bl231-cjs-boundary.mjs:49-53) — never route through --isolate-worktree.
    needsBuild: ['memory-core', 'ingest'],
  },
  {
    id: 'bl266',
    tier: 2,
    script: 'test-bl266-bundle-invariants.mjs',
    needsBuild: ['memory-server'],
    driverArgs: true,
  },
  {
    id: 'bl313',
    tier: 2,
    script: 'test-bl313-graph-store-migrations-asset.mjs',
    needsBuild: ['memory-server'],
  },
];

export const TIER1_COUNT = GUARDS.filter((g) => g.tier === 1).length;
export const TIER2_COUNT = GUARDS.filter((g) => g.tier === 2).length;
