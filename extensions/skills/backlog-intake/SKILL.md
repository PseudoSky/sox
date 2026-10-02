# backlog-intake — burn the backlog while you're there

The dispatcher's intake step — before decomposing any direction, ask backlog-operator for related backlog items (by symbol, path, error text) and apply the inclusion policy — same root cause → recommend folding in; small and in scope → fold in to burn the backlog; old or unverified → attach to the related executor as check-and-confirm (the executor must message the dispatcher confirm/deny with evidence before correcting); unrelated → leave. Runs once per direction in dispatch-direct/dispatch-triage. Load at intake; never files new items (that is triage).

Related backlog items are cheapest to fix when an executor is already in the
file. This step finds them, buckets them with the operator, and applies a fixed
policy so the user is asked once, not per item.

## Steps

0. **Catalogue first — never defer.** The moment a user request arrives, catalogue every user-requested item with the user's message **verbatim** and immutable. A correction appends to the existing record; new work is a new item; enrichment runs after and must never remove or alter the verbatim. A user note carries **no citation** — the user's word is truth, not evidence.
1. **Extract the axes** from the direction: symbols (function/class/module names), paths (files and dirs that will change), error strings (verbatim), and a one-line summary.
2. **`backlog-operator: scan-related`** with those axes (one request per distinct area of the direction). The operator returns items bucketed `same-root-cause` / `small-in-scope` / `old-unverified` / `unrelated`, each with the evidence that placed it.
3. **Apply the policy.**
   - `same-root-cause` → **recommend inclusion, ask once.** Present the items in one line each ("BUG-X — same mechanism as <symbol>; include?"). On yes: `TaskCreate` as a leaf or fold into the matching leaf; `backlog-operator: transition` → `IN_PROGRESS`; `relate` to the primary item if one exists.
   - `small-in-scope` → **include without asking** (the user's standing policy). `TaskCreate` as a sub-leaf of the executor whose scope holds the path; `transition` → `IN_PROGRESS`. State what was included in the report.
   - `old-unverified` → **check-and-confirm.** Add to the related executor's brief (`dispatch-contract` §1): verify best-effort while in the area, `SendMessage` the dispatcher confirm/deny with evidence, and **correct only after the dispatcher acknowledges**. On confirm: the dispatcher `TaskCreate`s the fix and `transition`s the item; on deny: `backlog-operator: enrich` with the evidence and, if refuted, a `transition` proposal for the user.
   - `unrelated` → leave; do not mention unless the user asks.
4. **Record.** Every included item appears in the Task list and is `IN_PROGRESS` under this run's identity before its executor is dispatched. Every confirm/deny message from an executor is acted on within the run, never left pending at close.

## Hard rules

- One user question per intake, covering all `same-root-cause` items together.
- `old-unverified` items are never corrected before the dispatcher acknowledges the executor's confirm message.
- Never file new items here; a new defect is `dispatch-triage`'s job.
- Never include an item the operator bucketed `unrelated`.
- Cataloguing is never deferred, and the user's verbatim is never removed or altered by enrichment or citation — a user note carries no citation.
