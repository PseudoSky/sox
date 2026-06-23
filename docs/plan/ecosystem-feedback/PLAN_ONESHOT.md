# Ecosystem Feedback: Implementation Plan

Items: BL-1, BL-2 (ecosystem aspect), BL-4, BL-5, BL-6, BL-7, BL-15 (ecosystem aspect)

---

## Phase 0 — Non-Blocking Quick Fixes (Parallelizable, Zero Risk)

These items are entirely mechanical. No architectural dependencies. Can be parallelized
across agents.

---

### P0-A: Fix all 9 typecheck errors (BL-1)

**Files to change:**

- `extensions/services/tokenguard/src/cli.ts`
- `extensions/services/tokenguard/src/mapstore.ts`
- `extensions/services/tokenguard/src/proxy.ts`
- `extensions/services/tokenguard/vitest.config.ts`
- `scripts/check-registry-sync.ts`
- `scripts/new-extension.ts`

**Fixes, one per error:**

**1. `tokenguard/src/cli.ts:23` — unused `readline` import (TS6133)**  
Remove the `import readline from 'node:readline';` line if readline is not used, or
prefix the import alias with `_` if it must be retained for side effects.

**2. `tokenguard/src/mapstore.ts:32` — unused `now` variable (TS6133)**  
Remove `const now = ...` or rename to `_now` if the intent is to silence the warning
while preserving the side effect (unlikely; it's a timestamp).

**3. `tokenguard/src/proxy.ts:170` — unused `mapper`, `adapter` (TS6133)**  
The destructure `const { config, mapper, adapter, storePath, auditPath } = opts;` at
line 170 includes `mapper` and `adapter` which are not used in the function body.
Remove them from the destructure: `const { config, storePath, auditPath } = opts;`

**4. `tokenguard/src/proxy.ts:309` — TS2322 `string | string[] | undefined` (BL-1)**  
Line 309: `responseHeaders[k] = vs.length === 1 ? vs[0] : vs;`  
`Object.entries(upstream.headers)` where `upstream.headers` is `IncomingHttpHeaders`
produces values of type `string | string[] | undefined`. When `vs` is an array of 1
element, `vs[0]` is `string | undefined`, not `string`.  
Fix:

```typescript
responseHeaders[k] = vs.length === 1 ? (vs[0] ?? '') : vs;
```

Or add a type guard:

```typescript
if (vs.length === 1) {
  responseHeaders[k] = vs[0] as string;
} else {
  responseHeaders[k] = vs;
}
```

**5. `tokenguard/vitest.config.ts:1` — TS1479 ESM/CJS mismatch**  
Change to dynamic import or add `"type": "module"` to
`extensions/services/tokenguard/package.json`. The cleanest fix for this repo's CommonJS
convention is to rename `vitest.config.ts` to `vitest.config.mts` (ESM module file
extension) so TypeScript treats it as ESM without changing the package.json.

**6. `scripts/check-registry-sync.ts:35` — unused `tmpRoot` (TS6133)**  
Remove or rename to `_tmpRoot`.

**7. `scripts/check-registry-sync.ts:162` — unused `liveJson` (TS6133)**  
Remove or rename to `_liveJson`.

**8. `scripts/new-extension.ts:82` — missing return statement (TS2366)**  
`function makeContentFile(...)` has a `switch (type)` block. If the switch has a
`default:` case it must return a `string`. Add a `default: return '';` (or throw an
error for exhaustive checking).

**9. `scripts/new-extension.ts:281` — missing return statement (TS2366)**  
Same pattern for `function makeReadme(...)`. Add a `default: return '';`.

**Verification:**  
`pnpm typecheck` exits 0 with no errors.

---

### P0-B: Document build hygiene — stale dist warning (BL-4)

**Files to change:**

- `CLAUDE.md` (already has a note; add to the project-level instructions)
- `libs/memory-core/README.md` or the `memory-server` project README if it exists

**Fix:**  
Add a note to `CLAUDE.md` (project root) under a "Testing" or "Build" section:

```markdown
## Build vs. test hygiene

`memory-server` and `memory-core` use `composite: true` in their `tsconfig.json`.
A bare `tsc` after a source change may emit nothing if `.tsbuildinfo` thinks outputs are
current. Vitest resolves `@adhd/sox-memory-core` to `libs/memory-core/dist/index.js` — a
static alias. Tests pass against stale `dist/` if `nx build` was not run first.

**Always run `npx nx build memory-core && npx nx build memory-server` before running
memory tests.** Never use `pnpm tsc` or bare `tsc` as a build step; use `npx nx build`.
```

**Verification:**  
The note is visible in the project-level CLAUDE.md. No code change is required.

---

### P0-C: Verify bundle member builds post-glob-widening (BL-6)

**Files to change:** None (verification task, not a code change).

**Actions:**  

1. Clear nx cache for all four members: `npx nx reset` (or delete `.nx/cache`).
2. Run `npx nx build memory-daemon memory-cli memory-flush` with `--skip-nx-cache`.
3. Verify `dist/index.js` exists and `node --check dist/index.js` passes for each.
4. Run a smoke test for `memory-cli`: `node extensions/bundles/sox-memory-bundle/members/memory-cli/dist/index.js` with no args should print help.
5. Run `npx nx test memory-cli memory-flush memory-daemon` if unit tests exist.
6. Document results in a brief comment added to each member's `project.json` under a
   `"description"` field.

**Verification:**  
All four members build clean from source (not cache). `node --check dist/index.js` exits
0 for all four.

---

## Phase 1 — Scope Cascade for `cmdServe` (BL-7)

This is the highest-impact DX fix. It depends only on the existing `getScopePaths` and
`loadLockfile` functions being correct (which they are). Phase 0 is not a prerequisite,
but should be completed first for clean CI.

---

### P1-A: Implement scope-cascade resolution in `cmdServe` (BL-7)

**Files to change:**

- `apps/sox/src/main.ts` (function `cmdServe`, lines 3099–3210)

**Fix:**  
Replace the single-scope lookup at lines 3126–3150 with a cascade loop. The resolution
order should match the "proximity" principle already used elsewhere in the CLI: innermost
scope (project) wins over outer scopes (user → org).

```typescript
async function cmdServe(flags: Record<string, string>): Promise<void> {
  // ... (help block unchanged) ...

  const extId = flags['_0'] ?? flags['id'] ?? argv[1];
  if (!extId) {
    process.stderr.write(`${CLI} serve: extension id required\n`);
    process.stderr.write(`Usage: ${CLI} serve <ext-id> [--scope=<scope>]\n`);
    process.exit(1);
  }

  const ROOT2 = process.cwd();
  const explicitScope = flags['scope'];           // undefined if not provided
  const root2 = flags['root'] ?? ROOT2;

  const fsMod2 = require('node:fs') as typeof import('node:fs');
  const pathMod2 = require('node:path') as typeof import('node:path');

  // Resolution order: project → user → org → local (innermost wins).
  // If --scope is explicit, search only that scope.
  const SERVE_SCOPE_ORDER = ['project', 'user', 'org', 'local'] as const;
  const scopesToSearch = explicitScope ? [explicitScope] : SERVE_SCOPE_ORDER;

  let entry2: { source: string } | null = null;
  let resolvedScope2: string | null = null;
  let extDir2: string | null = null;

  for (const sc of scopesToSearch) {
    let sp: { lockfile: string; config: string };
    try {
      sp = getScopePaths(sc, root2);
    } catch {
      continue;   // scope path may not exist (e.g. no org scope configured)
    }
    const lf = loadLockfile(sp.lockfile);
    const found = lf?.resolved?.[extId]
      ?? Object.entries(lf?.resolved ?? {}).find(([k]) => k.startsWith(extId + '@'))?.[1];
    if (found) {
      entry2 = found;
      resolvedScope2 = sc;
      extDir2 = resolveExtensionDir(found.source, root2);
      break;
    }
  }

  const localExt2 = extDir2 ? null : findLocalExtension(extId, root2);
  if (!extDir2 && localExt2) {
    extDir2 = pathMod2.dirname(localExt2);
    resolvedScope2 = 'local';
  }

  if (!extDir2) {
    const searched = scopesToSearch.join(', ');
    process.stderr.write(`${CLI} serve: extension '${extId}' not found in lockfile (searched scopes: ${searched}) or local extensions\n`);
    process.exit(1);
  }

  // ... (rest of function unchanged: manifest load, env build, execFileSync) ...
}
```

Note: `buildExtConfigEnv(extId, root2)` already cascades all scopes for config resolution;
no change is needed there. The scope cascade here is purely for locating the extension
directory.

**Verification:**  

- `sox install memory-server --scope=user` then `sox serve memory-server` (no --scope) resolves the user-scoped entry.
- `sox install memory-server --scope=project` then `sox serve memory-server` resolves the project-scoped entry.
- If installed at both scopes, project-scoped entry wins.
- `sox serve memory-server --scope=user` with project-scoped-only install fails with a clear error naming the searched scope.
- Existing e2e tests (`host-runtime:test-e2e`) still pass (63/63).

---

### P1-B: Update `cmdServe` help text and serve default scope (BL-7)

**Files to change:**

- `apps/sox/src/main.ts` (the `--help` block inside `cmdServe`, lines 3101–3114)

**Fix:**  
Update the help block to reflect the cascade behavior:

```
Flags:
  --scope=<scope>   Restrict lookup to one scope (default: cascade project→user→org→local)
  --root=<dir>      Workspace root (default: cwd)
  --help            Show this message
```

Also update the main `helpText` function (around line 247) to match.

**Verification:**  
`sox serve --help` shows the updated cascade description.

---

## Phase 2 — `@adhd/sox-mcp-runtime` Consolidation (BL-5)

This is the largest single refactor. It depends on Phase 1 (scope cascade) being stable,
because `sox serve memory-server` is the intended `.mcp.json` command after refactor and
must work cross-scope first.

---

### P2-A: Migrate `memory-server` to `@adhd/sox-mcp-runtime` (BL-5)

**Files to change:**

- `extensions/bundles/sox-memory-bundle/members/memory-server/src/index.ts`
- `extensions/bundles/sox-memory-bundle/members/memory-server/package.json`
  (add `@adhd/sox-mcp-runtime` to dependencies)

**Fix approach:**  

1. Add `@adhd/sox-mcp-runtime` to `package.json` dependencies.
2. Import `{ serve, defineTool }` from `@adhd/sox-mcp-runtime`.
3. Convert each of the 7 handlers to `defineTool(...)` calls:

   ```typescript
   const memoryWriteTool = defineTool({
     name: 'memory_write',
     description: '...',
     inputSchema: { ... },  // matches current extension.json inputSchema
     handler: async (args, ctx) => {
       checkDbPathCtx(args.db_path, ctx);  // ctx carries the policy
       const db = getDb(args.db_path);
       return memoryWriteHandler(db, args);
     }
   });
   ```

4. Delete the `compilePolicyFromEnv` vendor block (lines 43–145) and the `readline`
   loop (lines 548–562).
5. Replace the process entry point with:

   ```typescript
   serve({ tools: [memoryWriteTool, memoryRecallTool, ...], serverInfo: { name: 'memory-server', version: '0.1.0' } });
   ```

The `checkDbPathCtx` function must be adapted to use the `ctx` (tool context from
`@adhd/sox-mcp-runtime`) rather than reading `process.env` directly. The mcp-runtime
enforce.ts already provides `checkFsAccess(path)` which reads from the policy-env.

**Verification:**  

- All 7 `memory_*` tools respond correctly to MCP tool calls.
- The vendored `compilePolicyFromEnv` is gone from `src/index.ts`.
- The `readline` loop is gone from `src/index.ts`.
- Permission guard still denies `db_path` outside `~/.memory/**` (C6 regression test).
- `npx nx build memory-server` exits 0.
- `host-runtime:test-e2e` still passes (63/63).

---

## BL Assignment Summary

| BL   | Phase  | Task |
|------|--------|------|
| BL-1 | P0-A   | Fix 9 typecheck errors (tokenguard + scripts) |
| BL-2 | Memory plan P0-D | (naming drift — ecosystem aspect: none beyond documentation) |
| BL-4 | P0-B   | Document build hygiene for stale dist |
| BL-5 | P2-A   | Migrate memory-server to @adhd/sox-mcp-runtime |
| BL-6 | P0-C   | Verify all bundle members build post-glob-widening |
| BL-7 | P1-A, P1-B | Scope cascade in cmdServe |
| BL-15| Memory plan P0-C | (db_path documentation — covered in memory-system plan) |
