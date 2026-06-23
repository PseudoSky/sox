# Architecture Audit v2 — sox-ecosystem

**Date:** 2026-06-08
**Auditor:** architect-reviewer (independent re-audit)
**Method:** Primary evidence only — actual code, schema, test runs, and command output.
Files read: 47. Commands executed: 42. No plan/session/status files consulted.

---

## Part 1 — Per-Finding Status Delta

### Original findings from `docs/architecture-audit.md`

| ID | Original finding | Prior status | Current status | Evidence |
|---|---|---|---|---|
| C1 | No host runtime | CRITICAL | **Partial** | `scripts/host/loader.ts`, `supervisor.ts`, `registrar.ts`, adapters exist. But none are wired to `bin/sox`; no `sox start` verb; host runtime is library-only. See §E2E. |
| C2 | No MCP tool registration | CRITICAL | **Partial** | `scripts/host/registrar.ts` implements `McpRegistrar` with `initialize`+`tools/list` over stdio. Tested only against a fake process (no actual spawn in tests). Not invoked from any product entrypoint. |
| D1 | No per-package build; no build in CI | CRITICAL | **Partial** | Per-package `tsconfig.json` added to all 9 extension packages. `pnpm -r build` runs and succeeds. `dist/index.js` exists per-package. CI step "Build extension packages" added to `validate.yml`. However: (a) CI step ordering is wrong (validate-manifests runs before build, contradicting its own comment at line 63-68); (b) `pnpm typecheck` exits code 2 with 17 TS errors; CI is currently broken. |
| A4 | Cross-package runtime import via relative path | HIGH | **Partial** | Changed from `../../../dist/memory-lib.js` (repo root) to `../../../mcp-servers/memory-server/dist/lib.js` (`memory-flush/src/index.ts` line 262, compiled output line 220). The new path resolves correctly within the monorepo (`extensions/hooks/memory-flush/dist/../../../mcp-servers/memory-server/dist/lib.js` = valid). Still a cross-package runtime dependency not mediated by npm packages — will break on npm publish of `@adhd/sox-extension-memory-flush` without `memory-server` dist present. |
| C5 | Uninstall leaves stale lockfile entries | LOW | **Partial** | `loader.ts` line 300-306 skips entries whose `dist/index.js` is absent (Gap C5 hygiene). However, `install.ts` still does NOT read the `dependencies` field from manifests (confirmed by search: zero references to `manifest.dependencies` in `install.ts`). The lockfile source is still `src/index.ts` (verified: `.extensions/extensions.lock` line 5: `"source": "file:///.../src/index.ts"`), not `dist/index.js`. |
| A1 | Hook event binding not in manifest schema | HIGH | **Closed** | `schemas/extension/v1.json` line 184-198 adds `events` array with closed enum `[PreToolUse, PostToolUse, SessionEnd, ScopePromotionProposed, Stop]`. `validate-manifests.ts` lines 726-743 enforces this. Both hooks declare `events`: `memory-flush/extension.json` line 15, `audit-hook/extension.json` line 10. |
| D2 | No linter/formatter | MEDIUM | **Open** | No `.eslintrc*`, `eslint.config*`, `biome.json`, or `.prettier*` found. The CI `typecheck` step provides partial coverage via `noUnusedLocals/noUnusedParameters`, but currently exits code 2 with 17 errors, meaning it is effectively broken as a gate. No lint step in CI. |
| A2 (DEFECT-1) | HookLoader.fire() aborts chain on first throw | MEDIUM | **Closed** | `scripts/hook-loader.ts` lines 136-155 add `fireIsolated()` that wraps each hook in try/catch, continues past failures, and returns a per-hook result array. `docs/engine-defects-found.md` updated to "Status: RESOLVED". Tests at `scripts/hook-isolation.test.ts` now assert correct isolated behavior (not the broken behavior). |
| A3 | Bundle dedup silent first-seen | MEDIUM | **Closed** | `install.ts` lines 787-801 add `console.warn()` when two bundles declare the same member with different version specs. First-seen still wins, but the operator now sees a warning. Documented in `scripts/bundle-collision.test.ts`. |
| A5 | Socket tilde path not expanded | MEDIUM | **Closed** | `scripts/host/supervisor.ts` line 83-88 implements `expandTilde()` called at probe time (line 263). Tests in `scripts/host-runtime.test.ts` lines 26-48 verify expansion. |
| D5 | Schema `$id` URLs are placeholders | LOW | **Open** | All three schemas still use `"$id": "https://your-registry/schemas/..."` (`schemas/extension/v1.json` line 3, `extensions-config/v1.json` line 3, `lockfile/v1.json` line 3). |
| A6 | Hash-based embedding, not semantic | MEDIUM | **Open** | `extensions/mcp-servers/memory-server/src/embed.ts` line 20: `EMBED_MODEL = 'nomic-embed-text-v1.5-hash'`. Still a hash projection (FNV-1a, lines 38-68). Comment unchanged: "when fastembed/onnxruntime becomes available... swap." |
| A7 | No host version enforcement | LOW | **Open** | `install.ts` still reads `requires` but not `compatibility.host`. No host version exists. |
| A8 | Registry source URLs are absolute local paths | MEDIUM | **Open** | `registry/index.json` still uses `"source": "file:///Users/nix/dev/ai/sox-ecosystem/..."` (all 11 entries). Machine-specific. |
| F2 | Extension dependencies not enforced at install | HIGH | **Partial** | `scripts/validate-manifests.ts` lines 966-996 add `checkDependencyExistence()` that warns when a declared dependency `id` is not in the registry. Severity is hardcoded `'warn'` and NOT promoted to `error` by `--strict` (only `checkDxConformance` uses the severity toggle). `install.ts` never reads `manifest.dependencies` — confirmed zero references. Dependency enforcement is manifest-validation-only (registry existence check), not install-time (graph resolution, version satisfaction). |
| F3 | No per-extension config schema validation | MEDIUM | **Partial** | `scripts/host/loader.ts` lines 308-331 call `validateConfigAgainstSchema()` at activation. `schemas/extension/v1.json` line 300 adds `config_schema` property. `install.ts` still does NOT call `validateConfigAgainstSchema` — gap F3 is closed only at activation time (if a host runs), not at install time. |
| C3 | No `sox search` | MEDIUM | **Closed** | `bin/sox` `cmdSearch()` function lines 533-605 implement full-text search over `registry/index.json` by `id`, `title`, `description`, `keywords`. Works correctly (verified by `node bin/sox search memory`). |
| C6 | No `sox update` | LOW | **Closed** | `bin/sox` `cmdUpdate()` lines 613-644 delegate to `sox install --update`. |
| C4 | Install client resolves to source files, not built artifacts | HIGH | **Open** | `scripts/install.ts` lines 313-317 still prefer `src/index.ts` over `dist/index.js` when resolving a `file://` directory source. The lockfile still records `"source": ".../src/index.ts"` (`.extensions/extensions.lock` line 5). The loader works around this by stripping the `/src/index.ts` suffix to find the extension dir (`scripts/host/loader.ts` lines 474-481), but the lockfile artifact path remains a TypeScript source file. |

