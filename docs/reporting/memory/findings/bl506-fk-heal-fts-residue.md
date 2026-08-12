# FK-heal must drop fts5 residue before the rebuild — the permanent fix for BL-506/507/508

**Date:** 2026-08-12 · **Fix:** `383c030e` on `fix/fk-heal-fts-residue` (sox-ecosystem)
**Supersedes the manual-repair playbooks:** the shipped heal now does what the 2026-08-11
live-store repair did BY HAND. Measured against `@tursodatabase/database@0.7.1`,
better-sqlite3 12.10.0, the real pre-repair backup of the live backlog store.

---

## 1. The defect, restated with the one measurement the earlier write-ups lacked

The live-store forensics (memory 01KZSV4NMH7VTV2D55KPBRBK74) were correct, but a minimal
repro with ONLY node + edge + residue does **not** exhibit the catalog abort — the driver
registers every object, residue or not. The abort only bites when objects exist **after**
the first unparseable row: on the real store, rows 1-20 (`__drizzle_migrations`, node,
node indexes) register; rows 21-28 (fts5 residue) stop the catalog build; everything after
(29-40: `_adapter_meta`, Tantivy rows, `_sox_engine`, the rebuilt `edge`, all edge indexes)
never registers — `no such table: edge` with NO open-time error. The earlier fixtures (and
the shipped step-17 acceptance) missed the defect because they had nothing after the residue.

**Terminology (corrected framing):** the defect shape is **legacy library-domain schema
authored by a Drizzle migration that no longer exists in this repo** — the 2026-07-11
`0000_sad_onslaught.sql`, which created the explicit-rowid FK on `edge` and the fts5
residue. "Drizzle-era store" is the WRONG label: Drizzle is a live dependency in this
ecosystem (8+ adhd packages, actively imported) and owns the app tables; `node`/`edge`
and their FTS objects are LIBRARY-domain schema, so removing the residue and rebuilding
`edge` stays within the library's ownership and touches nothing Drizzle owns. The
coexistence rule is unchanged: the library owns domain DDL, Drizzle owns app tables.

## 2. The fix

`ensureCheckConstraints` now calls `dropFts5ResidueBeforeRebuild()` before the rebuild
transaction. On a turso store carrying any of the 8 dead fts5 objects (`fts_node` VT + 4
shadow tables + 3 triggers, via `FTSDialect.legacyResidueNames` — all library-domain FTS
objects; no Drizzle-owned table is ever named by the delete), it deletes those
`sqlite_master` rows via the sanctioned escape hatch — better-sqlite3 + `unsafeMode` +
`PRAGMA writable_schema=ON` + `DELETE FROM sqlite_master` — inside a
**same-instance close → drop → reopen** (`withConnectionClosedForRepair` on
`TursoAdapterImpl`, the SPEC-CONN-RECYCLE `_reconnect()` adoption pattern). The rebuilt
`edge` row then lands in a parseable region. The name-based delete also removes any
duplicate `fts_node_ai` trigger (BL-507: Turso does not dedupe `CREATE TRIGGER IF NOT EXISTS`).

Two load-bearing details discovered during implementation:

- **The caller's adapter handle must survive the heal.** The first implementation closed the
  adapter and swapped in a fresh one inside the backend — the external handle went stale
  ("The database connection is not open" on the very next query). `withConnectionClosedForRepair`
  reopens on the SAME instance, so callers (e.g. the backlog CLI) keep a valid handle. The
  better-sqlite3 write must run with the turso connection CLOSED (cross-engine WAL
  coordination — `-tshm` vs `-shm` — is what destroyed stores, BL-508).
- **The escape hatch needs `writable_schema=ON`, not just a plain better-sqlite3 open.**
  memory-core's `dropFtsResidueViaBetterSqlite3` opens WITHOUT it and therefore cannot
  touch a store carrying Tantivy `USING fts` rows (BL-329). The promoted shared function
  (`deleteSchemaRowsViaBetterSqlite3` in store-adapter/preflight.ts) uses the full
  unsafeMode + writable_schema pair, exactly like the pre-flight's `openSchemaReader`.

## 3. Acceptance that catches it (BL-508)

`fk-heal-fts-residue.bl506.spec.ts` builds the legacy fixture (node + explicit-rowid-FK
edge + node indexes + fts5 residue + a table AFTER the residue — the shape left by the
removed `0000_sad_onslaught.sql`, not a Drizzle dependency), runs the heal through the
real turso adapter, then **reopens with the raw TURSO driver** and asserts:
`PRAGMA table_list` contains `edge`; `SELECT COUNT(*) FROM edge` returns the seeded row; all
16 graph indexes register; zero `fts_node%` objects remain; edge DDL is the implicit FK
form; the caller's adapter handle still serves queries and a post-heal `writeNode` lands.
RED on pre-fix code (`expected [Array(4)] to include 'edge'`), GREEN with the fix. A
sqlite arm pins the gate: the heal must NOT drop fts5 residue on a sqlite store (it is the
store's live FTS; BL-448 AC-3 identity).

## 4. Scope boundary

A store ALREADY broken by 0.8.2's heal (edge at rowid 36, DDL already implicit) does not
re-trigger the rebuild, so the fixed code cannot heal it on open — restore the pre-heal
backup and let the fixed heal run, or apply the manual residue drop (the 2026-08-11
playbook). BL-509 (half-materialized Tantivy backing, `fts_match` = 0 hits) is a separate
pre-existing defect, untouched by this fix.

## Citations

Citations: [wip/fix-fk-heal-fts-residue, typescript, deepseek, BL-506 fix,
1: libs/data/graph/graph-store/src/index.ts (dropFts5ResidueBeforeRebuild + call site),
2: libs/data/graph/graph-store/src/fk-heal-fts-residue.bl506.spec.ts,
3: libs/data/store/store-adapter/src/preflight.ts (deleteSchemaRowsViaBetterSqlite3),
4: libs/data/store/store-adapter/src/turso-adapter.ts (withConnectionClosedForRepair),
5: libs/data/store/store-adapter/src/types.ts (TursoAdapter.withConnectionClosedForRepair),
6: tools/eslint-local/no-storage-backend-leak.cjs (blessed cfg.type !== 'turso'),
7: libs/data/store/store-adapter/src/schema-row-delete.bl506.spec.ts,
8: commit 383c030e]
