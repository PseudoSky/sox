# Schema Unification — Implementation Spec

**Plan slug:** `schema-unification`
**Date:** 2026-07-11
**Branches:** BL-293, BL-300, BL-301, BL-302, BL-304
**Status:** Draft — not yet implemented

---

## 1. Problem statements

### 1.1 BL-293 (HIGH) — `createGraphBackend(db)` silently defers schema

`createGraphBackend(db)` is a pure constructor call — it never applies the DDL. A consumer
who opens a `better-sqlite3` database, calls `createGraphBackend(db)`, and then calls
`writeNode()` gets `SqliteError: no such table: node` unless they separately call
`graph.applySchema()` first. This footgun was confirmed by a real downstream consumer
(adhd/agent-mcp-authoring integration). It is masked in memory-core only because `openDb`
pre-creates the `node` table via its own private DDL before `createGraphBackend` is called.

**Evidence:** `libs/data/graph/graph-store/src/index.ts:528-530` (constructor), `:1265-1266` (factory).

### 1.2 BL-300 (MEDIUM) — Schema duplicated across graph-store and memory-core

The `node` and `edge` table DDL is defined twice:
- `libs/data/graph/graph-store/src/index.ts:15-74` (`GRAPH_DDL`)
- `libs/memory-core/src/schema.ts:43-85` (`DDL`)

They describe the **same physical tables** — `memory-core` creates them via `openDb` →
`db.exec(DDL)`, then `memory-core` passes that `db` handle into `createGraphBackend(db)` in
8 modules (enrich.ts, enrich-batch.ts, cluster.ts, neardup.ts, near-duplicates.ts,
entity-episodes.ts, list-entities.ts, related.ts). No single source of truth exists.

### 1.3 BL-301 (HIGH) — Schemas have already drifted

The two copies are **not** byte-identical. Confirmed differences:

| Aspect | graph-store `GRAPH_DDL` | memory-core `DDL` |
|---|---|---|
| `node.topic` | present | absent in base DDL, added via `migrateAddColumn` |
| `node.tags` | present | absent in base DDL, added via `migrateAddColumn` |
| `node.namespace` | present | absent |
| `node.project_path` | present | absent in base DDL, added via `migrateAddColumn` |
| `node.is_superseded` | present (`INTEGER DEFAULT 0`) | absent |
| `node.t_expires` | present | absent |
| `node.level` | absent | present (`INTEGER`) |
| `node.resume_state` | absent | present (`TEXT`) |
| `node.confidence` | `TEXT` | `REAL` (**type mismatch**) |
| `edge.t_expired` | absent | present (`TEXT`) |
| `edge.rel` CHECK | includes `PART_OF`, `DEPENDS_ON` | omits `DEPENDS_ON` |
| `ix_edge_src/dst` | unconditional | `WHERE t_expired IS NULL` |

A graph-store consumer calling `writeEdge(..., rel:'DEPENDS_ON')` against a memory-core-created
`edge` table throws a CHECK violation. This is a latent runtime bug.

### 1.4 BL-302 (HIGH) — No real migration mechanism

`graph-store`'s `applySchema()` has a `_schema_version` table and `targetVersion` gate, but
`targetVersion` is hard-coded to `1` and the only action is `db.exec(GRAPH_DDL)` — all
`CREATE TABLE/INDEX IF NOT EXISTS`. Once a DB exists at version 1, no schema change can
reach it. Bumping `targetVersion` to `2` would re-run `CREATE TABLE IF NOT EXISTS` which
no-ops on an existing table.

`memory-core` has a better start: `migrateAddColumn(db, table, column, type)` (simple
`ALTER TABLE ADD COLUMN`) and `migrateOrganizerQueueCheckConstraint(db)` (a full
rename→create→copy→drop→rename table-rebuild dance). But these are ad-hoc functions called
directly from `openDb`, not an ordered migration runner. There is no `migrations[]` array,
no per-version step, no table-rebuild helper exportable for any table.

### 1.5 BL-304 (MEDIUM) — Reframe "unused/dead/phantom" findings

Several packages were flagged as "dead" or "phantom" in earlier audits. The correct lens:
these were **built for this project** and their consumers either exist or are planned.

