# SPEC-PKT-74 — `edge.rel` opens: delete the `rel` CHECK from fresh DDL, widen `EdgeRel`, new stores only

**Packet:** PKT-74 · **Closes:** BL-448 (HIGH) · **Authorising ADR:**
[`docs/decisions/0010-open-node-and-edge-typing.md`](./docs/decisions/0010-open-node-and-edge-typing.md)
(cited below as "ADR-0010"), specifically **D4** (`edge.rel` opens in the same pass as `node.kind`,
same D2 injected-policy enforcement, same D3 never-automatic migration) and its "Consequences"
`EdgeRel`-widening / rebuild-loop paragraphs.
**Prerequisites (all merged on `main`, verified below):** PKT-57 (ADR-0010 itself, `65171ad9`'s
successor chain), PKT-73/BL-447 (`37863fee` — structural `hasEnumCheckConstraint()` rebuild gate),
PKT-59/BL-440 (`9ba8ec70` — injected `TypePolicy`, `validateRel` **already wired** at the write
boundary), PKT-58/BL-439 (`86d758ed` merge commit, `ae262a2d` — `node.kind` opened; **read its diff
and `SPEC-PKT-58.md` before touching anything, they establish the pattern this spec mirrors**).
**Worktree:** `/Users/nix/dev/ai/sox-ecosystem/.worktrees/pkt74-open-edge-rel`, branch
`feat/pkt74-open-edge-rel`, branched from `main` at `86d758ed`. Toolchain verified: `pnpm install`
clean (native rebuild of `better-sqlite3`/`sqlite-vec` succeeded), `npx nx test graph-store` →
**4 test files, 61 tests, all passing**, tree state `CLEAN` per
`node tools/check-suite-tree-state.mjs --project graph-store`, before any edit.

---

## 0. Prerequisite verification (do this first, report if it fails)

```
git log --oneline -5 -- libs/data/graph/graph-store/src/index.ts
```
Must show, most-recent-first: `86d758ed` (merge, PKT-58), `ae262a2d` (PKT-58's actual edit),
`9ba8ec70` (PKT-59), `37863fee` (PKT-73). If your checkout does not have `DEFAULT_EDGE_RELS`,
`TypePolicy.validateRel`, or `hasEnumCheckConstraint(sql, 'kind' | 'rel')` in `index.ts`, **stop and
report — do not proceed.**

**The most important fact this spec rests on, verified by direct read, not assumed from the backlog
item's prose:** BL-448's own text (filed 2026-08-05, before PKT-59 existed) says `writeEdgeInternal`
"validates nothing" and "passes rel straight into the INSERT." **That is no longer true.**
`writeEdgeInternal` (`index.ts:1161-1181`) now reads:

```ts
private async writeEdgeInternal(src: number, dst: number, rel: EdgeRel, meta?: EdgeMeta): Promise<void> {
  this.typePolicy.validateRel(rel);          // index.ts:1162 — added by PKT-59, already merged
  try {
    ...
    await this.adapter.executeRun(`INSERT INTO edge ...`, ...);
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('CHECK constraint failed'))
      throw new ConstraintError(err.message);
    ...
  }
}
```
`validateRel` runs **before** the `try` block, i.e. before any SQL is issued, and both public funnels
— `writeEdge` (`:1157-1159`) and `writeGraph`'s edge loop (`:1083`) — call `writeEdgeInternal`
exclusively (verified by grep: zero other call sites of the `INSERT INTO edge` template literal).
`DEFAULT_TYPE_POLICY.validateRel` (`:563-569`) still throws `ConstraintError` for anything outside
`DEFAULT_EDGE_RELS` (`:521-532`, the full ten-member vocabulary — **not** `PUBLIC_EDGE_RELS`, see §1).

**Consequence for this packet's scope:** PKT-59 already closed BL-448's "no runtime fallback" half.
What remains open is exactly D4's DDL half — the SQL `CHECK` — plus the `EdgeRel` type widening and
the doc/spec honesty work. This packet is smaller than BL-448's own text implies, because its sibling
packet already shipped the harder half. Do not re-derive or re-litigate PKT-59's `validateRel` design;
treat `index.ts:1157-1181` as correct and unchanged except where §2 says otherwise.

---

## 1. Root cause, in my own words, with citations I opened

`edge.rel` is closed by `CHECK (rel IN ('MENTIONS','SUPPORTS','RELATES_TO','SUPERSEDES','DERIVED_FROM','MEMBER_OF','PART_OF','SAME_AS','ASSIGNED_TO','DEPENDS_ON'))`
declared identically in three places: `graphDdl()` (`index.ts:94`), `INLINE_MIGRATION_DDL`
(`:213`), and the module-private `EDGE_TABLE_DDL` (`:294`, used only as `rebuildTable`'s target
shape — see §3 Decision 1, the direct mirror of `SPEC-PKT-58.md`'s Decision 1 for `NODE_TABLE_DDL`).
Per ADR-0010 D4 (`0010-open-node-and-edge-typing.md:98-102`): *"The `rel` CHECK is dropped from fresh
DDL in the same change as `kind`'s… `EdgeRel` widens accordingly."* Until PKT-59, the closed
`EdgeRel` TypeScript union (`:364-374`) was the *only* guard on `rel`, at compile time only, and
enforced nothing for a JSON tool payload — see §0's read of `writeEdgeInternal`'s pre-PKT-59 shape as
BL-448 describes it. PKT-59 already closed that runtime gap. What is left, and what this packet does:

1. **The DDL still has three CHECK declarations** (`:94`, `:213`, `:294`) that D4 rules must come off
   the two genuinely-fresh-store paths (`graphDdl()`, `INLINE_MIGRATION_DDL`), mirroring exactly what
   PKT-58 did for `kind` at `:62`/`:181`.
2. **`EdgeRel` is a closed TS union in return position.** `EdgeRecord.rel: EdgeRel` (`:424`), assigned
   at `rowToEdgeRecord` (`:668-674`, specifically `:672`, `rel: row.rel as EdgeRel`). Widening `EdgeRel`
   to accept an open consumer rel is source-breaking for any downstream consumer that narrows on it
   exhaustively (`switch`/`assertNever`) — confirmed by grep across `libs/memory-core/src` and
   `libs/data/graph/graph-store/src`: **no in-repo consumer does this today** (§3 Decision 3), but the
   package is published (`@adhd/sox-graph-store`, `package.json:2-3`, `private: false`) and BL-444
   records this as a real external-consumer risk, not a hypothetical one.
3. **`PUBLIC_EDGE_RELS` (`:505-513`) is a *different* constant from the CHECK's vocabulary and always
   has been** — confirmed by reading `DEFAULT_EDGE_RELS`'s own doc comment (`:515-519`, added by
   PKT-59): *"the full ten-member EdgeRel vocabulary… NOT PUBLIC_EDGE_RELS (which is memory-core's own
   7-member tool-surface subset, unrelated to this constant and untouched by this packet)."*
   `graph-store.spec.ts:28-39` asserts `PUBLIC_EDGE_RELS` has exactly 7 values. This packet does not
   touch the CHECK's vocabulary count (still 10, unchanged) or `PUBLIC_EDGE_RELS`'s vocabulary count
   (still 7, unchanged) — see §3 Decision 4 for why this assertion is a **regression guard**, not a
   red→green criterion, and why it is left value-unchanged but must gain an explanatory comment.