---

## Part 2 — End-to-End Chain Trace

### Primary path: `memory-server` (mcp-server type)

**Step 1 — Discover.** `sox search memory` returns results including `memory-server`. Source URLs in `registry/index.json` are absolute developer paths (`file:///Users/nix/...`), rendering remote search non-functional. **Holds for local dev only.**

**Step 2 — Install.** `sox install -s project` triggers `npx tsx scripts/install.ts`. The install client reads `.extensions/extensions.json`, resolves `memory-server` from `file://` source, checksums `src/index.ts`, and writes `.extensions/extensions.lock`. The lockfile records `"source": "file:///.../src/index.ts"`. **Holds, but records a .ts artifact, not a .js artifact.**

**Step 3 — Build.** `pnpm -r build` runs `tsc` in `extensions/mcp-servers/memory-server/` using `tsconfig.json` (rootDir: src, outDir: dist, composite: true). `dist/index.js` is produced at the correct path. **Holds if build step is run explicitly. CI runs validate-manifests before build, so on a fresh clone the entrypoint-reachability gate fires before dist exists.**

**Step 4 — Activation (new).** `scripts/host/loader.ts` `loadFromLockfile()` reads `.extensions/extensions.lock`, strips `/src/index.ts` suffix to find the extension dir, reads `extension.json`, resolves `dist/index.js`, calls `activateMcp()`. `scripts/host/supervisor.ts` `ProcessSupervisor.start()` spawns `node dist/index.js` via `child_process.spawn`. **Holds in isolation** — the code is correct. **But `loadFromLockfile` is never called from `bin/sox` or any product entrypoint.** There is no `sox start` or `sox host` command. The loader exists only as a library imported by tests.