| Package | Status | Evidence |
|---|---|---|
| `@adhd/sox-analysis` | **Consumed** | Imported by `memory-core` (`cluster.ts:19`, `neardup.ts:13`, `importance.ts:10`) |
| `@adhd/sox-vector-store` | **Consumed** | Imported by `hybrid-search` (`index.ts:1`, `hybrid-search.spec.ts:16`) |
| `@adhd/sox-blob-store` | **Consumed externally** | `agent-source` `file:` dep (BL-166 verified) |
| `@adhd/sox-claim-verification` | **Consumed externally** | `agent-source` `file:` dep (BL-166 verified) |
| `@adhd/sox-hybrid-search` | **Consumed externally** | `agent-source` `file:` dep (BL-166 verified) |
| `@adhd/sox-graph-store` | **Consumed** | 8 modules in `memory-core` call `createGraphBackend` |
| `drizzle-orm` in graph-store | **Genuinely dead** | Zero imports; tracked as BL-303 |

**Disposition (BL-304):** No packages should be deleted. `drizzle-orm` removal is BL-303
(already a separate ticket). All other "dead" findings are resolved — packages are wired or
have verified external consumers.

---

## 2. Proposed architecture

### 2.1 Single source of truth for `node`/`edge` schema

**Decision:** `graph-store` OWNS the canonical `node`/`edge`/FTS DDL. `memory-core` imports
it, composes it with its own memory-specific tables, and deletes its private copy.

**Rationale:** `graph-store` is the package whose entire purpose is "bi-temporal graph store
over SQLite." It already exports the GRAPH_DDL/FTS_DDL/FTS_TRIGGERS constants. `memory-core`
is a domain composer that adds memory-specific tables (`memory_scope`, `sox_store_meta`,
`organizer_queue`, `request_ledger`, `promotion_queue`, `vec_node`) on top of the graph
primitives. The dependency already runs `memory-core → graph-store` (memory-core imports
`createGraphBackend`). Importing the DDL constant is zero-cost.

### 2.2 Unified node schema (reconcile the drift)

The reconciled `node` table carries the **superset** of both schemas:

```sql
CREATE TABLE IF NOT EXISTS node (
  rowid        INTEGER PRIMARY KEY,
  uid          TEXT UNIQUE NOT NULL,
  kind         TEXT NOT NULL CHECK (kind IN ('episode','entity','claim','community','session','generic')),  -- BL-295
  content      TEXT,
  name         TEXT,
  summary      TEXT,
  topic        TEXT,
  tags         TEXT,
  importance   REAL DEFAULT 1.0,
  confidence   REAL,              -- was TEXT in graph-store, NOW REAL (memory-core is correct)
  content_hash TEXT,
  namespace    TEXT DEFAULT 'global',
  meta         TEXT,
  agent_id     TEXT,
  session_id   TEXT,
  source       TEXT CHECK (source IN ('message','tool_output','observation','document','reflection','import')),
  project_path TEXT,
  level        INTEGER,           -- from memory-core
  resume_state TEXT,              -- from memory-core
  t_occurred   TEXT,
  t_expires    TEXT,              -- from graph-store
  t_created    TEXT NOT NULL,
  t_valid      TEXT,
  t_invalid    TEXT,
  is_superseded INTEGER DEFAULT 0, -- from graph-store
  access_count INTEGER DEFAULT 0,
  last_access  TEXT,
  t_updated    TEXT
);
```

**Additional columns** (`embed_model`, `enrich_ver`) added by memory-core via
`migrateAddColumn` stay in `memory-core`'s domain — they are memory-specific enrichment
columns, not graph primitives. They continue to be added by memory-core's `openDb`
as they are today. `tags` and `topic` move into the base DDL (they already existed in
graph-store and were added by memory-core's `migrateAddColumn` — the migration runner
handles the transition).

### 2.3 Unified edge schema

