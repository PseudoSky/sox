# AGENTS.md — sox-ecosystem

> This file is the single source of truth for all agents (Claude Code, OpenCode, Codex).
> `CLAUDE.md` is a symlink to this file — edits here, both hosts see the same guidance.

## Routing

**Memory-subsystem work → [`docs/reporting/memory/README.md`](./docs/reporting/memory/README.md).**
That is the single entry point: program state, work order, findings, and the traps that have each
cost hours. Start at its `STATE.md`. Do not create a parallel doc tree for memory work — findings
go in `findings/`, state in `STATE.md`, defects filed through the backlog tool (family `BL`, repo
`sox-ecosystem`), nowhere else.


For codebase navigation, see [`docs/routing/ROUTER.md`](./docs/routing/ROUTER.md) (intent→scope mapping) and
[`docs/routing/INDEX.md`](./docs/routing/INDEX.md) (project listing). For `data/*` package guidance, see
[`libs/data/CLAUDE.md`](./libs/data/CLAUDE.md).

## Website & package metadata (discoverability)

The public-facing discoverability layer is governed by these rules:

1. **Manifest is derived, never edited.** The website's package list (once the site exists) is
   generated from `package.json` at build time — never hand-edit the generated manifest.
2. **Description == the one-liner.** A package's `package.json.description` is what its site card and
   npm snippet show — keep it a one-line "what it does + problem solved".
3. **New publishable package ⇒ keywords + repository + homepage.** Every `private: false` package must
   carry `keywords`, `repository`, and `homepage`. Until sox-ecosystem gets its own GitHub repo, these
   point at `github.com/PseudoSky/adhd` (see `docs/plan/website-design/README.md`).
4. **Root AEO files.** `llms.txt`, `LICENSE`, `SECURITY.md`, and `CODE_OF_CONDUCT.md` live at the repo
   root and are updated when the package set changes.
5. **CI sync gate.** A check fails the PR if any publishable package is missing `description`/`keywords`
   or if the website manifest and the publishable package set diverge.

## Harvesting external skills into extensions

When asked to harvest an external repo/URL into a sox extension:

