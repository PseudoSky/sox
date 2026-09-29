---
name: "Severity-gated review that converges (ratchet + non-blocking dispositions)"
topic: "tool-catalog"
tags: ["pattern:recommended", "review-gate", "convergence", "severity-threshold", "ratchet"]
summary: "Established review gates converge by (1) blocking only on findings at/above a severity floor; (2) explicitly labeling sub-threshold findings as non-blocking ('Nit:', advisory); (3) grandfathering existing findings in a baseline/ratchet that may only shrink; (4) a bounded round cap. Google's code-review standard is the canonical termination rule: approve once the change definitely improves code health, not when it is perfect."
importance: 8
data_quality: "estimated"
type: "best-practice"
---

# Finding (RQ2 — how a review gate converges instead of re-opening forever)

The caller's pattern — *a gate that re-opens on every sub-threshold finding* — is a **known failure mode with
a known cure**. Four mechanisms, each independently established:

## 1. Approve-on-improvement, not on perfection (the termination rule)

**Google `eng-practices` — "The Standard of Code Review"** (fetched live, HTTP 200; canonical, widely adopted
across the industry). Direct quote:

> *"In general, reviewers should favor approving a CL once it is in a state where it definitely improves the
> overall code health of the system being worked on, even if the CL isn't perfect."*

and the explicit non-blocking disposition:

> *"Reviewers should always feel free to leave comments expressing that something could be better, but if it's
> not very important, prefix it with something like 'Nit:' to let the author know that it's just a point of
> polish that they could choose to ignore."*

**Grade A.** → A gate that never terminates has violated the senior rule: it is seeking perfection, not
continuous improvement. Non-blocking findings MUST carry a disposition that does not re-open the gate.

## 2. Severity floor gates the merge; advisory never does

Established across code-review tooling: findings carry a severity, **blocking severity gates the merge,
advisory never does** (corroborated across multiple review-gate products; **Grade C/B-primary**, secondary
sources). This is exactly RQ2's "severity floor".

## 3. The baseline / ratchet — "discretion may clear but never add"

**Lint-baseline pattern** (verified via multiple sources; **Grade B-primary**): *"A lint baseline lets you
enforce a standard you cannot fix today. Existing violations are grandfathered, new ones fail the build, and
the file can only shrink."* (tim-schipper.nl); Android lint baseline; ESLint "ratchet" tooling.
→ This **is** the requested "discretion may clear but never add": the finding count is monotonic
non-increasing; clearing a finding (removing its baseline entry) is always allowed and even encouraged
(some linters *fail* when a baselined violation is fixed so the baseline must shrink), while *adding* a new
blocking finding is the only thing that re-opens the gate.

## 4. Bounded rounds / dry-round termination

Secondary sources (**Grade C**) describe review loops that *"stop after two consecutive dry rounds (or at the
plan's round cap — reported as such rather than as convergence)"* and *"hard caps prevent infinite loops
regardless of convergence state."* Convergent with Fagan-inspection practice (formal inspection with
entry/exit criteria and a rework→re-inspection loop, **Grade A/B** historically).

## Corroboration from MAST

The MAST failure taxonomy independently names the underlying failure: **FM-3.2 "No or incomplete
verification" (8.2%)**, **FM-3.3 "Incorrect verification" (6.2%)**, and **FM-3.1 "Premature termination"** —
the "task verification" category. The paper's own example: *"a ChatDev-generated chess program passes
superficial checks (e.g., code compilation) but fails actual gameplay."* → gates must terminate on the right
criterion, and a gate that fires on sub-threshold noise is the dual failure.

## Weaknesses

- "Nit:"-style dispositions work because a *human* author may ignore them; a machine gate needs an explicit
  severity type on the finding, or the disposition is unenforceable.
- A hard round cap converts a non-converging gate into a **timeout**, which can silently ship an unverified
  change — the cap must report "capped, not converged", never "clean".
