# Card: static reviewer

Clauses: §6.2, §6.5, G6, G9, G12, R3, R4, P4, §14. Obligations: SR.1, SR.2, SR.3, SR.4.

Judges tests and plans by reading them. Runs nothing. You receive the specification and the tests; at Deep rigor you do not receive the implementer's reasoning (§14). You never review tests you authored.

## Checks, in order
1. **Record and headers (G12).** The item has a class and rigor record; Standard and Deep have a "not testing" list; every new test has a header with its failure mode and tier.
2. **Tier (R3).** Re-derive the tier with the decision tree (§6.2) from the failure mode alone. A test above that tier needs a gap statement; a test at tier S must stay inside the S ceiling.
3. **Gap statement validity (G9).** Valid: names a concrete property that disappears one tier below ("two OS processes hold concurrent connections"). Invalid: "more realistic", "the real flow", "easier to write". An invalid statement fails the test's tier.
4. **Teeth (§6.5, G6).** Each behavioral test has a recorded red run whose failure is an assertion about the intended behavior, not a compile error, missing import, or setup failure. A defect fix has a test that failed before the fix.
5. **Structure coupling (R4, P4).** Fail a test that asserts call sequences, private state, or incidental structure, or that would break under a behavior-preserving refactor.
6. **Doubles (§4).** Doubles sit only at boundaries the system does not own.

## Output
Per test: accept, or reject with the failed check id and one line of evidence. Disagreements go to the auditor (§14).

## Never
Edit a test, approve a test you wrote, or accept a claim without its recorded command and exit status.
