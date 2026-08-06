# SPEC — BL-447: defuse the substring-probe rebuild trigger before any DDL CHECK is edited

Worktree: `/Users/nix/dev/ai/sox-ecosystem/.worktrees/bl447-ddl-substring-probe`
Branch: `feat/bl447-ddl-substring-probe`
Package: `@adhd/sox-graph-store` (`libs/data/graph/graph-store`), version 0.5.3, PUBLIC, published.

This spec is authoritative. Do not make a judgement call the spec does not already make —
if you find one, that's a bug in the spec; stop and escalate rather than guessing.

---

## 0. Pre-flight (do this before touching any file)

1. Confirm no one else has this file open right now:
   `git log -3 --oneline -- libs/data/graph/graph-store/src/index.ts` in this worktree, AND
   `git -C ../turso-adapter status --porcelain -- libs/data/graph/graph-store/src/index.ts`
   (BACKLOG.md flags a conflict risk with FEAT-SOX-001/Turso-adapter work touching this same
   file). As of this spec being written, both are clean — re-check before you start; if either
   shows uncommitted work on `index.ts`, stop and escalate rather than editing around it.
2. `npx nx test graph-store` must be green **before** you change anything (baseline). It is —
   confirmed 2026-08-06, 46/46 passing, `node tools/check-suite-tree-state.mjs --project
   graph-store` reports CLEAN in this worktree.

---

## 1. Root cause (file:line citations — all opened directly)

