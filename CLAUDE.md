# CLAUDE.md — sox-ecosystem

## ⛔ AGENT CONSTRAINT — bin/sox IS READ-ONLY

**Never write code to `bin/sox`.** It is a thin ESM shim that only loads the compiled
output from `dist/apps/sox/main.js`. All CLI logic lives in `apps/sox/src/main.ts`.

- **Edit CLI logic** → `apps/sox/src/main.ts`, then `npx nx build sox`
- **Edit the runtime** → `libs/host-runtime/src/`, then `npx nx build host-runtime`
- Changes to `bin/sox` are silently bypassed at runtime and will never take effect.

---

## ⛔ AGENT CONSTRAINT — GIT STAGING IS EXPLICIT-PATH ONLY

**Never run `git add -A`, `git add .`, or `git add --all`.** They sweep machine-local
state and build artifacts into commits (`.nx/`, `.DS_Store`, stray `dist`/compiled output
emitted into `src/`). The repo has been polluted this way before (478 `.nx/cache` files +
9 `.DS_Store` were tracked).

- **Stage by explicit path:** `git add <file> <file> …` — only the files your change touched.
- **Review before staging:** run `git status` and confirm every path is intended source.
- **Never stage** `.nx/`, `.DS_Store`, `dist/`, or any `*.js`/`*.d.ts` sitting next to a `.ts` source.

**Never run `git stash` (or `git stash pop/drop/clear`).** Stashed changes are invisible to
`git status`, silently dropped on conflict (`pop`), and trivially lost or forgotten across
sessions — a real hazard given how much uncommitted work this tree accumulates. To set work
aside, commit it to a branch (`git switch -c wip/<topic>` + an explicit-path commit), never stash.

---

## ⛔ AGENT CONSTRAINT — BUILD VIA NX TARGETS, NEVER BARE TOOLS

**Always build, test, lint, and typecheck through nx targets — never invoke `tsc`, `vitest`,
or `eslint` directly against a project.** A bare `tsc` with no `outDir` emits compiled
`.js`/`.d.ts` into `src/` (this is exactly how `libs/tokenguard-core/src/*.js` got created),
and bare runs bypass the project-graph dependency ordering and cache.

- **Build:** `npx nx build <project>` (or `npx nx run-many -t build`); for affected-only, `npx nx affected -t build`.
- **Test / lint / typecheck:** `npx nx test|lint|typecheck <project>` — the project's target wires the correct config + `outDir`.
- **Whole-repo gate:** `npx nx run-many -t build,lint,test` (the order C3 mandates).
- A bare `tsc`/`vitest` result is **not** authoritative — verify runtime behavior against `nx build` output (see BACKLOG BL-4).

---

A monorepo for an **LLM-extension ecosystem**: independently-versioned extensions of 8 types
(`agent`, `skill`, `mcp-server`, `service`, `prompt`, `hook`, `command`, `bundle`), installed across scopes
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
- [x] **A11 `exec`** — airtight: both `apps/sox` and `runtime-cli` route through the live supervisor's Unix exec socket; fresh spawn is a fallback for service-mode (no socket) only. execSocketPath race fixed (awaited in startRuntime). Socket routing verified in e2e (63/63).
- [x] **A12 flags** — both `--flag value` and `--flag=value` parse (parser fixed in `install-engine`).

### B. Authoring at scale
- [x] **B1** born-conformant `init` for all active types — `libs/authoring` core + `@sox/nx` generators (the `prompt` type is parked by design).
- [x] **B2** every type `init → build → validate → install` — born-conformance gate + lifecycle e2e green. "Run" splits by role:
  - [x] **run (process) — Role A:** code/service types spawn + execute (lifecycle e2e, 35/35).
  - [x] **placed + discoverable (declarative) — Role B:** content types placed at the host's discovery path for the correct scope; reality-check tops out at placed + valid at target (not host execution).
- [x] **B3** build graph scales — `nx affected` + cache; project-graph-aware build.
- [x] **B4** adding an extension never red-bars the tree — verified (audit `dod.6`).

