# consolidate-legacy — Retire the Legacy `scripts/host/` Duplicate Runtime

> **Slug is identity.** `consolidate-legacy` is immutable. Ordering comes from
> `dag.json` (`depends_on`), not this name.

**Phase:** foundation · **Depends on:** (none — branches off `feat/nx-migration`) · **Guard:** `test ! -d scripts/host && nx run-many -t test && nx run-many -t build && nx run-many -t lint`

---

## Goal

Make `libs/host-runtime` the **SINGLE canonical runtime** before any C6
enforcement is wired. The nx migration (commit `e29624c`) ported the host
runtime (`loader` / `supervisor` / `registrar` / adapters) into
`libs/host-runtime/src/*` but **left the pre-nx copy live under
`scripts/host/`**. The result is a duplicate: two `ProcessSupervisor` classes,
two `loadFromLockfile` flows, duplicate `activate*` adapters, and a duplicate
`McpRegistrar`. C6 must enforce declared permissions **once**, in the canonical
runtime — enforcing it in `libs/host-runtime` while the superseded
`scripts/host/` copy still ships the unbounded `_spawn` would leave a second,
unenforced activation path. This state deletes the superseded copy so every
later enforcement state has exactly one place to change.

This is a **prerequisite** for `policy-core` and the enforcement states: it is
the root of the graph. It adds no enforcement behaviour — it removes dead,
duplicated code so the duplicate caller-mapping `--discover` failures vanish and
the enforcement seams are unambiguous.

---

## Semantic Distillation

- **Primitive:** DELETE the legacy `scripts/host/**` tree and its two dedicated
  test files (`scripts/host-runtime.test.ts`, `scripts/host-delivery.test.ts`),
  leaving `libs/host-runtime` as the sole runtime.

- **Reference Pattern:** the canonical lib already re-exports every symbol the
  legacy copy defined — `libs/host-runtime/src/index.ts` exports
  `ProcessSupervisor`, `loadFromLockfile`, `McpRegistrar`, `activateMcp`,
  `activateHook`, `activateAgent`, `activateSkill`, `activateCommand`. The
  consuming app imports the lib (`@sox/host-runtime`), NOT `scripts/host/`.

- **Delta Spec:**
  - **Prove supersession FIRST (read-only investigation), before deleting:**
    - `gitnexus_impact` / `gitnexus_context` on each deleted symbol
      (`ProcessSupervisor`, `activateHook`, `activateAgent`, `activateSkill`,
      `activateCommand`, `activateMcp`, `loadFromLockfile`, `McpRegistrar`) to
      enumerate every importer.
    - Confirm the ONLY live importers of `scripts/host/` are the two legacy test
      files deleted here (`scripts/host-runtime.test.ts` imports
      `./host/supervisor.js`; `scripts/host-delivery.test.ts` imports
      `./host/prompt-renderer.js` / `./host/registrar.js` / command). Confirm the
      product consumer (`apps/sox` / `bin/sox`) imports `@sox/host-runtime`, NOT
      `scripts/host/`. `bin/sox` (the CLI skeleton) imports no host module —
      verify and record. If any **non-test** live importer of `scripts/host/`
      remains, STOP and escalate (planner-class amendment) — do not delete under
      it.
  - **Delete** the files in `mutates` (the whole `scripts/host/` tree plus the
    two test files). If `scripts/host/` contains additional files
    (`hook-loader.ts`, `event-bus.ts`, `prompt-renderer.ts`, `cascade.ts`,
    etc.) that are ALSO superseded by a `libs/host-runtime` equivalent and have
    no remaining importer, delete them too and add them to this state's
    `mutates`/`artifacts` (executor-class `expand-artifacts` amendment with a
    `gitnexus_impact` citation) — keep `artifacts` ≡ `mutates` in sync.
  - **Do NOT touch** `libs/host-runtime/**` (it is the survivor),
    `tools/*-shim.js` (separate test scaffolding, out of scope), or
    `docs/architecture-audit-v2.md` (prose only — read_only; it describes the
    historical gap and must not be rewritten).

- **Invariants:** [inv:no-regress] (the suite stays green — the canonical lib
  tests already cover the behaviour the deleted test files covered;
  `nx run-many -t test` must not drop below the baseline minus the two legacy
  files' tests, which are redundant duplicates of `host-runtime` lib tests —
  document the exact count delta in the commit), [inv:carry-fixes] (the
  [def:session-fixes] live in `libs/host-runtime` and are untouched),
  [inv:dev-time-nx].

- **Validation:** the guard `test ! -d scripts/host && nx run-many -t test &&
  nx run-many -t build && nx run-many -t lint` — the directory is gone, the
  suite is green, every project builds and lints clean.

---

## Acceptance criteria

Checked by `audit-foundation` as slug-keyed criterion IDs.

- [ ] **[consolidate-legacy.1]** The legacy directory is gone: `scripts/host/`
      does not exist.
      `test ! -d scripts/host && echo OK`
- [ ] **[consolidate-legacy.2]** The two legacy test files are gone.
      `test ! -e scripts/host-runtime.test.ts && test ! -e scripts/host-delivery.test.ts && echo OK`
- [ ] **[consolidate-legacy.3]** No source/test/script file imports
      `scripts/host/` any longer (only docs prose may mention the symbols).
      `grep -rn "host/supervisor\|host/loader\|host/registrar\|host/adapters\|scripts/host" scripts extensions libs apps bin 2>/dev/null | grep -v "\.md:"` (expect empty)