```sql
CREATE TABLE IF NOT EXISTS edge (
  rowid     INTEGER PRIMARY KEY,
  src       INTEGER NOT NULL REFERENCES node(rowid) ON DELETE CASCADE,
  dst       INTEGER NOT NULL REFERENCES node(rowid) ON DELETE CASCADE,
  rel       TEXT NOT NULL CHECK (rel IN ('MENTIONS','SUPPORTS','RELATES_TO','SUPERSEDES','DERIVED_FROM','MEMBER_OF','PART_OF','SAME_AS','ASSIGNED_TO','DEPENDS_ON')),
  weight    REAL DEFAULT 1.0,
  confidence REAL,
  origin    TEXT CHECK (origin IN ('extracted','inferred','user_asserted')),
  meta      TEXT,
  t_created TEXT NOT NULL,
  t_expired TEXT,               -- from memory-core (graph-store lacked it)
  t_valid   TEXT,
  t_invalid TEXT
);
```

Indexes are a superset too — `ix_edge_unique` (graph-store), `ix_edge_src/dst` with
`WHERE t_expired IS NULL` (memory-core pattern, but only if the column exists).

### 2.4 How `createGraphBackend` fails LOUD

**Fix (Option A from BL-293 recommendation):** `SqliteGraphBackend` constructor calls
`this.applySchema()` at the end. `applySchema()` is already idempotent-guarded via
`schemaApplied` flag + `_schema_version` check — the guard work is already in place.

Since `applySchema()` applies DDL for `node`/`edge`/FTS5/FTS_TRIGGERS, every
`createGraphBackend(db)` call now ensures the tables exist.

**Same question for memory-core:** after unification, `memory-core`'s `openDb` calls
`db.exec(canonicalNodeEdgeDDL)` (imported from graph-store) and then adds its own
memory-specific DDL. `createGraphBackend(db)` then calls `applySchema()` which finds
the tables already exist (version check) and no-ops. This is safe and correct.

### 2.5 Real migration mechanism

**Design:** An ordered migration array in `graph-store`, running at `applySchema()` time,
sourced from a shared migration protocol that memory-core also uses.

```typescript
// graph-store/src/migrations.ts
export interface Migration {
  version: number;
  description: string;
  up(db: Database.Database): void;
}

export const MIGRATIONS: Migration[] = [
  // v1 is implicit (base DDL)
  // v2: reconcile drift — add missing columns to pre-unification stores
  { version: 2, description: 'Reconcile schema drift: add topic, tags, namespace, project_path, etc.',
    up(db) { /* ADD COLUMN for each drift column missing from pre-unification stores */ } },
  // v3: BL-295 — relax node.kind CHECK to include 'generic'
  { version: 3, description: 'Add generic kind to node.kind CHECK constraint',
    up(db) { /* table-rebuild dance for node table with relaxed CHECK */ } },
];
```

**The migration runner** (`applySchema` rewrite):

```typescript
applySchema(): void {
  if (this.schemaApplied) return;
  // pragmas ...
  db.exec(`CREATE TABLE IF NOT EXISTS _schema_version (version INTEGER NOT NULL)`);
  const currentVersion = this.db.prepare(`SELECT version FROM _schema_version ORDER BY version DESC LIMIT 1`).get();
  const targetVersion = MIGRATIONS.length; // or MIGRATIONS[MIGRATIONS.length-1].version
  
  if (!currentVersion || currentVersion.version < 1) {
    db.exec(GRAPH_DDL);
    db.exec(FTS_DDL);
    db.exec(FTS_TRIGGERS);
    db.prepare(`INSERT INTO _schema_version VALUES (1)`).run();
  }
  
  const v = currentVersion?.version ?? 1;
  for (const m of MIGRATIONS) {
    if (m.version > v) {
      db.transaction(() => { m.up(db); })();
      db.prepare(`INSERT INTO _schema_version VALUES (?)`).run(m.version);
    }
  }
  
  this.schemaApplied = true;
}
```

**Reuse in memory-core:** `memory-core`'s `openDb` delegates to graph-store's migration
runner for the shared tables. Memory-specific migration steps (e.g., adding `embed_model`
column, organizer_queue CHECK rebuild) remain in `openDb`'s ad-hoc block but can
migrate into the same ordered-runner pattern over time.

### 2.6 How `memory-core` consumes graph-store's DDL

After unification, `memory-core/src/schema.ts`:

