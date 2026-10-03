# dispatch-direct — direction in, merged work out

The dispatcher's default playbook — turn explicit user direction (a task, a list, a port, a refactor, a PR) into a Task tree, dispatch 00-active executors in the background under dispatch-contract briefs, verify each outcome from git/tests/state, merge on the change's own gates, resolve the item on merge, review from `main` after the merge, and keep the Task list and backlog in sync. Load when the user gives direction that is not an issue report (that is dispatch-triage) and not a plan reference (that is dispatch-plan). Explicit direction is followed as given.

The user told you what they want. Your job is to get it done by others, prove it
is done, and leave nothing in flight. You do not reframe the request into
triage or planning they did not ask for (dispatcher rule 0).

## Flow

```text
direction ─► intake (backlog-intake) ─► task tree ─► route + brief ─► dispatch (bg, parallel)
        ◄───────────── verify from state ◄── return block
                │
                ├─ verified-pass ─► gates ─► merge ─► resolve item ─► post-merge review ─► next
                ├─ verified-fail ─► retry ladder (same tier ×1, +1 tier ×1, then surface)
                ├─ partial ──────► append (running) / resume (completed) — Step 8
                └─ deflection ──► prove-or-fix back to executor
```

## Steps

1. **Restate + root task.** One sentence; `TaskCreate` one root task per distinct outcome the user named. Mint the run identity if not already done.
2. **Intake.** Run `backlog-intake` once for the whole direction (one `scan-related` per distinct area). Fold in what the policy says to fold in; attach `old-unverified` items as check-and-confirm to the executor whose scope they touch.
3. **Task tree — into Buckets.** One subtask per **Bucket**: a cohesive group of related work — one shared done-state, a cohesive write-scope, and every change touching a given file grouped together. Size each Bucket by **cohesion and separability, not maximal size**; split a change out only when it is **separably dispatchable** (its own done-state, disjoint write-scope, no need for the Bucket's context). Reasons to dispatch smaller: the user's explicit *now/speed* directive, genuine independence, or write-scope serialization (Step 4). **Bucketing scans the backlog for any similar item to fold in** (Step 2 intake). Then apply **`definition-of-ready`** to each Bucket — **after** bucketing: it returns one of four paths — `needs-triage`, `needs-research`, `needs-spec`, or `ready` — each verdict citing the observable check that produced it, and a not-ready Bucket routes to its path instead of dispatching. Assess each Bucket's priority via **`dispatch-priority`**, with freedom to escalate (record the trigger).
4. **Serialize by write-scope — declared up front.** Buckets that touch the same files run in sequence; everything else runs in parallel. **Declare each bucket's write-scope in its brief before dispatch** and check the declared sets against each other: two executors that independently create the same file produce a real add/add collision and a fixture-driven rebase, not parallelism. Keep the same-file rule even when the executor promises to be careful.
5. **Order.** Keep the user's order if they gave one. If order matters, is unpinned, and there are more than three buckets, dispatch `product` for the order; otherwise dependency order, then shortest-first.
6. **Route.** Match each bucket to a named specialist against the dispatcher's Step 2.5 work-class table; route gaps are surfaced, not forced, and `general` is never the route for work a specialist covers. Typical matches:
   - implement a module/API/service (production code) → `backend`; type-system depth → `typescript`; restructure → `refactor`; measured perf → `performance`
   - run tests → `test`; static review → `review`; root-cause a failure → `debug` (via `dispatch-triage`); one-shot decision → `architect-decision`; multi-package spec → `architect`
   - backlog graph writes → `backlog-operator`; docs surface → `doc-steward`; git ops → `git-manager`; prioritisation → `product`; research → `researcher`
   - `general` is a last resort only; no match → surface the roster gap to the user
7. **Brief + dispatch.** Fill `dispatch-contract` §1; dispatch anonymously in the background with `model` and `tools` stated. Mark the subtask `in_progress` with the `dispatch-contract` §5 run line in `metadata`; `backlog-operator: transition` any linked item to `IN_PROGRESS` with that run line as the note (dispatcher rules 15–16).
8. **Verify.** On return, read the diff, run the done-state checks yourself, classify (`verified-pass` / `verified-fail` / `partial` / `deflection`). Update the Task entry. A `RETURN` block without evidence is `blocked`. **To reach a dispatch already sent** — correct it or supply the missing scope — re-invoke it by id: a **running** target takes the text as an *advisory append* (no interrupt; it reads it when it next looks), a **completed** target resumes with its transcript replayed (expensive — only when the follow-up needs that context). **Never cold-restart a partial:** send the full brief plus an account of what it already achieved (dispatcher Step 4).
9. **Retry ladder.** `verified-fail` → once more at the same tier with the failure evidence inlined → once at the next tier up → surface to the user with the evidence. Never a fourth attempt without the user.
10. **Merge on gates.** The merge trigger is the change's **own gates** — `pnpm test` 0 failures, `tsc --noEmit` exit 0, bundle under budget — **not** a review. Fast-forward directly when the branch is FF-able; dispatch `git-manager` only on conflict/non-FF. Confirm from `git log`; keep dispatching implementation while the merge lands — never idle on it. Then `transition` the item `merged` and **`backlog-operator: resolve` immediately** — the merge IS the completion event; `resolve` with the commit ref only when a red→green test names its id (BL-225) and rule 18's artifact-class evidence holds, else leave it at its intermediate status; mark the subtask done.
11. **Post-merge review from `main`.** After the merge, blind-review **per ticket against the merged sha** (see `dispatch-contract` §1a) — pinned so the review is race-free while other merges land. The reviewer **runs the suite**, it does not judge from reading. A finding at or above **HIGH** is never a merge blocker: bucket it with the run's other deferrals, dispatch it as immediate follow-up implementation, and surface it to the user by severity. Review type is chosen by the review's **changed lines of code** (~200–400 blind threshold; changed-file count `>=8` is a coarse secondary proxy): at/above the band → **blind review** (the reviewer receives ONLY the diff content and the instruction "Review"); below → **guided review** (focused context allowed). At **plan completion**, run exactly one **full-delta blind review** over the plan-start sha → finish sha. The **HIGH/critical filter is narrow** — it applies only to immediate corrections arising from reviews (rule 12 governs unrelated defects).
12. **Out-of-scope observations.** Anything in `out-of-scope-observed` is a candidate discovered bug: route it through `dispatch-triage`; if confirmed, `TaskCreate` + `backlog-operator: file` + a correction dispatch in this run (dispatcher rule 12). An observation in another repo is filed to that repo instead (dispatcher rule 17).
13. **Post-deploy.** If any bucket deployed, dispatch live-status + upstream-consumer verification before closing (dispatcher rule 13).
14. **Close.** `dispatch-status` check: every subtask terminal. Write the report with one telemetry row per dispatch and only the new/unacknowledged bugs/deferrals.

## Hard rules

- Never dispatch a bucket without a done-state.
- Never run two writers on the same file concurrently.
- Never merge without the change's own gates green; never merge a review gate into the delivery path.
- Never let an `out-of-scope-observed` item vanish — it is triaged, filed, and scheduled, or the user explicitly defers it.
- Never redirect explicit direction into another playbook uninvited.
