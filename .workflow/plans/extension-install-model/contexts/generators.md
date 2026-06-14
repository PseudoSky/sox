<!-- markdownlint-disable MD013 MD033 -->
# generators — nx-style `init` options emitting the hybrid descriptor

> **Slug is identity.** This filename and the `generators` slug are immutable once assigned.
> Ordering comes from `dag.json` (`depends_on`), not from this name.

**Phase:** enforcement · **Depends on:** audit-foundation · **Guard:** `./node_modules/.bin/nx run sox-nx:test && ./node_modules/.bin/nx run authoring:test`
**Parallel with:** mcp-runtime, install-lifecycle

---

## Goal

After this state `sox init <type>` exposes the Appendix-A generator options
(`--content @path` / `--from`, `--inject`, `--profile` / `--mode`, `--surface`, `--host`,
`--transports`, `--trust`) and emits the **[shape:install-descriptor]** (hybrid: type + serves +
profiles + config) from the chosen options, born-conformant (**[def:born-conformant]**,
**[ref:born-conformant-scaffold]**). `--content @source` fills the artifact body and stamps
`source:` provenance (**[def:source-provenance]**) — the ingestion primitive (**[dod.7]**) that
`ingestion-skill` builds on.

It depends on `audit-foundation` (descriptor + registry exist so defaults can be pre-filled).
Parallel with `mcp-runtime` + `install-lifecycle`, but **shares `bin/sox` + `apps/sox/src/main.ts`
with `install-lifecycle`** — see Merge protocol.

---

## Semantic Distillation

- **Primitive:** MODIFY `libs/authoring/src/templates/<type>/index.ts` (six types) + the
  `@sox/nx` extension generator (`packages/sox-nx/src/generators/extension/`).

- **Reference Pattern:** spec Appendix A (the full per-type option schema), §7 (nx-style
  generators), the existing `libs/authoring` core + `@sox/nx` generator (the byte-identical parity
  gate, DoD A1/B1).

- **Delta Spec:**
  - Extend each type template + the nx generator `schema.json` with the Appendix-A options:
    common (`--host`, `--scope`, `--permissions`, `--env`); content (`--content`, `--from`);
    mcp (`--transports`, `--profiles`/`--mode`, `--trust`); command (`--surface`); prompt
    (`--inject`).
  - Emit the **[shape:install-descriptor]** + `serves`/`profiles` from the chosen options; author
    edits only `config` + overrides.
  - `--content @source` reads the body from a path and stamps `source:` provenance
    (**[def:source-provenance]**) for re-pull (**[dod.7]**).
  - **Byte-identical parity preserved**: `sox init` and the nx generator produce identical output
    (**[ref:born-conformant-scaffold]**).

- **Invariants:** **[ref:born-conformant-scaffold]** (single scaffolder, byte-identical),
  **[inv:host-agnostic-type]** (descriptor stores a host-agnostic type; targets from registry at
  install, not at init).

- **Validation:** `./node_modules/.bin/nx run sox-nx:test && ./node_modules/.bin/nx run authoring:test`
  — generator tests assert each new option lands in the emitted descriptor, `--content @path` fills
  the body + stamps `source:`, and `sox init` ⇄ nx output is byte-identical.

---

## Acceptance criteria

Checked by `audit-enforcement`. One check per item; none deferred.

- [ ] **[generators.1]** The nx generator schema exposes the Appendix-A options.
      `grep -nE 'content|from|inject|profile|mode|surface|transports|trust' packages/sox-nx/src/generators/extension/schema.json` → non-empty.
- [ ] **[generators.2]** `init` emits the hybrid install descriptor (serves/profiles/config).
      `authoring:test` covers a generated manifest carrying `install` + `serves`/`profiles`.
- [ ] **[generators.3]** `--content @source` fills the body + stamps `source:` provenance
      (**[dod.7]**, **[def:source-provenance]**).
      `grep -niE 'source|content' packages/sox-nx/src/generators/extension/extension.ts` → non-empty;
      `sox-nx:test` covers the `--content @path` → `source:` stamp.
- [ ] **[generators.4]** Output is born-conformant + byte-identical (`sox init` ⇄ nx)
      (**[ref:born-conformant-scaffold]**). `sox-nx:test` + `authoring:test` cover the parity gate.
- [ ] **[generators.5]** All six type templates accept the new options.
      `for t in mcp-server agent skill command hook prompt; do test -f libs/authoring/src/templates/$t/index.ts || exit 1; done`

---

## Reservations

```text
read_only:  ["libs/manifest/src/schema.json",
             "libs/host-registry/src/index.ts"]
mutates:    ["libs/authoring/src/templates/mcp-server/index.ts",
             "libs/authoring/src/templates/agent/index.ts",
             "libs/authoring/src/templates/skill/index.ts",
             "libs/authoring/src/templates/command/index.ts",
             "libs/authoring/src/templates/hook/index.ts",
             "libs/authoring/src/templates/prompt/index.ts",
             "packages/sox-nx/src/generators/extension/extension.ts",
             "packages/sox-nx/src/generators/extension/schema.json"]
```

**Merge protocol:** This state and `install-lifecycle` both touch the sox CLI surface
(`bin/sox` / `apps/sox/src/main.ts`). `install-lifecycle` runs **first** and owns
install/update/diff/uninstall dispatch; this state adds only `init` option wiring and must rebase
onto lifecycle's committed `main.ts`. **Do not** edit `bin/sox` / `apps/sox/src/main.ts` here unless
lifecycle has landed — `generators`' own `mutates` list deliberately excludes them; if `init` wiring
forces a CLI edit, coordinate (executor-class amendment expanding artifacts in both states).

---

## Contract Promise

- **Added:** Appendix-A options on six type templates + the nx generator schema; descriptor emission.
- **Modified:** `extension.ts` generator logic — emits descriptor + `source:` provenance.
- **Deleted:** none.

---

## Commit points

- [ ] **After both generator test targets are green** (mandatory) — commit source **and**
      `state.json` / `dag.json`: `feat(eim): generators complete — Appendix-A options + descriptor emission — guard green`

---

## Notes for executor

- **Byte-identical parity is the trap** — adding an option to one path (nx) but not the other
  (`sox init`) breaks `generators.4`. Both go through the single `libs/authoring` scaffolder
  (**[ref:born-conformant-scaffold]**); change the core once.
- `--content @source` is the **ingestion primitive** — `ingestion-skill` (convergence) calls it. Get
  the `source:` provenance stamp right (**[dod.7]**) or the skill cannot re-pull.
- Stay out of `bin/sox` / `apps/sox/src/main.ts` until `install-lifecycle` lands them (merge
  protocol). Budget ~2 sessions.
