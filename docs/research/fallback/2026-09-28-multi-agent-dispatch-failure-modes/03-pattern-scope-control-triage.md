---
name: "Bounding 'file/schedule every discovered issue' — triage threshold + action-item discipline"
topic: "tool-catalog"
tags: ["pattern:recommended", "scope-control", "triage", "task-derailment", "stopping-conditions"]
summary: "Established practice separates RECORDING a finding from SCHEDULING work on it. A triage gate (severity/priority/reproducibility/ownership + explicit decline dispositions) decides whether a recorded finding becomes work. Google's SRE postmortem discipline bounds follow-up work: postmortems have objective TRIGGERS, and action items are reviewed for appropriateness and priority. MAST names the unbounded-work failure directly: FM-1.5 'Unaware of stopping conditions' (12.4%) and FM-2.3 'Task derailment' (7.4%)."
importance: 8
data_quality: "estimated"
type: "best-practice"
---

# Finding (RQ3 — how to stop 'every discovered issue becomes new work')

The caller's rule — *"a discovered bug is scheduled, never shelved"* — **conflates recording with
scheduling**, and that conflation is the root cause. Every established process inserts a triage decision
between the two.

## Mechanism 1 — a triage gate between recording and work

- **Chromium bug lifecycle** (fetched live, HTTP 200, `chromium.org/for-testers/bug-reporting-guidelines/`):
  a newly-logged bug is **New / `Unconfirmed`**; it is only moved to **`Available`** *"has been triaged and is
  waiting for a fix"* after a confirmation/triage step. Bugs may be resolved **"Won't Fix (Obsolete)"**.
  Triage is a scheduled discipline with an SLA, not an automatic promotion. **Grade B-primary** (project doc).
- General triage practice (**Grade B/C**): every bug gets an **impact (severity) + urgency (priority)** and
  an explicit disposition (accept / defer / decline / duplicate / by-design). A severity/Priority-0..3 scale
  plus a "won't fix" disposition is the linguistic form of a relevance filter.

**The transferable filter** (synthesis, **MEDIUM confidence**): schedule a *found* issue only if it clears
**(a) severity ≥ floor**, **(b) relevance to the current objective**, and **(c) an owner/priority**; otherwise
*record* it and stop. This is the missing "relevance filter" the caller's figure (1) names.

## Mechanism 2 — bounded follow-up work (action-item discipline)

**Google SRE Book ch.15 "Postmortem Culture"** (fetched live, HTTP 200; canonical, **Grade A**):

- Postmortems have **objective triggers** defined *before* an incident ("user-visible downtime beyond a
  threshold", "data loss of any kind", "resolution time above a threshold") — i.e. even the act of opening a
  postmortem is gated, not automatic.
- The review explicitly checks *"Is the action plan appropriate and are resulting bug fixes at appropriate
  priority?"* — action items are **bounded and prioritized**, not unboundedly accumulated.
- Complementary published guidance: every action item needs an **owner and a tracking number**, and postmortem
  effectiveness is questioned when action-item completion falls below ~50% (secondary; **Grade C**).

## Mechanism 3 — let the backlog only shrink (the ratchet again)

See `02-pattern-review-gate-convergence.md`: the lint-baseline/ratchet pattern records findings without
scheduling them and constrains the tracked set to be non-increasing. Applied to a bug backlog: discovery
*records*, the ratchet only ever *decreases* the open set; nothing is auto-promoted to work.

## Corroboration from MAST (independent, peer-reviewed)

MAST (**NeurIPS 2025**, arXiv:2503.13657) names the failure the caller measured:
- **FM-1.5 "Unaware of stopping conditions" (12.4%)** — an agent that does not know when to stop.
- **FM-2.3 "Task derailment" (7.4%)** — drifting off the assigned task.
- **FM-2.2 "Fail to ask for clarification" (6.8%)**.

→ The caller's figure (1) (128/417 dispatches off-objective) is the empirical signature of FM-1.5 + FM-2.3 in
production. The taxonomy corroborates the *mechanism*; it does **not** corroborate the numbers.

## Weaknesses / gaps

- "Never shelve" is sometimes defended as a safety property (don't lose a discovered bug). The correct
  reframe is *record, don't schedule* — the ratchet preserves the record without adding work.
- No source found that quantifies an optimal severity/relevance threshold; thresholds are inherently
  domain-tuned.
