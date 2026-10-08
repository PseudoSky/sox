# Playbook: apply gates

Writes the gate registry and stage bindings, composed from every registered standard's declared gates.

## Steps
1. Read each active standard's `standard.json` `gates` (id, threshold, mechanism class, stage). Skip a standard that declares `own: ["gates"]` and report it skipped.
2. Between `workspace-standards:gates:begin` and `:end` in `AGENTS.md`, write: the gate registry, the stage bindings, and the capability row for the one domain-neutral gate runner. Each standard's gate set (the testing standard's is `test-gates`) runs through that runner and appears in its single report.
3. A standard never adds a runner of its own.
4. For each gate whose mechanism does not exist, file one backlog item instead of writing code, and list the gate as an obligation, not yet a gate.
5. A second run produces no change; a hand edit inside the block is drift.

## Output
The gates block diff and the filed mechanism items.

## Record
The diff summary and the filed items in the change description.

Status: the managed-block writer and the runner are built by later tasks; until then perform step 2 by hand against the same structure and state that in the Record.