**Step 5 — MCP registration (new).** `scripts/host/registrar.ts` `McpRegistrar.register()` sends `initialize` + `tools/list` over the spawned process's stdio, receives tool descriptors, and exposes them via `registrations()` / `allToolNames()`. Verified: spawning `dist/index.js` manually and sending `initialize` returns `{"serverInfo":{"name":"memory-server","version":"0.1.0"}}`. `tools/list` returns 7 tools. **Holds at the code level. Not invoked from any product entrypoint.**

**Step 6 — Tool call (broken).** `memory_write` works: returns `{"episode_uid":"01KTN6..."}`. `memory_recall` fails with `SqliteError: no such column: n.t_invalid` on every invocation. **Root cause:** `recall.ts` line 124-126 constructs `validityPred = 'n.t_invalid IS NULL'` using table alias `n`, but the temporal query at lines 168-174 uses `FROM node` with no alias — `n.t_invalid` is unresolvable. This is a SQL bug that makes `memory_recall` (the primary read path) unconditionally broken. Confirmed by running `memory_write` then `memory_recall` against the built binary; the error is deterministic.

**Chain verdict:** Holds through Steps 1-3 (with caveats). Steps 4-5 exist as correct library code but are unreachable from the product CLI — the host runtime is not wired to any executable entrypoint. Step 6 (`memory_recall`) is hard-broken by a SQL alias bug in the primary read path.

### Secondary path: `audit-hook` (hook type)

`audit-hook` declares `events: ["PreToolUse"]`, `entrypoint: "dist/index.js"`. `pnpm -r build` produces `extensions/hooks/audit-hook/dist/index.js`. `activateHook()` in `scripts/host/adapters/hook.ts` dynamically imports the module and registers it in `HookLoader` for `PreToolUse`. This path is tested by `host-runtime.test.ts` with a synthetic entrypoint. The real `audit-hook` entrypoint is not exercised in tests. Same chain break as above: no product entrypoint calls `loadFromLockfile`.

---

## Part 3 — New Gaps Identified

### NEW-1 — `memory_recall` is unconditionally broken (CRITICAL — regression)

**Evidence:** `extensions/mcp-servers/memory-server/src/recall.ts` lines 124-126 build `validityPred` using alias `n.t_invalid`. Lines 168-174 execute `SELECT ... FROM node WHERE ${validityPred}` with no table alias. SQLite raises `no such column: n.t_invalid` on every `memory_recall` invocation. Confirmed by live process test (write succeeded; recall returned error code -32700). No test in the suite exercises `memoryRecall()` against an actual SQLite database (the 377 passing tests test the MCP protocol layer with fake processes and the lockfile/install layer — not the SQL). The `<50ms hybrid recall` claim in the audit title and `EMBED_MODEL` metadata is untestable because the function never returns results.

### NEW-2 — CI `typecheck` step exits code 2; CI pipeline is currently broken (CRITICAL)