- [ ] **[consolidate-legacy.4]** `ProcessSupervisor` and `loadFromLockfile` now
      resolve to exactly ONE definition each — the canonical lib. No definition
      remains under `scripts/`.
      `grep -rln "class ProcessSupervisor\|export function loadFromLockfile\|export async function loadFromLockfile" scripts 2>/dev/null` (expect empty)
- [ ] **[consolidate-legacy.5]** Regression: `nx run-many -t test` stays green
      (the canonical `host-runtime` lib suite covers the behaviour the deleted
      legacy tests duplicated). [inv:no-regress]
      `nx run-many -t test`
- [ ] **[consolidate-legacy.6]** `nx run-many -t build` and `nx run-many -t lint`
      are clean (no dangling reference to a deleted module). [inv:dev-time-nx]
      `nx run-many -t build && nx run-many -t lint`

---

## Reservations

```text
read_only:  ["libs/host-runtime/src/index.ts",
             "libs/host-runtime/src/supervisor.ts",
             "libs/host-runtime/src/loader.ts",
             "libs/host-runtime/src/registrar.ts",
             "libs/host-runtime/src/runtime.ts",
             "libs/host-runtime/src/adapters/mcp.ts",
             "libs/host-runtime/src/adapters/hook.ts",
             "docs/architecture-audit-v2.md"]
mutates:    ["scripts/host/supervisor.ts",
             "scripts/host/loader.ts",
             "scripts/host/registrar.ts",
             "scripts/host/runtime.ts",
             "scripts/host/adapters/mcp.ts",
             "scripts/host/adapters/hook.ts",
             "scripts/host/adapters/agent.ts",
             "scripts/host/adapters/command.ts",
             "scripts/host-runtime.test.ts",
             "scripts/host-delivery.test.ts"]
```

`mutates` here means **delete**. Every file is removed; `artifacts` in
`dag.json` lists the identical set (Check 2 parity). The `read_only` set names
the canonical survivor files (so a `--discover` re-grep / `gitnexus` of the
deleted symbols accounts every remaining occurrence) plus
`docs/architecture-audit-v2.md`, which references the symbols in PROSE and is
never edited.

**External-caller accounting (Step 0 / `--discover`).** The deleted symbols
(`ProcessSupervisor`, `activateHook`, `activateAgent`, `activateSkill`,
`activateCommand`, `activateMcp`, `loadFromLockfile`, `McpRegistrar`) are
re-derived by the checker (GitNexus fresh @ `e29624c`, else grep over
`scripts/`+`docs/`). Their occurrences:

- **Legacy copies** — `scripts/host/*` and the two legacy test files: in
  `mutates` (deleted here).
- **Canonical copies** — `libs/host-runtime/src/{index,supervisor,loader,registrar,adapters/*}.ts`:
  the survivor, accounted via this state's `read_only` and the enforcement
  states' reservations (`process-boundary` mutates `supervisor.ts`,
  `inproc-policy` mutates the adapters + `index.ts`).
- **Doc prose** — `docs/architecture-audit-v2.md`: `read_only` here.

After this state runs, a re-grep of these symbols finds them ONLY in
`libs/host-runtime` + doc prose — the duplicate caller-mapping is resolved at
the source.

---

## Contract Promise

- **Added:** none.
- **Modified:** none.
- **Deleted:** the legacy `scripts/host/**` runtime tree and its two dedicated
  test files (`scripts/host-runtime.test.ts`, `scripts/host-delivery.test.ts`).
  Declared in `dag.json` `changes.deletes` as the symbol set those files define.

---

## Commit points

- [ ] **After the supersession proof** (gitnexus investigation, no code change) —
      record the finding in the commit body of the deletion commit; no separate
      commit needed for read-only investigation.
- [ ] **After the deletion + guard passes** (mandatory) — commit:
      `refactor(c6): consolidate-legacy — remove superseded scripts/host duplicate; libs/host-runtime is canonical`
- [ ] **After the runtime updates** — commit the `state.json` / `dag.json`
      advancement together with the deletion (R1).

---

## Notes for executor

- This is a **deletion** state. Run the guard FIRST — it is red while
  `scripts/host/` exists (and `nx build/lint` may surface the dangling test
  imports). Delete, then re-run to green.
- The supersession proof is NON-NEGOTIABLE and comes first. If
  `gitnexus_impact` shows ANY non-test live importer of a `scripts/host/`
  symbol, STOP — that is a planner-class amendment (the duplicate is not yet
  fully superseded), not a deletion you make under a live caller.
- Do NOT edit `docs/architecture-audit-v2.md`. It is a historical record that
  references the deleted symbols in prose; rewriting it would falsify the audit
  trail. It is reserved `read_only`.
- Do NOT touch `tools/supervisor-shim.js` / `tools/host-event-shim.js` — they
  are test scaffolding, tracked separately, and out of this state's scope.
- If `scripts/host/` holds files beyond the eight listed (e.g. `hook-loader.ts`,
  `event-bus.ts`, `prompt-renderer.ts`) that are superseded with no remaining
  importer, delete them too and expand `mutates`/`artifacts` in lockstep
  (executor-class `expand-artifacts` amendment, cite the `gitnexus_impact`
  output). Keep `artifacts` ≡ `mutates`.
- Budget: 1 session.
```