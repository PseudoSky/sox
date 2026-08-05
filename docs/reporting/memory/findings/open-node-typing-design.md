# Open node + edge typing in `@adhd/sox-graph-store` — the decided design

**Status:** **DECIDED by the owner 2026-08-05.** Nothing here is implemented.
**Drives:** `BUG-SOXGRAPH-TYPED-NODES-001` (graph, nodeId 563, HIGH, OPEN) → BL-438..BL-444 + BL-447, BL-448; PKT-57..PKT-63 + PKT-67, PKT-68.
**Owner directive:**

> Open `kind` and typing within memory-server rather than CHECK enums. It must be indexed.

---

## 0. The four decisions, and what each one costs

An earlier revision of this document presented four forks with recommendations. The owner has ruled
on all four. **This section is the authorisation every downstream packet cites.** The recommendation
column is retained only where the ruling went against it, because a later reader needs to know the
alternative was considered and rejected, not overlooked.

| # | Decision | Prior recommendation | Consequence |
|---|---|---|---|
| **D1** | **`kind` itself opens. There is no `sub_kind` column.** Owner: *"I see no reason why kind is restricted."* | 1a — add `sub_kind`, leave `kind` coarse | The discriminator is `node.kind`, already indexed by `ix_node_kind`. **Zero new columns, zero new indexes.** But an existing store cannot accept a consumer kind until D3's migration runs — `sub_kind` was the mechanism that would have served existing stores on day one, and it is gone. |
| **D2** | **Enforcement is an injected policy closure**, validated at the write boundary. | 2a — same | Unchanged from the recommendation. graph-store's default policy is syntactic only; the vocabulary descends from memory-core by DI. No registry table, no trigger, **no path from a consumer's type declaration to DDL**. |
| **D3** | **Existing stores: opt-in, operator-invoked, offline migration with verified rollback.** Never automatic, never on open. | 3b — same | Unchanged as a *mechanism*, **changed entirely in role.** Under 1a it was the optional last mile that nothing depended on. Under D1 it is the **only** way any store that exists today — including the live `~/.memory/memory.db` — ever accepts a consumer kind. It moves onto the critical path. |
| **D4** | **`edge.rel` opens in the same pass as `node.kind`.** | 4 — later | The `rel` CHECK is dropped from fresh DDL alongside `kind`'s; the same injected policy validates it; the same operator migration removes it from existing stores; `EdgeRel` widens. |

**D1's stated rationale removes D3's original escape hatch, and D3 is what makes D1 affordable.**
The prior recommendation introduced `sub_kind` for exactly one reason: to reach an indexed
discriminator on a *populated* store without the table rebuild that CHECK removal requires. The owner
has instead accepted the rebuild, gated behind D3. The two decisions are therefore a package: **D1
without a working D3 delivers open typing to new stores only and nothing at all to the ~10,150-node
store this program actually runs on.**

### 0.1 What this architect is flagging as unsafe, per instruction

None of the four decisions is unsafe *as a decision*. Three consequences are, and each has a packet:

1. **The banned operation is now mandatory, not optional** (D1 + D3). Section 2 row 4 —
   rename→create→copy→drop on a populated `node` — was previously off the critical path and
   "conditional, may never be built." It is now the feature's only delivery mechanism for every
   existing store. That operation has already caused one CRITICAL incident on this exact store
   (BL-313, 40,930 edges silently cascade-deleted).[4] The mitigation is not "be careful": it is that
   PKT-61 reuses the *fixed* `skipDrop` sequencing that already survived this, tests against a 90-edge
   fixture with `foreign_keys` asserted ON, and rolls back from a verified backup on any mismatch.
2. **Opening the two CHECKs silently converts an existing repair path into an unconditional
   rebuild-on-every-open loop** — BL-447, §5. This is not a risk, it is a defect the decisions
   *create* on contact, and it reconstitutes BL-295's exact shape without anyone writing a line of
   new rebuild code. **PKT-67 must land before any DDL constant is edited.**
