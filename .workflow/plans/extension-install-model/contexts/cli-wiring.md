# cli-wiring — CLI WIRING

> **Slug is identity.** This filename and the `cli-wiring` slug are immutable once assigned.

**Phase:** install · **Depends on:** audit-foundation · **Guard:** `bash .workflow/plans/extension-install-model/scripts/guards/cli-wiring.sh`

---

## Goal

After this state, every documented verb (`install`, `build`, `diff`, `update`) is wired in `apps/sox/src/main.ts` and resolves the correct library function, with all flags parsed correctly including both `--flag value` and `--flag=value` syntax. The CLI resolves `@sox/*` at runtime via `rewrite-paths.cjs`. This state is the prerequisite for declarative-install and mcp-install-modes.

The v1 failure was that the `install` verb was never wired to the library at all; the `diff` verb was absent; and `--flag=value` broke the flag parser.

---

## Semantic Distillation

- **Primitive:** WIRE `apps/sox/src/main.ts` — add `install`, `build`, `diff`, `update` dispatch; fix flag parser.

- **Reference Pattern:** `bin/sox` is the shell shim that invokes `apps/sox/src/main.ts`. `apps/sox/scripts/rewrite-paths.cjs` handles `@sox/*` resolution at runtime. Existing verb dispatch (e.g. `start`, `list`, `stop`) shows the pattern to follow.

- **Delta Spec:**
  - `bin/sox` — ensure it invokes the built `apps/sox` bundle with no bare module references; `rewrite-paths.cjs` must be called before any `@sox/*` import.
  - `apps/sox/src/main.ts`:
    - `install <id> [--host <h>] [--scope <s>] [--profile <p>] [--root <r>]` → calls `installExtension(...)` from `libs/install-engine`.
    - `build <id>` → calls the extension's nx build target.
    - `diff <id> [--host <h>] [--scope <s>]` → calls `diffExtension(...)` from `libs/install-engine`. NEW verb.
    - `update <id> [--host <h>] [--scope <s>]` → calls `updateExtension(...)` from `libs/install-engine`.
  - Flag parser: support both `--key value` and `--key=value`. Fix the existing parser or replace with a minimal correct one.
  - `apps/sox/scripts/rewrite-paths.cjs` — verify `@sox/*` is rewritten to the correct monorepo dist paths at build time so the CLI works from any cwd.

- **Invariants:** `[inv:tier3-proof]` — the guard drives real `node bin/sox <verb>` calls. `[inv:sandbox-isolation]` enforced by `probe_done`. Merge protocol: this state writes `bin/sox` + `main.ts` FIRST; `lifecycle` rebases onto this state's output.

- **Validation:** `bash .workflow/plans/extension-install-model/scripts/guards/cli-wiring.sh` — runs each verb via the harness and asserts its observable; also tests `--flag=value` syntax.

---

## Acceptance criteria

Checked by audit-install (phase gate).

- [ ] **[cli-wiring.1]** `sox install <agent> --host claude --scope project` exits 0 and places the file (real CLI).
      Via guard: `bash .workflow/plans/extension-install-model/scripts/guards/cli-wiring.sh`
- [ ] **[cli-wiring.2]** `sox install <agent> --host=claude --scope=project` (equals syntax) exits 0 and places the file.
      Via guard (equals-flag test case).
- [ ] **[cli-wiring.3]** `sox build <mcp-server>` exits 0 (verb is wired).
      Via guard.
- [ ] **[cli-wiring.4]** `sox diff <agent>` exits 0 on a clean install (new verb is wired; no drift reported).
      Via guard.
- [ ] **[cli-wiring.5]** `sox update <agent>` exits 0 (verb is wired).
      Via guard.
- [ ] **[cli-wiring.6]** `apps/sox/src/main.ts` dispatches `install` to `installExtension` (not a no-op).
      `grep -n "installExtension\|install-engine" apps/sox/src/main.ts | grep -q "install" && echo OK`

---

## Reservations

```text
read_only:  ["libs/install-engine/src/install.ts",
             "libs/install-engine/src/diff.ts",
             "libs/install-engine/src/lifecycle.ts",
             "libs/host-registry/src/claude.ts",
             "libs/host-registry/src/codex.ts"]
mutates:    ["bin/sox",
             "apps/sox/src/main.ts",
             "apps/sox/scripts/rewrite-paths.cjs",
             "scripts/guards/cli-wiring.sh"]
```

**Merge protocol:** This state writes `bin/sox` + `apps/sox/src/main.ts` FIRST. `lifecycle` (a later state) rebases onto this state's output when it adds `disable`, `enable` wiring.

---

## Contract Promise

- **Modified:** `apps/sox/src/main.ts` — wires `install`, `build`, `diff`, `update`; fixes flag parser; `rewrite-paths.cjs` — verified correct; `bin/sox` — verified no bare module leaks

---

## Commit points

- [ ] **After flag parser fix** — commit `apps/sox/src/main.ts`:
      `fix(eim): cli-wiring — fix --flag=value parser`
- [ ] **After all verbs wired** — commit `main.ts` + `bin/sox` + `rewrite-paths.cjs`:
      `feat(eim): cli-wiring — wire install/build/diff/update verbs`
- [ ] **After the guard passes** (mandatory):
      `feat(eim): cli-wiring complete — guard green`

---

## Notes for executor

- The `diff` verb is new — it does not exist in v1. Add it to the parser and wire it to `diffExtension` from `libs/install-engine/src/diff.ts` (which the declarative-install state will create; wire the call site now, implement the library function in declarative-install).
- The `rewrite-paths.cjs` step must run at build time so the emitted `bin/sox` bundle has no `@sox/*` bare specifiers at runtime. If the paths are already resolved by esbuild, that is fine; just verify with a grep on the built artifact.
- Do not touch `libs/install-engine/src/install.ts` in this state — that is declarative-install's territory.
