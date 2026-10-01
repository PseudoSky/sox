# _shared — turso-fts-migration

Read this before any segment. The full spec is `../DESIGN.md`.

## Facts (anchored)

- Format rewrite: upstream PR **#8517** (merged 2026-08-31), shipped in `v0.8.0`
  (2026-09-28). **Not** #8085 (that is perf-only). 0.8.1 is plumbing-only.
- Boundary at **0.8.0-pre.8**: v1 persisted through 0.8.0-pre.7.
- 0.8 opens a 0.7 store; base tables + `integrity_check` OK; FTS read/write errors until
  `DROP INDEX <idx>` + `CREATE INDEX <idx> ON <t> USING fts(<cols>)`.
- No auto-migrate (`format.rs:33`). `DROP INDEX` always succeeds.
- Backing table name unchanged: `__turso_internal_fts_dir_<idx>`. The `…_key` row may be
  gone under 0.8 (`(agent-read)`) — verify.
- Leak fixed on 0.8.1: interleaved 264 vs single 266 pages (0.7.1 control still leaks).

## Hazard map (inherited from store-reclaim)

- Never raw/stock sqlite; never delete `-wal`/`-tshm`/pre-image/sidecars — rename aside
  (`staleSidecarPath`).
- Never rely on cross-version `VACUUM INTO` (UNVERIFIED); VACUUM only **same-version,
  after** the index rebuild.
- `DROP INDEX` on an FTS index orphans its directory B-tree — only VACUUM reclaims; the
  current engine "NEVER drops anything" and must be extended, not contradicted silently.
- ADR-0013: no env-var-armed migration; CLI subcommand only.
- ADR-0021: never touch `registry/index.json` / `registry:sync-index`.
- ADR-0012: `multiprocess_wal` TRUNCATE race is an open upstream hazard — no new
  WAL-checkpoint mechanism.
- `BL-235`/`BL-456`: nx targets have no dry-run; isolated worktree; quote
  `node tools/check-suite-tree-state.mjs --project <p>`.
- Commit by explicit pathspec; hooks on.

## Key files/lines

- `libs/data/store/store-adapter/src/store-rebuild.ts` — `rebuildStoreOffline:721`,
  `restoreStoreOffline:1159`, `FTS_OPTIMIZE_LEAK_MEASURED_ON:128`, `swapIntoPlace:912`,
  `stampRebuildMeta:373`, `verifyReplacement:287`, `captureFtsSentinels:226`.
- `libs/data/store/store-adapter/src/integrity.ts` — `isFtsIndex`, `parseFtsColumns`,
  `SUPPRESSION_VALID_FOR:2454`.
- `libs/data/store/store-adapter/src/fts-dialect.ts` — `tursoFtsInternalNames:78-81`,
  `resolveExistingFtsIndexName:115`, `createIndexDDL:252`.
- `libs/data/store/store-adapter/src/fts-ops.ts` — `verifyTursoFtsMaterialization:346`.
- gate: `libs/data/store/store-adapter/src/__tests__/fts-optimize-leak-gate.bl-c5249cdd.spec.ts`
  (TEST 1 `:96-117`).
- CLI: `extensions/bundles/sox-memory-bundle/members/memory-cli/src/index.ts:701,867`.

## Backlog

`89849d2a` (leak debt; root-fix confirmed at 0.8.1; LEFT OPEN) · `2bf0b7c8` (gate
observability) · related: `c5249cdd`, `cc03366b`, `794f854e`, `62027a66`, `64b59ca3`,
`4cd68c4e`.
