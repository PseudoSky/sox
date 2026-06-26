# State machine — memory-refactor

Resumable plan-state-machine (same artifact set as
`.workflow/plans/permission-enforcement/`). The orchestrator dispatches states
wave-by-wave; `dag.json` is authoritative for ordering (`depends_on`), `state.json`
tracks live status, and each state's `contexts/<slug>.md` is the self-contained work
order. Slugs are immutable identity; ordering comes from `depends_on`, never the name.

## Phases & terminal

`baseline → layout → extraction → routing → convergence`; terminal state `done`.
Branch: `feat/memory-refactor` (cut off `main` AFTER the quickfix merges).

## Nodes (15) and dependency edges

```
p0-baseline                                     (baseline,    deps: —)        ⛔ entry-blocked: [inv:quickfix-landed]
  └─ audit-baseline                             (baseline,    deps: p0-baseline)
       └─ p1-layout                             (layout,      deps: audit-baseline)
            └─ audit-layout                     (layout,      deps: p1-layout)
                 ├─ w2a-embedding-provider      (extraction,  deps: audit-layout)        ┐ parallel
                 └─ w2b-graph-store             (extraction,  deps: audit-layout)        ┘
                      ├─ w2c-vector-store       (extraction,  deps: w2a, w2b)
                      │    ├─ w2d-analysis      (extraction,  deps: w2c)                 ┐ parallel
                      │    └─ w2d-hybrid-search (extraction,  deps: w2c)                 │
                      └─ w2d-ingest            (extraction,  deps: w2b)                  ┘
                           └─ w2e-domain-rewire (extraction,  deps: w2d-ingest, w2d-analysis, w2d-hybrid-search)
                                └─ audit-extraction (extraction, deps: w2e-domain-rewire)
                                     └─ p4-routing      (routing, deps: audit-extraction)
                                          └─ audit-routing (routing, deps: p4-routing)
                                               └─ audit-final (convergence, deps: audit-routing)
```

## Waves (orchestrator dispatch)

| Wave | States | Notes |
|------|--------|-------|
| 0 | `p0-baseline` | entry-blocked on the quickfix republish |
| 1 | `audit-baseline` | builds the audit runner |
| 2 | `p1-layout` | consume scaffold/generator; boundary becomes real |
| 3 | `audit-layout` | synthetic data→platform import must fail lint |
| 4 | `w2a-embedding-provider` ‖ `w2b-graph-store` | disjoint source |
| 5 | `w2c-vector-store` ‖ `w2d-ingest` | vector carve + ingest (ingest needs only graph) |
| 6 | `w2d-analysis` ‖ `w2d-hybrid-search` | both need vector-store |
| 7 | `w2e-domain-rewire` | facade→flip→dissolve; registry resync |
| 8 | `audit-extraction` | tool-contract diff vs baseline |
| 9 | `p4-routing` | generated index + drift gate |
| 10 | `audit-routing` | drift gate exercised |
| 11 | `audit-final` | reality audit + owner review → merge |

## Critical path (13 hops)

`p0-baseline → audit-baseline → p1-layout → audit-layout → {w2a|w2b} → w2c-vector-store
→ {w2d-analysis|w2d-hybrid-search} → w2e-domain-rewire → audit-extraction → p4-routing →
audit-routing → audit-final`.

## Gate discipline

- Every state's `guard` (dag.json) must pass before `state.json` advances; the audit
  states re-run the cumulative `audit_memrefactor.py --phase <p>`.
- Audits are READ-ONLY: a failing check is fixed in source, never by weakening the check.
- `[inv:no-regress]`: no state red-bars anything green at `p0-baseline`. E2E orphan count
  is reconciled against the BL-63 known false-positive.
- `audit-final` requires owner sign-off before `complete` + merge; publishing any `data/*`
  package stays owner-gated (F1).
