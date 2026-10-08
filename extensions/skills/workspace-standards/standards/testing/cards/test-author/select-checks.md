# Playbook card: select-checks

Clauses: §2.4, §6.7, §7.1, §7.2, G10, P3. Obligations: TA.2, TA.3.

Serves the configuration and dependency classes. One item per unit.

## Input
The item, the changed files, the class and rigor record.

## Steps
1. Determine whether the change alters observable behavior. If it does not, no new test is written (§6.7).
2. Name the artifact check that covers the change: the built artifact loads and its primary journey runs as a consumer runs it (§2.4, G10). Name any `smoke` or `contract` subset the change reaches.
3. For a dependency on the runtime path of a shipped artifact, raise the rigor to Standard and name the contract tests of the boundaries the dependency provides (§6.7).
4. Confirm each named check runs at its earliest stage for its tier (§7.2).
5. Add a `smoke` test only if no existing check covers the primary journey the change touches. Write it at the lowest tier that can load the artifact, with a gap statement (P3, §6.2).
6. Record the selected checks and why on the item.

## Output
The list of checks that cover the change with their stages, plus any new smoke test with header and red evidence.

## Never
Add a test for behavior the change does not alter, or run X-tier checks in presubmit (§7.1).
