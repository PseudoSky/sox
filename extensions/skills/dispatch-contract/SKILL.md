---
name: dispatch-contract
description: The brief every dispatcher dispatch carries and the return contract every executor must satisfy. Load once per dispatcher session before the first dispatch, and whenever assembling a brief, reading a return, or writing a telemetry row. Defines the brief template (goal, observable done-state, scope, tools/model, budget, return shape, check-and-confirm items), the structured return block, the operator request shape, and the one-line-per-dispatch telemetry format. Not a playbook — the other dispatch-* skills all assume it.
source: git@bitbucket.org:id8/agents.git#categories/dispatch/skills/dispatch-contract/SKILL.md
source-version: v1.4.0 (6ffe0db1)
---

# dispatch-contract — what every dispatch carries and returns

A dispatch is verifiable only if, before it starts, the dispatcher can name the
observable state that will change when it succeeds — and, after it ends, reads
that state directly instead of the executor's summary. This contract makes both
halves mechanical.

## 1. The brief (send this, filled, as the entire dispatch prompt)

Use `templates/brief.md`. Every field is required unless marked optional.

- **Goal** — one sentence, imperative.
- **Done-state** — the observable evidence: `tests: <cmd> exits 0`, `diff touches only: <paths>`, `state: <file>.<field> == <value>`, `artifact: <path> exists with <shape>`. At least one; never "when you are confident".
- **Scope** — files/dirs in scope; anything else is out of scope and must be reported, not edited.
- **Context inline** — the file excerpts, error text, and prior findings the executor needs. Never "read `<path>` for context" for anything under 200 lines; inline it.
- **Tools / model** — the exact tool set and model tier; the executor aborts and returns if it needs an undeclared tool.
- **Budget** — a turn or token ceiling and what to do at 80%: return partial with the remaining scope named.
- **Check-and-confirm** (optional) — backlog items from `backlog-intake` bucketed `old-unverified`: the executor checks each, then **sends the dispatcher a `SendMessage` with confirm/deny + evidence before correcting anything**.
- **Return contract** — section 2, verbatim.
- **Delivery** — anonymous dispatch: the return block is the final message. Named teammate: the final action is `SendMessage` to the dispatcher with the return block.

## 2. The return block (the executor's last message, nothing after it)

```text
RETURN
outcome: done | partial | blocked
evidence:
  - <cmd> → <exit code / last line>
  - diff: <paths touched> (<n> files, +<a>/−<b>)
  - <state or artifact check> → <observed value>
out-of-scope-observed: [<path or symptom> — <one line>] | none
claims-needing-proof: [<"pre-existing"/"unrelated" style claim> — <evidence attached or "none">] | none
remaining (if partial/blocked): <what is left, or the blocker>
telemetry: turns=<n> tokens_in=<n> tokens_out=<n> retries=<n>
```

The dispatcher treats `outcome` as a pointer, not a fact: it re-runs the
done-state checks itself. A return block without an `evidence` list is treated as
`blocked`.

**The done-state is also the stopping line.** Once the dispatcher has re-run the
brief's checks and they pass, verification is finished. Any further check must
name what it could disprove that the evidence in hand does not already settle —
otherwise it is ceremony, and it costs a dispatch. A claim about file content is
decided by `diff`; a red→green control is for behavior under a condition you
cannot directly observe, never for a fact you can read.

## 3. Operator requests (backlog traffic)

```text
verb: <scan-related|dedupe|file|enrich|transition|claim|release|resolve|relate|batch|report>
by: <run identity>
repo: <slug or omit>
args: {…}
expect: <what read-back should show>
```

A `transition` request carries the §5 run line as its note (`reason`), naming the dispatched agent.

Operator replies are `OK {…}` or `ESCALATE {…}`. An `ESCALATE` is retried once,
then recorded as an *unrecorded transition* in the final report — never dropped.

## 4. Telemetry row (one per dispatch, in the final report)

`templates/telemetry-row.md`:

```text
<agent> · <tier> · turns=<n> · tok=<in>/<out> · dur_ms=<n> · item=<backlog uid|none> · verified=<pass|fail|partial> · retries=<n> · deflections=<n> · scope=<in|out> · review_items=<n>
```

`verified` is the dispatcher's own reading of the done-state, never the
executor's `outcome`. `scope=out` means the diff touched files outside the brief.
`deflections` counts `claims-needing-proof` entries that arrived without
evidence. These rows are the raw material for `docs/catalog/agents/dispatcher/METRICS.md`;
the dispatcher does not aggregate or act on them.

## 5. Run line (one per dispatch, kept current)

```text
event=<claimed|started|dispatched|blocked|merged|resolved> agent=<type> model=<tier> id=<agent/dispatch id> start=<ISO UTC> end=<ISO UTC|running> dur_ms=<n|running> item=<backlog uid|none>
```

`start` is taken with `date -u +%FT%TZ` at dispatch; `end` and `dur_ms` come from
the task-notification (`duration_ms`) when available, else from `date -u` at
return. The same line is the Task entry's `metadata`, the backlog transition's
note, and the source of the §4 row's `dur_ms`/`item`.

## Hard rules

- No brief without a done-state. No return without evidence.
- The done-state that opens a dispatch is the same line that closes it: met and read directly = verification over.
- Never reference a file for the executor to open when it can be inlined.
- Every brief states model and tools explicitly.
- Every check-and-confirm item is confirmed to the dispatcher *before* it is corrected.
