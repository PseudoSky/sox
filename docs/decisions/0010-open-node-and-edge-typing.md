# ADR-0010 — Open `node.kind` and `edge.rel` typing in `@adhd/sox-graph-store`

**Status:** Accepted · 2026-08-05
**Relates to:** BL-438 (this record), BL-295 (reverted precedent), BL-313 (the cascade-delete
incident that shapes D3), BL-447 (the rebuild-loop trap D1+D4 create, gated closed by PKT-73),
BL-448 (D4's runtime-validation half), ADR-0006 (bundling/DI conventions unaffected by this ADR).
**Drives:** `BUG-SOXGRAPH-TYPED-NODES-001`; the nine-packet Wave J open-typing group (PKT-58, PKT-59,
PKT-60, PKT-61, PKT-62, PKT-63, PKT-73, PKT-74) each cite this ADR by section instead of restating
the ruling from memory.
**Full design rationale:** `docs/reporting/memory/findings/open-node-typing-design.md` (the decided
design; §0 is the decision table this ADR canonicalizes, §5 is BL-447, §7 is the release/semver
position). This ADR is the citable record of the four ownership decisions; the findings doc remains
the fuller working document and is not superseded by it.

## Context

`node.kind` and `edge.rel` in `@adhd/sox-graph-store`'s SQLite schema are closed by `CHECK (kind IN
(…))` / `CHECK (rel IN (…))` constraints enumerating the library's own six node kinds and ten edge
relations (`libs/data/graph/graph-store/src/index.ts:62,181,262` for the three `kind` CHECK
declarations; `:94,213,294` for the three `rel` CHECK declarations). External consumers — chiefly
memory-server — cannot register their own vocabulary at the schema level. The sanctioned workaround,
`kind:'generic'` plus a sub-kind string in `tags`/`meta`, has no index: `ix_node_kind` exists and is
populated (10,150/10,150 rows on the live store; `index.ts:319,:105,:226` are its three live DDL/index
paths) and serves the library's six built-in kinds, but every tag-based lookup is a correlated
`EXISTS (SELECT 1 FROM json_each(n.tags) WHERE value = ?)` (`index.ts:678,683`;
`libs/memory-core/src/memory-filters.ts:101,108`; `libs/memory-core/src/recall.ts:445,451`) — a
table-valued function scan SQLite cannot serve from any index, closed or open.

This is not the first attempt to widen `kind`. BL-295 shipped an extensible constructor-level kind
allowlist (`0ce39c7`) and it was reverted 19 minutes later (`1446028`) with no reason recorded in the
revert commit itself; the design doc's §1 reconstructs the revert from the replacement commit
(`a8715dc`) and CHANGELOG correction (`8d0ab06`), which record that the CHECK constraint was
deliberately never meant to be extended per consumer. Separately, the operation that *any* schema
widening on a populated `node`/`edge` table requires — SQLite's rename→create→copy→drop rebuild
sequence, because `ALTER TABLE` cannot modify a `CHECK` clause in place — has already caused one
CRITICAL incident on this exact store: BL-313, 40,930 edges silently cascade-deleted, no exception
raised, nothing logged. Any decision to open these columns has to be made in that shadow.

The owner directive that resolves this:

> Open `kind` and typing within memory-server rather than CHECK enums. It must be indexed.

Four forks followed from that directive. All four are now ruled. This ADR is the closed record of
the ruling — not a re-presentation of the forks for further input.

## Decision

### D1 — `node.kind` opens; there is no `sub_kind` column

**Ruling:** `kind` itself becomes plain `TEXT NOT NULL` (its CHECK clause is dropped from
`NODE_TABLE_DDL`/`INLINE_MIGRATION_DDL`). No `sub_kind` column, index, or filter field is added.
Owner's stated reason: *"I see no reason why kind is restricted."*

**Rejected alternative — add a `sub_kind` column, leave `kind` coarse (closed, six-value).** This was
the design doc's prior recommendation (its "1a"). It reaches an indexed discriminator on a *populated*
store without triggering the CHECK-removal rebuild, because adding a nullable column is a cheap
`ALTER TABLE ADD COLUMN`, not a rebuild. It loses because it does not answer the owner's stated
objection — restricting `kind` at all — and because `ix_node_kind` already exists, is already
populated, and is already used by three live code paths, making a second discriminator column pure
duplication of a mechanism the schema already has. The cost the owner accepted in exchange: an
existing store gets **no** consumer-kind support until D3's migration runs, since `sub_kind` was the
only path that would have served existing stores without a rebuild.

### D2 — enforcement is an injected policy closure, validated at the write boundary

**Ruling:** graph-store's own default policy is syntactic-only (accepts any string that satisfies
basic shape rules). The actual vocabulary of permitted kinds/rels for a given deployment is owned by
memory-core and supplied to graph-store by dependency injection, validated at the write boundary
(`writeNode`/`writeEdgeInternal`), not in SQL.

**Rejected alternative:** none — this ruling upholds the prior recommendation unchanged. It is
recorded here because every downstream packet (in particular PKT-60, PKT-74) needs a citable owner
authorization for "no registry table, no trigger, no path from a consumer's type declaration to DDL,"
which is the shape this decision commits to.

### D3 — existing stores gain the open schema only via opt-in, operator-invoked, offline migration with verified rollback

**Ruling:** No existing store is ever migrated automatically, and never on connection open. A
consumer-kind-bearing schema is reached by an explicit operator command that runs offline, against a
verified backup, with rollback on any mismatch.

**Rejected alternative:** none as a *mechanism* — this upholds the prior recommendation ("3b")
unchanged in shape. What changes is D3's **role**. Under the rejected D1 alternative (`sub_kind`), D3
was the optional last mile: nothing else depended on it, because `sub_kind` already served existing
stores without a rebuild. Under the ruled D1 (no `sub_kind`), D3 becomes the **only** path by which
any store that exists today — including the live `~/.memory/memory.db`, ~10,150 nodes — ever accepts
a consumer kind. D1's affordability is conditional on D3 actually shipping as a working, safe
migration; the two decisions are a package, not two independent line items.

**Why "automatic, on open" was never on the table as an alternative to rule between:** that shape is
exactly what BL-295 shipped and was reverted for, and it is exactly the shape BL-313's cascade-delete
occurred under. It is not recorded here as a rejected alternative because it was never a live option
— it is the failure mode D3 exists to foreclose. D3's mitigation, concretely: PKT-61 reuses the
already-fixed `skipDrop` sequencing that survived BL-313's incident, tests it against a 90-edge
fixture with `foreign_keys` asserted `ON`, and rolls back automatically from a verified backup on any
row-count mismatch.

### D4 — `edge.rel` opens in the same pass as `node.kind`

**Ruling:** The `rel` CHECK is dropped from fresh DDL in the same change as `kind`'s. The same
injected policy (D2) validates `rel`. The same operator-invoked offline migration (D3) removes the
CHECK from existing stores. `EdgeRel` widens accordingly.

**Rejected alternative — defer `edge.rel` to a later pass.** This was the design doc's prior
recommendation ("4 — later"), on the reasoning that `node.kind` and `edge.rel` are separable and
splitting them limits blast radius per change. It loses because it would leave the two types in an
indefensible asymmetric state with no plan to close the gap, and because deferring it does not avoid
any of the shared cost — it is the same DDL edit, the same D2 policy plumbing, and the same D3
migration mechanism, so splitting the pass adds a second review/release cycle for zero risk
reduction. Tracked downstream as BL-448.

**The asymmetry D4 makes visible, which this ADR does not pretend is symmetric between the two
columns:** `writeNode` validates `kind` in TypeScript today, so even after the SQL CHECK is dropped a
real runtime guard remains standing on the node side. `writeEdgeInternal` validates **nothing** at
the TypeScript layer — the closed `EdgeRel` union is the *entire* guard for edges today, and it is a
compile-time-only guard that enforces nothing at runtime. Dropping the SQL CHECK on `edge.rel`
without D2's policy landing in the same change would leave edges completely unvalidated at every
layer. Closing that gap is PKT-74's job; this ADR records that the gap exists and that D4 does not
close it by itself — D2's policy closure is what closes it.

## Consequences

- **Zero new columns, zero new indexes, on the node side.** `ix_node_kind` already exists, is already
  populated, and already serves three live code paths; D1 makes it serve consumer kinds too, for free.
- **The rename→create→copy→drop rebuild — previously conditional, "may never be built" — is now the
  feature's sole delivery mechanism for every store that exists today.** That operation caused BL-313.
  It must not run automatically. **BL-447 must land before any DDL constant referencing `kind` or
  `rel` is edited** — `ensureCheckConstraints()` currently decides whether to rebuild by
  substring-probing the live DDL for `'generic'` (node) / `'DEPENDS_ON'` (edge), literals that live
  only inside the CHECK clauses D1 and D4 delete, so editing those constants first turns the existing
  repair path into an unconditional rebuild-on-every-open loop and performs D3's banned migration by
  inaction. (PKT-73 closes BL-447 and is a prerequisite for every packet that edits the DDL.)
- **`EdgeRel` widening is source-breaking**, not additive. It is a closed TypeScript union
  (`index.ts:364-374`) surfaced in return position via `EdgeRecord.rel` (`:424`, assigned at `:609`).
  A consumer that exhaustively `switch`es on `edge.rel` stops compiling. Under 0.x semver the minor
  slot is the breaking slot, so `0.6.0` is still the correct next version for
  `@adhd/sox-graph-store` — but the release note must say what breaks (`EdgeRel`, and the meaning of
  `PUBLIC_EDGE_RELS`) rather than assert the release is additive throughout.
- **One release train, not one per packet.** `graph-store` is 0.5.2, published, with four in-repo
  dependents each pinned exactly on publish; PKT-73, PKT-59, PKT-58, PKT-74, and PKT-60 all land on
  `main` before anything publishes, shipping together as a single `0.6.0`. PKT-61 and PKT-62 ride the
  same version; PKT-63 executes the train.
- **Existing rows, existing consumer behaviour, and the six-kind/ten-rel closed-vocabulary default
  are all unaffected until an operator explicitly runs D3's migration.** A caller who supplies no
  `typePolicy` gets today's behaviour unchanged; `kind:'generic'` plus the tags convention keeps
  working, so no consumer is forced to migrate data.

## Architect recommendations mentioned in the source design doc, and explicitly NOT owner decisions

The following appear in `open-node-typing-design.md` alongside D1–D4 but were never put to the owner
as forks and are not ruled here. They are recorded in this ADR only to say, explicitly, that they
carry no owner authorization and any packet relying on them must get one, or treat them as an
architect recommendation subject to review like any other implementation choice:

- The **dependency-injection wiring shape** for how memory-core's vocabulary reaches graph-store's
  write boundary (concrete closure signature, module boundary) — an implementation detail of D2, not
  a ruled decision in its own right.
- The proposed **`user_version` sentinel** (or an `_adapter_meta` row, or a CHECK-presence parse) as
  the replacement predicate for BL-447's substring probe — the design doc names it as one shape the
  fix could take; BL-447/PKT-73 chooses the actual mechanism.
- The **release-train sequencing** (which packets land before publish, and in what order) beyond what
  §7's non-breaking/breaking split above requires — this ADR states the *consequence* (one 0.6.0, not
  N releases) as ruled by D1–D4's shared DDL/policy/migration surface, but the specific packet
  ordering within the train is planning, not an owner ruling.

## Alternatives considered

Recorded per-decision above (D1: `sub_kind` column; D3: automatic-on-open migration, never a live
option; D4: defer `edge.rel` to a later pass). D2 carries no rejected alternative — it upholds the
prior recommendation unchanged.
