# type-discovery — PER-TYPE DISCOVERY: REFINE GENERATORS + CONFIRM FLEXES

> **Slug is identity.** Immutable. Legacy P6.

**Phase:** convergence · **Depends on:** audit-engine · **Guard:** `bash .workflow/plans/nx-migration/scripts/guards/type-discovery.sh`

---

## Goal

The real extension corpus is explored — **shape per type, not full ingestion**
(ingestion is explicitly out of scope) — and the findings refine the
`libs/authoring` templates and confirm (or additively adjust) the `libs/manifest`
contract flexes. Each active type's generator output matches a real example's
structure. The born-conformance and parity invariants stay green.

---

## Semantic Distillation

- **Primitive:** MODIFY `libs/authoring/src/templates/<type>/` + (if needed,
  additively) `libs/manifest/src/schema.json`; CREATE `docs/per-type-shapes.md`.
- **Reference Pattern:** `docs/plans/nx-self-hosting-migration.md` §5 (real example
  sources per type and paths); current `libs/authoring/src/templates/`;
  `libs/manifest/src/index.ts` (schema + flexes).
- **Delta Spec:** read 1–3 real examples per type to determine structural shape;
  refine each template to match (correct shebang/event binding for shell hooks,
  `.md` entrypoint for markdown agents, real skill I/O convention, etc.); any
  schema change is **additive/backward-compatible only**; rebuild manifest +
  authoring; re-run born-conformance + parity; write `docs/per-type-shapes.md`
  (one paragraph per type: entrypoint form, runtime, whether install-target applies).
- **Invariants:** [inv:scaffold-parity]; schema changes additive only. `prompt`
  parked (no template/generator).
- **Validation:** `bash .workflow/plans/nx-migration/scripts/guards/type-discovery.sh`.

---

## Acceptance criteria

- [ ] **[type-discovery.1]** born-conformance gate green after refinement
      (`nx run sox-nx:born-conformance`).
- [ ] **[type-discovery.2]** parity test green after refinement (`nx run sox-nx:test`).
- [ ] **[type-discovery.3]** `docs/per-type-shapes.md` exists.
- [ ] **[type-discovery.4]** Any schema change was additive — `apps/sox/extension.json`
      still validates.

---

## Reservations

```text
read_only:  ["docs/plans/nx-self-hosting-migration.md",
             "apps/sox/extension.json"]
mutates:    ["libs/authoring/src/templates",
             "libs/manifest/src/schema.json",
             "docs/per-type-shapes.md"]
```

**No merge protocol needed:** this state shares `libs/authoring/src/templates` and
`libs/manifest/src/schema.json` with `authoring-lib`/`manifest-lib`, but those run
strictly earlier in the serial chain (foundation → engine → convergence); the
states are never executed in parallel, so no shared-file conflict can arise.

---

## Contract Promise

- **Added:** `docs/per-type-shapes.md`.
- **Modified:** refined templates; (optionally) additive schema fields.
- **Deleted:** none.

---

## Commit points

- [ ] **After template refinement + doc** — `feat(nx-migration): type-discovery — refine templates to real corpus shapes`
- [ ] **After the guard passes** (mandatory) — `feat(nx-migration): type-discovery complete — guard green`

---

## Notes for executor

- DO NOT ingest any external extensions — read shapes only (manifests + entrypoints).
- `prompt` gets NO generator or template.
- Any schema change MUST be additive — all existing manifests still validate.
- The parity test MUST stay green.
- Capture `$?` directly; never pipe a tested exit ([inv:capture-exit]).

**Mandatory completion step.** Update `state.json` and commit (R1) before stopping.