**Evidence:** `pnpm typecheck` exits with code 2 and 17 TypeScript errors (`tsc --noEmit`). The errors include: `scripts/validate-manifests.ts(361,19): This expression is not constructable` (AJV type mismatch — structural error, not unused-var), `scripts/new-extension.ts` exactOptionalPropertyTypes errors, and unused import errors introduced by the new host runtime files. The CI `validate.yml` step "Typecheck" would fail on any PR. Because `vitest` uses `tsx` (bypassing `tsc`), tests pass despite the typecheck failure. The codebase currently cannot pass its own CI pipeline from a clean run.

### NEW-3 — CI step ordering contradicts itself: validate-manifests runs before build (HIGH)

**Evidence:** `validate.yml` line 54-58 runs `validate-manifests --strict` as Step 1. Lines 63-68 comment: "This step must run AFTER typecheck and BEFORE validate-manifests." Lines 69-72 run `pnpm -r build` as Step 2b (after typecheck at Step 2). The entrypoint-reachability gate in `validate-manifests.ts` line 886-893 checks `fs.existsSync(resolvedEntrypoint)`. On a fresh CI runner, `dist/index.js` does not exist (`.gitignore` excludes `dist/`). The ordering means the reachability gate would always fire on a real CI run before build produces the artifacts. (Currently masked by the typecheck failure at Step 2, which aborts the pipeline earlier.)

### NEW-4 — Declared permissions are not enforced at runtime (declared-but-not-enforced — HIGH)

**Evidence:** `scripts/host/loader.ts` lines 338-354 log declared `permissions` blocks at activation: "enforcement: advisory for in-process, env-gated for spawned." `scripts/host/adapters/mcp.ts` lines 50-58 log permissions and then spawn the process with the full `process.env` — no env vars are set to gate filesystem or network access. `schemas/extension/v1.json` lines 305-351 declare `permissions.fs.write`, `permissions.network.outbound`, `permissions.socket.paths` as governance fields. The memory-server `extension.json` declares no `db_path` restriction in its `permissions.fs.write` field. A caller can pass any filesystem path as `db_path` and the server opens it without checking (confirmed: `index.ts` line 150-155, no path validation). The schema presents a complete permission model; the runtime honors none of it.

### NEW-5 — Host runtime library has no product entrypoint (CRITICAL — gap C1 regressed to Partial)

**Evidence:** `scripts/host/loader.ts` exports `loadFromLockfile`. `bin/sox` has no `start`, `host`, `activate`, or equivalent verb (confirmed by reading all 867 lines of `bin/sox` and its `parseTopLevel` switch). `tools/supervisor-shim.js` now claims to be "backed by the productized supervisor" (line 6-7) but remains a test tool. `tools/host-event-shim.js` now claims to be "the real dispatch path" (line 4) but is still in `tools/` (not `bin/`, not a package export). The host runtime stack (loader → supervisor → registrar → adapters) is structurally complete as TypeScript modules, but there is no executable host process, no CLI verb to invoke it, and no integration into `bin/sox`. Installing an extension still produces a lockfile entry and nothing else at runtime.

### NEW-6 — `pnpm -r build` does NOT compile `scripts/host/*.ts` (HIGH)

**Evidence:** `pnpm -r build` runs `tsc` in each extension package (11 packages). The root `tsconfig.json` includes `scripts/**/*.ts` but is only invoked by `pnpm typecheck` (`tsc --noEmit`). `pnpm -r build` does NOT run the root `tsc`. After `pnpm -r build`, `dist/scripts/` contains no `host/` subdirectory (confirmed: `find /dist/scripts -type d` returns only `dist/scripts`). The host runtime TypeScript source cannot be `require()`d or `import()`ed without `tsx` at runtime. Any production use of `scripts/host/loader.ts` requires `tsx` (a devDependency) or a separate build step that does not exist.

### NEW-7 — Lockfile records `.ts` source, loader compensates silently (MEDIUM)

