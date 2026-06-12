# CLAUDE.md — sox-ecosystem

A monorepo for an **LLM-extension ecosystem**: independently-versioned extensions of 7 types
(`agent`, `skill`, `mcp-server`, `prompt`, `hook`, `command`, `bundle`), installed across scopes
(`org`/`user`/`project`/`local`) and run by a host runtime. CLI: `bin/sox`. Engine: `scripts/`.
Extensions: `extensions/`. Per-type contracts: `docs/guidelines/`. Current-state audit:
`docs/architecture-audit-v2.md`.

## Definition of Done

The bar for "the initial system is finished" is **[DOD.md](./DOD.md)**: rapidly add many extensions of
every type — each going `init → build → validate → install → run` with zero manual conformance work, on
a build that stays fast at scale — plus the full command surface working.

**Status** — `[x]` done & reality-verified · `[~]` partial · `[ ]` not done.
Verify against the OS / real artifacts, **not** test output (every prior "green" that skipped that lied).

### A. Command surface
- [x] **A1 `init`** — born-conformant for all active types via `libs/authoring` + `@sox/nx`/`sox init` (born-conformance + byte-identical parity gates green).
- [x] **A2 `validate`** — works; entrypoint-reachability enforced.
- [x] **A3 `search`** — works.
- [x] **A4 `install`** — works (resolves + lockfile).
- [x] **A5 `start`** — works; spawns + supervises.
- [x] **A6 `list` / `details`** — show RUNNING state + scope/pid/source.
- [x] **A7 `enable` / `disable`** — actually (de)activate the process (fixed this session).
- [x] **A8 `update`** — works (registry drift gate added).
- [x] **A9 `uninstall`** — stops + removes.
- [x] **A10 `stop`** — clean teardown, zero orphans (verified from clean slate).
- [~] **A11 `exec`** — now tries the running registrar first, falls back to a fresh spawn (improved, not airtight).
- [x] **A12 flags** — both `--flag value` and `--flag=value` parse (parser fixed in `install-engine`).

### B. Authoring at scale
- [x] **B1** born-conformant `init` for all active types — `libs/authoring` core + `@sox/nx` generators (the `prompt` type is parked by design).
- [x] **B2** every type `init → build → validate → install → run` — born-conformance gate + lifecycle e2e green.
- [x] **B3** build graph scales — `nx affected` + cache; project-graph-aware build.
- [x] **B4** adding an extension never red-bars the tree — verified (audit `dod.6`).

### C. Foundational integrity
- [x] **C1** framework-owned build; hand-maintained `dist` mirrors retired.
- [x] **C2** registry checksums current + CI drift gate.
- [x] **C3** `build → validate --strict → typecheck → test` blocking CI, correct order.
- [~] **C4** reality-checking gates — done for the lifecycle e2e; not yet universal.
- [x] **C5** memory MCP `write` + `recall` execute correctly (zero-LLM read) — recall bug fixed.
- [x] **C6** `permissions` enforced at runtime — HARD for spawned types (env-scrub + policy-env injection + in-process fs/socket allowlist at the resource sink) across all four extension entry points (supervisor `_spawn`, `runtime-cli` exec, `apps/sox` exec, in-proc adapters = SOFT declare+audit per `[dod.6]`); undeclared `db_path` denied at runtime with no file created. Reality-verified: real spawned `memory-server`, forbidden write denied + side-effect absent (e2e + independent probe). OS-kernel sandboxing is an explicit non-goal.
- [x] **C7** shared internal code reuse without reach-in — `libs/memory-core` extracted; cross-extension `../../../dist` reach-in eliminated (grep returns zero).

**Summary: 21/23 done, 2 partial (A11, C4), 0 not done.** The nx self-hosting migration met the
DoD to its D5 scope (architect-verified: final audit exit 0, C7 zero, `nx build,lint` 13/13), and the
**C6 engagement is now complete** — runtime permission enforcement is delivered and reality-verified
across all four extension spawn paths (`audit_c6.py --phase final` exit 0; `nx run-many build,lint,test`
green; `host-runtime:test-e2e` 35/35 with the undeclared-write denial proven + zero orphans). The C6
work also fixed two latent migration defects the prior audit missed (duplicate `scripts/host/` runtime;
deleted-`runtime-cli` regression) and closed four distinct unenforced spawn points. The two remaining
partials are acknowledged scope: **A11** (`exec` routing not airtight) and **C4** (reality-gates not yet
universal). Work lives on branch `feat/nx-migration` (committed; not merged to `main`).

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **sox-ecosystem** (2977 symbols, 4689 relationships, 111 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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
