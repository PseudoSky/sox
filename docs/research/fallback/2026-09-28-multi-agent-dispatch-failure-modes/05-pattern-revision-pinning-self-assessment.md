---
name: "Revision-pinning for self-assessment — cite-the-revision / optimistic concurrency"
topic: "tool-catalog"
tags: ["pattern:recommended", "revision-pinning", "self-assessment", "lost-update", "provenance"]
summary: "An agent proposing changes against an already-fixed spec is the classic LOST-UPDATE / stale-read class. Three established analogues: (1) HTTP ETag + If-Match optimistic concurrency control (RFC 9110) — a write must name the revision it read or be rejected; (2) ADR/MADR convention — an accepted decision is NEVER edited, only superseded, so the revision is immutable and citable; (3) build provenance (git SHA / content-addressing) pins 'what I read'. No NAMED agent-self-assessment 'cite the revision you read' pattern was found — that is a genuine gap, not a solved problem."
importance: 7
data_quality: "estimated"
type: "best-practice"
---

# Finding (RQ5 — anchoring a self-assessment so proposals can't target a stale revision)

The caller's figure (7) — *3 of ~10 proposed fixes were already implemented before the reflection was written*
— is, in distributed-systems terms, a **lost update / stale read**: the author acted on a revision that had
already moved. There are three mature, unrelated traditions that each solve exactly this.

## 1. Optimistic concurrency control — name the revision or be rejected

**HTTP `ETag` + `If-Match`** (RFC 9110; widely documented): a client that read a resource under version `E`
must send `If-Match: E` to write; if the resource has since changed, the write is **rejected**, not silently
applied. This is the canonical cure for the "lost update" problem (*"multiple people edit a resource without
knowledge of each other's changes"*). **Grade A** (standard). → The direct analogue: a proposal must carry
"the revision of the spec I read"; if the spec has moved, the proposal is stale and must be re-derived, not
applied.

## 2. Decision records — never edit, only supersede

**ADR / MADR convention** (fetched via live search; canonical **Grade A/B**):
- *"Once an ADR is accepted, it should never be reopened or changed — instead it should be superseded."*
- MADR template status line: *"superseded by ADR-0123"*.
→ Because an accepted record is **immutable**, the revision is stable and citable, and "I read ADR-0123" is a
well-defined claim forever. A spec that is edited in place destroys this property.

## 3. Build provenance — pin "what I read"

- **git commit SHA / content addressing**, **SLSA provenance**, **SBOMs (SPDX/CycloneDX)** all exist to make
  "these exact bytes at this exact revision" a first-class, verifiable reference. **Grade A** (standards).
- **Docs-drift CI** (live search; **Grade B/C**): checks that code changes include the expected specification
  impact — the mirror-image guard (a change can't silently diverge from its doc).

## The gap — this is NOT a named agent pattern

A targeted search for an agent *self-assessment* pattern that "cites the revision it read" returned **no named
pattern**. The nearest hits were generic (an arXiv preprint "Who Holds the Pen? Let Specifications, Not
Agents, Sign Off" — *"the agent ... cannot modify the ledger"*, **Grade B**, very fresh; and generic
"write a good agent spec" advice). **Conclusion (MEDIUM confidence): the caller is not missing an established
off-the-shelf pattern; the mechanism is well-established at the protocol/decision-record/provenance layers,
but the specific "self-assessment cites its source revision" application has no canonical named home.**

## Corroboration from MAST

MAST's "inter-agent misalignment" category and **FM-2.6 "Reasoning-action mismatch" (13.2%)** describe acting
on a divergence between what an agent believes and the real state — the same class as proposing against a
stale revision.

## Weaknesses

- Revision-pinning raises coordination cost (every proposal must be re-validated when the base moves); it is
  the correct default for specifications, not for freely-editable scratch content.
- ETag/If-Match solves *rejection*; it does not auto-rebase the stale proposal. Someone (or something) must
  re-derive it.
