# Schema Unification — Migration Review

**Date:** 2026-07-11
**Status:** Architecture review of completed BL-293/300/301/295/304 and remaining BL-302

---

## 1. What shipped

| BL | Change | Commit |
|---|---|---|
| 293 | `SqliteGraphBackend` constructor calls `this.applySchema()` | `7edfd93` |
| 300/301/295 | `GRAPH_DDL` unified as superset; `memory-core` imports from graph-store | uncommitted (2 test failures) |
| 304 | Phantom-package audit resolved | `638dc8f` |
| 302 | Real migration mechanism (Migration[] array + runner) | **not started** |

---

## 2. Current state walkthrough

### 2.1 `graph-store/src/index.ts` — Unified `GRAPH_DDL`

The `node` table now carries the full superset (lines 15-45):

| Column | Source | Status |
|---|---|---|
| `kind` CHECK includes `'generic'` | BL-295 | ✓ |
| `confidence REAL` (was TEXT) | memory-core was correct | ✓ |
| `topic`, `tags`, `namespace`, `project_path`, `t_expires` | always in graph-store | ✓ |
| `level`, `resume_state` | from memory-core | ✓ |
| `is_superseded`, `access_count`, `last_access`, `t_updated` | from graph-store | ✓ |

The `edge` table (lines 47-60):

| Aspect | Status |
|---|---|
| `rel` CHECK includes `'DEPENDS_ON'` | ✓ |
| `t_expired TEXT` | ✓ (was memory-core only) |
| `CREATE UNIQUE INDEX IF NOT EXISTS ix_edge_unique ON edge(src, dst, rel)` | in GRAPH_DDL | ✓ |

Constructor (line 531-534): calls `this.applySchema()` — fixed (BL-293).

`applySchema()` (lines 538-576):
- Creates `_schema_version` table → checks version → if `< 1`: runs GRAPH_DDL, FTS_DDL, FTS_TRIGGERS, FTS rebuild, stamps version 1
- **Version gate is `currentVersion.version < 1` — once version 1 is stamped, GRAPH_DDL never runs again**

### 2.2 `memory-core/src/schema.ts` — Composed DDL

```
import { GRAPH_DDL, FTS_DDL, FTS_TRIGGERS } from '@adhd/sox-graph-store';
export const DDL = GRAPH_DDL + '\n' + FTS_DDL + '\n' + MEMORY_ONLY_DDL;
```

No private `node`/`edge` definitions remain. ✓

### 2.3 `memory-core/src/db.ts` — Remaining migrations

Lines 222-256:
```typescript
migrateAddColumn(db, 'node', 'enrich_ver', 'TEXT');      // memory-specific ✓
migrateAddColumn(db, 'node', 'embed_model', 'TEXT');      // memory-specific ✓
// topic, tags, project_path migrateAddColumn calls REMOVED (now in GRAPH_DDL) ✓
migrateOrganizerQueueCheckConstraint(db);                 // still present
```

Additionally (lines 228-230):
```typescript
db.exec(`CREATE INDEX IF NOT EXISTS ix_node_topic      ON node(topic)        WHERE topic IS NOT NULL`);
db.exec(`CREATE INDEX IF NOT EXISTS ix_node_project    ON node(project_path) WHERE project_path IS NOT NULL`);
db.exec(`CREATE INDEX IF NOT EXISTS ix_node_enrich_ver ON node(enrich_ver)   WHERE enrich_ver IS NOT NULL`);
```

These are now redundant (the same `CREATE INDEX IF NOT EXISTS` exists in GRAPH_DDL), but harmless.

### 2.4 Version tracking — three separate mechanisms

| Mechanism | Location | Value |
|---|---|---|
| `_schema_version` table | graph-store `applySchema()` | `1` |
| `sox_store_meta.schema_version` key | memory-core `stampStoreMeta()` | `"1"` |
| `memory_scope.schema_ver` column | memory-core `initScope()` | `1` |

