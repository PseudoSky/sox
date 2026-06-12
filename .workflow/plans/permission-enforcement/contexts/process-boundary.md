# process-boundary — Spawn-Time Process Bounding

> **Slug is identity.** `process-boundary` is immutable. Ordering comes from
> `dag.json`.

**Phase:** enforcement · **Depends on:** `audit-foundation` · **Guard:** `nx run host-runtime:test`
**Parallel with:** `inproc-policy`

---

## Goal

Wire the **[def:policy]** into the single spawn point so **[def:spawned-types]**
are bounded at the process boundary. Today `ProcessSupervisor._spawn`
(`libs/host-runtime/src/supervisor.ts:162`) spawns with
`env: { ...process.env, ...this._env }` — the FULL parent environment, no cwd
restriction, no policy. That is exactly the "records but does not enforce" gap
(audit-v2 NEW-4). After this state, a spawned child receives a scrubbed env plus
the canonical **[def:policy-env]** describing its declared allowlist, and a
restricted cwd — giving the child a self-enforcement contract that
`mcp-path-guard` then consumes at the resource sink.

This state delivers the HARD-enforcement *delivery vehicle* for spawned types:
the bounded launch. `mcp-path-guard` (which depends on this state) delivers the
actual fs-path denial inside the child using the env this state injects.

---

## Semantic Distillation

- **Primitive:** MODIFY `libs/host-runtime/src/supervisor.ts` —
  `ProcessSupervisor` consumes `permissions`, compiles a Policy, and bounds
  `_spawn`.

- **Reference Pattern:** the existing `_spawn` at `supervisor.ts:162-190`
  (env merge + stdio). The constructor already accepts `opts.permissions`
  (`SupervisorOptions.permissions`, `supervisor.ts:42`) but currently DISCARDS
  it (it is never stored — confirm and fix). Cite **[ref:deny-by-default]**.

- **Delta Spec:**
  - Store `opts.permissions` in the constructor; `compilePolicy(permissions)`
    (from `policy.ts`) once at construction.
  - In `_spawn`, when `policy.enforced`:
    - **env scrub:** spawn with a minimal base env (PATH, HOME, plus an explicit
      allowlist of vars the runtime needs) rather than the full `process.env`,
      then merge `this._env`, then merge `policy.toEnv()` (**[def:policy-env]**).
      When NOT enforced, preserve today's exact behaviour
      (`{ ...process.env, ...this._env }`) — [def:enforcement-opt-in],
      [inv:no-regress].
    - **cwd restriction:** set `spawn` `cwd` to the extension directory (derive
      from `entrypointPath` dirname) when enforced, so relative path resolution
      is bounded. Unbounded (inherit) when not enforced.
  - Do NOT touch the restart / stop / health logic ([inv:carry-fixes]) — add the
    env/cwd bounding ONLY inside `_spawn`'s spawn-options construction.
  - Expose `policy()` accessor on `ProcessSupervisor` (read-only) so
    `mcp.ts`/tests can assert the wired policy.

- **Invariants:** [inv:carry-fixes] (restart/stop/health untouched),
  [inv:no-regress] (non-enforced path byte-identical behaviour),
  [def:enforcement-opt-in], [ref:deny-by-default].

- **Validation:** `nx run host-runtime:test` — a new
  `supervisor-policy.spec.ts` asserts the bounded launch; the existing
  supervisor/host-runtime suite stays green (proves [inv:carry-fixes]).

---

## Acceptance criteria

Checked by `audit-enforcement` as slug-keyed IDs.

- [ ] **[process-boundary.1]** When a `permissions` block is declared, the
      supervisor injects **[def:policy-env]** into the child env (`SOX_PERM_ENFORCE=1`
      + the four `SOX_PERM_*` JSON arrays). (vitest: spawn a tiny probe child
      that prints `process.env.SOX_PERM_*`; assert values match the declaration.)
- [ ] **[process-boundary.2]** When a `permissions` block is declared, the child
      env is SCRUBBED — a sentinel var present in the parent `process.env` is NOT
      visible to the child unless explicitly allowlisted. (vitest probe asserts
      the sentinel is absent.)