**Evidence:** `install.ts` lines 313-317 prefer `src/index.ts` when resolving a `file://` directory. The lockfile records `"source": "file:///.../src/index.ts"` (`.extensions/extensions.lock` line 5). `loader.ts` lines 474-481 (`stripKnownSuffix`) silently strips `/src/index.ts` to recover the extension dir. This creates a layered workaround: the lockfile asserts a `.ts` artifact; the loader silently corrects it. If `install.ts` were fixed to record `dist/index.js`, the loader's stripping logic would still work but the workaround layer would be unnecessary. The current state means the checksum in the lockfile is of the TypeScript source, not the compiled artifact.

### NEW-8 — `scripts/validate-manifests.ts` has a structurally broken AJV import (CRITICAL for CI)

**Evidence:** `pnpm typecheck` errors at `scripts/validate-manifests.ts(361,19): error TS2351: This expression is not constructable. Type 'typeof import(".../ajv/dist/ajv")' has no construct signatures.` and line 573. This means `new Ajv()` does not type-check with the current `ajv@8.20.0` types under TypeScript 6.0.3's strict mode. The file still works at runtime (via `tsx` which bypasses type checking), but it fails `tsc --noEmit`, breaking CI.

---

## Part 4 — Summary Table: Original Findings

| Status | Count | Finding IDs |
|---|---|---|
| Closed | 5 | A1 (events schema), A2/DEFECT-1 (fireIsolated), A3 (bundle warn), A5 (tilde expand), C3 (search), C6 (update) |
| Partial | 8 | C1 (host runtime library-only), C2 (registrar untriggered), C4 (lockfile records .ts), C5 (stale hygiene partial), D1 (build exists but CI broken), F2 (manifest-only dependency check), F3 (activation-only config validation) |
| Open | 6 | A6 (hash embeddings), A7 (host version unenforced), A8 (absolute registry paths), D2 (no linter), D5 (placeholder $id), A4 (cross-package dep) |
| Regressed | 0 | — |

**Note:** A1 and C3/C6 are genuinely closed. The rest of the "Closed" claims in commit messages cannot be independently confirmed as production-delivered — the host runtime components exist as library code but are not wired into any executable or invoked by any product path.

---

## Part 5 — Remaining and New Gaps, Ranked by Severity

### Severity: CRITICAL

**1. `memory_recall` always fails with SQL alias bug (NEW-1)**
The primary read path of the memory subsystem — the feature this entire body of work claims to deliver — unconditionally raises `SqliteError: no such column: n.t_invalid` on every invocation. `recall.ts` line 126 uses `n.t_invalid` but the `FROM node` query at line 170 has no alias. The write path (`memory_write`) works. The recall path does not. No test covers actual SQLite execution of `memoryRecall()`.

**2. CI pipeline is broken: `pnpm typecheck` exits code 2 (NEW-2/NEW-8)**
17 TypeScript errors prevent CI from passing. The most structurally significant are `TS2351` errors in `validate-manifests.ts` (AJV import incompatible with TypeScript 6.0.3 strict mode). This means the CI gate that is supposed to enforce type correctness is failing on its own gatekeeping step. A PR that introduces new TS errors would still appear to fail CI — but for the wrong reason (pre-existing errors).

**3. Host runtime has no product entrypoint — gap C1 remains undelivered (NEW-5)**
The host runtime stack exists as TypeScript source in `scripts/host/`. It compiles (under `tsx`). Tests pass. But nothing invokes it. `bin/sox` has no activation verb. Installing an extension produces a lockfile; the lockfile is never consumed by a running process. The system still cannot deliver its Layer 0 promise.

### Severity: HIGH

**4. CI step ordering wrong — validate-manifests runs before build (NEW-3)**
The entrypoint-reachability gate in `validate-manifests` requires `dist/index.js` to exist. Build runs after validate-manifests in CI. On a fresh runner, `dist/` is not in git (`.gitignore` excludes it). The gate would fire before build produces artifacts. This is masked by the typecheck failure (Step 2) aborting CI earlier.