```typescript
import { GRAPH_DDL, FTS_DDL, FTS_TRIGGERS } from '@adhd/sox-graph-store';

// memory-specific tables only
export const MEMORY_DDL = `
  CREATE TABLE IF NOT EXISTS memory_scope (...);
  CREATE TABLE IF NOT EXISTS sox_store_meta (...);
  CREATE VIRTUAL TABLE IF NOT EXISTS vec_node USING vec0(...);
  CREATE TABLE IF NOT EXISTS organizer_queue (...);
  CREATE TABLE IF NOT EXISTS request_ledger (...);
  CREATE TABLE IF NOT EXISTS promotion_queue (...);
`;

export const DDL = GRAPH_DDL + '\n' + MEMORY_DDL;
```

The `DDL` export is kept for backward compat — existing callers of `db.exec(DDL)` in
`db.ts` continue to work, but now it's composed from the canonical source.

### 2.7 Import graph

```
graph-store (owns node/edge DDL, migrations, applySchema)
    ↑
    │ imports GRAPH_DDL, FTS_DDL, FTS_TRIGGERS, MIGRATIONS, applySchema
    │
memory-core (composes DDL, has memory-specific tables + ad-hoc migrations)
```

No new packages. No circular dependency (memory-core already depends on graph-store).

---

## 3. Sequence of changes

Each step is independent where possible, with explicit dependencies.

### Step 1: Remove `drizzle-orm` from graph-store (BL-303)

**Files:** `libs/data/graph/graph-store/package.json`
**Dependencies:** none
**Effort:** S
**Test:** `nx build graph-store && nx test graph-store` stays green
**Closes:** BL-303

### Step 2: Fix `createGraphBackend` to call `applySchema()` (BL-293)

**Files:** `libs/data/graph/graph-store/src/index.ts:528-530`
**Dependencies:** none
**Change:** Add `this.applySchema()` at end of constructor
**Effort:** S
**Test:**
- `createGraphBackend(new Database(':memory:')).writeNode(...)` succeeds without explicit `applySchema()`
- Explicit `applySchema()` after construction remains idempotent (no-op)
- Existing spec suite passes unmodified
**Closes:** BL-293

### Step 3: Reconcile the two schemas into graph-store as canonical source (BL-300 + BL-301)

**Files:**
- `libs/data/graph/graph-store/src/index.ts` — update `GRAPH_DDL` to be the superset
- `libs/memory-core/src/schema.ts` — import `GRAPH_DDL` from graph-store, delete private copy

**Dependencies:** Step 2 (graph-store DDL changes need the auto-apply fix in place)
**Effort:** M
**Changes:**
1. Rewrite `GRAPH_DDL` in graph-store to the unified `node`/`edge` schema (superset)
2. Add `'generic'` to `node.kind` CHECK (BL-295, piggybacking the DDL change)
3. Rewrite `memory-core/src/schema.ts` `DDL` to import `GRAPH_DDL` + compose memory-only tables
4. Remove `memory-core`'s private `node`/`edge` definitions
5. Remove memory-core's ad-hoc `migrateAddColumn` calls for columns now in base DDL (`topic`, `tags`, `project_path`)
6. Keep memory-specific `migrateAddColumn` calls (`embed_model`, `enrich_ver`)

**Tests:**
- Schema-equality test: `PRAGMA table_info(node)` from a graph-store-only DB matches a memory-core DB
- Drift regression test: `createGraphBackend(memoryCoreDb).writeEdge(..., rel:'DEPENDS_ON')` succeeds (was CHECK violation)
- `confidence` type test: a node written with confidence `0.95` stores `0.95` (REAL), not `'0.95'` (TEXT)
- All existing test suites pass: `nx test graph-store`, `nx test memory-core`, `nx test hybrid-search`, `nx test analysis`

**Closes:** BL-300, BL-301. Also closes BL-295 (generic kind added alongside).

### Step 4: Build real migration runner (BL-302)

**Files:**
- `libs/data/graph/graph-store/src/migrations.ts` (create)
- `libs/data/graph/graph-store/src/index.ts` — rewrite `applySchema()`
- `libs/memory-core/src/db.ts` — wire graph-store migrations into `openDb`