3. **`EdgeRel` is a closed TypeScript union in the published surface** (index.ts:364-374), read back
   out of `EdgeRecord.rel` (:609,:424). Widening it is a source-breaking change for a consumer that
   switches exhaustively — see §7. Under 0.x semver the minor slot *is* the breaking slot, so 0.6.0
   remains the right number, but BL-444's claim that the release is "additive throughout, nobody
   observes a change" is now false for the edge half and has been corrected rather than repeated.

---

## 1. Why BL-295 was reverted

**The revert commit says nothing.** `1446028` ("Revert \"feat(graph-store): extensible node kind
allowlist (BL-295)\"", 2026-07-16 16:42) carries only git's auto-generated body — 19 minutes after
`0ce39c7` landed the feature.[1][2] There is no stated reason in the revert itself. So the
following is split into *what the record says* and *what the diff shows*, and the difference is
marked. **Do not read section 1.2 as the author's stated reason; it is reconstruction from the code.**

### 1.1 What the record does say

The replacement commit `a8715dc` ("BL-295 Option A — kind:'generic' + sub-kind in meta/tags") and
the CHANGELOG correction `8d0ab06` record a **design decision**, not a bug report:[3]

> **The CHECK constraint itself is never extended per consumer** — this is sox-ecosystem's own
> Option A resolution for BL-295, chosen over adding an extensible constructor-level kind allowlist
> (an earlier implementation attempt at the allowlist approach was built, then reverted, per that
> decision).

So the recorded reason is: *"we decided per-consumer CHECK extension is the wrong shape"* — and the
`generic`+sub-kind-in-tags steer that `BUG-SOXGRAPH-TYPED-NODES-001` now objects to was
**the deliberate substitute**, not an oversight. That matters: the item and the revert are two
positions in the same argument, and the owner has now ruled for the item's side — and, under D1,
ruled against the substitute as well.

### 1.2 What the reverted diff shows (reconstruction — stated as such)

The reverted implementation made **the SQLite `CHECK` constraint a function of the constructor
argument of whichever process opened the store last**, and upgraded it by **rebuilding the populated
`node` table implicitly, at construction time**:[2]

```ts
// 0ce39c7, applySchema() step 2
const requiredKinds = [...this.allowedKinds];          // = defaults + opts.kinds
const nodeKindsMissing =
  nodeRow !== undefined && requiredKinds.some((k) => !nodeRow.sql.includes(`'${k}'`));
if (nodeRow && nodeKindsMissing) {
  this.db.transaction(() => {
    rebuildTable(this.db, 'node', nodeTableDDL(requiredKinds), NODE_COLUMNS);  // rename→create→copy→drop
    for (const ddl of NODE_INDEX_DDLS) this.db.exec(ddl);
    this.db.exec(FTS_TRIGGERS);
    ...
```

Six defects follow from that shape:

1. **It performs a rename→create→copy→drop rebuild of a populated shared table, implicitly, on
   open** — triggered by nothing more than a consumer passing a new string to a constructor.
2. **The schema becomes a function of open history, not of the code.** `nodeKindsMissing` only ever
   *widens*. A store's `CHECK` therefore reflects the union of every kind any process has ever
   opened it with, while each process's in-memory `allowedKinds` reflects only its own — so
   `writeNode` rejects, in process B, a kind that is already legal in the table and already present
   in its rows.
3. **It is still a closed enum, now runtime-mutable** — strictly worse than either a closed enum or
   an open column, because it has the rigidity of the former and the unpredictability of the latter.
4. **DDL string interpolation guarded only by `/^[a-z][a-z0-9_]*$/`**, in a published package, on a
   path SQLite cannot parameterise.
5. **All 11 node indexes and the three FTS triggers are dropped and recreated per rebuild**, and an
   interrupted rebuild strands a renamed `node_old`.
6. **Multiple processes share `~/.memory/memory.db`.** Two of them racing that rebuild is unbounded.