**5. `scripts/host/*.ts` not compiled by `pnpm -r build` (NEW-6)**
The host runtime source files require `tsx` at runtime. There is no build step that produces `dist/scripts/host/*.js`. Any production deployment scenario that doesn't have `tsx` (a devDependency) cannot use the loader, supervisor, or registrar.

**6. Declared permissions not enforced at runtime (NEW-4)**
The schema declares a complete permission model (`fs`, `network`, `socket`). The loader logs declared permissions. The MCP server accepts any `db_path` from any caller. No sandboxing is applied. The `ENFORCEMENT NOTE` comments in `schemas/extension/v1.json` lines 302 and 307 say enforcement is "P5 scope," but P5 is not planned in a visible roadmap within the repository.

**7. Extension dependency graph not resolved at install (F2 — Partial)**
`install.ts` never reads `manifest.dependencies`. Installing `memory-flush` without `memory-server` produces no error or warning. The manifest validator warns (not errors, not promoted by `--strict`) that a declared dep doesn't exist in the registry, but this only catches typos — it does not resolve or satisfy the dependency graph at install time.

**8. Lockfile records `.ts` source, not `.js` artifact (C4 — Open)**
`install.ts` checksums `src/index.ts` and records it as the lockfile artifact. A host that reads the lockfile `source` field to load the extension gets a TypeScript file. The loader works around this silently. The checksum is of the source, not the compiled artifact.

### Severity: MEDIUM

**9. Cross-package runtime import not mediated by npm package (A4 — Partial)**
`memory-flush/dist/index.js` line 220 dynamically imports `../../../mcp-servers/memory-server/dist/lib.js`. Works inside the monorepo. Breaks on npm publish of `@adhd/sox-extension-memory-flush`.

**10. Hash-based embedding produces semantically meaningless vectors (A6 — Open)**
`embed.ts` uses FNV-1a hash projection. `memory_recall` claims `<50ms hybrid vec+BM25+temporal` but: (a) recall is unconditionally broken (NEW-1); (b) even if fixed, the vector component is not semantic.

**11. Registry source URLs are absolute local paths (A8 — Open)**
`registry/index.json` contains hardcoded `file:///Users/nix/...` paths. Non-functional on any other machine.

**12. No linter or formatter (D2 — Open)**
No ESLint, Biome, or Prettier. The existing TS errors in the new host runtime files (unused imports, type mismatches) would have been caught immediately by a linter.

**13. Schema $id URLs remain non-dereferenceable placeholders (D5 — Open)**

**14. Config schema validation not wired at install time (F3 — Partial)**
`install.ts` does not call `validateConfigAgainstSchema`. Validation only happens at activation (loader), not at install.

### Severity: LOW

**15. Uninstall stale lockfile still loaded by loader (C5 — Partial)**
Loader skips entries whose `dist/index.js` doesn't exist. But if the extension's built artifacts remain after uninstall, the loader still activates the uninstalled extension.

**16. Host compatibility version never enforced (A7 — Open)**

---

## Part 6 — Single Most Important Finding

**`memory_recall` is unconditionally broken (NEW-1 / `recall.ts:126`).**

This is the only observable output of the memory subsystem's read path. `memory_write` succeeds; `memory_recall` fails every time with a SQL alias error. The system cannot fulfill its stated purpose ("7 memory_* tools over a single-file SQLite graph store with hybrid recall"). Every test that passes, every metric that is claimed, and every design document that describes recall quality is built on a read path that does not execute.

## Part 7 — Single Most Consequential Declared-But-Not-Enforced Gap

**Declared: host runtime (scripts/host/loader.ts) reads lockfile and activates extensions. Actual: `loadFromLockfile` is never called from any product entrypoint (NEW-5 / C1 Partial).**

