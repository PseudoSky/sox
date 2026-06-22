# host-targets — HOST TARGETS

> **Slug is identity.** This filename and the `host-targets` slug are immutable once assigned.

**Phase:** foundation · **Depends on:** (none) · **Guard:** `bash .workflow/plans/extension-install-model/scripts/guards/host-targets.sh`
**Parallel with:** bundle-pipeline, manifest-templates

---

## Goal

After this state, `libs/host-registry` surfaces the **exact** `[shape:host-target]` discoverable artifact path for every `(type, host, scope)` combination, and resolves each scope root under `SOX_HOME` so that sandbox isolation `[inv:sandbox-isolation]` covers project/user/local/org-detect for both claude and codex. No literal host-discovery path lives outside this library (`[ref:host-keyed-target]`).

---

## Semantic Distillation

- **Primitive:** MODIFY `libs/host-registry/src/claude.ts` + `libs/host-registry/src/codex.ts` + `libs/host-registry/src/internal.ts` — ensure the registry emits the exact shapes from `[shape:host-target]` and resolves scope roots under `$SOX_HOME` for all scopes.

- **Reference Pattern:** `libs/host-registry/src/internal.ts` is the anchor for `[ref:host-keyed-target]`. The current implementations of `claude.ts` and `codex.ts` define the existing mappings; audit them against `[shape:host-target]`.

- **Delta Spec:**
  - `claude.ts`: `targetPath(type, id, scope, root)` must return:
    - agent   → `${root}/.claude/agents/${id}.md`   (FILE)
    - skill   → `${root}/.claude/skills/${id}/SKILL.md` (DIR target)
    - command → `${root}/.claude/commands/${id}.md` (FILE)
    - hook    → `${root}/.claude/hooks/${id}/`      (DIR) + `settings.json` entry
    - mcp sse/http → `${root}/.mcp.json` entry
    - mcp stdio    → `${root}/.claude.json` entry
    - mcp service  → `[def:store-dir]` + supervisor record
  - `codex.ts`: `targetPath(type, id, scope, root)` must return:
    - skill → `${root}/.codex/skills/${id}/`  (DIR, `~/.codex` P0.6-verified)
    - agent → `${root}/AGENTS.md`              (file-drop)
  - `internal.ts`: `scopeRoot(scope, host, SOX_HOME)` must reroot ALL scopes (project/user/local) under `SOX_HOME` when `SOX_HOME` is set, not just project scope.
  - `host-registry.spec.ts`: add unit tests covering every `(type, host, scope)` → path mapping.

- **Invariants:** `[ref:host-keyed-target]` — no literal host-discovery paths outside this library. `[inv:sandbox-isolation]` — `scopeRoot` must reroot under `SOX_HOME` for ALL scopes so the guard never writes to real home.

- **Validation:** `bash .workflow/plans/extension-install-model/scripts/guards/host-targets.sh` — installs one file-drop type per `(host, scope)` via real CLI and asserts the exact `[shape:host-target]` path exists under `$SBX`; `probe_done` confirms zero real-home writes.

---

## Acceptance criteria

Checked by audit-foundation (phase gate).

- [ ] **[host-targets.1]** claude agent installs to `$SBX/.claude/agents/<id>.md` (a FILE, not a dir) via the real CLI.
      Via guard: `bash .workflow/plans/extension-install-model/scripts/guards/host-targets.sh`
- [ ] **[host-targets.2]** claude skill installs to `$SBX/.claude/skills/<id>/SKILL.md` (a file inside a DIR) via the real CLI.
      Via guard (same invocation).
- [ ] **[host-targets.3]** claude command installs to `$SBX/.claude/commands/<id>.md` (FILE) via the real CLI.
      Via guard.
- [ ] **[host-targets.4]** codex skill installs to `$SBX/.codex/skills/<id>/` (DIR) via the real CLI.
      Via guard.
- [ ] **[host-targets.5]** `scopeRoot` resolves all scopes under `SOX_HOME` (no literal `~` or `$HOME` escape in user/local scope).
      `grep -n "HOME\|~/" libs/host-registry/src/internal.ts | grep -v "SOX_HOME\|scopeRoot\|process.env" | wc -l | grep -q "^0$" && echo OK`
- [ ] **[host-targets.6]** No literal host-discovery path outside `libs/host-registry` in source.
      `grep -rn '\.claude/agents\|\.claude/skills\|\.codex/skills' --include="*.ts" --include="*.js" . --exclude-dir=libs/host-registry --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=.workflow | wc -l | grep -q "^0$" && echo OK`

---

## Reservations

```text
read_only:  ["apps/sox/src/main.ts",
             "libs/install-engine/src/install.ts"]
mutates:    ["libs/host-registry/src/claude.ts",
             "libs/host-registry/src/codex.ts",
             "libs/host-registry/src/internal.ts",
             "libs/host-registry/src/host-registry.spec.ts",
             "scripts/guards/host-targets.sh"]
```

---

## Contract Promise

- **Modified:** `claude.ts` — exact `[shape:host-target]` paths + SOX_HOME rerooting for all scopes; `codex.ts` — same for codex targets; `internal.ts` — `scopeRoot` reroots all scopes
- **Added:** `host-registry.spec.ts` — per-(type,host,scope) unit tests

---

## Commit points

- [ ] **After registry shape fixes** — commit `claude.ts` + `codex.ts` + `internal.ts`:
      `feat(eim): host-targets — exact discovery shapes + all-scope SOX_HOME rerooting`
- [ ] **After spec file** — commit `host-registry.spec.ts`:
      `test(eim): host-targets — per-(type,host,scope) unit coverage`
- [ ] **After the guard passes** (mandatory):
      `feat(eim): host-targets complete — guard green`

---

## Notes for executor

- The critical gap from v1: only project scope was rerooted under `SOX_HOME`; user and local scopes leaked to real `~/.claude`. Fix `internal.ts` first, then verify with the guard.
- The `[ref:host-keyed-target]` ESLint rule (`no-restricted-syntax` + `@nx/enforce-module-boundaries`) must already exist; do not add new literal paths elsewhere.
- Codex skill paths use `~/.codex/skills` (P0.6-verified in `_shared.md`); do not invent a different path.
