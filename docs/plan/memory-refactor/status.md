# Status — memory-refactor

**Authored:** 2026-06-26 · **State:** execution-ready, entry-blocked on the quickfix.

## Progress

| Phase | State | Status |
|-------|-------|--------|
| baseline | p0-baseline | ⛔ blocked (quickfix republish pending) |
| baseline | audit-baseline | pending |
| layout | p1-layout | pending |
| layout | audit-layout | pending |
| extraction | w2a-embedding-provider | pending |
| extraction | w2b-graph-store | pending |
| extraction | w2c-vector-store | pending |
| extraction | w2d-ingest | pending |
| extraction | w2d-analysis | pending |
| extraction | w2d-hybrid-search | pending |
| extraction | w2e-domain-rewire | pending |
| extraction | audit-extraction | pending |
| routing | p4-routing | pending |
| routing | audit-routing | pending |
| convergence | audit-final | pending |

## Blocking item

- **Entry gate ([inv:quickfix-landed]):** `p0-baseline` cannot start until the
  memory-embedding-quickfix merges AND the live user-scope `memory-server` reports
  `embed_on_hash_fallback:false` + `bge-base-en-v1.5`. The quickfix is half-landed (live
  store re-embedded; server still hash) pending an **owner-gated npm republish**.

## Residual human-gated items (carry to convergence)

- Owner sign-off on the green `audit-final` before `complete` + merge of `feat/memory-refactor`.
- Per-package publish of any `data/*` package (F1 — public@0.x, publish action owner-gated).
- The npm republish that unblocks `p0-baseline` (also gates the quickfix itself).

## Notes

- 15 nodes, 5 audit phases, critical path 13 hops. See `state-machine.md`.
- The physical `libs/platform/<group>/` relocation is intentionally a follow-on, not in
  this plan ([decision-A]).
