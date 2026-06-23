> **DEPRECATED 2026-06-11.** Legacy single-file format — does NOT conform to the `plan-state-machine` skill (fails `gap-check.js`: missing dag.json/state.json/README/final-review). Superseded by the conforming plan-state-machine artifact in this directory. Retained only as the content source for the conversion.

# Migration plan: Nx + self-hosting for sox-ecosystem

**Engagement:** `nx-migration`. Decision record: `docs/decisions/0001-nx-and-self-hosting.md` (the
*why/what*). Full strategy: `docs/plans/nx-self-hosting-migration.md` (the *how*). Requirements bar:
`DOD.md`. Current status: `CLAUDE.md`.

This document expands the P0–P10 phase outline from the strategy doc into a full **plan-state-machine**
with deterministic acceptance checks, Green= lines, and standalone executor prompts. Every phase is
resumable: its first action re-runs the prior phase's acceptance check. The `/plan-state-machine` skill
was not available in this session; the format follows the same shape used in
`.workflow/plans/sox-memory/migration.md` and `.workflow/plans/consumer-interface-standard/migration.md`.

**State machine:** `suggested → planned → P0 → P1 → P2 → P3 → P4 → P5 → P6 → P7 → P8 → P9 → P10 → complete`.
Skipping phases is forbidden. Each phase transitions `state: executing` on entry; only P10 transitions
`state: complete`.

**Phases:** 11 (P0–P10).

**Non-negotiable constraints carried into every phase:**

- `$ROOT=/Users/nix/dev/ai/sox-ecosystem`. `pnpm` at
  `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm` (use `pnpm` if on PATH, else that absolute path).
- **Nx is dev-time only.** Never a consumer/runtime dependency. `libs/authoring`'s `scaffold()` is
  nx-free so `sox init` works without nx installed.
- **Carry the session's fixes forward** — everything currently uncommitted (recall alias, `fireIsolated`,
  enable-reactivation, stop-via-supervisor, registry drift gate, typecheck) must be present in all work
  after P0. Never re-grab pre-fix code from git.
- Acceptance checks capture `$?` directly — **never pipe** a command whose exit code is being tested.
- **Ordering is mandatory:** `libs/manifest` before `libs/authoring`; engine libs before wiring `sox`;
  generate shells → port logic → wire/verify last.
- Scope of this migration (D5): make **A1, A12, B1–B4, C7 pass; regress nothing green**. C6 and memory
  semantic depth stay out.

---

## Phase 0 — Checkpoint: commit the session's fixes and create the migration branch

**Phase ID:** P0
**Phase goal:** the current working tree (with all this session's unfixed commits — recall alias,
`fireIsolated`, enable-reactivation, stop-via-supervisor, registry drift gate, typecheck) is committed
and tagged as a clean baseline, and a dedicated migration branch is created from it. All subsequent
phases work on this branch. No code changes beyond committing what already exists.
**Inputs:** current uncommitted state (all session fixes); `CLAUDE.md` (status inventory of what is
green); `docs/decisions/0001-nx-and-self-hosting.md` §Consequences step 0.
**Outputs:** a git commit containing every modified file from this session; a `pre-nx-baseline` tag on
that commit; a `feat/nx-migration` branch checked out and tracking the tag.
**Verification:** acceptance check exits 0.

**Acceptance check (deterministic)**

```bash
cd "$ROOT"
# working tree must be clean (no uncommitted changes):
git diff --quiet; rc=$?; [ $rc -eq 0 ] || exit 1
git diff --cached --quiet; rc=$?; [ $rc -eq 0 ] || exit 1
# the baseline tag must exist:
git rev-parse --verify pre-nx-baseline >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# we are on the migration branch:
branch=$(git rev-parse --abbrev-ref HEAD)
[ "$branch" = "feat/nx-migration" ]; rc=$?; [ $rc -eq 0 ] || exit 1
# the current suite must be green (nothing regressed by the commit):
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```

**Green =** a clean, tagged, branched baseline from which every subsequent phase works. No code changes.
The session's fixes are preserved in git history and cannot be accidentally lost or overwritten by later
phase work.

**Phase prompt:**

