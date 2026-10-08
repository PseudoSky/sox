# Playbook: apply testing

`/workspace-standards apply testing` writes only the testing-specific parts of a repository. It does not write routing rows, `roles.md`, or gate bindings; those belong to `apply routing` and `apply gates` unless `standard.json` declares `own`.

## Input
The target repository root and the policy document location (`registry.json` > `policy`).

## Steps
1. Read `standards/testing/standard.json` and `templates/agents-block.md`. Confirm the repository's policy document exists and names no agent.
2. Write the testing block between `workspace-standards:testing:begin` and `workspace-standards:testing:end` in the repository's `AGENTS.md`, from `templates/agents-block.md`: at most 12 lines, no agent name. Create the markers if absent; touch nothing outside them. A re-run changes only the block.
3. Write the `test-routing` capability row and the class table behind it (classification is domain-specific, so it is not a routing-foundation row).
4. Copy the five record formats and the cards the repository's briefs will inline. Keep the 4096-byte limit (`scripts/conformance.mjs testing`).
5. Write the IMPLEMENTATION skeleton from `templates/implementation-skeleton.md` to the binding path (`registry.json` > `binding`). The binding table sits in the hand-maintained region, created once and never overwritten.
6. For each mechanism a gate or check needs that does not exist (a checker, a hook), file one backlog item instead of editing code.
7. With `--dry-run`, print the diff and write nothing. A hand edit inside a managed block is drift: report it and do not overwrite without an explicit flag.

## Output
The changed blocks, the IMPLEMENTATION skeleton path, the list of filed mechanism items.

## Record
The diff summary (blocks written, files created, items filed) in the change description; a second run must produce no diff.

Status: the managed-block writer and the routing command are built by later tasks; until they exist, perform steps 2 to 5 by hand against the same template and state that in the Record.
