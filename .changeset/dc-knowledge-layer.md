---
'@adhd/sox-graph-store': minor
'@adhd/sox-memory-core': minor
---

D-C — the knowledge layer: outcome-gated records, an open facet vocabulary, and
coverage-aware retrieval.

**Outcome-gated records.** A knowledge record splits into an IMMUTABLE claim (a
native `claim` node carrying `meta.facet` + `meta.expectation`, frozen at first
write — K-I1) and APPEND-ONLY outcomes (each a NEW `episode` node with a
`meta.outcome` envelope, `DERIVED_FROM` the claim — K-I2). `memoryClaimAssert`
mints a claim; `memoryOutcomeAppend` appends an outcome; `memoryBack` reads the
record as decision-backing. The verdict is DERIVED on read (never stored — K-I3)
and TIERED, not a boolean: `unverified | self-reproduced | independently-reproduced
| replicated | stale | refuted | unknown`, splitting Repeatability (self) from
Reproducibility (independent) from Replicability (two independent agreeing
outcomes). `deriveVerdict` is pure and unit-tested, with a negative control that
collapses it to a boolean and goes RED. No new node kind — so no ADR-0010 D3
migration for the split.

**Open facets.** `memoryFacetAdmit` / `memoryFacetPromote` / `memoryFacetList`
back a governed, open vocabulary stored on `generic` nodes at `meta.facet_term`
(no new kind). A term is minted `unpromoted`; promotion is a demand gate
(≥ `config.facetPromotion.minDistinctClaims` distinct claims + a non-empty
origin). A term is NEVER redefined in place — a changed meaning is a new id
(`E_TERM_REDEFINED`, K-I5).

**Coverage-aware retrieval.** `memory_recall` now carries a `CoverageEnvelope`
and an SR-3 `count` (`eq`/`gte`). It ABSTAINS (returns no results and logs a
`recall.coverage_gap`) when the candidate set shows no coverage, rather than
returning the nearest held row (K-I6). Thresholds are typed config
(`KnowledgeConfig`, ADR-0013) with permissive defaults, reported by `memory_stats`;
every envelope names the `threshold_source` that decided it.

**SR-3 / SR-8.** `filters.metadata` adds a store-side `meta.*` predicate
(`{path, in?, eq?}`). `memory_write_batch` now verifies every supplied structured
field (topic/tags/importance/summary) — a field that did not persist FAILS the
item with `E_VERIFY_FAILED` naming it, never a success envelope over a partial
record (SR-8).

**graph-store.** `REFUTES` joins `EdgeRel` / `DEFAULT_EDGE_RELS` — additive to
the already-widened `(string & {})` union, so not a further source break.
Writing a `REFUTES` edge on an EXISTING store still requires the ADR-0010 D3
operator-invoked migration; fresh stores accept it from the CHECK-free DDL, and
reads are unaffected either way.

New MCP tools: `memory_claim_assert`, `memory_outcome_append`, `memory_back`,
`memory_facet_admit`, `memory_facet_promote`, `memory_facet_list`; `memory_recall`
/ `memory_update` extended. Tests: `knowledge.spec.ts`, `coverage`/facet/outcome
coverage in `dc-knowledge.spec.ts` (each capability with a negative control proven
red→green), the memory-server `dc-knowledge-host.spec.ts` driving the real MCP
tools, and a two-connection latch race for K-I7. `docs/decisions/0023` is a
PROPOSED ADR (not ratified).

**Dependencies (recorded, not silently assumed).** SR-6 (documented per-node CAS)
does not exist, so `memoryClaimUpsert` degrades to `E_CLAIM_HELD`-on-conflict;
`REFUTES` on a live store needs the ADR-0010 D3 migration.
