# Dispatch brief — <task slug> (run: <run-id>)

## Goal

<one imperative sentence>

## User request (verbatim)

user-request (verbatim): <the user's own words, copied exactly — never paraphrased or trimmed>

## Dispatcher structuring

dispatcher-structuring: <everything the dispatcher added — goal narrowing, acceptance criteria, ordering, scope, routing>

## Acceptance criteria (test each; cite the ticket and the AC id)

- <uid or BL-<n>> AC1 — <binary, checkable statement>
- <uid or BL-<n>> AC2 — <statement>

Every test, whoever writes a test, names the ticket and the AC ids it exercises (`<uid or BL-<n>> AC<n>`); one test may cite several ACs. Every AC is cited by at least one test; an AC no test cites is not done.

## Test routing (change needs tests)

test-authorship: <implementer|separated>
rigor: <none|light|standard|deep>
playbook: <card id>

The citation duty attaches to whoever writes a test.

## Done-state (the dispatcher will check these directly)

- tests: `<command>` exits 0
- diff touches only: `<path>`, `<path>`
- state/artifact: `<path>.<field>` == `<value>`

## Scope

In scope: <paths>
Out of scope (report, do not edit): everything else

## Context (inline)

<file excerpts / error text / prior findings — no "read <path>" pointers for anything you can paste>

## Worktree (implementer briefs only)

Worktree: `<path>` · bucket branch: `<branch>` · plan branch: `<plan-branch>`. When every AC is verified, merge into the plan branch fast-forward only (rebase your bucket branch first if the plan branch moved; hand a conflicting rebase back as `blocked`), then transition your issue to `review`.

## Test standard (test-writing roles only)

Inline the role's card and the project's tier-mapping excerpt here.

## Static-analysis review (per-bucket review briefs only)

Target: `<bucket diff on the plan branch>`. Read and analyse against the ACs and scope above; do not run the suite. Check each test's tier and fidelity-gap statement for validity. Return findings by severity with file:line evidence.

## Audit (retention-audit briefs only)

Inline: the auditor card, R1–R6, and the audit record format. Return one audit record per test.

## Blind review (the plan's one blind review — nothing but this)

The brief is the plan's whole diff and the single word: `Review`. Nothing else is added.

## Tools / model

model: <sonnet|opus|haiku> · tools: <exact list>
If you need a tool not listed, stop and return `blocked` naming it.

## Budget

<N> turns / <T> tokens. At 80% return `partial` with the remaining scope named.

## Check-and-confirm (optional)

- <BUG-XXX-nnn>: <one-line claim>. Verify; `SendMessage` the dispatcher confirm/deny + evidence BEFORE correcting.

## Return contract

End with the RETURN block from dispatch-contract §2. Nothing after it.
Delivery: <final message | SendMessage to dispatcher>