`SqliteGraphBackend.ensureCheckConstraints()` —
`libs/data/graph/graph-store/src/index.ts:811-852` — is called unconditionally from
`applySchema()` at `:806`, itself called from `ensureCheckConstraints()`'s only two call sites in
this repo that matter: `graph-store.spec.ts`'s `freshBackend()` helper, and the two other in-repo
spec suites that exercise the public `createGraphBackend(...).applySchema()` contract
(`analysis.spec.ts`, `hybrid-search.spec.ts` — confirmed via
`grep -rln "createGraphBackend|SqliteGraphBackend"` across the repo, and via GitNexus's own
`applySchema` call-graph, which reports only `makeGraphBackend`/`freshBackend`/
`createTestGraphStore` as callers). **`applySchema()` is never invoked from
`libs/memory-core/src/db.ts`'s live open path today** — `db.ts:329,510` applies `GRAPH_DDL`
directly (via `schema.ts:90`'s `DDL_BASE`) and runs its own hand-rolled `migrateAddColumn` calls
(`db.ts:416-501`) that never touch the `kind`/`rel` CHECK at all. This does not make the defect
lower priority: `applySchema()` is the **published public entry point** of a 0.5.3 npm package —
its contract must be correct for every consumer, in-repo test suites today and any future
memory-core wiring or external consumer tomorrow — and BL-438 D1/D4 edit the DDL constants in
*this same file*, which is what arms the bug regardless of who currently calls `applySchema()`.
State this finding to the reviewer as new information; it does not change the required fix, only
the "how live is this today" framing the backlog item understated.

The defect itself, at `:817-825`:

```ts
const nodeRow = await this.adapter.executeGet<{ sql: string }>(
  `SELECT sql FROM sqlite_master WHERE type='table' AND name='node'`,
);
const nodeNeedsRebuild = !!nodeRow && !nodeRow.sql.includes("'generic'");   // :820

const edgeRow = await this.adapter.executeGet<{ sql: string }>(
  `SELECT sql FROM sqlite_master WHERE type='table' AND name='edge'`,
);
const edgeNeedsRebuild = !!edgeRow && !edgeRow.sql.includes("'DEPENDS_ON'"); // :825

if (nodeNeedsRebuild || edgeNeedsRebuild) {
  await this.adapter.transaction(async (tx) => {
    if (nodeNeedsRebuild) {
      await rebuildTable(this.adapter, 'node', NODE_TABLE_DDL, NODE_COLUMNS, { skipDrop: true, tx });
    }
    if (edgeNeedsRebuild) {
      await rebuildTable(this.adapter, 'edge', EDGE_TABLE_DDL, EDGE_COLUMNS, { skipDrop: true, tx });
    }
    // ... :836-849: DROP TABLE *_old, rebuild 11 node indexes / 4 edge indexes,
    // re-wire FTS triggers, re-INSERT the entire fts_node content
  });
}
```

`'generic'` occurs in this file **only** at `:262`, inside `NODE_TABLE_DDL`'s
`CHECK (kind IN (...))`. `'DEPENDS_ON'` occurs **only** at `:294`, inside `EDGE_TABLE_DDL`'s
`CHECK (rel IN (...))`. `rebuildTable` itself is
`libs/data/graph/graph-store/src/rebuild-table.ts:41-55` (`doRebuild`) — a real
rename→create→copy→optional-drop against `better-sqlite3`, the exact mechanism BL-313
(`CHANGELOG.md:1986-2040`) proved deletes every edge on a real store when it goes wrong, and the
same *class* of substring-sentinel BL-295 used and was reverted for (`git show 0ce39c7 --
libs/data/graph/graph-store/src/index.ts`, `nodeKindsMissing`).

**Why the literal-substring design cannot be patched by refining the literal.** BL-438 D1 removes
the `kind` CHECK from the fresh-creation DDLs (`graphDdl()` at `:62`, `INLINE_MIGRATION_DDL` at
`:181` — the DDL `applySchema()` actually executes at `:796` to create a table, see §2) but D3
rules the CLOSED-schema rebuild targets `NODE_TABLE_DDL`/`EDGE_TABLE_DDL` (`:259-303`) stay
untouched. After that lands there are three live-DDL shapes `ensureCheckConstraints` must tell
apart, and two of them are **indistinguishable by literal-substring search alone**:

1. A store freshly created (or migrated) after D1 lands: no CHECK on `kind` at all. Correct
   action: **do nothing, ever** — this store is deliberately open-schema, and BL-438 D3 forbids
   auto-migrating it further.
2. A store already at the current CLOSED shape (CHECK present, `'generic'` in the enum list).
   Correct action: do nothing.
3. A genuinely ancient store predating `'generic'` being added to the enum at all (CHECK present,
   `'generic'` absent from the IN-list). Correct action: rebuild to the closed shape — this is
   `ensureCheckConstraints`'s original, still-legitimate job.

Case 1 and case 3 both fail `sql.includes("'generic'")` — a literal search cannot tell them apart,
which is exactly the rebuild-loop-on-an-already-open-store defect. **A structural check for
whether a CHECK clause on the column exists at all** *does* separate them: case 1 has no CHECK
clause on `kind`, full stop; cases 2 and 3 both do. That structural gate is the fix; §3 keeps the
literal search only as the second-stage decision *inside* "a CHECK exists," where it still
correctly distinguishes case 2 from case 3.

---

## 2. The two DDL quoting styles you must both match (read this before writing the regex)

`applySchema()` (`:789-809`) executes `INLINE_MIGRATION_DDL` (`:177-255`, Drizzle-quoted
identifiers) to create tables, **not** `graphDdl()`/`GRAPH_DDL` (`:55-124`, bare identifiers) —
`GRAPH_DDL` is exported for `memory-core`'s separate `db.ts` path and is irrelevant to
`SqliteGraphBackend`. So the live `sqlite_master.sql` text `ensureCheckConstraints` reads back can
be in **either** of two forms depending on how the table was created, and your predicate must
match both:

- `INLINE_MIGRATION_DDL` (`:181`, `:213` — quoted): `` "kind" text NOT NULL CHECK ("kind" IN (...)) ``
  and `` "rel" text NOT NULL CHECK ("rel" IN (...)) ``.
- `NODE_TABLE_DDL`/`EDGE_TABLE_DDL` (`:262`, `:294` — bare, the `rebuildTable` target, so this is
  what a table looks like **after** a rebuild has run): `` kind TEXT NOT NULL CHECK (kind IN (...)) ``
  and `` rel TEXT NOT NULL CHECK (rel IN (...)) ``.

Both were opened and confirmed byte-for-byte at those line numbers. `CHECK` and `IN` are uppercase
in every occurrence in this file; the column identifier is optionally double-quoted. Design the
predicate to match on that basis, not on the enum values.

---

## 3. The change — file by file

### 3.1 `libs/data/graph/graph-store/src/index.ts` — the only file that changes

**Add** a module-scope helper immediately above `export class SqliteGraphBackend` (i.e. directly
after `buildOrderClause`, before line 775 in the current file):

```ts
/**
 * BL-447 — structural presence check, not a literal-value probe.
 *
 * True iff the live DDL text declares a CHECK constraint on `column` at all — true for both
 * quoting styles this file emits: `INLINE_MIGRATION_DDL`'s Drizzle-quoted
 * `CHECK ("kind" IN (...))` and `NODE_TABLE_DDL`/`EDGE_TABLE_DDL`'s bare `CHECK (kind IN (...))`
 * (the shape a table has after `rebuildTable` has run against it). False once BL-438 D1/D4 drop
 * the CHECK from the fresh-creation DDLs (`graphDdl()`, `INLINE_MIGRATION_DDL`) — at that point
 * every freshly created or already-open-schema store reports `false` here, forever, and
 * `ensureCheckConstraints` never rebuilds it again.
 *
 * This replaces a literal-value search (`sql.includes("'generic'")` /
 * `sql.includes("'DEPENDS_ON'")`) that could not tell "CHECK absent because this store predates
 * the enum value" from "CHECK absent because this store is deliberately on the open schema" —
 * both looked identical to a literal search, which is what armed a rebuild-on-every-open loop the
 * moment the CHECK was removed from fresh DDL (BL-447). A structural presence check has no such
 * ambiguity: an open-schema store simply has no CHECK clause on this column.
 */
function hasEnumCheckConstraint(sql: string, column: 'kind' | 'rel'): boolean {
  return new RegExp(`CHECK\\s*\\(\\s*"?${column}"?\\s+IN\\b`).test(sql);
}
```

**Replace** `:820` and `:825` (inside `ensureCheckConstraints`) — everything else in the method
(`:811-819`, `:826-852`) is unchanged:

```ts
// BEFORE
const nodeNeedsRebuild = !!nodeRow && !nodeRow.sql.includes("'generic'");
// ...
const edgeNeedsRebuild = !!edgeRow && !edgeRow.sql.includes("'DEPENDS_ON'");

// AFTER
const nodeNeedsRebuild =
  !!nodeRow && hasEnumCheckConstraint(nodeRow.sql, 'kind') && !nodeRow.sql.includes("'generic'");
// ...
const edgeNeedsRebuild =
  !!edgeRow && hasEnumCheckConstraint(edgeRow.sql, 'rel') && !edgeRow.sql.includes("'DEPENDS_ON'");
```

That is the entire production diff: one new pure function, two `&&`-narrowed conditions. No other
line in `ensureCheckConstraints`, `applySchema`, `addColumnIfMissing`, or `rebuildTable` changes.

### 3.2 New test file — `libs/data/graph/graph-store/src/ensure-check-constraints.bl447.spec.ts`

New file (the `vitest.config.ts` include glob is `src/**/*.{spec,test}.ts`, confirmed — any name
matching that pattern is picked up automatically, no config edit needed). Full content spec is
§4/§5 below (acceptance criteria doubles as the test spec — do not invent additional scenarios or
drop any of the listed assertions).

### 3.3 Files that must NOT change, and why

- **`NODE_TABLE_DDL` / `EDGE_TABLE_DDL`** (`:259-303`) — the `rebuildTable` target constants. They
  stay the CLOSED shape (CHECK present) forever; that is what makes them a safe automatic-upgrade
  target under D3. Editing them is BL-439/440/448's job, explicitly gated behind this item landing
  first. Touching them here would be doing D1's job inside a ticket whose entire point is to make
  D1 safe to do later.
- **`graphDdl()` / `GRAPH_DDL` / `INLINE_MIGRATION_DDL`'s CHECK clauses** (`:62`, `:94`, `:181`,
  `:213`) — same reasoning. This ticket prepares `ensureCheckConstraints` to survive that future
  edit; it does not perform the edit.
- **`rebuild-table.ts`** — the rebuild mechanism itself is not the defect (it does exactly what it
  says); the defect is only in the trigger condition. No change needed or wanted.
- **`writeNode`'s TS-level kind validation (`:862-870`), `DEFAULT_NODE_KINDS` (`:257`),
  `writeEdgeInternal` (`:1074-1096`)** — BL-448's scope, not this item's.
- **`libs/memory-core/src/db.ts` / `schema.ts`** — confirmed by direct read that
  `SqliteGraphBackend.applySchema()` is not on memory-core's live open path today (§1). Do **not**
  wire `db.ts` to start calling `ensureCheckConstraints()` as part of this ticket — that is a
  separate decision for whichever packet needs it, and doing it here would silently expand this
  ticket's blast radius onto the live `~/.memory/memory.db` open path without that packet's own
  review.
- **`COMPILED_INTERFACES.md`** — no public interface changes; `hasEnumCheckConstraint` is
  module-private, not exported.

---

## 4. Every decision, ruled

**D-1: mechanism — structural CHECK-presence gate (chosen) vs. `PRAGMA user_version` vs.
`_adapter_meta` versioned marker (both considered, both lose).**

A version counter (either `PRAGMA user_version`, unused anywhere in this codebase today — confirmed
via `grep -rn "user_version"` returning zero hits — or a new `_adapter_meta` key, the table already
built by `libs/data/store/store-adapter/src/adapter-meta.ts`) was the finding doc's first-listed
option and was seriously evaluated. It loses for three concrete reasons, not stylistic ones:

1. **Ordering is not guaranteed.** `_adapter_meta` is created and stamped in
   `SqliteAdapterImpl.init()` (`sqlite-adapter.ts:185-202`) / `TursoAdapterImpl`'s equivalent, which
   is called by `createStoreAdapter()` (`factory.ts:88-90`) — **not** by the `SqliteGraphBackend`
   constructor or by `applySchema()`. `graph-store.spec.ts`'s own `freshBackend()` helper
   (`:18-23`) never calls `adapter.init()` at all — it goes straight from
   `new SqliteAdapterImpl(':memory:')` to `backend.applySchema()`. A fix that depends on
   `_adapter_meta` existing would either silently no-op the version check against every in-repo
   test store today, or require editing three spec files' fixture helpers as a precondition of a
   CRITICAL fix — scope creep this ticket should not need.
2. **Read-only opens skip stamping entirely** — `stampAdapterMeta` returns immediately when
   `adapter.config.readonly === true` (`adapter-meta.ts:77`), and `SqliteAdapterImpl.init()` itself
   returns immediately on a readonly config (`sqlite-adapter.ts:186`). `memory-core/src/db.ts:928`
   opens a readonly adapter for at least one code path. A version-marker design has to special-case
   "no marker present, but also not necessarily legacy" for every readonly open; the structural
   check has no such case — it just reads the DDL, which exists regardless of write access.
3. **It is strictly more moving parts for the same guarantee.** `PRAGMA user_version` would work
   (verified both adapters implement `pragmaGet`/`pragmaSet` generically via bare `PRAGMA key [=
   value]` — `sqlite-adapter.ts:272-280`, `turso-adapter.ts:529-537` — so it is not blocked by a
   capability gap), but it adds a second source of truth (a version integer) that has to be kept in
   sync with the DDL it describes, is a *new* piece of on-disk state a corrupt/hand-edited store
   could desync from the DDL it actually has, and buys nothing the structural check doesn't already
   give for free by reading the DDL directly, which is the only fact that actually determines
   whether a rebuild is needed.

The structural gate reads the same `sqlite_master.sql` row `ensureCheckConstraints` was already
fetching, adds one pure function, needs no new table, no init-ordering dependency, and works
identically on read-only and in-memory stores.

**D-2: keep the literal-value check (`'generic'`/`'DEPENDS_ON'`) as a second-stage test inside the
structural gate, rather than deleting it — ruled: keep it.**

Deleting it and rebuilding on "CHECK present, whatever it says" would trigger a rebuild on
**every** currently-closed store on every open, forever (case 2 in §1 would misfire) — a strictly
worse regression than today, since today's bug at least leaves already-closed stores alone. The
literal check's only defect was being reachable when no CHECK exists at all; gated behind
"a CHECK exists," it is exactly the discriminator case 3 vs. case 2 needs, and it was already
correct for that narrower question before this ticket.

**D-3: `NODE_TABLE_DDL`/`EDGE_TABLE_DDL` stay closed forever, not "closed until D1's operator
migration lands" — ruled: forever, out of scope for this ticket to even discuss changing.**

The finding doc is explicit that the open DDL is reachable only from BL-442's operator command,
never from `ensureCheckConstraints`'s automatic path. This item does not revisit that ruling; it
only makes the automatic path unable to misfire once D1 changes the *fresh-creation* DDL elsewhere
in this same file.

**D-4: test the future DDL shape without waiting for D1 — ruled: construct a test-local DDL string
in the new spec file, do not import from `graphDdl()`/`INLINE_MIGRATION_DDL`.**

BL-447 must land and be provably correct **before** any DDL constant loses its CHECK (that is the
whole point — it gates D1/D4). The acceptance criteria therefore require exercising "what happens
when a store's live DDL has no CHECK on `kind`/`rel`" without actually editing `graphDdl()` /
`INLINE_MIGRATION_DDL` yet. §5.1 gives the exact literal DDL string to use for this — copy it
verbatim; do not derive it by string-manipulating the real constants at test time (that would test
a regex against a computed string instead of against DDL text a real future store will actually
carry).

---

## 5. Acceptance criteria (BL-447) — each with its RED arm

All four run inside `ensure-check-constraints.bl447.spec.ts`. Use the temp-file pattern already
established in `libs/data/store/store-adapter/src/__tests__/migration-e2e.test.ts:20-52`
(`mkdtempSync(join(tmpdir(), 'graph-store-bl447-'))`, one `.db` file per test, `afterEach`
close+cleanup) — **not** `:memory:`, because these tests must close and reopen a real adapter
against the same file to prove state persisted correctly across "cold opens," and `:memory:`
databases do not survive closing the connection.

### 5.1 Criterion A — zero rebuilds on an already-open-schema store, across two cold opens

**Setup DDL** (test-local constant, do not import from index.ts — see D-4):

**ARCHITECT AMENDMENT (post-implementation, ruling on implementer's open question #2):** the
original text below omitted `access_count`, `last_access`, `t_updated` — three columns the real
`NODE_TABLE_DDL` (`index.ts:284-287`) and `NODE_COLUMNS` (`index.ts:305-311`) both carry. That
was a spec bug, inconsistent with this section's own stated intent ("this is `NODE_TABLE_DDL`'s
exact column set … with only the CHECK clause removed"). Confirmed by the implementer running the
original literal DDL: `rebuildTable`'s `NODE_COLUMNS`-driven `INSERT INTO node (...) SELECT ...
FROM node_old` crashed with `SqliteError: no such column: access_count` instead of producing the
clean rootpage-mismatch RED assertion this section describes — i.e. the bug below would have
under-tested the real defect shape. The DDL is corrected in place below (3 columns added,
matching `CLOSED_NODE_DDL`, which already had them correct). Ruling: keep the corrected fixture.

```ts
const OPEN_SCHEMA_NODE_DDL = `CREATE TABLE node (
  rowid        INTEGER PRIMARY KEY,
  uid          TEXT UNIQUE NOT NULL,
  kind         TEXT NOT NULL,
  content      TEXT,
  name         TEXT,
  summary      TEXT,
  topic        TEXT,
  tags         TEXT,
  importance   REAL DEFAULT 1.0,
  confidence   REAL,
  content_hash TEXT,
  namespace    TEXT DEFAULT 'global',
  meta         TEXT,
  agent_id     TEXT,
  session_id   TEXT,
  source       TEXT CHECK (source IN ('message','tool_output','observation','document','reflection','import')),
  project_path TEXT,
  level        INTEGER,
  resume_state TEXT,
  is_superseded INTEGER DEFAULT 0,
  t_occurred   TEXT,
  t_expires    TEXT,
  t_created    TEXT NOT NULL,
  t_valid      TEXT,
  t_invalid    TEXT,
  access_count INTEGER DEFAULT 0,
  last_access  TEXT,
  t_updated    TEXT
)`;

const OPEN_SCHEMA_EDGE_DDL = `CREATE TABLE edge (
  rowid     INTEGER PRIMARY KEY,
  src       INTEGER NOT NULL REFERENCES node ON DELETE CASCADE,
  dst       INTEGER NOT NULL REFERENCES node ON DELETE CASCADE,
  rel       TEXT NOT NULL,
  weight    REAL DEFAULT 1.0,
  confidence REAL,
  origin    TEXT CHECK (origin IN ('extracted','inferred','user_asserted')),
  meta      TEXT,
  t_created TEXT NOT NULL,
  t_expired TEXT,
  t_valid   TEXT,
  t_invalid TEXT
)`;
```

(This is `NODE_TABLE_DDL`/`EDGE_TABLE_DDL`'s exact column set with only the `CHECK (kind IN (...))`
/ `CHECK (rel IN (...))` clause removed — i.e. exactly what those two constants will look like the
day D1/D4 land, since D1/D4 do not touch any other column. `is_superseded`/`t_expired` are included
directly in the DDL here — unlike production, where `addColumnIfMissing` adds them — precisely so
this test's rebuild-detection isn't confounded by the unrelated `addColumnIfMissing` ALTER TABLEs
that always run first.)

**Steps:**

1. Create adapter on a temp file path. `adapter.exec('PRAGMA foreign_keys = ON')`,
   `adapter.exec(OPEN_SCHEMA_NODE_DDL)`, `adapter.exec(OPEN_SCHEMA_EDGE_DDL)`.
2. Insert 2 node rows and 1 edge row directly via `adapter.executeRun` (real data — the "populated
   edge table" requirement from the backlog item's acceptance text) with `rel` set to a value NOT
   in the historical enum (e.g. `'CUSTOM_REL'`) — proving nothing constrains it, i.e. this really is
   open-schema, not accidentally still-closed.
3. Capture identity before first open: `SELECT rootpage FROM sqlite_master WHERE type='table' AND
   name IN ('node','edge')` → two rootpage integers. Also capture the full `sql` text for both
   tables and `SELECT COUNT(*) FROM node` / `FROM edge`.
4. `const backend = createGraphBackend(adapter); await backend.applySchema();` (first open/apply).
5. Re-read rootpages, `sql` text, and row counts. **Assert: identical to step 3** — `applySchema()`
   must not touch a store that already has no CHECK on `kind`/`rel`, not even once.
6. Close the adapter. Open a **new** `SqliteAdapterImpl` on the same file path (simulating a real
   process cold-open). `const backend2 = createGraphBackend(adapter2); await
   backend2.applySchema();` (second open).
7. Re-read rootpages, `sql` text, row counts, and `PRAGMA foreign_keys`. **Assert:** rootpages
   unchanged from step 3, `sql` text byte-identical to step 3 for both tables, row counts unchanged
   (2 nodes, 1 edge), `foreign_keys` reads `1`.

**RED arm (must be seen failing before the fix, per BL-225):** with today's code
(`!nodeRow.sql.includes("'generic'")` / `!edgeRow.sql.includes("'DEPENDS_ON'")`, no structural
gate), step 5 already fails — `nodeRow.sql` (this test's `OPEN_SCHEMA_NODE_DDL`) does not contain
`'generic'`, so `nodeNeedsRebuild` is `true` on the very first `applySchema()` call and the
rootpage changes immediately (a real `rebuildTable` runs). Confirm this by temporarily reverting
just the `index.ts` diff (`git stash`/`git checkout` is banned — instead, comment out the
`hasEnumCheckConstraint(...) &&` clause locally, run the test, observe the failure, then restore
the real fix) and running `npx nx test graph-store -- ensure-check-constraints.bl447.spec.ts`.
Record the failing assertion text in your completion report — that is your BL-225 evidence, not a
description of what "would" happen.

### 5.2 Criterion B — a genuine legacy pre-`'generic'` store upgrades to the CLOSED shape, not the open one

**ARCHITECT AMENDMENT (post-implementation, ruling on implementer's open questions #1 and #3):**

- **#1 — `NODE_TABLE_DDL`/`EDGE_TABLE_DDL` are module-private** (`const`, not `export const`, at
  `index.ts:259,290` — confirmed via `grep -n "^export "`), so "import these constants directly"
  below is wrong; it was never satisfiable as written. Do not export them for this ticket (§3.3
  already forbids expanding the production diff, and exporting them would do exactly that).
  Instead: define local template functions (`CLOSED_NODE_DDL(kinds)` / `CLOSED_EDGE_DDL(rels)`)
  copied byte-for-byte from `index.ts:259-303`, CHECK IN-list parameterized, and assert
  `CLOSED_NODE_DDL(DEFAULT_NODE_KINDS)` / `CLOSED_EDGE_DDL(FULL_EDGE_RELS)` are byte-identical to
  the real post-rebuild `sqlite_master.sql` text. That assertion is checked against the real
  rebuild output, so it gives the identical guarantee a direct import would.
- **#3 — `EdgeRel` (`index.ts:364-374`) is a TS type, erased at runtime, with no value-level
  export**, and `PUBLIC_EDGE_RELS` (`index.ts:505-513`) exports only 7 of its 10 members (missing
  `MEMBER_OF`, `PART_OF`, `DEPENDS_ON`). "Construct these lists … from the exported constants — do
  not hand-type the enum" below is therefore unsatisfiable as written for the 3 missing members. Do
  **not** add a runtime `EdgeRel` enumeration to production code to satisfy this literally — that
  is itself a production-surface expansion outside this ticket's scope (§3.3). Instead: hand-type
  `FULL_EDGE_RELS` (all 10, in production string order, confirmed against `index.ts:294` directly)
  and self-check it against `PUBLIC_EDGE_RELS` at module load with a throwing guard, so a future
  edit to `PUBLIC_EDGE_RELS` that isn't mirrored here fails loudly at suite load rather than
  silently mis-testing — satisfying the anti-drift *intent* without the literal "no hand-typing"
  instruction, which this codebase cannot satisfy without a scope-creeping production change.

**Setup DDL** — same shape as `NODE_TABLE_DDL`/`EDGE_TABLE_DDL` (`index.ts:259-303` — copied via
local template functions per the amendment above, not imported; this scenario is about the CLOSED
shape, which does not change) but with the CHECK's IN-list built from `DEFAULT_NODE_KINDS.slice(0,
-1)` (drop the `'generic'`, which is the DEFAULT_NODE_KINDS array's last entry — confirmed at
`:257`) for node, and the hand-typed, self-checked `FULL_EDGE_RELS` minus `'DEPENDS_ON'` for edge.

**Steps:**

1. Create adapter on a temp file. `PRAGMA foreign_keys = ON`. Exec the legacy DDL (CHECK present,
   `'generic'`/`'DEPENDS_ON'` absent from the IN-lists).
2. Insert 2 nodes (`kind` one of the still-valid legacy values, e.g. `'episode'`) + 1 edge
   (`rel` one of the still-valid legacy values, e.g. `'MENTIONS'`).
3. `const backend = createGraphBackend(adapter); await backend.applySchema();`
4. Re-read `node`/`edge` `sql` text from `sqlite_master`. **Assert:**
   - Both now contain `'generic'` and `'DEPENDS_ON'` respectively (upgraded).
   - Both are **bare-identifier** form (`CHECK (kind IN (` not `CHECK ("kind" IN (` — i.e. they
     match `NODE_TABLE_DDL`/`EDGE_TABLE_DDL`'s text, confirming the rebuild targeted the CLOSED
     constant, not some open-schema shape).
   - Row counts unchanged (2 nodes, 1 edge — no data loss across the rebuild).
   - A fresh write with `kind: 'generic'` now succeeds (`writeNode` no longer throws
     `ConstraintError`, and a raw INSERT with `kind='generic'` does not hit the live SQLite CHECK
     either) — this is the positive proof the upgrade reached the closed shape, not merely that the
     literal text changed.

**RED arm:** before this ticket's fix, this scenario already passes (the literal check alone
already handles case 3 correctly, per §1) — so this criterion's RED arm is not against today's
`index.ts`, it is the **regression guard** proving D-2's kept literal check still works once gated
behind the new structural check. Prove it red by temporarily deleting the
`hasEnumCheckConstraint(...) &&` clause's structural half incorrectly — e.g. inverting the gate to
`!hasEnumCheckConstraint(...)` — and confirming this test's step-4 upgrade assertions fail (no
rebuild happens because the inverted gate now says "no CHECK present" is false when a CHECK *is*
present). Restore the correct implementation before finishing.

---

## 6. Risks

- **Data-loss risk from `rebuildTable` itself: none introduced.** This ticket's diff never changes
  what `rebuildTable` does or which DDL it targets — only the boolean that decides whether to call
  it. §1 proves behavior is byte-identical to today for every DDL shape that exists **right now**
  (case 2 and case 3 in §1); the only behavioral delta is for case 1 (no CHECK on `kind`/`rel` at
  all), which nothing in this repo produces until BL-439/440/448 land. **Merging this ticket alone
  is therefore a no-op against the live `~/.memory/memory.db` and against every store any current
  test creates** — verify that framing holds by running the full `graph-store` suite unmodified
  (§7) and confirming all 46 existing tests plus the two new ones pass with no other file touched.
- **`nx build`/`nx test` destructiveness (BL-235/BL-456).** Do not run `npx nx build graph-store`
  as a diagnostic step — read compiler errors from `tsc`/`nx typecheck` output, never from a build
  you triggered just to see if it fails. Report `check-suite-tree-state.mjs` output alongside every
  test result per the standing house rule.
  - Any concurrent worktree editing this file (checked in §0) — a merge conflict on this exact
  function is the only way this ticket could silently lose the fix; re-check `git log` on this file
  immediately before opening a PR, not just at task start.
- **Do not let this ticket's DDL string in §5.1 leak into production code.** `OPEN_SCHEMA_NODE_DDL`/
  `OPEN_SCHEMA_EDGE_DDL` are test-only fixtures simulating a future state — they must live in the
  new spec file only, never be imported into `index.ts`, and must not be mistaken for "BL-439/440
  already landed" by a future agent grepping for CHECK-free DDL strings.

---

## 7. The gate — exactly what to run, in order

1. `npx nx test graph-store` (plain — no `--skip-nx-cache`). Confirm **48 passing** (46 existing +
   2 new — if the count differs, you added/removed a test outside this spec's scope; stop and
   reconcile against §5 before proceeding).
2. `node tools/check-suite-tree-state.mjs --project graph-store --require-clean` — must report
   CLEAN, and quote its output verbatim in your completion report next to the test result.
3. `npx nx lint graph-store`.
4. `npx nx typecheck graph-store` if a `typecheck` target exists for this project (check
   `libs/data/graph/graph-store/project.json`); if it does not exist, that is itself worth a note
   back per the repo-wide `typecheck`-target house rule, but do not add one as part of this ticket
   unless asked — out of scope creep.
5. Do **not** run `npx nx build graph-store` as part of verifying this change — `nx test`'s own
   `dependsOn` already rebuilds what it needs (and per BL-456, that rebuild is itself gated by
   `check-suite-tree-state.mjs` in step 2). A standalone `nx build` here is diagnostic-only and
   banned by BL-235.
6. Commit by explicit pathspec:
   `git commit libs/data/graph/graph-store/src/index.ts libs/data/graph/graph-store/src/ensure-check-constraints.bl447.spec.ts -m "fix(graph-store): BL-447 — structural CHECK-presence gate replaces substring-literal rebuild probe"`.
   Do not touch `BACKLOG.md` in the same commit as the code fix — mark BL-447 RESOLVED (with the
   test-file citation and the two `check-suite-tree-state`-quoted gate runs as evidence) in a
   follow-up commit once the reviewer stage confirms RED→GREEN, per the standing BL-225 rule; do
   not self-certify RESOLVED at the implementer stage.
7. Report to the reviewer: the exact RED output you captured for Criterion A (§5.1) and the
   inverted-gate RED output for Criterion B's regression guard (§5.2) — both are required evidence,
   neither is optional.