1. **Fetch the upstream content** (SKILL.md and any references/, assets/, scripts/ dirs).
2. **Scaffold** with `soxe init skill <id>` (adds extension.json, package.json, CHANGELOG.md, README.md, SKILL.md skeleton).
3. **Move to** `extensions/skills/<id>/`.
4. **Populate SKILL.md** with upstream content + YAML frontmatter with `source` and `source-version` fields.
5. **Write reference files** into `references/` (same structure as upstream).
6. **Update extension.json** `run_interface` with input/output schemas matching the skill's contract.
7. **No registry step needed** — the new skill has no `registry/index.json` row and installs
   straight from its local dir; see [registry is release-only](#registry-is-release-only).
8. **Install & replace in place + exercise the install** — for each target host, uninstall any
   existing install of the id first (`soxe uninstall <id> --host <host> --scope user`), then
   `soxe install <id> --host <host> --scope user`; verify the installed dir is byte-identical to
   the extension with zero leftover files, then prove the host actually loads it in a FRESH
   process (`opencode run` / `claude -p` one-turn probe reporting the skill's version). Load the
   `sox-ingest` skill for the full flow.
9. **Upgrade consumers** with `node bin/soxe upgrade --all`.
10. **Commit** the source changes.

Existing harvested skills: `extensions/skills/tui-design/` (from gfargo/skills, TUI/CLI design).

---

## ⛔ AGENT CONSTRAINT — RUN SMOKE TEST BEFORE MERGING

**Every agent MUST run `node scripts/smoke-test.mjs` and confirm 0 failures before merging
any branch that touches extension manifests, the install engine, service lifecycle code,
host-runtime, CLI `cmdServe`/`cmdService`, or any `libs/data/` package consumed by bundles.**

The smoke test discovers all service + mcp-server extensions, installs them into a disposable
project scope under `dist/smoke/`, exercises every manifest-driven variation (install, upgrade,
service enable/status/disable, serve proxy + stdio, uninstall), and records structured pass/fail
json. Read the output or ensure `summary.failed === 0` at the end.

Run:
```
rm -rf dist/smoke && node scripts/smoke-test.mjs
```

Single extension fast pass:
```
node scripts/smoke-test.mjs --extension memory-server
```

---

## ⛔ AGENT CONSTRAINT — `bin/soxe` IS THE CLI SHIM, DO NOT EDIT IT FOR CLI LOGIC

The CLI entrypoint is **`bin/soxe`** — a ~10-line ESM shim that loads the compiled
`dist/apps/sox/main.js`. It contains **zero CLI logic.** All CLI logic lives in **`apps/sox/src/main.ts`**.

- **Edit a verb / flag / behavior** → `apps/sox/src/main.ts`, then `npx nx build sox`.
- **Edit the runtime** → `libs/host-runtime/src/`, then `npx nx build host-runtime`.
- **Editing the shim to change CLI behavior is always a bug** — the logic isn't there.

---

## ⛔ AGENT CONSTRAINT — COMMIT BY PATHSPEC, NOT BY STAGING

**Never run `git add -A`, `git add .`, `git add --all`, or a bare `git commit` after `git add`.**
Commit with an explicit pathspec instead: `git commit <file> <file> … -m "..."`. This commits exactly
those paths regardless of what else is sitting in the index — the index is shared across concurrent
agents, so `git add <path>` followed by a bare `git commit` sweeps in whatever anyone else already
staged (BL-409). Never let a commit touch `.nx/`, `.DS_Store`, `dist/`, or `*.js`/`*.d.ts` in `src/`.

**When a hot file is contended, pathspec is not enough — use `tools/commit-mine.mjs`.**
`git commit <path>` is all-or-nothing per file, so it cannot help when two agents are editing
different sections of `CHANGELOG.md` or `PLAN.md` at once (root `BACKLOG.md` was the canonical
example of this until [ADR-0011] Stage 3 deleted it — the graph has no equivalent hot-file
contention problem, since each item is its own row). Worse, the shared index can hold a copy of a
file *behind* HEAD: measured 2026-08-03, `BACKLOG.md` sat staged 21 lines behind HEAD, where a bare
`git commit` would have silently reverted a fix committed minutes earlier.

```
node tools/commit-mine.mjs --dry-run -m "msg" --hunks 'REGEX' -- CHANGELOG.md   # always dry-run first
node tools/commit-mine.mjs -m "msg" --hunks 'REGEX' -- CHANGELOG.md
```

It seeds a **private** `GIT_INDEX_FILE` from HEAD, applies only the hunks you selected, and moves the
branch with `commit-tree`/`update-ref`. The working tree is never modified, so another agent's
uncommitted edits survive untouched. It refuses to move the ref if HEAD changed while the commit was
being built. It **bypasses hooks** — run `node tools/check-backlog-markers.mjs` yourself first.

**`--amend` is not a message-only operation — it commits the SHARED INDEX (BL-457).** The pathspec
rule above is worded around `git add`, so `--amend` reads as exempt. It is not: one live incident ran
`git commit --amend -F msg.txt` to correct a *subject line* and turned a reviewed 2-file/+282 commit
into 8 files/+727/−2567, swallowing four other agents' staged files behind a subject that had already
been approved. `.husky/pre-commit` now refuses the pathspec-less form while the index diverges from
HEAD (run `node tools/install-git-hooks.mjs` once per clone/worktree — hooks are never tracked).

```
node tools/commit-mine.mjs --amend-message -m "corrected subject"   # message only; index untouched
git commit --amend path/one path/two                                # amending real files: name them
git reset --soft <good-sha>                                         # recovery if one already landed
```

**Do not run `git restore --staged` after `commit-mine` any more (BL-465).** That was the interim
mitigation for a defect now fixed at the source: `update-ref` used to leave every committed path in
the shared index holding the *old* HEAD blob, so `git diff --cached` read as the exact inverse of the
commit and armed the next pathspec-less commit to revert it. `commit-mine` now resyncs those entries
itself, and only those — a path where someone else has staged content is left byte-identical and
named in a warning. If you see that warning, do not commit without a pathspec until its owner clears
it.

**Staged entries outlive the agent that staged them (BL-463).** A stopped or finished agent leaves
index entries behind; `git status` looks fine and `git diff` (which compares against the *index*)
actively misleads — use `git diff HEAD`. At teardown, or when you inherit a checkout:

```
node tools/unstage-orphans.mjs                        # report only
node tools/unstage-orphans.mjs --apply --min-idle-min 10
```

It clears only entries whose staged bytes are identical to the working tree; content that exists
*only* in the index is held back and reported with the blob sha that reads it, because clearing that
would turn a revert bomb into real data loss.

**Never run `git stash` (or `git stash pop/drop/clear`).** Commit to a branch instead — `stash`
"solves" contention by destroying the other agent's work, which is the whole problem.

---

## ⛔ AGENT CONSTRAINT — BUILD VIA NX TARGETS, NEVER BARE TOOLS

Always build, test, lint, and typecheck through nx targets — never `tsc`, `vitest`, or `eslint` directly.
- `npx nx build <project>` / `npx nx test <project>` / `npx nx lint <project>` / `npx nx typecheck <project>`
- **Whole-repo gate: `npx nx run-many -t build,lint,test,typecheck`**

**`typecheck` is not optional, and `build` does not imply it.** Every esbuild-bundled project
(`memory-server`, `memory-cli`, `memory-flush`, `tokenguard`, `sox`) builds through
`tools/bundle-extension.cjs`, which **strips types without checking them**. Until 2026-07-10 the gate
was `build,lint,test` and no project had a `typecheck` target at all — so `memory-server` shipped
**15 real TypeScript errors** with a fully green sweep, two of them live bugs (BL-249: `memory_link`
missing an `await`, so it always returned `{}` and could never report an error; BL-250: reads of an
`on_hash_fallback` field that no longer exists). See BL-248.

If you add a project, give it a `typecheck` target. If a `typecheck` fails, fix the code — never
weaken `strict`, `noUnusedLocals`, or `exactOptionalPropertyTypes` to silence it.

## ⛔ AGENT CONSTRAINT — NEVER USE EMPTY CATCH STATEMENTS

Never use empty catch statements. Always log traces of errors any time you see an untraced catch, using the appropriate `@adhd/sox-...` tracing package.

---

## ⛔ AGENT CONSTRAINT — PNPM WORKSPACE "MISSING PACKAGE" DIAGNOSIS ORDER

Before concluding a `workspace:*` package failed to link, check in this order — **do not skip to a fix before completing these checks**:

1. Does the *consuming* project's own `node_modules/@scope/<pkg>` have the symlink? (Not the repo root — pnpm's isolated linker never hoists workspace packages to root `node_modules` unless the root `package.json` itself depends on them. An empty root `node_modules/@scope/` is normal, not a bug.)
2. Does a **clean-room reinstall** (`rm -rf node_modules && pnpm install`, zero flags) fix it, verified by a programmatic scan of every consumer's declared `workspace:*` deps against its own local symlink? A single `ls` is not evidence; a passing test/script is not evidence either — `tsx`/`vitest` resolve workspace packages via `tsconfig.base.json` `paths` straight to source, bypassing `node_modules` entirely. Verify against the actual runtime entry point (built `dist/`, compiled server, published CLI).

Only if step 2 fails to relink is there a real bug — and it lives in `pnpm-lock.yaml`/`package.json`, never in `node_modules`.

## ⛔ AGENT CONSTRAINT — NEVER HAND-FIX `node_modules`

`mkdir -p node_modules/... && ln -sf ...` is banned as a remediation for any linking symptom. The fix is always upstream: correct the lockfile/manifest and let `pnpm install` relink. A `--frozen-lockfile` failure post-merge means the lockfile is genuinely stale (usually a merged branch added a `workspace:*` edge without relocking) — fix with a plain `pnpm install` and **commit the resulting `pnpm-lock.yaml` diff in the same change**. Never leave a corrected lockfile uncommitted next to a hand-symlink that gets credited for the fix instead — the symlink is dead weight that masks the next real regression.

## ⛔ AGENT CONSTRAINT — RELOCK BEFORE MERGE ON NEW WORKSPACE EDGES

Any branch/worktree that adds or changes a `workspace:*` entry in a `package.json` must run `pnpm install` and commit the `pnpm-lock.yaml` diff before merging. This is a pre-merge checklist item alongside the smoke test. (Incident: BL-150.)

---

## ⛔ AGENT CONSTRAINT — SERVICE/SUPERVISOR EDITS MUST CONFORM TO THE LIFECYCLE SPEC

Read [`docs/spec/service-lifecycle.md`](./docs/spec/service-lifecycle.md) before touching:
`libs/host-runtime/src/{supervisor,runtime,reaper,lock,registry,gc,log-manager}.ts`,
the `os-unit` generator, or any `cmdStart/Stop/Serve/Enable/Disable` in `apps/sox/src/main.ts`.

- Never spawn without singleton guard — `[inv:singleton]`
- Never report RUNNING without reality verification — `[inv:list-never-lies]`
- Teardown: verified-stop + identity reaper + `[inv:unload-then-reap]` for OS units

---

<a id="registry-is-release-only"></a>
## ⛔ AGENT SEQUENCE — when you change extension/lib code that ships a `dist` artifact

`registry/index.json` is a release artifact pinned to published npm bytes. A local rebuild
never touches it: lint → build → typecheck/test → smoke → commit source only (`git diff --exit-code registry/index.json` must be clean). Extensions without a registry row install from their local dir with no checksum gate. Only the release flow (PUBLISHING.md) or `tools/repin-registry-entry.mjs` may write the registry. Never run `registry:sync-index` / bare `build-index` outside a release — it replaces the published pins with local hashes.

For what a bundled `dist` artifact actually IS and guarantees (self-contained CJS, sidecar
auto-discovery, atomic staging, the tests-bypass-artifact trap), see
[`docs/standards/extension-bundling.md`](./docs/standards/extension-bundling.md) — read it before
touching `tools/bundle-extension.cjs`, any `sox.sidecars`/`sox.sidecarExternals` declaration, or any
project's `--worker`/`--external` build flags.

---

## ⛔ AGENT CONSTRAINT — RELEASING A PACKAGE TO NPM GOES THROUGH CHANGESETS

Never run `npm publish`/`pnpm publish` by hand, and never hand-bump a `version` field. Releasing
an `@adhd/sox-*` package to npm is a Changesets-driven flow: **[`PUBLISHING.md`](./PUBLISHING.md)**
is the full playbook (version-bump gates, cascade-plan, clean-room smoke, the publish
step). Read it before touching a release, start to finish.

---

## ⛔ AGENT CONSTRAINT — NEVER MARK A BACKLOG ITEM RESOLVED WITHOUT A RED→GREEN TEST

Governed by **BL-225**. A status marker must record a *verified outcome*, never an intention.

Before calling `backlog_transition_status`/`backlog_resolve_item` with status
`RESOLVED`/`DONE`/`FIXED`/etc on any `BL-<n>` item:

1. A regression test **naming the BL-ID** exists.
2. You have seen it **fail** with the fix disabled, and **pass** with it restored. Not "it would fail" — run it.
3. A test that *skips* the failing case does not count.

This rule exists because four separate items shipped as RESOLVED while still broken:

- **BL-88** added a schema column. Nothing read it. Its dependent BL-92 stayed live.
- **BL-95** fixed `cmdStatus`, left `cmdList` broken, and was marked done.
- **BL-115** shipped a working chunker that silently took two test suites to **zero** and hard-blocked the repo-wide smoke gate for two days (BL-231).
- **BL-167**'s suite carried `hasChannelSignal` guards that *skipped the assertion for exactly the case where the invariant broke* — a coverage audit would have seen a test named for the invariant and believed it.

Corollary: **the ~125 items already marked CLOSED have never been audited against this rule.** Do not treat a `RESOLVED` marker as evidence. Read the code.

---

## ⛔ AGENT CONSTRAINT — RESOLVED BACKLOG ITEMS: TRANSITION STATUS, ATTACH CITATIONS, NOTHING FURTHER

**[ADR-0011, Stage 3 complete]** The backlog graph is the only place a `BL-*` item lives — root
`BACKLOG.md`/`CHANGELOG.md` were deleted. Resolving an item is a single tool call, not a
three-document lifecycle:

1. **Transition status** via `backlog_transition_status`/`backlog_resolve_item`
   (`RESOLVED`/`DONE`/`FIXED`/`SHIPPED`/`VERIFIED`/etc, per what actually happened).
2. **Attach citations** via `backlog_add_citation` (or `backlog_append_note` for narrative) —
   file:line evidence of the fix, same standard as before.
3. **Nothing further.** There is no second document to keep in sync, no status table to
   regenerate by hand — status of every `BL-*` item lives in the backlog graph; query it directly
   (`backlog query` / `backlog get`). `PLAN.md`/`STATE.md` carry narrative only.

---

## ⛔ AGENT CONSTRAINT — A REVERT IS NOT FINISHED UNTIL YOU REBUILD

**`git revert` restores source. It does NOT restore `dist/`.** Every running service keeps
executing the OLD artifact — code that now exists in no commit — until someone rebuilds. Reading
the source proves nothing about what is running.

Services run **directly out of this worktree**: a `file://` install is a reference, not a copy
(`resolveExtensionDir` ignores the install root for `file://` sources —
`libs/host-runtime/src/loader.ts:491`), so the launchd unit's entrypoint is
`extensions/.../<member>/dist/index.js` in *this* repo. Reverting or rebuilding here changes
production immediately.

After reverting (or `reset --soft`-ing) anything that feeds a bundled artifact — including any
`libs/data/*` package a bundle inlines:

1. `npx nx build <project>` — restore artifact↔source parity.
2. Registry: see [registry is release-only](#registry-is-release-only) — a local rebuild does not
   touch `registry/index.json`.
3. Restart every service that loads it (`soxe service disable <id>` → `enable <id> --node-path=<stable node>`).
4. **Verify the live process adopted the new artifact** — compare the running server's reported
   artifact hash to the rebuilt file. Process liveness is not verification.

Diagnostic: when a service misbehaves after a revert, `rg` the reverted symbol in `dist/` BEFORE
debugging source. A non-zero count means you are debugging code the process is not running.

Incident **BUG-028** (2026-08-12): a reverted store-adapter change stayed live in
`memory-server/dist/` for ~2 h, poisoned `~/.memory/memory.db`, and took all recall down. Source
read clean the entire time; the reverted symbols appeared in `dist/index.js` 9 times.

---

## ⛔ AGENT CONSTRAINT — `nx build` HAS NO SAFE DRY-RUN

Governed by **BL-235**. Builds stage into `<outdir>.staging-<pid>` and swap into place on success
(`packages/sox-nx/src/executors/atomic-tsc/executor.ts`, `tools/bundle-extension.cjs`); a failed
build leaves the old `dist/` intact.

- **`--dry-run` does NOT protect you.** nx accepts the flag on a run-target and *silently ignores it* —
  `npx nx build ingest --dry-run` performs a real build. Verified 2026-07-09. There is no
  safe "just show me the error" build flag. To inspect a failure without risking the artifact, read the
  source, or compile to a scratch `outDir` directly.
- In a shared checkout with concurrent agents, treat every `dist/` as someone else's live artifact.

Registry: see [registry is release-only](#registry-is-release-only) — a local rebuild does not
touch `registry/index.json`.

**`nx test` is a build too — it carries the same hazard, from the other side (BL-456).** `nx.json`
sets `targetDefaults.test.dependsOn = ["^build"]`, so `npx nx test <project>` rebuilds every upstream
`dist/` from whatever source is on disk — **including another agent's uncommitted edits**. This is not
theoretical: an agent's isolated runs were green and its first full `nx test memory-server
--skip-nx-cache` went red on an assertion its packet had never touched, because a concurrent agent's
in-flight `write-queue.ts` was compiled into `memory-core/dist` by the test run itself. The reverse is
worse and silent — a suite can go **green** against code the running agent has never seen, and be
reported as verification.

So a suite result is evidence only when the tree state it ran against is stated with it:

```
node tools/check-suite-tree-state.mjs --project memory-server            # quote this with the result
node tools/check-suite-tree-state.mjs --project memory-server --require-clean   # gate, exit 1 if dirty
```

It reports `git status --porcelain` restricted to the project's transitive nx dependency set — dirt
elsewhere in the repo cannot reach that suite and is deliberately not reported. A dirty dependency set
does not make the run wrong; it makes it **unattributable**. Re-run in an isolated worktree (the
structural fix, already the dispatch default) or publish the dirt alongside the result.

---

## ⛔ AGENT CONSTRAINT — PUBLIC PACKAGES BUNDLE PRIVATE INTERNALS; LIVE OBJECTS CROSS VIA DI

Governed by [ADR-0006](./docs/decisions/0006-public-bundles-private-and-di-for-live-objects.md).

---

## ⛔ AGENT CONSTRAINT — PARALLEL AGENT DISPATCH SAFETY

When `pro` dispatches multiple agents in parallel, these rules prevent file conflicts:

1. **Disjoint file sets only**: `pro`'s `dispatch.json` `depends_on` must declare a dependency if two segments touch the same file. Segments with overlapping file sets are NEVER dispatched in parallel.
2. **Read-before-edit is enforced**: The Edit tool requires reading files first — stale reads are auto-detected. If an agent's read is stale, it will re-read and retry.
3. **Per-project test scope**: Agents run `nx test|lint <project>` for the project(s) they changed — NOT the full monorepo. This prevents test collision (two agents running the same test suite).
4. **No git worktree needed for well-partitioned work**: The `depends_on` tree + disjoint file sets is sufficient. Worktrees are reserved for destructive/experimental work (major refactors, force-rebuilds that dirty the tree).
5. **Pre-commit gate is serial**: The primary agent (or `pro` after all waves complete) runs `npx nx affected -t lint` across ALL changed projects before committing. This catches cross-project breakage.
6. **No stash, ever**: Already constrained above. Extends to ALL dispatched agents — if an agent needs to set work aside, it commits to a branch.

## ⛔ AGENT CONSTRAINT — DISPATCH PROTOCOL

Dispatched agents (`pro`, `implement`, `flash`) coordinate through `.opencode/artifacts/`:

| Artifact | Writer | Reader | Purpose |
|---|---|---|---|
| `dispatch.json` | `pro` | all | Decomposed plan: segments, agents, files, dependency tree |
| `reports/S{id}_{agent}_{ts}.json` | implement/flash | pro, dependents | Structured completion: changes, tests, handoff notes |
| `handoff/` | any | dependents | Cross-segment findings (interface changes, gotchas) |

Templates: `.opencode/artifacts/DISPATCH_TEMPLATE.json`, `.opencode/artifacts/REPORT_TEMPLATE.json`.

Agent prompts: `.opencode/agents/{pro,implement,flash}.md` and `.opencode/prompts/*-system.md`.

## ⛔ AGENT CONSTRAINT — LIVE SHIP VERIFICATION (MANDATORY)

**Every agent MUST read and follow [`CONTRIBUTING.md`](./CONTRIBUTING.md) before reporting any change as complete.**

This is a non-negotiable gate. The document defines:
- **§1 Universal Pre-Ship Checklist** — lint, build, test, impact analysis, commit hygiene, registry sync, backlog
- **§2 Type-Based Live Verification** — per-extension-type playbooks (mcp-server, service, agent, skill, command, hook, bundle, data lib, platform lib, CLI, host-runtime)
- **§3 Scope-Based Verification** — project/user/local/org, sandbox isolation
- **§4 Host-Based Verification** — claude/opencode/codex config formats and paths

Agents that skip live verification will produce code that may pass tests but fail at runtime.
The playbook ensures every change is confirmed working against the live system using in-session
tools — never scripts, never simulated results.

---

## Definition of Done

The bar for "the initial system is finished" is **[DOD.md](./DOD.md)**. Status: `[x]` done · `[~]` partial · `[ ]` not done.
Verify against real artifacts, not test output.

### A. Command surface — 12/12 done
### B. Authoring at scale — 4/4 done
### C. Foundational integrity — 7/7 done

**Summary: 23/23 done, 0 partial, 0 not done.**

See `CLAUDE.md` (pre-symlink) for full DoD breakdown with per-item evidence.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **sox-ecosystem**. Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/sox-ecosystem/context` | Codebase overview, check index freshness |
| `gitnexus://repo/sox-ecosystem/clusters` | All functional areas |
| `gitnexus://repo/sox-ecosystem/processes` | All execution flows |
| `gitnexus://repo/sox-ecosystem/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
