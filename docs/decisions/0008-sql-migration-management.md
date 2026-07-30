# ADR 0008 — SQL-based projects MUST implement migration management from day one

- **Status:** ACCEPTED (2026-07-11)
- **Drives:** BL-293, BL-295, BL-300, BL-301, BL-302, BL-303
- **Grounding:** schema-unification incident (2026-07-11) — two diverged copies of `node`/`edge` DDL
  with a latent `DEPENDS_ON` CHECK violation, no migration mechanism, and a declared-but-unused
  `drizzle-orm` dependency that was aspirational documentation rather than wired code.
- **Owner:** pseudosky.

## Context

Every SQLite-backed package in this repo (`graph-store`, `memory-core`, `blob-store`, `task-queue`,
`hybrid-search`, `vector-store`) defines its schema as a raw `GRAPH_DDL` / `DDL` string with
`CREATE TABLE IF NOT EXISTS` statements. Schema evolution is handled through ad-hoc mechanisms:

- `migrateAddColumn(db, table, column, type)` — simple `ALTER TABLE ADD COLUMN`, called directly in
  `openDb()` with no ordering or version tracking.
- `migrateOrganizerQueueCheckConstraint(db)` — a full rename→create→copy→drop→rename table-rebuild,
  hand-written for one specific table.
- Version tracking is spread across three independent mechanisms (`_schema_version` in graph-store,
  `sox_store_meta.schema_version` in memory-core, `memory_scope.schema_ver` in memory-core), none
  of which gate the ad-hoc migrations.

This was tolerable when the schema was static, but the schema-unification incident (BL-300/301)
proved it doesn't survive evolution:

1. `node`/`edge` DDL was duplicated across `graph-store` and `memory-core` — two copies drifted,
   producing a latent `DEPENDS_ON` CHECK violation on memory-core-created stores.
2. The `confidence` column had a type mismatch (`TEXT` vs `REAL`).
3. Adding `'generic'` to the `kind` CHECK required a table-rebuild with zero tooling support.
4. Old stores couldn't get new CHECK constraints because `CREATE TABLE IF NOT EXISTS` no-ops on
   existing tables.
5. `drizzle-orm` was declared as a dependency and documented as the migration strategy, but no
   code ever imported it — the raw SQL approach won by default, not by decision.

The custom migration runner built in BL-302 (377 lines in `migrations.ts`) is functional but
replicates what Drizzle's `drizzle-kit generate` + `drizzle-kit migrate` provide for free:
versioned migrations, automatic diff generation, transaction-per-step, and roll-forward safety.

## Decision

**Every SQL-based project in this repo MUST implement migration management from day one.**

### For new projects

1. **Define the schema as Drizzle schema objects** (`sqliteTable`, `sqliteEnum`, etc.) — not raw SQL strings.
2. **Use `drizzle-kit generate`** to produce migration SQL from schema diffs.
3. **Use `drizzle-kit migrate`** (or a thin wrapper calling Drizzle's `migrate()`) to apply migrations
   at startup.
4. **Commit generated migration SQL** alongside the schema source — migrations are source code, not
   build artifacts.
5. **Never write raw `CREATE TABLE IF NOT EXISTS`** as the primary schema definition. Raw SQL is
   acceptable only for operations Drizzle can't express (PRAGMAs, FTS5 virtual tables, sqlite-vec
   vector tables), and must be wrapped in a migration step.

### For existing projects (backfill requirement)

All existing SQL-based packages that currently use raw DDL strings must be backfilled:

| Package | Current state | Backfill target |
|---------|--------------|-----------------|
| `graph-store` | Raw `GRAPH_DDL` string + custom `Migration[]` runner (377 lines) | Port to Drizzle schema objects; delete custom runner |
| `memory-core` | Imports `GRAPH_DDL` from graph-store + raw memory-specific DDL + ad-hoc `migrateAddColumn` calls | Port memory-specific tables to Drizzle; keep importing graph-store's Drizzle schema |
| `blob-store` | Raw DDL string | Port to Drizzle |
| `task-queue` | Raw DDL string | Port to Drizzle |
| `hybrid-search` | Likely raw DDL or imports from graph-store | Port or verify |
| `vector-store` | sqlite-vec virtual tables (not expressible in Drizzle) | Wrap in a migration step; document the limitation |

