# STATE — turso-fts-migration

```yaml
schema: plan-state-machine/v1-light
plan: turso-fts-migration
current_state: null
entry_blocked_on: []       # spike-format-compat + spike-rollback measured 2026-09-30 (DESIGN §6a)
authorized: true           # owner AUTHORIZED the pin bump (Q1 resolved; see §8)
authored_at: 2026-09-30
author: architect (deepseek-flash)
```

## State

| field | value |
|---|---|
| status | pre-flight spike complete; migration NOT STARTED |
| current segment | none |
| blocked on | nothing — DESIGN §6a measured the five unknowns; residual = restore-engine path UNVERIFIED |
| pin | still `^0.7.1` — bump AUTHORIZED, not yet applied (segment s5) |

## Open questions (resolve before dispatch)

- **Q1 — owner authorization. RESOLVED (authorized).** The owner has authorized the pin bump.
  The bump itself is still applied only in segment s5 (pin remains `^0.7.1` until then).
  `89849d2a` remains deliberately left **open** until s5 lands the bump and the leak gate is
  re-measured.
- **Q2 — rollback direction. RESOLVED (measured CORRUPTING).** A 0.7.2 open of a 0.8.1
  store reads base tables but `FTS_READ` returns **OK with zero results and no error**;
  `integrity_check` reports `wrong # of entries in index __turso_internal_fts_dir_idx_fts_node_key`.
  A 0.7.2 **write** poisons the store — the next 0.8.1 read throws `Corrupt database: FTS
  registry scan hit an unrecognized row: meta.json`. Any 0.7 open is therefore *corrupting*;
  no downgrade may ever be offered (DESIGN §5, §6a item 1). Residual: the pre-migration image
  was proven restorable by raw file copy, **not** through `restoreStoreOffline` (UNVERIFIED).
- **Q3 — cross-version VACUUM INTO. RESOLVED (measured SAFE).** A plain 0.8.1 `VACUUM INTO`
  of a checkpointed 0.7.2 v1 store produced a clean v2 store (1145 → 43 pages, sentinels
  preserved, integrity ok). §2 still orders DROP+CREATE before VACUUM — now for determinism,
  not to avoid a correctness hazard (DESIGN §6a item 3).
- **Q4 — `_key` object. RESOLVED (measured; hazard REFUTED).** Under 0.8.1 the
  `__turso_internal_fts_dir_<idx>_key` object **is still materialized** after migration; two
  consecutive opens keep `page_count` stable (43→43 synthetic; 43,033→43,033 real) and all
  three FTS objects remain in `sqlite_master`. `verifyTursoFtsMaterialization` (`fts-ops.ts:346`)
  does not misfire; `1a814578` is refuted on 0.8.1 (DESIGN §7, §6a item 4).
- **Q5 — ADR number collision.** `docs/plan/store-reclaim/` references a proposed
  ADR-0026 for the reclaim engine; this plan proposes ADR-0026 for the migration.
  Reconcile numbering with the owner (next free = 0026).
- **Q6 — scratch manifest** `researcher-exp/package.json:13` pins exact `0.7.2`: remove or
  bump?

## Segments

| id | segment | depends_on | status |
|---|---|---|---|
| s1 | Pre-flight spike (rollback + cross-version VACUUM + `_key`) | — | done (measured 2026-09-30; findings in DESIGN §6a) |
| s2 | Migration engine/transform (DROP+CREATE→same-version VACUUM) | s1 | pending |
| s3 | Gate observability fix (`2bf0b7c8`) | — | pending |
| s4 | CLI subcommand + offline-exclusive wiring (ADR-0013 D4) | s2 | pending |
| s5 | Pin bump + relock + constant re-measurement (OWNER-GATED) | s1,s3 | pending |
| s6 | Production-copy verification + docs + proposed ADR-0026 | s2,s4,s5 | pending |
| s7 | In-process FTS orphan destroy goes out-of-band (BL-507/BL-461) | — | in progress (this work) |

s3 is independent of s1 and may run in parallel. s1 (now complete) was entry-blocking for s2.

**s7 — the repair path (dod.7, BL-507/BL-461).** On 0.8.1 every in-process route to remove
an FTS index whose `_key` backing row is already missing is refused (`DROP INDEX` throws
`Internal error: FTS backing store … not found`; `DROP TABLE` on the system table is a parse
error; `DELETE FROM sqlite_master` is refused even under `writable_schema = ON`). The only
working route is the better-sqlite3 hatch `deleteSchemaRowsViaBetterSqlite3`. s7 shares that
hatch through a new `destroyOrphanedFtsIndex` (`fts-repair.ts`) and routes both the orphan
guard's destroy (`fts-orphan-guard.ts`) and `ensureFtsIndex`'s re-CREATE
(`verifyTursoFtsMaterialization`, `fts-ops.ts`) through it, supplying a repair context from
`turso-adapter.ts`. This corrects the earlier `dod.7` assumption that the `_key` re-leak
hazard was the only concern — the destroy path itself is the harder constraint under 0.8.1.

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

UNVERIFIED: `restoreStoreOffline` engine path for the pre-migration image (raw file copy was
verified; the engine path was not exercised). Rollback direction, cross-version VACUUM, and
`_key` existence under 0.8 are now measured (DESIGN §6a).