Three version trackers are a code smell but not a migration blocker. Only graph-store's `_schema_version` gates `GRAPH_DDL` re-execution.

---

## 3. Answers to the five questions

### Q1: Does BL-302 still need the full `Migration[]` array with runner?

**No.** The unified DDL resolved the column drift. The original spec assumed pre-unification
stores would need column additions (`topic`, `tags`, `project_path`, `namespace`, `t_expires`,
`level`, `resume_state`). But:

- `topic`, `tags`, `project_path` were ALWAYS in graph-store's DDL and were added to
  memory-core stores by the old `migrateAddColumn` calls (now removed).
- `namespace`, `t_expires`, `is_superseded` were always in graph-store's DDL.
- `level`, `resume_state` were always in memory-core's DDL.
- The CHECK constraint changes (`kind` adding `'generic'`, `edge.rel` adding `DEPENDS_ON`)
  are non-blocking — no current code inserts these values.

The only genuinely blocking gap is the `ix_edge_unique` index (see Q2). A single
`CREATE UNIQUE INDEX IF NOT EXISTS` outside the version gate fixes it.

**Verdict:** The `Migration[]` array with ordered runner is over-engineered for the current
state. A lightweight incremental approach is sufficient.

### Q2: What migration gaps actually remain?

Walk through a real user with a pre-unification store:

#### Store created by `memory-core` (the common case)

1. **Columns**: All columns already exist — memory-core's old private DDL either had them
   or `migrateAddColumn` added them. ✓ No gap.

2. **`ix_edge_unique`**: **MISSING.** Memory-core's old DDL did not create this unique
   index. The version-1 gate in `applySchema()` prevents GRAPH_DDL from re-running, so
   `CREATE UNIQUE INDEX IF NOT EXISTS` never executes on re-open.

   **Impact:** `cluster.ts:346` does `ON CONFLICT(src, dst, rel)` which requires this
   unique constraint. `graph-store`'s `writeEdgeInternal()` (line 893) also uses
   `ON CONFLICT(src, dst, rel)`.

   **Failure mode:** `SqliteError: ON CONFLICT clause does not match any PRIMARY KEY or UNIQUE constraint`

   **Severity: CRITICAL** — cluster operations and edge upserts would fail on stores
   created by the old memory-core DDL (i.e., most real stores).

3. **`node.kind` CHECK**: Old stores have `CHECK (kind IN ('episode','entity','claim','community','session'))`
   without `'generic'`. No current code inserts `'generic'`, so zero impact. Severity: LOW.

4. **`edge.rel` CHECK**: Old stores (memory-core-created) lack `'DEPENDS_ON'` in the CHECK.
   No current `PUBLIC_EDGE_RELS` includes `DEPENDS_ON`, and no internal code inserts it.
   Severity: LOW (until a consumer calls `DEPENDS_ON`).

5. **`confidence` TEXT→REAL**: SQLite's flexible typing means this is cosmetic. The code
   stores string values (`'confirmed'`, `'unverified'`, etc.) regardless of the column
   type annotation. Severity: NONE.

6. **`organizer_queue` op CHECK**: Already handled by `migrateOrganizerQueueCheckConstraint(db)`.
   ✓ Covered.

7. **FTS index rebuild**: `applySchema()` only runs the FTS rebuild when version < 1. For
   a version-1 store, existing rows in `node` without FTS entries (unlikely, but possible
   if triggers were missing at insert time) would not be re-indexed. Severity: LOW.

#### Store created by `graph-store` standalone (unlikely)

Additional gaps: `level`, `resume_state` columns missing from `node`; `t_expired` missing
from `edge`. However, `cluster.ts:329` inserts `level` directly — this would fail for
standalone graph-store stores. Since `graph-store` is almost never used without
`memory-core` in practice, this is a LOW severity theoretical gap.

### Q3: Is `migrateOrganizerQueueCheckConstraint` a good enough pattern?

**Yes, with caveats.**

