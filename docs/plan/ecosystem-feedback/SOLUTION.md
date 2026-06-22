# Ecosystem Feedback: Design Flaws and Solution

## Executive Summary

Five categories of framework and DX debt emerge from BL-1, BL-2, BL-4, BL-5, BL-6, BL-7,
and BL-15. The highest-impact item is BL-7: the `serve` command does a single-scope lockfile
lookup with a hardcoded default of `'project'` and no fallback cascade. A user who runs
`sox install memory-server --scope=user` then `sox serve memory-server` gets "extension not
found" because serve never looks in the user-scope lockfile. Every `.mcp.json` entry that
uses `sox serve` must carry an explicit `--scope=` flag to work, which eliminates the value
of default scope resolution everywhere else in the CLI. The root cause is that `cmdServe`
(`apps/sox/src/main.ts:3099–3210`) calls `getScopePaths(scope2, root2)` for one scope and
stops; no scope-cascade loop exists in this path.

The second category is typecheck hygiene: 9 latent TypeScript errors in tokenguard and
scripts files block `pnpm typecheck` from exiting 0. These are entirely mechanical: unused
variables, a missing `undefined` union in a type annotation, and missing `return` statements.
None require design decisions. They should be fixed in Phase 0.

The third category is build hygiene: `memory-server/tsconfig.json` uses `composite: true`
which enables incremental builds via `.tsbuildinfo`. A stale `.tsbuildinfo` causes `tsc` to
emit no files after a source change. Vitest resolves `@sox/memory-core` to
`libs/memory-core/dist/index.js` (a static file path alias), so tests run against whatever
is currently in `dist/`, not the live source. If `nx build` has not been run after a source
change, tests pass against the stale build. This is a documentation/process gap rather than
a code bug, but it has caused confusion when vitest green did not imply runtime correctness.

The fourth category is the ADR-0002 `@sox/mcp-runtime` consolidation: `memory-server` has
a hand-rolled newline-delimited JSON-RPC stdio loop (a `readline` interface at
`src/index.ts:548`) and a vendored `compilePolicyFromEnv` function (src/index.ts:113–145)
duplicating policy logic from `libs/host-runtime`. ADR-0002 decision 6 calls for collapsing
this into `@sox/mcp-runtime`, which already exists at `libs/mcp-runtime/src/serve.ts`. This
is the largest single refactor in this plan but is risk-bounded because the external contract
(7 `memory_*` tools, stdio JSON-RPC transport) does not change.

The fifth category is post-workspace-glob verification: BL-6 reports that the four other
memory bundle members (`memory-cli`, `memory-flush`, `memory-daemon`, `memory-organizer`)
were not explicitly verified after the workspace-glob widening that linked `@sox/memory-core`
into all members. Builds currently pass (nx cache shows success), but runtime verification
against a live install has not been documented.

---

## Design Flaw 1: Single-Scope `cmdServe` Lookup with Wrong Default (BL-7)

**What is broken:**  
`cmdServe` in `apps/sox/src/main.ts:3126`:
```typescript
const scope2 = flags['scope'] ?? 'project';
```
It then calls `getScopePaths(scope2, root2)` for that single scope and reads exactly one
lockfile. If the extension was installed at user scope, the project lockfile does not contain
it and the command exits with `extension not found`. There is no fallback loop.

The correct behavior — which `cmdStart`, `cmdStatus`, and `buildExtConfigEnv` already
implement — is to iterate `['org', 'user', 'project', 'local']` in precedence order (or
`['project', 'user', 'org']` for serve resolution, highest-proximity first) until the
extension is found. `buildExtConfigEnv` at line 46 already does this for config:
```typescript
for (const cs of ['org', 'user', 'project', 'local'] as const) { ... }
```
But the lockfile resolution immediately above it does not.

**Which BLs it explains:** BL-7 directly. It also explains why `--scope=user` must be
passed to `sox serve` in every `.mcp.json` entry for user-scoped installs, which is
a silent DX trap: the install step does not write the scope back anywhere, so the serve
step has no way to discover which scope was used.

