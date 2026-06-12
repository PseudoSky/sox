# manifest-lib — libs/manifest: SCHEMA + VALIDATE WITH CONTRACT FLEXES

> **Slug is identity.** Immutable. Legacy P2.

**Phase:** foundation · **Depends on:** nx-init · **Guard:** `bash .workflow/plans/nx-migration/scripts/guards/manifest-lib.sh`

---

## Goal

`libs/manifest` becomes the single source of truth for "conformant"
([inv:manifest-source], `[ref:manifest-single-source]`): the manifest JSON schema
(with the three contract flexes [shape:manifest-flexes]) and a
`validate(manifest)` function. The behavior of the existing
`scripts/validate-manifests.ts` is fully replicated and re-verified. This is the
prerequisite for all born-conformant work, so it must precede `authoring-lib`
([inv:ordering]).

---

## Semantic Distillation

- **Primitive:** CREATE `libs/manifest/src/index.ts` — the canonical schema +
  validator.
- **Reference Pattern:** `schemas/extension/v1.json` (current schema),
  `scripts/validate-manifests.ts` (current validator + 44 tests [fix:validate-suite]),
  ADR-0001 §Contract adjustments.
- **Delta Spec:** generate the lib (`@nx/js:lib manifest --tags=type:lib`); export
  `validate(manifest): { ok: boolean; errors: string[] }`, a `Manifest` interface,
  and the schema. Encode [shape:manifest-flexes]: `entrypoint` optional/typed;
  `runtime ∈ {node,shell,python,declarative}`; optional `install-target`. Port all
  44 validator checks into `libs/manifest/src/manifest.spec.ts`. Do NOT delete
  `scripts/validate-manifests.ts` (thin-wrapped later in `migrate-rest`).
- **Invariants:** [inv:manifest-source]; libs/manifest is a pure lib (no @nx/devkit).
- **Validation:** `bash .workflow/plans/nx-migration/scripts/guards/manifest-lib.sh`.

---

## Acceptance criteria

- [ ] **[manifest-lib.1]** `nx run manifest:build` clean.
- [ ] **[manifest-lib.2]** `nx run manifest:test` passes (flex coverage + ported suite).
- [ ] **[manifest-lib.3]** Schema: `entrypoint` optional and `runtime:'shell'` validates.
- [ ] **[manifest-lib.4]** Schema: `runtime:'declarative'` with no `entrypoint` validates.
- [ ] **[manifest-lib.5]** Schema: `install-target` accepted.
- [ ] **[manifest-lib.6]** `libs/manifest/src` has no `@nx/devkit` import (pure lib).

---

## Reservations

```text
read_only:  ["scripts/validate-manifests.ts",
             "schemas/extension/v1.json",
             "docs/decisions/0001-nx-and-self-hosting.md"]
mutates:    ["libs/manifest/src/index.ts",
             "libs/manifest/src/schema.json",
             "libs/manifest/src/manifest.spec.ts",
             "libs/manifest/project.json"]
```

---

## Contract Promise

- **Added:** `validate`, `Manifest`, `ManifestSchema` in `libs/manifest`; the
  `validate`/`test`/`build` nx targets; `libs/manifest` tagged `type:lib`.
- **Modified:** the schema gains the three flexes (additive vs v1).
- **Deleted:** none (the old validator stays until `migrate-rest`).

---

## Commit points

- [ ] **After the lib + schema + flexes** — `feat(nx-migration): manifest-lib — schema+validate with contract flexes`
- [ ] **After the guard passes** (mandatory) — `feat(nx-migration): manifest-lib complete — guard green`

---

## Notes for executor

- Do NOT delete `scripts/validate-manifests.ts` — it still guards the existing
  extensions; it is thin-wrapped in `migrate-rest`, not here.
- `libs/manifest` MUST have zero `@nx/devkit` dependency (pure lib).
- `entrypoint` is optional — do NOT require it on all types.
- Capture `$?` directly; never pipe a tested exit ([inv:capture-exit]).

**Mandatory completion step.** Update `state.json` and commit (R1) before stopping.
