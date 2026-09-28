# ADR-0023 — Knowledge-record storage model (outcome-gated claims, open facets, coverage-aware retrieval)

**Status:** PROPOSED — design only, not ratified (2026-09-27). Carved from the D-C ticket
(`c35319fa`) of the substrate-fleet program; this file is a **proposal**, written on the
precedent of ADR-0014 (a PROPOSED ADR that exists before owner approval). It is NOT
binding until the owner accepts it.
**Owner:** pending owner review (authored by the backend agent, D-C implementation).
**Relates to:** ADR-0010 (open `node.kind`/`edge.rel` typing — D3's operator-invoked offline
migration is a hard dependency, below), ADR-0012 (multi-process write invariant — supersedes
ADR-0007's single-writer claim), ADR-0013 (feature switches are typed config, never env vars),
and `docs/plan/case-library-storage-model/case-library-storage-spec.md` (the un-homed storage
model this ADR gives a durable home).

## Context

The store is an outcome-blind notebook: every assertion has equal weight, so a claim that was
never checked, one the author verified once, one an independent party reproduced, and one that
was actively refuted are indistinguishable on read. There is no place to record an *outcome*
separate from the assertion, no governed way to grow the vocabulary without a schema migration,
and no obligation on retrieval to report *absence* rather than the nearest held row.

Three requirements converge (the D-C spec / `SOX-REQUIREMENTS.md`):

1. **An outcome-gated record** — the claim (assertion + expectation) must be separable from its
   evidence, and the verdict must distinguish *believed* from *self-checked* from
   *independently reproduced* from *refuted*. A single boolean destroys that distinction.
2. **An open facet vocabulary with a promotion path** — a new kind of finding must be recordable
   without a code change or a schema migration, and a term must never silently change meaning.
3. **Coverage-aware retrieval** — a query the store does not cover must ABSTAIN and log the gap,
   never return the nearest held row as if it were the answer.

## Decision

### D1 — Claim is a native `claim` node carrying its SR-7 lease

The immutable half of a knowledge record is a native `claim`-kind node (already in
`MEMORY_NODE_KINDS`, ADR-0010 D2). Its subject/text is `node.content`; its facet term id is
`meta.facet`; its expectation is `meta.expectation = {expected_outcome, confidence}`; its
provenance/envelope is `meta.claim_record = {kind, asserted_by, asserted_at}`. The claim's
`revision` is **SR-7's lease upsert counter** (`meta.claim.revision`, minted by
`memoryClaimUpsert`), not a node revision.

**`meta.claim` is the SR-7 work-LEASE, not the knowledge envelope.** The converged-primitives
design names the envelope `meta.claim`; that key was already owned by SR-7's claim-for-processing
record (`{caller, claimed_at, updated_at, revision}`). This ADR stores the knowledge envelope at
`meta.claim_record` to avoid clobbering the lease, and the K-I1 frozen set is
`content` + `meta.expectation` + `meta.facet` + `meta.claim_record`.

### D2 — An outcome is a NEW `episode` node, never a claim mutation

`memoryOutcomeAppend` mints a NEW `episode` node carrying `meta.outcome`
(`{claim_uid, observed_result, observed_by, method, observed_at, independence,
attestation_revision}`) and a `DERIVED_FROM` edge to the claim. Outcomes are **append-only**
(K-I2): re-recording appends; an existing outcome is never rewritten; the claim's bytes never
change. **No new node kind is introduced by the split**, so no ADR-0010 D3 migration is required
for it.

### D3 — The verdict is DERIVED on read, and tiered

`deriveVerdict` (pure) computes the tier on read from the outcome set, the live `REFUTES` edges,
and the claim revision. It is never a stored field, so it cannot drift from the evidence. The
tier enum splits self-verification from independent reproduction:

`unverified | self-reproduced | independently-reproduced | replicated | stale | refuted | unknown`

with precedence `refuted > stale > replicated > independently-reproduced > self-reproduced >
unverified > unknown`. Two records differing only in outcome `independence` MUST yield different
tiers.

