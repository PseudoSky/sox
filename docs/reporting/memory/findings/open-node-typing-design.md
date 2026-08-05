# Open node typing in `@adhd/sox-graph-store` — design, forks, and why BL-295 died

**Status:** design for owner decision. Nothing here is implemented.
**Drives:** `BUG-SOXGRAPH-TYPED-NODES-001` (graph, nodeId 563, HIGH, OPEN) → BL-438..BL-444, PKT-57..PKT-63.
**Owner directive being designed against (settled, not re-litigated here):**

> Open `kind` and typing within memory-server rather than CHECK enums. It must be indexed.

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
positions in the same argument, and the owner has now ruled for the item's side.

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

### 1.3 The retrospective vindication — BL-313

**Two days after the revert**, BL-313 was found: `ensureCheckConstraints()`'s
rename→create→copy→drop rebuild — *the exact function BL-295 called* — **silently cascade-deleted
the entire live `edge` table**, 40,930 edges, no exception and nothing in any log.[4]

The mechanism: `edge.src`/`edge.dst` are `REFERENCES node ON DELETE CASCADE`. With
`PRAGMA foreign_keys = ON` (always on for this store, `PRAGMAS` in index.ts),
`ALTER TABLE node RENAME TO node_old` auto-rewrites `edge`'s FK to point at `node_old`; SQLite then
treats `DROP TABLE node_old` as deleting every row for cascade purposes, and `edge` is emptied.
It was caught only because the running backend had `schemaApplied` cached — *the next cold start
would have wiped it.*

BL-295 shipped that operation on a **consumer-controlled trigger**. It would have converted a
migration hazard that fires once per legacy store into one that fires whenever any consumer
introduces a type.

**Conclusion.** The revert's stated basis is a design decision; its strongest justification arrived
two days later and is decisive. **The killer is not "extensible kinds" — it is "schema mutation as
a side effect of opening a connection."** Every design below is judged first on whether it can ever
reach DDL from a consumer's type declaration. The recommended one cannot, structurally.

---

## 2. The constraint that shapes everything: which SQLite ops are safe here

| Operation | Cost on a populated `node` | Reversible? | Cascade risk |
|---|---|---|---|
| `ALTER TABLE node ADD COLUMN sub_kind TEXT` | metadata-only, no row rewrite | yes (`DROP COLUMN`, SQLite ≥3.35) | none — no FK, no rename |
| `CREATE INDEX ix_node_sub_kind ON node(sub_kind) WHERE sub_kind IS NOT NULL` | builds one btree, table untouched | yes, exactly (`DROP INDEX`) | none |
| `CREATE TABLE IF NOT EXISTS` with new DDL | **no-op** on an existing table | n/a | none |
| **Drop/alter a `CHECK`** | **rename→create→copy→drop rebuild** | only from backup | **BL-313 — total `edge` loss** |

This table is the entire design. Getting consumer types into an **indexed** discriminator needs only
rows 1 and 2, both of which are online, cheap, and exactly reversible. Only *literally removing the
`kind` CHECK from an already-populated store* needs row 4.

Row 3 is the precedent this repo already set and documented: BL-430 landed `json_valid` CHECKs on
`node.tags`/`node.meta` **for new stores only**, explicitly citing BL-313, BL-337 and BL-361 as the
reason not to rebuild.[5] Opening `kind` in fresh DDL is the same move, with the same rationale
already accepted.

## 3. Honouring `data→data|shared` while typing "moves into memory-server"

`libs/data/CLAUDE.md` forbids `data→memory-core` and lint-enforces it. Validation therefore cannot
be *imported* upward; it must **descend by injection** (ADR-0006: live objects cross via DI):

```ts
// @adhd/sox-graph-store — knows nothing about memory's ontology
export interface KindPolicy {
  validate(kind: string, subKind?: string): void;   // throws ConstraintError
}
createGraphBackend(adapter, { kindPolicy?: KindPolicy })
```

graph-store's **default** policy is *syntactic only* — identifier shape and length, no vocabulary.
`memory-core` supplies `MemoryOntologyPolicy` (the six kinds, plus whatever memory-server registers)
when it constructs the backend. The store enforces what it is handed; it never knows what memory is.

