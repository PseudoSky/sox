# Dispatch brief — <task slug> (run: <run-id>)

## Goal

<one imperative sentence>

## Done-state (the dispatcher will check these directly)

- tests: `<command>` exits 0
- diff touches only: `<path>`, `<path>`
- state/artifact: `<path>.<field>` == `<value>`

## Scope

In scope: <paths>
Out of scope (report, do not edit): everything else

## Context (inline)

<file excerpts / error text / prior findings — no "read <path>" pointers for anything you can paste>

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