**Note the mechanism in defect 2 — a substring probe of live DDL (`sql.includes("'<kind>'")`) used
as a schema-version sentinel. That mechanism is still in the code today** (index.ts:820,825), it
survived the revert because the BL-313 fix reused it, and §5 is about what these four decisions do
to it.

### 1.3 The retrospective vindication — BL-313

**Two days after the revert**, BL-313 was found: `ensureCheckConstraints()`'s
rename→create→copy→drop rebuild — *the exact function BL-295 called* — **silently cascade-deleted
the entire live `edge` table**, 40,930 edges, no exception and nothing in any log.[4]

The mechanism: `edge.src`/`edge.dst` are `REFERENCES node ON DELETE CASCADE` (index.ts:92-93,
:292-293). With `PRAGMA foreign_keys = ON` (always on for this store — `PRAGMAS`, index.ts:7-13),
`ALTER TABLE node RENAME TO node_old` auto-rewrites `edge`'s FK to point at `node_old`; SQLite then
treats `DROP TABLE node_old` as deleting every row for cascade purposes, and `edge` is emptied.
It was caught only because the running backend had `schemaApplied` cached — *the next cold start
would have wiped it.*

BL-295 shipped that operation on a **consumer-controlled trigger**. It would have converted a
migration hazard that fires once per legacy store into one that fires whenever any consumer
introduces a type.

**Conclusion.** The revert's stated basis is a design decision; its strongest justification arrived
two days later and is decisive. **The killer is not "extensible kinds" — it is "schema mutation as
a side effect of opening a connection."** D3 is precisely the rule that the rebuild is never reached
from `applySchema()`, and §5/BL-447 is the audit that the decisions have not re-armed that path by
accident. D2 is what guarantees a consumer's type declaration cannot reach DDL under any input.

---

## 2. The constraint that shapes everything: which SQLite ops are safe here

| Operation | Cost on a populated `node` | Reversible? | Cascade risk |
|---|---|---|---|
| `ALTER TABLE node ADD COLUMN …` | metadata-only, no row rewrite | yes (`DROP COLUMN`, SQLite ≥3.35) | none — no FK, no rename |
| `CREATE INDEX …` | builds one btree, table untouched | yes, exactly (`DROP INDEX`) | none |
| `CREATE TABLE IF NOT EXISTS` with new DDL | **no-op** on an existing table | n/a | none |
| **Drop/alter a `CHECK`** | **rename→create→copy→drop rebuild** | only from backup | **BL-313 — total `edge` loss** |

Rows 1 and 2 were the whole prior design. **Under D1 they are no longer needed and no longer
sufficient:** no column is added, no index is added (`ix_node_kind` already exists, index.ts:319,
:105, :226, and is populated 10,150/10,150 on the live store), and the only operation that delivers
the feature to an existing store is **row 4**.

Row 3 is what makes *new* stores free, and it is the precedent this repo already set and documented:
BL-430 landed `json_valid` CHECKs on `node.tags`/`node.meta` **for new stores only**, explicitly
citing BL-313, BL-337 and BL-361 as the reason not to rebuild.[5] Dropping the `kind` and `rel`
CHECKs from fresh DDL is the same move with the same accepted rationale — `CREATE TABLE IF NOT
EXISTS` (index.ts:59, :181) no-ops on every store that already exists.

**The honest summary of D1+D3+D4:** new stores get the feature for free via row 3; every existing
store gets it only via row 4, once, deliberately, offline, with rollback.

## 3. Honouring `data→data|shared` while typing "moves into memory-server"

`libs/data/CLAUDE.md` forbids `data→memory-core` and lint-enforces it. Validation therefore cannot
be *imported* upward; it must **descend by injection** (ADR-0006: live objects cross via DI):

```ts
// @adhd/sox-graph-store — knows nothing about memory's ontology
export interface TypePolicy {
  validateKind(kind: string): void;   // throws ConstraintError
  validateRel(rel: string): void;     // throws ConstraintError — D4
}
createGraphBackend(adapter, { typePolicy?: TypePolicy })
```

