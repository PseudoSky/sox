# Changelog

## 2.1.0

- Test standard (item 5416b29f, T15): the binary unit/e2e standard is replaced by inlining the test-writing role's card and the project's tier-mapping excerpt; it rides test-writing briefs only. The citation duty attaches to whoever writes a test.
- Brief gains `test-authorship:`, `rigor:`, `playbook:`; return gains `tier:`, `red:`, `tests-obsoleted:`, `test-dispute:`. Static-review brief checks tier and gap validity; new audit brief carries the auditor card, R1-R6 and the audit record format. Pin tests in `tests/pin.test.mjs`.

## 2.0.0

- §1a rewritten: the static-analysis review brief (per bucket, guided, no suite run) and the plan's single blind review (diff + "Review" only); the post-merge review brief and §1b are removed. Adds the test standard (unit-test mocking, one-shot e2e).
- Brief gains a Worktree field; `none applicable` removed from the AC, return and hard-rule text; tests may cite several ACs. Matches dispatcher 2.0.0.

## 1.9.0

- §1a: blind review applies only to first-pass implementations; corrections (finding fixes, `main` hot fixes, re-dispatches) get no review round.
- §5: the run line is now the dispatch record `dispatcher: …, session: …, agent: …, task: …, run_at: …` (+ lifecycle fields), appended to the plan or issue it serves. Matches dispatcher 1.14.0.

## 1.8.0

- **The brief is the ticket.** §1: the brief fields live on the backlog ticket; dispatch sends the ticket id and the run envelope, and the executor reads the ticket with the backlog tool. Matches dispatcher 1.12.0.

## 1.7.0

- **Acceptance criteria carry ids and every AC is proven by a citing test.** §1 gains the AC-block field (stable `AC1`/`AC2` ids; every test must cite the ticket and the AC id); §2's return block gains `ac-coverage:`; a hard rule forbids `done` with an AC that no citing test exercises. `templates/brief.md` gains the `## Acceptance criteria` section.

## 1.6.1

- **Post-ship refinement.** §1a and `templates/brief.md` choose review type by **changed lines of code** (~200–400); `>=8` changed files is a coarse secondary proxy.

## 1.6.0

- **The brief carries the verbatim user request.** §1 adds `user-request (verbatim):` and `dispatcher-structuring:`, with the HARD-contradiction closed set and the non-contradictions named — never ask on an admissible addition.
- **Review type by changed-file count.** §1a: `>=8` → blind (diff + "Review" only), `<8` → guided, exactly one full-delta blind review at plan completion. §1b: the HIGH/critical filter is narrow — immediate corrections arising from reviews only.
- **Verification section** added before the return block: re-run the done-state checks and re-read the diff before reporting `done`.
- Hard rule: every brief carries the verbatim and the re-checked structuring.

## 1.5.0

- **Post-merge review brief (§1a) and severity-for-bucketing (§1b).** AC2: the reviewer **runs the suite**, it does not judge from reading — gates named (`pnpm test` 0 failures, `tsc --noEmit` exit 0, bundle to a TEMP outDir under the size budget), raw exit codes and **flake measurements across runs** required, and the review runs against the **merged commit by sha, per ticket, from `main`**. Records the gitignored-fixture trap (`public/events.json` / `details.json` — copy from the repo root; a missing fixture is not a code failure). §1b states the HIGH disposition (bucketed as follow-up impl, never a merge blocker), the rails (every finding filed AND scheduled; a red `main` is an immediate fix), and the tradeoff. `templates/brief.md` gains the matching `## Review target` fill-in block (AC3/AC4/AC5).

## 1.4.0

- Initial release. Ingested verbatim from `claude-agents` (`categories/dispatch/skills/dispatch-contract/SKILL.md`,
  v1.4.0, commit `6ffe0db1`) as part of the `dispatcher` v1.4.0 ingestion. Ships `templates/brief.md`
  and `templates/telemetry-row.md`.
