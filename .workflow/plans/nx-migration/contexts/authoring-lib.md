# authoring-lib — libs/authoring + @adhd/sox-nx GENERATORS + BORN-CONFORMANCE GATE

> **Slug is identity.** Immutable. Legacy P3.

**Phase:** foundation · **Depends on:** manifest-lib · **Guard:** `bash .workflow/plans/nx-migration/scripts/guards/authoring-lib.sh`

---

## Goal

`libs/authoring` provides a **pure** `scaffold(opts) → FileSet` (no `@nx/devkit`
import, [inv:nx-free-core], `[ref:nx-free-authoring-core]`) with templates for the
6 active types ([def:active-types]; `prompt` parked). `@adhd/sox-nx` in
`packages/sox-nx/` provides thin `@adhd/sox-nx:extension`/`:library` generators that
call `scaffold()` and apply the FileSet to the nx Tree. A **parity test**
([inv:scaffold-parity], `[ref:scaffold-parity]`) asserts `soxe init` and the
generator emit byte-identical output. A born-conformance gate scaffolds one
extension per type, builds it, and validates it against `libs/manifest`. Per D4,
the 6 demo extensions are deleted — generated output is the fixture.

---

## Semantic Distillation

- **Primitive:** CREATE `libs/authoring/src/index.ts` (`scaffold`) + the `@adhd/sox-nx`
  generators + the born-conformance gate.
- **Reference Pattern:** ADR-0001 §Authoring, §The reflexive boundary, §D4;
  `libs/manifest/src/index.ts` (validate API); `scripts/new-extension.ts` (the
  existing scaffolder to port from — fix its gaps: missing `tsconfig`,
  `keywords`/`author`).
- **Delta Spec:** `scaffold(opts): FileSet` (`Record<path,content>`); per-type
  templates under `libs/authoring/src/templates/<type>/`; a `writeFileSet(fs,outDir)`
  helper; `@adhd/sox-nx:extension` maps FileSet → Tree + `project.json` + `type:<type>`
  tag; `@adhd/sox-nx:library` wraps `@nx/js:lib`. The parity spec calls `scaffold()`
  directly and via the generator in a dry-run Tree and asserts byte-equality.
  `tools/born-conformance.js` (nx target `sox-nx:born-conformance`) loops the 6
  types: scaffold → write → validate → assert ok. DELETE the 6 demo extensions.
- **Invariants:** [inv:nx-free-core], [inv:scaffold-parity]. `prompt` gets NO generator.
- **Validation:** `bash .workflow/plans/nx-migration/scripts/guards/authoring-lib.sh`.

---

## Acceptance criteria

- [ ] **[authoring-lib.1]** `nx run authoring:build` clean.
- [ ] **[authoring-lib.2]** `nx run sox-nx:build` clean.
- [ ] **[authoring-lib.3]** All 6 active types scaffold to a manifest that
      validates (`nx run sox-nx:born-conformance`).
- [ ] **[authoring-lib.4]** Parity test green: `soxe init` == `@adhd/sox-nx:extension`
      (`nx run sox-nx:test`).
- [ ] **[authoring-lib.5]** `libs/authoring/src` has zero `@nx/devkit`/`@nx/*` import.
- [ ] **[authoring-lib.6]** The 6 demo extensions are deleted (no longer on disk).

---

## Reservations

```text
read_only:  ["scripts/new-extension.ts",
             "libs/manifest/src/index.ts",
             "docs/decisions/0001-nx-and-self-hosting.md"]
mutates:    ["libs/authoring/src/index.ts",
             "libs/authoring/src/writer.ts",
             "libs/authoring/src/templates",
             "libs/authoring/project.json",
             "packages/sox-nx/src/generators/extension",
             "packages/sox-nx/src/generators/library",
             "packages/sox-nx/project.json",
             "tools/born-conformance.js",
             "extensions/agents/echo-agent",
             "extensions/skills/hello-world",
             "extensions/mcp-servers/hello-server",
             "extensions/hooks/audit-hook",
             "extensions/prompts/greeting-prompt",
             "extensions/commands/status-command"]
```

The six `extensions/.../<demo>` entries are listed in `mutates` because this state
**removes** them (D4) — a deletion is a mutation of that path.

---

## Contract Promise

- **Added:** `scaffold`, `writeFileSet` (`libs/authoring`); `@adhd/sox-nx:extension`,
  `@adhd/sox-nx:library`; `tools/born-conformance.js`; the parity test.
- **Modified:** none.
- **Deleted:** the 6 demo extensions (`echo-agent`, `hello-world`, `hello-server`,
  `audit-hook`, `greeting-prompt`, `status-command`).

---

## Commit points

- [ ] **After libs/authoring + @adhd/sox-nx generators** — `feat(nx-migration): authoring-lib — scaffold core + thin generators`
- [ ] **After the parity test + born-conformance gate + demo deletion** — `feat(nx-migration): authoring-lib — parity + conformance gate; delete demos (D4)`
- [ ] **After the guard passes** (mandatory) — `feat(nx-migration): authoring-lib complete — guard green`

---

## Notes for executor

- `libs/authoring` MUST have zero `@nx/devkit` imports — `soxe init` runs without nx.
- The parity test is MANDATORY — if it fails the two paths drifted; fix before exiting.
- `prompt` gets NO generator or template.
- Delete the 6 demos — do NOT keep them as reference extensions.
- Capture `$?` directly; never pipe a tested exit ([inv:capture-exit]).

**Mandatory completion step.** Update `state.json` and commit (R1) before stopping.