**Dependencies:** Step 3 (unified schema must exist before migrations can be authored)
**Effort:** M
**Changes:**
1. Create `migrations.ts` with `Migration` interface + `MIGRATIONS[]` array
2. Add `rebuildTable(db, name, newDDL, columnMap)` helper for table-rebuild migrations
3. Rewrite `applySchema()` to iterate `MIGRATIONS[]` for versions > current
4. Wire graph-store's `applySchema` call from memory-core's `openDb` (so migrations run on memory stores too)
5. Remove duplicate `migrateOrganizerQueueCheckConstraint` and fold into migration runner

**Tests:**
- v1→v2 migration test: create v1 DB with a row, register v2 migration, re-open, assert row survived + new column exists
- Negative control: old stub fails (v2 change never applies)
- Transactionality: a migration that throws mid-way leaves the DB at previous version

**Closes:** BL-302

### Step 5: BL-304 classification audit

**Files:** `BACKLOG.md` only — update dispositions
**Dependencies:** none (pure documentation)
**Effort:** S

Write a status block confirming:
- `@adhd/sox-analysis` — consumed by memory-core ✓
- `@adhd/sox-vector-store` — consumed by hybrid-search ✓
- `@adhd/sox-blob-store` — consumed externally (agent-source) ✓
- `@adhd/sox-claim-verification` — consumed externally (agent-source) ✓
- `@adhd/sox-hybrid-search` — consumed externally (agent-source) ✓
- `@adhd/sox-graph-store` — consumed by memory-core (8 modules) ✓
- `drizzle-orm` — genuinely dead → BL-303 ✓
- `embedWorker.ts` — see BL-289 disposition (in-code provenance says retired)

**Closes:** BL-304

---

## 4. Independent segments

### Segment A: BL-293 constructor fix + BL-303 drizzle remove (Steps 1-2)

- **Files:** `libs/data/graph/graph-store/src/index.ts` (constructor), `libs/data/graph/graph-store/package.json`
- **Dependencies:** none
- **Read tokens:** ~50
- **Output tokens:** ~30
- **Risk:** very low — `applySchema()` is already idempotent

### Segment B: Schema unification (Step 3)

- **Files:** `libs/data/graph/graph-store/src/index.ts` (GRAPH_DDL rewrite), `libs/memory-core/src/schema.ts` (import + compose), `libs/memory-core/src/db.ts` (remove redundant migrateAddColumn calls)
- **Dependencies:** Segment A (graph-store DDL changes need auto-apply fix)
- **Read tokens:** ~400
- **Output tokens:** ~600
- **Risk:** medium — touches live schema; must keep applied SQL byte-identical for existing columns

### Segment C: Migration runner (Step 4)

- **Files:** `libs/data/graph/graph-store/src/migrations.ts` (create), `libs/data/graph/graph-store/src/index.ts` (applySchema rewrite), `libs/memory-core/src/db.ts` (wire up)
- **Dependencies:** Segment B (unified schema must be the starting point for migration v1→v2)
- **Read tokens:** ~300
- **Output tokens:** ~500
- **Risk:** medium — migrations touch live data; must be transactional + tested against populated stores

### Segment D: BL-304 classification (Step 5)

- **Files:** `BACKLOG.md` (update BL-304 entry)
- **Dependencies:** none
- **Read tokens:** ~100
- **Output tokens:** ~80
- **Risk:** zero — pure documentation

---

## 5. Execution strategies

### Segment A — BL-293 + BL-303

1. Read `graph-store/src/index.ts` lines 527-531 to confirm constructor shape.
2. Add `this.applySchema();` as the last line of the constructor (after `this.db = db`).
3. Read `graph-store/package.json` to confirm `drizzle-orm` location.
4. Remove `drizzle-orm` from `dependencies`.
5. Run `nx build graph-store && nx test graph-store` — both must stay green.
6. The `freshBackend` helper in the spec already calls `applySchema()` explicitly —
   verify the test still passes (idempotency guard handles the double-call).

### Segment B — Schema unification

