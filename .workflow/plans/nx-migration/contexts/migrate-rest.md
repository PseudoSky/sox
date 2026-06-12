# migrate-rest — MIGRATE REMAINING EXTENSIONS + THIN-WRAP validate-manifests

> **Slug is identity.** Immutable. Legacy P8. **Code-moving state.**

**Phase:** convergence · **Depends on:** memory-core · **Guard:** `bash .workflow/plans/nx-migration/scripts/guards/migrate-rest.sh`

---

## Goal

Every remaining extension in `extensions/` that is not yet an nx project gets a
`project.json`, a `type:extension` tag, and a working `build` target — so
`nx run-many -t build` covers the full tree. Extension manifests are validated
against `libs/manifest` (incl. flex fields where applicable). The old engine
consumer `scripts/validate-manifests.ts` is made a **thin wrapper** that imports
`libs/manifest`'s `validate()` (`[ref:manifest-single-source]`,
[inv:manifest-source]) — all 44 of its tests still pass. `nx run-many -t
build,lint` exits 0 across the whole tree.

---

## Semantic Distillation

- **Primitive:** WIRE the remaining extensions into the nx graph; REWRITE
  `scripts/validate-manifests.ts` as a thin wrapper.
- **Reference Pattern:** the `extensions/` directory listing (subdirs without
  `project.json`); `scripts/validate-manifests.ts` (the 44 tests [fix:validate-suite]
  and the validation logic to replace); `libs/manifest/src/index.ts`.
- **Delta Spec:** add `project.json` (`type:extension`, `@nx/js:tsc` build, or a
  no-op/copy target for declarative/shell extensions) to every extension lacking
  one; validate each `extension.json` against `libs/manifest` and fix manifests (NOT
  behavior) that fail; replace the validation logic in
  `scripts/validate-manifests.ts` with calls to `libs/manifest`'s `validate()`,
  preserving the error-reporting format and exit-code behavior; run all 44 tests;
  `nx run-many -t build` and `-t lint` clean, fixing tag/path issues.
- **Invariants:** [inv:manifest-source]; do NOT change extension behavior.
- **Validation:** `bash .workflow/plans/nx-migration/scripts/guards/migrate-rest.sh`.

### GitNexus (repo indexed)

`gitnexus impact <symbol>` + `gitnexus context <symbol>` before relocating each
extension's code; `gitnexus detect-changes` after to confirm no unexpected
consumers were affected. Prefer the gitnexus MCP tools over grep for importers.

---

## Acceptance criteria

- [ ] **[migrate-rest.1]** Full nx graph builds (`nx run-many -t build`).
- [ ] **[migrate-rest.2]** Module-boundary lint clean across ALL projects
      (`nx run-many -t lint`).
- [ ] **[migrate-rest.3]** Thin-wrapped `validate-manifests` still passes its 44
      conformance tests (`nx run manifest:test`).
- [ ] **[migrate-rest.4]** `scripts/validate-manifests.ts` imports `libs/manifest`
      (single source of truth) rather than re-implementing the schema.

---

## Reservations

```text
read_only:  ["libs/manifest/src/index.ts",
             "docs/decisions/0001-nx-and-self-hosting.md"]
mutates:    ["scripts/validate-manifests.ts"]
```

**Broader scope (project.json files).** This state ALSO creates a `project.json`
and adds a `type:extension` tag inside each remaining `extensions/<type>/<id>/`
directory, and may fix non-conformant `extension.json` manifests in place. Those
are net-new files inside per-extension directories (no other state owns them, so
there is no file-ownership conflict). The single declared `artifacts`/`mutates`
entry — `scripts/validate-manifests.ts` — is the one file shared with the engine
phase's read-only set, kept explicit so the gap-check artifacts↔mutates parity is
exact; the per-extension `project.json` additions are scoped here in prose.

---

## Contract Promise

- **Added:** `project.json` (+ `type:extension` tag) for every remaining extension.
- **Modified:** `scripts/validate-manifests.ts` → thin wrapper over `libs/manifest`;
  non-conformant `extension.json` manifests corrected (manifests only, not behavior).
- **Deleted:** none.

---

## Commit points

- [ ] **After all project.json + manifest fixes** — `feat(nx-migration): migrate-rest — full nx graph coverage`
- [ ] **After the thin-wrap + 44 tests green** — `refactor(nx-migration): migrate-rest — validate-manifests thin-wraps libs/manifest`
- [ ] **After the guard passes** (mandatory) — `feat(nx-migration): migrate-rest complete — guard green`

---

## Notes for executor

- ALL 44 `validate-manifests` tests must stay green — the thin-wrap may not drop coverage.
- Do NOT change extension entrypoints or runtime behavior — `project.json` +
  manifests only.
- Module-boundary lint must be clean across ALL projects.
- Capture `$?` directly; never pipe a tested exit ([inv:capture-exit]).

**Mandatory completion step.** Update `state.json` and commit (R1) before stopping.