- [ ] **[process-boundary.3]** Legacy compat: with NO `permissions` block, the
      child env equals `{...process.env, ...env}` and cwd is inherited — exact
      pre-state behaviour. [inv:no-regress] (vitest assertion.)
- [ ] **[process-boundary.4]** cwd is set to the extension dir when enforced.
      (vitest probe prints `process.cwd()`; assert it equals the entrypoint dir.)
- [ ] **[process-boundary.5]** Carried-forward logic intact: the existing
      supervisor suite (restart/stop/health, [def:session-fixes]) stays green.
      `nx run host-runtime:test` (all prior specs pass).
- [ ] **[process-boundary.6]** `ProcessSupervisor.policy()` returns a Policy
      reflecting the declared permissions. (vitest assertion.)

---

## Reservations

```text
read_only:  ["libs/host-runtime/src/policy.ts",
             "libs/host-runtime/src/loader.ts",
             "libs/host-runtime/src/adapters/mcp.ts",
             "libs/host-runtime/src/host-runtime.spec.ts",
             "libs/host-runtime/src/index.ts",
             "docs/architecture-audit-v2.md"]
mutates:    ["libs/host-runtime/src/supervisor.ts",
             "libs/host-runtime/src/supervisor-policy.spec.ts"]
```

No file overlaps with `inproc-policy` (which mutates only the agent/hook/command
adapters) — the two run in parallel with NO shared mutable file, so no merge
protocol is required.

**External-caller accounting (Step 0 / `--discover`).** `ProcessSupervisor` is
the resigned symbol. Per GitNexus its canonical callers are `activateMcp`
(`libs/host-runtime/src/adapters/mcp.ts`, read_only), the lib barrel
(`libs/host-runtime/src/index.ts`, read_only), and `host-runtime.spec.ts`
(read_only). The pre-nx legacy copy under `scripts/host/` is **deleted by the
new `consolidate-legacy` state** (the first state in this plan), so by the time
this state runs there is exactly ONE `ProcessSupervisor` — the canonical one
mutated here. `docs/architecture-audit-v2.md` references the symbol in prose only
(read_only). The behaviour change is confined to `libs/host-runtime`.

---

## Contract Promise

- **Added:** `ProcessSupervisor.policy()`; `supervisor-policy.spec.ts`.
- **Modified:** `ProcessSupervisor` constructor (store permissions, compile
  policy) and `_spawn` (env scrub + policy-env injection + cwd bounding, gated on
  `policy.enforced`). The `SupervisorOptions.permissions` field's effective
  behaviour changes from discarded to consumed — see `changes` in `dag.json`.
- **Deleted:** none.

---

## Commit points

- [ ] **After `_spawn` bounding + tests pass** — commit:
      `feat(c6): process-boundary — policy-env + env scrub + cwd in supervisor`
- [ ] **After the guard passes** (mandatory) — commit source + runtime updates:
      `feat(c6): process-boundary complete — guard green`

---

## Notes for executor

- The constructor TODAY does not store `opts.permissions` (only key, entrypoint,
  args, env, lifecycle, onRestart — see `supervisor.ts:81-88`). Adding the field
  is a behaviour change to a discarded option, so it is declared in `dag.json`
  `changes.resigns` — run gap-check `--discover` to confirm no other caller
  relies on it being ignored.
- Footgun: scrubbing too aggressively breaks the child (e.g. dropping
  `NODE_OPTIONS`, `npm_*`, or the better-sqlite3 native loader's needs). Keep a
  conservative allowlist (PATH, HOME, LANG, TZ, NODE_*, plus `this._env`) and add
  vars only as a child fails — but document each. The enforcement that MATTERS
  for C6 is the fs-path denial (`mcp-path-guard`); env scrub is defence in depth.
- Do NOT enforce fs denial HERE — this state delivers the bounded launch + the
  policy-env contract. The actual `db_path` denial is `mcp-path-guard`, which
  depends on this state. Keeping them separate keeps each guard red→green.
- Budget: 1 session.
