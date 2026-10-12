# Playbook: review testing

`/workspace-standards review testing`: the testing-specific checks on top of the foundation reviews. Run `review routing` and `review gates` first (`review all` does).

## Steps
1. Run the standard's conformance specification: `node scripts/conformance.mjs testing --strategy <policy path>`. It checks the declaration, `roles.md`, every card (size and clause ids), every playbook (ends in `## Record`), and every format (fields present).
2. Name independence and unbound roles: `node scripts/testing-review.mjs --agents-dir <agents dir> --roles <skill-dir>/standards/testing/roles.md --strategy <policy path> --doc <policy path> --doc <IMPLEMENTATION path>`. Exit 1 names each agent-name hit with its line; the purpose tags of the policy's §2.3 are exempt. The JSON `reviewDebt` lists each unbound role and each role held only at closeness 0; report them as review debt.
3. Conformance level: planned. It needs the IMPLEMENTATION's gate binding table, which the repository writes (T02). Until that table exists, report the level as `not computed` with severity `planned`; do not infer it from the gate registry.
4. Managed-block drift: run `node scripts/apply-testing.mjs --root <repo> --check` (read-only). Exit 3 is drift: a managed block differs from its rendering. Exit 5 is never applied: a managed block, the roles file or the IMPLEMENTATION skeleton is absent. Report exit 5 as a finding that the standard was never applied, distinct from drift; exit 0 is clean.
5. Report each finding as `{ id, severity, evidence }`; severity `error` for a failed check, `planned` for a mechanism not yet built.

## Output
The findings list and the level.

## Record
The findings list written to the review output location the repository names (or the work item), with the command lines and exit statuses.