**The correct design:**  
`cmdServe` must iterate scopes in resolution order when `--scope` is not explicitly
specified. The resolution order for extension lookup should be:
`project → user → org → local` (innermost scope wins, matching the principle that
project-specific installs take precedence). If `--scope` is explicitly given, use that
scope only (preserving current explicit-scope behavior).

Implementation sketch:
```typescript
const scope2 = flags['scope'];  // may be undefined
const root2 = flags['root'] ?? ROOT2;

const SERVE_SCOPE_ORDER = ['project', 'user', 'org', 'local'] as const;
const scopesToSearch = scope2 ? [scope2] : SERVE_SCOPE_ORDER;

let entry2: LockfileEntry | null = null;
let resolvedScope2: string | null = null;
let extDir2: string | null = null;

for (const sc of scopesToSearch) {
  try {
    const sp = getScopePaths(sc, root2);
    const lf = loadLockfile(sp.lockfile);
    const found = lf?.resolved?.[extId]
      ?? Object.entries(lf?.resolved ?? {}).find(([k]) => k.startsWith(extId + '@'))?.[1];
    if (found) {
      entry2 = found;
      resolvedScope2 = sc;
      extDir2 = resolveExtensionDir(found.source, root2);
      break;
    }
  } catch { /* scope path may not exist */ }
}

const localExt2 = extDir2 ? null : findLocalExtension(extId, root2);
if (!extDir2 && localExt2) extDir2 = pathMod2.dirname(localExt2);
```

Additionally, `buildExtConfigEnv` must be called with `resolvedScope2` to load config from
the correct scope (currently it always cascades all scopes, which is correct; no change
needed there).

**Why the current design drifted here:**  
`cmdServe` was added as a new command after `cmdStart` and `cmdExec`. The scope cascade
pattern was present in `buildExtConfigEnv` but was not replicated in the lockfile-lookup
path. The test surface for `cmdServe` did not include cross-scope resolution.

---

## Design Flaw 2: Typecheck Gate Not Blocking on Latent Errors (BL-1)

**What is broken:**  
`pnpm typecheck` exits 2 with 9 errors spread across four files:
- `extensions/services/tokenguard/src/cli.ts:23` — unused `readline` import (TS6133)
- `extensions/services/tokenguard/src/mapstore.ts:32` — unused `now` variable (TS6133)
- `extensions/services/tokenguard/src/proxy.ts:170` — unused `mapper`, `adapter` variables
  destructured from opts (TS6133)
- `extensions/services/tokenguard/src/proxy.ts:309` — `vs[0]` resolves to
  `string | undefined` (because `Object.entries` on `IncomingHttpHeaders` may produce
  `undefined` array slots), but `responseHeaders[k]` is typed `string | string[]`.
  The fix is `vs[0] ?? ''` or a non-null assertion with an existence guard.
- `extensions/services/tokenguard/vitest.config.ts:1` — TS1479: CommonJS module cannot
  `require()` an ESM `vitest/config`. Fix: change `import` to `await import(...)` or
  add `"type": "module"` to the tokenguard `package.json`.
- `scripts/check-registry-sync.ts:35,162` — two unused variables (TS6133)
- `scripts/new-extension.ts:82,281` — two functions missing a return statement in their
  switch (TS2366)

These are all mechanical and were latent before the current work.

**Why the current design drifted here:**  
The typecheck CI gate checks `tsconfig.base.json` (the project-wide composite root).
Tokenguard was built with its own isolated tsconfig that was not included in the composite
project references. Scripts were not covered. The errors accumulated silently.

---

## Design Flaw 3: Build Hygiene — Stale Dist Masking Test Results (BL-4)

**What is broken:**  
`memory-server/tsconfig.json` uses `composite: true` (line 6). A `tsc` run that detects
the `.tsbuildinfo` is current emits nothing, leaving `dist/` unchanged even after source
edits. `memory-server/vitest.config.ts:9` resolves `@sox/memory-core` to
`libs/memory-core/dist/index.js` — a static file path that is whatever was last emitted
by `nx build memory-core`. If `memory-core` source changed since the last build, vitest
tests load the stale compiled output.

