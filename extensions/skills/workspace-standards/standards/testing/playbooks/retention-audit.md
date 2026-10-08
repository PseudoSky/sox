# Playbook: retention-audit

Mode of `run testing`. Reviews a group of tests against the retention questions. Triggered by an event or the sweep (§8.2); never by age alone.

## Input
A group of tests, the retention report (duration, flake count, failure history, tier, kill-set uniqueness where available), the trigger that opened the audit.

## Steps
1. Confirm the auditor's independence: read each test's authorship record; refuse any test the auditor authored (§14).
2. For each test, apply R1 to R6 in order using `cards/role/auditor.md`. Record the method with each answer.
3. Act on the first failed question (§8.1): strengthen or remove, remove or merge, lower, rewrite, repair on a deadline, or remove.
4. Lower with parity (§8.3); remove with per-test evidence (§8.4). Dispatch `cards/test-author/maintain.md` for the edits.
5. A removal that cannot show coverage of the guarded failure mode is a risk acceptance: it needs a named owner and an exception-log entry (§8.4, §10).
6. Have every edit or removal confirmed by a different party that receives only the audit record, the parity evidence, and the test-file diff.
7. Report net suite growth: tests added, lowered, removed (§8.6).

## Output
Audit records, removal records, parity evidence, the growth line.

## Record
One audit record per test (`formats/audit-record.md`), one removal record per removal (`formats/removal-record.md`), written on the retention ticket.
