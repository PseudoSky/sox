# engine-libs — PORT ENGINE LIBS + FIX FLAG PARSER (A12)

> **Slug is identity.** Immutable. Legacy P4. **Code-moving state.**

**Phase:** engine · **Depends on:** audit-foundation · **Guard:** `bash .workflow/plans/nx-migration/scripts/guards/engine-libs.sh`

---

## Goal

The engine logic from `scripts/` is re-homed into three nx libs ([def:engine-libs]),
**carrying [def:session-fixes] forward** ([inv:fix-carry-forward]) and fixing the
flag parser (A12, `[ref:dual-flag-form]`) and `exec` routing (A11) while re-homing
the CLI. No logic is re-grabbed from before the `pre-nx-baseline` tag. The
`apps/sox` CLI is a stub shell here — behavior is wired in `sox-extension`.

---

## Semantic Distillation

- **Primitive:** MIGRATE `scripts/{install,cascade,build-index,host/*,provider-capabilities}`
  → `libs/{install-engine,host-runtime,registry}` + `apps/sox` stub shell.
- **Reference Pattern:** `scripts/install.ts`, `scripts/cascade.ts`,
  `scripts/hook-loader.ts`, `scripts/host/`, `scripts/provider-capabilities.ts`,
  `scripts/validate-manifests.ts` (drift-gate check); `CLAUDE.md` (fix inventory);
  DOD.md A11+A12.
- **Delta Spec:** generate the 3 libs (`type:lib`) + `apps/sox` (`type:app`); port
  install/cascade/build-index/lockfile + `parseArgs` into `install-engine`;
  loader/supervisor/registrar/event-bus (with `fireIsolated`, enable-reactivation,
  stop-via-supervisor) into `host-runtime`; drift-gate/index/checksum into
  `registry`; a verb-dispatch stub in `apps/sox/src` routing to stub handlers.
  Implement/export `parseArgs` from `install-engine` handling **both** `--flag value`
  and `--flag=value`. Fix `exec` routing to use the running server. Port all
  `scripts/*.test.ts` to the right lib + add A12 tests.
- **Invariants:** [inv:fix-carry-forward], [inv:nx-dev-only], [inv:ordering]
  (engine libs before `sox-extension`).
- **Validation:** `bash .workflow/plans/nx-migration/scripts/guards/engine-libs.sh`.

### GitNexus (this repo is indexed — 2,977 symbols)

Before moving ANY symbol: `gitnexus impact <symbol>` (blast radius — who breaks)
and `gitnexus context <symbol>` (callers/callees) to find every importer FIRST.
After moving: `gitnexus detect-changes` to confirm only the intended
symbols/flows changed. Prefer the gitnexus MCP tools over grep for dependency
discovery. Any importer you discover outside this state's `mutates`/`read_only`
is a planner-class divergence — stop and escalate.

---

## Acceptance criteria

- [ ] **[engine-libs.1]** Three engine libs + `apps/sox` build clean
      (`nx run-many -t build --projects=install-engine,host-runtime,registry,sox`).
- [ ] **[engine-libs.2]** `host-runtime` tests pass (fireIsolated,
      enable-reactivation, stop-via-supervisor carried forward).
- [ ] **[engine-libs.3]** `install-engine` tests pass (registry drift gate carried forward).
- [ ] **[engine-libs.4]** A12: `parseArgs` handles both `--flag value` and `--flag=value`.
- [ ] **[engine-libs.5]** Module-boundary lint clean on the three engine libs.

---

## Reservations

```text
read_only:  ["scripts/install.ts",
             "scripts/cascade.ts",
             "scripts/hook-loader.ts",
             "scripts/host",
             "scripts/provider-capabilities.ts",
             "scripts/validate-manifests.ts",
             "CLAUDE.md",
             "DOD.md"]
mutates:    ["libs/install-engine/src",
             "libs/install-engine/project.json",
             "libs/host-runtime/src",
             "libs/host-runtime/project.json",
             "libs/registry/src",
             "libs/registry/project.json",
             "apps/sox/src",
             "apps/sox/project.json"]
```

---

## Contract Promise

- **Added:** `libs/install-engine` (incl. `parseArgs`), `libs/host-runtime`,
  `libs/registry`, `apps/sox` (stub shell); A12 + drift-gate tests.
- **Modified:** the flag parser now accepts both forms; `exec` routes via the
  running server.
- **Deleted:** none (the `scripts/` originals stay until `migrate-rest`/`ci-release`).

---

## Commit points

- [ ] **After each lib is ported + green** — `feat(nx-migration): engine-libs — port <lib> with fixes carried forward`
- [ ] **After the A12 parser fix + exec routing** — `fix(nx-migration): engine-libs — A12 dual flag forms + exec via running server`
- [ ] **After the guard passes** (mandatory) — `feat(nx-migration): engine-libs complete — guard green`

---

## Notes for executor

- NEVER re-grab pre-fix code from before the `pre-nx-baseline` tag.
- The flag parser MUST handle both `--flag value` AND `--flag=value`.
- Do NOT delete the `scripts/` originals in this state.
- Do NOT add nx as a runtime dep of any lib ([inv:nx-dev-only]).
- Capture `$?` directly; never pipe a tested exit ([inv:capture-exit]).

**Mandatory completion step.** Update `state.json` and commit (R1) before stopping.