1. Read `graph-store/src/index.ts` lines 15-74 (current GRAPH_DDL).
2. Rewrite to the unified superset with all columns from both schemas.
3. Add `'generic'` to `kind` CHECK enum (BL-295).
4. Fix `confidence` type from TEXT→REAL.
5. Add `t_expired` to edge table. Add `ix_edge_unique` index.
6. Read `memory-core/src/schema.ts` in full.
7. Add `import { GRAPH_DDL } from '@adhd/sox-graph-store'` at top.
8. Replace the private `node`/`edge` SQL blocks with the import.
9. Compose `DDL = GRAPH_DDL + '\n' + MEMORY_ONLY_DDL`.
10. Read `memory-core/src/db.ts` lines 218-235 (migrateAddColumn calls).
11. Remove `migrateAddColumn(db, 'node', 'topic', ...)`, `migrateAddColumn(db, 'node', 'tags', ...)`, `migrateAddColumn(db, 'node', 'project_path', ...)` — these are now in base DDL.
12. Keep `migrateAddColumn(db, 'node', 'embed_model', ...)` and `migrateAddColumn(db, 'node', 'enrich_ver', ...)` — these are memory-specific.
13. Run full gate: `nx run-many -t build,test --projects=graph-store,memory-core,hybrid-search,analysis`.

### Segment C — Migration runner

1. Create `libs/data/graph/graph-store/src/migrations.ts`.
2. Export `Migration` interface and `MIGRATIONS: Migration[]` array.
3. Add `rebuildTable()` helper function.
4. v2 migration: adds columns missing from pre-unification stores (topic, tags, namespace, etc.).
5. v3 migration: table-rebuild for `node` to relax `kind` CHECK (adds `'generic'` per BL-295).
6. Rewrite `applySchema()` to use `MIGRATIONS`.
7. In `memory-core/src/db.ts`, after `stampStoreMeta(db)`, call graph-store's migration runner.
8. Test: create `v1` DB, seed a row, run migrations, assert row survives + `kind:'generic'` now inserts.

### Segment D — BL-304 classification

1. Read `BACKLOG.md` lines 5672-5687 (BL-304 entry).
2. Update the entry with confirmed dispositions from §1.5 of this spec.
3. Mark BL-304 as RESOLVED and move to CHANGELOG per backlog lifecycle rules.

---

## 6. Test cases

### Unit tests

**BL-293:**
- `createGraphBackend(new Database(':memory:')).writeNode('test', {kind:'episode'})` → succeeds (no prior `applySchema()`)
- `backend.applySchema(); backend.applySchema();` → no error (idempotent)

**BL-300/301 (schema equality):**
- `PRAGMA table_info(node)` from graph-store DB === `PRAGMA table_info(node)` from memory-core DB
- `graphBackend.writeEdge(1, 2, {rel:'DEPENDS_ON'})` → succeeds (was CHECK violation)
- `node.confidence` stores `0.95` (REAL), not `'0.95'` (TEXT)

**BL-302 (migration):**
- v1 DB with row → migration to v2 → row survived, new column exists
- v1 DB → migration throwing mid-way → DB still at v1 (transactional rollback)
- v1 DB with `kind:'episode'` → migration v3 → `kind:'generic'` insert succeeds

### Integration tests

- `nx test memory-core` passes with unified schema (256+ tests)
- `nx test graph-store` passes with updated DDL
- `nx test hybrid-search` passes (imports graph-store through memory-core)
- `nx test analysis` passes (imports graph-store)

### UX acceptance tests

- New consumer: `npm install @adhd/sox-graph-store` → `createGraphBackend(db)` → immediately usable (BL-293)
- Existing memory store: opens cleanly after unification, all recall queries return same results
- Live memory store pre-migration: opens, runs migrations, operates normally

---

## 7. Which BL items close after which step

| Step | Closes |
|---|---|
| Step 1 | BL-303 |
| Step 2 | BL-293 |
| Step 3 | BL-300, BL-301, BL-295 |
| Step 4 | BL-302 |
| Step 5 | BL-304 |

---

## 8. Estimated totals

| Metric | Estimate |
|---|---|
| Total files touched | 6-8 |
| New files created | 1 (`migrations.ts`) |
| Read tokens needed | ~850 |
| Output tokens needed | ~1300 |
| Total effort | M-L (2-3 implementer sessions) |
| Blast radius | graph-store, memory-core, hybrid-search, analysis |
| Risk | medium (live schema change, needs migration) |