**The property that makes this not-BL-295:** `KindPolicy` is pure in-process policy with **no path to
DDL**. There is no `opts.kinds → CHECK → rebuildTable` edge, because there is no `CHECK` to reach.
A consumer registering a type cannot cause a schema change under any input.

---

## 4. Forks — for the owner to decide

### Fork 1 — where does a consumer type physically land?

| | Mechanism | Live store today | Indexed? | Cost |
|---|---|---|---|---|
| **1a (rec.)** | new `sub_kind TEXT` column + partial index; `kind` stays coarse | works immediately, `ADD COLUMN` only | `ix_node_sub_kind` | one additive column |
| 1b | widen `kind` itself; consumer writes `kind:'repository'` | **requires the banned rebuild** on all ~10,150 existing rows | `ix_node_kind`, free | BL-313 exposure |
| 1c | both — open `kind` *and* add `sub_kind` | as 1b | both | largest surface |

**Recommendation: 1a, with 1b's fresh-store half.** New stores get an open `kind` (no CHECK) via
`CREATE TABLE IF NOT EXISTS`, costing nothing. Every store — new and existing — gets `sub_kind`.
This lands consumer types in a real index on day one **without ever performing the banned operation**,
and it makes the existing `kind:'generic'` + tag convention *first-class and indexed* rather than
replacing it: `generic` + `sub_kind:'repository'` is the same idea with the `json_each` scan removed.

The counter to be honest about: 1a keeps two discriminator columns, which is arguably the "two
parallel typing systems" the item complains about. The reply is that the item explicitly sanctions
it — *"If a `sub_kind`/`type` column is introduced for structured extension types, index that too"* —
and that under 1a `kind` and `sub_kind` are a coarse/fine pair with one owner each, not two
competing conventions.

### Fork 2 — how is the vocabulary enforced?

| | Mechanism | Consumer→DDL path? | Discoverable? |
|---|---|---|---|
| **2a (rec.)** | injected `KindPolicy` closure, validated at the write boundary | **none** | via the policy object |
| 2b | `node_kind` registry table + FK/trigger on `node.kind` | none, but adds a table + trigger to the hot write path | yes, queryable |
| 2c | no store-level enforcement at all; memory-core validates, store accepts anything | none | no |

