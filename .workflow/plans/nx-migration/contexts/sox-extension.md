# sox-extension — WIRE apps/sox (EXTENSION #0): FULL CLI + CONFORMANT MANIFEST

> **Slug is identity.** Immutable. Legacy P5.

**Phase:** engine · **Depends on:** engine-libs · **Guard:** `bash .workflow/plans/nx-migration/scripts/guards/sox-extension.sh`

---

## Goal

`apps/sox` is a fully-wired, working `sox` CLI consuming `libs/install-engine`,
`libs/host-runtime`, `libs/registry`, `libs/manifest`, and `libs/authoring`. It
ships its own `extension.json` (`type: "command"`) that validates against
`libs/manifest` — the **literal self-hosting** invariant (D1/D2,
`[ref:self-hosted-extension-zero]`). The full command surface works: A1 (`init`
born-conformant via `scaffold()`), A2–A10, A11 (`exec` via running server), A12
(both flag forms flow through the live CLI).

---

## Semantic Distillation

- **Primitive:** WIRE `apps/sox/src/main.ts` — verb handlers delegating to the
  engine libs; CREATE `apps/sox/extension.json`.
- **Reference Pattern:** ADR-0001 D1+D2; DOD.md A1–A12; the exported interfaces of
  `libs/{authoring,install-engine,host-runtime,registry,manifest}`.
- **Delta Spec:** `apps/sox/extension.json` (`type:"command"`, entrypoint → built
  CLI, `runtime:"node"`, valid `compatibility`) validated by `libs/manifest`; wire
  every verb (`init`→`scaffold()`+`writeFileSet`, `validate`, `search`, `install`,
  `start`, `list`, `details`, `enable`, `disable`, `update`, `uninstall`, `stop`,
  `exec` via the running server); add a `bin` field so `node dist/apps/sox/main.js`
  and `bin/sox` work; verify A12 flows through the live CLI; an integration test
  scaffolding a hook and asserting it validates.
- **Invariants:** [inv:nx-dev-only]; `init` uses `libs/authoring` (not the old
  scaffolder).
- **Validation:** `bash .workflow/plans/nx-migration/scripts/guards/sox-extension.sh`.

---

## Acceptance criteria

- [ ] **[sox-extension.1]** `nx run sox:build` clean.
- [ ] **[sox-extension.2]** `apps/sox/extension.json` validates against `libs/manifest` (D1).
- [ ] **[sox-extension.3]** `apps/sox/extension.json` `type` is `command` (D2).
- [ ] **[sox-extension.4]** A1: `sox init` scaffolds a born-conformant extension
      that validates.
- [ ] **[sox-extension.5]** A12: the live CLI reaches `--help` (documented flag forms).

---

## Reservations

```text
read_only:  ["libs/authoring/src/index.ts",
             "libs/install-engine/src",
             "libs/host-runtime/src",
             "libs/registry/src",
             "libs/manifest/src/index.ts",
             "DOD.md",
             "docs/decisions/0001-nx-and-self-hosting.md"]
mutates:    ["apps/sox/extension.json",
             "apps/sox/src/main.ts",
             "apps/sox/package.json",
             "apps/sox/bin/sox"]
```

---

## Contract Promise

- **Added:** `apps/sox/extension.json`; the wired verb handlers; `bin/sox`.
- **Modified:** `apps/sox/src/main.ts` (stub → full); `apps/sox/package.json` (`bin`).
- **Deleted:** none.

---

## Commit points

- [ ] **After extension.json validates** — `feat(nx-migration): sox-extension — conformant extension #0 manifest (D1/D2)`
- [ ] **After all verbs wired** — `feat(nx-migration): sox-extension — full command surface wired to engine libs`
- [ ] **After the guard passes** (mandatory) — `feat(nx-migration): sox-extension complete — guard green`

---

## Notes for executor

- `apps/sox/extension.json` MUST validate against `libs/manifest` (D1).
- `init` MUST use `libs/authoring` `scaffold()` — do NOT re-port the old scaffolder.
- `exec` MUST use the running server (not a throwaway session).
- nx is never a runtime dep ([inv:nx-dev-only]).
- Capture `$?` directly; never pipe a tested exit ([inv:capture-exit]).

**Mandatory completion step.** Update `state.json` and commit (R1) before stopping.
