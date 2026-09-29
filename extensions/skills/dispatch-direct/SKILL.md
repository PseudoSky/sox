# dispatch-direct — direction in, merged work out

The dispatcher's default playbook — turn explicit user direction (a task, a list, a port, a refactor, a PR) into a Task tree, dispatch 00-active executors in the background under dispatch-contract briefs, verify each outcome from git/tests/state, review-gate and merge, and keep the Task list and backlog in sync. Load when the user gives direction that is not an issue report (that is dispatch-triage) and not a plan reference (that is dispatch-plan). Explicit direction is followed as given.

The user told you what they want. Your job is to get it done by others, prove it
is done, and leave nothing in flight. You do not reframe the request into
triage or planning they did not ask for (dispatcher rule 0).

## Flow

```text
direction ─► intake (backlog-intake) ─► task tree ─► route + brief ─► dispatch (bg, parallel)
        ◄───────────── verify from state ◄── return block
                │
                ├─ verified-pass ─► review gate ─► merge ─► resolve item ─► next
                ├─ verified-fail ─► retry ladder (same tier ×1, +1 tier ×1, then surface)
                ├─ partial ──────► resume with remaining scope
                └─ deflection ──► prove-or-fix back to executor
```

## Steps

1. **Restate + root task.** One sentence; `TaskCreate` one root task per distinct outcome the user named. Mint the run identity if not already done.
2. **Intake.** Run `backlog-intake` once for the whole direction (one `scan-related` per distinct area). Fold in what the policy says to fold in; attach `old-unverified` items as check-and-confirm to the executor whose scope they touch.
3. **Task tree.** One subtask per dispatchable leaf. A leaf is dispatchable when you can write its done-state in `dispatch-contract` terms. Split until you can; never dispatch a leaf without one. Cap: no leaf covers more than five discrete items.
4. **Serialize by write-scope.** Leaves that touch the same files run in sequence; everything else runs in parallel. Keep the same-file rule even when the executor promises to be careful.
5. **Order.** Keep the user's order if they gave one. If order matters, is unpinned, and there are more than three leaves, dispatch `product` for the order; otherwise dependency order, then shortest-first.
6. **Route.** Match each leaf to a named specialist against the dispatcher's Step 2.3 work-class table; route gaps are surfaced, not forced, and `general` is never the route for work a specialist covers. Typical matches:
   - implement a module/API/service (production code) → `backend`; type-system depth → `typescript`; restructure → `refactor`; measured perf → `performance`
   - run tests → `test`; static review → `review`; root-cause a failure → `debug` (via `dispatch-triage`); one-shot decision → `architect-decision`; multi-package spec → `architect`
   - backlog graph writes → `backlog-operator`; docs surface → `doc-steward`; git ops → `git-manager`; prioritisation → `product`; research → `researcher`
   - `general` is a last resort only; no match → surface the roster gap to the user
7. **Brief + dispatch.** Fill `dispatch-contract` §1; dispatch anonymously in the background with `model` and `tools` stated. Mark the subtask `in_progress` with the `dispatch-contract` §5 run line in `metadata`; `backlog-operator: transition` any linked item to `IN_PROGRESS` with that run line as the note (dispatcher rules 15–16).
8. **Verify.** On return, read the diff, run the done-state checks yourself, classify (`verified-pass` / `verified-fail` / `partial` / `deflection`). Update the Task entry. A `RETURN` block without evidence is `blocked`.
9. **Retry ladder.** `verified-fail` → once more at the same tier with the failure evidence inlined → once at the next tier up → surface to the user with the evidence. Never a fourth attempt without the user.
10. **Review gate.** Blind review: dispatch `review` with the diff and the word "Review" — no context, no rationale, no prior state. Open items go back to the same executor; zero items → merge.
11. **Merge.** Dispatch the merge per `docs/contributing/conventions/git-workflow.md`; confirm from `git log`; `transition` the item `merged`, then `backlog-operator: resolve` with the commit ref only when a red→green test names its id (BL-225), else leave it at its intermediate status; mark the subtask done.
12. **Out-of-scope observations.** Anything in `out-of-scope-observed` is a candidate discovered bug: route it through `dispatch-triage`; if confirmed, `TaskCreate` + `backlog-operator: file` + a correction dispatch in this run (dispatcher rule 12). An observation in another repo is filed to that repo instead (dispatcher rule 17).
13. **Post-deploy.** If any leaf deployed, dispatch live-status + upstream-consumer verification before closing (dispatcher rule 13).
14. **Close.** `dispatch-status` check: every subtask terminal. Write the report with one telemetry row per dispatch and only the new/unacknowledged bugs/deferrals.

## Hard rules

- Never dispatch a leaf without a done-state.
- Never run two writers on the same file concurrently.
- Never merge without a zero-item review.
- Never let an `out-of-scope-observed` item vanish — it is triaged, filed, and scheduled, or the user explicitly defers it.
- Never redirect explicit direction into another playbook uninvited.
