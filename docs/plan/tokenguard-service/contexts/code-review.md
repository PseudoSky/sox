# code-review — CODE_REVIEW

> **Slug is identity.** Immutable.

**Phase:** final · **Depends on:** decouple-generalize · **Guard:** `python3 docs/plan/tokenguard-service/scripts/guard_code_review.py`

---

## Goal

After this state, the orchestrator has performed a **full code review of every touched project** and recorded findings + their resolution in `code-review.md`, and a clean `typecheck/lint/test` run across all touched projects is green. This is the reviewer gate the requester asked for — *"I want you to do a final code review before final check"* — sitting immediately before `audit-final`.

---

## Semantic Distillation

- **Primitive:** CREATE `docs/plan/tokenguard-service/code-review.md` — the recorded review + verdict.
- **Reference Pattern:** the diff of everything authored across the framework/core/service tracks; the project's CI order (`build → validate --strict → typecheck → test`).
- **Delta Spec:**
  - Review every touched project: `tokenguard-core`, `tokenguard`, `manifest`, `authoring`, `host-runtime`, `install-engine`, `host-registry`, `apps/sox`. For each, record: correctness, **[inv:*]** adherence, **[ref:*]** conformance, security (the C6 sink guard), and reuse/simplification findings.
  - Record each finding with a resolution (fixed in source as an amendment to the owning state, or explicitly accepted with rationale). A finding that changes behavior is fixed in the owning state, not here.
  - Write a final `VERDICT: PASS` line only when all findings are resolved/accepted and the cross-project gate is green.
  - The guard requires: `code-review.md` present with `VERDICT: PASS`, **and** `npx --yes nx run-many -t typecheck,lint,test --projects=tokenguard-core,tokenguard,manifest,authoring,host-runtime,install-engine,host-registry,sox` exits 0.
- **Invariants:** the review must not weaken any guard or audit check to pass; fixes land in source.
- **Validation:** the guard asserts the verdict + the clean cross-project run.

---

## Acceptance criteria

- [ ] **[code-review.1]** `code-review.md` exists with a `VERDICT: PASS` line and per-project findings. `grep -n "VERDICT: PASS" docs/plan/tokenguard-service/code-review.md`
- [ ] **[code-review.2]** the cross-project typecheck/lint/test gate is recorded green. `grep -n "run-many" docs/plan/tokenguard-service/code-review.md`

---

## Reservations

```text
read_only:  ["libs/tokenguard-core/src/index.ts",
             "extensions/services/tokenguard/src/index.ts",
             "libs/manifest/src/index.ts",
             "libs/host-runtime/src/supervisor.ts",
             "libs/install-engine/src/install.ts"]
mutates:    ["docs/plan/tokenguard-service/code-review.md"]
```

---

## Contract Promise

- **Added:** `code-review.md` — the recorded review + verdict.
- **Modified:** none here (any fix the review demands is an amendment to the owning source state).
- **Deleted:** none.

---

## Commit points

- [ ] **After the review is recorded with a PASS verdict + green gate** — `chore(tokenguard-service): code-review — orchestrator review PASS, cross-project gate green`
- [ ] **After the guard passes** (mandatory) — `chore(tokenguard-service): code-review complete`

---

## Notes for executor

- This is a review **by the orchestrator**, distinct from the architecture review of the plan (done before execution) and the founder's live-demo acceptance (at `audit-final`).
- If the review surfaces a behavior fix, make it an `amendment_log` entry against the owning state and re-run that state's guard before continuing — do not patch it silently here.
