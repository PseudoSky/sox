# memory-core — GENERATE MEMORY'S 4 EXTENSIONS + libs/memory-core (KILL THE REACH-IN)

> **Slug is identity.** Immutable. Legacy P7. **Code-moving state.**

**Phase:** convergence · **Depends on:** type-discovery · **Guard:** `bash .workflow/plans/nx-migration/scripts/guards/memory-core.sh`

---

## Goal

The 4 memory extensions and `sox-memory-bundle` ([def:memory-extensions]) are
brought into the nx layout. Shared internal code is extracted into
`libs/memory-core` (satisfying C7). Every cross-extension `../**/dist/` reach-in is
re-pointed to `libs/memory-core` (`[ref:no-cross-extension-reachin]`) and the
module-boundary lint confirms extension→extension edges are forbidden. The memory
MCP still works end-to-end (C5: `memory_write` + `memory_recall`).

---

## Semantic Distillation

- **Primitive:** MIGRATE the shared db/schema/embed/recall/write code into
  `libs/memory-core`; re-point the 4 extensions.
- **Reference Pattern:** ADR-0001 §Layout mapping (`libs/memory-core`);
  `extensions/mcp-servers/memory-server/src/` (the code to extract); the other 3
  memory extensions' `src/`.
- **Delta Spec:** generate `libs/memory-core` (`type:lib`, internal/not published);
  port SQLite schema+migrations, embed helpers, recall (hybrid vec+BM25+graph
  depth-1), write (SHA-256 dedup, FTS index); add `project.json` + `type:extension`
  tags + `build` targets to each of the 4 extensions and the bundle; replace every
  `../**/dist/` import with a `libs/memory-core` import; re-run lint until zero
  boundary violations (fix imports, never disable the rule); confirm C5 works.
- **Invariants:** [inv:manifest-source] (extensions validate); `libs/memory-core`
  internal. `[ref:no-cross-extension-reachin]`.
- **Validation:** `bash .workflow/plans/nx-migration/scripts/guards/memory-core.sh`.

### GitNexus (repo indexed)

`gitnexus query "memory recall write schema"` + `gitnexus context <symbol>` to find
EVERY module importing the memory-server internals (this locates the
`../**/dist/` reach-in to kill); `gitnexus impact <symbol>` before moving each
shared module into `libs/memory-core`; `gitnexus detect-changes` after to verify
the 4 memory extensions are the only affected consumers. Prefer the gitnexus MCP
tools over grep. Any consumer outside this state's `mutates`/`read_only` is a
planner-class divergence — stop and escalate.

---

## Acceptance criteria

- [ ] **[memory-core.1]** `nx run memory-core:build` clean.
- [ ] **[memory-core.2]** All 4 memory extensions + bundle build clean
      (`nx run-many -t build --projects=memory-server,memory-organizer,memory-flush,memory-cli,sox-memory-bundle`).
- [ ] **[memory-core.3]** Zero cross-extension `../**/dist/` reach-in remains under
      `extensions/` (`grep -rEl '\.\./.*dist/' extensions --include=*.ts` → empty).
- [ ] **[memory-core.4]** Module-boundary lint clean on the 4 memory extensions.
- [ ] **[memory-core.5]** C5: `memory_write` + `memory_recall` works end-to-end
      via `libs/memory-core`.

---

## Reservations

```text
read_only:  ["docs/decisions/0001-nx-and-self-hosting.md",
             "CLAUDE.md"]
mutates:    ["libs/memory-core/src",
             "libs/memory-core/project.json",
             "extensions/mcp-servers/memory-server",
             "extensions/agents/memory-organizer",
             "extensions/hooks/memory-flush",
             "extensions/commands/memory-cli",
             "extensions/bundles/sox-memory-bundle"]
```

---

## Contract Promise

- **Added:** `libs/memory-core` (db/schema/embed/recall/write); `project.json` +
  `type:extension` tags on the 4 extensions + bundle.
- **Modified:** the 4 extensions' imports re-pointed from `../**/dist/` to
  `libs/memory-core`.
- **Deleted:** the duplicated shared code inside `memory-server` (moved to the lib).

---

## Commit points

- [ ] **After libs/memory-core extraction** — `feat(nx-migration): memory-core — extract shared db/recall/write (C7)`
- [ ] **After re-pointing imports + lint clean** — `refactor(nx-migration): memory-core — kill cross-extension reach-in`
- [ ] **After the guard passes** (mandatory) — `feat(nx-migration): memory-core complete — guard green`

---

## Notes for executor

- The `../**/dist/` reach-in pattern must be ZERO after this state.
- Do NOT disable the module-boundary lint rule to pass — fix the import.
- `libs/memory-core` is internal — do NOT publish it (no `publishConfig`).
- C5 (`memory_write` + `memory_recall`) must still work.
- Capture `$?` directly; never pipe a tested exit ([inv:capture-exit]).

**Mandatory completion step.** Update `state.json` and commit (R1) before stopping.
