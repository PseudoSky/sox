# audit-routing — Phase audit: routing

> **Slug is identity.** `audit-routing` is immutable.

**Phase:** routing · **Depends on:** `p4-routing` · **Guard:** `audit_memrefactor.py --phase routing`

---

## Goal

Extend the runner with `phase_routing()` (calls baseline + layout + extraction first).
Verify the routing layer is generated (not hand-maintained), the drift gate bites, the
CLAUDE.md hierarchy + ROUTER.md exist, and the soft advisory never gates.

---

## Semantic Distillation

- **Primitive:** ADD `phase_routing()` covering every `[p4-routing.*]`.
- **Reference Pattern:** the BL-33 mirror-gate model; `docs/routing/*`.
- **Delta Spec:** `phase_routing()` checks:
  - [p4-routing.1] map.json + INDEX.md (root + per-area) exist and reference every
    data/* package's `sox.*`.
  - [p4-routing.2] drift gate: a synthetic `sox.concerns` edit makes `routing:check-drift`
    FAIL; regenerate → pass. (Performed in a sandbox; reverted.) [inv:routing-generated]
  - [p4-routing.3] CLAUDE.md at root + `libs/data/`.
  - [p4-routing.4] ROUTER.md present with intent→scope entries.
  - [p4-routing.5] soft advisory works with embeddings disabled (a hash-backend recall
    returns advisory text, never errors/blocks). [def:degrade-to-bm25]
  - [p4-routing.6] `nx run-many -t build,lint` + `registry:check-sync` green.
- **Invariants:** [inv:routing-generated], [def:degrade-to-bm25], [def:audit-runner].
- **Validation:** `--phase routing` exits 0.

---

## Acceptance criteria

- [ ] **[audit-routing.1]** `--phase routing` runs all prior phases + routing and exits 0.
- [ ] **[audit-routing.2]** The drift gate is exercised (synthetic-edit-then-regenerate),
      not merely asserted.

---

## Notes for executor

- The drift gate is the load-bearing routing check — prove it fails on a real synthetic
  drift, like the layout phase proves the boundary fails on a real synthetic import.
- Budget: 1 session.
