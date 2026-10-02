# definition-of-ready — route each bucket by an observable check

Every bucket is classified into exactly one of four handling paths — `needs-triage`,
`needs-research`, `needs-spec`, or `ready` — and no verdict stands without the
observable check that produced it.

## What "definition of ready" means

The **definition of ready** is the set of observable conditions a bucket must
satisfy before it can be routed to a handling path. It is an *entry gate* that
mirrors the definition-of-done *exit* gate: done says what "finished" looks like,
ready says what "safe to start" looks like. It is a working agreement between the
agent that shapes work and the agent that executes it — **not bureaucracy**. A gate
applied to work that is already ready is a tax; over-application is the failure mode
this skill is written to avoid.

Two consequences of that definition:

- **Ready is not a size judgment.** A large, well-understood bucket is ready; a
  one-line bucket with an unresolved question is not.
- **A verdict is an evidence record.** "Needs-spec" is not an opinion — it is the
  output of a named check. A verdict that cannot cite its observable check is
  invalid and must be re-run, not accepted.

## Position — after bucketing

This gate runs **after** bucketing, never before. Items are first grouped by
cohesion into buckets — each bucket shares one file/component and one done-state, and
is the unit of dispatch (a cohesive write-scope; size it by cohesion and separability, never maximal size).
Only then is each bucket classified. Classifying individual items before cohesion
grouping produces path churn: two items in one file with one shared done-state must
not be split because one of them happened to mention a defect.

## The four paths

Classify in the order below. The **first check that fires decides the path**; if no
check fires, the bucket is `ready`. Every verdict must cite the check that fired.

| Path | Fires when | Observable check | Route |
|---|---|---|---|
| `needs-triage` | The bucket reports a defect/symptom, or carries a "pre-existing / unrelated / skipped" claim. | The bucket states observed behaviour (a symptom) and **no established root cause**: no artifact or citation in the repo names the cause. | `dispatch-triage` → `debug` |
| `needs-research` | The bucket's path or feasibility is unknown; it names an unknown (library choice, unknown constraint, unclear solution space). | The bucket carries an open question of the form *which / does / is-it-possible* that **no artifact in the repo answers**, and the answer is **external knowledge, not a decision**. | `researcher`, or a time-boxed spike |
| `needs-spec` | What to build is clear, how is not; the work spans modules or touches an interface; a design decision must be made. | The bucket's done-state **cannot yet be written in `dispatch-contract` terms** (no observable acceptance criterion) **and** the missing ingredient is a design/contract decision. | `architect` → `dispatch-direct` |
| `ready` | Research and design are settled. | A done-state **can be written as an observable action** (`test exits 0` / `diff touches only X` / `state field == value`), scope is named, and no blocking unknown remains. | `dispatch-direct` |

Each path in full:

- **`needs-triage`** — we do not know *what is wrong*. The route is `dispatch-triage`
  (root-cause with `debug`, evidence before fix). A symptom with no cause is the
  signature: the bucket can describe what is observed but not why, and no citation
  pins the cause.
- **`needs-research`** — we do not know *a fact about the world*. The route is
  `researcher` or a time-boxed spike. The signature is an external factual question
  (`which library`, `does API X support Y`, `is it possible to Z`) whose answer lives
  outside the repo. If the repo already answers it, this path does not fire.
- **`needs-spec`** — we know *what*, not *how*. The route is `architect` (produce the
  design/contract) then `dispatch-direct` (execute it). The signature is a done-state
  that cannot yet be written as a checkable action because a contract or interface
  shape is undecided.
- **`ready`** — research and design are settled and the bucket can be dispatched as
  written. The signature is a writable done-state plus a named scope plus no blocking
  unknown.

## Sizing logic — the checks that decide

Sizing here is about **what is unknown, not how big the bucket is**. Run these checks
in order and stop at the first that fires:

1. **Symptom-without-cause check** → `needs-triage`.
   Can the bucket state its observed behaviour but *not* point to a file:line,
   citation, or tool result naming the cause? If yes, it is triage. A
   "pre-existing / unrelated / skipped" claim is the same signal and always triages —
   never dismiss it.