graph-store's **default** policy is *syntactic only* — identifier shape and length, no vocabulary.
`memory-core` supplies `MemoryOntologyPolicy` (the six kinds, the ten rels, plus whatever
memory-server registers) when it constructs the backend. The store enforces what it is handed; it
never knows what memory is.

**The property that makes this not-BL-295:** `TypePolicy` is pure in-process policy with **no path to
DDL**. There is no `opts.kinds → CHECK → rebuildTable` edge, because there is no `CHECK` to reach.
A consumer registering a type cannot cause a schema change under any input.

**Two enforcement points, both funnels — verified, not assumed.** Every node write reaches
`writeNode` (index.ts:862): `writeNodeBatch` (:976) and `writeGraph` (:982) both loop over it rather
than issuing their own INSERT. Every edge write reaches `writeEdgeInternal` (:1078): `writeEdge`
(:1074) and `writeGraph` both delegate. So D2 needs exactly two call sites, not an audit of every
statement.

**The seam is leaky and PKT-60 must close it, not decorate it.** `createGraphBackend(adapter)` is
called with a bare adapter from **eight files, eleven references** across memory-core —
`enrich-batch.ts:189`, `entity-episodes.ts:119`, `cluster.ts:749,820,886`, `near-duplicates.ts:44`,
`list-entities.ts:63`, `related.ts:95`, `supersession-chain.ts:49`. A policy passed at *some* of
those constructions yields partial enforcement that looks total in review. memory-core needs **one**
composition point that supplies the policy, with the raw factory not called directly from feature
modules — otherwise the ninth call site added next month silently opts out.

---

## 4. The decided design

### 4.1 `node.kind` is the discriminator (D1)

The `kind` CHECK (index.ts:62 in `graphDdl()`, :181 in `INLINE_MIGRATION_DDL`, :262 in
`NODE_TABLE_DDL`) is removed. `kind` stays `TEXT NOT NULL`. `ix_node_kind` — which already exists in
all three live DDL paths — becomes the consumer's index at zero cost. `NodeMeta.kind` is **already**
typed `string` (index.ts:379), so no public type widens on the node side.

There is **no `sub_kind` column and no `ix_node_sub_kind`.** The `kind:'generic'` + tag convention
continues to work byte-identically for anyone already using it — nothing forces a migration of
*data* — but it is no longer the sanctioned answer, and `writeNode`'s message telling consumers to
adopt it (index.ts:865-869) is deleted rather than softened.

**Existing stores are unchanged by this packet.** Their `CHECK (kind IN (…))` survives
`CREATE TABLE IF NOT EXISTS`, so a consumer kind is rejected by SQLite even with the policy
permitting it. That is D3's job, not this one, and §5 is what stops it happening by accident first.

### 4.2 Vocabulary lives in an injected policy (D2)

As §3. graph-store ships a default syntactic policy; memory-core owns memory's vocabulary;
memory-server exposes registration. No registry table, no trigger on the hot write path, no storage
cost, and — the load-bearing property — no input by which registering a type alters a schema.

### 4.3 Existing stores migrate only when an operator says so (D3)

An explicit, operator-invoked, offline command. Never reachable from `applySchema()`. It must:
take a verified pre-migration backup; rebuild `node` **and** `edge` in one transaction using
`rebuildTable`'s existing `skipDrop` sequencing (rebuild-table.ts:52-54 — copy *every* FK-related
table before dropping *any* `_old`, which is the BL-313 fix and is already modelled at
index.ts:828-850); recreate all 11 node indexes, the 4 edge indexes, the FTS triggers and the FTS
content (index.ts:839-849); verify node count, edge count, per-relation breakdown and a content
checksum against the pre-migration snapshot; and **roll back to the backup automatically on any
mismatch**.

Because D1 makes this the sole delivery path for existing stores, it is no longer conditional and no
longer last. It is still **off the critical path for new-store functionality** and still must never
be a prerequisite for opening a connection.

