# dispatch-triage — evidence before anything

The dispatcher's playbook for an issue report — a bug, a red test, a reviewer finding, an executor's out-of-scope observation, or any "pre-existing / unrelated / skipped" claim. Root-cause with debug first (evidence, never the dispatcher's own guess), plan the fix with architect when the decision is technical, then implement through dispatch-direct — which merges on the change's own gates, resolves the item on merge, and reviews from `main` after the merge. Nothing is filed to the backlog or surfaced to the user as fact until triage has evidence. Load on any report; the user's explicit direction still overrides.

A report is a hypothesis. This playbook turns it into either a confirmed defect
with a scheduled fix or a documented non-issue — and nothing in between reaches
the user or the backlog as fact.

## Flow

```text
report ─► debug (root-cause + evidence) ─┬─ confirmed ─► significance?
                                            │                ├─ trivial ─► dispatch-direct (fix) ─► gates ─► merge ─► resolve ─► post-merge review
                                            │                └─ significant ─► architect (fix plan) ─► dispatch-direct ─► gates ─► merge ─► resolve ─► post-merge review
                                            ├─ refuted ─► record why (evidence) ─► return to reporter if it was a deflection
                                            └─ cannot determine ─► INSUFFICIENT → what evidence is needed → back to reporter or user
```

## Steps

1. **Capture, don't classify.** `TaskCreate` `triage: <one-line symptom>` under the current root. Do not name a cause in the task title. A report or deferral claim is the `needs-triage` path of `definition-of-ready` — routed here before any dispatch, never assumed to be already understood.
2. **Dedupe first.** `backlog-operator: dedupe` by symbol, path, and error text. An existing item is enriched, not re-filed; its status governs whether this is new work.
3. **Dispatch `debug`** (model sonnet; tools Read, Grep, Glob, Bash) with a `dispatch-contract` brief whose done-state is *an evidence-backed root cause or an explicit "cannot reproduce" with what was tried*: the symptom, the exact error text, the reporter's claim verbatim (labeled as a claim), the commits in question, and how to reproduce. The brief says: rule 6 applies — a claim of "pre-existing"/"unrelated" must be proven with `git log`/`git bisect`/a failing run on the base ref, or it is not accepted.
4. **Read the evidence yourself.** Run the reproduction the debug names. If the debug's conclusion is not reproducible from its own evidence, re-dispatch once with that gap named, then surface.
5. **Branch on outcome.**
   - *Confirmed, trivial* (single-line, compiler-obvious, no design question): straight to `dispatch-direct` as a bucket with the fix as goal.
   - *Confirmed, significant* (root-cause spans modules, a design choice is involved, or the fix touches an interface): dispatch `architect` for the fix plan (files, sequence, executor, test); one-shot decisions inside it go to `architect-decision`. Then `dispatch-direct` per the plan.
   - *Refuted*: record the evidence on the task; if the report was an executor's deflection, the original work returns to that executor with the refutation.
   - *Undetermined*: surface to the user as `(hypothesis, triage incomplete)` with the exact missing evidence.
6. **File and schedule.** On confirmation: `backlog-operator: file` (or `enrich` the dedupe hit) with citations from the debug's evidence; `TaskCreate` the fix; dispatch it in this run (dispatcher rule 12). Deferral only on the user's word — then `backlog-operator: transition` with the reason.
7. **Close the loop.** The fix merges on its own gates and is `resolve`d on merge (`dispatch-direct` Step 10); the post-merge review follows from `main` per ticket (`dispatch-direct` Step 11). `backlog-operator: resolve` carries the commit ref and the reproduction that now passes. A HIGH the post-merge review returns is bucketed and dispatched as follow-up implementation — it never stalls the delivery.

## Hard rules

- The dispatcher never names a root cause; `debug` does, with evidence the dispatcher re-runs.
- No backlog item is filed on an unconfirmed report; no report reaches the user unlabeled. Exception: an issue observed in another repo is filed to that repo as a labeled symptom with evidence (dispatcher rule 17), without triage.
- A significant confirmed issue never goes straight to an implementation executor.
- A refuted deflection goes back to its reporter with the evidence, not to a new executor.
- The dispatcher supplies the debug with *symptoms, the claim verbatim, and repro
  steps* — never candidate causes it derived itself. If a commit looks suspect, that is
  a finding the debug must reach independently, or it is not evidence. Deriving it
  yourself first is the pre-dispatch investigation rule 1 forbids.