The rename→create→copy→drop→rename dance (lines 268-310) is the standard SQLite
table-rebuild pattern. It's correct and transactional.

Shortcomings:
- **Hard-coded to `organizer_queue`**: No reuse for `node` CHECK or `edge` CHECK rebuilds.
- **Duplicates the full CREATE TABLE SQL**: If the schema definition changes, the
  migration must be manually updated to match.
- **No general `rebuildTable(db, name, newDDL, columnMap)` helper exported**: This
  would let callers rebuild any table's CHECK without duplicating the dance logic.

**Recommendation:** Extract a `rebuildTable()` helper in graph-store's `migrations.ts`
(or directly in `index.ts`). Keep `migrateOrganizerQueueCheckConstraint` as a thin
caller of `rebuildTable()`. This adds negligible complexity and creates a pattern
for future CHECK constraint changes.

### Q4: What's the minimum viable migration story?

Assuming most users don't have production stores with the old schema:

#### Must fix now (blocking)

1. **Add `ix_edge_unique` outside the version gate.** Either:
   - In `memory-core/src/db.ts` `openDb()`, after the DDL execution, add:
     ```typescript
     db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ix_edge_unique ON edge(src, dst, rel)`);
     ```
   - Or in `graph-store/src/index.ts` `applySchema()`, add the same statement AFTER the
     version gate (so it runs unconditionally on every open).

   **Preference:** Put it in `applySchema()` — graph-store owns the edge table.

#### Should fix soon (non-blocking, but correctness)

2. **Extract `rebuildTable()`** from the `migrateOrganizerQueueCheckConstraint` pattern.
   Export it from graph-store for use by memory-core and external consumers.

3. **Add `migrateAddColumn` for `level` and `resume_state`** in `openDb()` — defensive
   coverage for the rare standalone graph-store store case. `migrateAddColumn` is
   idempotent and cheap.

#### Can defer indefinitely

4. `node.kind` CHECK rebuild — defer until code begins inserting `'generic'` kind.
5. `edge.rel` CHECK rebuild — defer until code begins inserting `DEPENDS_ON` edges.
6. Version tracking unification (merging `_schema_version`, `sox_store_meta.schema_version`,
   `memory_scope.schema_ver` into one source of truth).

### Q5: Recommendation

**Option D — Something else: Minimal fix + `rebuildTable()` extraction.**

| Action | Priority | Effort |
|---|---|---|
| Add `CREATE UNIQUE INDEX IF NOT EXISTS ix_edge_unique` to `applySchema()` outside the version gate | P0 | 1 line |
| Extract `rebuildTable()` helper from `migrateOrganizerQueueCheckConstraint` | P1 | ~30 lines |
| Add defensive `migrateAddColumn` for `level`, `resume_state` in `openDb()` | P2 | 2 lines |
| Defer full `Migration[]` array | — | — |
| Defer CHECK constraint rebuilds | — | — |

**Rationale against building the full `Migration[]` runner now:**

1. The original spec's migration runner was designed to handle column drift between
   two independent DDL copies. That drift no longer exists — there's ONE canonical
   DDL. The use case for an ordered migration array is "we changed the schema and
   need to upgrade old stores." That hasn't happened yet.

2. The only real migration needed (missing `ix_edge_unique`) is a one-line `CREATE
   UNIQUE INDEX IF NOT EXISTS` — zero complexity.

3. Building the runner now would add ~200 lines of tested code for a mechanism
   with zero current migrations to run. The first real schema change that needs it
   will be the right time to build it.

4. The `rebuildTable()` helper is a better near-term investment — it's small,
   general, and immediately useful for `migrateOrganizerQueueCheckConstraint`
   and any future CHECK changes.

---

## 4. Concrete code changes needed

### 4.1 P0: Fix `ix_edge_unique` gap

**File:** `libs/data/graph/graph-store/src/index.ts`

In `applySchema()`, after the version-gated block (after line 573, before `this.schemaApplied = true`):

```typescript
// Ensure the unique edge index exists on pre-unification stores.
// The version gate above means GRAPH_DDL (which contains this index)
// is only executed on version < 1 — stores already at version 1
// need this applied separately.
this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS ix_edge_unique ON edge(src, dst, rel)`);
```

