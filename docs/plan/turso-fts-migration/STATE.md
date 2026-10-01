# STATE — turso-fts-migration

```yaml
schema: plan-state-machine/v1-light
plan: turso-fts-migration
current_state: null
entry_blocked_on: [spike-format-compat, spike-rollback]
authorized: true           # owner AUTHORIZED the pin bump (Q1 resolved; see §8)
authored_at: 2026-09-30
author: architect (deepseek-flash)
```

## State

| field | value |
|---|---|
| status | spec authored; NOT STARTED |
| current segment | none |
| blocked on | pre-flight spike (DESIGN §6a) |
| pin | still `^0.7.1` — bump AUTHORIZED, not yet applied (segment s5) |

## Open questions (resolve before dispatch)

- **Q1 — owner authorization. RESOLVED (authorized).** The owner has authorized the pin bump.
  The bump itself is still applied only in segment s5 (pin remains `^0.7.1` until then).
  `89849d2a` remains deliberately left **open** until s5 lands the bump and the leak gate is
  re-measured.
- **Q2 — rollback direction (UNVERIFIED).** Can 0.7.x read an fts2 store? No primary
  source. The spike must measure it; until then no downgrade is promised.
- **Q3 — cross-version VACUUM INTO (LOW).** Does a 0.8 `VACUUM INTO` of a v1 store
  produce a clean v2 index? Believed NO; §2 orders DROP+CREATE before VACUUM to sidestep.
  Spike confirms.
- **Q4 — `_key` object.** Does 0.8 still materialise
  `__turso_internal_fts_dir_<idx>_key`? If not, `verifyTursoFtsMaterialization`
  (`fts-ops.ts:346`) misfires → DROP+CREATE on every open → re-leak. Spike confirms.
- **Q5 — ADR number collision.** `docs/plan/store-reclaim/` references a proposed
  ADR-0026 for the reclaim engine; this plan proposes ADR-0026 for the migration.
  Reconcile numbering with the owner (next free = 0026).
- **Q6 — scratch manifest** `researcher-exp/package.json:13` pins exact `0.7.2`: remove or
  bump?

## Segments

| id | segment | depends_on | status |
|---|---|---|---|
| s1 | Pre-flight spike (rollback + cross-version VACUUM + `_key`) | — | pending |
| s2 | Migration engine/transform (DROP+CREATE→same-version VACUUM) | s1 | pending |
| s3 | Gate observability fix (`2bf0b7c8`) | — | pending |
| s4 | CLI subcommand + offline-exclusive wiring (ADR-0013 D4) | s2 | pending |
| s5 | Pin bump + relock + constant re-measurement (OWNER-GATED) | s1,s3 | pending |
| s6 | Production-copy verification + docs + proposed ADR-0026 | s2,s4,s5 | pending |

s3 is independent of s1 and may run in parallel. s1 is entry-blocking for s2.

## Anchors (read status)

READ by author (this plan): `docs/decisions/` (catalog), `docs/plan/store-reclaim/`
(DESIGN/STATE/README), `.research-trace/2026-09-30-turso-fts-optimize-leak-driver-bump.md`,
`store-rebuild.ts` (full), `fts-dialect.ts`, `fts-ops.ts`, `adapter-meta.ts`,
`store-growth.ts`, `store-lease.ts`, `cold-open-lock.ts`, `integrity.ts:1-1333`,
`config.ts`, `backup.ts:400-619`, ADR-0012/0013/0021/0024,
`fts-optimize-leak-gate.bl-c5249cdd.spec.ts`, `store-adapter/src/index.ts`,
`store-adapter/package.json`.

`(agent-read)` (dispatched, not personally re-read): all `package.json` pin lines,
`pnpm-lock.yaml` line numbers, `memory-cli/src/index.ts:701,778,867,870`,
`registry/index.json` rows, `integrity.ts:2454`.

UNVERIFIED: rollback direction; cross-version VACUUM; `_key` existence under 0.8.
