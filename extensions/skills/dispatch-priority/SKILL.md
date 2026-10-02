# dispatch-priority — order buckets by consequence-to-objective, and escalate with the trigger recorded

Use this when the dispatcher must decide the order in which buckets run and the user has not pinned that order. The dispatcher's priority playbook — it defines priority for dispatch as the ordering of buckets by consequence-to-objective when order is not user-pinned (distinct from `product`, which sets WHAT matters), and gives an explicit escalation ladder with observable triggers: P0 run-blocker (blocks the run's stated objective or breaks `main`/a shipped artifact), P1 objective-critical (directly serves the objective; unblocks at least two other buckets), P2 in-scope normal (serves the objective, no blocker), P3 deferrable (does not bear on this objective; files only). It lists the escalation triggers that raise a bucket's priority — blocks the run's stated objective, breaks `main` or a shipped artifact, the user named it, it unblocks at least two other buckets, or it is a HIGH+ review correction that is an immediate correction — and grants the dispatcher the freedom to escalate or reorder, provided every escalation records its trigger in the rule-16 run line (agent, model, id, times, item uid). The high/critical review filter applies ONLY to immediate corrections arising from reviews. The dispatcher escalates to the user only when the decision or blocker exceeds its authority or rule 12's chain-depth limit. Load when ordering buckets, when a bucket's priority changes, or when deciding whether a review finding enters this run.

## Definition

**Priority** is the ordering of buckets by *consequence-to-objective* when the order is not user-pinned. It is not `product`'s question (WHAT matters); it is WHEN and IN-WHAT-ORDER, given the run's stated objective. The objective is the anchor: a bucket is high only relative to the objective it advances or obstructs.

## Escalation ladder

Each bucket lands on exactly one level. The trigger in the right column is observable — not a severity label.

| Level | Name | Observable trigger |
|---|---|---|
| **P0** | run-blocker | Blocks the run's stated objective, or breaks `main` or a shipped artifact. |
| **P1** | objective-critical | Directly serves the objective and unblocks at least two other buckets. |
| **P2** | in-scope normal | Serves the objective, no blocker. |
| **P3** | deferrable | Does not bear on this objective; file only, do not dispatch. |

Order the run P0 → P1 → P2 → P3. Within a level, order by the number of buckets the item unblocks, then by the number the user named.

## Escalation triggers

Any one of these **raises a bucket's priority and MUST be recorded**:

- It blocks the run's stated objective.
- It breaks `main` or a shipped artifact.
- The user named it.
- It unblocks at least two other buckets.
- It is a HIGH+ review correction **that is an immediate correction**.

The last trigger is the only place the high/critical filter applies, and it is scoped to **immediate corrections arising from reviews** — never to a defect's severity, and never to deferred findings, which rule 5 buckets with the run's other deferrals.

### HARD contradiction (CLOSED set)

An immediate correction qualifies under the review trigger only when the finding is a **HARD contradiction** — a direct, verifiable incompatibility between the finding and the artifact or the record. The set is closed; nothing outside it qualifies:

1. **Artifact-state** — the finding asserts the artifact does X, and reading the artifact at the pinned sha shows it does not.
2. **Cross-review** — two reviews of the same artifact at the same sha assert incompatible claims about the same behavior.
3. **Contract** — the finding contradicts a shipped artifact's recorded grant or contract.
4. **Objective** — the finding contradicts the run's stated objective or a binding user instruction.

A difference of opinion, a severity disagreement, or any below-HIGH finding is **not** a HARD contradiction.

## Freedom to escalate

The dispatcher MAY raise a bucket's priority or reorder the run. It MUST record the trigger, using the rule-16 run line: agent, model, id, times, item uid.

Escalate to the **user** only when the decision or blocker exceeds the dispatcher's authority or exceeds rule 12's chain-depth limit (a self-generated follow-up chain deeper than 1). Do not ask the user to choose an order the ladder already decides.

## Relation to `product` and rule 7

Dispatch `product` for the order — and do **not** apply this ladder — when all three hold: the order matters, the user did not pin it, and there are more than three items. Otherwise the dispatcher applies this ladder directly.

## Flow

```
direction → buckets
   │
   ├─ order pinned by the user? ──yes──▶ follow the pin (rule 0)
   │
   └─ no ─▶ order matters AND >3 items? ──yes──▶ product (rule 7)
                  │
                  no
                  ▼
           classify: P0 → P1 → P2 → P3
                  │
                  ▼
           escalation trigger fires? ──yes──▶ raise + record trigger (rule 16)
                  │
                  ▼
           exceeds authority / rule-12 chain depth? ──yes──▶ ask the user
```

## Steps

1. **State the objective.** One line: what this run must achieve. Priority is meaningless without it.
2. **Classify each bucket** on the ladder by its observable trigger. P3 buckets are filed, not dispatched.
3. **Apply the escalation triggers.** For each bucket, check every trigger; the highest that fires sets its priority.
4. **Record.** Every raise and reorder carries its trigger in the rule-16 run line (agent, model, id, times, item uid).
5. **Escalate to the user only** when the decision or blocker exceeds the dispatcher's authority or rule 12's chain-depth limit.

## Hard rules

- Priority is consequence-to-objective, not severity in the abstract, and never a substitute for `product`'s WHAT.
- Every priority change — raise or reorder — records its trigger. An unrecorded escalation did not happen.
- The high/critical filter applies ONLY to immediate corrections arising from reviews; HARD contradiction is the CLOSED four-member set above.
- A P3 bucket is filed, never dispatched.
- Never ask the user to pick an order the ladder already decides; ask only when authority or rule 12's chain-depth limit is exceeded.