**Turso is a hard constraint on this packet, not a footnote.** The node rebuild drops and repopulates
`fts_node`. BL-337 records the Turso FTS index as un-`REINDEX`-able and BL-361 records a driver PANIC
that kills the process on a malformed FTS row.[5] A migration that runs blind on a Turso-backed store
can therefore take the process down mid-rebuild. The command must detect the backend and either
refuse or take the documented BL-337 repair path — decide it explicitly, do not discover it.

### 4.4 `edge.rel` opens in the same pass (D4)

The `rel` CHECK (index.ts:94, :213, :294) is removed from fresh DDL alongside `kind`'s, validated by
the same policy at `writeEdgeInternal`, and removed from existing stores by the same operator
migration. There is currently **no runtime `rel` validation at all** — `writeEdgeInternal` (:1078-1096)
passes `rel` straight into the INSERT and only translates the resulting SQLite error (:1091). The TS
`EdgeRel` union (:364-374) is the sole guard for TypeScript callers and no guard whatsoever for a
JavaScript caller or a JSON tool payload. **So dropping the CHECK without landing the policy in the
same change leaves edges completely unvalidated on new stores** — a strictly worse state than today.
D2 and D4 are therefore inseparable.

`EdgeRel` widens (§7). `PUBLIC_EDGE_RELS` (:505) and the spec asserting it has exactly 7 values
(graph-store.spec.ts:28-35) become a statement about *memory's* vocabulary, which is memory-core's
property under D2 — so it moves, or it is re-scoped, deliberately.

---

## 5. The trap these decisions create, which must be defused first — BL-447

`ensureCheckConstraints()` (index.ts:811-852) decides whether to rebuild `node` and `edge` by
**substring-probing the live DDL for a literal that exists only inside the CHECK clause being
removed**:

```ts
const nodeNeedsRebuild = !!nodeRow && !nodeRow.sql.includes("'generic'");   // :820
const edgeNeedsRebuild = !!edgeRow && !edgeRow.sql.includes("'DEPENDS_ON'"); // :825
```

`'generic'` appears in `NODE_TABLE_DDL` only at :262, inside `CHECK (kind IN (…))`. `'DEPENDS_ON'`
appears in `EDGE_TABLE_DDL` only at :294, inside `CHECK (rel IN (…))`. Both are the exact clauses D1
and D4 delete. Two consequences follow mechanically, and neither requires anyone to write new
rebuild code:

1. **A store migrated to the open schema fails the probe forever.** Its DDL no longer contains
   `'generic'` or `'DEPENDS_ON'`, so `nodeNeedsRebuild` and `edgeNeedsRebuild` are `true` on **every**
   `applySchema()` — i.e. every cold open of every process — each one performing a full
   rename→create→copy→drop of both populated tables, dropping and rebuilding 11 indexes, 4 indexes,
   the FTS triggers and the entire FTS content. That is an unbounded rebuild loop on the table
   BL-313 emptied, running automatically on connection open, with concurrent processes sharing the
   file.
2. **Merely editing the DDL constants performs the D3-banned migration by inaction.** The rebuild
   target is `NODE_TABLE_DDL`/`EDGE_TABLE_DDL`. Once those lose their CHECKs, any store that already
   trips the probe — every pre-`'generic'` legacy store — is silently rebuilt *to the open schema*
   the next time it is opened. Automatic-on-open is the mechanism D3 exists to forbid and the
   mechanism BL-295 was reverted for.

**A packet that edits only the DDL constants and ships a green suite has therefore built BL-295 a
second time**, because the trigger is inherited rather than authored. In-repo tests create fresh
stores that never trip the probe, so nothing in the suite would go red.

**Fix shape:** replace the substring sentinels with an explicit, positive schema-shape predicate
(`user_version`, an `_adapter_meta` row, or a parse of the CHECK's presence rather than a search for
one of its literals), and keep the automatic path targeting the **closed** DDL — the open DDL is
reachable only from D3's operator command. The auto path's remaining job is what it was built for:
upgrading a genuinely legacy store to the current *closed* shape. **PKT-67 lands this before any DDL
constant is touched.**

