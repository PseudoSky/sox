# Dispatch brief — <task slug> (run: <run-id>)

## Goal

<one imperative sentence>

## User request (verbatim)

user-request (verbatim): <the user's own words, copied exactly — never paraphrased or trimmed>

## Dispatcher structuring

dispatcher-structuring: <everything the dispatcher added — goal narrowing, acceptance criteria, ordering, scope, routing>

## Done-state (the dispatcher will check these directly)

- tests: `<command>` exits 0
- diff touches only: `<path>`, `<path>`
- state/artifact: `<path>.<field>` == `<value>`

## Scope

In scope: <paths>
Out of scope (report, do not edit): everything else

## Context (inline)

<file excerpts / error text / prior findings — no "read <path>" pointers for anything you can paste>

## Review target (post-merge review briefs only)

Repo/commit: review `main` at the merged sha `<sha>` — pinned so the review is race-free while other merges land.
RUN the suite, do not judge from reading. Gates, each with its raw exit code:
- `pnpm test` → 0 failures
- `tsc --noEmit` → exit 0
- bundle to a TEMP outDir → under the size budget
Flake: run the suite <n> times; report pass/fail per run.
Fixtures: `public/events.json` / `details.json` are gitignored — copy them from the repo root; a missing fixture is NOT a code failure.
Report findings by severity. A HIGH is bucketed as follow-up impl, never a merge blocker.

Review type by changed-file count: `>=8` changed files → **blind review** (reviewer gets ONLY the diff + the instruction "Review"); `<8` → **guided review** (may carry focused context). At plan completion, one full-delta blind review over the plan-start sha → finish sha.

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