> You are a release engineer performing a safe-checkpoint step on the `sox-ecosystem` monorepo at
> `$ROOT=/Users/nix/dev/ai/sox-ecosystem`. `pnpm` is on PATH or at
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`.
>
> **CRITICAL CONTEXT:** All work from the current session is uncommitted. The session fixed: the
> `memory_recall` alias bug, `fireIsolated` on the event bus, enable-reactivation flow,
> stop-via-supervisor, the registry drift gate, and a typecheck failure. These fixes must survive in git
> before any migration work touches anything. The strategy document (`docs/plans/nx-self-hosting-
> migration.md`) §6 P0 requires: "Commit/tag the current (fixed) state — everything this session is
> uncommitted."
>
> Your task: (1) Run `git status` and `git diff --stat` to verify exactly which files are modified.
> (2) Stage ALL modified/new files: `git add -A`. (3) Commit with message
> `chore: checkpoint session fixes before nx migration (recall alias, fireIsolated, enable-reactivation, stop-via-supervisor, registry drift gate, typecheck)`.
> (4) Create and push (locally) tag: `git tag pre-nx-baseline`. (5) Create and switch to branch:
> `git checkout -b feat/nx-migration`. (6) Run `pnpm test` and confirm the suite is green — if it
> red-bars, FIX the failures (do not leave broken tests in the baseline commit; amend if needed before
> creating the tag). Do not implement any migration changes; this phase is commit+tag+branch only.
>
> Skills/tools you need: git, pnpm.
> Files to read first: `CLAUDE.md` (status inventory), `git status` output (see above step 1).
> Success criteria: the Phase 0 acceptance check above exits 0.
> Hard constraints: do NOT begin any Nx setup or code changes. Do NOT skip the tag — later phases'
> resumability depends on it. If the test suite is red, fix the specific failures (read the test output,
> repair the breakage) before committing. Never pipe a command whose exit code you are checking.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/nx-migration/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P0 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

---

## Phase 1 — nx init + configure (cache, boundaries, release, named inputs)

**Phase ID:** P1
**Phase goal:** Nx is initialized in the monorepo with `nx.json`, `tsconfig.base.json` (path aliases
wired), project target defaults (`@nx/js:tsc`), named inputs (production/test), module-boundary lint
(`type:extension`, `type:lib`, `type:app`), cache configuration, and `nx release` with commitlint.
The existing pnpm workspaces continue to work; the existing test suite stays green.
**Inputs:** P0 (green baseline branch); `docs/decisions/0001-nx-and-self-hosting.md` §Architecture
(layout mapping, tag scheme, target layout); `docs/plans/nx-self-hosting-migration.md` §6 P1–P2.
**Outputs:** `nx.json` (project graph, target defaults, cache inputs, release config); updated
`package.json` (nx devDependency, commitlint config, `nx` scripts); `tsconfig.base.json` (base paths
for future libs/apps); `.eslintrc.json` or `eslint.config.js` with `@nx/enforce-module-boundaries`
rule active; `commitlint.config.js`; `pnpm-workspace.yaml` updated to include `apps/**`, `libs/**`,
`packages/**`.
**Verification:** acceptance check exits 0.

**Acceptance check (deterministic)**

```bash
cd "$ROOT"
# P0 guard: clean tree on migration branch:
git diff --quiet; rc=$?; [ $rc -eq 0 ] || exit 1
branch=$(git rev-parse --abbrev-ref HEAD); [ "$branch" = "feat/nx-migration" ]; rc=$?; [ $rc -eq 0 ] || exit 1
# nx is installed and the graph resolves:
pnpm exec nx show projects >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# module-boundary lint is configured (the rule appears in the eslint config):
node -e "const fs=require('fs'),path=require('path');const configs=['eslint.config.js','.eslintrc.json','.eslintrc.js'];const found=configs.find(c=>fs.existsSync(path.join(process.cwd(),c)));if(!found)process.exit(1);const t=fs.readFileSync(found,'utf8');process.exit(t.includes('enforce-module-boundaries')?0:1)"; rc=$?; [ $rc -eq 0 ] || exit 1
# nx release is configured (nx.json has a release key):
node -e "const nx=require('./nx.json');process.exit(nx.release?0:1)"; rc=$?; [ $rc -eq 0 ] || exit 1
# pnpm workspace includes libs/** and apps/**:
node -e "const fs=require('fs');const y=fs.readFileSync('pnpm-workspace.yaml','utf8');process.exit((y.includes('libs/**')&&y.includes('apps/**'))?0:1)"; rc=$?; [ $rc -eq 0 ] || exit 1
# existing test suite still green:
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```

**Green =** Nx is alive in the repo, the module-boundary lint rule is wired, `nx release` is configured,
and the workspace can host libs/apps — while every existing test still passes.

**Phase prompt:**

> You are a monorepo infrastructure engineer onboarding to `sox-ecosystem` at
> `$ROOT=/Users/nix/dev/ai/sox-ecosystem` (`pnpm` on PATH or at
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). You are on branch `feat/nx-migration`.
> The session's fixes are committed and tagged as `pre-nx-baseline`. This is Phase 1 of an Nx migration.
>
> Context you need cold: the repo is a pnpm monorepo today with `extensions/` packages and `scripts/`
> engine. The migration target layout (from `docs/decisions/0001-nx-and-self-hosting.md` §Layout
> mapping) adds `apps/sox/` (extension #0), `libs/{manifest,install-engine,registry,host-runtime,
> authoring,memory-core}/`, and `packages/sox-nx/` (`@adhd/sox-nx` plugin). Tags: `type:extension`,
> `type:lib`, `type:app`. The boundary rule: extensions may depend on libs, never on each other
> (cross-extension `../../../dist` reach-in must become a lint error). Nx is **dev-time only** — never a
> consumer/runtime dep. Releases switch from Changesets to `nx release` + conventional commits
> (commitlint). The existing `extensions/` packages and `scripts/*.ts` are NOT moved in this phase.
>
> Your task: (1) Install nx: `pnpm add -D nx @nx/js @nx/eslint @nx/plugin` (exact versions compatible
> with the Node version in `.nvmrc` or the current `node -v`). (2) Create `nx.json` with: project graph
> config, target defaults for `build` (`@nx/js:tsc`) and `test` (`@nx/jest` or existing vitest shim),
> named inputs (`production` excludes tests; `default` includes all), cache settings, and a `release`
> block enabling `nx release` with conventional-commits version strategy. (3) Create `tsconfig.base.json`
> as the root path-alias registry for all future libs/apps (empty paths for now; they populate in P3+).
> (4) Add/extend ESLint config with `@nx/enforce-module-boundaries` rule: `type:extension` projects may
> depend on `type:lib`; never on each other; `type:app` may depend on `type:lib`. (5) Add
> `commitlint.config.js` with conventional-commits preset. (6) Update `pnpm-workspace.yaml` to include
> `apps/**`, `libs/**`, `packages/**` in addition to existing globs. (7) Run `pnpm exec nx show projects`
> and confirm it resolves without error; run `pnpm test` and confirm existing suite stays green.
>
> Skills/tools you need: Nx, pnpm, TypeScript project references, ESLint, commitlint.
> Files to read first: `pnpm-workspace.yaml`, root `package.json`, `tsconfig.json` (if any),
> `docs/decisions/0001-nx-and-self-hosting.md` §Layout mapping + §Architecture, `nx.json` if it already
> exists.
> Success criteria: the Phase 1 acceptance check exits 0.
> Hard constraints: Nx is a devDependency only — do NOT add it to any extension's `dependencies`. Do NOT
> move or restructure existing `extensions/` or `scripts/` packages in this phase (that happens in P3+).
> Do NOT delete or disable any existing tests. Capture `$?` directly; never pipe a tested exit.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/nx-migration/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P1 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

---

## Phase 2 — `libs/manifest`: schema + validate with contract flexes

**Phase ID:** P2
**Phase goal:** `libs/manifest` is generated as an nx library containing the manifest JSON schema
(including the three contract flexes: `entrypoint` optional/typed; `runtime ∈ {node,shell,python,
declarative}`; `install-target` field for host-discovery placement) and a `validate(manifest)` function.
The existing `scripts/validate-manifests.ts` behavior is fully replicated; `libs/manifest` becomes the
single source of truth for "conformant" across the entire repo.
**Inputs:** P1 (green); `schemas/extension/v1.json` (current schema); `scripts/validate-manifests.ts`
(current validator); `docs/decisions/0001-nx-and-self-hosting.md` §Contract adjustments.
**Outputs:** `libs/manifest/src/index.ts` (exports `validate`, `ManifestSchema`, typed `Manifest`
interface); updated `schemas/extension/v1.json` (or a new `schemas/extension/v2.json`) reflecting the
three flexes; an nx `validate` target on `libs/manifest`; tests in `libs/manifest/src/manifest.spec.ts`
covering all existing validator test cases plus the new flex fields; `libs/manifest` tagged `type:lib`.
**Verification:** acceptance check exits 0.

**Acceptance check (deterministic)**

```bash
cd "$ROOT"
# P1 guard: nx resolves:
pnpm exec nx show projects >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# libs/manifest exists as an nx project:
pnpm exec nx show project manifest >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# libs/manifest builds clean:
pnpm exec nx run manifest:build >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# libs/manifest tests pass (incl. flex field coverage):
pnpm exec nx run manifest:test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# the schema declares entrypoint as optional and runtime accepts 'shell':
node -e "
  const s=require('./libs/manifest/src/index');
  const valid=s.validate({id:'x',version:'0.1.0',type:'hook',title:'X',description:'D',
    compatibility:{sox:'^0'},license:'MIT',runtime:'shell'});
  process.exit(valid.ok?0:1)
"; rc=$?; [ $rc -eq 0 ] || exit 1
# the schema accepts declarative runtime and no entrypoint (bundle/prompt shape):
node -e "
  const s=require('./libs/manifest/src/index');
  const valid=s.validate({id:'y',version:'0.1.0',type:'bundle',title:'Y',description:'D',
    compatibility:{sox:'^0'},license:'MIT',runtime:'declarative'});
  process.exit(valid.ok?0:1)
"; rc=$?; [ $rc -eq 0 ] || exit 1
# install-target field is accepted:
node -e "
  const s=require('./libs/manifest/src/index');
  const valid=s.validate({id:'z',version:'0.1.0',type:'skill',title:'Z',description:'D',
    compatibility:{sox:'^0'},license:'MIT',runtime:'declarative',
    'install-target':'~/.claude/commands/'});
  process.exit(valid.ok?0:1)
"; rc=$?; [ $rc -eq 0 ] || exit 1
# existing full test suite still green:
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```

**Green =** `libs/manifest` is the canonical home for schema + validation logic; the three contract flexes
(entrypoint-optional, multi-runtime, install-target) are encoded and tested; the existing validator
behavior is preserved and re-verified. This is the prerequisite for all "born-conformant" work.

**Phase prompt:**

> You are a schema/contract engineer in the `sox-ecosystem` monorepo at
> `$ROOT=/Users/nix/dev/ai/sox-ecosystem` (`pnpm` on PATH or at
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). You are on branch `feat/nx-migration`; Nx is
> configured (Phase 1). You are building `libs/manifest`.
>
> Context you need cold: the three contract flexes required by the real extension corpus
> (`docs/decisions/0001-nx-and-self-hosting.md` §Contract adjustments):
> (1) **`entrypoint` optional/typed** — a markdown agent's entrypoint is its `.md`; a shell hook's is
> the script file; a bundle/prompt has none. The current "all types compile to `dist/index.js`"
> assumption must be dropped from the schema.
> (2) **`runtime ∈ {node, shell, python, declarative}`** — not node-only.
> (3) **`install-target`** — a declarative extension declares where it installs to (e.g.
> `~/.claude/commands/`, `~/.claude/agents/`, skills dir). This is the generalized reinjection primitive
> for the declarative family (prompt + markdown agents + skills). `sox install` = render/link the
> artifact into the target location.
> The existing `scripts/validate-manifests.ts` has 44 tests that must be re-expressed in
> `libs/manifest/src/manifest.spec.ts` so this lib becomes the single source of truth.
>
> Your task: (1) Generate the lib: `pnpm exec nx g @nx/js:lib manifest --directory=libs/manifest
> --tags="type:lib" --unitTestRunner=vitest` (adjust flags as nx version requires). (2) In
> `libs/manifest/src/index.ts` export: a `validate(manifest: unknown): { ok: boolean; errors: string[] }`
> function; a `Manifest` TypeScript interface covering all types incl. the three flexes; the updated
> JSON schema (in `libs/manifest/src/schema.json` or inline). (3) Encode the three flex adjustments:
> make `entrypoint` optional in the schema (typed by `runtime`); broaden `runtime` to the 4-value enum;
> add optional `install-target` (string, for declarative types). (4) Port all existing validator checks
> from `scripts/validate-manifests.ts` into `libs/manifest/src/manifest.spec.ts` — do NOT delete
> `scripts/validate-manifests.ts` yet (it still runs the existing extensions; migration happens in P5).
> (5) Add tests covering each flex field. Tag the lib `type:lib` in its `project.json`.
>
> Skills/tools you need: Nx generators (`@nx/js:lib`), TypeScript, JSON Schema (draft 2020-12), vitest.
> Files to read first: `schemas/extension/v1.json`, `scripts/validate-manifests.ts` (all 44 test cases),
> `docs/decisions/0001-nx-and-self-hosting.md` §Contract adjustments + §Layout mapping.
> Success criteria: the Phase 2 acceptance check exits 0.
> Hard constraints: do NOT delete `scripts/validate-manifests.ts` (it still guards the existing
> extensions). `libs/manifest` must have NO `@nx/devkit` dependency (it is a pure lib). Entrypoint is
> optional — do NOT require it on all types. Nx is never a runtime dep of `libs/manifest`. Capture `$?`
> directly; never pipe a tested exit.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/nx-migration/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P2 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

---

## Phase 3 — `libs/authoring` + `@adhd/sox-nx` generators + born-conformance gate

**Phase ID:** P3
**Phase goal:** `libs/authoring` provides a pure `scaffold(opts) → FileSet` function (no `@nx/devkit`
import) with templates for all 6 active types (agent, skill, mcp-server, hook, command, bundle — `prompt`
is parked). `@adhd/sox-nx` in `packages/sox-nx/` provides thin `@adhd/sox-nx:extension` and `@adhd/sox-nx:library`
generators that call `scaffold()` and apply the FileSet to the nx Tree. A parity test asserts that
`sox init <type> <id>` and `pnpm exec nx g @adhd/sox-nx:extension <type> <id>` produce byte-identical output
from the same `scaffold()` core. A born-conformance gate scaffolds one extension per type, builds it, and
validates it — all in one command.
**Inputs:** P2 (green — `libs/manifest` with the contract flexes); `docs/decisions/0001-nx-and-self-hosting.md`
§Authoring = lib-core + adapters + §The reflexive boundary; §D4 (delete 6 demos; generators are
input-driven per type).
**Outputs:** `libs/authoring/src/index.ts` (exports `scaffold()`; no `@nx/devkit`); template files
under `libs/authoring/src/templates/<type>/` for 6 types; `packages/sox-nx/src/generators/extension/`
(generator + `schema.json` + `files/<type>/`); `packages/sox-nx/src/generators/library/`; a
born-conformance test (`tools/born-conformance.js` or as an nx target) that for each of the 6 types
runs `scaffold → build → validate` and exits 0; a parity test asserting byte-identical output.
**Verification:** acceptance check exits 0.

**Acceptance check (deterministic)**

```bash
cd "$ROOT"
# P2 guard: libs/manifest tests pass:
pnpm exec nx run manifest:test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# libs/authoring builds clean:
pnpm exec nx run authoring:build >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# @adhd/sox-nx plugin builds clean:
pnpm exec nx run sox-nx:build >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# scaffold each of the 6 active types via the generator and validate each output:
for type in agent skill mcp-server hook command bundle; do
  TMP="$ROOT/.tmp-bc-$type"; rm -rf "$TMP"
  node -e "const {scaffold}=require('./libs/authoring/dist/index');const {writeFileSet}=require('./libs/authoring/dist/writer');writeFileSet(scaffold({type:'$type',id:'probe-$type',title:'Probe $type',description:'use this when probing $type'}),require('path').join('$TMP','probe-$type'))"; rc=$?; [ $rc -ne 0 ] && exit 1
  # generated manifest must validate:
  node -e "const {validate}=require('./libs/manifest/dist/index');const m=require('$TMP/probe-$type/extension.json');const r=validate(m);process.exit(r.ok?0:1)"; rc=$?; [ $rc -ne 0 ] && exit 1
  rm -rf "$TMP"
done
echo "all 6 types scaffold+validate"
# parity test: sox init and nx generator produce identical output (run the parity test target):
pnpm exec nx run sox-nx:test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```

**Green =** every active type scaffolds to a manifest that validates against `libs/manifest`; the parity
invariant holds (`sox init` == `@adhd/sox-nx:extension` same core); the born-conformance gate is a runnable
target. The 6 demo extensions are no longer needed as fixtures — generated output is the fixture.

**Phase prompt:**

> You are a developer-tooling engineer in the `sox-ecosystem` monorepo at
> `$ROOT=/Users/nix/dev/ai/sox-ecosystem` (`pnpm` on PATH or at
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). You are on branch `feat/nx-migration`. Phase 2 is
> green: `libs/manifest` is the schema+validate source of truth with the three contract flexes.
>
> Context you need cold (from `docs/decisions/0001-nx-and-self-hosting.md`):
>
> - **`libs/authoring`** — pure `scaffold(opts) → FileSet` with NO `@nx/devkit` import. This is the
>   single source of truth for "what a conformant extension of type X is." Both `sox init` and the nx
>   generator call it.
> - **`@adhd/sox-nx:extension` generator** — thin adapter: maps the FileSet returned by `scaffold()` onto the
>   nx `Tree`, adds `project.json` with tags + nx target wiring.
> - **Parity invariant** — a test MUST assert that `scaffold()` called directly (via `sox init`) and
>   called via `@adhd/sox-nx:extension` emit byte-identical output for the same inputs. This invariant must
>   never be broken.
> - **`prompt` is parked** — no generator for prompt type until a real use case appears. Generate
>   templates for: `agent`, `skill`, `mcp-server`, `hook`, `command`, `bundle`.
> - **D4: delete the 6 demos** — the demo extensions (`echo-agent`, `hello-world`, `hello-server`,
>   `audit-hook`, `greeting-prompt`, `status-command`) are replaced by the conformance-gate's generated
>   fixtures. Delete them in this phase.
> - Generator inputs per type: `hook` takes `events[]` + `runtime(shell|node)`; `mcp-server` takes
>   `tools[]` with names + descriptions; `command` takes `verb` + `args[]` + `runtime`; `skill` takes
>   `io` description + markdown body stub; `agent` takes `invocation` description + markdown stub;
>   `bundle` takes `members[]` ids.
>
> Your task: (1) Generate `libs/authoring`: `pnpm exec nx g @nx/js:lib authoring --directory=libs/authoring
> --tags="type:lib"`. Implement `scaffold(opts): FileSet` where `FileSet = Record<string, string>` (path
> relative to extension root → file content). Per-type templates live in
> `libs/authoring/src/templates/<type>/`. Templates use `libs/manifest` for the schema shape (import
> `libs/manifest` — allowed: lib-to-lib). Implement a `writeFileSet(fs, outDir)` helper. (2) Generate
> `packages/sox-nx`: `pnpm exec nx g @nx/plugin:plugin sox-nx --directory=packages/sox-nx
> --tags="type:lib"`. Implement `@adhd/sox-nx:extension` generator — imports `scaffold()` from
> `libs/authoring`, maps FileSet to nx Tree, adds `project.json` with `type:<type>` tag. Implement
> `@adhd/sox-nx:library` generator (wraps `@nx/js:lib` with sox-specific defaults + `type:lib` tag).
> (3) Write the parity test in `packages/sox-nx/src/generators/extension/extension.spec.ts`: call
> `scaffold()` directly, call the generator in a dry-run Tree, assert every file content is byte-identical.
> (4) Delete the 6 demo extensions from `extensions/` (they are no longer needed). (5) Write
> `tools/born-conformance.js`: for each of the 6 active types, call `scaffold()`, write to a temp dir,
> call `validate()` from `libs/manifest`, assert ok, clean up. Add it as an nx target `born-conformance`
> on `sox-nx`.
>
> Skills/tools you need: Nx generators (`@nx/js:lib`, `@nx/plugin:plugin`, `@nx/plugin:generator`),
> TypeScript, template strings, vitest, `libs/manifest` API.
> Files to read first: `docs/decisions/0001-nx-and-self-hosting.md` (§Authoring, §The reflexive boundary,
> §D4); `libs/manifest/src/index.ts` (the validate API); `scripts/new-extension.ts` (the existing
> scaffolder to port from — carry its logic forward, fix its known gaps: missing `tsconfig`, missing
> `keywords`/`author`).
> Success criteria: the Phase 3 acceptance check exits 0.
> Hard constraints: `libs/authoring` MUST have zero `@nx/devkit` imports (pure lib; `sox init` must work
> without nx). `prompt` type gets NO generator. The parity test is MANDATORY — if it fails, the two
> paths have drifted (fix it before exiting). Delete the 6 demos — do NOT keep them as reference
> extensions. Capture `$?` directly; never pipe a tested exit.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/nx-migration/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P3 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

---

## Phase 4 — Port engine libs: `libs/install-engine`, `libs/host-runtime`, `libs/registry`

**Phase ID:** P4
**Phase goal:** the engine logic from `scripts/` is re-homed into three nx libs, carrying ALL of the
session's fixes forward and fixing the flag parser (A12: `--flag value` AND `--flag=value` both parse
correctly) and `exec` routing while re-homing the CLI. No logic is re-grabbed from pre-fix git history.
The CLI entrypoint in `apps/sox/` is wired to the three libs (shell only — behavior verified in P5).
**Inputs:** P3 (green); `scripts/{install.ts,cascade.ts,hook-loader.ts,host/*}` (source to port);
`CLAUDE.md` (the session's fix inventory); `DOD.md` A12 (flag parser), A11 (exec routing).
**Outputs:** `libs/install-engine/src/` (install, cascade, build-index, lockfile); `libs/host-runtime/src/`
(loader, supervisor, registrar, event-bus — with `fireIsolated`, enable-reactivation,
stop-via-supervisor fixes); `libs/registry/src/` (drift gate, index, checksum); `apps/sox/src/` stub
CLI (verb dispatch shell, no logic yet — that is P5); each lib tagged `type:lib`; `apps/sox` tagged
`type:app`; all three libs + `apps/sox` build clean with `nx run-many -t build`.
**Verification:** acceptance check exits 0.

**Acceptance check (deterministic)**

```bash
cd "$ROOT"
# P3 guard: born-conformance still passes:
pnpm exec nx run sox-nx:born-conformance >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# all three engine libs + apps/sox build clean:
pnpm exec nx run-many -t build --projects=install-engine,host-runtime,registry,sox >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# libs/host-runtime tests pass (incl. fireIsolated, enable-reactivation, stop-via-supervisor):
pnpm exec nx run host-runtime:test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# libs/install-engine tests pass (incl. drift gate):
pnpm exec nx run install-engine:test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# A12: flag parser handles BOTH forms:
node -e "
  const {parseArgs}=require('./libs/install-engine/dist/index');
  const r1=parseArgs(['--scope','user']); // --flag value form
  const r2=parseArgs(['--scope=user']);   // --flag=value form
  process.exit((r1.scope==='user'&&r2.scope==='user')?0:1)
"; rc=$?; [ $rc -eq 0 ] || exit 1
# module-boundary lint: no cross-extension imports exist:
pnpm exec nx run-many -t lint --projects=install-engine,host-runtime,registry >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```

**Green =** the three engine libs build, test, and lint clean; the flag parser handles both documented
forms (A12); the session's fixes (`fireIsolated`, enable-reactivation, stop-via-supervisor, drift gate)
are provably present in the ported code; module-boundary lint is clean.

**Phase prompt:**

> You are a systems/refactoring engineer in the `sox-ecosystem` monorepo at
> `$ROOT=/Users/nix/dev/ai/sox-ecosystem` (`pnpm` on PATH or at
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). You are on branch `feat/nx-migration`. Phase 3 is
> green: `libs/authoring`, `packages/sox-nx`, and the born-conformance gate all pass.
>
> Context you need cold — **CRITICAL:**
> (1) ALL of this session's fixes are in the P0 baseline commit. You must PORT them forward into the new
> libs — do NOT re-grab code from before the P0 tag. Specifically:
>
> - `fireIsolated` fix: the event bus must fire hooks in isolation so one failure cannot abort others
>      (in `scripts/host/event-bus.ts` or equivalent).
> - Enable-reactivation fix: `enable` on a disabled extension must re-spawn the process.
> - Stop-via-supervisor fix: `stop` must go through the supervisor, not kill the process directly.
> - Registry drift gate: checksums are re-verified before install/update; stale checksums cause a
>      non-zero exit with a clear message.
> - Typecheck fix: whatever typecheck error existed is already fixed — preserve the fixed typing.
> (2) **Fix the flag parser (A12) while re-homing the CLI.** The documented `--help` output shows
> `--flag value` forms; today `--flag value` mis-parses (only `--flag=value` works). The fix must
> live in the CLI argument parser inside the new `libs/install-engine` or `apps/sox` layer.
> (3) **Fix `exec` routing (A11)** to use the running server rather than spawning a throwaway session.
> Port the existing exec path and fix it while doing so.
> (4) The existing `scripts/` files are NOT deleted in this phase — they still run the existing
> `validate-manifests.ts` etc. (those are cleaned up in P9). Port the logic; leave the originals.
>
> Your task: (1) Generate three libs: `pnpm exec nx g @nx/js:lib install-engine`, `host-runtime`,
> `registry` (all `--directory=libs/<name> --tags="type:lib"`). (2) Generate `apps/sox`:
> `pnpm exec nx g @nx/js:app sox --directory=apps/sox --tags="type:app"` (or equivalent — this is the
> CLI app, extension #0, not a web app; configure it to emit a runnable Node CLI). (3) Port
> `scripts/install.ts` + `cascade.ts` + `build-index.ts` into `libs/install-engine/src/`; carry the
> drift-gate fix. (4) Port `scripts/host/*` into `libs/host-runtime/src/`; carry `fireIsolated`,
> enable-reactivation, stop-via-supervisor. (5) Port `scripts/provider-capabilities.ts` + registry
> helpers into `libs/registry/src/`. (6) In `apps/sox/src/main.ts` write a dispatch shell that parses
> argv (with `--flag value` AND `--flag=value` forms both handled — fix A12 here) and routes verbs to
> stub handlers (no real verb logic yet — behavior wired in P5). Fix `exec` routing stub. (7) Write
> `parseArgs` (or use a well-known parser like `yargs`/`minimist`) that correctly handles both flag forms
> and export it from `libs/install-engine`. Port ALL tests from `scripts/*.test.ts` to the appropriate
> lib's test file; add new tests for the A12 fix.
>
> Skills/tools you need: TypeScript, Nx generators, argv parsing, the existing scripts source (read it
> carefully — especially the fixed code in the P0 commit), vitest.
> Files to read first: `scripts/install.ts`, `scripts/cascade.ts`, `scripts/hook-loader.ts`,
> `scripts/host/` directory, `scripts/provider-capabilities.ts`, `scripts/validate-manifests.ts` (for
> the drift-gate check), `CLAUDE.md` (the fix inventory), `DOD.md` A11 + A12.
> Success criteria: the Phase 4 acceptance check exits 0.
> gitnexus (this repo is indexed — 2,977 symbols; use it before relocating code): for each symbol you move, run `gitnexus impact <symbol>` (blast radius — who breaks) and `gitnexus context <symbol>` (callers/callees) to find every importer FIRST; after moving, run `gitnexus detect-changes` to confirm only the intended symbols/flows changed. The gitnexus MCP tools (`gitnexus_impact`, `gitnexus_context`, `gitnexus_detect_changes`, `gitnexus_query`) are available; prefer them over grep for dependency discovery.
> Hard constraints: NEVER re-grab pre-fix code from before the P0 tag. The flag parser MUST handle both
> `--flag value` AND `--flag=value`. Do NOT delete `scripts/` originals in this phase. Do NOT add Nx as
> a runtime dep of any lib. Capture `$?` directly; never pipe a tested exit.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/nx-migration/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P4 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

---

## Phase 5 — Wire `apps/sox` (extension #0): full CLI + conformant manifest

**Phase ID:** P5
**Phase goal:** `apps/sox` is a fully-wired, working `sox` CLI that consumes `libs/install-engine`,
`libs/host-runtime`, `libs/registry`, and `libs/manifest`. It has its own `extension.json` manifest
(`type: command`) validated by `libs/manifest`. It validates as a conformant extension #0 — the
self-hosting invariant (D1). The complete command surface works: A1 (`init` born-conformant), A2–A10,
A11 (`exec` via running server), A12 (both flag forms).
**Inputs:** P4 (green engine libs + flag-parser fix); `docs/decisions/0001-nx-and-self-hosting.md` D1
(self-hosting), D2 (type = `command`); `DOD.md` A1–A12.
**Outputs:** `apps/sox/extension.json` (`type:"command"`, entrypoint points to built CLI, validates
clean); `apps/sox/src/main.ts` with all verb handlers wired to the engine libs; `apps/sox/bin/sox`
(or `package.json` `bin` field); A1 `init` wired to `libs/authoring scaffold()` + disk writer; the
CLI built by `nx run sox:build` and executable as `node dist/apps/sox/main.js`.
**Verification:** acceptance check exits 0.

**Acceptance check (deterministic)**

```bash
cd "$ROOT"
# P4 guard: engine libs tests pass:
pnpm exec nx run-many -t test --projects=install-engine,host-runtime,registry >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# sox CLI builds:
pnpm exec nx run sox:build >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# sox's own manifest validates (self-hosting invariant D1):
node -e "const {validate}=require('./libs/manifest/dist/index');const m=require('./apps/sox/extension.json');const r=validate(m);if(!r.ok)console.error(r.errors);process.exit(r.ok?0:1)"; rc=$?; [ $rc -eq 0 ] || exit 1
# sox type is 'command' (D2):
node -e "const m=require('./apps/sox/extension.json');process.exit(m.type==='command'?0:1)"; rc=$?; [ $rc -eq 0 ] || exit 1
# A12: both flag forms parse correctly via the live CLI:
node dist/apps/sox/main.js validate --help >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# A1: sox init scaffolds a born-conformant extension:
TMP="$ROOT/.tmp-init-a1"; rm -rf "$TMP"; mkdir -p "$TMP"
node dist/apps/sox/main.js init hook smoke-hook --events SessionEnd --runtime shell --out "$TMP" >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
node -e "const {validate}=require('./libs/manifest/dist/index');const m=require('$TMP/smoke-hook/extension.json');const r=validate(m);process.exit(r.ok?0:1)"; rc=$?; [ $rc -eq 0 ] || exit 1
rm -rf "$TMP"
# full test suite green:
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```

**Green =** `sox` is literally self-hosted: it is a conformant `command` extension whose own manifest
validates. The A1 `init` command produces a born-conformant extension. The full command surface works
with both flag forms.

**Phase prompt:**

> You are a CLI engineer in the `sox-ecosystem` monorepo at `$ROOT=/Users/nix/dev/ai/sox-ecosystem`
> (`pnpm` on PATH or at `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). You are on branch
> `feat/nx-migration`. Phase 4 is green: three engine libs build and test clean with the flag-parser fix.
>
> Context you need cold (from `docs/decisions/0001-nx-and-self-hosting.md`):
>
> - **D1 — Literal self-hosting.** `sox` is extension #0: a real conformant extension with its own
>   `extension.json`, validated by its own validator (`libs/manifest`). If `sox` cannot be expressed
>   conformantly, the manifest contract is wrong.
> - **D2 — `sox` type = `command`.** Description: "a CLI program with an entrypoint — the root CLI or a
>   subcommand." No new `host` type.
> - `apps/sox` depends on: `libs/install-engine`, `libs/host-runtime`, `libs/registry`, `libs/manifest`,
>   `libs/authoring`. These are the only internal libs it should import.
> - The `init` command wires `libs/authoring`'s `scaffold()` + a `writeFileSet()` disk writer — this is
>   the path that makes A1 born-conformant. DO NOT port the broken old scaffolder logic; use
>   `libs/authoring` which already has the correct templates from Phase 3.
> - The `exec` verb must route through the running server (A11 fix from P4 must be wired here).
>
> Your task: (1) Create `apps/sox/extension.json` with `type:"command"`, a title and description, the
> proper `entrypoint` pointing to the compiled CLI output, `runtime:"node"`, and a valid
> `compatibility` block — validate it with `libs/manifest` and fix any errors. (2) Wire all verb
> handlers in `apps/sox/src/main.ts`: `init` (calls `scaffold()` + disk writer), `validate`, `search`,
> `install`, `start`, `list`, `details`, `enable`, `disable`, `update`, `uninstall`, `stop`, `exec`
> (via running server — use the `libs/host-runtime` exec channel). Each verb delegates to the
> appropriate engine lib; no logic is forked. (3) Add a `bin` field to `apps/sox/package.json` so
> `node dist/apps/sox/main.js` and `bin/sox` both work. (4) Ensure A12: both `--flag value` and
> `--flag=value` parse correctly (already fixed in P4 parser — just verify it flows through to the
> live CLI). (5) Write an integration test scaffolding a hook with `init` and asserting the output
> validates.
>
> Skills/tools you need: TypeScript, Node, the engine lib APIs (read the exported interfaces from P4),
> `libs/authoring` scaffold() + writeFileSet() API, `libs/manifest` validate() API.
> Files to read first: `docs/decisions/0001-nx-and-self-hosting.md` D1 + D2; `DOD.md` A1–A12;
> `libs/authoring/src/index.ts`, `libs/install-engine/src/index.ts`, `libs/host-runtime/src/index.ts`,
> `libs/registry/src/index.ts`, `libs/manifest/src/index.ts`.
> Success criteria: the Phase 5 acceptance check exits 0.
> Hard constraints: `apps/sox/extension.json` MUST validate against `libs/manifest` — the self-hosting
> invariant (D1). `init` MUST use `libs/authoring` scaffold() — do NOT re-port the old broken scaffolder.
> `exec` MUST use the running server (not a throwaway session). Nx is never a runtime dep. Capture `$?`
> directly; never pipe a tested exit.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/nx-migration/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P5 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

---

## Phase 6 — Per-type discovery: refine generators + confirm contract flexes

**Phase ID:** P6
**Phase goal:** the real extension corpus (listed in the strategy doc §5) is explored — shape per type,
not full ingestion — and the findings are used to refine the `libs/authoring` generator templates and
confirm (or update) the `libs/manifest` contract flexes. Scope is bounded: "shape per type" only;
ingestion is explicitly out of scope. Each active type's generator produces output that matches a real
example's structure.
**Inputs:** P5 (green); `docs/plans/nx-self-hosting-migration.md` §5 (real example sources per type
and their paths); `libs/authoring/src/templates/` (current templates to refine).
**Outputs:** refined templates in `libs/authoring/src/templates/<type>/` for each of the 6 types;
any `libs/manifest` schema updates needed to accommodate real corpus shapes (additive/backward-
compatible only); an updated born-conformance gate (if template changes affect output); a one-page
`docs/per-type-shapes.md` recording the confirmed/refined shape per type; parity test still green.
**Verification:** acceptance check exits 0.

**Acceptance check (deterministic)**

```bash
cd "$ROOT"
# P5 guard: sox extension.json still validates and CLI builds:
node -e "const {validate}=require('./libs/manifest/dist/index');const m=require('./apps/sox/extension.json');const r=validate(m);process.exit(r.ok?0:1)"; rc=$?; [ $rc -eq 0 ] || exit 1
# libs/manifest and libs/authoring rebuild after any template changes:
pnpm exec nx run-many -t build --projects=manifest,authoring >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# born-conformance gate passes for all 6 types (with refined templates):
pnpm exec nx run sox-nx:born-conformance >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# parity test still passes (sox init == nx generator):
pnpm exec nx run sox-nx:test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# per-type-shapes doc exists:
test -f docs/per-type-shapes.md; rc=$?; [ $rc -eq 0 ] || exit 1
# full test suite green:
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```

**Green =** templates reflect the real corpus shapes, the three contract flexes are confirmed (or any
needed adjustments are applied and re-tested), and the born-conformance + parity invariants are
unbroken. Discovery is bounded — ingestion is not done.

**Phase prompt:**

> You are a developer-experience engineer in the `sox-ecosystem` monorepo at
> `$ROOT=/Users/nix/dev/ai/sox-ecosystem` (`pnpm` on PATH or at
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). You are on branch `feat/nx-migration`. Phase 5 is
> green: `apps/sox` (extension #0) is fully wired and self-validated.
>
> Context you need cold — the real extension corpus (from `docs/plans/nx-self-hosting-migration.md` §5):
>
> | type | real example source |
> |---|---|
> | hook | `~/dev/ai/claude-agents/tools/hooks/{swarm-cost,agent-tool-logger.sh,budget-gate.sh}` |
> | mcp-server | `~/dev/node/adhd/packages/ai/agent-mcp` |
> | command | `~/dev/ai/sox-protocol/packages/python`, `~/dev/ai/claude-agents/tools/cli` |
> | skill | `~/dev/ai/claude-agents/categories/workflow/skills/` |
> | agent | `~/dev/ai/claude-agents/categories/00-active/agents/` |
> | bundle | existing `extensions/bundles/` |
> These repos are LARGE — do NOT ingest them; read enough to determine the shape per type. `prompt` is
> parked (no generator needed). Scope: "shape per type" only. Ingestion is explicitly out of scope.
>
> Your task: (1) For each of the 6 active types, read 1–3 real examples from the source locations above
> to determine the structural shape (what fields appear in the manifest, what the entrypoint looks like,
> what the template should scaffold). Note any shapes that do NOT fit the current contract flexes in
> `libs/manifest`. (2) Refine the `libs/authoring/src/templates/<type>/` templates to match real corpus
> shapes — e.g., a shell hook's template should have the correct shebang and event binding structure; an
> agent template should scaffold a markdown `.md` entrypoint if that is what real agents use; a skill
> template should match the real skill I/O convention. (3) If any real corpus shape requires a schema
> change, apply it to `libs/manifest` as an additive/backward-compatible adjustment (never a breaking
> change). (4) Rebuild `libs/manifest` and `libs/authoring`; re-run the born-conformance gate and parity
> test; fix any failures. (5) Write `docs/per-type-shapes.md` recording the confirmed shape per type
> (one paragraph per type; include the entrypoint form, runtime, whether install-target applies).
>
> Skills/tools you need: reading real codebases, TypeScript, template editing, `libs/manifest` schema
> editing, `libs/authoring` template editing.
> Files to read first: `docs/plans/nx-self-hosting-migration.md` §5 (the source map); current
> `libs/authoring/src/templates/` (what exists to refine); `libs/manifest/src/index.ts` (the current
> schema + flexes); `docs/decisions/0001-nx-and-self-hosting.md` §Contract adjustments.
> Success criteria: the Phase 6 acceptance check exits 0.
> Hard constraints: **DO NOT ingest** any external extensions — read shapes only (look at manifests and
> entrypoints; do not copy all source files). Prompt type gets NO generator or template. Any schema
> change must be additive (backward-compatible; all existing manifests still validate). The parity test
> MUST stay green. Capture `$?` directly; never pipe a tested exit.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/nx-migration/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P6 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

---

## Phase 7 — Generate memory's 4 extensions + `libs/memory-core` (kill the reach-in)

**Phase ID:** P7
**Phase goal:** the four memory extensions (`memory-server`, `memory-organizer`, `memory-flush`,
`memory-cli`) and the `sox-memory-bundle` are generated via `@adhd/sox-nx:extension` in the new nx layout.
Shared internal code is extracted into `libs/memory-core` (satisfying C7). All cross-extension
`../../../dist` reach-in imports are re-pointed to `libs/memory-core` — and the module-boundary lint
confirms they are now forbidden. The memory MCP end-to-end still works (C5: `memory_write` +
`memory_recall`).
**Inputs:** P6 (green refined generators); `docs/decisions/0001-nx-and-self-hosting.md` §Layout mapping
(`libs/memory-core`); `CLAUDE.md` C5 (memory write+recall green); C7 (reach-in exists today).
**Outputs:** `extensions/mcp-servers/memory-server/` (re-generated with nx project); `extensions/
agents/memory-organizer/`, `extensions/hooks/memory-flush/`, `extensions/commands/memory-cli/`,
`extensions/bundles/sox-memory-bundle/` — all with `project.json`, `type:extension` tag, build target;
`libs/memory-core/src/` (db schema, embed helpers, recall/write utilities); all reach-in imports
replaced with `libs/memory-core` imports; module-boundary lint clean; `nx run memory-server:test` green.
**Verification:** acceptance check exits 0.

**Acceptance check (deterministic)**

```bash
cd "$ROOT"
# P6 guard: born-conformance and parity pass:
pnpm exec nx run sox-nx:born-conformance >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# libs/memory-core exists and builds:
pnpm exec nx run memory-core:build >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# all 4 memory extensions + bundle build clean:
pnpm exec nx run-many -t build --projects=memory-server,memory-organizer,memory-flush,memory-cli,sox-memory-bundle >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# no cross-extension dist reach-in imports remain (search for the pattern):
node -e "
  const {execSync}=require('child_process');
  try {
    const out=execSync('grep -r \"\\.\\./.*dist/\" extensions/ --include=\"*.ts\" -l',{cwd:process.cwd()}).toString().trim();
    // if grep finds any files, we have a violation:
    process.exit(out.length?1:0);
  } catch(e) { process.exit(0); } // grep exits 1 when no matches — that is success
"; rc=$?; [ $rc -eq 0 ] || exit 1
# module-boundary lint passes (no extension→extension imports):
pnpm exec nx run-many -t lint --projects=memory-server,memory-organizer,memory-flush,memory-cli >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# C5: memory write+recall works end-to-end:
TMP="$ROOT/.tmp-memory-e2e"; rm -rf "$TMP"; mkdir -p "$TMP"
node dist/extensions/commands/memory-cli/main.js init --scope project --path "$TMP" >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# write a memory entry and recall it (zero-LLM path):
node -e "
  const {write,recall}=require('./libs/memory-core/dist/index');
  const db='$TMP/.memory/project.db';
  write(db,{content:'nx migration test memory entry',agent_id:'test'});
  const r=recall(db,{query:'nx migration',limit:1});
  process.exit(r.length>0?0:1)
"; rc=$?; [ $rc -eq 0 ] || exit 1
rm -rf "$TMP"
exit 0
```

**Green =** the memory extensions are re-homed in the nx layout; all shared code lives in
`libs/memory-core` (C7 satisfied); the cross-extension reach-in is eliminated and would be caught by
module-boundary lint; memory write+recall works end-to-end (C5 still holds).

**Phase prompt:**

> You are a refactoring/systems engineer in the `sox-ecosystem` monorepo at
> `$ROOT=/Users/nix/dev/ai/sox-ecosystem` (`pnpm` on PATH or at
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). You are on branch `feat/nx-migration`. Phase 6 is
> green: generators are refined against the real corpus.
>
> Context you need cold (from `docs/decisions/0001-nx-and-self-hosting.md`):
>
> - **C7 fix**: today `memory-server` has shared db/schema/embed/recall/write code that other memory
>   extensions reach into via `../../../dist` relative paths. The fix is `libs/memory-core` — an
>   **internal library** (not published) that the 4 memory extensions depend on. Cross-extension
>   `dist` imports become a lint error.
> - **Layout:** `libs/memory-core` at `libs/memory-core/` (tagged `type:lib`). The 4 extensions stay in
>   `extensions/mcp-servers/memory-server/`, `extensions/agents/memory-organizer/`,
>   `extensions/hooks/memory-flush/`, `extensions/commands/memory-cli/` — they get `project.json` and
>   `type:extension` tags added.
> - **Approach:** generate shells first via `pnpm exec nx g @adhd/sox-nx:extension <type> <id>` (add tags),
>   then port the logic from the current extension sources, then re-point deps to `memory-core`. Verify
>   last.
> - **C5 must hold:** `memory_write` + `memory_recall` must continue to work end-to-end. The
>   `libs/memory-core` extraction must not break the recall logic.
>
> Your task: (1) Generate `libs/memory-core`: `pnpm exec nx g @adhd/sox-nx:library memory-core
> --directory=libs/memory-core`. Port into it: SQLite schema + migrations, embed helpers, recall logic
> (hybrid vec+BM25+graph depth-1), write logic (SHA-256 dedup, FTS index). Tag it `type:lib`. (2) Add
> `project.json` and `type:extension` tags to each of the 4 existing memory extensions and the bundle.
> Configure their nx `build` targets to use `@nx/js:tsc`. (3) In each extension, replace every
> `../../../dist` import with an import from `@adhd/sox-memory-core` (or the monorepo path alias for
> `libs/memory-core`). (4) Re-run `pnpm exec nx run-many -t lint` — every boundary violation must be
> zero. If lint catches a violation, fix the import, do NOT disable the rule. (5) Run memory-server's
> tests (and any other memory extension tests) and confirm green.
>
> Skills/tools you need: TypeScript, Nx, `libs/memory-core` API design (read the existing
> `memory-server/src/` to identify what to extract), SQLite, vitest.
> Files to read first: `extensions/mcp-servers/memory-server/src/` (all files — this is what gets
> extracted); `extensions/agents/memory-organizer/src/`, `extensions/hooks/memory-flush/src/`,
> `extensions/commands/memory-cli/src/`; `docs/decisions/0001-nx-and-self-hosting.md` §Layout mapping.
> Success criteria: the Phase 7 acceptance check exits 0.
> gitnexus (repo indexed — use it to extract `memory-core` safely): run `gitnexus query "memory recall write schema"` and `gitnexus context <symbol>` to find EVERY module that imports the memory-server internals (this is how you locate the cross-extension `../../../dist` reach-in to kill); run `gitnexus impact <symbol>` before moving each shared module into `libs/memory-core`; run `gitnexus detect-changes` after to verify the 4 memory extensions are the only affected consumers. Prefer the gitnexus MCP tools over grep.
> Hard constraints: the reach-in pattern (`../../../dist`) must be ZERO after this phase — any remaining
> instance is a failure. Do NOT disable the module-boundary lint rule to make it pass; fix the import.
> `libs/memory-core` is an internal lib — do NOT publish it (no `package.json` `publishConfig`). C5
> (`memory_write` + `memory_recall`) must still work. Capture `$?` directly; never pipe a tested exit.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/nx-migration/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P7 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

---

## Phase 8 — Migrate existing extensions to nx layout + re-point to engine libs

**Phase ID:** P8
**Phase goal:** all remaining extensions in `extensions/` that are not yet nx projects get `project.json`
files, `type:extension` tags, and working `build` targets (so `nx run-many -t build` covers the full
tree). Extension manifests are updated to use `libs/manifest`'s contract (including the flex fields where
applicable). The old `scripts/` engine consumers (`validate-manifests.ts`, `build-index.ts`) are updated
to delegate to `libs/manifest` and `libs/install-engine` — not deleted, but now thin wrappers. The
`nx run-many -t build,validate` on the full tree exits 0.
**Inputs:** P7 (green memory extensions); the remaining `extensions/` subdirectories (skills, commands,
hooks that are not yet nx projects); `scripts/validate-manifests.ts` (to thin-wrap).
**Outputs:** `project.json` for every extension in `extensions/`; all extension manifests validated
against `libs/manifest`; `scripts/validate-manifests.ts` delegates to `libs/manifest validate()` (thin
wrapper, all 44 tests preserved); `nx run-many -t build` covers all projects; `nx run-many -t lint`
clean (no boundary violations).
**Verification:** acceptance check exits 0.

**Acceptance check (deterministic)**

```bash
cd "$ROOT"
# P7 guard: memory-core and memory extensions build clean:
pnpm exec nx run-many -t build --projects=memory-core,memory-server,memory-organizer,memory-flush,memory-cli >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# every project in the nx graph builds (affected would miss nothing):
pnpm exec nx run-many -t build >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# module-boundary lint across ALL projects is clean:
pnpm exec nx run-many -t lint >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# the thin-wrapped validate-manifests still passes (44 tests):
pnpm tsx scripts/validate-manifests.ts >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# validate as an nx target works:
pnpm exec nx run manifest:test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```

**Green =** the complete nx graph is wired: every extension is an nx project, builds clean, and passes
module-boundary lint. The old `scripts/validate-manifests.ts` is a thin wrapper (backward-compatible)
and its 44 tests still pass.

**Phase prompt:**

> You are a migration engineer in the `sox-ecosystem` monorepo at
> `$ROOT=/Users/nix/dev/ai/sox-ecosystem` (`pnpm` on PATH or at
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). You are on branch `feat/nx-migration`. Phase 7 is
> green: `libs/memory-core` + the 4 memory extensions are in the nx graph; reach-in is eliminated.
>
> Context you need cold: any remaining `extensions/` packages without `project.json` are invisible to the
> nx graph — `nx run-many` will skip them. Also, `scripts/validate-manifests.ts` currently runs its own
> validation logic; after Phase 2 this duplicates `libs/manifest`. It should become a thin wrapper
> (`import {validate} from 'libs/manifest'; …`) so there is a single source of truth — but ALL 44 of its
> tests must still pass (they are the conformance regression suite).
>
> Your task: (1) For every `extensions/<type>/<id>/` directory that does NOT yet have a `project.json`,
> add one: tag it `type:extension`, configure a `build` target using `@nx/js:tsc` (or `@nx/node:build`
> for Node extensions). For declarative/shell extensions with no TypeScript, add a no-op `build` target
> (or a copy target). (2) Validate every extension's `extension.json` against `libs/manifest` — for any
> that fail (due to the old schema being stricter or more lenient than the new flexes), fix the manifest
> (or add the flex fields as needed) to make it pass. Do NOT change extension behavior — manifests only.
> (3) Thin-wrap `scripts/validate-manifests.ts`: replace its validation logic with calls to
> `libs/manifest`'s `validate()` function, keeping the same error reporting format and exit code
> behavior. Run all 44 tests and confirm green. (4) Run `pnpm exec nx run-many -t build` and
> `pnpm exec nx run-many -t lint` and fix any failures (they are expected the first run — tag mismatches,
> missing tsconfig paths, etc.).
>
> Skills/tools you need: Nx `project.json` format, TypeScript, `libs/manifest` validate() API, the
> existing `scripts/validate-manifests.ts` test harness.
> Files to read first: `extensions/` directory listing (all subdirectories); `scripts/validate-manifests.ts`
> (the 44 tests and the validation logic to replace); `libs/manifest/src/index.ts` (the validate API);
> `docs/decisions/0001-nx-and-self-hosting.md` §Layout mapping.
> Success criteria: the Phase 8 acceptance check exits 0.
> gitnexus (repo indexed — use it per extension you migrate): `gitnexus impact <symbol>` + `gitnexus context <symbol>` before relocating each extension's code; `gitnexus detect-changes` after, to confirm no unexpected consumers were affected. Prefer the gitnexus MCP tools over grep for finding importers.
> Hard constraints: ALL 44 `validate-manifests.ts` tests must stay green — the thin-wrap may not
> silently drop test coverage. Do NOT change extension entrypoints or runtime behavior — manifests and
> `project.json` only. The module-boundary lint must be clean across ALL projects. Capture `$?` directly;
> never pipe a tested exit.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/nx-migration/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P8 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

---

## Phase 9 — CI: `nx affected`, `nx release` + commitlint, reality-gate tests as nx targets

**Phase ID:** P9
**Phase goal:** CI is updated to run `nx affected -t build,lint,test` (so only changed packages
rebuild); `nx release` replaces Changesets as the versioning mechanism; commitlint is wired into the
pre-commit hook; all existing tests and the new reality-gates (process-table checks, lifecycle e2e) are
re-homed as nx targets so they run on `affected`; per-type purpose docs (`docs/guidelines/`) are
present for all 6 active types. The scaffolder tests from `scripts/` are retired (replaced by the
born-conformance gate).
**Inputs:** P8 (green full-graph build); `.github/workflows/` (existing CI); `scripts/*.test.ts`
(existing test suite — move, don't re-implement); `docs/plans/nx-self-hosting-migration.md` §6 P9 (CI

- reality-gates).
**Outputs:** updated `.github/workflows/ci.yml` running `nx affected -t build,lint,test,validate`; a
`commitlint` pre-commit hook (husky or simple-git-hooks); `nx release` dry-run works in CI; per-type
docs in `docs/guidelines/<type>.md` for agent, skill, mcp-server, hook, command, bundle; scaffolder
tests removed (replaced); process-table reality-gates preserved as nx targets (not removed); no
previously-green test removed.
**Verification:** acceptance check exits 0.

**Acceptance check (deterministic)**

```bash
cd "$ROOT"
# P8 guard: full nx graph builds and lints clean:
pnpm exec nx run-many -t build >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# affected works (simulate by running on all — affected subset is a CI optimization):
pnpm exec nx affected -t build,lint,test --all >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# nx release dry-run completes (requires conventional commit history from P0+):
pnpm exec nx release --dry-run >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# per-type docs exist for all 6 active types:
for t in agent skill mcp-server hook command bundle; do
  test -f "docs/guidelines/$t.md"; rc=$?; [ $rc -ne 0 ] && exit 1
done
# CI workflow uses nx affected:
node -e "const fs=require('fs');const y=fs.readFileSync('.github/workflows/ci.yml','utf8');process.exit(y.includes('nx affected')?0:1)"; rc=$?; [ $rc -eq 0 ] || exit 1
# full test suite green (including reality-gates re-homed as nx targets):
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
exit 0
```

**Green =** CI is incremental (affected only); `nx release` is wired; commitlint enforces conventional
commits; all tests (including reality-gates) survive the re-homing; per-type docs exist for all 6 types.

**Phase prompt:**

> You are a CI/release engineer in the `sox-ecosystem` monorepo at
> `$ROOT=/Users/nix/dev/ai/sox-ecosystem` (`pnpm` on PATH or at
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). You are on branch `feat/nx-migration`. Phase 8 is
> green: the full nx graph builds and lints clean.
>
> Context you need cold (from `docs/decisions/0001-nx-and-self-hosting.md` D3 and `docs/plans/
> nx-self-hosting-migration.md` §6 P9):
>
> - **D3 — `nx release` replaces Changesets.** Conventional commits + commitlint enforce the commit
>   format. Nx release does graph-aware bumps (change `memory-core` → all 4 memory extensions bump
>   automatically). The `.changeset/` directory is deprecated.
> - **Reality-gate discipline:** process-table checks and lifecycle e2e tests (the ones that verify
>   against the OS, not just test output) must be preserved — re-home them as nx `test` targets, do NOT
>   delete them. The scaffolder tests in `scripts/scaffolder.test.ts` are RETIRED (replaced by the
>   born-conformance gate in `packages/sox-nx`); do not move them — delete them.
> - **Per-type purpose docs:** each of the 6 active types needs a `docs/guidelines/<type>.md` describing
>   purpose, when-to-use, install-target (for declarative types), and the generator inputs. This fills
>   the gap that left `prompt`'s use case undiscoverable.
>
> Your task: (1) Update `.github/workflows/ci.yml` (or create it if absent) to run
> `pnpm exec nx affected -t build,lint,test,validate --base=origin/main` as the primary CI step.
> Remove any `pnpm -r build` or `pnpm test --all` steps that are not nx-affected-aware. (2) Wire
> `nx release` in `nx.json` with conventional-commits version strategy, a changelog renderer, and
> the memory extensions as a release group (so `memory-core` changes propagate). (3) Add commitlint +
> husky (or `simple-git-hooks`): conventional-commits preset; `commit-msg` hook runs commitlint.
> (4) Delete `scripts/scaffolder.test.ts` (the born-conformance gate in `packages/sox-nx` replaces
> it). Ensure every OTHER test from `scripts/*.test.ts` is either already in its lib's test file
> (from P4) or added now. (5) Re-home the process-table reality-gate tests as nx `test` targets on
> the appropriate lib (`host-runtime` or `install-engine`). (6) Write
> `docs/guidelines/{agent,skill,mcp-server,hook,command,bundle}.md` — each: purpose, when-to-use,
> generator inputs, install-target (for declarative types), example invocation.
>
> Skills/tools you need: GitHub Actions YAML, Nx release configuration, commitlint, husky/simple-git-hooks,
> TypeScript, vitest.
> Files to read first: `.github/workflows/` (existing), `nx.json` (P1 release block to extend),
> `package.json` (existing scripts), `scripts/scaffolder.test.ts` (to delete), `scripts/*.test.ts`
> (inventory what is being moved); `docs/plans/nx-self-hosting-migration.md` §6 P9; ADR D3.
> Success criteria: the Phase 9 acceptance check exits 0.
> Hard constraints: do NOT delete any reality-gate test that checks the OS process table — re-home it,
> not remove it. `scripts/scaffolder.test.ts` IS deleted (born-conformance gate replaces it). Full test
> count must not drop below the pre-migration count minus the scaffolder tests. Capture `$?` directly;
> never pipe a tested exit.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/nx-migration/status.md` under `## State transitions`:
> `<ISO timestamp> executing — phase P9 complete (executor: <your role>)`
> Update frontmatter: `state: executing`, `last_event: <ISO timestamp>`.

---

## Phase 10 — Acceptance: verify D5 scope from a clean slate

**Phase ID:** P10
**Phase goal:** full, final verification of the D5 migration scope from a clean slate — every type
`init → build → validate → install → run`, lifecycle with zero orphans (verified against the OS process
table), and the full command surface using the **documented flag forms**. A1, A12, B1–B4, C7 must pass;
nothing previously green may be regressed. C6 and memory-depth remain explicitly out.
**Inputs:** P9 (green CI/release/tests); `DOD.md` (the bar); `CLAUDE.md` (current green items that must
not regress); `docs/decisions/0001-nx-and-self-hosting.md` D5 (the scope).
**Outputs:** a fully-verified system. No new code — only verification. Any failure found must be fixed
before the phase is marked complete.
**Verification:** acceptance check exits 0 — this is the final phase; it transitions `state: complete`.

**Acceptance check (deterministic)**

```bash
cd "$ROOT"
# ---- B3: incremental build (only changed packages rebuild) ----
pnpm exec nx run-many -t build >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# touch one extension source file and assert only affected projects rebuild:
touch extensions/mcp-servers/memory-server/src/index.ts
pnpm exec nx affected -t build --base=HEAD~1 >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
git checkout -- extensions/mcp-servers/memory-server/src/index.ts

# ---- A1: born-conformant init for all 6 types ----
for type in agent skill mcp-server hook command bundle; do
  TMP="$ROOT/.tmp-a1-$type"; rm -rf "$TMP"; mkdir -p "$TMP"
  node dist/apps/sox/main.js init "$type" "verify-$type" --out "$TMP" >/dev/null 2>&1; rc=$?; [ $rc -ne 0 ] && exit 1
  node -e "const {validate}=require('./libs/manifest/dist/index');const m=require('$TMP/verify-$type/extension.json');const r=validate(m);process.exit(r.ok?0:1)" 2>/dev/null; rc=$?; [ $rc -ne 0 ] && exit 1
  rm -rf "$TMP"
done
echo "A1: all 6 types init → validate"

# ---- A12: both flag forms parse correctly ----
node dist/apps/sox/main.js install --help >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
node -e "
  const {parseArgs}=require('./libs/install-engine/dist/index');
  const r1=parseArgs(['--scope','user']);
  const r2=parseArgs(['--scope=user']);
  process.exit((r1.scope==='user'&&r2.scope==='user')?0:1)
"; rc=$?; [ $rc -eq 0 ] || exit 1
echo "A12: both flag forms correct"

# ---- B1/B2: every type init → build → validate → install → run ----
# Use the hook type as the representative full-lifecycle proof (most constrained):
TMP="$ROOT/.tmp-b1b2"; rm -rf "$TMP"; mkdir -p "$TMP"
node dist/apps/sox/main.js init hook e2e-hook --events SessionEnd --runtime node --out "$TMP" >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
pnpm exec nx run e2e-hook:build --skipNxCache >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
node dist/apps/sox/main.js validate "$TMP/e2e-hook" >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
node dist/apps/sox/main.js install --scope project "$TMP/e2e-hook" >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
node dist/apps/sox/main.js start >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
node dist/apps/sox/main.js list >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
node dist/apps/sox/main.js stop >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
# zero orphan processes (OS process table — reality check, not test output):
pids=$(pgrep -f "sox-ecosystem" 2>/dev/null || true)
[ -z "$pids" ]; rc=$?; [ $rc -eq 0 ] || exit 1
rm -rf "$TMP"
echo "B1/B2: init→build→validate→install→run→stop, zero orphans"

# ---- C7: no cross-extension reach-in ----
node -e "
  const {execSync}=require('child_process');
  try {
    const out=execSync('grep -r \"\\.\\./.*dist/\" extensions/ --include=\"*.ts\" -l',{cwd:process.cwd()}).toString().trim();
    process.exit(out.length?1:0);
  } catch(e) { process.exit(0); }
"; rc=$?; [ $rc -eq 0 ] || exit 1
echo "C7: no cross-extension dist reach-in"

# ---- B4: adding a new extension does not red-bar validate ----
TMP2="$ROOT/.tmp-b4"; rm -rf "$TMP2"; mkdir -p "$TMP2"
node dist/apps/sox/main.js init command new-cmd --verb greet --runtime node --out "$TMP2" >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
node dist/apps/sox/main.js validate >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
rm -rf "$TMP2"
echo "B4: new extension does not red-bar validate"

# ---- Full suite: nothing regressed ----
pnpm -s test >/dev/null 2>&1; rc=$?; [ $rc -eq 0 ] || exit 1
echo "Full suite: no regressions"

echo "D5 ACCEPTANCE: A1 A12 B1 B2 B3 B4 C7 all pass; suite green"
exit 0
```

**Green =** the full D5 scope is verified from a real execution path: all 6 types born-conformant,
lifecycle runs to zero orphans (OS-verified), both flag forms parse correctly, `libs/memory-core`
eliminates the reach-in, adding a new extension doesn't red-bar validate, and incremental build works.
Nothing previously green is regressed. The migration is done. **state → complete.**

**Phase prompt:**

> You are an acceptance engineer performing the final verification of the Nx + self-hosting migration in
> the `sox-ecosystem` monorepo at `$ROOT=/Users/nix/dev/ai/sox-ecosystem` (`pnpm` on PATH or at
> `/Users/nix/.nvm/versions/node/v24.11.1/bin/pnpm`). You are on branch `feat/nx-migration`.
> ALL prior phases (P0–P9) must be green before you begin. This phase is VERIFICATION ONLY — no new
> code is written unless a specific acceptance assertion fails, in which case you fix the root cause and
> re-run.
>
> Context you need cold — the D5 scope (from `docs/decisions/0001-nx-and-self-hosting.md` D5):
> "Accountable for A1, A12, B1–B4, C7 + no regressions to anything currently green. Explicitly out:
> C6 (runtime permission enforcement) and memory semantic depth." Verification is against **reality**
> (OS process table, real built artifacts, documented flag forms) from a clean state — NOT
> self-reported test output. This is the `DOD.md` "Verification rule" applied.
>
> Your task: (1) Run the complete Phase 10 acceptance check above. If any assertion fails, diagnose the
> root cause, fix it in the appropriate phase's output (P1–P9), rebuild, and re-run the acceptance check.
> Do not declare done with any assertion red. (2) Explicitly verify the previously-green items from
> `CLAUDE.md` are still green: A2 (`validate`), A3 (`search`), A4 (`install`), A5 (`start`), A6
> (`list`/`details`), A7 (`enable`/`disable`), A8 (`update`), A9 (`uninstall`), A10 (`stop`), C1, C2,
> C3, C5. (3) Confirm C6 and memory-depth are NOT claimed as done (they remain unchecked). (4) Once all
> assertions pass, do NOT merge to main — that is for a human to review. Just confirm the branch is
> clean and all checks pass.
>
> Skills/tools you need: all of the above; read DOD.md and CLAUDE.md to inventory what was green before.
> Files to read first: `DOD.md`, `CLAUDE.md`, `docs/decisions/0001-nx-and-self-hosting.md` D5.
> Success criteria: the Phase 10 acceptance check exits 0 with every assertion passing.
> Hard constraints: DO NOT declare done with any D5 item unverified. DO NOT claim C6 is done — it
> remains out of scope. Verification is against real process table and real artifacts, not test logs alone.
> If a fix is needed, make it targeted (in the specific lib or config that's wrong) — do not re-implement
> large chunks of prior phases. This is the FINAL phase: set `state: complete`.
>
> **Mandatory completion step.** Before exiting, append one line to
> `.workflow/plans/nx-migration/status.md` under `## State transitions`:
> `<ISO timestamp> complete — phase P10 complete (executor: <your role>)`
> Update frontmatter: `state: complete`, `last_event: <ISO timestamp>`. *(Final phase: `complete`, not
> `executing`.)*

---

## Resumability & ownership

- **Resume guard:** each phase's first action re-runs the prior phase's core acceptance assertion. On
  red, the executor repairs forward — never silently skips.
- **Critical ordering:** P2 (`libs/manifest`) before P3 (`libs/authoring`); P4 (engine libs) before P5
  (wire `apps/sox`); P3 (generators) before P7 (memory re-gen); P8 (full graph) before P9 (CI). P6
  (discovery) runs after P5 and before P7 — generators must exist before refinement, and memory
  re-generation comes after the generators are stable.
- **Fix-carry discipline:** P4 is the designated phase for carrying all session fixes forward. Later
  phases build on P4's output — they do NOT reach back into pre-fix history.
- **File ownership (no file written by two phases):**
  - P0 owns: the initial commit + `pre-nx-baseline` tag + `feat/nx-migration` branch.
  - P1 owns: `nx.json`, root `package.json` (nx devDeps), `tsconfig.base.json`, ESLint config,
    `commitlint.config.js`, `pnpm-workspace.yaml` additions.
  - P2 owns: `libs/manifest/` + `schemas/extension/v2.json` (or updated `v1.json`) + schema flex changes.
  - P3 owns: `libs/authoring/`, `packages/sox-nx/`, `tools/born-conformance.js`; deletes 6 demos.
  - P4 owns: `libs/install-engine/`, `libs/host-runtime/`, `libs/registry/`, `apps/sox/` (stub shell).
  - P5 owns: `apps/sox/extension.json` + verb handler implementations + `apps/sox/bin/sox`.
  - P6 owns: `docs/per-type-shapes.md` + template refinements in `libs/authoring/src/templates/`.
  - P7 owns: `libs/memory-core/` + `project.json` additions on 4 memory extensions.
  - P8 owns: `project.json` for remaining extensions + thin-wrap of `scripts/validate-manifests.ts`.
  - P9 owns: `.github/workflows/ci.yml` + commitlint/husky + `docs/guidelines/<type>.md` per type;
    deletes `scripts/scaffolder.test.ts`.
  - P10 owns: no new files — verification only; transitions `state: complete`.
- **What stays custom (Nx does not touch):** manifest contract + `validate`; multi-scope install/cascade;
  host runtime; registry; the `sox` CLI/host semantics. Nx provides only the undifferentiated layer.
- **Nx never at runtime:** no extension or lib may list `nx` (or `@nx/*`) in `dependencies` (only
  `devDependencies` at the root). The `libs/authoring` parity test enforces the nx-free core invariant.
- **Explicitly out of scope (D5 + strategy §9):** C6 (runtime permission enforcement); memory semantic
  quality (real embeddings, LLM organizer enrichment); ingestion/normalization of external extensions.

---

## Changelog

- **2026-06-11** — Initial plan. 11 phases (P0–P10). Expands the P0–P10 outline from
  `docs/plans/nx-self-hosting-migration.md` into a full plan-state-machine with deterministic
  acceptance checks, Green= lines, and standalone executor prompts. Every phase carries a mandatory
  status-update step. Format follows `.workflow/plans/sox-memory/migration.md` and
  `.workflow/plans/consumer-interface-standard/migration.md`. Scope = D5: A1, A12, B1–B4, C7 + no
  regressions; C6 + memory-depth explicitly out. Written by `architect-reviewer`.
