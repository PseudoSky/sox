# Playbook card: maintain

Clauses: §8.1, §8.3, §8.4, §14, R1, R2, R3, R4, P10. Obligations: TA.3, TA.5.

Serves test maintenance: lowering, rewriting, removing, quarantining, un-stubbing. One retention ticket per unit. The auditor judges the result; you never approve your own edit.

## Input
The retention ticket, the audit record naming the failed question (R1 to R6), the tests.

## Steps
1. **Lower** (§8.3): write the lower-tier test with the same assertions and a real, fake, or contract-verified double at the boundary. Prove parity by injecting each fault the original guards, or the original's own negative control, and show the new test fails. Keep the original until parity is shown, then retire it in the same change. The new test inherits the original's tags and `regression:<id>` links. If no honest lower equivalent exists, keep the test and write the gap statement in its header.
2. **Rewrite** (R4): assert behavior through the public interface; show it still fails on the guarded fault.
3. **Remove** (§8.4): state the failed question and evidence, show the defect is still covered or the requirement is gone, remove in the same change as the evidence, and write the removal record. Never batch removals.
4. Name old test, new test, and the defects the pair covers in the change record.
5. List tests made obsolete or lowered (§8.6).

## Output
The edit, the parity runs with commands and exit statuses, and the removal or audit-record fields. A different party confirms from the audit record, parity evidence, and test-file diff (§8.4, §14).

## Never
Lower to a placeholder, todo, or skipped test (P10, §8.3), or delete without per-test evidence.
