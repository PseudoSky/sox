# SPEC-PKT-58 — `node.kind` opens: delete the CHECK from fresh DDL, new stores only

**Packet:** PKT-58 · **Closes:** BL-439 (HIGH) · **Authorising ADR:** [`docs/decisions/0010-open-node-and-edge-typing.md`](./docs/decisions/0010-open-node-and-edge-typing.md)
(cited below as "ADR-0010"), specifically **D1** (`node.kind` opens, no `sub_kind`), **D3** (existing
stores never migrate automatically), and the "Consequences" list's rebuild-loop warning.
**Prerequisites (all merged, verified below):** PKT-57 (ADR-0010 itself), PKT-73/BL-447 (structural
`hasEnumCheckConstraint()` rebuild gate), PKT-59/BL-440 (injected `TypePolicy`).
**Worktree:** `/Users/nix/dev/ai/sox-ecosystem/.worktrees/pkt58-open-kind-check`, branch
`feat/pkt58-open-kind-check`. Toolchain verified: `pnpm install` clean, `npx nx test graph-store` →
**3 test files, 56 tests, all passing**, tree state `CLEAN` per
`node tools/check-suite-tree-state.mjs --project graph-store`, before any edit.

---

## 0. Prerequisite verification (do this first, report if it fails)

```
git log --oneline --all | grep -i 447
```
Confirms on `main` (verified by the architect at time of writing):
`6c484957 docs(memory-core): close out BL-447 — move to CHANGELOG, PKT-73 DONE`,
`893b42c4 fix(memory-core): bl-447 structural CHECK gate replaces the DDL substring probe`. This
worktree branched from `main` at `3db7ff46` (PKT-59), which is after both — `hasEnumCheckConstraint()`
already exists at `libs/data/graph/graph-store/src/index.ts:856-858` and is wired into
`ensureCheckConstraints()` at `:907-908, :913-914`. **If your checkout does not have this function,
stop and report — do not proceed.**

---

## 1. Root cause (own words, with citations I opened)