This is idempotent (`IF NOT EXISTS`) and safe to run on every `applySchema()` call.

### 4.2 P1: Extract `rebuildTable()` helper

**File:** `libs/data/graph/graph-store/src/index.ts` (or new `src/migrations.ts`)

```typescript
/**
 * Rebuild a table with a new DDL while preserving data.
 * SQLite cannot ALTER TABLE CHECK constraints, so this is the standard
 * rename→create→copy→drop→rename dance. Runs in a transaction.
 *
 * @param db          Database handle
 * @param tableName   Table to rebuild (e.g., 'node', 'edge', 'organizer_queue')
 * @param newDDL      Full CREATE TABLE statement with the updated constraints
 * @param columnMap   Map of old column names to new column names (for renames)
 *                    or an array of column names (if no renames)
 */
export function rebuildTable(
  db: Database.Database,
  tableName: string,
  newDDL: string,
  columnMap: string[] | Record<string, string>,
): void {
  const columns: string[] = Array.isArray(columnMap)
    ? columnMap
    : Object.keys(columnMap);
  const selectCols = Array.isArray(columnMap)
    ? columns.join(', ')
    : Object.entries(columnMap).map(([old, nu]) => `${old} AS ${nu}`).join(', ');

  db.transaction(() => {
    db.exec(`ALTER TABLE ${tableName} RENAME TO ${tableName}_old`);
    db.exec(newDDL);
    db.exec(
      `INSERT INTO ${tableName} (${columns.join(', ')})
       SELECT ${selectCols} FROM ${tableName}_old`,
    );
    db.exec(`DROP TABLE ${tableName}_old`);
  })();
}
```

Then refactor `migrateOrganizerQueueCheckConstraint` to use it:

