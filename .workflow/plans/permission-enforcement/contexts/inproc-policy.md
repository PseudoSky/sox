# inproc-policy — In-Process Declaration + Audit

> **Slug is identity.** `inproc-policy` is immutable. Ordering comes from
> `dag.json`.

**Phase:** enforcement · **Depends on:** `audit-foundation` · **Guard:** `nx run host-runtime:test`
**Parallel with:** `process-boundary`

---

## Goal

Deliver the **honest SOFT enforcement** for **[def:inproc-types]** (`agent`,
`skill`, in-process `hook`/`command`). These types are activated by in-process
`import()` (`adapters/{agent,hook,command}.ts`) and share the host's address
space — **hard OS isolation is impossible without a separate process**, and is a
declared non-goal ([dod.6]). Today these adapters merely `console.log` the
declared permissions then attach the raw block to the handle. This state raises
that to the achievable level: compile a **[def:policy]** at activation, attach it
to the handle, and emit a structured **audit-log decision** so access intent is
observable and the documented level matches the delivered level.

This state exists to make the per-type scope EXPLICIT and proven
([inv:per-type], `[dod.3]`), so the plan never claims isolation it does not
provide. Its forcing function is `[audit-final.per-type-soft]`.

---

## Semantic Distillation

- **Primitive:** MODIFY the three in-process adapters
  (`adapters/agent.ts`, `adapters/hook.ts`, `adapters/command.ts`) to compile +
  attach a Policy and audit access decisions.

- **Reference Pattern:** the current adapters
  (`activateAgent`/`activateSkill` `adapters/agent.ts:22,84`;
  `activateHook` `adapters/hook.ts:24`; `activateCommand` `adapters/command.ts:73`)
  — each takes `opts.permissions` and logs it. Cite **[ref:deny-by-default]**.

- **Delta Spec:**
  - In each adapter, `compilePolicy(opts.permissions)` at activation; attach the
    compiled `Policy` (not just the raw block) to the returned handle as a
    `policy: Policy` field.
  - Add a small shared `auditAccess(key, type, domain, target, decision)` helper
    (place it in `policy.ts` or a new `audit-log.ts` in the lib) that records a
    structured decision line (key, type, domain, target, allow|deny). The
    in-process adapters call it when their handle's policy is queried — provide a
    handle method (e.g. `handle.checkFs(path)`) that consults the policy AND
    audit-logs the decision, so an in-process extension that wants to honour the
    policy has a checked, logged path.
  - Document, in each adapter's header comment, the level: "SOFT — declaration +
    activation policy + audit log; no OS isolation (shared address space) — see
    [dod.6]." This documented level is what `[audit-final.per-type-soft]` checks.
  - Do NOT change activation semantics otherwise ([inv:no-regress]).

