# STATE — turso-fts-migration

```yaml
schema: plan-state-machine/v1-light
plan: turso-fts-migration
current_state: s6-verified; only dod.10 (proposed ADR-0027) outstanding
entry_blocked_on: []       # nothing blocks; the ADR is owner-gated, not dependency-gated
authorized: true           # owner AUTHORIZED the pin bump (Q1 resolved; see §8); bump LANDED in s5
authored_at: 2026-09-30
author: architect (deepseek-flash)
```

## State

| field | value |
|---|---|
| status | s1–s5 and s7 LANDED on `main`; s6/dod.9 verified PASS; only dod.10 (proposed ADR-0027) outstanding |
| current segment | s6 (verified) — awaiting the proposed ADR |
| blocked on | nothing — the ADR is written only after owner approval |
| pin | `^0.8.1` — applied in s5 (commit `4e77e94a`), lockfile committed in the same change |

## Open questions (resolve before dispatch)

- **Q1 — owner authorization. RESOLVED (authorized; applied).** The owner authorized the pin
  bump and it **landed in segment s5** (commit `4e77e94a`; all five manifests + `pnpm-lock.yaml`).
  The leak gate was re-measured on 0.8.1 (`FTS_OPTIMIZE_LEAK_MEASURED_ON = '0.8.1'`), so both
  conditions Q1 attached to `89849d2a` are now satisfied; the item remains **open** in the graph
  (not resolved by this reconciliation — that is the owner's call).
- **Q2 — rollback direction. RESOLVED (measured CORRUPTING).** A 0.7.2 open of a 0.8.1
  store reads base tables but `FTS_READ` returns **OK with zero results and no error**;
  `integrity_check` reports `wrong # of entries in index __turso_internal_fts_dir_idx_fts_node_key`.
  A 0.7.2 **write** poisons the store — the next 0.8.1 read throws `Corrupt database: FTS
  registry scan hit an unrecognized row: meta.json`. Any 0.7 open is therefore *corrupting*;
  no downgrade may ever be offered (DESIGN §5, §6a item 1). Residual **resolved**: the
  `restoreStoreOffline` engine path is now exercised — previous-format (v1) images restore as
  success with `fts_verified:false` / `fts_skip_reason:'previous_format_unreadable_by_driver'`
  (`store-rebuild.ts:443-444`), a non-empty source `-wal` is refused with the typed
  `E_ROLLBACK_IMAGE_WAL_NOT_EMPTY` (`errors.ts:497`) rather than silently checkpointed, and both
  are covered by `store-rebuild-rollback-image.bl-00296157.spec.ts` (commit `660be41a`, merged
  `11e6960b`).
- **Q3 — cross-version VACUUM INTO. RESOLVED (measured SAFE).** A plain 0.8.1 `VACUUM INTO`
  of a checkpointed 0.7.2 v1 store produced a clean v2 store (1145 → 43 pages, sentinels
  preserved, integrity ok). §2 still orders DROP+CREATE before VACUUM — now for determinism,
  not to avoid a correctness hazard (DESIGN §6a item 3).
- **Q4 — `_key` object. RESOLVED (measured; hazard REFUTED).** Under 0.8.1 the
  `__turso_internal_fts_dir_<idx>_key` object **is still materialized** after migration; two
  consecutive opens keep `page_count` stable (43→43 synthetic; 43,033→43,033 real) and all
  three FTS objects remain in `sqlite_master`. `verifyTursoFtsMaterialization` (`fts-ops.ts:346`)
  does not misfire; `1a814578` is refuted on 0.8.1 (DESIGN §7, §6a item 4).
- **Q5 — ADR number collision. RESOLVED.** `0026` was taken by the committed agents ADR
  (`docs/decisions/0026-agents-are-tool-agnostic-capability-referenced.md`), so the next free
  number is **0027**; this plan's migration decision record is therefore **ADR-0027**
  (`docs/plan/store-reclaim/`'s proposed 0026 is displaced too).
- **Q6 — scratch manifest. STILL OPEN** — `researcher-exp/package.json:13` still pins exact
  `0.7.2`: remove or bump?

## Segments

| id | segment | depends_on | status |
|---|---|---|---|
| s1 | Pre-flight spike (rollback + cross-version VACUUM + `_key`) | — | done (measured 2026-09-30; findings in DESIGN §6a) |
| s2 | Migration engine/transform (DROP+CREATE→same-version VACUUM) | s1 | done (`3df09bc5`; out-of-band orphan destroy in `0bb7b7ee`) |
| s3 | Gate observability fix (`2bf0b7c8`) | — | done (`3df09bc5`) |
| s4 | CLI subcommand + offline-exclusive wiring (ADR-0013 D4) | s2 | done (`3df09bc5`) |
| s5 | Pin bump + relock + constant re-measurement (OWNER-GATED) | s1,s3 | done (`4e77e94a`; `FTS_OPTIMIZE_LEAK_MEASURED_ON='0.8.1'`) |
| s6 | Production-copy verification + docs + proposed ADR-0027 | s2,s4,s5 | verified PASS (dod.9); ADR-0027 drafted, not written (dod.10) |
| s7 | In-process FTS orphan destroy goes out-of-band (BL-507/BL-461) | — | done (`0bb7b7ee`) |

s3 was independent of s1 and ran in parallel. s1 was entry-blocking for s2. All segments are
now landed; the rollback-image hardening (`660be41a`, merged `11e6960b`) closed the last
pre-ADR gap.

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

RESOLVED: `restoreStoreOffline` engine path for the pre-migration image is now exercised by
`fts-format-migration.bl-89849d2a.spec.ts` and `store-rebuild-rollback-image.bl-00296157.spec.ts`
(previous-format success with `fts_verified:false`; non-empty `-wal` refusal). Rollback
direction, cross-version VACUUM, and `_key` existence under 0.8 were measured (DESIGN §6a).
