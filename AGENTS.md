# AGENTS.md — sox-ecosystem

> This file is the single source of truth for all agents (Claude Code, OpenCode, Codex).
> `CLAUDE.md` is a symlink to this file — edits here, both hosts see the same guidance.

## Routing

For codebase navigation, see [`docs/routing/ROUTER.md`](./docs/routing/ROUTER.md) (intent→scope mapping) and
[`docs/routing/INDEX.md`](./docs/routing/INDEX.md) (project listing). For `data/*` package guidance, see
[`libs/data/CLAUDE.md`](./libs/data/CLAUDE.md).

## Harvesting external skills into extensions

When asked to harvest an external repo/URL into a sox extension:

1. **Fetch the upstream content** (SKILL.md and any references/, assets/, scripts/ dirs).
2. **Scaffold** with `soxe init skill <id>` (adds extension.json, package.json, CHANGELOG.md, README.md, SKILL.md skeleton).
3. **Move to** `extensions/skills/<id>/`.
4. **Populate SKILL.md** with upstream content + YAML frontmatter with `source` and `source-version` fields.
5. **Write reference files** into `references/` (same structure as upstream).
6. **Update extension.json** `run_interface` with input/output schemas matching the skill's contract.
7. **Rebuild registry** with `npx nx run registry:sync-index` (auto-discovers new extensions, computes checksums).
8. **Upgrade consumers** with `node bin/soxe upgrade --all`.
9. **Commit** source changes AND regenerated `registry/index.json` together.

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

## ⛔ AGENT CONSTRAINT — GIT STAGING IS EXPLICIT-PATH ONLY

**Never run `git add -A`, `git add .`, or `git add --all`.**
Stage by explicit path: `git add <file> <file> …`. Never stage `.nx/`, `.DS_Store`, `dist/`, or `*.js`/`*.d.ts` in `src/`.

**Never run `git stash` (or `git stash pop/drop/clear`).** Commit to a branch instead.

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

## ⛔ AGENT SEQUENCE — when you change extension/lib code that ships a `dist` artifact

1. `npx nx lint <project>`
2. `npx nx build <project>`
3. `npx nx run registry:sync-index` — rebuilds + regenerates `registry/index.json` checksums
4. Commit source changes AND regenerated `registry/index.json` together
5. `node bin/soxe upgrade --all` — upgrade every consumer spanning all scopes

---

## ⛔ AGENT CONSTRAINT — NEVER MARK A BACKLOG ITEM RESOLVED WITHOUT A RED→GREEN TEST

Governed by **BL-225**. A status marker must record a *verified outcome*, never an intention.

Before writing `**RESOLVED**` on any `### BL-<n>` heading:

1. A regression test **naming the BL-ID** exists.
2. You have seen it **fail** with the fix disabled, and **pass** with it restored. Not "it would fail" — run it.
3. A test that *skips* the failing case does not count.

This rule exists because four separate items shipped as RESOLVED while still broken:

- **BL-88** added a schema column. Nothing read it. Its dependent BL-92 stayed live.
- **BL-95** fixed `cmdStatus`, left `cmdList` broken, and was marked done.
- **BL-115** shipped a working chunker that silently took two test suites to **zero** and hard-blocked the repo-wide smoke gate for two days (BL-231).
- **BL-167**'s suite carried `hasChannelSignal` guards that *skipped the assertion for exactly the case where the invariant broke* — a coverage audit would have seen a test named for the invariant and believed it.

Corollary: **the ~125 items already marked CLOSED have never been audited against this rule.** Do not treat a `RESOLVED` marker as evidence. Read the code.

Do not hand-maintain `BACKLOG.md`'s status header — it is derived from heading markers (BL-224). Regenerate it. Every marker must begin with a status word (`Open`, `REOPENED`, `BLOCKED`, `RESOLVED`, `CLOSED`, …); a `[TRIAGE]` prefix breaks the parser and silently drops the item from the count.

---

## ⛔ AGENT CONSTRAINT — A DIAGNOSTIC `nx build` IS A DESTRUCTIVE OPERATION

Governed by **BL-235**. Several `build` targets begin with `rm -rf .../dist`. They delete the existing
artifact **before** knowing the rebuild will succeed. If the source is currently non-compiling — because
of a real bug, or because another agent is mid-edit in a shared checkout — the working artifact is gone
and **cannot be restored except by a successful build**, which is precisely what is impossible.

This has happened twice, both times to agents running a build merely to *see* an error message. One of
them took the live memory MCP server down mid-session.

- Before `npx nx build <project>` on a project you did not just fix, know you may not get the old `dist/` back.
- **`--dry-run` does NOT protect you.** nx accepts the flag on a run-target and *silently ignores it* —
  `npx nx build ingest --dry-run` performs a real, destructive build. Verified 2026-07-09. There is no
  safe "just show me the error" build flag. To inspect a failure without risking the artifact, read the
  source, or compile to a scratch `outDir` directly.
- In a shared checkout with concurrent agents, treat every `dist/` as someone else's live artifact.

**After any rebuild of a `dist` artifact that ships in an extension, run `npx nx run registry:sync-index`** —
the rebuilt bundle's checksum will no longer match `registry/index.json`, and `smoke-test.mjs` fails with
`CHECKSUM MISMATCH`. Commit the regenerated `registry/index.json` alongside the source.

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

This project is indexed by GitNexus as **sox-ecosystem** (12973 symbols, 20034 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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