---

## 2. The change, file by file

### 2.1 `libs/data/graph/graph-store/src/index.ts` — the only source file with a runtime edit

**Edit A — `graphDdl()`, line 94.** Delete the CHECK clause from the `rel` column definition:
```diff
- rel       TEXT NOT NULL CHECK (rel IN ('MENTIONS','SUPPORTS','RELATES_TO','SUPERSEDES','DERIVED_FROM','MEMBER_OF','PART_OF','SAME_AS','ASSIGNED_TO','DEPENDS_ON')),
+ rel       TEXT NOT NULL,
```
Same template shared by `GRAPH_DDL` and `GRAPH_DDL_PRE_BL430` (both exported, neither invoked at
runtime — same finding PKT-58 made for the `kind` line, re-verified here for `rel`: `GRAPH_DDL`
appears only in `graph-store.spec.ts:47-50`'s "non-empty string" smoke assertion).

**Edit B — `INLINE_MIGRATION_DDL`, line 213.** Delete the CHECK clause, Drizzle-quoted form:
```diff
- "rel" text NOT NULL CHECK ("rel" IN ('MENTIONS','SUPPORTS','RELATES_TO','SUPERSEDES','DERIVED_FROM','MEMBER_OF','PART_OF','SAME_AS','ASSIGNED_TO','DEPENDS_ON')),
+ "rel" text NOT NULL,
```
This is the DDL `applySchema()` actually executes (`:883`, `CREATE TABLE IF NOT EXISTS`, `:209`) —
no-ops on any store that already has an `edge` table, open or closed. This is the "new stores only"
mechanism, by construction, identical to PKT-58's Edit B.

**Edit C — do NOT touch `EDGE_TABLE_DDL`, line 294.** See §3 Decision 1. Direct mirror of
`SPEC-PKT-58.md` Decision 1 (`NODE_TABLE_DDL`), same reasoning, same passing-test evidence
(`ensure-check-constraints.bl447.spec.ts` Criterion B, already asserts
`after.edge.sql).toBe(CLOSED_EDGE_DDL(FULL_EDGE_RELS))` at `:389` — a legacy pre-`'DEPENDS_ON'` edge
table rebuilds to the **closed** ten-rel shape, not the open one).

**Edit D — widen `EdgeRel` (`:364-374`).** Per §3 Decision 3:
```diff
 export type EdgeRel =
   | 'MENTIONS'
   | 'SUPPORTS'
   | 'RELATES_TO'
   | 'DERIVED_FROM'
   | 'SUPERSEDES'
   | 'SAME_AS'
   | 'ASSIGNED_TO'
   | 'MEMBER_OF'
   | 'PART_OF'
-  | 'DEPENDS_ON';
+  | 'DEPENDS_ON'
+  | (string & {});
```
Add a doc comment directly above the type (there is none today) stating: this is the branded-string
widening pattern (preserves literal autocomplete for the ten known rels, accepts any other string),
per ADR-0010 D4 and BL-444; it is source-breaking for a consumer that assigns `EdgeRecord.rel` into an
exhaustive `switch`/`Record<EdgeRel, T>` — cite BL-448's own type-level regression test (§4 AC-Type)
as the demonstration, not an assertion.

**No other line in this section changes.** In particular, do not touch:
- `EdgeRecord` (`:421-428`) — `rel: EdgeRel` stays exactly as written; the widened type flows through
  automatically, no edit needed at the usage site.
- `rowToEdgeRecord` (`:668-679`) — the `rel: row.rel as EdgeRel` cast at `:672` stays; it was already
  a cast (not a literal-narrowing assignment) and remains valid, now trivially so, against the widened
  type.
- `writeEdgeInternal` (`:1157-1181`) — **zero changes**, per §0. `this.typePolicy.validateRel(rel)` at
  `:1162` already runs before the `try`/INSERT block. The `err.message.includes('CHECK constraint
  failed')` translation at `:1174-1176` stays — it is still reachable, and still correct, for any
  store that still carries the CHECK (every existing store, until PKT-61 runs).
- `hasEnumCheckConstraint()` (`:856-858`) — **zero changes.** Its own doc comment (`:844-847`) already
  states the post-D4 outcome for `rel` explicitly: *"False once BL-438 D1/D4 drop the CHECK from the
  fresh-creation DDLs… every freshly created or already-open-schema store reports `false` here,
  forever, and `ensureCheckConstraints` never rebuilds it again."* Written during PKT-73, already
  correct for this packet.
- `ensureCheckConstraints()` (`:898-941`) — **zero changes.** Same three-case trace as PKT-58's §2.1,
  now performed for the edge branch specifically (I traced this by reading the function, the tests in
  §4 prove it at runtime):
  1. **Brand-new store.** `INLINE_MIGRATION_DDL` (post Edit B) has no `rel` CHECK →
     `hasEnumCheckConstraint(edgeRow.sql, 'rel')` `false` → `edgeNeedsRebuild` `false` (`:913-914`,
     `&&` on a `false` left operand). No rebuild, ever.
  2. **Existing production-shape store** (CHECK present, includes `'DEPENDS_ON'` — every real store
     today). `CREATE TABLE IF NOT EXISTS` no-ops, `edgeRow.sql` unchanged: CHECK present,
     `.includes("'DEPENDS_ON'")` `true` → `!includes(...)` `false` → `edgeNeedsRebuild` `false`. No
     rebuild. D3's "existing rows… unaffected" made concrete for the edge column.
  3. **Genuinely legacy pre-`'DEPENDS_ON'` store** (CHECK present, missing `'DEPENDS_ON'`) — exactly
     `ensure-check-constraints.bl447.spec.ts` Criterion B's fixture. `hasEnumCheckConstraint` `true`,
     `!includes('DEPENDS_ON')` `true` → `edgeNeedsRebuild` `true` → `rebuildTable(..., EDGE_TABLE_DDL,
     ...)` runs, and because `EDGE_TABLE_DDL` is untouched (Edit C), the rebuilt table is the
     **closed** ten-rel shape — identical to today, not the open schema. Same load-bearing reason as
     PKT-58's Decision 1: if `EDGE_TABLE_DDL` lost its CHECK too, this on-open rebuild would silently
     deliver the fully open schema to a store no operator asked to migrate.
- `writeNode`/node-side machinery — untouched, out of this packet's file scope entirely.

### 2.2 `libs/data/graph/graph-store/drizzle/schema.ts` — confirmed, no change needed

Read in full (`schema.ts:75`, `rel: text('rel').notNull()` — no CHECK expressed in Drizzle at all,
same finding PKT-58 made for `kind` at `schema.ts:20`, for the same documented reason: *"CHECK
constraints are applied via generated migration SQL"* (`schema.ts:48-49`)). Already matches the open
schema. Do not add a CHECK-shaped Drizzle expression here.

### 2.3 `libs/data/graph/graph-store/drizzle/migrations/0000_sad_onslaught.sql` — edit, documentation honesty only, zero runtime risk

Read in full. Static, hand-generated, never executed by any migration runner (confirmed by PKT-58's
own grep, re-verified here: no `migrate(` call anywhere in `libs/`/`apps/`). Its `kind` CHECK is
already gone (PKT-58's Edit, `:7`, confirmed by direct read: `` `kind` text NOT NULL, `` — no CHECK).
Its `rel` CHECK is still present at `:39` (`` `rel` text NOT NULL CHECK (`rel` IN (...)) ``) — PKT-58's
own spec explicitly left it for this packet ("Leave the `rel` CHECK on this same file's `edge` table
(`:39`) untouched — that's PKT-74's column, not this packet's"). Edit it now:
```diff
- `rel` text NOT NULL CHECK (`rel` IN ('MENTIONS','SUPPORTS','RELATES_TO','SUPERSEDES','DERIVED_FROM','MEMBER_OF','PART_OF','SAME_AS','ASSIGNED_TO','DEPENDS_ON')),
+ `rel` text NOT NULL,
```

### 2.4 `libs/data/graph/graph-store/src/graph-store.spec.ts` — comment-only edit, value unchanged

Per §3 Decision 4: add an explanatory comment directly above the `'PUBLIC_EDGE_RELS contains 7
values'` test (`:28-39`) stating explicitly that this assertion is **deliberately unaffected** by
BL-448/D4 — the CHECK's vocabulary (still 10, unchanged by this packet) and `PUBLIC_EDGE_RELS` (still
7, unchanged by this packet) were never the same constant (established by PKT-59's own comment at
`index.ts:515-519`, cited above). **Do not change the numbers, the `toContain`/`not.toContain`
assertions, or the array itself.** State plainly in the comment: "which set `MemoryOntologyPolicy`
carries is PKT-60/BL-441's decision, not this packet's; see ADR-0010's 'Architect recommendations…
not owner decisions' section for why the DI wiring shape (and by extension, PKT-60's exact vocabulary
choice) is not ruled here."

### 2.5 `libs/data/graph/graph-store/src/type-policy.bl440.spec.ts` — the packet's actual RED arm, sitting in a file the packet doesn't mention (mirrors `SPEC-PKT-58.md` Decision 3 exactly)

Line 154 (read in full above, §0's context read):
```ts
await expect(backend.writeEdge(n1, n3, 'CUSTOM_REL' as EdgeRel)).rejects.toThrow(
  ConstraintError,
);
```
This assertion sits inside AC-1 (BL-440)'s test, which builds a store via `setupBackend =
createGraphBackend(setupAdapter)` → `applySchema()` **on a fresh temp file** (`:109-111`), then
re-opens it with `createGraphBackend(adapter, { typePolicy: permissivePolicy })` where
`permissivePolicy.validateRel` explicitly allows `'CUSTOM_REL'` (`:95-98`). Today this assertion is
true because, even though the policy permits `CUSTOM_REL`, the fresh store's `INLINE_MIGRATION_DDL`
still carries the `rel` CHECK, and the raw SQLite failure is translated to `ConstraintError` by
`writeEdgeInternal`'s catch (`:1174-1176`, comment at `:152-153` says exactly this: *"the CHECK still
rejects it — and here writeEdgeInternal's existing catch does translate it to ConstraintError"*). The
moment Edit B lands, this store's `edge` table has no CHECK at all — `validateRel` permits
`'CUSTOM_REL'`, nothing else stands in the way, and `writeEdge` **resolves** instead of rejecting.
**This is BL-448's literal RED arm**, exactly as PKT-58's Decision 3 found for the `kind` side.

**Ruling: the implementer updates lines 151-156** to assert success and round-trip instead of
rejection:
```ts
// Same proof on the edge side, but the opposite outcome from before PKT-74 (BL-448):
// 'CUSTOM_REL' passes the permissive policy, and after PKT-74 there is no more SQL CHECK to
// reject it either — the write succeeds and round-trips. This assertion was a CHECK-rejection
// expectation prior to PKT-74; see SPEC-PKT-74.md §2.5 for why flipping it here, not adding a
// new test file, is this packet's own literal RED arm (mirrors SPEC-PKT-58.md Decision 3).
await backend.writeEdge(n1, n3, 'CUSTOM_REL');
const customEdges = await backend.getEdges({ src: n1, dst: n3, rel: 'CUSTOM_REL' });
expect(customEdges).toHaveLength(1);
expect(customEdges[0]!.rel).toBe('CUSTOM_REL');
```
Note `'CUSTOM_REL'` no longer needs the `as EdgeRel` cast once Edit D (the widening) lands — leave the
cast in place anyway for this specific line for minimal diff, or remove it; either compiles. **Do not
touch anything else in this file.** AC-2/AC-3/AC-4 (`:162-282`) all use `DEFAULT_TYPE_POLICY` or a
default-vocabulary rel — none constructs a novel rel through a *fresh* store with a *permissive*
policy, so none is affected by Edit A/B (same "zero observable behaviour change for current call
sites" property PKT-58 established for `kind`, now confirmed to hold for `rel` too).

### 2.6 New file — `libs/data/graph/graph-store/src/open-rel-check.bl448.spec.ts`

New spec, following `open-kind-check.bl439.spec.ts`'s structure line for line (same temp-dir
scaffolding, same `track()`/`afterEach` cleanup, same `permissiveTestPolicy` convention naming a novel
value — here `'COMPONENT_REL'`, chosen to echo BL-439's `'component'` kind and make the two files'
provenance obviously paired for a future reader). See §4 for the four ACs plus the type-level test.

### 2.7 Explicitly out of bounds — and why

- **`rebuild-table.ts`** — not touched. No new target DDL shape that changes its inputs.
- **`NODE_TABLE_DDL`, `graphDdl()`'s `kind` line, `INLINE_MIGRATION_DDL`'s `kind` line** — PKT-58's
  territory, already landed, already merged into this branch's base (`86d758ed`). Do not re-touch.
- **`EDGE_TABLE_DDL` (`:294`)** — untouched. See §3 Decision 1.
- **`libs/memory-core/**`** — no call site edited. All `createGraphBackend(adapter)` call sites
  (`cluster.ts` ×3, `enrich-batch.ts`, `entity-episodes.ts`, `list-entities.ts`,
  `near-duplicates.ts`, `supersession-chain.ts`, `related.ts`) continue to get `DEFAULT_TYPE_POLICY`
  and therefore continue to reject any rel outside the closed ten, in TypeScript, before this
  packet's SQL-layer change is ever reached. Wiring a permissive `MemoryOntologyPolicy` is PKT-60's
  job (BL-441), not this one's.
- **`package.json` version bump / `CHANGELOG.md` entry for `@adhd/sox-graph-store`** — PKT-63's job,
  covering the whole train (PKT-73, PKT-59, PKT-58, PKT-74, PKT-60) as one `0.6.0`. Current version
  `0.5.3` (read directly) — leave it.
- **`PUBLIC_EDGE_RELS`'s array contents** — see §3 Decision 4. Comment-only edit in §2.4.
- **Any new column, any new index, any new `NodeFilter`/edge-filter field** — D4 requires none;
  `ix_edge_src`/`ix_edge_dst`/`ix_edge_unique` already exist and need no modification to serve an open
  `rel` (see §4 AC-1's second `it()` for the index-reuse proof).

---

## 3. Every decision, ruled

### Decision 1 — `EDGE_TABLE_DDL` (`index.ts:294`) keeps its `rel` CHECK; direct mirror of `SPEC-PKT-58.md` Decision 1

**The packet's own file list** (in the task brief) names all three CHECK sites — `:94`, `:213`,
`:294` — for deletion, exactly as its sibling packet's brief named `:62`, `:181`, `:262`. **The same
override applies for the same reason.** `EDGE_TABLE_DDL` is `rebuildTable`'s target DDL for the
legacy-rebuild path (`ensureCheckConstraints()`, `:922`: `rebuildTable(this.adapter, 'edge',
EDGE_TABLE_DDL, EDGE_COLUMNS, { skipDrop: true, tx })`), reached whenever `edgeNeedsRebuild` is
`true` — i.e. a genuinely legacy pre-`'DEPENDS_ON'` store being rebuilt **on open**, no operator
invocation, no offline step, no verified backup. If `EDGE_TABLE_DDL` lost its CHECK, that automatic
on-open rebuild would deliver the fully open `rel` schema to such a store — D3's forbidden shape
verbatim (`0010-…:78`), and the exact failure mode the ADR names as "never a live option" (`:90-93`).

**Ruling: leave `EDGE_TABLE_DDL`'s CHECK in place, verbatim, including `'DEPENDS_ON'`.**

**Already a passing, committed regression test, not merely my inference.**
`ensure-check-constraints.bl447.spec.ts` Criterion B (`:325-414`, landed with PKT-73) constructs a
legacy pre-`'DEPENDS_ON'` edge table, runs `applySchema()`, and asserts (`:377,:384-385,:389`):
```ts
expect(after.edge.sql).toContain("'DEPENDS_ON'");
expect(after.edge.sql).toContain('CHECK (rel IN (');
expect(after.edge.sql).not.toContain('CHECK ("rel" IN (');
expect(after.edge.sql).toBe(CLOSED_EDGE_DDL(FULL_EDGE_RELS));   // CLOSED_EDGE_DDL is EDGE_TABLE_DDL's byte-for-byte shape
```
**If the implementer's edit to `index.ts` makes this test fail, that is not a stale test to update —
it is proof the edit is wrong. Revert the `EDGE_TABLE_DDL` change and stop.**

**Losing alternative — edit `:294` too, per the task brief's literal file list.** Rejected: it
re-arms the exact rebuild-loop failure mode BL-447/PKT-73 closed, on the one population (pre-
`'DEPENDS_ON'` legacy stores) still capable of triggering an automatic rebuild today, by inaction
inside an already-existing, already-armed code path.

### Decision 2 — the AC-1 test for "a new store accepts a consumer rel" must inject a custom `TypePolicy`, not rely on `DEFAULT_TYPE_POLICY`

Identical reasoning to `SPEC-PKT-58.md` Decision 2. `DEFAULT_TYPE_POLICY.validateRel` (`:563-569`)
still throws for anything outside the closed ten `DEFAULT_EDGE_RELS`, and `writeEdgeInternal` calls it
unconditionally (`:1162`) — correct, intentional PKT-59 behaviour that this packet must not weaken.
No packet in this train is authorised to widen the *default* policy; ADR-0010 D2 assigns that
vocabulary decision to memory-core (PKT-60). **Ruling:** every AC in §4 that needs a consumer rel to
reach SQL constructs `createGraphBackend(adapter, { typePolicy: permissiveTestPolicy })` with a small
locally-defined `TypePolicy` accepting `'COMPONENT_REL'` (matching `open-kind-check.bl439.spec.ts`'s
`'component'` convention) and delegating everything else to `DEFAULT_TYPE_POLICY`. **Losing
alternative:** relax `DEFAULT_TYPE_POLICY` itself, or add a `rel: '*'` escape hatch — rejected, out of
this packet's authorisation, would make PKT-74 alone observably change memory-core's write behaviour
before PKT-60 lands (violates the same "inert in production until PKT-60" property `SPEC-PKT-58.md`
Risk 1 established for `kind`).

### Decision 3 — `EdgeRel` widens via `EdgeRel | (string & {})`, not a bare `string`, and the compile break must be a dedicated type-level test, not discovered downstream

**Two shapes were live options** (per the task brief and BL-444's own text):
(a) widen `EdgeRel` to plain `string` — simplest, but discards literal autocomplete for the ten known
rels in every parameter position (`writeEdge(src, dst, rel: EdgeRel, ...)`, `getEdges({ rel })`, etc.)
— a real DX regression for the ~15 call sites that currently get autocomplete on `'MENTIONS'` etc.
(b) `EdgeRel | (string & {})` — the "branded string" pattern: literal members still autocomplete,
arbitrary strings are still assignable, TypeScript does not collapse the union to bare `string`.

**Ruling: (b).** This is the shape both the task brief and BL-444 name explicitly as the one that
"preserves autocomplete," and it is strictly better than (a) for every current in-repo parameter-
position call site (all ~15, enumerated by grep in §1) with zero cost — nothing in this repo currently
relies on `EdgeRel` collapsing to `string`. **This does not "fix" the return-position break — nothing
can, without either keeping the closed union (defeating D4's whole purpose) or being `string` outright
(same break, worse DX).** The break is real and is D4's explicit, accepted consequence
(`0010-…:133-138`: *"`EdgeRel` widening is source-breaking, not additive… A consumer that
exhaustively `switch`es on `edge.rel` stops compiling"*).

**The break must be demonstrated, not asserted.** No in-repo consumer performs an exhaustive
`switch`/`assertNever` on `EdgeRel` today (confirmed by grep, §1) — the break cannot be "discovered"
in this codebase's own call sites, so a synthetic type-level test is required. **Ruling: add a
dedicated test in `open-rel-check.bl448.spec.ts`** (§4 AC-Type) using a `// @ts-expect-error`
directive on a line that is a genuine compile error **after** Edit D lands and a genuine "unused
directive" compile error **before** it — i.e. its own red→green pair, verified via `npx nx typecheck
graph-store`, not `npx nx test graph-store` (TS directive correctness is a typecheck-time property).
**Losing alternative — a documented `tsc` failure captured as prose in this spec, with no runnable
artifact:** rejected. §5's `CONTRIBUTING.md`-driven house rules require live verification, and a
prose-only claim is exactly the kind of unverified assertion BL-225 exists to forbid. A `@ts-expect-
error`-gated test file is runnable, checked on every future `typecheck`, and fails loudly (as an
"unused directive" error) if a future edit accidentally makes `EdgeRel` narrow again.

### Decision 4 — `PUBLIC_EDGE_RELS` and `graph-store.spec.ts:28-39` are left value-unchanged; the packet's "say what changed" instruction is satisfied by an explicit "nothing changed, and here is why" comment, not a silent no-op

The task brief requires: *"`PUBLIC_EDGE_RELS` and the widened `EdgeRel` agree, and the spec assertion
reflects reality"* and separately, from BL-448/BL-444: *"`PUBLIC_EDGE_RELS` changes meaning… from 'the
rels this store permits' to 'the rels memory uses'… Move it or re-scope it deliberately and say which
in the packet output; do not silently edit the number."*

**Two readings compete.** Reading A: this packet must actively move/re-scope `PUBLIC_EDGE_RELS`
(e.g. relocate it to memory-core, or expand it to 10, or rename it). Reading B: the re-scoping is a
*framing* decision already made — by PKT-59, which landed the `DEFAULT_EDGE_RELS` constant and its
doc comment explicitly disclaiming any relationship to `PUBLIC_EDGE_RELS` (`:515-519`, quoted in §1)
— and this packet's job is to confirm that framing still holds and make it explicit in the one place
that doesn't yet say so (the test file), not to re-litigate PKT-60's ownership question early.

**Ruling: Reading B.** `PUBLIC_EDGE_RELS` (`:505-513`) is memory-core's currently-registered
tool-surface subset (7 rels: the ten minus `MEMBER_OF`, `PART_OF`, `DEPENDS_ON` — read directly,
`graph-store.spec.ts:30-39` enumerates exactly this). It was **never** "the rels this store permits"
in the sense of the SQL CHECK — the CHECK has permitted 10 since before this ADR existed (confirmed:
`git log -p` on `index.ts:94` predates this session's work). BL-448's characterisation of it changing
"from X to Y" describes a conflation that existed in the *backlog item's own framing*, not a change
this packet makes to the constant's actual runtime behaviour. Reassigning `PUBLIC_EDGE_RELS`'s
ownership to memory-core (moving the constant, or its list, into `libs/memory-core`) is explicitly
PKT-60/BL-441's job — ADR-0010 says the DI wiring shape and (by direct extension) which package owns
which vocabulary list is **not an owner-ruled decision** in this ADR (`0010-…:154-157`, "Architect
recommendations… explicitly NOT owner decisions"). Moving it now, unilaterally, in a packet scoped to
the DDL/type-widening half of D4, would be architecture the implementer is not authorised to invent.

**What this packet does instead, concretely (§2.4):** add a comment to `graph-store.spec.ts` stating
this explicitly, so the next reader (including PKT-60's implementer) does not have to re-derive it
from `index.ts:515-519` alone. **Losing alternative — expand `PUBLIC_EDGE_RELS` to 10, matching
`DEFAULT_EDGE_RELS`:** rejected. It would silently change memory-core's *tool surface* (whatever
consumes `PUBLIC_EDGE_RELS` today gains three new values with zero registration or memory-core-side
decision), which is exactly the "silently edit the number" outcome BL-444 forbids, and it pre-empts
PKT-60's actual ownership decision rather than deferring to it. **Losing alternative — leave the test
unchanged with no comment:** rejected per the task brief's explicit "say what changed" requirement —
even "nothing changed" must be *said*, not left for a future reader to infer.

### Decision 5 — the type-level compile-break test lives in the new BL-448 spec file, not a separate `.type-test.ts`, and is exercised by both `test` and `typecheck`

No precedent exists in this repo for a dedicated `.test-d.ts`/`.typetest.ts` convention (confirmed:
`find . -name "*.test-d.ts" -o -name "*.typetest.ts"` returns nothing outside `node_modules`), and
`tsconfig.json`'s `include: ["src"]` (`tsconfig.json:10`) already typechecks every `.spec.ts` file, so
introducing a new file-naming convention for this one test would add process overhead this codebase
has never needed elsewhere. **Ruling:** the compile-break demonstration is a normal exported function
plus a normal `it()` inside `open-rel-check.bl448.spec.ts`, gated by `@ts-expect-error` (Decision 3).
It is exercised twice, for two different properties: `npx nx typecheck graph-store` proves the
directive is *necessary* (the type-level break exists); `npx nx test graph-store` proves the runtime
function still behaves correctly for the ten known rels (the widening didn't break ordinary usage).

### Decision 6 — verifying BL-448's "insert never attempted" criterion for the *no-CHECK-backstop* case requires a documented temporary-disable-and-restore, not a permanently red test

BL-448's acceptance text: *"`validateRel` rejects an unknown rel before the INSERT is attempted —
assert the insert was never attempted, not merely that an error was thrown, since the CHECK would
also throw."* `type-policy.bl440.spec.ts` AC-2 (`:167-190`) already proves exactly this — but against
a tree where the CHECK is **also** present as a backstop, so it cannot distinguish "the policy caught
it" from "the policy caught it, and if it hadn't, the CHECK would have anyway." That distinction only
becomes observable, and only becomes the *sole* protection, on an open-schema store (post Edit A/B).

**Ruling:** `open-rel-check.bl448.spec.ts` includes a test (§4 AC-2) that repeats AC-2's spy-on-
`executeRun` technique against a **fresh, open-schema** store (`applySchema()` after Edit A/B lands,
default policy, no CHECK backstop). This test is expected to **pass** as committed (validateRel is
already correct, per §0) — it is a permanent regression sentinel, not a red→green criterion in
isolation, matching `SPEC-PKT-58.md`'s AC-3/AC-4 pattern for identity-preservation guards. **But its
value as a guard is only real if it has actually been observed to fail when the guard it protects is
absent** (BL-225's standard: "you must have seen it fail," not "it would fail"). **Ruling, concretely:
before committing this test, the implementer must locally comment out `this.typePolicy.validateRel(rel)`
at `index.ts:1162`, re-run this one test file, observe it fail** (the bogus rel silently inserts,
`edgeInsertAttempted` becomes `true`, the write resolves instead of rejecting — the exact silent-
corruption BL-448 exists to prevent), **then restore the line and re-run to confirm green.** Record
both observations in the commit message body (not as a permanently-disabled code path — the guard
must ship intact). This is the closest this packet can get to a literal red→green cycle for a
criterion whose "fix" (PKT-59's `validateRel` call) already shipped in a prior packet; per BL-225 it
is not optional to skip this because the fix predates this packet — the criterion names BL-448, and
BL-448's acceptance text is explicit that this exact behaviour is what must be shown red-then-green.

---

## 4. Acceptance criteria — each observable, each with a stated RED arm, each naming BL-448

### AC-1 — a new store accepts and round-trips a consumer rel through `writeEdge`/`getEdges`/`getNeighbors`, with an injected `TypePolicy` permitting it

**Assertion:** against a fresh `:memory:` `SqliteAdapterImpl`, `createGraphBackend(adapter, {
typePolicy: permissiveTestPolicy })` where `permissiveTestPolicy.validateRel` accepts `'COMPONENT_REL'`
and delegates everything else to `DEFAULT_TYPE_POLICY` (Decision 2). `applySchema()`, write two nodes,
`writeEdge(a, b, 'COMPONENT_REL')` **resolves** (not rejects). `getEdges({ rel: 'COMPONENT_REL' })`
returns exactly one edge with `rel === 'COMPONENT_REL'`. `getNeighbors(a, { rel: 'COMPONENT_REL' })`
returns `b`.
**RED arm today (pre-Edit A/B):** the identical test, run against the current (pre-this-packet)
`index.ts`, has `writeEdge` **reject** — `INLINE_MIGRATION_DDL`'s live SQL CHECK rejects the INSERT
with `SqliteError: CHECK constraint failed: rel`, translated to `ConstraintError` by
`writeEdgeInternal`'s existing catch (`:1174-1176`). Watch it fail before the DDL edit; watch it pass
after. This is the same RED arm as `type-policy.bl440.spec.ts:154`'s flip (§2.5) — write both, since
they exercise different call surfaces (`type-policy.bl440.spec.ts` proves the identity-preserving
re-open path from AC-1/BL-440's own fixture; this AC proves the plain fresh-store path plus
`getNeighbors`, which BL-440's fixture never calls).

**Second `it()` in the same `describe` — index reuse, informational, not a strict red/green:**
`EXPLAIN QUERY PLAN SELECT * FROM edge WHERE rel = 'COMPONENT_REL' AND src = ?` (or the shape
`getEdges({ src, rel })` actually issues — read `getEdges`'s SQL construction, `:1183-1193`, and match
it) resolves via `ix_edge_src` (or `ix_edge_dst`), i.e. `SEARCH edge USING INDEX ix_edge_src`. Unlike
BL-439's AC-2 (which contrasts against a genuinely different, unindexable `json_each` query shape for
kind's tag-based workaround), there is no pre-existing "workaround" query shape for a consumer edge
rel — a custom rel could not be *written* at all before PKT-59+this packet, so there is nothing to
contrast against. State this explicitly in the test's comment rather than manufacturing an artificial
contrast: this `it()` exists to prove `ix_edge_src`/`ix_edge_dst` need **zero modification** to serve
a consumer rel, the same "zero new index" property PKT-58 established for `ix_node_kind`.

### AC-2 — `validateRel` rejects an unknown rel before the INSERT is attempted, on a fresh open-schema store with no CHECK backstop

Per Decision 6. **Assertion:** fresh `:memory:` adapter, `createGraphBackend(adapter)` (default
policy — no permissive override), `applySchema()`. Wrap `adapter.executeRun` (same technique as
`type-policy.bl440.spec.ts:176-184`) to record whether any `INSERT INTO edge` is attempted.
`writeEdge(a, b, 'BOGUS_REL' as EdgeRel)` **rejects** with `ConstraintError`, and the recorded flag is
`false` — the INSERT was never issued. **RED arm:** per Decision 6, this assertion is expected to pass
as committed (the guard it protects, `index.ts:1162`, already shipped in PKT-59) — its RED arm is
produced by the implementer **locally and temporarily** commenting out that one line, re-running this
test file, and observing this specific assertion fail (the write resolves instead of rejecting, and/or
`edgeInsertAttempted` becomes `true`), then restoring the line. **Do not leave the line commented out
in any commit.** Record both observations (fail-when-disabled, pass-when-restored) in the commit
message body for this test file, naming BL-448 explicitly, per BL-225.

### AC-3 — honest-scope arm: a store created by the OLD (CHECK-bearing) DDL still rejects a consumer rel, and its table identity is unchanged (BL-295/BL-313 guard)

**Assertion:** construct a store using a test-local, byte-for-byte copy of the pre-Edit-B
`INLINE_MIGRATION_DDL` shape (do **not** import a "closed" constant from `index.ts` — after this edit
lands there is none to import for the fresh-DDL paths; follow `open-kind-check.bl439.spec.ts:156-207`'s
own `OLD_CHECK_BEARING_INLINE_DDL` convention, or literally reuse/extend that same test-local literal
if it is convenient to import it — it is currently private to that file, so either duplicate it locally
in the new file, matching its exact text, or promote it to a small shared test-helper module if that is
cleaner; either is acceptable, prefer duplication for now to keep this packet's diff self-contained).
Capture `sqlite_master.rootpage`/`.sql` for `edge` before `applySchema()`. Call
`createGraphBackend(adapter, { typePolicy: permissiveTestPolicy }).applySchema()` (permissive policy
deliberately — proves the **SQL** layer, not the TypeScript layer, is still doing the rejecting; if
the test used `DEFAULT_TYPE_POLICY` it would prove nothing new, per Decision 2). Assert: (a)
`writeEdge(a, b, 'COMPONENT_REL')` **rejects** (raw SQLite CHECK failure translated to
`ConstraintError`, same shape as AC-1's current RED arm), (b) `sqlite_master.rootpage` and `.sql` for
`edge` are **byte-identical** before and after `applySchema()` — no rebuild fired just because a
permissive policy was attached. **RED arm:** this is a **regression guard**, not a red→green criterion
— today's code already passes both halves (an old-DDL store already rejects `'COMPONENT_REL'`, and
`applySchema()` already leaves it untouched, since `hasEnumCheckConstraint` is `true` and
`.includes('DEPENDS_ON')` is `true` for this shape regardless of policy). Run it again, unchanged,
after Edit A/B/C land, and it must still pass — proving the fresh-DDL edit did not accidentally widen
`ensureCheckConstraints()`'s rebuild trigger or leak the open schema onto a CHECK-bearing store. State
this explicitly in the test's own comment (mirrors `SPEC-PKT-58.md` AC-3's identical framing).

### AC-4 — populated round-trip against a synthetic populated store: open, close, reopen, zero rebuilds, zero row/edge loss

Mirrors `open-kind-check.bl439.spec.ts`'s AC-4 (`:238-316`) exactly, scaled to ≥500 nodes/≥500 edges,
using the package's own `writeGraph` API against a real temp-file `SqliteAdapterImpl` (not
`:memory:` — cold-open identity is the point), default policy (this AC is about identity, not
consumer rels). Close, `fs.copyFileSync` the `.db` (+ `-wal`/`-shm` if present), reopen the copy,
`applySchema()`, assert: row/edge counts match exactly, `sqlite_master.rootpage`/`.sql` for `edge`
unchanged from an independent pre-`applySchema()` read of the copy, `PRAGMA foreign_keys` reports `1`,
a spot-check of N arbitrary edge rows is byte-identical pre/post. **RED arm:** regression guard, not
red→green in isolation — its historical RED precedent is BL-313 (40,930 edges cascade-deleted, cited
in ADR-0010's Context, `0010-…:35-37`), the exact failure class this AC exists to catch on a populated
`edge` table specifically. Since PKT-73 already landed (verified §0), run this AC against the
pre-Edit-A/B tree first (it must already pass — a smoke test for a property that holds with or without
this packet), then again post-edit (must still pass). **This AC may be the single dedicated
`open-rel-check.bl448.spec.ts` file's most expensive test (≥500 writes) — that duplication of
`open-kind-check.bl439.spec.ts`'s AC-4 is deliberate**, not laziness: BL-439's AC-4 already proves the
*node* table's identity survives a populated round-trip using `MENTIONS` for every edge (a single,
default-vocabulary rel); this AC additionally spans **multiple** rels per edge batch (mix
`DEFAULT_EDGE_RELS` across the 500 edges, matching AC-4's own node-kind-cycling convention at
`open-kind-check.bl439.spec.ts:251`) so the edge table's rebuild-avoidance is proven under the same
kind of realistic heterogeneity BL-439 proved for `node`, not merely re-asserting BL-439's own result
under a new file name.

### AC-Type — the `EdgeRecord.rel`-into-`EdgeRel` compile break, demonstrated via `@ts-expect-error`

Per Decision 3/5. In `open-rel-check.bl448.spec.ts`, outside any `describe`/`it` (module scope, so
`tsc` type-checks it unconditionally) or inside a trivial `it()` that also runs it at runtime for
sanity:
```ts
function assertNeverRel(x: never): never {
  throw new Error(`unreachable rel: ${String(x)}`);
}

// Exhaustive over the ten known EdgeRel literals. Before Edit D (EdgeRel closed), the `default`
// arm's narrowed type is `never` and `assertNeverRel(rel)` compiles with NO error — so the
// `@ts-expect-error` below is itself an error ("Unused '@ts-expect-error' directive"), and this
// file fails `npx nx typecheck graph-store`. After Edit D (EdgeRel widened to include
// `string & {}`), the `default` arm's type is `string & {}` (not `never`), so
// `assertNeverRel(rel)` is a genuine type error and the directive becomes necessary — the file
// passes typecheck. This is BL-448's demonstrated (not asserted) EdgeRecord.rel-into-EdgeRel
// compile break: a consumer's exhaustive switch over `edge.rel` stops compiling once EdgeRel
// widens, exactly as ADR-0010's Consequences section states.
function classifyRel(rel: EdgeRel): string {
  switch (rel) {
    case 'MENTIONS': return 'mentions';
    case 'SUPPORTS': return 'supports';
    case 'RELATES_TO': return 'relates_to';
    case 'DERIVED_FROM': return 'derived_from';
    case 'SUPERSEDES': return 'supersedes';
    case 'SAME_AS': return 'same_as';
    case 'ASSIGNED_TO': return 'assigned_to';
    case 'MEMBER_OF': return 'member_of';
    case 'PART_OF': return 'part_of';
    case 'DEPENDS_ON': return 'depends_on';
    default:
      // @ts-expect-error BL-448 — see comment above; necessary only once EdgeRel widens (Edit D).
      return assertNeverRel(rel);
  }
}

it('classifyRel handles all ten known EdgeRel literals at runtime (sanity check alongside the compile-time @ts-expect-error above)', () => {
  expect(classifyRel('MENTIONS')).toBe('mentions');
  expect(classifyRel('DEPENDS_ON')).toBe('depends_on');
});
```
**RED arm:** run `npx nx typecheck graph-store` against the tree **before** Edit D — this file fails
typecheck (`error TS2578: Unused '@ts-expect-error' directive.`). Watch it fail, then land Edit D,
re-run, watch it pass. **This is a typecheck-time RED/GREEN, not a `nx test` one — report both
commands' output, not just `nx test`'s.**

### Test-count/tree-state gate

After all edits: `npx nx test graph-store` must report the pre-edit **4 files, 61 tests**, plus the
new tests added under AC-1 (2 `it()`s), AC-2 (1), AC-3 (1), AC-4 (1), AC-Type's runtime sanity `it()`
(1) — at minimum **6 new tests in a 5th file** — all green, plus `type-policy.bl440.spec.ts`'s
existing test count unchanged (one assertion flipped in place, not added/removed). `npx nx typecheck
graph-store` must pass. `node tools/check-suite-tree-state.mjs --project graph-store` must report
`CLEAN` at the moment the suite is run for the record.

---

## 5. Risks

**Risk 1 — this packet is inert in production until PKT-60, and that is correct, not incomplete.**
Identical to `SPEC-PKT-58.md` Risk 1: every current `libs/memory-core` call site supplies no
`typePolicy`, so `DEFAULT_TYPE_POLICY` keeps rejecting any rel outside the closed ten in TypeScript,
before SQL is ever reached. Verify via §4's AC tests, which inject a test policy specifically because
that is the only way to observe this packet's effect before PKT-60 lands.

**Risk 2 — the one real data-loss vector is Decision 1's scenario, closed by *not* editing
`EDGE_TABLE_DDL`.** If the implementer edits `:294` anyway, the failure is silent and delayed: nothing
breaks until a store that still has the pre-`'DEPENDS_ON'` CHECK shape is opened, at which point it
auto-migrates to the fully open schema with no operator consent, no backup, no rollback — BL-313's
shape, via a different trigger. Concrete guard: `ensure-check-constraints.bl447.spec.ts` Criterion B
must still pass unmodified after this packet's edits. **Sequencing that avoids it:** make Edit A/B/D
first, run the full `graph-store` suite (pre-existing 61 tests) **before** writing any new test, treat
any failure in `ensure-check-constraints.bl447.spec.ts` as a stop condition, not a test to fix.

**Risk 3 — `npx nx build graph-store` is destructive (BL-235); `npx nx test`/`typecheck` rebuild
upstream dists (BL-456).** Do not run a bare build to "check" the DDL/type edit compiles — `npx nx
typecheck graph-store` is the correct, non-destructive compile-correctness signal, and it is required
anyway for AC-Type. `npx nx test graph-store` rebuilds `^build` dependencies (`store-adapter`,
`sox-telemetry`, confirmed by this session's own toolchain-verification run in §0) — expected, already
accounted for. Report `check-suite-tree-state.mjs`'s output with every result.

**Risk 4 — do not construct or copy anything under `~/.memory/`.** AC-4 uses a synthetic populated
store built via the package's own write API, never the live production file. If the fixture feels
insufficiently "real," that impulse is wrong — the synthetic store carries the identical protective
value BL-313's guard needs, at zero blast radius.

**Risk 5 — Decision 6's temporary-disable-and-restore step touches `index.ts:1162` transiently.**
This is a real edit-and-revert cycle against a shared-checkout-sensitive file, done in an isolated
worktree (this one) with no other agent present — safe here specifically because of the worktree
isolation this task was dispatched into. Do this step **last**, immediately before the final commit
sequence, so the window in which the guard is disabled is as short as possible and is never
accidentally left uncommitted-but-disabled across a session boundary. Confirm `git diff HEAD --
libs/data/graph/graph-store/src/index.ts` shows zero net change to `writeEdgeInternal` before the
final commit.

---

## 6. The gate — exact nx targets

Run in this order, after edits are complete:

1. `npx nx lint graph-store`
2. `npx nx typecheck graph-store` — **required for AC-Type's red/green**, not optional. Confirmed
   present: `project.json`'s `typecheck` target runs `tsc -p
   libs/data/graph/graph-store/tsconfig.json --noEmit`.
3. `npx nx test graph-store` — expect the pre-edit 61 plus the new AC tests (5 files, ~67+ tests), all
   green.
4. `node tools/check-suite-tree-state.mjs --project graph-store` — quote the output verbatim alongside
   both the typecheck and test results.
5. Do **not** run `npx nx run registry:sync-index` — `graph-store` is a `libs/data/*` package, not a
   registered extension (`libs/data/CLAUDE.md`, "Build rules").
6. Whole-repo gate is **not required** in isolation (single-package change with no consumer edits) —
   but `npx nx affected -t lint,test,typecheck` scoped to this branch's diff is good practice before
   handoff to the reviewer, matching the parallel-dispatch pre-commit convention.

Commit by explicit pathspec, incrementally. Suggested sequence:
1. `index.ts` (Edits A, B, D) + `0000_sad_onslaught.sql` (§2.3) — the DDL/type change itself.
2. `type-policy.bl440.spec.ts` (§2.5's flip) + `graph-store.spec.ts` (§2.4's comment) — updates to
   existing suites the DDL change directly implicates.
3. `open-rel-check.bl448.spec.ts` (new file, §2.6/§4) — the new AC suite, including the
   Decision-6 disable/restore verification recorded in this commit's message body.

Conventional-commit, lowercase subject, scope `memory-core` — matching this repo's established
precedent for `graph-store`-only changes (PKT-59's `9ba8ec70`, PKT-73's `37863fee`, PKT-58's
`ae262a2d`; no dedicated `graph-store` scope exists in this repo's commit history for this package).

---

## Summary of what changes vs. the task brief's literal text

| Site | Task brief said | This spec rules |
|---|---|---|
| `graphDdl()` `:94` | delete CHECK | **delete CHECK** (confirmed) |
| `INLINE_MIGRATION_DDL` `:213` | delete CHECK | **delete CHECK** (confirmed) |
| `EDGE_TABLE_DDL` `:294` | delete CHECK | **leave CHECK in place** (Decision 1 — mirrors PKT-58 Decision 1, passing test as evidence) |
| `EdgeRel` `:364-374` | widen, source-breaking | **widen via `EdgeRel \| (string & {})`** (Decision 3), compile break demonstrated via `@ts-expect-error` (AC-Type) |
| `EdgeRecord.rel` `:424`, assignment `:672` | note return-position risk | **no edit needed** — widened type flows through automatically |
| `writeEdgeInternal` `:1078-1096` (brief's stale line numbers; now `:1157-1181`) | "no runtime validation" — implies this packet must add it | **already added by PKT-59** (`:1162`); this packet verifies it via AC-2/Decision 6, does not add it |
| `PUBLIC_EDGE_RELS` `:505` | "move it or re-scope it deliberately" | **left value-unchanged; re-scoping deferred to PKT-60 explicitly** (Decision 4) — comment added, not silent |
| `graph-store.spec.ts:27-35` (now `:28-39`) | "change it to assert what is now true" | **assertion values unchanged** (nothing about `PUBLIC_EDGE_RELS` became false); explanatory comment added stating so explicitly |
| `drizzle/migrations/0000_sad_onslaught.sql` | not mentioned | delete `rel` CHECK too, documentation-only, zero runtime risk (§2.3) — PKT-58 explicitly deferred this line to this packet |