**Recommendation: 2a.** 2b is the "registered-kinds table" option and it is genuinely attractive for
discovery — but a trigger or FK on every `node` insert taxes the hot write path this program has
spent weeks on, and a registry row is *itself* schema-ish state that two processes can disagree
about. 2c gives up the ability of a published library to protect a consumer from a typo. 2a keeps
enforcement where the domain lives (the owner's directive) at zero storage cost. If discovery
matters later, a `SELECT DISTINCT sub_kind` over `ix_node_sub_kind` is a covering index scan.

### Fork 3 — do existing stores ever get an open `kind`?

| | Mechanism | Risk |
|---|---|---|
| 3a | never — existing stores use `generic` + `sub_kind` forever | zero; but the directive "open `kind`" is only met for new stores |
| **3b (rec.)** | opt-in, explicit, offline CLI migration with pre-backup, row-count verify, and proven rollback | bounded, operator-initiated |
| 3c | automatic on open | **this is BL-295. Banned.** |

**Recommendation: 3b**, sequenced *last* (PKT-61) and never on the critical path. It must be an
explicit operator command, never reachable from `applySchema()`.

### Fork 4 — does `edge.rel` open in the same pass?

**Recommendation: later (PKT-63 records the decision, does not implement).** `rel` has the identical
closed-CHECK problem, but `edge` is the table BL-313 destroyed and its FK topology is the reason.
Opening `rel` has no `sub_kind`-shaped safe path (an edge's whole identity *is* its `rel`), so it is
strictly the row-4 operation. Land node typing, prove the migration machinery on the safe case,
then revisit. **Surfaced explicitly so it is a decision, not an omission.**

---

## 5. Acceptance bar (from the item, kept)

> the query plan for "all nodes of consumer type X" must **not** be a `json_each` scan.

Testable form, asserted via `EXPLAIN QUERY PLAN`:

- **Red (today):** `SEARCH node ... ` + `SCAN json_each VIRTUAL TABLE INDEX` — the correlated
  `EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ?)` at index.ts:678,683 and
  memory-filters.ts:101,108 / recall.ts:445,451.
- **Green:** `SEARCH node USING INDEX ix_node_sub_kind (sub_kind=?)`, with **zero** occurrences of
  `json_each` anywhere in the plan.

## 6. Release & migration sequencing

`@adhd/sox-graph-store` is **0.5.2, published**. Its in-repo dependents are `analysis`,
`vector-store`, `hybrid-search`, and `memory-core` (`workspace:*` in source, pinned exactly on
publish) — so **every graph-store version costs four downstream republishes**, which is why a
one-line fix cost eight releases today.

**Therefore: one release train, not one per packet.** PKT-58, PKT-59 and PKT-60 all land on
`main` before anything is published, and ship together as a single **0.6.0 minor** (additive: new
column, new optional filter field, new optional option — no removals, no behaviour change for a
caller that passes nothing). PKT-61 and PKT-62 ride the same version. PKT-63 executes the train.

Backwards compatibility held explicitly:
- `episode/entity/claim/community/session/generic` keep working, unchanged.
- The `generic` + tag convention keeps working — **no consumer is forced to migrate.**
- `sub_kind` is nullable; every existing row reads back identically.
- A caller who passes no `kindPolicy` gets today's six-kind behaviour.

**Coordination with FEAT-SOX-001 (Turso adapter, OPEN).** Same `store`/schema layer. The additive
`ADD COLUMN` + `CREATE INDEX` are the *only* DDL this design emits on existing stores, and both are
engine-neutral — no `REINDEX`, no FTS rebuild, so BL-337's un-`REINDEX`-able Turso FTS index and
BL-361's PANIC are not touched. **The two workstreams must not both hold `applySchema()`.**
PKT-58 declares the conflict.

---

## 7. Live-store safety rules for every packet below

- **Never write to `~/.memory/*`.** Migration work runs against a `cp` of a WAL-consistent backup —
  the method BL-313's root-cause used.
- **Never call `rebuildTable` on a populated `node` outside PKT-61**, and inside PKT-61 only behind
  an explicit operator command with a verified pre-backup.
- `PRAGMA foreign_keys` state must be asserted in any test touching a rebuild — BL-313 was a
  `foreign_keys = ON` interaction and is invisible with it off.

---

**Citations:** [wip/turso-live-metrics, architect-reviewer, claude, BUG-SOXGRAPH-TYPED-NODES-001 design,
1: `git log -1 --format=%B 1446028` (bare auto-generated revert body) and `git show --stat 1446028`;
2: `git show 0ce39c7 -- libs/data/graph/graph-store/src/index.ts` (reverted `applySchema` step 2, `nodeTableDDL`, `KIND_NAME_RE`, `GraphBackendOpts.kinds`);
3: CHANGELOG.md:2245-2273 (the Option A record, incl. "an earlier implementation attempt at the allowlist approach was built, then reverted, per that decision"), commits a8715dc, 8d0ab06;
4: CHANGELOG.md:1986-2040 (BL-313 CRITICAL — `DROP TABLE node_old` cascading into `edge`, 40,930 edges, confirmed live);
5: libs/data/graph/graph-store/src/index.ts:15-42 (BL-430 "new stores only, and that is a deliberate decision" comment citing BL-337/BL-361/BL-313);
6: libs/data/graph/graph-store/src/index.ts:62 (node DDL `kind` CHECK), :105,:226,:319 (`ix_node_kind` in three live paths), :257 (`DEFAULT_NODE_KINDS`), :678,:683 (`json_each` tag filter), :863-869 (the `generic`-steer `ConstraintError` in `writeNode`);
7: libs/memory-core/src/memory-filters.ts:101,108 and libs/memory-core/src/recall.ts:445,451 (`json_each` tag filters in the consumer);
8: libs/data/CLAUDE.md ("`data→memory-core` is also forbidden", lint-enforced);
9: docs/decisions/0007-memory-single-writer-architecture.md:55 (D1 — memory hosts, `data/*` owns);
10: libs/data/graph/graph-store/package.json:3 (version 0.5.2, `private: false`), and the four in-repo dependents' package.json `@adhd/sox-graph-store` entries (analysis:28, vector-store:27, hybrid-search:28, memory-core:28);
11: `backlog_list_items {repo:"sox-ecosystem"}` → FEAT-SOX-001 status OPEN]
