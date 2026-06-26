# audit-layout — Phase audit: layout

> **Slug is identity.** `audit-layout` is immutable.

**Phase:** layout · **Depends on:** `p1-layout` · **Guard:** `audit_memrefactor.py --phase layout`

---

## Goal

Extend the runner with `phase_layout()` (which calls `phase_baseline()` first). Verify the
taxonomy + boundary are real: the six `data/*` skeletons exist + compile + carry metadata,
the three area depConstraints bite, the existing libs are tagged, and a synthetic
`data→platform` import fails lint.

---

## Semantic Distillation

- **Primitive:** ADD `phase_layout()` to `audit_memrefactor.py`.
- **Reference Pattern:** `[shape:depconstraints]`, [ref:handoff] §7 acceptance,
  [fix:synthetic-boundary].
- **Delta Spec:** `phase_layout()` checks:
  - [p1-layout.1] six data/* packages with correct `name`/`sox.*`/tags.
  - [p1-layout.2] each `nx build <name>` exits 0.
  - [p1-layout.3] three depConstraints present in BOTH eslint blocks, before the catch-all.
  - [p1-layout.4] tokenguard-core=area:shared; 8 platform libs tagged area:platform;
    memory-core/memory-enrich untagged by area.
  - [p1-layout.5] [fix:synthetic-boundary] — in a sandbox copy, an injected
    `data→platform` import makes `nx lint` FAIL; without it, pass. (The audit performs the
    inject-lint-revert in a temp area so nothing lands.)
  - [p1-layout.6] `nx run-many -t build,lint` green + `registry:check-sync` green.
- **Invariants:** [inv:boundary], [inv:registry-current], [def:audit-runner].
- **Validation:** `--phase layout` exits 0.

---

## Acceptance criteria

- [ ] **[audit-layout.1]** `--phase layout` runs baseline + layout checks and exits 0.
- [ ] **[audit-layout.2]** The synthetic boundary test is executed (not just asserted) and
      confirms `data→platform` is rejected by lint.

---

## Notes for executor

- The synthetic-boundary check is the load-bearing one — it proves the boundary is REAL,
  not just declared. Run it against a sandbox copy of a data package; never commit the
  synthetic import.
- Budget: 1 session.
