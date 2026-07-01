# AGENTS.md — sox-ecosystem

> This file is the single source of truth for all agents (Claude Code, OpenCode, Codex).
> `CLAUDE.md` is a symlink to this file — edits here, both hosts see the same guidance.

## Routing

For codebase navigation, see [`docs/routing/ROUTER.md`](./docs/routing/ROUTER.md) (intent→scope mapping) and
[`docs/routing/INDEX.md`](./docs/routing/INDEX.md) (project listing). For `data/*` package guidance, see
[`libs/data/CLAUDE.md`](./libs/data/CLAUDE.md).

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
node scripts/smoke-test.mjs --extension memory-daemon
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
- `npx nx build <project>` / `npx nx test <project>` / `npx nx lint <project>`
- Whole-repo gate: `npx nx run-many -t build,lint,test`

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
