<!-- markdownlint-disable MD013 MD033 -->
# install-lifecycle — install/update/diff/uninstall wired to engine + registry + ledger

> **Slug is identity.** This filename and the `install-lifecycle` slug are immutable once assigned.
> Ordering comes from `dag.json` (`depends_on`), not from this name.

**Phase:** enforcement · **Depends on:** audit-foundation · **Guard:** `./node_modules/.bin/nx run install-engine:test && ./node_modules/.bin/nx run host-runtime:test-e2e`
**Parallel with:** mcp-runtime, generators

---

## Goal

After this state `soxe install/update/diff/uninstall` are wired to the capability engine + host
registry + ledger, scope- and host-aware, with host-detection defaulting `--host`
(**[inv:host-agnostic-type]**). This is where Role B (**[def:role-b]**) finally fulfils its half —
**placement** — for declarative content: a markdown agent installs into `.claude/agents/` (project +
user), `diff` shows drift, `update` replaces in place, `uninstall` removes it, all verified on the
real FS (**[dod.1]**, **[dod.5]**). The single-string `install-target` *consumer* (`runInstall`) is
replaced by the descriptor-driven path.

It depends on `audit-foundation` (engine + registry exist). Parallel with `mcp-runtime` +
`generators`, but **shares `bin/sox` + `apps/sox/src/main.ts` with `generators`** — see Merge
protocol.

---

## Semantic Distillation

- **Primitive:** CREATE `libs/install-engine/src/{install,lifecycle,diff}.ts`; WIRE `bin/sox` +
  `apps/sox/src/main.ts`.

- **Reference Pattern:** spec §5 (lifecycle table), §6 (host detection), §3.4 (ledger-driven
  diff/uninstall); the existing `runInstall` path in `apps/sox/src/main.ts` (the symbol being
  re-signed).

- **Delta Spec:**
  - `install.ts`: resolve target via `host-registry` → run capability installers → merge `config`
    → write a ledger entry. Capabilities come from `capability-engine`; targets are
    registry-resolved (**[ref:host-keyed-target]**); host config is touched ONLY through
    `config-merge` (**[ref:config-merge-format]**).
  - `lifecycle.ts`: `update` (re-resolve version → diff desired-vs-ledger → apply delta only),
    `uninstall` (reverse ledger actions). `update`/`uninstall` are ledger-driven
    (**[inv:ledger-reversible]**); a capability that cannot cleanly reverse **aborts** (**[dod.12]**).
  - `diff.ts`: ledger vs disk → up-to-date / drifted / will-change, cross-scope.
  - CLI: add `soxe diff` / `soxe update` (declarative-aware) + `--host` / `--profile` / `--scope` /
    `--trust`; `runInstall` is **re-signed** to the descriptor-driven path.
  - Host detection defaults `--host` (spec §6).

- **Invariants:** **[inv:ledger-reversible]**, **[inv:host-agnostic-type]**, **[inv:never-managed]**,
  **[inv:no-regress]** (`host-runtime:test-e2e` stays green).

- **Validation:** `./node_modules/.bin/nx run install-engine:test && ./node_modules/.bin/nx run host-runtime:test-e2e`
  — unit tests plus the e2e that places a markdown agent into `.claude/agents/`, diffs, updates,
  uninstalls.

---

## Acceptance criteria

Checked by `audit-enforcement`. One check per item; none deferred.

- [ ] **[install-lifecycle.1]** install/update/diff/uninstall modules exist and are wired.
      `for f in install lifecycle diff; do test -f libs/install-engine/src/$f.ts || exit 1; done`
- [ ] **[install-lifecycle.2]** Declarative install places bytes at the host target, `uninstall`
      reverses via the ledger, AND an external edit to a ledger-tracked file is reported as drifted by
      `diff` (**[dod.1]**, **[dod.5]**, **[inv:ledger-reversible]**). `host-runtime:test-e2e` +
      `install-engine:test` cover install→diff(+drift)→update→uninstall of a markdown agent on the real FS.
