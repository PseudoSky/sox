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
- [ ] **A1 `init`** — runs, but output is **non-conformant** (no `tsconfig`, missing `tools`/self-description, no `keywords`/`author`) → won't build/validate.
- [x] **A2 `validate`** — works; entrypoint-reachability enforced.
- [x] **A3 `search`** — works.
- [x] **A4 `install`** — works (resolves + lockfile).
- [x] **A5 `start`** — works; spawns + supervises.
- [x] **A6 `list` / `details`** — show RUNNING state + scope/pid/source.
- [x] **A7 `enable` / `disable`** — actually (de)activate the process (fixed this session).
- [x] **A8 `update`** — works (registry drift gate added).
- [x] **A9 `uninstall`** — stops + removes.
- [x] **A10 `stop`** — clean teardown, zero orphans (verified from clean slate).
- [~] **A11 `exec`** — works, but spawns a fresh session instead of using the running server.
- [ ] **A12 flags** — `--flag=value` works; **`--flag value` (the `--help` form) mis-parses**.

### B. Authoring at scale
- [ ] **B1** born-conformant `init` for all 7 types — scaffolder drifts from build/validate contracts.
- [ ] **B2** every type `init → build → validate → install → run` repeatably — only partially proven; scaffold breaks it.
- [ ] **B3** build graph scales (incremental/cached) — plain `tsc` per package, no cache (only `memory-cli` is composite).
- [ ] **B4** adding an extension never red-bars the tree — a fresh scaffold currently **fails** repo-wide validate.

### C. Foundational integrity
- [x] **C1** framework-owned build; hand-maintained `dist` mirrors retired.
- [x] **C2** registry checksums current + CI drift gate.
- [x] **C3** `build → validate --strict → typecheck → test` blocking CI, correct order.
- [~] **C4** reality-checking gates — done for the lifecycle e2e; not yet universal.
- [x] **C5** memory MCP `write` + `recall` execute correctly (zero-LLM read) — recall bug fixed.
- [ ] **C6** `permissions` enforced at runtime — declared + validated only; no runtime sandbox.
- [ ] **C7** shared internal code reuse without duplication or reach-in — no shared-library primitive; cross-extension `../../../dist` reach-in exists today.

**Summary: 13/23 done, 2 partial, 8 not done.** Not finished. The critical blockers for your
"rapidly add many extensions" goal are **B1–B4** (born-conformant scaffolding + scaled build) and
**A1/A12** (init conformance, flag parsing). All changes this session are uncommitted, pending review.

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
