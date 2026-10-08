# Playbook card: author-regression

Clauses: §6.1, §6.7, §8.5, G6, R3, P3. Obligations: TA.3, TA.4.

Serves the defect-fix class. One defect per unit.

## Input
The defect item, the reproduction, the escape record if the triager wrote one (§8.5).

## Steps
1. Scope the risk map to the escaped failure mode (§6.7).
2. Choose the lowest tier that observes the failure (P3, §8.5 step 1). If only a higher tier observes it, write the gap statement and the test there (§8.5 step 3).
3. Write the test so it fails on the pre-fix commit for the intended reason: an assertion about the defect's behavior (G6, §6.5).
4. Tag it `regression:<defect id>` so the defect record links to the test (§2.3).
5. Record the same test run failing before the fix and passing after, with both commands and both exit statuses (§6.7, G6).
6. Supply the fields the escape record owes: lowest observing tier, stage that would have run the test, the missing-test finding (§8.5).
7. Header per the test-header format (§6.1.8).

## Output
The regression test, the before and after runs, the escape-record fields.

## Never
Commit the fix and the test as one unverifiable step, assert the fix's implementation instead of the behavior, or pick a higher tier for convenience (R3).