2. **External-fact check** → `needs-research`.
   Does the bucket carry a `which / does / is-it-possible` question with no repo
   artifact answering it, where settling it requires looking outside the repo rather
   than choosing between options? If yes, it is research. If the answer is a *choice
   between known options*, do not send it to research — that is a design decision.
3. **Uncheckable-done-state check** → `needs-spec`.
   Can a done-state be written as an observable action right now? If not, and the
   missing ingredient is a design or contract decision (interface shape, module
   boundary, data format), it is spec. If the done-state is unwritable because a
   *fact* is missing, go back to check 2.
4. **Ready check** → `ready`.
   Done-state writable as an observable action, scope named, no blocking unknown. A
   bucket that reaches here without a check firing is ready — **do not invent a gate
   to look rigorous.**

**Size never fires a path.** A ten-file refactor with a settled design and a writable
done-state is ready. A one-line fix with an unknown cause is triage. The trigger is
the unknown, not the estimate. This is the check that keeps the gate from "assuming
it knows": the classifier must produce the missing artifact (the cause, the fact, or
the design) as the *reason* for the verdict, not assert the verdict and move on.

## Boundary rules

- A **symptom with no cause** is triage.
- A **known change with no design** is spec.
- A **factual unknown** is research.
- A **design choice** is spec — never research; research settles facts, humans/agents
  settle choices.

When two checks appear to fire, the earliest in the ordered list wins: you cannot
design a fix for a defect whose cause is unknown, and you cannot decide a design
without the facts that constrain it.

## The filing-boundary subset — one notion of ready, two halves

The same definition of ready has a sibling half applied by `backlog-operator` at
**filing** time, before this gate runs. An item is fileable when it carries:

- acceptance criteria present,
- scope stated,
- citations present,
- dependencies resolved.

That subset asks "is this a well-formed item?". This routing gate asks "is this
*bucket* ready to route, and to where?". They are one notion of ready applied at two
boundaries: the filing half guards item quality at write time; the routing half
guards classification at dispatch time. Neither replaces the other — a well-formed
item can still be routed to the wrong path if this gate is skipped.

## Why this gate exists

The gap is measured, not theoretical. The dispatcher has repeatedly acted as if it
already knew the answer:

- **d758f3d4** — a brief widened scope beyond its item body: it asserted a fuller
  target than the body's Goal/Remedy and rename-scoped acceptance criteria. The body
  is authoritative; a brief may narrow or concretise but never widen.
- **f3c3c073** — a brief carried a fused/nonexistent uid, so the executor's spec
  fetch hit `item_not_found`. A uid in a brief must be copied from a tool result,
  never reconstructed.
- **48751b32** — a claimed `filterChips.ts` divergence (502 vs 487) was asserted as
  fact and was wrong: a pre-rebase artifact, and the merged blob was byte-identical.
- **3fe895f3** — no guard validates the dispatcher's hand-maintained executor roster
  against the live registry.

Each is the same failure: a verdict or claim stated without the check that would
support it. This skill makes the check the verdict's required evidence.

## References

Honest grounding for the concept and its boundaries — not the shipped artifact:

- **Scrum** — the "definition of ready" as a team working agreement that mirrors the
  definition of done; the shared entry criterion for a backlog item.
- **INVEST (Bill Wake, 2003)** — the item-quality criteria (Independent, Negotiable,
  Valuable, Estimable, Small, Testable) that the filing-boundary subset derives from.
- **Spike literature** (XP / Scrum) — the time-boxed spike as the `needs-research`
  route: a bounded investigation that returns a fact or a decision, not shippable
  work.
- **Agentic-SDLC triage** — routing a report to root-cause diagnosis before any fix,
  the `dispatch-triage` → `debug` route.

## Hard rules

- **Gate after bucketing**, never before.
- **No verdict without its observable check** — cite the check that fired.
- **Size never fires a path**; the unknown does.
- **First firing check wins**; when in doubt, the earlier path is the safe one.
- **Do not over-apply**: a bucket that already satisfies the ready check is ready; a
  gate on ready work is a tax.
- **A "pre-existing / unrelated / skipped" claim always triages** — it is never
  grounds to leave work unexamined.
