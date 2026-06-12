# ci-release — CI (nx affected) + nx release + commitlint + reality-gate targets

> **Slug is identity.** Immutable. Legacy P9.

**Phase:** convergence · **Depends on:** migrate-rest · **Guard:** `bash .workflow/plans/nx-migration/scripts/guards/ci-release.sh`

---

## Goal

CI runs `nx affected -t build,lint,test,validate` (only changed packages rebuild,
B3); `nx release` replaces Changesets (D3); commitlint is wired into a `commit-msg`
hook; the reality-gate tests (process-table checks, lifecycle e2e) are re-homed as
nx `test` targets (NOT deleted); per-type purpose docs exist in
`docs/guidelines/<type>.md` for all 6 active types. The retired
`scripts/scaffolder.test.ts` is deleted (the born-conformance gate replaces it).
No previously-green test is removed.

---

## Semantic Distillation

- **Primitive:** WIRE CI + release + commit hook; CREATE per-type docs; DELETE the
  retired scaffolder test.
- **Reference Pattern:** `.github/workflows/` (existing CI); `nx.json` (the
  `release` block from `nx-init` to extend); `scripts/scaffolder.test.ts` (to
  delete); `docs/plans/nx-self-hosting-migration.md` §6 P9; ADR-0001 D3.
- **Delta Spec:** `.github/workflows/ci.yml` runs
  `nx affected -t build,lint,test,validate --base=origin/main`; extend `nx release`
  in `nx.json` (conventional-commits, changelog renderer, memory extensions as a
  release group); add a `.husky/commit-msg` hook running commitlint; re-home
  process-table reality-gate tests as nx `test` targets on `host-runtime`/
  `install-engine` (do NOT delete them); write `docs/guidelines/{agent,skill,
  mcp-server,hook,command,bundle}.md`; DELETE `scripts/scaffolder.test.ts`.
- **Invariants:** [def:reality-check] (reality-gates preserved). No previously-green
  test removed (except the deliberately retired scaffolder test).
- **Validation:** `bash .workflow/plans/nx-migration/scripts/guards/ci-release.sh`.

---

## Acceptance criteria

- [ ] **[ci-release.1]** `.github/workflows/ci.yml` uses `nx affected`.
- [ ] **[ci-release.2]** `nx release --dry-run` completes.
- [ ] **[ci-release.3]** `docs/guidelines/<type>.md` exists for all 6 active types.
- [ ] **[ci-release.4]** `scripts/scaffolder.test.ts` is deleted (born-conformance
      gate replaces it).

---

## Reservations

```text
read_only:  ["nx.json",
             "docs/plans/nx-self-hosting-migration.md"]
mutates:    [".github/workflows/ci.yml",
             ".husky/commit-msg",
             "docs/guidelines",
             "scripts/scaffolder.test.ts"]
```

`scripts/scaffolder.test.ts` is in `mutates` because this state **deletes** it.
`nx.json`'s `release` block is extended in place — it was created by `nx-init`, so
it is reserved `read_only` here and the release-group addition is an additive edit
the executor makes via an `nx release` config patch noted in the commit log; if a
direct `nx.json` edit is required, expand this state's `mutates` with an
executor-class amendment (it is non-topological).

---

## Contract Promise

- **Added:** `.github/workflows/ci.yml`; `.husky/commit-msg`;
  `docs/guidelines/<type>.md` (6 files); re-homed reality-gate nx test targets.
- **Modified:** `nx release` config (release group) — see Reservations note.
- **Deleted:** `scripts/scaffolder.test.ts`.

---

## Commit points

- [ ] **After CI + nx release + commitlint hook** — `ci(nx-migration): ci-release — nx affected CI + nx release + commitlint`
- [ ] **After per-type docs + reality-gate re-home + scaffolder-test deletion** — `docs(nx-migration): ci-release — per-type guidelines; retire scaffolder test`
- [ ] **After the guard passes** (mandatory) — `ci(nx-migration): ci-release complete — guard green`

---

## Notes for executor

- Do NOT delete any reality-gate test that checks the OS process table — re-home it.
- `scripts/scaffolder.test.ts` IS deleted (born-conformance gate replaces it).
- Total test count must not drop below pre-migration minus the scaffolder tests.
- Capture `$?` directly; never pipe a tested exit ([inv:capture-exit]).

**Mandatory completion step.** Update `state.json` and commit (R1) before stopping.
