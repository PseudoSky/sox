# enforcement — ENFORCEMENT

> **Slug is identity.** This filename and the `enforcement` slug are immutable once assigned.

**Phase:** runtime · **Depends on:** declarative-install, mcp-install-modes · **Guard:** `bash .workflow/plans/extension-install-model/scripts/guards/enforcement.sh`

---

## Goal

After this state, every denial path works via the CLI and the forbidden artifact is **confirmed absent on disk** after (`[dod.10]`): (a) stdio profile routing to `.mcp.json` is denied; (b) `exec` with an undeclared `db_path` is denied and no db file created; (c) codex project-forbidden key refused; (d) claude org/managed scope denied — nothing written. `[inv:never-managed]` is enforced.

---

## Semantic Distillation

- **Primitive:** MODIFY `libs/install-engine/src/install.ts` + `libs/host-registry/src/codex.ts` — add denial guards for each forbidden scenario. CREATE `extensions/mcp-servers/memory-server/src/permission-guard.spec.ts` — unit tests for the policy enforcement.

- **Reference Pattern:** `libs/host-runtime/src/policy.ts` anchors `[ref:policy-env-enforce]` — `compilePolicyFromEnv` enforces declared permissions at the resource sink. `install.ts` (after mcp-install-modes rebase) dispatches profiles; add validation before dispatch. `codex.ts` validates allowed keys at install time.

- **Delta Spec:**
  - `install.ts` (enforcement rebase onto mcp-install-modes):
    - If `--profile stdio` is given for an mcp server that explicitly targets `.mcp.json` (wrong routing), exit non-zero before writing anything.
    - If `--host codex --scope project` is given with a key that `codex.ts` marks forbidden, exit non-zero.
    - If `--host claude --scope org`, exit non-zero (org/managed is `[inv:never-managed]`).
  - `codex.ts` — `validateKey(key, scope)`: returns `{allowed: boolean, reason?}`. The enforcement check calls this before any file write.
  - `permission-guard.spec.ts` — unit tests for `compilePolicyFromEnv` covering: undeclared `db_path` denied; declared path allowed; isError=true returned on denial.

- **Invariants:** `[inv:never-managed]` — soxe never writes the org/managed tier. `[inv:tier3-proof]` — guard drives real CLI for all four denial cases and asserts both nonzero exit AND absent artifact.

- **Validation:** `bash .workflow/plans/extension-install-model/scripts/guards/enforcement.sh` — runs each of the four denial scenarios; asserts `assert_nonzero` + `assert_absent` for the forbidden artifact.

---

## Acceptance criteria

Checked by audit-final (terminal gate).

- [ ] **[enforcement.1]** `soxe install <mcp> --profile stdio` does NOT write `.mcp.json`; exits non-zero if the profile→target mismatch is explicitly forbidden.
      Via guard: `bash .workflow/plans/extension-install-model/scripts/guards/enforcement.sh`
- [ ] **[enforcement.2]** `soxe exec <memory-server> memory_write '{"db_path":"/tmp/forbidden.sqlite"}'` exits non-zero; `/tmp/forbidden.sqlite` is absent.
      Via guard.
- [ ] **[enforcement.3]** `soxe install <skill> --host codex --scope project --forbidden-key test` exits non-zero; `$SBX/.codex/skills/<id>` is absent.
      Via guard.
- [ ] **[enforcement.4]** `soxe install <agent> --host claude --scope org` exits non-zero; `$SBX/.claude/agents/<id>.md` is absent.
      Via guard.
- [ ] **[enforcement.5]** `permission-guard.spec.ts` exists and tests `compilePolicyFromEnv` undeclared-db denial.
      `test -f extensions/mcp-servers/memory-server/src/permission-guard.spec.ts && echo OK`

---

## Reservations

```text
read_only:  ["libs/host-runtime/src/policy.ts",
             "libs/install-engine/src/diff.ts",
             "libs/install-engine/src/lifecycle.ts",
             "libs/install-engine/src/capabilities/config-merge.ts",
             "libs/install-engine/src/capabilities/run-service.ts",
             "bin/sox",
             "apps/sox/src/main.ts"]
mutates:    ["libs/install-engine/src/install.ts",
             "libs/host-registry/src/codex.ts",
             "extensions/mcp-servers/memory-server/src/permission-guard.spec.ts",
             "scripts/guards/enforcement.sh"]
```

**Merge protocol:** This state rebases onto `mcp-install-modes`'s `install.ts`. Serialized by `depends_on`.

---

## Contract Promise

- **Modified:** `install.ts` — denial guards for org scope, codex forbidden keys, stdio→mcp.json mismatch; `codex.ts` — `validateKey(key, scope)` added
- **Added:** `permission-guard.spec.ts` — undeclared-path denial unit tests

---

## Commit points

- [ ] **After denial guards in install.ts** — commit `install.ts` + `codex.ts`:
      `feat(eim): enforcement — deny org scope, codex forbidden keys, profile mismatch`
- [ ] **After spec file** — commit `permission-guard.spec.ts`:
      `test(eim): enforcement — permission-guard unit tests for compilePolicyFromEnv`
- [ ] **After the guard passes** (mandatory):
      `feat(eim): enforcement complete — guard green ([dod.10])`

---

## Notes for executor

- Denial (a): a stdio install that writes to `.mcp.json` is a routing bug (stdio → `.claude.json`, sse/http → `.mcp.json`). The denial is that the wrong target is never written, not that stdio install fails. Make sure the check is "does stdio write `.mcp.json`?" = no.
- Denial (b): the `exec` denial for an undeclared `db_path` is enforced by `compilePolicyFromEnv` inside the running service — the guard calls `soxe exec` and the service itself returns `isError: true`. The guard then checks `assert_nonzero` (CLI propagates the error exit) and `assert_absent` the db file.
- The `permission-guard.spec.ts` is a UNIT test (tier 2) — it may accompany the tier-3 guard but must NOT replace it. The guard's exec denial is tier 3.
