# Shared context — C6 Runtime Permission Enforcement

> **Single source of truth for definitions.** Every work-state context references
> entries here by name instead of restating them. Change a definition once, here.

---

## Glossary

Reference as **[def:term]** from any context file.

- **[def:permissions-block]** — the declared permission contract on an
  extension manifest. Type `ManifestPermissions` in
  `libs/manifest/src/index.ts:73` (`fs.read[]`, `fs.write[]`,
  `network.outbound[]`, `socket.paths[]`). Mirrored at runtime as
  `PermissionsBlock` in `libs/host-runtime/src/supervisor.ts:30`. Glob/path
  patterns use `~/` for home-relative (schema v1 §permissions).
- **[def:policy]** — a compiled, queryable form of a [def:permissions-block]:
  an object that answers `allowsFsRead(path)`, `allowsFsWrite(path)`,
  `allowsSocket(path)`, `allowsNetwork(host)` → boolean. Produced by
  `compilePolicy(permissions)` in the new `policy` module. Empty/absent
  permission domain ⇒ **deny-by-default for that domain when a policy is being
  enforced** (an extension that declares no `fs` gets no fs access under
  enforcement; an extension with NO `permissions` block at all is
  unconstrained — legacy behaviour preserved, see [def:enforcement-opt-in]).
- **[def:enforcement-opt-in]** — enforcement applies only when a manifest
  declares a `permissions` block. A manifest with NO `permissions` is
  unconstrained (legacy compat, preserves [inv:no-regress]). Within a declared
  block, each domain (`fs`/`network`/`socket`) that is PRESENT is enforced
  deny-by-default; a domain that is ABSENT from a present block is unconstrained
  for that domain. This rule is the single contract every enforcement state
  obeys.
- **[def:policy-env]** — the canonical environment variables the supervisor
  injects into a spawned child so the child can self-enforce its [def:policy]:
  `SOX_PERM_FS_READ`, `SOX_PERM_FS_WRITE`, `SOX_PERM_SOCKET`,
  `SOX_PERM_NETWORK` (each a JSON array of patterns), and `SOX_PERM_ENFORCE=1`.
  Absent `SOX_PERM_ENFORCE` ⇒ no enforcement (legacy). See [shape:policy-env].
- **[def:resource-sink]** — the exact line where a spawned extension turns a
  caller-supplied path into an OS resource. For `memory-server` this is
  `openDb(dbPath)` (`extensions/mcp-servers/memory-server/src/db.ts:30`), called
  via `getDb(dbPath)` from `handleToolCall` (`.../src/index.ts:155`). The
  in-process fs guard MUST run BEFORE the sink.
- **[def:spawned-types]** — extension types activated by spawning a child OS
  process (`mcp-server` background lifecycle; and `command`/`hook` declaring
  `runtime: shell`/`python` if/when spawned). These get **HARD** enforcement at
  the process boundary + the resource sink. The supervisor `_spawn`
  (`libs/host-runtime/src/supervisor.ts:162`) is the single spawn point.
- **[def:inproc-types]** — extension types activated by in-process dynamic
  `import()` (`agent`, `skill`, and `command`/`hook` loaded in-process), plus
  declarative `prompt`. These get **SOFT** enforcement: declaration + an
  activation-time [def:policy] attached to the handle + an audit log of access
  decisions. No OS isolation (a `[dod.6]` non-goal). Adapters:
  `libs/host-runtime/src/adapters/{agent,hook,command}.ts`.
- **[def:session-fixes]** — prior fixes that MUST be carried forward unchanged
  (see [inv:carry-fixes]): `fireIsolated` (DEFECT-1, hook isolation),
  enable-reactivation (supervisor restart on unexpected exit),
  stop-via-supervisor (SIGTERM path in `stop()`), `expandTilde` (Gap A5),
  `resolveExtensionDir` no-stat resolution.
- **[def:audit-runner]** — `scripts/audit_c6.py` in this plan dir. A
  phase-scoped checklist runner (`--phase foundation|enforcement|final`); each
  `--phase` runs its checks plus all prior phases; exits with the failure count.
  Read-only — fixes happen in source, never by weakening a check.

---

## Cross-cutting invariants

Contracts every state must preserve. A state's context lists only its
*additional* invariants and references these by ID.

- **[inv:reality]** Acceptance is verified against reality — a real spawned
  process and a real filesystem/socket observation — never a self-reported log
  or record. The C6 negative check attempts a forbidden access and observes BOTH
  the denial AND the absence of the side effect (no file created at the
  undeclared path). Check: `audit_c6.py --phase final` spawns the real built
  `memory-server` binary and inspects the filesystem.
