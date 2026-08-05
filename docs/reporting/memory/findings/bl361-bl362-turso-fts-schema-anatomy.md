# Turso FTS schema anatomy — what actually panics, and the damage recipe that works

**Date:** 2026-08-05 · **Packets:** PKT-69 (BL-361), PKT-70 (BL-362)
**Measured against:** `@tursodatabase/database@0.7.1`, `better-sqlite3@12.10.0`, Node 24.11.1, macOS.
Every claim below is from a run, not from reading.

---

## 1. The three rows a Turso FTS index materialises

`CREATE INDEX idx_fts_node ON node USING fts (content)` writes **three** `sqlite_master` rows:

| name | type | rootpage | what it holds |
|---|---|---|---|
| `idx_fts_node` | index | `0` | nothing — it has no btree of its own |
| `__turso_internal_fts_dir_idx_fts_node` | table (`path, chunk_no, bytes`) | real page | **nothing, ever — 0 rows in every state, healthy or dead** |
| `__turso_internal_fts_dir_idx_fts_node_key` | index `USING backing_btree (path, chunk_no, bytes)` | real page | **the Tantivy segments — this is the FTS content** |

This single table is why four of BL-362's recipes failed. The obviously named object
(`…_fts_dir_…`, the "directory" *table*) is a decoy: it is empty by design. The content lives in the
`_key` **index**, which is the object nobody aimed at.

## 2. BL-361: `connect()` does **not** panic — `fts_match` does

BL-361 states the panic happens inside `connect()`. It does not. On a store whose FTS index row
survives without its backing objects, each of the following was run in a fresh process against a
freshly damaged store:

| statement | outcome |
|---|---|
| `connect(path, {experimental:['index_method','multiprocess_wal']})` | **succeeds** |
| `SELECT 1` | succeeds |
| `SELECT id FROM node` | succeeds |
| `SELECT name FROM sqlite_master` | succeeds |
| `INSERT INTO node …` | succeeds (the orphaned index is simply not maintained) |
| `CREATE INDEX IF NOT EXISTS … USING fts` | succeeds (no-op) |
| `DROP INDEX idx_fts_node` | **succeeds** |
| `SELECT … WHERE fts_match(content, ?)` | **`panicked at core/vdbe/execute.rs:13189` → SIGABRT, exit 134** |

Deterministic, 3/3 per variant. The earlier "connect() panics" reading came from repro scripts that
ran `connect()` and an `fts_match` in one breath.

**The operational conclusion is unchanged, and that is why BL-361 stays valid:**
`TursoAdapterImpl.connect()` reaches `fts_match` by itself — `runOpenTimeIntegrity` →
`probeFtsIndexes` → sentinel round-trip. So an ordinary adapter open *does* abort the host process.
`preflight-panic.bl361.test.ts`'s marker-absent arm asserts exactly that, in a child process.

Two variants both panic:
- backing **table** row and `_key` row both deleted → panic on `fts_match`
- `_key` row alone deleted (table present) → panic on `fts_match`

One variant does **not**:
- backing **table** row alone deleted (`_key` present) → catchable
  `Corrupt database: sqlite_schema contains index for missing table …` at `connect()`.

## 3. `better-sqlite3` can read a Turso-FTS schema — with **two** settings, not one

BL-362 recorded `PRAGMA writable_schema = ON` as the escape hatch. On better-sqlite3 that pragma is
**silently a no-op**: better-sqlite3 enables SQLite's *defensive* mode by default. The full recipe is

```js
const db = new Database(path);   // or { readonly: true } — both work
db.unsafeMode(true);             // ← without this the next line does nothing
db.pragma('writable_schema = ON');
db.prepare('SELECT type, name, rootpage, sql FROM sqlite_master').all();  // works
```

Without `unsafeMode(true)`, every schema-touching statement throws BL-329's
`malformed database schema (__turso_internal_fts_dir_idx_fts_node_key) - near "USING": syntax error`
— which is why the escape hatch reads as non-existent from BL-329's side. Both are true; they are
different connection configurations of the same driver.

