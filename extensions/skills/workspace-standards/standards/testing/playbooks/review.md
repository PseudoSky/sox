# Playbook: review testing

`/workspace-standards review testing`: the testing-specific checks on top of the foundation reviews. Run `review routing` and `review gates` first (`review all` does).

## Steps
1. Run the standard's conformance specification: `node scripts/conformance.mjs testing --strategy <policy path>`. It checks the declaration, `roles.md`, every card (size and clause ids), every playbook (ends in `## Record`), and every format (fields present).
2. Name independence: the policy document and the IMPLEMENTATION contain no agent name from the harness roster. Report each hit.
3. Conformance level: from the IMPLEMENTATION's gate mapping, count the gates with a working mechanism; an obligation without a mechanism counts toward no level (§13). Report L1, L2, or L3 and the unbound roles that lower it.
4. Managed-block drift: run `node scripts/apply-testing.mjs --root <repo> --check` (read-only). Exit 3 is drift: a managed block differs from its rendering. Exit 5 is never applied: a managed block, the roles file or the IMPLEMENTATION skeleton is absent. Report exit 5 as a finding that the standard was never applied, distinct from drift; exit 0 is clean.
5. Report each finding as `{ id, severity, evidence }`; severity `error` for a failed check, `planned` for a mechanism not yet built.

## Output
The findings list and the level.

## Record
The findings list written to the review output location the repository names (or the work item), with the command lines and exit statuses.