- [ ] **[install-lifecycle.3]** the exported `install()` is re-signed to the descriptor path; the old
      single-string `install-target` consumer is gone. `grep -nE 'install-target' apps/sox/src/main.ts` → empty.
- [ ] **[install-lifecycle.4]** `soxe diff` / `soxe update` exist with `--host`/`--profile`/`--scope`/
      `--trust`. `grep -nE 'diff|update' bin/soxe apps/sox/src/main.ts` → non-empty.
- [ ] **[install-lifecycle.5]** A capability that cannot cleanly reverse aborts (**[dod.12]**).
      `grep -niE 'abort|cannot.*reverse|reversib' libs/install-engine/src/lifecycle.ts` → non-empty;
      `install-engine:test` covers the abort path.

---

## Reservations

```text
read_only:  ["libs/host-registry/src/index.ts",
             "libs/install-engine/src/capabilities/config-merge.ts",
             "libs/install-engine/src/ledger.ts"]
mutates:    ["libs/install-engine/src/install.ts",
             "libs/install-engine/src/lifecycle.ts",
             "libs/install-engine/src/diff.ts",
             "bin/sox",
             "apps/sox/src/main.ts",
             "libs/install-engine/src/lifecycle.spec.ts",
             "tools/test-e2e-lifecycle.js"]
```

> **MANDATORY (architect pre-dispatch fix — BLOCKER-1):** extend `tools/test-e2e-lifecycle.js`
> (the `host-runtime:test-e2e` target) with the DECLARATIVE-placement scenarios `[dod.1]`/`[dod.2]`
> claim — otherwise the guard passes vacuously on the existing memory-server path. Add: (a) a markdown
> `agent` install into `.claude/agents/` at **project** AND **user** scope, then `diff` shows drift,
> `update` replaces, `uninstall` removes — asserted on the real FS; (b) the **codex** equivalent
> placement; (c) an `mcp-server` installed as **stdio in `.mcp.json`** (`--trust prompt`) with an
> undeclared-access **denial** observed. `install()` (NOT the `runInstall` test helper) is the
> re-signed symbol — review its callers (`apps/sox/src/main.ts:cmdInstall`, `bin/sox`) when changing
> its descriptor contract. The **drift-detection test** (external edit → `diff` reports drifted,
> **[dod.5]**) is folded into `[install-lifecycle.2]` and must be a real case in `install-engine:test`.

**Merge protocol:** This state and `generators` both mutate `bin/sox` + `apps/sox/src/main.ts`. Run
**install-lifecycle first**, commit the result, then apply `generators` against this state's output
(generators only adds `init` option wiring; lifecycle owns install/update/diff/uninstall command
dispatch). Coordinate via both context files.

---

## Contract Promise

- **Added:** `install.ts`, `lifecycle.ts`, `diff.ts`; `soxe diff` / `soxe update` commands.
- **Modified:** `bin/sox`, `apps/sox/src/main.ts` — descriptor-driven dispatch.
- **Re-signed:** `runInstall` — now takes the descriptor, not the single-string target.

---

## Commit points

- [ ] **After the unit + e2e guard is green** (mandatory) — commit source **and** `state.json` /
      `dag.json`: `feat(eim): install-lifecycle complete — declarative install/diff/update/uninstall — guard green`

If you land CLI wiring separately from the engine modules, commit the engine modules first
(`feat(eim): install-lifecycle — engine install/update/diff`) before touching the shared `bin/sox`.

---

## Notes for executor

- **You own the shared files first** (merge protocol). Land + commit `bin/sox` + `main.ts` here so
  `generators` rebases cleanly. If you discover `generators` already touched them, stop and
  coordinate (executor-class amendment).
- The on-disk reality test is the point of this state — a passing unit test that never writes a real
  host file does not satisfy **[install-lifecycle.2]**. The project rule: verify against the OS, not
  test output.
- Route ALL host-config writes through `config-merge` (**[ref:config-merge-format]**) and ALL target
  resolution through the registry (**[ref:host-keyed-target]**) — the final audit greps for direct
  `writeFileSync`/literal paths outside the registry. Budget ~2 sessions.