Sidenote worth keeping: Node's built-in `node:sqlite` (SQLite 3.50.4) needs only the pragma, because
it is not defensive. better-sqlite3 ships the *newer* SQLite (3.53.1) and still fails without
`unsafeMode` — this is a build-flag difference, not a version difference.

Reads are safe against a hot Turso WAL: a read-only better-sqlite3 connection returned post-WAL
rootpages (verified against a store with a 49 KB uncheckpointed WAL), so the Turso WAL is
SQLite-readable. Writes through this path were also verified to survive a subsequent Turso open.

## 4. The BL-362 fixture that works

Repoint **`__turso_internal_fts_dir_<index>_key`** at a freshly created, empty index btree — the same
mechanism as the existing `seedUnpopulatedIndex` helper, aimed at the object Turso keeps FTS content
in:

```js
db.unsafeMode(true);
db.pragma('writable_schema = ON');
db.exec('CREATE TABLE IF NOT EXISTS _damage_scratch (z TEXT)');
db.exec('CREATE INDEX _damage_scratch_ix ON _damage_scratch (z)');
// take _damage_scratch_ix's rootpage, then:
db.prepare('UPDATE sqlite_master SET rootpage = ? WHERE name = ?')
  .run(scratchRootpage, '__turso_internal_fts_dir_idx_fts_node_key');
db.prepare("DELETE FROM sqlite_master WHERE name IN ('_damage_scratch','_damage_scratch_ix')").run();
db.pragma('writable_schema = RESET');
```

Result: every `sqlite_master` row is still present (so **nothing panics** — this is the
empty-but-present requirement), the store opens normally, and `fts_match` returns 0 rows for a token
that is demonstrably in the indexed text. `probeFtsIndexes` reports
`damaged / repairable / probeValidated`, `CREATE INDEX IF NOT EXISTS` no-ops on it (the BL-347
mechanism), and `repairFtsIndex`'s `DROP INDEX` + `CREATE INDEX … USING fts` restores it.

No anonymised copy of the live store was needed; the fallback in BL-362 is unused.

## 5. What is still open

- **Whether this state occurs naturally is still unknown.** Both damage shapes were produced by hand.
  The pre-flight's log line says so and states that a sighting in the wild reclassifies BL-361 to
  HIGH — so the evidence arrives by itself rather than needing someone to remember.
- **The marker gate has a hole, by construction.** The pre-flight runs only when the previous session
  left its open marker behind. A store damaged during a session that afterwards closed cleanly still
  reaches `fts_match` and still dies. Now that §2 shows `DROP INDEX` works on the open connection, a
  cheap unconditional in-process guard is possible (one `sqlite_master` read before the FTS probe
  issues any `fts_match`) — proposed to the owner, not implemented here.
- **Upstream.** Filed as https://github.com/tursodatabase/turso/issues/8216 — a `panic!` on
  malformed schema is a driver defect regardless of how well we route around it. The repro is `libs/data/store/store-adapter/src/__tests__/fixtures/bl361-open-child.ts`
  plus the damage helper in `preflight-panic.bl361.test.ts`.

## Citations

Citations: [wip/turso-live-metrics, debugger, claude, PKT-69/PKT-70,
1: libs/data/store/store-adapter/src/preflight.ts,
2: libs/data/store/store-adapter/src/turso-adapter.ts:260-300,346-355,594-601,
3: libs/data/store/store-adapter/src/__tests__/preflight-panic.bl361.test.ts,
4: libs/data/store/store-adapter/src/__tests__/turso-fts-damage-fixture.bl362.test.ts,
5: libs/data/store/store-adapter/src/__tests__/fixtures/bl361-open-child.ts,
6: libs/data/store/store-adapter/src/adapter-meta.ts:102-125,
7: libs/data/store/store-adapter/src/integrity.ts:866-1012 (probeFtsIndexes), :1924-1947 (repairFtsIndex), :2463-2487 (runOpenTimeIntegrity),
8: libs/data/store/store-adapter/src/__tests__/integrity-selfheal.test.ts:83-147 (the seed-helper precedent),
9: libs/data/store/store-adapter/src/errors.ts:14-70 (BL-329's framing, reconciled in §3)]