---

## 6. Acceptance bar (from the item, restated for D1)

> the query plan for "all nodes of consumer type X" must **not** be a `json_each` scan.

Testable form, asserted via `EXPLAIN QUERY PLAN`:

- **Red (today):** `SEARCH node …` + `SCAN json_each VIRTUAL TABLE INDEX` — the correlated
  `EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ?)` at index.ts:678,683 and
  memory-filters.ts:101,108 / recall.ts:445,451.
- **Green:** `SEARCH node USING INDEX ix_node_kind (kind=?)`, with **zero** occurrences of
  `json_each` anywhere in the plan.

The index named in the green arm changed from `ix_node_sub_kind` to `ix_node_kind` under D1. This is
the one place where D1 is strictly cheaper than the prior recommendation: the index already exists,
is already populated, and is already used by three code paths — so the green arm needs no new DDL at
all on a store where `kind` is open.

## 7. Release, semver, and what is genuinely non-breaking

`@adhd/sox-graph-store` is **0.5.2, published**. Its in-repo dependents are `analysis`,
`vector-store`, `hybrid-search`, and `memory-core` (`workspace:*` in source, pinned exactly on
publish) — so **every graph-store version costs four downstream republishes**, which is why a
one-line fix cost eight releases on 2026-08-04.

**Therefore: one release train, not one per packet.** PKT-67, PKT-58, PKT-59, PKT-68 and PKT-60 all
land on `main` before anything is published and ship together as a single **0.6.0**. PKT-61 and
PKT-62 ride the same version. PKT-63 executes the train.

**What is non-breaking (assert it, do not claim it):**
- `episode/entity/claim/community/session/generic` keep working, unchanged.
- The `kind:'generic'` + tag convention keeps working — **no consumer is forced to migrate data.**
- Every existing row reads back identically; no column is added or removed.
- A caller who passes no `typePolicy` gets today's six-kind/ten-rel behaviour.

**What is breaking, and was previously mis-stated as additive:**
- **`EdgeRel` widens** (D4). It is a closed union today (index.ts:364-374) appearing in ~15 public
  signatures and, crucially, in *return* position via `EdgeRecord.rel` (:424, assigned at :609). A
  consumer that exhaustively `switch`es on `edge.rel` stops compiling when the union becomes
  `string`. Widening a *parameter* is safe; widening a *return* is not. `EdgeRel | (string & {})`
  preserves autocomplete but does not make the assignment `const r: EdgeRel = rec.rel` legal, so it
  is a mitigation, not an escape.
- **`PUBLIC_EDGE_RELS`'s meaning changes** from "the rels this store permits" to "the rels memory
  uses", and graph-store.spec.ts:28-35 asserts its length.
- Under 0.x semver the **minor slot is the breaking slot**, so **0.6.0 is still the correct number** —
  but the release note must say what breaks rather than assert that nothing does.

**Coordination with FEAT-SOX-001 (Turso adapter, OPEN).** Same `store`/schema layer. Under D1 this
design no longer emits `ADD COLUMN`/`CREATE INDEX` on existing stores at all; it emits **nothing**
until an operator runs D3's migration, and that migration is the one that collides with BL-337's
un-`REINDEX`-able Turso FTS index and BL-361's PANIC (§4.3). **The two workstreams must not both hold
`applySchema()`.** PKT-67 and PKT-59 declare the conflict.

---

## 8. Live-store safety rules for every packet below

- **Never write to `~/.memory/*`.** Migration work runs against a `cp` of a WAL-consistent backup —
  the method BL-313's root-cause used.
- **Never call `rebuildTable` on a populated `node` outside PKT-61**, and inside PKT-61 only behind
  an explicit operator command with a verified pre-backup.