### C. Foundational integrity
- [x] **C1** framework-owned build; hand-maintained `dist` mirrors retired.
- [x] **C2** registry checksums current + CI drift gate.
- [x] **C3** `build → validate --strict → typecheck → lint → test` blocking CI, correct order; pre-commit hook runs `nx affected --target=lint`.
- [x] **C4** reality-checking gates — universal: (1) `sox list` validates pid liveness via `process.kill(pid, 0)` before reporting RUNNING (stale `runtime.json` entries reported INACTIVE); (2) born-conformance gate verifies `dist/index.js` exists and passes `node --check` for code types; (3) lockfile + registry now checksum the declared `entrypoint` (built artifact) not `src/index.ts` — `fetchArtifact` in `install.ts` and `resolveChecksum` in `build-index.ts` both follow the same resolution order: `manifest.entrypoint` → `dist/index.js` → `prompt.md` → `extension.json`. Registry regenerated + lockfile refreshed.
- [x] **C5** memory MCP `write` + `recall` execute correctly (zero-LLM read) — recall bug fixed.
- [x] **C6** `permissions` enforced at runtime — HARD for spawned types (env-scrub + policy-env injection + in-process fs/socket allowlist at the resource sink) across all four extension entry points (supervisor `_spawn`, `runtime-cli` exec, `apps/sox` exec, in-proc adapters = SOFT declare+audit per `[dod.6]`); undeclared `db_path` denied at runtime with no file created. Reality-verified: real spawned `memory-server`, forbidden write denied + side-effect absent (e2e + independent probe). OS-kernel sandboxing is an explicit non-goal.
- [x] **C7** shared internal code reuse without reach-in — `libs/memory-core` extracted; cross-package `../dist` reach-ins eliminated and **enforced at lint time**: `@nx/enforce-module-boundaries` (static import/require) plus a `no-restricted-syntax` rule in `eslint.config.js` that also catches the dynamic/laundered form (`require(path.resolve(__dirname, '../x/dist/...'))`). NB: the prior "grep returns zero" was unreliable — that grep missed both a template-literal dynamic import and multi-segment paths; turning the lint rule on surfaced two real reach-ins it had missed (`install-engine`→`host-registry`, `apps/sox`→`authoring`). Both now route through the `@sox/*` scope + the build's `rewrite-paths` step (source clean, dist resolved); reach-in is now a hard lint error, not a hopeful grep.

**Summary: 23/23 done, 0 partial, 0 not done.** The nx self-hosting migration met the
DoD to its D5 scope (architect-verified: final audit exit 0, C7 lint-enforced (see note above), `nx build,lint` 13/13), and the
**C6 engagement is now complete** — runtime permission enforcement is delivered and reality-verified
across all four extension spawn paths (`audit_c6.py --phase final` exit 0; `nx run-many build,lint,test`
green; `host-runtime:test-e2e` 63/63 with the undeclared-write denial proven + zero orphans). **A11 is
now complete** — exec routing is airtight in both `apps/sox` and `runtime-cli` via Unix exec socket;
execSocketPath write race fixed; `sox exec --help` documents `--scope`; dead `getRegistrar()` export
deprecated; SOX_HOME redirect notice added; `manifest:test` Nx flakiness resolved by splitting into
independent `test` + `test-scripts` targets. **B2 "run" splits by role:** process types (Role A) are
spawned + supervised by sox; declarative/content types (Role B) are placed at the host's discovery path
for the correct scope. **C4 is now complete** — reality-gates are universal: pid liveness in `sox list`,
born-conformance gate checks `dist/index.js` syntax, lockfile + registry checksum the built entrypoint
artifact (`fetchArtifact` + `resolveChecksum` aligned). Work lives on branch `feat/nx-migration`
(committed; not merged to `main`).

**Next plan:** `runtime-productionization` — scoped at `.workflow/plans/runtime-productionization/SCOPE.md`.
Covers global service discovery, stale-state GC, concurrent-start safety, log management, worker
containment, SIGKILL escalation, signal contract enforcement, and a live monitoring surface. Architect
design required before implementation.

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
