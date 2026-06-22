# manifest-templates — MANIFEST TEMPLATES

> **Slug is identity.** This filename and the `manifest-templates` slug are immutable once assigned.

**Phase:** foundation · **Depends on:** (none) · **Guard:** `bash .workflow/plans/extension-install-model/scripts/guards/manifest-templates.sh`
**Parallel with:** bundle-pipeline, host-targets

---

## Goal

After this state, `sox init <type> <id>` produces an extension that passes `sox validate` for every active type (agent, skill, mcp-server, command, hook, bundle). `[dod.1]` is fully satisfied: validate exits 0 and emits no `[ERROR]` for all six types. This state eliminates the v1 failure mode where `sox init` output failed validate (missing `package.json`, `run_interface`, `README`).

---

## Semantic Distillation

- **Primitive:** MODIFY `libs/authoring/src/templates/<type>/index.ts` for all 6 types — ensure each template emits every field that `sox validate` requires.

- **Reference Pattern:** `libs/authoring/src/templates/` — the per-type template modules. The current templates are the source to audit; `sox validate` at `apps/sox/src/main.ts` defines what fields are required. `packages/sox-nx/src/generators/extension/index.ts` is the nx generator path (must stay in parity per `[ref:scaffold-parity]`).

- **Delta Spec:**
  - For each of `agent`, `skill`, `mcp-server`, `command`, `hook`, `bundle`: ensure the template emits:
    - A valid `sox.yaml` / `manifest.json` with all required fields (`id`, `type`, `version`, `run_interface` where applicable).
    - A `package.json` (for code types: mcp-server, hook, bundle).
    - A `README.md`.
    - Any type-specific required file (skill → `SKILL.md`; agent → `agent.md` or the content file; command → `<id>.md`).
  - Output must survive `sox validate --strict` with no `[ERROR]` lines.
  - `[ref:scaffold-parity]`: the nx generator must produce byte-identical output to `scaffold()`. If the generator lags, update it.

- **Invariants:** `[inv:tier3-proof]` — the guard drives the real `node bin/sox init` + `node bin/sox validate`, not a unit test. `[inv:sandbox-isolation]` enforced by `probe_done`.

- **Validation:** `bash .workflow/plans/extension-install-model/scripts/guards/manifest-templates.sh` — for each of 6 types: `sox init <type> <id>` exits 0; the created dir exists; `sox validate <path>` exits 0 with no `[ERROR]` in stdout.

---

## Acceptance criteria

Checked by audit-foundation (phase gate).

- [ ] **[manifest-templates.1]** `sox init agent` + `sox validate` exits 0 with no `[ERROR]` (real CLI, fresh dir).
      Via guard: `bash .workflow/plans/extension-install-model/scripts/guards/manifest-templates.sh`
- [ ] **[manifest-templates.2]** `sox init skill` + `sox validate` exits 0 with no `[ERROR]`.
      Via guard (same invocation covers all 6 types).
- [ ] **[manifest-templates.3]** `sox init mcp-server` + `sox validate` exits 0 with no `[ERROR]`.
      Via guard.
- [ ] **[manifest-templates.4]** `sox init command` + `sox validate` exits 0 with no `[ERROR]`.
      Via guard.
- [ ] **[manifest-templates.5]** `sox init hook` + `sox validate` exits 0 with no `[ERROR]`.
      Via guard.
- [ ] **[manifest-templates.6]** `sox init bundle` + `sox validate` exits 0 with no `[ERROR]`.
      Via guard.
- [ ] **[manifest-templates.7]** nx generator output is byte-identical to `scaffold()` for agent and skill (parity gate per `[ref:scaffold-parity]`).
      `node -e "const {scaffold}=require('./libs/authoring/dist'); const a=scaffold('agent','parity-agent'); const b=require('./packages/sox-nx/dist/generators/extension').generate('agent','parity-agent'); JSON.stringify(a)===JSON.stringify(b) ? process.exit(0) : process.exit(1)"`

---

## Reservations

```text
read_only:  ["apps/sox/src/main.ts",
             "packages/sox-nx/src/generators/extension/index.ts"]
mutates:    ["libs/authoring/src/templates/agent/index.ts",
             "libs/authoring/src/templates/skill/index.ts",
             "libs/authoring/src/templates/mcp-server/index.ts",
             "libs/authoring/src/templates/command/index.ts",
             "libs/authoring/src/templates/hook/index.ts",
             "libs/authoring/src/templates/bundle/index.ts",
             "scripts/guards/manifest-templates.sh"]
```

---

## Contract Promise

- **Modified:** all 6 type templates — each now emits a validate-passing manifest with all required fields

---

## Commit points

- [ ] **After all 6 templates pass validate locally** — commit all template files:
      `feat(eim): manifest-templates — all 6 init templates pass validate`
- [ ] **After the guard passes** (mandatory):
      `feat(eim): manifest-templates complete — guard green`

---

## Notes for executor

- Run validate manually against each type before the guard to catch type-specific issues early.
- `prompt` type is parked by design (CLAUDE.md B1) — do not add it.
- The guard runs all 6 types sequentially in the same `probe_init` sandbox so cross-type pollution is possible; ensure `init` creates distinct output dirs.
- If the nx generator is out of parity, update it in the same commit as the template so the byte-identity check passes in one shot.
