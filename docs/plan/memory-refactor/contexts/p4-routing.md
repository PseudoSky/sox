# p4-routing — Agent-optimized decision-routing layer

> **Slug is identity.** `p4-routing` is immutable.

**Phase:** routing · **Depends on:** `audit-extraction` · **Guard:** see dag.json

---

## Goal

Build the layered agent decision-routing surface (SCOPE Part C) on top of the now-real
[def:area-group] taxonomy: a **generated** routing index (behind a drift gate),
hierarchical authored `CLAUDE.md`, a curated `ROUTER.md`, and a soft sox-memory advisory
that is advisory-only and embedding-independent. The goal is that an agent landing
anywhere in the tree can discover "what lives here, what may I import, where do I go for
task X" without grepping.

---

## Semantic Distillation

- **Primitive:** GENERATE `map.json`+`INDEX.md` from `sox.*`; AUTHOR the hierarchical
  CLAUDE.md + ROUTER.md; wire the soft advisory.
- **Reference Pattern:** the per-package `sox:{area,group,concerns,invariants,entrypoints}`
  metadata stamped in `p1-layout` (the source of truth, [ref:handoff] §5); the existing
  `build-index.ts`↔`check-registry-sync.ts` byte-mirror pattern (BL-33) as the model for a
  generator+drift-gate pair; the root `CLAUDE.md` AGENT CONSTRAINT style.
- **Delta Spec:**
  - `scripts/build-routing-index.ts` — walk the nx project graph + each package's
    `sox.*` metadata; emit `docs/routing/map.json` (machine) + `docs/routing/INDEX.md`
    (human) at root, plus a per-area `INDEX.md`. **Never hand-edit the outputs.**
  - `scripts/check-routing-drift.ts` — regenerate into a temp dir and diff against the
    committed outputs; non-zero on drift (the gate). Wire both as nx targets
    `routing:build-index` / `routing:check-drift`.
  - Hierarchical `CLAUDE.md`: a root pointer + an `area`-level `libs/data/CLAUDE.md`
    (and the group stubs the scaffold already drops) carrying execution rules + footguns,
    auto-scoped by cwd. Keep authoritative + minimal.
  - `docs/routing/ROUTER.md` — hand-curated "if doing X go to Y" for the top task types
    (add an embedding provider → data/embed; change ranking → data/search; schema change →
    data/graph + re-embed; etc.) incl. the cross-cutting ones.
  - Soft sox-memory advisory: a documented convention that task-time recall surfaces
    learned lessons — **advisory, never gating**, and MUST function with embeddings off
    ([def:degrade-to-bm25] applies; the advisory degrades, never blocks).
- **Invariants added:** [inv:routing-generated] (index generated, never hand-maintained),
  [inv:nx-targets], soft-advisory-never-gates.
- **Validation:** `routing:build-index` + `routing:check-drift` green + `audit … --phase
  routing`.

---

## Acceptance criteria

Checked by `audit-routing`.

- [ ] **[p4-routing.1]** `docs/routing/map.json` + `docs/routing/INDEX.md` (root) +
      per-area `INDEX.md` exist and are generated from `sox.*` (every data/* package +
      tagged lib appears with its concerns/invariants).
- [ ] **[p4-routing.2]** Drift gate works: a synthetic edit to a package's `sox.concerns`
      makes `routing:check-drift` FAIL; regenerating makes it pass. [inv:routing-generated]
- [ ] **[p4-routing.3]** Hierarchical CLAUDE.md present at root + `libs/data/` (area level)
      with boundary + build rules.
- [ ] **[p4-routing.4]** `docs/routing/ROUTER.md` present with intent→scope entries for the
      top task types incl. cross-cutting.
- [ ] **[p4-routing.5]** The soft advisory is documented as non-gating and works with
      embeddings disabled (a recall-with-hash run still returns advisory text, never errors
      or blocks). [def:degrade-to-bm25]
- [ ] **[p4-routing.6]** `nx run-many -t build,lint` green; `registry:check-sync` green.

---

## Reservations

```text
read_only:  ["docs/plan/memory-refactor/NX-GENERATOR-HANDOFF.md",
             "libs/data/**/package.json"]
mutates:    ["scripts/build-routing-index.ts", "scripts/check-routing-drift.ts",
             "docs/routing/**", "CLAUDE.md", "libs/data/CLAUDE.md"]
```

---

## Notes for executor

- The hard rule from SCOPE Part C: `map.json`/`INDEX.md` are **generated**, never hand-
  maintained — mirror-drift is a proven failure mode here. The drift gate is the whole
  point; build it like the BL-33 registry mirror.
- The soft advisory must not become a gate. If recall is down (embeddings off), routing
  still works — the advisory is a bonus layer, never a dependency.
- Touching the root `CLAUDE.md` is sensitive (it carries the AGENT CONSTRAINTs). ADD a
  routing pointer; do not rewrite the existing constraints.
- Budget: 1-2 sessions.