### What Drizzle handles vs. what stays custom

| Schema concern | Drizzle handles? | Approach |
|---------------|-----------------|----------|
| `CREATE TABLE` with columns, types, defaults | ✅ Yes | `sqliteTable()` |
| CHECK constraints on columns | ✅ Yes | `.$type<>()` + custom check |
| UNIQUE constraints | ✅ Yes | `.unique()` |
| Indexes | ✅ Yes | `index()` |
| Foreign keys | ✅ Yes | `.references()` |
| Migration generation (`drizzle-kit generate`) | ✅ Yes | Run on schema change |
| Migration application (`drizzle-kit migrate`) | ✅ Yes | Call at startup |
| PRAGMA statements (synchronous, journal_mode) | ❌ No | Custom SQL in a migration step |
| FTS5 virtual tables + triggers | ❌ No | Custom SQL in a migration step |
| sqlite-vec virtual tables (`vec0`) | ❌ No | Custom SQL in a migration step |
| `better-sqlite3` specific APIs | ❌ No | Drizzle's `better-sqlite3` driver handles this |

### Migration protocol

Every package's startup sequence MUST follow this order:

1. Open the database (`new Database(path)`)
2. Apply PRAGMAs (synchronous, journal_mode, etc.)
3. **Run Drizzle migrations** (`migrate(db, { migrationsFolder })`) — this is the versioned,
   ordered migration runner
4. Apply any SQLite-extension-specific setup (vec0 loading, FTS5 triggers — wrapped as
   idempotent migrations or run-every-startup guards)
5. Stamp store metadata (content address, schema version — now trust Drizzle's
   `__drizzle_migrations` table instead of our custom `_schema_version`)

## Consequences

### Positive

- **Schema changes are diffed, not hand-written.** `drizzle-kit generate` produces the exact SQL
  needed to go from schema A to schema B, including table-rebuilds for CHECK changes. No more
  hand-auditing two DDL copies for drift.
- **Migrations are ordered and versioned.** Drizzle's `__drizzle_migrations` table is a
  well-tested, single source of truth for which migrations have been applied.
- **Type-safe schema definitions.** Drizzle schema objects produce TypeScript types for queries.
  Raw SQL strings produce `unknown`.
- **The custom runner (377 lines) is deleted.** Less code to maintain, fewer bugs.
- **No more ad-hoc `migrateAddColumn`.** Every schema change goes through the migration pipeline.

### Negative

- **Drizzle is a dependency.** ~200KB for `drizzle-orm` + `drizzle-kit` (dev only). Acceptable
  trade for deleting 377 lines of custom migration code.
- **Not every SQLite feature is expressible.** FTS5, sqlite-vec, and PRAGMAs still need raw SQL.
  These must be wrapped as migration steps or run-on-startup guards.
- **Schema-as-code means schema changes produce generated SQL.** The generated migration files
  must be reviewed and committed — they're not a black box. This is a process change, not a
  technical limitation.

### Neutral

- **Drizzle's query builder is available but not required.** Packages can continue using raw SQL
  for complex queries (vector search, temporal joins, batch operations). Drizzle is used for
  schema definition and migration management only — the query layer is unchanged.

## Migration path

1. Port `graph-store`'s schema to Drizzle objects (`drizzle/schema.ts`).
2. Generate the baseline migration (`drizzle-kit generate` → v1 snapshot matching current DDL).
3. Wire `migrate()` into `applySchema()` — Drizzle's runner replaces the custom `runMigrations()`.
4. Delete `migrations.ts` (the custom 377-line runner) and `runMigrations()` call sites.
5. Port `memory-core`'s memory-specific tables to Drizzle, with its own migrations folder.
6. Port `blob-store`, `task-queue`, `hybrid-search` similarly.
7. Document the FTS5 / sqlite-vec / PRAGMA escape-hatch pattern for packages that need it.
8. Update `AGENTS.md` to codify this decision as a constraint.