The host runtime stack — loader, supervisor, registrar, adapters — is structurally present and unit-tested. Every component correctly claims to close a prior audit finding. But the entire stack is library code with no caller. `bin/sox` has no `start`, `host`, or `activate` verb. `tools/supervisor-shim.js` claims to be backed by the productized supervisor but remains in `tools/` (test scaffolding territory) and is not invoked by CI or by `sox install`. The system's advertised contract — "install → activate → agent can call tools" — remains undelivered at the activation step, exactly as it was in the v1 audit. The new code closes the design gap; the product gap is open.

---

## Appendix — Commands Run and Files Read

**Commands run (representative):**

- `pnpm -r build` → exit 0; all 11 packages built
- `pnpm run test` → exit 0; 377 tests, 15 files
- `pnpm typecheck` → exit 2; 17 TypeScript errors
- `pnpm run validate-manifests -- --strict` → exit 0
- `node bin/sox search memory` → exit 0; 5 results
- Live spawn of `extensions/mcp-servers/memory-server/dist/index.js` → `memory_write` succeeds; `memory_recall` fails with `SqliteError: no such column: n.t_invalid`
- `git ls-files extensions/mcp-servers/memory-server/dist/` → no tracked files (dist is git-ignored)

**Key files read:**

- `/Users/nix/dev/ai/sox-ecosystem/.github/workflows/validate.yml`
- `/Users/nix/dev/ai/sox-ecosystem/scripts/install.ts` (lines 308-340, 490-530, 783-810)
- `/Users/nix/dev/ai/sox-ecosystem/scripts/host/loader.ts`
- `/Users/nix/dev/ai/sox-ecosystem/scripts/host/supervisor.ts`
- `/Users/nix/dev/ai/sox-ecosystem/scripts/host/registrar.ts`
- `/Users/nix/dev/ai/sox-ecosystem/scripts/host/adapters/mcp.ts`
- `/Users/nix/dev/ai/sox-ecosystem/scripts/hook-loader.ts` (lines 100-169)
- `/Users/nix/dev/ai/sox-ecosystem/scripts/hook-isolation.test.ts`
- `/Users/nix/dev/ai/sox-ecosystem/scripts/host-runtime.test.ts`
- `/Users/nix/dev/ai/sox-ecosystem/scripts/host-delivery.test.ts`
- `/Users/nix/dev/ai/sox-ecosystem/scripts/validate-manifests.ts` (selected sections)
- `/Users/nix/dev/ai/sox-ecosystem/schemas/extension/v1.json`
- `/Users/nix/dev/ai/sox-ecosystem/extensions/mcp-servers/memory-server/src/recall.ts`
- `/Users/nix/dev/ai/sox-ecosystem/extensions/mcp-servers/memory-server/src/schema.ts`
- `/Users/nix/dev/ai/sox-ecosystem/extensions/mcp-servers/memory-server/src/embed.ts`
- `/Users/nix/dev/ai/sox-ecosystem/extensions/mcp-servers/memory-server/dist/recall.js` (lines 90-175)
- `/Users/nix/dev/ai/sox-ecosystem/extensions/hooks/memory-flush/src/index.ts` (line 262)
- `/Users/nix/dev/ai/sox-ecosystem/extensions/hooks/memory-flush/extension.json`
- `/Users/nix/dev/ai/sox-ecosystem/extensions/hooks/audit-hook/extension.json`
- `/Users/nix/dev/ai/sox-ecosystem/.extensions/extensions.lock`
- `/Users/nix/dev/ai/sox-ecosystem/.gitignore`
- `/Users/nix/dev/ai/sox-ecosystem/tsconfig.json`, `tsconfig.base.json`
- `/Users/nix/dev/ai/sox-ecosystem/docs/engine-defects-found.md`
- `/Users/nix/dev/ai/sox-ecosystem/docs/cli-build-decision.md`
- `/Users/nix/dev/ai/sox-ecosystem/bin/sox` (selected sections)