`node.kind` is closed by a `CHECK (kind IN ('episode','entity','claim','community','session','generic'))`
declared identically in three places: `graphDdl()` (`index.ts:62`), `INLINE_MIGRATION_DDL`
(`index.ts:181`), and `NODE_TABLE_DDL` (`index.ts:262`, module-private, used only as
`rebuildTable`'s target shape — see §3 Decision 1). An external consumer's only sanctioned path for a
custom type is `kind:'generic'` plus a sub-kind string in `tags`/`meta`
(`NodeMeta.tags`, `index.ts:383`; `NodeMeta.metadata`, `:393`). Neither `tags` nor `meta` carries any
index — the full node index list is `index.ts:105-118` (`ix_node_kind` through `ix_edge_unique`) and
none targets those two columns; `fts_node` covers `content, name, summary` only (`FTS_DDL`,
`index.ts:74-77`, confirmed by reading the `CREATE VIRTUAL TABLE ... fts5(content, name, summary, ...)`
statement directly). Worse, the query shape used against `tags` is structurally unindexable: every tag
filter in the codebase is a correlated `EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value IN (...))`
(`index.ts:746`, and the `tagsMatchAll` variant at `:741`) or the memory-core equivalents
(`libs/memory-core/src/memory-filters.ts:101,108`; `libs/memory-core/src/recall.ts:445,451` — cited
from the backlog item, not independently re-opened by me since PKT-58's file scope is graph-store
only). `json_each` is a table-valued function scanning a TEXT blob; SQLite has no mechanism to serve it
from a B-tree index, closed or open. Meanwhile `ix_node_kind` (`index.ts:105` in `graphDdl()`, `:226` in
`INLINE_MIGRATION_DDL`, `:319` in `NODE_INDEX_DDLS`) already exists, is a plain B-tree index on `kind`,
and already serves the library's six built-in kinds via three live DDL paths — it is simply
unreachable by anything that isn't one of those six literal strings, because the CHECK constraint
rejects the INSERT before the index is ever relevant.

Per ADR-0010 D1 (`0010-open-node-and-edge-typing.md:48-52`): *"`kind` itself becomes plain `TEXT NOT
NULL`… No `sub_kind` column, index, or filter field is added."* This packet is exactly that: delete the
CHECK, change nothing else about the column, and let `ix_node_kind` — which needs zero modification —
start serving whatever `kind` values a consumer's injected `TypePolicy` (PKT-59, already merged) is
willing to validate.

---

## 2. The change, file by file

### 2.1 `libs/data/graph/graph-store/src/index.ts` — the only source file touched

**Edit A — `graphDdl()`, line 62.** Delete the CHECK clause from the `kind` column definition:

```diff
- kind         TEXT NOT NULL CHECK (kind IN ('episode','entity','claim','community','session','generic')),
+ kind         TEXT NOT NULL,
```

This is a single template literal shared by both `GRAPH_DDL` (`:124`, `jsonChecks: true`) and
`GRAPH_DDL_PRE_BL430` (`:142`, `jsonChecks: false`) — the `kind` CHECK line is not inside the
`jsonCheck()`-parameterised part of the template, so this one edit fixes both exported constants.
Neither constant is invoked anywhere in this codebase at runtime (confirmed: `GRAPH_DDL` appears only
in `graph-store.spec.ts:10,47-50` as a "is a non-empty string" smoke assertion — see §4 AC-4) but both
are part of the package's public surface (`export const GRAPH_DDL`, `:124`), so external consumers who
call `adapter.exec(GRAPH_DDL)` directly get the open schema too.

**Edit B — `INLINE_MIGRATION_DDL`, line 181.** Delete the CHECK clause, Drizzle-quoted form:

```diff
- "kind" text NOT NULL CHECK ("kind" IN ('episode','entity','claim','community','session','generic')),
+ "kind" text NOT NULL,
```

This is the DDL `SqliteGraphBackend.applySchema()` actually executes (`index.ts:883`,
`await this.adapter.exec(INLINE_MIGRATION_DDL)`) via `CREATE TABLE IF NOT EXISTS` (`:178`) — the
no-op-on-existing-table property that makes this "new stores only" **by construction**: any store that
already has a `node` table (open or closed) is untouched by this statement; only a genuinely fresh file
gets the new open-CHECK-free shape.

**Edit C — do NOT touch `NODE_TABLE_DDL`, line 262.** See §3 Decision 1 — this is the one place this
spec overrides the packet's own file list, with a currently-passing test as evidence.

**No other line in `index.ts` changes.** In particular:
- `hasEnumCheckConstraint()` (`:856-858`) — **zero changes.** It is a structural presence probe (`CHECK
  (kind IN` / `CHECK ("kind" IN`); it doesn't care what the CHECK's IN-list contains, only whether a
  CHECK exists at all. Its own doc comment (`:844-847`) already states the post-PKT-58 outcome
  correctly: *"False once BL-438 D1/D4 drop the CHECK from the fresh-creation DDLs (`graphDdl()`,
  `INLINE_MIGRATION_DDL`) — at that point every freshly created or already-open-schema store reports
  `false` here, forever, and `ensureCheckConstraints` never rebuilds it again."* That comment names
  exactly the two functions this spec edits and pointedly does not name `NODE_TABLE_DDL` — written
  during PKT-73, before this packet existed, and it already encodes the correct scope. Trust it.
- `ensureCheckConstraints()` (`:898-941`) — **zero changes.** Walk the three real-world cases against
  the edited DDL to confirm (I traced all three by reading the function, not by running it — the tests
  in §4 are what actually prove it):
  1. **Brand-new store.** `applySchema()` runs the now-CHECK-free `INLINE_MIGRATION_DDL`.
     `nodeRow.sql` has no `CHECK … kind …` substring → `hasEnumCheckConstraint` returns `false` →
     `nodeNeedsRebuild` short-circuits `false` (`:907-908`, `&&` on a `false` left operand). No
     rebuild, ever, for this store.
  2. **Existing production-shape store** (has the CHECK, includes `'generic'` — this is every real
     store today, since `'generic'` was added long before this ADR). `CREATE TABLE IF NOT EXISTS`
     no-ops, so `nodeRow.sql` is whatever it already was: CHECK present, includes `'generic'` →
     `hasEnumCheckConstraint` `true`, `!sql.includes("'generic'")` `false` → `nodeNeedsRebuild` `false`.
     No rebuild. This is D3's "existing rows… unaffected until an operator explicitly runs D3's
     migration" (`0010-open-node-and-edge-typing.md:143-146`) made concrete.
  3. **Genuinely legacy pre-`'generic'` store** (CHECK present, missing `'generic'`) — the case
     `ensure-check-constraints.bl447.spec.ts` Criterion B already exercises. `hasEnumCheckConstraint`
     `true`, `!includes('generic')` `true` → `nodeNeedsRebuild` `true` → `rebuildTable(...,
     NODE_TABLE_DDL, ...)` runs, and because `NODE_TABLE_DDL` is untouched (Edit C), the rebuilt table
     is the **closed** shape with `'generic'` added — identical to today's behaviour, not the open
     schema. This is the load-bearing reason Edit C matters: if `NODE_TABLE_DDL` lost its CHECK too,
     this case would silently deliver the open schema to a store an operator never asked to migrate —
     the exact "automatic, on open" failure mode ADR-0010 says "was never a live option" (`:90-92`).
- `writeNode()` (`:951-953`) — **zero changes.** It already calls
  `this.typePolicy.validateKind(kind)` (`:953`, landed by PKT-59) before ever reaching SQL.
  `DEFAULT_TYPE_POLICY.validateKind` (`:555-562`) still throws `ConstraintError` for anything outside
  the closed six `DEFAULT_NODE_KINDS` (`:257`). **This means PKT-58 alone changes zero observable
  behaviour for every current memory-core call site** — see §5 Risk 1.

### 2.2 `libs/data/graph/graph-store/drizzle/schema.ts` — confirmed, no change needed

Read in full. `node.kind` is declared `text('kind').notNull()` (`schema.ts:20`) with **no CHECK at
all** — the file's own header comment says why: *"CHECK constraints are applied via generated migration
SQL (Drizzle can't express them natively for SQLite)"* (`schema.ts:48-49`). This file already matches
the open schema. The packet's "plus `drizzle/schema.ts` if it mirrors the constraint" instruction
resolves to: it doesn't, so there is nothing to do here. **Do not add a CHECK-shaped Drizzle expression
to this file to "match" anything — that would be adding a constraint that has never existed here.**

### 2.3 `libs/data/graph/graph-store/drizzle/migrations/0000_sad_onslaught.sql` — edit, for documentation honesty only, zero runtime risk

Read in full. This is a **static, hand-generated artifact** — confirmed no code in the repo calls
`drizzle-orm`'s `migrate()` against it (`grep -rn "migrate(\|0000_sad_onslaught"` across `libs/` and
`apps/` returns only the `drizzle.config.ts` output-path declaration and a comment referencing the
filename; no executable migration runner). Its own header says *"Matches the current GRAPH_DDL exactly,
with all CHECK constraints and indexes"* (`0000_sad_onslaught.sql:2`) and it does carry a
backtick-quoted `` CHECK (`kind` IN (...)) `` (`:7`). Since nothing executes this file, deleting its
`kind` CHECK carries **none** of Decision 1's rebuild risk (§3) — there is no `rebuildTable` call
anywhere near it. Edit it to keep the header's claim true:

```diff
- `kind` text NOT NULL CHECK (`kind` IN ('episode','entity','claim','community','session','generic')),
+ `kind` text NOT NULL,
```

Leave the `rel` CHECK on this same file's `edge` table (`:39`) untouched — that's PKT-74's column, not
this packet's.

### 2.4 Explicitly out of bounds — and why

- **`rebuild-table.ts`** — not touched, not even read for edit purposes beyond the review in §2.1. Its
  behaviour (rename→create→copy→drop, `skipDrop` support) is correct as-is; this packet supplies no new
  target DDL that changes its inputs in a way it needs to handle differently.
- **`NODE_TABLE_DDL` (`index.ts:262`) and `EDGE_TABLE_DDL` (`index.ts:290`)** — untouched. See Decision 1.
- **Any `NodeFilter` field, any new column, any new index** — the packet's own text is explicit ("No
  `ALTER TABLE`, no new column, no new index, no new `NodeFilter` field") and nothing in this spec
  requires one. `ix_node_kind` already exists and needs no modification to serve open `kind` values —
  a B-tree index on a `TEXT` column has no notion of a value allowlist; removing the CHECK is the
  entire mechanism.
- **`edge.rel` / the `rel` CHECK anywhere** (`index.ts:94, :213, :294`) — PKT-74's job (BL-448), not
  this packet's, per ADR-0010 D4 and the packet's own sequencing note ("same file and same DDL region
  as PKT-74 — serialize, this one first"). This packet lands first; PKT-74 rebases onto it.
- **`libs/memory-core/**`** — no call site there is edited. All eight `createGraphBackend(adapter)`
  call sites (`cluster.ts` ×3, `enrich-batch.ts`, `entity-episodes.ts`, `list-entities.ts`,
  `near-duplicates.ts`, `supersession-chain.ts`, `related.ts` — enumerated by grep, confirmed none pass
  `opts.typePolicy`) continue to get `DEFAULT_TYPE_POLICY` and therefore continue to reject any kind
  outside the closed six, in TypeScript, before this packet's SQL-layer change is ever reached. Wiring
  a permissive `MemoryOntologyPolicy` is PKT-60's job.
- **`package.json` version bump / `CHANGELOG.md` entry for `@adhd/sox-graph-store`** — not this
  packet's job. ADR-0010's "Consequences" section is explicit: *"One release train, not one per
  packet… PKT-73, PKT-59, PKT-58, PKT-74, and PKT-60 all land on `main` before anything publishes,
  shipping together as a single `0.6.0`… PKT-63 executes the train"* (`0010-…:139-142`). Current
  `package.json` version is `0.5.3` (read directly) — leave it. Do not touch
  `libs/data/graph/graph-store/CHANGELOG.md` either; that entry is PKT-63's, covering the whole train
  at once, not per-packet.

---

## 3. Every decision, ruled

### Decision 1 — `NODE_TABLE_DDL` (`index.ts:262`) keeps its `kind` CHECK; the packet's own file list is wrong on this one line, and I am overriding it

**The packet text says** to edit ":262 in `NODE_TABLE_DDL`" as one of three CHECK sites. **The packet
text also says**, in the same breath: *"Do not touch `rebuildTable`, and do not 'just also' migrate an
existing store… `CREATE TABLE IF NOT EXISTS` (`:59`, `:181`) no-ops on every store that already exists,
so their `CHECK (kind IN (…))` survives."* Those two instructions conflict, because `:262` is not a
`CREATE TABLE IF NOT EXISTS` statement (`index.ts:259`, bare `CREATE TABLE node (`) — it is
`rebuildTable`'s **target DDL** (`ensureCheckConstraints()`, `index.ts:919`:
`rebuildTable(this.adapter, 'node', NODE_TABLE_DDL, NODE_COLUMNS, { skipDrop: true, tx })`), reached
whenever `nodeNeedsRebuild` is `true` — which, per the case-3 trace in §2.1, is exactly the scenario of
a genuinely legacy store being rebuilt **on open**, with no operator invocation, no offline step, no
verified backup. If `NODE_TABLE_DDL` lost its CHECK, that automatic on-open rebuild would deliver the
fully open schema to such a store — this is D3's forbidden shape verbatim: *"No existing store is ever
migrated automatically, and never on connection open"* (`0010-…:78`), and the ADR names this precise
failure mode as the reason "automatic, on open" was never even a rejected alternative worth recording —
it's "the failure mode D3 exists to foreclose" (`:90-93`).

**Ruling: leave `NODE_TABLE_DDL`'s CHECK in place, verbatim, including `'generic'`.** The rebuild path
for genuinely-legacy stores keeps producing the closed six-kind shape, exactly as it does today.
`ix_node_kind` gains nothing from this column staying closed on the narrow legacy-rebuild path, and it
loses nothing either — that path is orthogonal to what this packet is for (serving a *consumer's* kind
on a *newly created* store).

**This is not merely my inference — it is already a passing, committed regression test.**
`ensure-check-constraints.bl447.spec.ts` Criterion B (`:325-414`, landed with PKT-73/BL-447) explicitly
constructs a legacy pre-`'generic'` store, runs `applySchema()`, and asserts:
```
expect(after.node.sql).toBe(CLOSED_NODE_DDL(DEFAULT_NODE_KINDS));   // :388
expect(after.node.sql).toContain('CHECK (kind IN (');                // :382
```
where `CLOSED_NODE_DDL` is a byte-for-byte copy of `NODE_TABLE_DDL`'s shape (`:139-168`, its own
comment says so at `:130-138`). **If Decision 1 goes the other way and `NODE_TABLE_DDL` loses its
CHECK, this already-passing test breaks** — not as an acceptable, expected, "this test needed updating
for the new behaviour" change (the way §4 AC-1's `type-policy.bl440.spec.ts` edit is), but as a direct
violation of the D3 guarantee that test exists to enforce. **If the implementer's edit to `index.ts`
makes `ensure-check-constraints.bl447.spec.ts` fail, that is not a stale test to update — it is proof
the edit is wrong. Revert the `NODE_TABLE_DDL` change and stop.**

**Losing alternative — edit `:262` too, per the packet's literal file list.** Rejected for the reason
above: it re-arms exactly the rebuild-loop failure mode BL-447/PKT-73 was written to close, on the one
population (pre-`'generic'` legacy stores) still capable of triggering an automatic rebuild today, and
it does so by inaction inside an already-existing, already-armed code path — not through any new
mechanism this packet adds. The packet's own §2 prohibition #2 already forbids this outcome; the file
list's inclusion of `:262` is simply inconsistent with that prohibition, and prohibition #2 — backed by
ADR-0010 D3 and a passing test — wins.

### Decision 2 — the AC test for "a new store accepts a consumer kind" must inject a custom `TypePolicy`, not rely on `DEFAULT_TYPE_POLICY`

`DEFAULT_TYPE_POLICY.validateKind` (`index.ts:555-562`) still throws for anything outside the closed
six `DEFAULT_NODE_KINDS`, and `writeNode` calls it unconditionally before the INSERT (`:953`). This is
correct, intentional PKT-59 behaviour (`GraphBackendOpts.typePolicy` doc comment, `:574`: *"Defaults to
DEFAULT_TYPE_POLICY (today's six kinds, ten rels)"*) and this packet must not weaken it — no packet in
this train is authorised to widen the *default* policy; ADR-0010 D2 assigns that vocabulary decision to
memory-core (PKT-60), not to graph-store's default. **Ruling:** every AC-1 test in §4 that needs a
consumer kind to actually reach SQL constructs `createGraphBackend(adapter, { typePolicy:
permissiveTestPolicy })` with a small locally-defined `TypePolicy` whose `validateKind` accepts the
novel kind (e.g. `'component'`, matching the existing convention in `type-policy.bl440.spec.ts:90-99`)
and defers everything else to `DEFAULT_TYPE_POLICY.validateKind`. **Losing alternative:** relax
`DEFAULT_TYPE_POLICY` itself, or add a `kind: '*'` escape hatch — rejected outright, out of this
packet's authorisation (D2 is PKT-60's ADR-cited scope, not this one's), and it would make PKT-58 alone
observably change memory-core's write behaviour, which §2.4 and Risk 1 (§5) both require it not to.

### Decision 3 — `type-policy.bl440.spec.ts:150-152` must be updated as part of this packet — it is today's literal RED arm for AC-1

Read the file. `AC-1 (BL-440)` (`:103-161`) constructs a **fresh** store (`setupBackend =
createGraphBackend(setupAdapter); await setupBackend.applySchema();` against a brand-new temp file,
`:109-111`) and, later in the same test, against a *permissive* injected policy that accepts kind
`'component'`, asserts:
```ts
await expect(backend.writeNode('novel kind node', { kind: 'component' })).rejects.toThrow(
  /CHECK constraint failed/i,
);                                                                              // :150-152
```
with an inline comment explicitly framing this as proof that *"the underlying SQLite CHECK constraint,
untouched by this packet [PKT-59], still rejects it"* (`:138-140`). That sentence is true today and
becomes **false** the moment PKT-58's Edit B lands: the same fresh store, same permissive policy, same
`kind: 'component'` will now succeed — the policy permits it, and there is no more CHECK to reject it.
This is not incidental collateral damage; it is **the packet's own acceptance criterion's RED arm**,
sitting in a file this packet does not otherwise touch. **Ruling: the implementer updates lines
150-152** to assert success instead of rejection:
```ts
const idComponent = await backend.writeNode('novel kind node', { kind: 'component' });
expect(typeof idComponent).toBe('number');
const nodeComponent = await backend.getNode(idComponent);
expect(nodeComponent!.kind).toBe('component');
```
and updates the surrounding comment block (`:137-149`) to state plainly that this assertion changed
because PKT-58 removed the node-side CHECK, citing BL-439/this spec, rather than leaving PKT-59's
now-inaccurate "untouched by this packet" claim standing. **Do not touch anything else in this
`describe` block** — the very next assertion in the same test (`:154-159`,
`backend.writeEdge(n1, n3, 'CUSTOM_REL' as EdgeRel)).rejects.toThrow(ConstraintError)`) exercises
`edge.rel`, which this packet does not open (PKT-74's job) — it must keep failing, unchanged, and
continues to prove the edge side is still fully closed. **Do not touch AC-2, AC-3, or AC-4** in the
same file (`:163-285`) — none of them construct a novel kind/rel, all continue to exercise the closed
default-policy behaviour this packet leaves untouched (§2.1's "zero observable behaviour change for
current call sites" point, concretely instantiated).

### Decision 4 — the populated-round-trip AC uses a synthetic populated store, never `~/.memory/*`, and that satisfies the criterion's intent

The packet requires *"a populated round-trip against a copy of a real store: open, close, reopen,
assert zero rebuilds and zero row/edge loss"* and separately forbids opening `~/.memory/*` under any
circumstances, requiring instead *"a `cp` of a WAL-consistent snapshot — copy the `-wal` alongside the
`.db`"* if a real store's copy is used at all. Both instructions are satisfiable together only if "a
real store" is read as "a real, on-disk, populated SQLite database using this package's own schema" —
not literally the live production file. **Ruling:** the implementer builds a **synthetic populated
store inside the test's own temp directory**, at meaningful scale (rule: **at least 500 nodes and 500
edges**, spanning a realistic mix of the six closed kinds plus tag/meta payloads, generated via the
package's own `writeNode`/`writeEdge`/`writeGraph` API against a `SqliteAdapterImpl` backed by a real
file — not `:memory:`, since the criterion is specifically about *cold-open* identity, which
`:memory:` cannot exercise), closes the adapter (forcing a WAL checkpoint), copies the `.db` file (and
`-wal`/`-shm` if `close()` did not fully checkpoint them — verify via `ls` before deciding whether the
copy needs them) to a second temp path with plain `fs.copyFileSync`, and reopens the **copy** with a
fresh adapter to prove: (a) `sqlite_master.rootpage` for `node`/`edge` unchanged from what an
independent read of the pre-copy file reported, (b) `sqlite_master.sql` for both tables unchanged, (c)
`COUNT(*)` on both tables matches the pre-copy counts exactly, (d) `PRAGMA foreign_keys` reports `1`
post-reopen. This proves the exact property the criterion is protecting — *"open, close, reopen,
assert zero rebuilds and zero row/edge loss"* — without ever touching a live production artifact, and
without the "never open `~/.memory/*`" and "use a copy" instructions being read as requiring the
literal live file, which no packet in this train has license to touch regardless of copy discipline
(the constraint exists because the live file could be corrupted by a bug in the code under test, and a
synthetic store carries that exact same protective value at zero blast radius). **Losing alternative —
locate and `cp` an actual `~/.memory/`-derived snapshot committed somewhere in the repo:** none exists
(confirmed: no `.db` fixture under version control matching this shape; `backup.spec.ts`, the closest
precedent in `memory-core`, builds its own synthetic stores in temp dirs for the identical reason,
`libs/memory-core/src/backup.spec.ts:45-59`). Fabricating a "realistic" 500+-row store from a smaller
committed fixture would add fixture-maintenance burden for no additional confidence over generating it
programmatically at test time.

### Decision 5 — the `EXPLAIN QUERY PLAN` acceptance test asserts on the `detail`/`sql` shape SQLite actually returns, following the codebase's one existing precedent

`libs/data/store/store-adapter/src/integrity.ts:612-621`'s `planUsesIndex()` is the only other place in
this codebase that runs `EXPLAIN QUERY PLAN` and inspects the result — its pattern:
`adapter.executeAll<Record<string, unknown>>(`EXPLAIN QUERY PLAN ${sql}`)`, then scan
`Object.values(row).some(v => typeof v === 'string' && v.includes(needle))` across all returned columns
(SQLite's `EXPLAIN QUERY PLAN` result shape varies slightly by driver — better-sqlite3 returns
`id, parent, notused, detail`; asserting against `Object.values(row)` rather than a specific column name
is what makes this pattern portable across that variance). **Ruling: reuse this exact pattern** rather
than inventing a new one — assert `plan.rows.some(row => Object.values(row).some(v => typeof v ===
'string' && v.includes('ix_node_kind')))` for the positive case and
`plan.rows.every(row => Object.values(row).every(v => !(typeof v === 'string' &&
v.toLowerCase().includes('json_each'))))` for the negative (zero `json_each`) case, worded to match
§4 AC-2 exactly.

---

## 4. Acceptance criteria — each observable, each with a stated RED arm, each naming BL-439

### AC-1 — a new store accepts and round-trips a consumer kind through `writeNode`/`getNode`, with an injected `TypePolicy` permitting it

**Assertion:** against a brand-new `SqliteAdapterImpl` (temp file, not `:memory:` — cold-open identity
matters here per Decision 4's reasoning, though this specific AC may use `:memory:` since it is not
itself testing cross-open identity, only write/read round-trip; either is acceptable, prefer `:memory:`
for speed since Decision 4's own dedicated AC-4 already covers the file-identity dimension),
`createGraphBackend(adapter, { typePolicy: permissiveTestPolicy })` where `permissiveTestPolicy` accepts
a novel kind (e.g. `'component'`, following Decision 2/`type-policy.bl440.spec.ts`'s convention) and
delegates everything else to `DEFAULT_TYPE_POLICY`. `applySchema()`, then `writeNode('content',
{ kind: 'component' })` **resolves** with a numeric id, and `getNode(id)!.kind === 'component'`.
**RED arm today:** run this exact test against the current (pre-edit) `index.ts` — `writeNode` throws,
because `INLINE_MIGRATION_DDL`'s live SQL CHECK rejects the INSERT with a raw `SqliteError: CHECK
constraint failed: kind` (not even reaching a `ConstraintError` translation — `writeNode` has no
catch/translate on this path, confirmed by `type-policy.bl440.spec.ts:140-144`'s own comment on this
exact gap). Watch it fail before the DDL edit; watch it pass after.

### AC-2 — `EXPLAIN QUERY PLAN` for a consumer-kind query resolves to `SEARCH node USING INDEX ix_node_kind`, zero `json_each`

**Assertion:** on the same populated store as AC-1 (or a fresh one with a handful of `'component'`
nodes inserted via the permissive policy), run
`EXPLAIN QUERY PLAN SELECT * FROM node WHERE kind = 'component'` via `adapter.executeAll` (per Decision
5's pattern) and assert the plan text contains `ix_node_kind` and contains no `json_each` anywhere in
any returned field.
**RED arm — the packet's own stated one, reproduced exactly:** run
`EXPLAIN QUERY PLAN SELECT * FROM node WHERE EXISTS (SELECT 1 FROM json_each(node.tags) WHERE value =
'component')` (today's only way to filter on a consumer sub-kind stashed in `tags`) against the same
store, and assert the plan **does** contain `SCAN` and `json_each` (i.e. `SCAN json_each VIRTUAL
TABLE INDEX` or equivalent — assert on the substring `json_each` combined with the absence of `SEARCH …
USING INDEX`, since exact SQLite version wording for virtual-table scans varies). This RED arm requires
no code change to demonstrate — it is true against `main` today and remains true after this packet
(the tag-based path is not removed, only made unnecessary for the `kind`-shaped case). Include it as an
actual second `it()` in the same `describe` block, not just prose, so CI keeps proving both halves of
the contrast on every run.

### AC-3 — honest-scope arm: a store created by the OLD (CHECK-bearing) DDL still rejects a consumer kind, and its table identity is unchanged (BL-295/BL-313 guard)

**Assertion:** construct a store using the byte-for-byte pre-edit `INLINE_MIGRATION_DDL` shape (i.e.
literally paste the CHECK-bearing form as a local test constant — do **not** import a "closed" constant
from `index.ts`, since after this edit lands `index.ts` no longer has one to import; follow
`ensure-check-constraints.bl447.spec.ts`'s own established convention of maintaining a test-local DDL
literal for exactly this reason, `:127-138`'s comment explains why). Capture `sqlite_master.rootpage`
and `.sql` for `node` before calling `applySchema()`. Call `createGraphBackend(adapter, { typePolicy:
permissiveTestPolicy }).applySchema()` (permissive policy deliberately, to prove the **SQL** layer is
the one still doing the rejecting, not the TypeScript layer — if the test used `DEFAULT_TYPE_POLICY` it
would prove nothing new, since Decision 2/§2.1 already established that path is unaffected). Assert:
(a) `writeNode('x', { kind: 'component' })` **rejects** (raw SQLite CHECK failure, same shape as AC-1's
current RED arm), (b) `sqlite_master.rootpage` and `.sql` for `node` are **byte-identical** before and
after `applySchema()` — i.e. `ensureCheckConstraints()` did not rebuild this table just because it now
has a permissive policy attached to it. **RED arm:** this criterion's RED arm is not "today's code
fails it" — today's code already passes both halves (an old-DDL store already rejects `'component'`,
and `applySchema()` already leaves such a store's identity untouched, since `hasEnumCheckConstraint`
returns `true` and `.includes('generic')` is `true` for this shape, so `nodeNeedsRebuild` is `false`
regardless of policy). The RED arm this criterion exists to catch is a **regression**: it must be run
again, unchanged, after Edit A/B land, and it must still pass — proving the fresh-DDL edit did not
accidentally widen `ensureCheckConstraints()`'s rebuild trigger or otherwise leak the open schema onto
a store that has the CHECK. State explicitly in the test's own comment that this is a regression guard,
not a red→green criterion, so a future reader does not mistake "this passed before your change too"
for "this criterion is vacuous."

### AC-4 — populated round-trip against a synthetic populated store: open, close, reopen, zero rebuilds, zero row/edge loss

Per Decision 4. **Assertion:** build ≥500 nodes / ≥500 edges via the package's own write API against a
real temp-file `SqliteAdapterImpl` (default `DEFAULT_TYPE_POLICY` is fine here — this AC is about
row/table identity, not about consumer kinds), close the adapter, `fs.copyFileSync` the `.db` (plus
`-wal`/`-shm` if present after close) to a second temp path, open a fresh adapter on the copy, call
`applySchema()`, and assert: `node`/`edge` row counts match the pre-copy counts exactly,
`sqlite_master.rootpage` for both tables is unchanged from an independent read taken on the copy
*before* `applySchema()` ran (i.e. `applySchema()` itself caused zero rebuild — the copy step cannot
by construction, it's a raw file copy), and a spot-check of N arbitrary rows (content hash or uid) is
byte-identical pre/post. **RED arm:** this is a **regression guard**, like AC-3, not a red→green
criterion in isolation — but it has a real historical RED precedent to point to: BL-313, *"40,930 edges
silently cascade-deleted, no exception raised, nothing logged"* (ADR-0010, cited in Context,
`0010-…:35-37`), which is exactly the failure class this AC exists to catch on a populated store, and
which the pre-BL-447 substring-probe code (now fixed) could have re-triggered had this packet's DDL
edit landed before PKT-73's structural fix. Since PKT-73 already landed (verified in §0), this AC's
practical RED arm is: temporarily revert Edit A/B (or run this AC against `git stash`-free `main` at
the pre-PKT-58 commit) and confirm it still passes there too (it must — it's a smoke test for a
property that should hold with or without this packet). Then run it again post-edit and confirm it
still passes. The value of this AC is as a permanent regression sentinel over the row/edge-loss
invariant, run on every future change to this file, not as a criterion that is false until this packet
lands.

### Test-count/tree-state gate

After all edits: `npx nx test graph-store` must report the pre-edit **56** tests **plus** the new
tests added under AC-1 through AC-4 (at minimum 5-6 new `it()` blocks: AC-1, AC-2's two arms, AC-3,
AC-4), all green, and `node tools/check-suite-tree-state.mjs --project graph-store` must report
`CLEAN` at the moment the suite is run for the record (i.e. run it *after* committing, or accept and
report the dirty-set list per BL-456 if run mid-edit — do not claim a clean-tree result you did not
actually observe).

---

## 5. Risks

**Risk 1 — none of this is reachable by memory-core today, and that is the correct, intended outcome,
not an incompleteness.** Confirmed in §2.1/§2.4: every current `createGraphBackend()` call site in
`libs/memory-core` supplies no `typePolicy`, so `DEFAULT_TYPE_POLICY` keeps rejecting any kind outside
the closed six in TypeScript, before SQL is ever reached. This packet is therefore **inert in
production** until PKT-60 injects a permissive `MemoryOntologyPolicy` for memory-core specifically. Do
not treat "nothing changed for memory-core" as a sign the edit didn't work — verify via the AC tests in
§4, which exercise the SQL layer directly with an injected test policy, precisely because that's the
only way to observe this packet's effect before PKT-60 lands.

**Risk 2 — the one real data-loss vector is exactly Decision 1's scenario, and it is closed by *not*
editing `NODE_TABLE_DDL`.** If the implementer edits `:262` anyway (following the packet's literal file
list over this spec's ruling), the failure is silent and delayed: nothing breaks until some store that
still has the pre-`'generic'` CHECK shape is opened, at which point it auto-migrates to the fully open
schema with no operator consent, no backup, no rollback — reproducing BL-313's shape (uncontrolled
schema rebuild on a populated table) via a different trigger than the one BL-313 itself used. The
concrete guard: `ensure-check-constraints.bl447.spec.ts` Criterion B must still pass unmodified after
this packet's edits (§3 Decision 1). **Sequencing that avoids it:** make Edit A and Edit B, run the full
`graph-store` suite (pre-existing 56 tests) before writing any new test, and treat any failure in
`ensure-check-constraints.bl447.spec.ts` as a stop condition, not a test to fix.

**Risk 3 — `npx nx build graph-store` / `npx nx test graph-store` is destructive per BL-235/BL-456.**
Do not run a bare `npx nx build graph-store` "just to check" the DDL edit compiles — TypeScript string
literal edits inside a template literal cannot fail to compile in a way a build would catch that
`tsc`-via-`npx nx typecheck graph-store` wouldn't, so there is no diagnostic reason to build ahead of
the normal gate sequence in §6. `npx nx test graph-store` itself rebuilds `^build` dependencies
(`store-adapter`, `sox-telemetry`, confirmed by this session's own toolchain-verification run in §0's
preamble) — that's expected and already accounted for; just don't run it against a dirty upstream
dependency tree, and report `check-suite-tree-state.mjs`'s output with every result per BL-456.

**Risk 4 — do not construct or copy anything under `~/.memory/`.** Decision 4 exists specifically so
the implementer never needs to. If at any point the AC-4 fixture feels insufficiently "real" and the
implementer is tempted to reach for the live store to make it more convincing, that impulse is wrong —
stop and re-read Decision 4's reasoning, or escalate back to this spec's author rather than touching the
live path.

---

## 6. The gate — exact nx targets

Run in this order, after edits are complete:

1. `npx nx lint graph-store`
2. `npx nx typecheck graph-store` — confirmed present (`project.json`'s `typecheck` target runs
   `tsc -p libs/data/graph/graph-store/tsconfig.json --noEmit`), so there is no excuse to skip it or
   fall back to a destructive `build` for a compile-correctness signal.
3. `npx nx test graph-store` — expect the pre-edit 56 plus the new AC tests, all green
4. `node tools/check-suite-tree-state.mjs --project graph-store` — quote the output verbatim alongside
   the test result
5. Do **not** run `npx nx run registry:sync-index` — `graph-store` is a `libs/data/*` package, not a
   registered extension (per `libs/data/CLAUDE.md`'s "Build rules" section, confirmed: no
   `registry/index.json` entry exists for data packages).
6. Whole-repo gate is **not required** for this packet in isolation (single-file, single-package
   change with no consumer edits) — but if time permits before handoff to the reviewer, `npx nx
   affected -t lint,test,typecheck` scoped to this branch's diff is good practice and matches the
   parallel-dispatch pre-commit convention in the root `CLAUDE.md`.

Commit by explicit pathspec, incrementally (e.g. one commit for `index.ts` + the two spec files it
directly implicates, a separate commit for `0000_sad_onslaught.sql`'s documentation-only edit, a
separate commit for the new AC test file). Conventional-commit, lowercase subject, scope
`memory-core` — this repo's convention for prior `graph-store`-only changes (PKT-59's `9ba8ec70`,
PKT-73's `37863fee`) both used `fix(memory-core): …` / no dedicated `graph-store` scope exists in this
repo's commit history for this package; follow that precedent rather than inventing a new scope.

---

## Summary of what changes vs. what the packet's literal text says

| Site | Packet said | This spec rules |
|---|---|---|
| `graphDdl()` `:62` | delete CHECK | **delete CHECK** (confirmed) |
| `INLINE_MIGRATION_DDL` `:181` | delete CHECK | **delete CHECK** (confirmed) |
| `NODE_TABLE_DDL` `:262` | delete CHECK | **leave CHECK in place** (Decision 1 — overridden, with a passing test as evidence) |
| `drizzle/schema.ts` | "if it mirrors" | confirmed it doesn't; no change |
| `drizzle/migrations/0000_sad_onslaught.sql` | not mentioned | delete CHECK too, documentation-only, zero runtime risk (§2.3) |
| `type-policy.bl440.spec.ts:150-152` | not mentioned | **must update** — it is AC-1's literal current RED arm (Decision 3) |