### D4 — Facets live on existing kinds; ADR-0010 D3 is NOT required for them

The facet registry is stored on `generic`-kind nodes at `meta.facet_term` and queried through the
SR-3 `meta.*` predicate — **no new node kind**. A term is minted `unpromoted`; promotion is a
governed demand gate (≥ `config.facetPromotion.minDistinctClaims` distinct live claims AND a
non-empty origin tag). `definitionHash` is immutable once minted: admitting an existing id with a
different definition is refused with `E_TERM_REDEFINED` (mint a new id for a new meaning). This
is the schema.org-`pending` + OBO-`TERM STABILITY` posture.

### D5 — `REFUTES` is a first-class relation, gated on the ADR-0010 D3 migration

`REFUTES` joins `EdgeRel`/`DEFAULT_EDGE_RELS` (and memory-core's `MEMORY_EDGE_RELS`). This is
**purely additive** to the literal union — `EdgeRel` was already widened to `(string & {})`
(BL-444/BL-448/PKT-74), so it is NOT a further source break. On a **fresh** store the CHECK-free
DDL accepts it immediately; on an **existing** store, writing a `REFUTES` edge requires the
**ADR-0010 D3 operator-invoked offline migration** (D3's own terms). Reads are unaffected: a
`SELECT … rel='REFUTES'` works pre-migration and simply returns none. The knowledge layer reports
`unverified`/the lower tiers rather than a wrong verdict when no refutation is present.

### D6 — The claim-upsert CAS degrades to `E_CLAIM_HELD` until SR-6 lands

Correctness of `memoryClaimUpsert` is the store primitive — a conditional `UPDATE … WHERE (live
claim.caller IS NULL OR = :caller)` inside `BEGIN IMMEDIATE` — never an advisory lock (ADR-0012).
A node-level compare-and-swap on a monotonic `revision` (**SR-6**) does not exist yet; until it
does, the claim path degrades to `E_CLAIM_HELD`-on-conflict and `ClaimRecord.revision` is the
claim's own upsert counter. This is a **dependency**, recorded here, not a design choice.

### D7 — Coverage abstention is typed config (ADR-0013)

`KnowledgeConfig.coverage` holds `minMaxSimilarity`, `maxFlatness`, `maxEntropy`, `maxDecay`,
`countCap`; `KnowledgeConfig.facetPromotion` holds `minDistinctClaims`. Every field has a
documented default and is reported by `memory_stats`. The shipped defaults are **permissive**
(abstain only on the clearest no-coverage case — an empty candidate set; each distribution-shape
signal default sits outside its own range so it is disabled until calibrated). No env-var toggle
exists for any of it (ADR-0013). `threshold_source` on every coverage envelope names the field
that decided the verdict.

## Consequences

- **Additive, no node-kind migration** for the claim/outcome split and the facet registry. The
  only migration-gated piece is **writing `REFUTES`** on an existing store (ADR-0010 D3).
- **`ClaimView.revision` is SR-7's lease counter**, not SR-2's node revision; the `stale` tier is
  therefore inert until SR-2/SR-6 give the claim a node revision. The logic is present and
  unit-tested; it activates when the substrate does.
- **Coverage thresholds are uncalibrated.** Abstention is a tunable, logged policy; the numeric
  defaults are a starting point, to be tuned against a labeled query set (the case-library spec
  §(f)7). Treat an abstention decision as auditable via `threshold_source`, not as ground truth.
- **`memory_back`'s return shape** (claim + outcomes + verdict + citations) is this ADR's
  proposal, not a verified contract.

## Open questions (not decided here)

1. **SR-6** (documented per-node CAS) — the claim path's full correctness awaits it.
2. **ADR-0010 D3 migration** — whether/when it runs against the live store to enable `REFUTES`.
3. **Threshold calibration** — the numeric coverage defaults.
4. **Coverage-gap remediation** — clustering unsupported queries and routing them to a fallback
   (ingestion queue / human / search) is out of scope; this ADR logs the gap only.
