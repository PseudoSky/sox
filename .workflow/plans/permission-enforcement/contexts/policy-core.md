# policy-core — Permission Policy Compiler

> **Slug is identity.** `policy-core` is immutable. Ordering comes from
> `dag.json` (`depends_on`), not this name.

**Phase:** foundation · **Depends on:** (none — branches off `feat/nx-migration`) · **Guard:** `nx run host-runtime:test`

---

## Goal

Create the single module that turns a declared **[def:permissions-block]** into a
queryable **[def:policy]**. Today permissions are only *recorded* (logged at
activation in `loader.ts:256` and the adapters) — there is no object that can
answer "is this path/host/socket allowed?". Every later enforcement state
(`process-boundary`, `inproc-policy`, `mcp-path-guard`) routes its decisions
through this one module, so it must exist first and be correct in isolation.

This state adds NO callers and changes NO behaviour yet — it is pure foundation:
a new `policy.ts` lib module plus its unit tests. It exists at the root of the
graph because every enforcement decision in the plan is defined as "ask the
Policy" ([ref:deny-by-default]); centralizing the matching logic here is what
keeps enforcement consistent across the process boundary and the resource sink.

---

## Semantic Distillation

- **Primitive:** CREATE `libs/host-runtime/src/policy.ts` — the policy compiler
  and matcher.

- **Reference Pattern:** `[def:permissions-block]` (`PermissionsBlock` in
  `libs/host-runtime/src/supervisor.ts:30`; source-of-truth shape
  `ManifestPermissions` in `libs/manifest/src/index.ts:73`). `expandTilde`
  already exists in `supervisor.ts:58` — reuse it for `~/` expansion
  ([inv:carry-fixes]). Cite **[ref:deny-by-default]**.

- **Delta Spec:** Implement per **[shape:policy]**:
  - `export function compilePolicy(perms: PermissionsBlock | undefined): Policy`.
  - `export function compilePolicyFromEnv(env: Record<string,string|undefined>): Policy`
    — rebuilds a Policy from **[shape:policy-env]** (used by the spawned child in
    `mcp-path-guard`). Returns an unenforced policy when `SOX_PERM_ENFORCE` is
    absent.
  - `Policy.toEnv(): Record<string,string>` — serializes to **[shape:policy-env]**
    (used by `process-boundary`).
  - Matching: paths are compared as absolute (expand `~/` via `expandTilde`,
    resolve to absolute); `**` matches across `/` segments, `*` within a
    segment. Implement glob matching with a small, dependency-free matcher (a
    regex built from the pattern) — do NOT add a runtime npm dep
    ([inv:dev-time-nx] keeps shipped code lean).
  - Deny-by-default semantics exactly per **[def:enforcement-opt-in]** and
    **[def:policy]**: `perms === undefined` ⇒ `enforced=false`, all `allows*`
    return `true`; a present domain ⇒ deny-by-default within that domain; an
    absent domain within a present block ⇒ unconstrained for that domain.
  - `allowsNetwork(hostOrUrl)`: match against `network.outbound` entries as
    hostname or URL-prefix (per schema description).
  - Export the new symbols from `libs/host-runtime/src/index.ts`.

- **Invariants:** [inv:schema-stable] (do NOT edit `libs/manifest`),
  [inv:carry-fixes] (reuse `expandTilde`, do not duplicate it),
  [inv:dev-time-nx] (no new runtime npm dep), [ref:deny-by-default].

- **Validation:** `nx run host-runtime:test` — runs vitest for the lib; the new
  `policy.spec.ts` must pass and the pre-existing suite must stay green.

---

## Acceptance criteria

Checked by `audit-foundation` as slug-keyed criterion IDs. The audit script
(`scripts/audit_c6.py`) must contain a check for every item.

- [ ] **[policy-core.1]** `compilePolicy` and `compilePolicyFromEnv` are
      importable from the lib entry.
      `node -e "const m=require('./libs/host-runtime/dist/index.js'); if(typeof m.compilePolicy!=='function'||typeof m.compilePolicyFromEnv!=='function')process.exit(1); console.log('OK')"`
- [ ] **[policy-core.2]** Deny-by-default for a present domain: a write path
      OUTSIDE a declared `fs.write` allowlist is denied; one inside is allowed.
      (vitest assertion in `policy.spec.ts`, run by `nx run host-runtime:test`.)
- [ ] **[policy-core.3]** Legacy compat: `compilePolicy(undefined).enforced ===
      false` and every `allows*()` returns `true` (preserves [inv:no-regress]).
      (vitest assertion.)
- [ ] **[policy-core.4]** Round-trip: `compilePolicyFromEnv(p.toEnv())` yields a
      policy with identical allow/deny decisions for a representative path set —
      the [shape:policy-env] contract is lossless. (vitest assertion.)
- [ ] **[policy-core.5]** `~/` and `**` matching: `~/.memory/x.db` is allowed by
      `["~/.memory/**"]`; `/tmp/x.db` is denied. (vitest assertion.)
- [ ] **[policy-core.6]** No new runtime npm dependency added: `policy.ts`
      imports only `node:*` and local lib files (no new entry in
      `libs/host-runtime/package.json` deps). [inv:dev-time-nx]
      `node -e "const ast=require('node:fs').readFileSync('libs/host-runtime/src/policy.ts','utf8'); if(/from ['\"](?!node:|\.)/.test(ast))process.exit(1);console.log('OK')"`

---

## Reservations

```text
read_only:  ["libs/manifest/src/index.ts",
             "libs/host-runtime/src/supervisor.ts"]
mutates:    ["libs/host-runtime/src/policy.ts",
             "libs/host-runtime/src/policy.spec.ts",
             "libs/host-runtime/src/index.ts"]
```

---

## Contract Promise

- **Added:** `compilePolicy`, `compilePolicyFromEnv`, `Policy` interface in
  `libs/host-runtime/src/policy.ts`; re-exported from `src/index.ts`.
- **Modified:** `libs/host-runtime/src/index.ts` — adds the policy exports only.
- **Deleted:** none.

---

## Commit points

- [ ] **After `policy.ts` + tests pass locally** — commit:
      `feat(c6): policy-core — compilePolicy/Policy matcher + tests`
- [ ] **After the guard passes** (mandatory) — commit source + the `state.json`
      / `dag.json` updates together:
      `feat(c6): policy-core complete — guard green`

---

## Notes for executor

- Reuse `expandTilde` from `supervisor.ts` — do NOT copy it; import it. This
  keeps [inv:carry-fixes] intact and avoids drift.
- Keep the glob matcher tiny and dependency-free; the only consumer needs `**`,
  `*`, and `~/` — a hand-rolled regex builder is sufficient and avoids a runtime
  dep ([inv:dev-time-nx]).
- This state is deliberately caller-free. Resist wiring it into the supervisor or
  adapters here — that is `process-boundary` / `inproc-policy` / `mcp-path-guard`.
  Doing it here would make their guards green→green (no information).
- `compilePolicyFromEnv` is the contract the spawned child consumes in
  `mcp-path-guard`; get the `toEnv()` ⇄ `fromEnv()` round-trip exactly right
  ([policy-core.4]) — a mismatch silently disables enforcement in the child.
- Budget: 1 session.
