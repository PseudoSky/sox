# mcp-path-guard — Resource-Sink fs Denial in the Spawned Child

> **Slug is identity.** `mcp-path-guard` is immutable. Ordering comes from
> `dag.json`.

**Phase:** enforcement · **Depends on:** `process-boundary` · **Guard:** `nx run memory-server:test`

---

## Goal

Deliver the **actual HARD fs denial** for the canonical spawned type. After
`process-boundary`, the spawned `memory-server` receives **[def:policy-env]**
describing its declared allowlist (`~/.memory/**`). But the server still opens
ANY caller-supplied `db_path` at the **[def:resource-sink]**
(`handleToolCall` → `getDb(dbPath)` → `openDb` at
`extensions/mcp-servers/memory-server/src/index.ts:155` / `src/db.ts:30`) — this
is the unbounded vector the audit flags (NEW-4: "a caller can pass any filesystem
path as `db_path`"). This state inserts a policy guard BEFORE the sink so a
`db_path` outside the declared allowlist is **denied at runtime** — the tool
returns an `isError` permission-denied result and no file is created.

This is the state that makes `[dod.2]` (the REQUIRED negative check) true against
reality: a real spawned process, a forbidden path, an observed denial + no side
effect.

---

## Semantic Distillation

- **Primitive:** MODIFY `extensions/mcp-servers/memory-server/src/index.ts` —
  guard `db_path` against the env-injected policy before `getDb`.

- **Reference Pattern:** `handleToolCall` (`index.ts:149`) reads `db_path` then
  calls `getDb(dbPath)` → `openDb(dbPath)` (`db.ts:30`, which `mkdirSync`s and
  opens). The declared allowlist arrives as **[def:policy-env]** in
  `process.env` (injected by `process-boundary`). Cite **[ref:guard-before-sink]**
  and **[ref:deny-by-default]**.

- **Delta Spec:**
  - At server startup, build a Policy from the env:
    `compilePolicyFromEnv(process.env)` (from `@adhd/sox-host-runtime` /
    `libs/host-runtime` — import the published lib symbol). Cache it.
  - In `handleToolCall`, BEFORE `getDb(dbPath)`: if `policy.enforced` and NOT
    `policy.allowsFsWrite(resolvedDbPath)` (and/or `allowsFsRead` for read-only
    tools), return a permission-denied result
    `{ isError: true, content: [{ type: 'text', text: 'permission denied: db_path <p> outside declared fs allowlist' }] }`
    and DO NOT call `getDb`/`openDb`. Resolve `~/`/relative to absolute before
    matching ([ref:guard-before-sink]).
  - When `policy.enforced === false` (run standalone, no host, no SOX_PERM_ENFORCE
    — legacy/dev), preserve today's behaviour exactly: open any path
    ([def:enforcement-opt-in], [inv:no-regress]). This keeps the existing
    direct-invocation tests green.
  - Importing `compilePolicyFromEnv` from the host-runtime lib makes
    memory-server depend on the lib at the policy boundary only; ensure the
    import path resolves in the built `dist` (the lib publishes
    `compilePolicyFromEnv`). If a runtime cross-package import is undesirable,
    vendor a minimal `compilePolicyFromEnv` equivalent — but it MUST match the
    [shape:policy-env] contract from `policy-core` (the round-trip
    `[policy-core.4]` guarantees parity). Document the choice in the commit.

- **Invariants:** [inv:reality] (the negative check attempts a real forbidden
  access), [inv:no-regress] (standalone/dev path unchanged), [inv:schema-stable]
  (do not change the manifest), [ref:guard-before-sink], [ref:deny-by-default].

- **Validation:** `nx run memory-server:test` — a new
  `permission-guard.spec.ts` asserts: allowed path opens; forbidden path returns
  `isError` and `openDb` is NOT reached and no file is created. (The full
  cross-process reality check is the FINAL audit `[audit-final.negative-*]`; this
  guard proves the unit-level denial.)

---

## Acceptance criteria

Checked by `audit-enforcement`.

- [ ] **[mcp-path-guard.1]** With `SOX_PERM_ENFORCE=1` and
      `SOX_PERM_FS_WRITE=["~/.memory/**"]`, a `memory_write` with
      `db_path` outside the allowlist returns `isError: true` and does NOT create
      the file. (vitest assertion against `handleToolCall` with a tmp evil path;
      assert the path does not exist afterward.)
- [ ] **[mcp-path-guard.2]** With the same env, a `memory_write` with `db_path`
      INSIDE the allowlist succeeds (no isError; the store is created/opened).
      (vitest assertion.)
- [ ] **[mcp-path-guard.3]** The guard runs BEFORE the sink: `getDb`/`openDb` is
      not invoked on a denied path. [ref:guard-before-sink] (vitest: spy/observe
      that no DB file appears and no open occurs — assert via filesystem absence
      and, if feasible, a no-call assertion.)
- [ ] **[mcp-path-guard.4]** Legacy/dev compat: with NO `SOX_PERM_ENFORCE`, any
      `db_path` opens as before — existing memory-server tests stay green.
      [inv:no-regress] `nx run memory-server:test`.
- [ ] **[mcp-path-guard.5]** `compilePolicyFromEnv` is sourced consistently with
      `policy-core` ([shape:policy-env]); the resolved policy denies `/tmp/...`
      and allows `~/.memory/...`. (vitest assertion.)

---

## Reservations

```text
read_only:  ["libs/host-runtime/src/policy.ts",
             "extensions/mcp-servers/memory-server/src/db.ts",
             "extensions/mcp-servers/memory-server/extension.json"]
mutates:    ["extensions/mcp-servers/memory-server/src/index.ts",
             "extensions/mcp-servers/memory-server/src/permission-guard.spec.ts"]
```

---

## Contract Promise

- **Added:** a startup `policy` (from `compilePolicyFromEnv`) + a pre-sink guard
  in `handleToolCall`; `permission-guard.spec.ts`.
- **Modified:** `extensions/mcp-servers/memory-server/src/index.ts` —
  `handleToolCall` gains the policy guard before `getDb`. The effective behaviour
  of `handleToolCall` changes (it can now deny) — declared in `dag.json`
  `changes.resigns`.
- **Deleted:** none.

---

## Commit points

- [ ] **After the guard + tests pass** — commit:
      `feat(c6): mcp-path-guard — deny undeclared db_path before openDb`
- [ ] **After the state guard passes** (mandatory) — commit source + runtime
      updates: `feat(c6): mcp-path-guard complete — guard green`

---

## Notes for executor

- The `db_path` is a caller-supplied TOOL ARGUMENT (see `extension.json` tools —
  every tool requires `db_path`), NOT the config-schema `db_path`. The audit's
  unbounded-vector finding is specifically about this argument. Guard the
  argument path.
- Resolve before matching: `expandTilde` + `path.resolve` the `db_path` to an
  absolute path, then ask the policy. A relative `../../etc/x` that escapes the
  allowlist must be denied — resolve first ([ref:guard-before-sink]).
- `openDb` does `mkdirSync(dir, {recursive:true})` THEN opens — so a denied call
  that reaches the sink would CREATE a directory as a side effect. The guard MUST
  precede the sink so `[mcp-path-guard.1]`/`.3` (no file/dir created) hold.
- This state depends on `process-boundary` because the policy arrives via
  **[def:policy-env]**; the unit tests here SET that env directly so they don't
  require a live supervisor — the cross-process integration is verified in
  `audit-final` ([inv:reality]).
- Budget: 1 session.
