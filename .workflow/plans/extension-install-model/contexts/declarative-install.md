# declarative-install — DECLARATIVE INSTALL

> **Slug is identity.** This filename and the `declarative-install` slug are immutable once assigned.

**Phase:** install · **Depends on:** host-targets, cli-wiring · **Guard:** `bash .workflow/plans/extension-install-model/scripts/guards/declarative-install.sh`

---

## Goal

After this state, real-FS install/uninstall/update/diff for content types (agent, skill, command + codex skill) works via the CLI: exact `[shape:host-target]` placement, reversible ledger, diff-detects-drift, update-refreshes, uninstall-removes and reverses the ledger, all sandboxed under `SOX_HOME` with zero real-home writes. This satisfies `[dod.3]`, `[dod.7]`, `[dod.8]`, `[dod.9]`.

---

## Semantic Distillation

- **Primitive:** MODIFY `libs/install-engine/src/install.ts` + CREATE `libs/install-engine/src/diff.ts` + MODIFY `libs/install-engine/src/lifecycle.ts` — implement install/uninstall/update/diff for content types.

- **Reference Pattern:** `libs/host-registry` (from host-targets) provides the exact target paths. `cli-wiring` has already wired the CLI verbs. The existing `install.ts` may have a stub or partial implementation — rewrite the content-type dispatch path.

- **Delta Spec:**
  - `install.ts` — `installExtension(id, opts)`: for content types, reads the manifest, resolves `[shape:host-target]` via `host-registry`, copies the content file(s) to the target path, writes a ledger entry under `$SOX_HOME/.sox/ledger/<id>.json`.
  - `diff.ts` (NEW) — `diffExtension(id, opts)`: reads the ledger, checksums placed files, reports any that differ from the installed snapshot. Exits 0 whether or not drift is found; stdout names drifted paths.
  - `lifecycle.ts` — `uninstallExtension(id, opts)`: removes placed files; removes ledger entry; does NOT touch any key not owned by sox. `updateExtension(id, opts)`: re-runs install, replaces placed files, updates the ledger.
  - Ledger format: `{ id, type, host, scope, placedFiles: [{path, sha256}], installedAt }`.
  - The placed agent file must be a single FILE at `<scopeRoot>/.claude/agents/<id>.md` (not a dir).

- **Invariants:** `[inv:sandbox-isolation]` — `scopeRoot` from host-registry already reroots under `SOX_HOME`; install must pass through it and never construct paths manually. `[inv:tier3-proof]` — the guard drives real CLI calls.

- **Validation:** `bash .workflow/plans/extension-install-model/scripts/guards/declarative-install.sh` — runs the full install→diff→update→uninstall cycle for agent/skill/command (claude) + codex skill through the harness; asserts exact shape, drift detection, clean reversal, zero real-home writes.

---

## Acceptance criteria

Checked by audit-install (phase gate).

- [ ] **[declarative-install.1]** `soxe install <agent> --host claude --scope project` places the agent FILE at `$SBX/.claude/agents/<id>.md`.
      Via guard: `bash .workflow/plans/extension-install-model/scripts/guards/declarative-install.sh`
- [ ] **[declarative-install.2]** `soxe diff <agent>` exits 0 on a clean install (no drift).
      Via guard.
- [ ] **[declarative-install.3]** After external edit, `soxe diff <agent>` stdout names the drifted path.
      Via guard.
- [ ] **[declarative-install.4]** `soxe update <agent>` refreshes the placed artifact.
      Via guard.
- [ ] **[declarative-install.5]** `soxe uninstall <skill>` removes the placed files; `$SBX/.claude/skills/<id>/SKILL.md` is absent.
      Via guard.
- [ ] **[declarative-install.6]** `soxe uninstall <codex-skill>` removes `$SBX/.codex/skills/<id>` dir.
      Via guard.
- [ ] **[declarative-install.7]** Ledger file written at `$SBX/.sox/ledger/<id>.json` after install.
      `test -f "$SBX/.sox/ledger/<id>.json" && echo OK` (covered by guard teardown assertions)

---

## Reservations

```text
read_only:  ["libs/host-registry/src/claude.ts",
             "libs/host-registry/src/codex.ts",
             "libs/host-registry/src/internal.ts",
             "bin/sox",
             "apps/sox/src/main.ts"]
mutates:    ["libs/install-engine/src/install.ts",
             "libs/install-engine/src/diff.ts",
             "libs/install-engine/src/lifecycle.ts",
             "scripts/guards/declarative-install.sh"]
```

**Merge protocol:** `mcp-install-modes` also mutates `install.ts`. This state lands FIRST; `mcp-install-modes` rebases onto this state's `install.ts`. Then `enforcement` rebases onto `mcp-install-modes`. Serialized by `depends_on`.

---

## Contract Promise

- **Added:** `diff.ts` — `diffExtension(id, opts): Promise<DiffResult>`
- **Modified:** `install.ts` — content-type install dispatch with ledger; `lifecycle.ts` — uninstall + update with ledger reversal

---

## Commit points

- [ ] **After install + ledger** — commit `install.ts`:
      `feat(eim): declarative-install — content-type install with ledger`
- [ ] **After diff** — commit `diff.ts`:
      `feat(eim): declarative-install — diffExtension drift detection`
- [ ] **After uninstall/update** — commit `lifecycle.ts`:
      `feat(eim): declarative-install — uninstall/update with ledger reversal`
- [ ] **After the guard passes** (mandatory):
      `feat(eim): declarative-install complete — guard green`

---

## Notes for executor

- The ledger is how uninstall knows which files to remove without touching foreign keys. Always write it, always clean it.
- `diffExtension` exits 0 regardless — it is a query command, not an error. Drift is reported on stdout, not via exit code.
- Do NOT add mcp-server install dispatch here — that belongs to mcp-install-modes, which rebases onto this state.
