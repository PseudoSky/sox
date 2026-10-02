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

import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 3b752549 / ef033f92: the 7ff58364 guard (below) needs to re-run whenever ANY project's
// `project.json` changes, not just the three projects it happened to be written against — a new
// project growing a `typecheck-tests` target with no matching `typecheck-src`/noop `typecheck`
// would otherwise ship unwatched. `run-guards.mjs`'s watch matcher only understands an exact path
// or a directory prefix (a trailing-slash entry), not a glob (see `matchesDiff` in
// tools/run-guards.mjs), so the watch list is still an enumerated path list — but built from
// `git ls-files` against the real tracked tree instead of a hand-rolled `fs.readdirSync` walk
// with its own maintained `EXCLUDE_DIRS` set. That walker duplicated the one already living in
// tools/test-7ff58364-gate-reaches-typecheck-tests.mjs's `discoverProjectsViaFilesystem` and could
// silently drift from it; `git ls-files` is the tracked-file truth and its result is identical on
// every machine/checkout — no dependence on what happens to exist in a given working tree's
// `node_modules`/`dist`/`.worktrees`.
//
// BL-20d01a62: the claim this comment used to make here — that `project.json`-shaped fixture
// files under `docs/research/**/transcripts/**` are "never tracked, so they need no exclude
// list at all" — is FALSE. At least
// `docs/research/content-first/proxy/transcripts/file-writes/cf_pre/packages/apigen/apigen-plugin-batch/project.json`
// IS tracked (`git ls-files` returns it) and is NOT valid JSON (it is a line-numbered transcript
// capture — every line starts with `N:\t`, which fails `JSON.parse` at line 1). It ends up in
// `ALL_PROJECT_JSON_PATHS` below like any other tracked `project.json` path — that is fine and
// intentional, because nothing in this file (or in `tools/run-guards.mjs`'s exact-path/prefix
// `matchesDiff`) ever parses the watch list as JSON; it is used purely as a set of diff-changed
// paths to match against. The exclusion of `transcripts` that DOES matter lives in
// `tools/test-7ff58364-gate-reaches-typecheck-tests.mjs`'s `discoverProjectsViaFilesystem`
// (its own `EXCLUDE_DIRS`, used only on the `--code-root` red-demo fallback path, where the
// walker DOES `JSON.parse` every `project.json` it finds and would otherwise crash on this file).
//
// Also widened (per BL-ef033f92) to `package.json` and `tsconfig*.json`: A7 (added to the 7ff58364
// guard) reads the tsconfig file named by a project's `typecheck-src` command, so a change to
// e.g. `tsconfig.typecheck.json`'s `exclude` list — with no accompanying `project.json` edit —
// must also re-arm this guard.
//
// BL-20d01a62: the bare `**/project.json` pathspec (no `:(glob)` magic) is a LITERAL-with-`?`/`*`
// pathspec, not a recursive glob — `**` has no special "any depth including zero" meaning without
// `:(glob)`, so it never matches a top-level file. Verified live (2026-09-28): the plain pattern
// missed the repo's own root `project.json`, `package.json`, `tsconfig.json`, and
// `tsconfig.base.json` entirely — exactly the root config files this guard exists to watch (A6's
// own resolver reads `nx.json.targetDefaults`, and root `tsconfig.base.json` is the thing every
// project's `tsconfig.typecheck*.json` extends). Every pattern below is now `:(glob)`-prefixed so
// `**` recurses through zero or more directories, root included.
function trackedFiles(pattern) {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, 'ls-files', '--', pattern], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)
      .sort();
  } catch (err) {
    // BL-20d01a62: this must fail CLOSED, not open. An earlier version of this catch degraded to
    // an empty watch list on any `git` failure, on the theory that a guard which under-watches
    // still runs on its own script-path change and via `--all`. That reasoning was wrong: the
    // 7ff58364 guard's watch list is built ENTIRELY from trackedFiles() calls (ALL_PROJECT_JSON_
    // PATHS / ALL_PACKAGE_JSON_PATHS / ALL_TSCONFIG_JSON_PATHS below) — degrading to [] there means
    // the guard watches only 'nx.json' and its own script path, so a commit touching
    // project.json/package.json/tsconfig anywhere in the repo is reported "N/A — not in scope" and
    // the commit passes with NO guard coverage at all. A manifest that can't be imported runs no
    // guards and the caller sees that failure directly; a manifest that imports successfully but
    // silently watches nothing is far worse — it reports green while blind. Rethrow with context
    // so run-guards.mjs and the pre-commit hook both exit non-zero instead of passing unguarded.
    throw new Error(`guards-manifest: git ls-files -- ${pattern} failed: ${err.message ?? err}`, { cause: err });
  }
}

