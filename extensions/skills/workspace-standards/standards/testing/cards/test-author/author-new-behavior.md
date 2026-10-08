# Playbook card: author-new-behavior

Clauses: §6.1, §6.2, §6.4, §6.5, §14, G6, G9, G12. Obligations: TA.3, TA.4, TA.5.

Serves the new-behavior class. One item or one cohesive module per unit.

## Input
The item's criteria and interface, the plan block from planning, the declared write scope (tests and test support only).

## Steps
1. Derive the tests from the specification (criteria, interfaces, contracts), not from the implementation (§14).
2. Write one test per ranked failure mode at the planned tier, default S (§6.1.4). Parameterized cases of one failure mode are one test; each equivalence class among them must show red once.
3. Apply the case-design technique that fits and name it where non-obvious: partitions, boundaries, negative and adversarial input, state transitions, properties, concurrency with barriers and never sleeps (§6.4).
4. Header on every test: failure mode, tier, fidelity-gap statement for P, H, X, the item and criterion cited (§6.1.8, G9, G12).
5. Record the failing run against the base commit: command, exit status, the failing assertion (§6.5, §14). The stub returns a typed default so the failure is an assertion on value, not a crash.
6. Commit the tests to the bucket branch. List the tests made obsolete or lowered, or none (§8.6).

## Output
Committed failing tests, headers, `red:` evidence (command, non-zero exit, failing test names), the obsolete-tests line.

## Never
Edit production code, weaken an assertion to reach green, or leave a skipped or todo test (§14, P10).
