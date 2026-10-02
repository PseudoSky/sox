# Plan: `plan-value-assessment` — evidence-based value assessment for proposed plans

**Status:** proposed (design-complete) · **Author:** researcher · **Date:** 2026-09-29
**Filing component:** `agents` (the skills) · `docs` (the register) · `libs` (the knapsack/queue surface)
**Depends on:** nothing (greenfield) · **Enables:** `product` prioritization, backlog knapsack optimization

> This is a prose plan. It can be converted to the repo's `plan-state-machine` format (states + `dag.json` + runnable acceptance) by `plan-builder` if the owner wants executable guards — the segments and acceptance criteria below are written to map 1:1 onto work-states.

---

## 1. Motivation

Proposed plans are currently assessed by opinion. There is **no baseline** of what capability already exists, at what quality, and **no consistent method** to estimate a plan's marginal value. The consequence is measurable in this repo: a static audit produced 26 "findings" of which most were doc-drift, duplicates of already-tracked items, or symptoms of one design tension — i.e. *value was assessed badly, after the fact, and unfalsifiably*.

`product` (and `backlog-operator`) must be able to answer **"is this plan worth doing?"** with evidence — and that answer should feed prioritization, not sit in prose.

**The core reframe:** "is this plan valuable?" is almost never answered by opinion — it is answered by a **diff against a baseline**. Three questions, each evidenced:

1. Does the capability already exist — and how good is it? *(baseline)*
2. What is the marginal gain of the plan over it? *(delta)*
3. Is it novel or derivative, and is it blocked? *(context)*

---

## 2. Goal

Deliver a reusable `plan-value-assessment` skill plus a capability register and persisted value metrics, so that:

- any agent can assess a proposed plan's value **with evidence and a confidence level**;
- `product` and `backlog-operator` apply it **as standard practice**;
- plan **value and cost** feed a priority queue and a **knapsack-based** portfolio selection.

---

## 3. Deliverables (segments)

### S1 — `plan-value-assessment` skill *(primary; component `agents`)*
A sox skill at `extensions/skills/plan-value-assessment/`.
- **Input:** a proposed plan — a backlog item uid, a `docs/plan/<slug>/`, or a SPEC.
- **Method:** recall memory for the generalized pattern → diff against the capability register (S2) → score **novelty / differentiation / defensibility / shipped-vs-designed** → estimate **marginal gain + cost** → identify blockers/duplicates → emit verdict **DO / DEFER / DROP / ALREADY-DONE** with confidence + evidence.
- **Output:** a structured assessment (schema in S3) + a human summary.
- **Consumers:** `product` (**mandatory**), `backlog-operator` (standard), `architect`/`plan-builder` (advisory).
- **Acceptance:** on a fixed sample of N plans, produces a structured verdict with evidence + confidence; two runs on the same plan agree (deterministic rubric, not vibes).

### S2 — Capability register (the baseline) *(component `docs`)*
`docs/assessments/capability-register.json` (+ generated `.md`), produced by `scripts/build-capability-register.ts`, mirroring the existing `scripts/build-routing-index.ts` → `docs/routing/map.json` convention.
- **Schema per entry:** `id, capability, incumbent, novelty, craft, differentiation, defensibility, shipped_state, known_gaps, marginal_gain_estimate, blocked_by, evidence[], confidence, assessed_at`.
- **Seed:** the 2026-09-29 originality audit (the graded scorecard of libs/extensions).
- **Acceptance:** an agent can answer "does capability X already exist and how good is it?" by reading the register — no grep required — and every entry carries `evidence` + `assessed_at`.

### S3 — Value-assessment metrics persisted to the backlog *(component `libs`)*
Persist the S1 assessment as structured, queryable data on the plan item (via the `attest` primitive or a structured metadata field): `value_scores{novelty,differentiation,defensibility,shipped}, cost_estimate, gain_estimate, confidence, assessed_at, verdict`.
- **Acceptance:** `backlog get` on a plan exposes its value metrics; they are machine-readable, not prose.