// BL-20d01a62 (item 1, item 4 comment correction below): `:(glob)` pathspec magic makes `**` match
// zero or more path segments, so these now correctly include top-level `project.json`,
// `package.json`, `tsconfig.json`, and `tsconfig.base.json` alongside every nested one.
const ALL_PROJECT_JSON_PATHS = trackedFiles(':(glob)**/project.json');
const ALL_PACKAGE_JSON_PATHS = trackedFiles(':(glob)**/package.json');
const ALL_TSCONFIG_JSON_PATHS = trackedFiles(':(glob)**/tsconfig*.json');

export const GUARDS = [
  // ---------------------------------------------------------------- Tier 1 (36) -----------
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
    id: '28f22e8d',
    tier: 1,
    script: 'test-28f22e8d-tree-state-config-dirt.mjs',
    // Pins that check-suite-tree-state.mjs's git-status scope is each dependency's PROJECT ROOT
    // (project.json, tsconfig.json, vitest.config.ts, top-level test files) plus repo root config
    // (nx.json, tsconfig.base.json, pnpm-lock.yaml, package.json, pnpm-workspace.yaml, .npmrc) —
    // not just sourceRoot, which misses all of those — AND that a project root's `git status`
    // pathspec correctly excludes a NESTED non-dependency nx project (item 2) and, when the repo
    // ROOT project itself is a dependency, is scoped to the literal repo root rather than
    // sweeping in every other project via the `.` pathspec (item 3). Most arms use a scratch
    // fixture repo as the negative control (the authentic pre-fix sourceRoot-only scoping —
    // buildReport() absent entirely — for arms 1-4; the authentic pre-fix buildPathspecs()-absent
    // scoping for arms 5-6). Arm 7 is the ancestor self-cancellation arm — it goes RED only
    // against 6b75974c (the nested/root-scoping commit before the ancestor guard in
    // `isAncestorOfPkgRoot` landed), not against earlier history, where `buildPathspecs()` didn't
    // exist yet either. Arm 8 [BL-48d92088] pins `--untracked-files=all` on `porcelainOver()`'s
    // `git status` call, config-independent. The FINAL arm (9) is deliberately NOT hermetic — it
    // spawns the CLI against this real checkout's own live git state and graph, not a scratch
    // fixture, so it can
    // only assert shape (non-empty projectRoots/rootConfigFiles), not exact dirty content; it
    // stays Tier 1 on the same basis bl456's own arm 6 already established for that pattern.
    watch: ['tools/check-suite-tree-state.mjs'],
  },
  {
    id: 'aa65862e',
    tier: 1,
    script: 'test-aa65862e-tree-state-git-env-isolation.mjs',
    // Pins check-suite-tree-state.mjs's gitEnv() helper: porcelainOver() must strip inherited
    // GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE/GIT_COMMON_DIR before every spawned `git status` call,
    // so a value inherited from an enclosing git process (e.g. `.husky/pre-commit`'s in-progress
    // commit index) can never redirect the report away from the scratch/real repo it was asked to
    // scope to. The negative control is not a pinned git revision — it is a raw, un-stripped
    // `git status` call made in the same test process, so the guard never depends on old history
    // staying reachable.
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
  {
    id: 'fc2735f0',
    tier: 1,
    script: 'test-fc2735f0-precommit-lint-scope.mjs',
    watch: ['.husky/pre-commit', 'tools/precommit-lint.mjs', 'tools/lib/git-index-scope.mjs'],
  },
  {
    id: 'f1dc4926-fbdfe55e',
    tier: 1,
    script: 'test-run-guards-hook-index-fail-closed.mjs',
    watch: ['tools/run-guards.mjs', 'tools/lib/git-index-scope.mjs'],
  },
  {
    id: '19434c31',
    tier: 1,
    script: 'test-19434c31-dispatcher-review-floor.mjs',
    // Pins a property of the dispatcher agent prose (the merge-first delivery loop: merge on the
    // change's own gates, review from `main` after the merge, HIGH bucketed as follow-up), not a
    // tool script — the superseded pre-merge severity-floor shape must stay absent, and the pre-fix
    // shape (v1.4.0, commit 9ab825e3) is the negative control.
    watch: ['extensions/agents/dispatcher/dispatcher.md'],
  },
  {
    id: 'd5c01be3',
    tier: 1,
    script: 'test-d5c01be3-isolation-attribution.mjs',
    // Pins the smoke harness's BL-173 live data-root isolation guard: a concurrent OPERATOR soxe
    // write attributed by cli_invoked verb+target is a WARNING; every leak shape stays FATAL. The
    // authentic pre-fix any-hash-mismatch-is-FATAL rule is the embedded negative control.
    watch: ['scripts/lib/isolation-guard.mjs', 'scripts/smoke-test.mjs', 'apps/sox/src/cli-invoked-fields.ts'],
  },
  {
    id: '26121495',
    tier: 1,
    script: 'test-26121495-smoke-embed-host-isolation.mjs',
    // Pins the smoke harness's embedding-host containment: a smoke-owned host with the operator
    // HOME, model cache or a temp-dir socket is a breach; the harness env keeps socket + cache in
    // the run through the product's own resolution; every memory-server leg gets the scratch HOME.
    // e5cf17a0: also the product sources whose behaviour Part B reimplements or depends on — the
    // embed socket dir (embedHostConfig.ts), the model-cache resolution (embedding-provider index.ts)
    // and the `soxe serve` env scrub that drops TMPDIR (env-policy.ts).
    watch: [
      'scripts/lib/embed-host-isolation.mjs', 'scripts/lib/smoke-env.mjs', 'scripts/smoke-test.mjs', 'libs/service-proxy/src/socket-path.ts',
      'libs/data/embed/embedding-provider/src/embedHostConfig.ts', 'libs/data/embed/embedding-provider/src/index.ts', 'libs/host-runtime/src/env-policy.ts',
    ],
  },
  {
    id: '97e7f214',
    tier: 1,
    script: 'test-97e7f214-smoke-embed-host-teardown.mjs',
    // Pins the smoke serve legs' teardown: the detached embedding host (ADR-0022) is verified-stopped
    // after the soxe group kill, a survivor fails the leg, and an untagged host is never signalled.
    watch: ['scripts/lib/embed-host-isolation.mjs', 'scripts/smoke-test.mjs'],
  },
  {
    id: 'df0ea359',
    tier: 1,
    script: 'test-df0ea359-spec-embed-isolation.mjs',
    // Pins memory-server's bl404/bl401 real-entrypoint specs to never spawn a real
    // embedding host sharing the operator's HOME, model cache, or embed socket dir
    // (observed live: pids 21798/21856/22069 with HOME=/Users/nix), and to verified-stop
    // the whole spawned process tree (the tsx wrapper's grandchild server was orphaned by a
    // wrapper-only SIGKILL). Structural check on the spec sources plus a dynamic probe of the
    // real helper via `node --import tsx`. `--ref 80261908` (the pre-fix base) is the pinned
    // negative control.
    watch: [
      'extensions/bundles/sox-memory-bundle/members/memory-server/src/bl404-telemetry-composition-root.spec.ts',
      'extensions/bundles/sox-memory-bundle/members/memory-server/src/bl401-stages-declared-live.spec.ts',
      'extensions/bundles/sox-memory-bundle/members/memory-server/src/test-support/bl-df0ea359-embed-host-isolation.ts',
    ],
  },
  {
    id: '1647035b',
    tier: 1,
    script: 'test-1647035b-smoke-embed-evidence-per-leg.mjs',
    // Pins that each embedding leg's requireObserved is satisfied by its OWN host: the service leg's
    // host is verified-stopped after `service disable`, serve legs start with no smoke host alive.
    watch: ['scripts/lib/embed-host-isolation.mjs', 'scripts/smoke-test.mjs'],
  },
  {
    id: 'e5cf17a0',
    tier: 1,
    script: 'test-e5cf17a0-smoke-teardown-hardening.mjs',
    // Pins the smoke teardown hardening: ordered + identity-checked verified stops, per-spawner and
    // reparented-child attribution, signal sweep, space-safe ps parsing, alias-collision retry.
    watch: ['scripts/lib/embed-host-isolation.mjs', 'scripts/lib/smoke-fs.mjs', 'scripts/lib/smoke-teardown.mjs', 'scripts/smoke-test.mjs', 'tools/guards-manifest.mjs'],
  },
  {
    id: 'bd91334d',
    tier: 1,
    script: 'test-bd91334d-embed-scratch-teardown-fault.mjs',
    // Pins memory-server's vitest.global-embed-scratch.ts teardown: a thrown exception mid-audit,
    // or any recorded problem with no throw, must fail the run (process.exitCode = 1) and keep the
    // scratch root — never a bare try/finally that lets vitest 4.1.8 swallow the throw and exit 0.
    watch: [
      'extensions/bundles/sox-memory-bundle/members/memory-server/vitest.global-embed-scratch.ts',
      'extensions/bundles/sox-memory-bundle/members/memory-server/src/test-support/bl-26291f21-embed-scratch-env.ts',
    ],
  },
  {
    id: '8c3f8f87',
    tier: 1,
    script: 'test-8c3f8f87-smoke-log-reflects-exit.mjs',
    // Pins that log.json is written after every post-run assertion and that exit 2 implies
    // summary.failed > 0 (behavioural over every failure combination).
    watch: ['scripts/lib/embed-host-isolation.mjs', 'scripts/lib/smoke-teardown.mjs', 'scripts/smoke-test.mjs'],
  },
  {
    id: '9303b749',
    tier: 1,
    script: 'test-9303b749-embed-isolation-prefix-control.mjs',
    // Pins that test-26121495's Part A pre-fix control is the real 49768a63 evaluateIsolation loaded
    // from git, not a stub. (49768a63 = parent of 683e34b1, the embed-host isolation commit; the
    // earlier pin 0bb5b497 was absent from this clone's object store and crashed this guard.)
    watch: ['tools/test-26121495-smoke-embed-host-isolation.mjs', 'scripts/lib/embed-host-isolation.mjs'],
  },
  {
    id: '3ebd7ecb',
    tier: 1,
    script: 'test-3ebd7ecb-smoke-model-cache-seed.mjs',
    // Pins the smoke model-cache seed: copy-on-write clone from the operator cache (read-only source,
    // never hardlinks), download fallback, and the per-step snapshot excluding the cache and TMPDIR.
    watch: ['scripts/lib/smoke-fs.mjs', 'scripts/smoke-test.mjs'],
  },
  {
    id: '4fc3704e',
    tier: 1,
    script: 'test-4fc3704e-resolve-terminal-evidence.mjs',
    // Pins the dispatcher's artifact-class terminal-resolution rule (rule 18) and backlog-operator's
    // `resolve` evidence precondition — prose invariants, with the authentic pre-fix Step 5/7 text
    // and pre-fix resolve verb embedded as the negative controls.
    watch: ['extensions/agents/dispatcher/dispatcher.md', 'extensions/agents/backlog-operator/backlog-operator.md'],
  },
  {
    id: 'decda240',
    tier: 1,
    script: 'test-decda240-run-definition-of-done.mjs',
    // Pins the dispatcher's run/project definition of done (rule 19) + its Step 8 wiring.
    watch: ['extensions/agents/dispatcher/dispatcher.md'],
  },
  {
    id: 'e5a790a7',
    tier: 1,
    script: 'test-e5a790a7-acceptance-criteria-coverage.mjs',
    // Pins rule 20 (acceptance criteria or a `none applicable` declaration) and its wiring in the
    // dispatcher's Step 2/3/5/8 plus backlog-operator's resolve precondition.
    watch: ['extensions/agents/dispatcher/dispatcher.md', 'extensions/agents/backlog-operator/backlog-operator.md'],
  },
  {
    id: '3ec44b8c',
    tier: 1,
    script: 'test-3ec44b8c-product-priority-ownership.mjs',
    // Pins product's BLOCKING priority duty + re-ranking path (ownership duty 6).
    watch: ['extensions/agents/product/product.md'],
  },
  {
    id: 'c1b17653',
    tier: 1,
    script: 'test-c1b17653-researcher-single-definition.mjs',
    // Pins the researcher extension's single-definition install shape (one prose-only `agent.md` +
    // the host-agnostic IR in `extension.json`; header rendered per host at install time). The
    // authentic pre-fix three-copy shape — `install.source` pointing into the external claude-agents
    // repo while `entrypoint` named the in-repo opencode-headed copy, plus the orphaned
    // `researcher-claude.md` header — is embedded as the negative control (commit 09497f45's parent).
    watch: ['extensions/agents/researcher/'],
  },
  {
    id: '42b0dc25',
    tier: 1,
    script: 'test-42b0dc25-brief-no-executor-knowledge.mjs',
    // Pins agent-manager's brief-independence mandate (a brief carries no knowledge owned by the
    // routed executor) + the read-the-artifact rule + backlog-operator routing. The authentic
    // pre-fix brief text as dispatched (prt_0deddf315001ZebaxYwpdvPxXY) is embedded as the
    // negative control.
    watch: ['extensions/agents/agent-manager/agent-manager.md'],
  },
  {
    id: '70f75751',
    tier: 1,
    script: 'test-70f75751-operator-discovery.mjs',
    // Pins backlog-operator's operator-initiated discovery duties (similar-item discovery on every
    // invocation; sibling cascade-scan on every closure) as required prose invariants — never gated
    // on the caller asking. The authentic pre-fix six-step `When called` protocol (no discovery
    // step) is embedded as the negative control.
    watch: ['extensions/agents/backlog-operator/backlog-operator.md'],
  },
  {
    id: '0abc01ed',
    tier: 1,
    script: 'test-0abc01ed-unconfirmed-sha-refused.mjs',
    // Pins backlog-operator's refusal of a resolution asserting a commit/merge sha not confirmed
    // reachable in `main`. The authentic pre-fix resolve text without the "Confirm every named ref
    // is in `main`" rule is embedded as the negative control.
    watch: ['extensions/agents/backlog-operator/backlog-operator.md'],
  },
  {
    id: 'skill-headers',
    tier: 1,
    script: 'check-skill-frontmatter.mjs',
    // aace3faa: skill extensions had two sources of truth for their header — the
    // manifest description and a hand-written SKILL.md frontmatter — and the
    // hand-written one was what the host surfaced. 1ceffdbf proved the failure class
    // (a `description` with "backlog: product prioritizes" — colon+space in an
    // unquoted scalar — made the frontmatter unparseable and silently dropped the
    // skill). The fix makes extension.json the single source of truth: the header is
    // rendered at install (libs/host-registry/src/skill-renderers.ts, mirroring
    // agent-renderers.ts) and SKILL.md is prose-only. This guard keeps three legs
    // fail-closed: source-purity (no hand-written `---` fence — rejects the authentic
    // pre-fix bytes), manifest (id == dirname, description ≤1024, no `render` block,
    // non-empty body), and rendered-artifact (the off-the-shelf `skillcheck` linter
    // run over the rendered header, proving a colon-in-scalar description still
    // renders to parseable YAML). Agent source .md files are prose-only in this repo
    // (frontmatter rendered at install from extension.json), so the `extensions/agents/`
    // watch arms the guard for the future but finds no skill files today.
    watch: ['extensions/skills/', 'extensions/agents/', 'extensions/bundles/'],
  },
  {
    id: '7ff58364-7dd7a974-062504ba-3b752549-da25489b',
    tier: 1,
    script: 'test-7ff58364-gate-reaches-typecheck-tests.mjs',
    // Pins 7ff58364/7dd7a974 (062504ba's resolution waits on this guard): every project's
    // `typecheck` target must effectively depend on `^build`, and on `typecheck-tests` wherever
    // that target exists, so a whole-repo `nx run-many -t typecheck` sweep never reports green
    // while typecheck-tests silently never ran (config-merge + real task-graph proof).
    //
    // da25489b layered the gate further: `typecheck` (nx:noop) -> `typecheck-tests` ->
    // `typecheck-src`, so production-only breakage is triage-distinguishable from spec breakage.
    // BL-20d01a62: this used to claim "both are always reached by a whole-repo sweep" — false, and
    // contradicted by docs/reporting/memory/handoff/typecheck-tests.md's own account of the chain:
    // nx SKIPS `typecheck-tests` outright when its `typecheck-src` dependency fails, so only
    // `typecheck-src` is guaranteed to run on every sweep. A failing `typecheck-src` still fails the
    // sweep overall (non-green), but by itself it does not tell you whether specs would also have
    // failed — the spec-inclusive check simply never ran. `typecheck` itself has no command of its
    // own to short-circuit on, so the sweep can never report green while EITHER leaf silently never
    // ran — that "never both-silently-skipped" guarantee is what's reached on every sweep, not "both
    // leaves always run".
    //
    // Watch list (3b752549, widened ef033f92): every tracked project.json/package.json/
    // tsconfig*.json in the repo, not just the three projects this guard was originally written
    // against — any project that grows a typecheck-tests target without a matching
    // typecheck-src/noop typecheck needs this guard to re-run, and A7 needs it to re-run on a
    // bare tsconfig edit too. Built from `git ls-files`, see the trackedFiles() helper above.
    // Also watches its own manifest's watch-list machinery (BL-20d01a62 item 2):
    // tools/guards-manifest.mjs — a change to trackedFiles()/the glob patterns above changes what
    // this guard actually watches, so the guard must re-run on its own edit too.
    watch: [
      'nx.json',
      'tools/guards-manifest.mjs',
      ...ALL_PROJECT_JSON_PATHS,
      ...ALL_PACKAGE_JSON_PATHS,
      ...ALL_TSCONFIG_JSON_PATHS,
    ],
  },
  {
    id: 'capability-refs',
    tier: 1,
    script: 'check-agent-capability-refs.mjs',
    watch: ['extensions/agents/', 'AGENTS.md'],
  },

  // ---------------------------------------------------------------- Tier 2 (5) ------------
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
  {
    id: 'fc2735f0-graph',
    tier: 2,
    script: 'test-fc2735f0-precommit-lint-graph.mjs',
    // Read-only nx graph queries only — no dist/ dependency, but kept in Tier 2 per the item
    // spec (§4) alongside the other real-graph (not hermetic) guards.
    needsBuild: [],
  },
];

export const TIER1_COUNT = GUARDS.filter((g) => g.tier === 1).length;
export const TIER2_COUNT = GUARDS.filter((g) => g.tier === 2).length;
