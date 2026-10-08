# Playbook: flake-triage

Mode of `run testing`. Handles a test that passes and fails on the same code (P6, §9).

## Input
The flaking test, the repeat-run or CI history showing both outcomes on the same code.

## Steps
1. Confirm it is a flake: same code, both results (§8.2). A sampled test of non-deterministic behavior that meets its stated pass rate is not a flake (§12).
2. Remove the cause first, in this order: shared state, wall-clock dependence, real network, unordered output, resource leaks, fixed sleeps. Wait for conditions with bounded deadlines (§9).
3. If the fix is not immediate, quarantine: remove the test from the gating run, keep executing and reporting it, and open a tracking item with an owner and a deadline (default 14 days) (§9).
4. Never add a retry that turns red green silently. A retry is a recorded known flake with a tracking item and a fix date (§9, G5).
5. At the deadline the test is fixed or removed. A quarantine never exceeds its deadline (G1, G4).
6. Check the flake rate of the tier against the budget (G5); crossing it escalates.
7. If the test was kept only by retry, run `retention-audit` on it.

## Output
The cause found, the fix or the quarantine item, the budget check.

## Record
The tracking item (owner, deadline, cause, repeat-run evidence with commands and exit statuses) on the backlog; a closed item names the fixing change or the removal record.