### S4 — Prioritization + knapsack *(component `libs`)*
Feed plan **value** and **cost** into prioritization:
- a value-density metric (`value / cost`) on the priority queue;
- a **knapsack** view: given a resource budget, select the subset of assessed plans maximizing total value — and, as a stretch, *generate* plan bundles (which work to do now vs defer) rather than only ranking single items.
- **Acceptance:** given a set of assessed plans + a budget, produce a recommended subset and its total value; the selection is reproducible.

### S5 — Governance gate *(component `agents`)*
An obligation (via the backlog `obligate` primitive): **a plan cannot transition to an approved/ready status without a `value-assessment` attestation.** This is what makes S1–S4 *used* rather than ignored.
- **Acceptance:** a ready/terminal transition lacking the attestation is refused (`precondition_failed`); with it, it proceeds.

### S6 — Resource-adaptive assessment depth *(part of S1; component `agents`)*
The skill must **optimize its own resource consumption by the size of the proposed plan.** A size classifier (surface area touched / segment count / novelty / blast radius) selects an assessment depth band:
- **Small** (a one-file change): cheap heuristic pass, register lookup only, no external research.
- **Medium** (a segment): register diff + a bounded research pass.
- **Large** (an epic / new subsystem): full deep assessment — multi-source research, gain modeling, blocker scan.
- **Acceptance:** a documented cost model maps plan size → assessment effort; measured token/time cost per size band; a small plan does **not** trigger the large-plan path (negative control).

### S7 — `iterative-research-refinement` pass *(post-build; component `agents`)*
Once S1 (+S6) ships, **run `iterative-research-refinement` on the `plan-value-assessment` skill**: nested A/B loops with the runtime-metrics promotion gate, optimizing both assessment *accuracy* and *resource consumption*. A variant that regresses runtime beyond threshold does not promote unchanged.
- **Acceptance:** an IRF run recorded with measured deltas and a runtime gate; the promoted variant demonstrably beats baseline on accuracy and/or cost.

---

## 4. Mandated requirements (from the owner)

- **R1** — Skill adopted by `product` (**almost mandatory there**) and `backlog-operator`; filed against component **`agents`**.
- **R2** — **Run `iterative-research-refinement` on `plan-value-assessment` once built** (S7).
- **R3** — The skill must **optimize its overall resource consumption based on the size of the proposed plan** (S6).
- **R4** — **Persist value-assessment metrics into the backlog** so plan value + organization feed the **priority queue** and potentially a **knapsack problem for plan generation/optimization** (S3 + S4).

---

## 5. Sequencing & dependencies

```
S2 (register) ──┐
                ├──▶ S1 (skill) ──▶ S3 (metrics) ──▶ S4 (knapsack)
S6 (depth) ─────┘            │
                             └──▶ S5 (gate, after S1) ──▶ S7 (IRF, post-build)
```

- S2 is independent and can land first (it is also the seed that closes the "audit not persisted" gap).
- S1 depends on S2 (it reads the register). S6 is a design constraint *within* S1.
- S3 → S4 depend on S1. S5 depends on S1. S7 runs after S1+S6 are built.

---

## 6. Risks

| Risk | Mitigation |
|---|---|
| Register goes stale → agents get wrong baselines | dated `assessed_at` + `evidence` + `confidence`; regenerated by script; stale-flag after N days |
| Assessment cost blows up on every plan | S6 resource-adaptive depth; cost model with measured bands |
| "Value score" becomes unfalsifiable opinion | evidence + confidence mandatory; IRF (S7) calibrates against ground truth |
| Gate becomes bureaucratic / blocks small work | S5 scoped to *plan/epic* transitions, not individual items; S6 small-plan path is cheap |
| Knapsack over-engineered before value data exists | S4 lands only after S3 accumulates real metrics |

## 7. Non-goals

- Not an auto-approver — a human/owner still decides; this is **evidence input**.
- Not a replacement for `product` judgment.
- Not a general refactor of the backlog tool.

## 8. First adopter

Wire the gate (S5) onto the existing vector-search plan hub `eb6104b7-63e3-4c4a-a47e-658dd9e5ab11` as the pilot — its 13 members give an immediate corpus of assessed plans, and its own value case (blocked on upstream `tursodatabase/turso#832`) is exactly the kind of "should we do this now?" decision the skill exists to answer.