- **Never edit `NODE_TABLE_DDL` / `EDGE_TABLE_DDL` before PKT-67 lands.** They are the target of an
  automatic on-open rebuild path (§5); changing them is a live migration, not a constant edit.
- `PRAGMA foreign_keys` state must be asserted in any test touching a rebuild — BL-313 was a
  `foreign_keys = ON` interaction and is invisible with it off.

---

**Citations:** [wip/turso-live-metrics, architect-reviewer, claude, BUG-SOXGRAPH-TYPED-NODES-001 design revision,
1: `git log -1 --format=%B 1446028` (bare auto-generated revert body) and `git show --stat 1446028`;
2: `git show 0ce39c7 -- libs/data/graph/graph-store/src/index.ts` (reverted `applySchema` step 2, `nodeTableDDL`, `KIND_NAME_RE`, `GraphBackendOpts.kinds`);
3: CHANGELOG.md:2245-2273 (the Option A record, incl. "an earlier implementation attempt at the allowlist approach was built, then reverted, per that decision"), commits a8715dc, 8d0ab06;
4: CHANGELOG.md:1986-2040 (BL-313 CRITICAL — `DROP TABLE node_old` cascading into `edge`, 40,930 edges, confirmed live; the `skipDrop` fix; the 90-edge fixture);
5: libs/data/graph/graph-store/src/index.ts:15-42 (BL-430 "new stores only, and that is a deliberate decision" comment citing BL-337/BL-361/BL-313);
6: libs/data/graph/graph-store/src/index.ts:7-13 (`PRAGMAS`, `foreign_keys = ON`), :59,:181 (`CREATE TABLE IF NOT EXISTS` in both fresh-DDL paths), :62,:181,:262 (the three `kind` CHECK declarations), :92-93,:292-293 (`edge` FK `ON DELETE CASCADE`), :94,:213,:294 (the three `rel` CHECK declarations), :105,:226,:319 (`ix_node_kind` in three live paths), :257 (`DEFAULT_NODE_KINDS`), :364-374 (`EdgeRel` closed union), :379 (`NodeMeta.kind?: string` — already open), :424,:609 (`EdgeRecord.rel` return position), :505 (`PUBLIC_EDGE_RELS`), :678,:683 (`json_each` tag filter), :811-852 (`ensureCheckConstraints` — the substring sentinels at :820,:825 and the skipDrop-sequenced rebuild at :828-850), :862-870 (`writeNode` kind validation + the `generic`-steer message), :976,:982 (`writeNodeBatch`/`writeGraph` funnel through `writeNode`), :1074-1096 (`writeEdge`/`writeEdgeInternal` — no `rel` validation at all);
7: libs/data/graph/graph-store/src/rebuild-table.ts:41-55 (`doRebuild` rename→create→copy→drop and the `skipDrop` branch);
8: libs/data/graph/graph-store/src/graph-store.spec.ts:28-35 (`PUBLIC_EDGE_RELS` length assertion);
9: libs/memory-core/src/memory-filters.ts:101,108 and libs/memory-core/src/recall.ts:445,451 (`json_each` tag filters in the consumer);
10: `createGraphBackend` call sites — libs/memory-core/src/enrich-batch.ts:189, entity-episodes.ts:119, cluster.ts:749,820,886, near-duplicates.ts:44, list-entities.ts:63, related.ts:95, supersession-chain.ts:49 (eight files, and the definition in graph-store index.ts);
11: libs/data/CLAUDE.md ("`data→memory-core` is also forbidden", lint-enforced);
12: docs/decisions/0007-memory-single-writer-architecture.md:55 (D1 — memory hosts, `data/*` owns);
13: libs/data/graph/graph-store/package.json:3 (version 0.5.2, `private: false`), and the four in-repo dependents' package.json `@adhd/sox-graph-store` entries (analysis:28, vector-store:27, hybrid-search:28, memory-core:28);
14: `backlog_list_items {repo:"sox-ecosystem"}` → FEAT-SOX-001 status OPEN]