- **[inv:no-regress]** No state may red-bar anything currently green. Baseline
  captured at plan time: `nx run-many -t test` (vitest across projects) is green
  and the lifecycle e2e (`nx run host-runtime:test-e2e`) passes. Check: the
  enforcement and final audits re-run the suite and the e2e; any new failure is
  a blocking gap, fixed in source.
- **[inv:carry-fixes]** All [def:session-fixes] remain intact. Check: their
  guarding tests (hook-isolation, host-runtime supervisor tests) stay green;
  enforcement code is ADDED around the spawn/import seams, never by rewriting the
  restart/stop/isolation logic.
- **[inv:dev-time-nx]** No state adds an nx runtime import to shipped host or
  extension code. nx appears only in `project.json` targets and dev tooling.
- **[inv:per-type]** Enforcement level is type-dependent ([dod.3]). HARD for
  [def:spawned-types], SOFT (declaration+audit) for [def:inproc-types]. No state
  may claim OS isolation for an in-process/declarative type.
- **[inv:schema-stable]** `libs/manifest` (`ManifestPermissions` and the
  schema `permissions` block) is a READ-ONLY input. No state edits the manifest
  permission shape. Enforcement reads the declaration; it does not redefine it.

---

## Shared fixtures and sample data

- **[fix:allowed-db]** — a `db_path` INSIDE the memory-server declared allowlist
  (`~/.memory/**`), e.g. `~/.memory/c6-allowed.db`. Used by the positive check
  `[audit-final.positive-fs]`. The test creates/cleans `~/.memory/` as needed.
- **[fix:evil-db]** — a `db_path` OUTSIDE the declared allowlist, e.g.
  `/tmp/sox-c6-evil.db`. Used by the negative checks
  `[audit-final.negative-fs]` / `[audit-final.negative-no-file]`. The test
  asserts the call is denied AND `/tmp/sox-c6-evil.db` does NOT exist afterward.
- **[fix:memory-ext]** — the real built extension
  `extensions/mcp-servers/memory-server/dist/index.js` plus its
  `extension.json` (which already declares `permissions.fs.{read,write}:
  ["~/.memory/**"]` and `socket.paths: ["~/.memory/memoryd.sock"]`). This is the
  canonical spawned-type subject under test. Build it with
  `nx run memory-server:build` (or `pnpm -r build`) before the final audit.

---

## Type and config shapes

```text
[shape:policy]
  interface Policy {
    enforced: boolean;                 // true only when a permissions block was declared
    allowsFsRead(absPath: string): boolean;
    allowsFsWrite(absPath: string): boolean;
    allowsSocket(absPath: string): boolean;
    allowsNetwork(hostOrUrl: string): boolean;
    // serialization for the spawned-child contract:
    toEnv(): Record<string,string>;    // → [shape:policy-env]
  }
  function compilePolicy(perms: PermissionsBlock | undefined): Policy
  // perms === undefined  ⇒ enforced=false, every allows*() returns true (legacy compat)
  // perms domain present ⇒ deny-by-default within that domain ([def:enforcement-opt-in])
  // glob matching: '~/' expanded via expandTilde; '**' matches across path segments

[shape:policy-env]
  SOX_PERM_ENFORCE = "1"                            // presence enables child self-enforcement
  SOX_PERM_FS_READ  = '["~/.memory/**"]'            // JSON array (may be "[]")
  SOX_PERM_FS_WRITE = '["~/.memory/**"]'
  SOX_PERM_SOCKET   = '["~/.memory/memoryd.sock"]'
  SOX_PERM_NETWORK  = '[]'
  // The spawned child reads these once at startup, rebuilds a Policy via
  // compilePolicyFromEnv(process.env), and self-enforces at each [def:resource-sink].

[ref:deny-by-default]
  Anchor: compilePolicy in libs/host-runtime/src/policy.ts (NEW — discovered_via manual).
  Rule: when a permissions DOMAIN is declared (present in the block), any path/host
  NOT matched by a declared pattern in that domain returns false from the
  corresponding allows*() method. Absent domain (or absent block) returns true.
  Every enforcement decision in the codebase routes through a Policy method — no
  ad-hoc string compares against permission arrays outside policy.ts.

[ref:guard-before-sink]
  Anchor: handleToolCall → getDb → openDb in extensions/mcp-servers/memory-server
  (src/index.ts:149 / src/db.ts:30) (discovered_via manual).
  Rule: every code path that opens/creates an OS resource from a caller-supplied
  path first calls the Policy guard and returns a denial (isError result, no
  side effect) when the policy denies — the guard precedes the sink, never after.
```
