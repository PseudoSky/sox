<!-- markdownlint-disable MD013 MD033 -->
# dod-reconcile — Split B2 "run" into run(process) vs placed+discoverable(declarative)

> **Slug is identity.** This filename and the `dod-reconcile` slug are immutable once assigned.
> Ordering comes from `dag.json` (`depends_on`), not from this name.

**Phase:** convergence · **Depends on:** install-lifecycle · **Guard:** `grep -q 'placed' DOD.md && grep -q 'placed' CLAUDE.md`

---

## Goal

After this state `DOD.md` and `CLAUDE.md` reflect the corrected bar: B2's "run" is split into
**run (process)** (code/service types sox supervises — Role A, **[def:role-a]**) vs
**placed + discoverable (declarative)** (content the foreign host runs — Role B, **[def:role-b]**,
**[inv:boundary]**). The declarative half — placed + discoverable + updatable across scopes — is
recorded as a **first-class** requirement and is reality-verified (it became real in
`install-lifecycle`). `CLAUDE.md`'s status summary is updated to match (**[dod.9]**).

It depends only on `install-lifecycle` being real (the declarative half must actually work before the
DoD claims it). Pure docs.

---

## Semantic Distillation

- **Primitive:** MODIFY `DOD.md` + `CLAUDE.md` — reconcile the B2 "run" bar.

- **Reference Pattern:** spec §10 P6, §11 (DoD impact), ADR consequences ("B2 'run' was only
  verified for code/process types"); the current `DOD.md` B2 wording + `CLAUDE.md` status section.

- **Delta Spec:**
  - In `DOD.md`: split B2 "run" into *run (process)* and *placed + discoverable (declarative)*; add
    declarative-content support across scopes as a first-class, reality-verified requirement (the
    word **`placed`** appears, which the guard checks).
  - In `CLAUDE.md`: update the status summary to reflect the install/reinjection work and the split
    "run" bar (the word **`placed`** appears).

- **Invariants:** **[inv:boundary]** (the declarative bar tops out at placed + discoverable, never
  "the host ran it"). No code change — docs only.

- **Validation:** `grep -q 'placed' DOD.md && grep -q 'placed' CLAUDE.md` — both docs carry the
  reconciled wording; the declarative half being real is proved by `install-lifecycle` + `audit-final`.

---

## Acceptance criteria

Checked by `audit-final`. One check per item; none deferred.

- [ ] **[dod-reconcile.1]** `DOD.md` splits B2 "run" into process vs placed/declarative
      (**[dod.9]**). `grep -niE 'placed|declarative' DOD.md` → non-empty.
- [ ] **[dod-reconcile.2]** `CLAUDE.md` status reflects the split "run" bar (**[dod.9]**).
      `grep -niE 'placed' CLAUDE.md` → non-empty.

---

## Reservations

```text
read_only:  ["docs/decisions/0002-extension-install-model.md",
             "libs/install-engine/src/install.ts"]
mutates:    ["DOD.md",
             "CLAUDE.md"]
```

---

## Contract Promise

- **Added:** the declarative "run" bar (placed + discoverable across scopes) as a first-class DoD
  item.
- **Modified:** `DOD.md` B2 wording; `CLAUDE.md` status summary.
- **Deleted:** none.

---

## Commit points

- [ ] **After both docs carry the reconciled wording and the guard is green** (mandatory) — commit
      **and** `state.json` / `dag.json`: `docs(eim): dod-reconcile complete — B2 run split process/declarative — guard green`

Single-commit state.

---

## Notes for executor

- Do not overclaim — the declarative half is "placed + discoverable," NOT "the host executed it"
  (**[inv:boundary]**). Word the DoD to match the boundary or `audit-final` (which verifies the
  boundary) will flag it.
- Only edit `DOD.md` + `CLAUDE.md`; the install/reinjection behavior itself is owned by
  `install-lifecycle`. This state just makes the documented bar honest.
- Keep the existing `[dod.N]`-style clause IDs in `DOD.md`/`CLAUDE.md` intact — you are splitting B2's
  prose, not renumbering the project DoD.