- **Invariants:** [inv:per-type] (honest SOFT level), [inv:no-regress]
  (activation behaviour preserved), [inv:carry-fixes] (`fireIsolated` hook
  dispatch untouched — only the adapter's activation path is extended),
  [ref:deny-by-default].

- **Validation:** `nx run host-runtime:test` — a new `inproc-policy.spec.ts`
  asserts handles carry a compiled Policy + the audit helper records decisions;
  existing adapter/host-runtime tests stay green.

---

## Acceptance criteria

Checked by `audit-enforcement`.

- [ ] **[inproc-policy.1]** Each in-process handle (agent, skill, hook, command)
      carries a compiled `policy` (a Policy, with `enforced` reflecting whether a
      block was declared). (vitest assertion across all four adapters.)
- [ ] **[inproc-policy.2]** The audit helper records a structured decision
      (key, type, domain, target, allow|deny) when a handle's policy is queried.
      (vitest: query a handle's `checkFs`, assert a decision record is emitted.)
- [ ] **[inproc-policy.3]** Documented level present: each of `agent.ts`,
      `hook.ts`, `command.ts` contains the SOFT-level header note referencing
      `[dod.6]`. [inv:per-type]
      `grep -l "SOFT" libs/host-runtime/src/adapters/agent.ts libs/host-runtime/src/adapters/hook.ts libs/host-runtime/src/adapters/command.ts`
- [ ] **[inproc-policy.4]** Legacy compat: a handle with NO declared permissions
      has `policy.enforced === false` and activation behaviour is unchanged.
      [inv:no-regress] (vitest assertion.)
- [ ] **[inproc-policy.5]** `fireIsolated` hook dispatch and existing adapter
      tests stay green. [inv:carry-fixes] `nx run host-runtime:test`.

---

## Reservations

```text
read_only:  ["libs/host-runtime/src/policy.ts",
             "libs/host-runtime/src/supervisor.ts",
             "libs/host-runtime/src/loader.ts",
             "libs/host-runtime/src/host-runtime.spec.ts",
             "docs/architecture-audit-v2.md"]
mutates:    ["libs/host-runtime/src/adapters/agent.ts",
             "libs/host-runtime/src/adapters/hook.ts",
             "libs/host-runtime/src/adapters/command.ts",
             "libs/host-runtime/src/audit-log.ts",
             "libs/host-runtime/src/inproc-policy.spec.ts",
             "libs/host-runtime/src/index.ts"]
```

No MUTATED file overlaps with `process-boundary` (which mutates only
`supervisor.ts` + its spec). The two states share READ-ONLY files (`policy.ts`,
and `host-runtime.spec.ts` which both list read_only — read_only sharing needs no
merge protocol); both run in parallel with NO shared MUTABLE file.

**External-caller accounting (Step 0 / `--discover`).** The resigned symbols are
`activateAgent`/`activateSkill`/`activateHook`/`activateCommand`. Per GitNexus
their canonical caller is `loadFromLockfile`/`dispatchToAdapter` in
`libs/host-runtime/src/loader.ts` (read_only) and the lib barrel
`libs/host-runtime/src/index.ts` (mutated here). The pre-nx legacy copy under
`scripts/host/adapters/` is **deleted by the new `consolidate-legacy` state**
(the plan's first state), so by the time this state runs the only definitions
are canonical. `docs/architecture-audit-v2.md` mentions `activateHook` in prose
only (read_only). **Note on `index.ts`:** `process-boundary`
does NOT mutate `index.ts`; only this state does (to export `audit-log`). If a
later amendment makes `process-boundary` also touch `index.ts`, add a merge
protocol then — at plan time there is no overlap.

---

## Contract Promise

- **Added:** `libs/host-runtime/src/audit-log.ts` (the `auditAccess` helper);
  `policy: Policy` + a `checkFs`/`checkSocket` method on each in-process handle;
  `inproc-policy.spec.ts`.
- **Modified:** `adapters/agent.ts`, `adapters/hook.ts`, `adapters/command.ts`
  (compile+attach policy, audit decisions, documented SOFT level); `index.ts`
  (export `audit-log`).
- **Deleted:** none.

---

## Commit points

- [ ] **After adapters carry policy + audit helper + tests pass** — commit:
      `feat(c6): inproc-policy — compiled policy + audit log on in-proc handles`
- [ ] **After the guard passes** (mandatory) — commit source + runtime updates:
      `feat(c6): inproc-policy complete — guard green`

---

## Notes for executor

- This is the HONEST-scoping state. Do not over-claim: in-process types share the
  host's memory; the deliverable is declaration + a checked, logged decision
  path, NOT a sandbox. The header notes you write are themselves audited
  ([inproc-policy.3]) so the plan cannot silently drift toward an isolation
  claim.
- `index.ts` is mutated here ONLY for the `audit-log` export — keep the diff to
  the export list to avoid any future overlap with `process-boundary`.
- Do not touch `fireIsolated` in the hook event-bus/loader; only extend the hook
  ADAPTER's activation path ([inv:carry-fixes]).
- Budget: 1 session.
