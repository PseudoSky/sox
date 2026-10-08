# dispatch-contract — what every dispatch carries and returns

The brief every dispatcher dispatch carries and the return contract every executor must satisfy. Load once per dispatcher session before the first dispatch, and whenever assembling a brief, reading a return, or writing a telemetry row. Defines the brief template (goal, observable done-state, scope, tools/model, budget, return shape, check-and-confirm items), the structured return block, the operator request shape, and the one-line-per-dispatch telemetry format. Not a playbook — the other dispatch-* skills all assume it.

A dispatch is verifiable only if, before it starts, the dispatcher can name the
observable state that will change when it succeeds — and, after it ends, reads
that state directly instead of the executor's summary. This contract makes both
halves mechanical.

## 1. The brief (the ticket carries it; dispatch sends the id + envelope)

The fields below live on the backlog ticket. Dispatch sends the ticket id and the run envelope (tools/model, budget, return contract); the executor reads the ticket with the backlog tool. Use `templates/brief.md` to author the ticket. Every field is required unless marked optional.

- **Goal** — one sentence, imperative.
- **User request (verbatim)** — `user-request (verbatim):` — the user's own words, copied exactly, never paraphrased or trimmed. This field is the record the dispatcher's additions are re-checked against, and the executor's ground truth for what was actually asked.
- **Dispatcher structuring** — `dispatcher-structuring:` — everything the dispatcher added: the restatement, the decomposition, acceptance criteria, guardrails, the chosen option among ones the user left open. **Before dispatch, re-check each addition against the verbatim.** A **HARD contradiction** is the closed set — it *forbids what the user required*, *requires what the user forbade*, *reverses a stated order/priority/constraint*, or *redirects target/scope to something the user did not name*. On a HARD contradiction, **halt and ask the user before dispatching**. Restating, disambiguating, adding acceptance criteria, choosing among open options, and adding consistent guardrails are **not** contradictions — never ask on those.
- **Acceptance criteria (with ids)** — the item's AC block, each criterion carrying a stable id (`AC1`, `AC2`, …). Every test, whoever writes a test, cites the ticket and the AC ids it exercises (`<uid or BL-<n>> AC<n>`); one test may cite several ACs, but every AC is cited by at least one, and an AC no test cites fails verification. An item with no ACs is not dispatched.
- **Test routing** (briefs for a change that needs tests) — `test-authorship:` (`implementer` | `separated`), `rigor:` (`none` | `light` | `standard` | `deep`) and `playbook:` (the one card id), all as returned by `workspace-standards run testing`. The citation duty attaches to whoever writes a test.
- **Done-state** — the observable evidence: `tests: <cmd> exits 0`, `diff touches only: <paths>`, `state: <file>.<field> == <value>`, `artifact: <path> exists with <shape>`. At least one; never "when you are confident".
- **Worktree** (implementer briefs) — the bucket worktree path, the bucket branch, and the plan branch it merges into fast-forward only before transitioning its issue to `review`.
- **Scope** — files/dirs in scope; anything else is out of scope and must be reported, not edited.
- **Context inline** — the file excerpts, error text, and prior findings the executor needs. Never "read `<path>` for context" for anything under 200 lines; inline it.
- **Tools / model** — the exact tool set and model tier; the executor aborts and returns if it needs an undeclared tool.
- **Budget** — a turn or token ceiling and what to do at 80%: return partial with the remaining scope named.
- **Check-and-confirm** (optional) — backlog items from `backlog-intake` bucketed `old-unverified`: the executor checks each, then **sends the dispatcher a `SendMessage` with confirm/deny + evidence before correcting anything**.
- **Return contract** — section 2, verbatim.
- **Delivery** — anonymous dispatch: the return block is the final message. Named teammate: the final action is `SendMessage` to the dispatcher with the return block.

## 1a. Review briefs and the test standard

Reviews occur twice in a plan (dispatcher Step 5); `templates/brief.md` carries all shapes.

- **Static-analysis review** (stage 4, per bucket, guided) — **target**: the bucket's diff on the plan branch. The brief carries the bucket's ACs and scope. The reviewer reads and analyses and does **not** run the suite (QA does); it checks each test's tier and fidelity-gap statement for validity. Return: findings by severity, each with file:line evidence.
- **Audit** (QA retention audit) — the brief carries the auditor card, R1–R6 and the audit record format, each inlined. Return: one audit record per test.
- **The blind review** (stage 9, exactly one per plan) — the reviewer receives **only** the plan's whole diff (start sha to head) and the instruction "Review": no ACs, context, rationale, review points or return contract. The dispatcher reads the findings from the reply and files them. A correction, a reopen cycle or a re-dispatch never gets one.

**Test standard** — rides the briefs of test-writing roles only. Inline that role's card (`workspace-standards` `standards/testing/cards/`) and the project's tier-mapping excerpt; do not restate the standard in the brief.

## Verification (run before returning)

Do not report `done` from belief. Run each line, then put the result in `evidence:`.

- Re-run the done-state checks (the `tests:`/`state:`/`artifact:` lines) and confirm each passes.
- Re-read the `diff` and confirm it touches exactly the stated path(s) — no more.
- If the change must be committed and is not, say so in `remaining` — an uncommitted change is not `done`.

## 2. The return block (the executor's last message, nothing after it)

```text
RETURN
outcome: done | partial | blocked
evidence:
  - <cmd> → <exit code / last line>
  - diff: <paths touched> (<n> files, +<a>/−<b>)
  - <state or artifact check> → <observed value>
ac-coverage: [<AC id → test citing ticket+AC id>]
tier: [<test → tier>] | none
red: <cmd → non-zero exit, failing assertion> | none
tests-obsoleted: [<test — why>] | none
test-dispute: [<test — evidence>] | none
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

## 5. Run line / dispatch record (one per dispatch, kept current)

```text
dispatcher: <dispatcher session_id>, session: <subagent session id>, agent: <dispatched agent name>, task: <task title>, run_at: <ISO UTC timestamp>
```

This line is the single dispatch record. At dispatch it is appended (`backlog-operator:
append-note`) to the plan or issue the dispatch serves — the issue, or the plan item for
plan-level work; with no item it lives only in the Task entry's `metadata`. Lifecycle
transitions carry it followed by `; event=<claimed|started|dispatched|blocked|merged|resolved>
model=<tier> end=<ISO UTC|running> dur_ms=<n|running> item=<backlog uid|none>`.

`run_at` is taken with `date -u +%FT%TZ` at dispatch; `end` and `dur_ms` come from the
task-notification (`duration_ms`) when available, else from `date -u` at return. Session ids
come from the host and the dispatch result — an id the host does not expose is written
`unknown`, never invented. The same line is the Task entry's `metadata`, the backlog
transition's note, and the source of the §4 row's `dur_ms`/`item`.

## Hard rules

- Every brief carries the user's request `verbatim` and the dispatcher's `dispatcher-structuring`; the structuring is re-checked against the verbatim for HARD contradictions before dispatch.
- No brief without a done-state. No return without evidence.
- The done-state that opens a dispatch is the same line that closes it: met and read directly = verification over.
- Never reference a file for the executor to open when it can be inlined.
- Every brief states model and tools explicitly.
- Every check-and-confirm item is confirmed to the dispatcher *before* it is corrected.
- Every AC is cited by a test carrying the ticket and the AC id; an AC no test cites is not `done`.
- A role that writes tests returns `tier:`, `red:` and `tests-obsoleted:`; an implementer who disagrees with a test returns `test-dispute:` and never edits the test.