```typescript
function migrateOrganizerQueueCheckConstraint(db: Database.Database): void {
  const row = db.prepare<[], { sql: string }>(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='organizer_queue'`
  ).get();
  if (!row || row.sql.includes("'enrich'")) return;

  rebuildTable(db, 'organizer_queue', `
    CREATE TABLE organizer_queue (
      seq        INTEGER PRIMARY KEY AUTOINCREMENT,
      op         TEXT NOT NULL CHECK (op IN ('ingest','enrich','extract','link','consolidate','decay','reindex')),
      payload    TEXT NOT NULL,
      priority   INTEGER NOT NULL DEFAULT 100,
      enqueued   TEXT NOT NULL, claimed_at TEXT, done_at TEXT,
      attempts   INTEGER DEFAULT 0
    )
  `, ['seq', 'op', 'payload', 'priority', 'enqueued', 'claimed_at', 'done_at', 'attempts']);

  db.exec(`CREATE INDEX IF NOT EXISTS ix_q_open ON organizer_queue(done_at, priority, seq) WHERE done_at IS NULL`);
}
```

### 4.3 P2: Defensive column additions

**File:** `libs/memory-core/src/db.ts`

After the existing `migrateAddColumn` calls (around line 226):

```typescript
// Defensive: columns present in the unified graph-store DDL but potentially
// missing from stores created by old standalone graph-store (without memory-core).
migrateAddColumn(db, 'node', 'level', 'INTEGER');
migrateAddColumn(db, 'node', 'resume_state', 'TEXT');
migrateAddColumn(db, 'edge', 't_expired', 'TEXT');
```

These are idempotent and cheap (`PRAGMA table_info` check). They protect the rare case
of a store created by the old graph-store DDL without memory-core's columns.

---

## 5. Test coverage assessment

### Existing coverage

| Test file | What it covers | Migration relevance |
|---|---|---|
| `graph-store/src/graph-store.spec.ts` | Node/edge CRUD, bitemporal, FTS | Uses in-memory DBs; schema always fresh ✓ |
| `memory-core/src/db.spec.ts` | Tilde expansion, store meta stamping | Does NOT test old-store migration |
| `memory-core/src/embed-provenance.spec.ts` | `migrateAddColumn` idempotency, `embed_model` column | Tests column migration pattern ✓ |

### Coverage gaps

1. **No test for `ix_edge_unique` existence on re-opened stores.** A test that:
   - Creates a store, inserts edges, verifies upsert works
   - Simulates an "old store" by dropping `ix_edge_unique`
   - Re-opens and verifies the index is recreated and upsert still works

2. **No test for the `applySchema()` version gate blocking index creation.**
   A test that stamps `_schema_version` to 1, drops the index, calls `applySchema()`,
   and verifies the index is still missing (current behavior) or recreated (after fix).

3. **No test for `rebuildTable()`** (doesn't exist yet; would need tests when created).

### The "2 test failures remain"

The task mentions "2 test failures remain, not yet committed" from the BL-300/301/295 work.
These are likely related to schema changes and should be investigated before the P0 fix:

- **Possible cause 1:** `near-duplicates.spec.ts` or `cluster.spec.ts` failing because
  `ix_edge_unique` is missing on test DBs (if tests use a DB lifecycle that hits the
  version gate).
- **Possible cause 2:** Schema drift in test expectations — tests that hardcoded the
  old column list and now see new columns.
- **Possible cause 3:** `confidence` type mismatch — tests expecting TEXT `confidence`
  values now getting REAL (or vice versa).

**Not migration-related if:** the test failures are in the near-duplicate detection
logic (which was also being changed for BL-295). The spec mentions BL-295 (generic kind)
was piggybacked on the schema unification — if near-dup tests were failing before
schema changes, they may be unrelated.

---

## 6. Blast radius of the P0 fix

Adding `CREATE UNIQUE INDEX IF NOT EXISTS ix_edge_unique` to `applySchema()`:

| What depends on it | Impact |
|---|---|
| `cluster.ts:346` — `ON CONFLICT(src, dst, rel)` | Fixed — was latent bug |
| `graph-store:893` — `writeEdgeInternal()` upsert | Already working on fresh DBs, now also on old DBs |
| `memory-core` — any module calling `writeEdge()` | Protected |
| Existing tests | Should remain green — `IF NOT EXISTS` is idempotent |

**Risk: LOW.** The `IF NOT EXISTS` guard means zero impact on stores that already have
the index. The index itself is a correctness requirement for `ON CONFLICT` upserts.

---

## 7. Summary

| Question | Answer |
|---|---|
| Q1: Full `Migration[]` needed? | **No.** Column drift resolved by unification. |
| Q2: Real migration gaps? | **One gap: `ix_edge_unique` missing on old stores.** Everything else is non-blocking or cosmetic. |
| Q3: `migrateOrganizerQueueCheckConstraint` pattern good enough? | **Yes.** Should extract `rebuildTable()` for reuse. |
| Q4: Minimum viable migration? | **1 line** for `ix_edge_unique` + optional `rebuildTable()` helper. |
| Q5: Recommendation? | **D — fix `ix_edge_unique` now, extract `rebuildTable()`, defer the rest.** |

**BL-302 disposition:** The full `Migration[]` runner that the spec proposed is not
needed in its original form. BL-302 should be rescoped to:
1. Add `ix_edge_unique` outside the version gate (P0, 1 line)
2. Extract `rebuildTable()` helper (P1, ~30 lines)
3. Add defensive `migrateAddColumn` for `level`/`resume_state`/`t_expired` (P2, 3 lines)
4. Mark BL-302 as RESOLVED after (1)-(3).

The ordered migration array pattern should be built when the first real schema change
that needs it occurs — not before. Building it now would be speculative architecture
with zero migrations to run through it.