The result: tests can be green while the runtime is broken. This was explicitly called
out in the CLAUDE.md ("Vitest can PASS while dist is stale").

**The correct design:**  
This is primarily a process/documentation issue. The cache-busting solution is:
1. Add a pre-test step that runs `tsc --build --force` (bypasses tsbuildinfo) or
   `nx build --skip-nx-cache memory-core` before running tests.
2. Document in the monorepo CONTRIBUTING guide that `nx build` must precede `nx test`.

No code change is strictly required, but adding a `prebuild` or `pretest` step to the
`memory-server` project.json that touches a sentinel file (forcing the tsbuildinfo to
mark outputs stale) would close the gap automatically.

---

## Design Flaw 4: Hand-Rolled MCP Loop and Vendored Policy Guard (BL-5)

**What is broken:**  
`memory-server/src/index.ts:548–562` implements a `readline`-based newline-delimited
JSON-RPC loop instead of using `@sox/mcp-runtime`. The file also vendors
`compilePolicyFromEnv` (lines 43–145, ~100 lines) which duplicates logic from
`libs/host-runtime/src/policy.ts`. This means any policy bug fix must be applied in
two places. The `@sox/mcp-runtime` library (`libs/mcp-runtime/src/serve.ts`) already
provides `serve()` and `defineTool()` which handle the transport, the protocol, and call
the host-runtime policy enforcement uniformly.

ADR-0002 decision 6 (docs/decisions/0002-extension-install-model.md:46–49) explicitly
calls for this refactor: "`memory-server`'s hand-rolled loop + vendored guard collapse
into it."

**The correct design:**  
Rewrite `memory-server/src/index.ts` to use `serve()` and `defineTool()` from
`@sox/mcp-runtime`. Each of the 7 handlers becomes a `defineTool(...)` call. The
`compilePolicyFromEnv` vendor block is deleted; enforcement is provided by the wrapper.

**Why the current design drifted here:**  
`memory-server` was implemented before `@sox/mcp-runtime` existed. The vendored guard
was added when C6 permission enforcement was required (enforced before the lib was
available). Now that the lib is present and the refactor was decided in ADR-0002, the
work is simply not done yet.

---

## Design Flaw 5: Post-Glob-Widening Bundle Members Not Verified (BL-6)

**What is broken:**  
After the workspace-glob widening that linked `@sox/memory-core` into all five bundle
members, only `memory-server` was explicitly verified end-to-end. `memory-cli`,
`memory-flush`, `memory-daemon`, and `memory-organizer` build green (nx cache shows
success for all four), but the following has not been verified:
- `memory-cli` can be invoked via `sox exec memory-cli -- init` and writes a valid DB.
- `memory-flush` fires on `SessionEnd` and writes to the DB.
- `memory-daemon` starts, binds its Unix socket, and drains the `organizer_queue`.
- `memory-organizer` is correctly identified as an internal library, not a bundle member.

**The correct design:**  
Write a verification checklist (or automated e2e test) that covers each member's primary
happy path post-install. `memory-organizer` should be removed from verification scope as
it is not a standalone extension (it is a library used by `memory-daemon`).

---

## Cross-References

- **Flaw 1 (serve scope) × Flaw 4 (mcp-runtime consolidation):** When memory-server is
  migrated to `@sox/mcp-runtime`, the `.mcp.json` command becomes
  `["sox", "serve", "memory-server"]`. If Flaw 1 is not fixed, this command only works
  for project-scoped installs. Fix Flaw 1 first.
- **Flaw 2 (typecheck) × Flaw 3 (build hygiene):** Both are hygiene issues. Fixing Flaw 2
  in Phase 0 unblocks clean CI. Flaw 3 is a process gap; documenting it is sufficient.

## Non-Goals

- Implementing the full ADR-0002 capability engine (file-drop, config-merge, host registry).
  That is a larger deliverable tracked in the extension install plan.
- Fixing memory subsystem recall quality (chunking, diversity, fusion weights). Those are
  in the memory-system plan.
- Adding `memory-organizer` to bundle members or changing its type. The current bundle
  extension.json correctly excludes it.
- Runtime permission guard fixes for memory-server (beyond documentation). C6 is complete.
