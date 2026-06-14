<!-- markdownlint-disable MD013 MD033 -->
# ingestion-skill — Dogfooded `sox-ingest` skill replaces `docs/ingestion/`

> **Slug is identity.** This filename and the `ingestion-skill` slug are immutable once assigned.
> Ordering comes from `dag.json` (`depends_on`), not from this name.

**Phase:** convergence · **Depends on:** generators, install-lifecycle · **Guard:** `test -d extensions/skills/sox-ingest && test ! -e docs/ingestion/migration-plan.md && test ! -d docs/ingestion/prompts && ./node_modules/.bin/nx run-many -t lint`

---

## Goal

After this state a single dogfooded `sox-ingest` skill (itself a `type: skill` extension) encodes the
full flow — initialize → generalize+author → validate → publish → install → enable → remove-old —
**delegating** per-type/per-operation details to `references/`. An agent told "ingest `<source>` into
sox" loads this skill and runs the whole flow with no bespoke prompts (**[dod.13]**). The legacy
`docs/ingestion/prompts/*` + `migration-plan.md` are **removed** — their reusable content folds into
the skill's `references/`. This is also the **first real declarative skill extension**, so it
exercises **[dod.1]** end-to-end. The reality check (proved at `audit-final`) is ingesting
**[fix:ingest-source]** (`swarm-cost`) driven solely by the skill.

It depends on `generators` (the `--content @source` ingestion primitive, **[dod.7]**) and
`install-lifecycle` (declarative install/enable/uninstall, **[dod.1]**).

---

## Semantic Distillation

- **Primitive:** CREATE `extensions/skills/sox-ingest/` (skill + references); DELETE
  `docs/ingestion/prompts/*` + `migration-plan.md`; keep a thin `docs/ingestion/README.md` pointer.

- **Reference Pattern:** the existing `docs/ingestion/` prompts (`strategy`, `workflow-researcher`,
  `tokenguard`, `policy-enforcer`, `swarm-cost`) — fold their reusable per-type/per-operation
  guidance into `references/by-type.md` + `references/by-operation.md`; the `--content @source`
  primitive from `generators` (**[def:source-provenance]**); the skill shape under
  `extensions/skills/`.

- **Delta Spec:**
  - `SKILL.md`: the dogfooded flow (initialize → generalize+author → validate → publish → install →
    enable → remove-old), delegating to `references/`.
  - `extension.json`: `type: skill` born-conformant manifest with the hybrid install descriptor
    (**[shape:install-descriptor]**, **[ref:born-conformant-scaffold]**).
  - `references/by-type.md` + `references/by-operation.md`: the delegated per-type / per-operation
    references distilled from the old prompts.
  - **Remove** `docs/ingestion/prompts/*` (5 files) + `docs/ingestion/migration-plan.md`; reduce
    `docs/ingestion/README.md` to a one-line pointer at the skill.

- **Invariants:** **[ref:born-conformant-scaffold]** (the skill is born-conformant), **[dod.1]**
  (it installs/enables/uninstalls as a declarative skill), **[inv:no-regress]** (`nx run-many lint`
  green).

- **Validation:** the guard asserts the skill dir exists, the legacy prompts + migration-plan are
  GONE, and lint is green. The end-to-end ingest of `swarm-cost` is proved at `audit-final`.

---

## Acceptance criteria

Checked by `audit-final`. One check per item; none deferred.

- [ ] **[ingestion-skill.1]** The `sox-ingest` skill exists with SKILL.md + manifest + references
      (**[dod.13]**). `test -f extensions/skills/sox-ingest/SKILL.md && test -f extensions/skills/sox-ingest/extension.json && test -f extensions/skills/sox-ingest/references/by-type.md && test -f extensions/skills/sox-ingest/references/by-operation.md`
- [ ] **[ingestion-skill.2]** Legacy ingestion prompts + migration-plan are GONE (**[dod.13]**).
      `test ! -d docs/ingestion/prompts && test ! -e docs/ingestion/migration-plan.md`
- [ ] **[ingestion-skill.3]** SKILL.md encodes the full flow + delegates to references.
      `grep -niE 'initialize|generalize|validate|publish|install|enable|remove' extensions/skills/sox-ingest/SKILL.md` → non-empty AND `grep -nE 'references/' extensions/skills/sox-ingest/SKILL.md` → non-empty.
- [ ] **[ingestion-skill.4]** The skill is a born-conformant declarative skill extension
      (**[dod.1]**, **[ref:born-conformant-scaffold]**). `./node_modules/.bin/nx run-many -t lint` exits 0
      and the manifest carries an `install` descriptor: `grep -nE 'install' extensions/skills/sox-ingest/extension.json` → non-empty.

---

## Reservations

```text
read_only:  ["extensions/skills",
             "packages/sox-nx/src/generators/extension/extension.ts",
             "libs/install-engine/src/install.ts"]
mutates:    ["extensions/skills/sox-ingest/SKILL.md",
             "extensions/skills/sox-ingest/extension.json",
             "extensions/skills/sox-ingest/references/by-type.md",
             "extensions/skills/sox-ingest/references/by-operation.md",
             "docs/ingestion/README.md",
             "docs/ingestion/migration-plan.md",
             "docs/ingestion/prompts/swarm-cost.md",
             "docs/ingestion/prompts/strategy.md",
             "docs/ingestion/prompts/workflow-researcher.md",
             "docs/ingestion/prompts/tokenguard.md",
             "docs/ingestion/prompts/policy-enforcer.md"]
```

> The five `docs/ingestion/prompts/*` files and `migration-plan.md` are listed in `mutates` because
> this state **deletes** them (mutation = removal); `README.md` is reduced to a pointer. The guard
> + `[ingestion-skill.2]` prove the deletions.

---

## Contract Promise

- **Added:** `extensions/skills/sox-ingest/` (SKILL.md, extension.json, references/by-type.md,
  references/by-operation.md).
- **Modified:** `docs/ingestion/README.md` → one-line pointer.
- **Deleted:** `docs/ingestion/prompts/*` (5 files) + `docs/ingestion/migration-plan.md`.

---

## Commit points

- [ ] **After the skill is authored and the legacy prompts removed, with the guard green**
      (mandatory) — commit source **and** `state.json` / `dag.json`:
      `feat(eim): ingestion-skill complete — sox-ingest skill, docs/ingestion prompts removed — guard green`

---

## Notes for executor

- Author the skill so its references are **delegated**, not inlined — the skill body stays thin and
  the per-type / per-operation specifics live in `references/` (this is the cost discipline that
  makes the skill maintainable, mirroring the plan-state-machine's own `[ref:]` model).
- Do not delete `docs/ingestion/` wholesale — keep `README.md` as a pointer; the guard checks for the
  absence of `prompts/` + `migration-plan.md` specifically.
- The real ingest of `swarm-cost` happens at `audit-final`, driven SOLELY by this skill. Make sure
  the flow is runnable with no external prompts before you mark this state complete — otherwise the
  final audit's live check fails.
