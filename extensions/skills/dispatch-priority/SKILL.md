# dispatch-priority — order buckets by consequence-to-objective, and escalate with the trigger recorded

Use this when the dispatcher must decide the order in which buckets run and the user has not pinned that order. The dispatcher's priority playbook — it defines priority for dispatch as the ordering of buckets by consequence-to-objective when order is not user-pinned (distinct from `product`, which sets WHAT matters), and gives an explicit escalation ladder with observable triggers: P0 run-blocker (blocks the run's stated objective or breaks `main`/a shipped artifact), P1 objective-critical (directly serves the objective; unblocks at least two other buckets), P2 in-scope normal (serves the objective, no blocker), P3 deferrable (does not bear on this objective; files only). It lists the escalation triggers that raise a bucket's priority — blocks the run's stated objective, breaks `main` or a shipped artifact, the user named it, it unblocks at least two other buckets, or it is a HIGH+ review correction that is an immediate correction — and grants the dispatcher the freedom to escalate or reorder, provided every escalation records its trigger in the rule-16 run line (agent, model, id, times, item uid). The high/critical review filter applies ONLY to immediate corrections arising from reviews. When the ladder cannot decide, the dispatcher escalates to the owning authority across the roster — `product` for order, `architect`/`architect-decision` for design, `researcher` for facts, and any named specialist — not to `product` alone; escalation serves both more strategic problem-solving and independence, so the dispatcher reaches the user only when a question exceeds every resource and its authority, or rule 12's chain-depth limit. Load when ordering buckets, when a bucket's priority changes, or when deciding whether a review finding enters this run.

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

### Review-finding materiality classes

An immediate correction qualifies under the review trigger only when the finding is **material** — a direct, verifiable incompatibility between the finding and the artifact or the record. These four classes are exhaustive; nothing outside them qualifies:

1. **Artifact-state** — the finding asserts the artifact does X, and reading the artifact at the pinned sha shows it does not.
2. **Cross-review** — two reviews of the same artifact at the same sha assert incompatible claims about the same behavior.
3. **Contract** — the finding contradicts a shipped artifact's recorded grant or contract.
4. **Objective** — the finding contradicts the run's stated objective or a binding user instruction.

A difference of opinion, a severity disagreement, or any below-HIGH finding is **not** material.

**HARD contradiction is a different term** — the dispatcher's pre-dispatch check of its own structuring against the user's verbatim, the CLOSED set defined canonically in dispatcher rule 0 (and `dispatch-contract` §1). It applies to structuring, never to a review finding; do not conflate the two.

## Escalation targets — the roster, not only `product`

Escalation is not one channel. When the ladder cannot decide, or a question exceeds the dispatcher's authority, route it to the authority that owns it — the full roster:
- `product` — the WHAT/order when the ladder's triggers cannot order it (the >3-items case below).
- `architect` / `architect-decision` — a design or contract choice.
- `researcher` — a fact or feasibility question.
- `git-manager` — a git operation.
- `debug` (via `dispatch-triage`) — the cause of a failure.
- `backlog-operator` — a graph write.
- any named specialist the work class maps to.

Escalation serves **two purposes at once**: **more strategic problem-solving** — the question goes to the agent that owns it — and **independence** — the dispatcher must not hand the user a problem it has the resources to resolve.

## Freedom to escalate

The dispatcher MAY raise a bucket's priority or reorder the run, and MAY route a question to the owning authority (targets above). It MUST record the trigger, using the rule-16 run line: agent, model, id, times, item uid.

Reach the **user** only when the question exceeds every available resource and the dispatcher's authority, or exceeds rule 12's chain-depth limit (a self-generated follow-up chain deeper than 1). Do not ask the user to choose an order the ladder already decides, and do not ask the user for what a specialist can resolve — the goal is strategic resolution in-run, not reliance on the user.

## Escalating the order to `product` (rule 7)

Dispatch `product` for the order — and do **not** apply this ladder — when all three hold: the order matters, the user did not pin it, and there are more than three items. Otherwise the dispatcher applies this ladder directly. This is the `product` member of the escalation roster above, not the only target.

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
           a question for an owning authority? ──yes──▶ escalate to the roster
                  │
                  ▼
           exceeds every resource + authority / rule-12? ──yes──▶ ask the user
```

## Steps

1. **State the objective.** One line: what this run must achieve. Priority is meaningless without it.
2. **Classify each bucket** on the ladder by its observable trigger. P3 buckets are filed, not dispatched.
3. **Apply the escalation triggers.** For each bucket, check every trigger; the highest that fires sets its priority.
4. **Record.** Every raise and reorder carries its trigger in the rule-16 run line (agent, model, id, times, item uid).
5. **Escalate to the owning authority** — `product` for order, `architect`/`architect-decision` for design, `researcher` for facts, any named specialist (roster above). Reach the **user** only when the question exceeds every resource and the dispatcher's authority, or rule 12's chain-depth limit.

## Hard rules

- Priority is consequence-to-objective, not severity in the abstract, and never a substitute for `product`'s WHAT.
- Every priority change — raise or reorder — records its trigger. An unrecorded escalation did not happen.
- The high/critical filter applies ONLY to immediate corrections arising from reviews; a finding qualifies only via the four materiality classes above (never a severity label, never a deferred finding).
- A P3 bucket is filed, never dispatched.
- Never ask the user to pick an order the ladder already decides, and never ask the user what a specialist can resolve; reach the user only when every resource and the dispatcher's authority are exceeded, or rule 12's chain-depth limit is.
