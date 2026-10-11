# Playbook: apply gates

Writes the gate registry and stage bindings, composed from every registered standard's declared gates.

## Steps
1. Read each active standard's `standard.json` `gates` (id, threshold, mechanism class, stage). Skip a standard that declares `own: ["gates"]` and report it skipped.
2. Between `workspace-standards:gates:begin` and `:end` in `AGENTS.md`, write: the gate registry, the stage bindings, and the capability row for the one domain-neutral gate runner. Each standard's gate set (the testing standard's is `test-gates`) runs through that runner and appears in its single report.
3. A standard never adds a runner of its own.
4. For each gate whose mechanism does not exist, file one backlog item instead of writing code, and list the gate as an obligation, not yet a gate.
5. A second run produces no change; a hand edit inside the block is drift.

Command: `node <skill>/scripts/foundations.mjs apply gates [--root <repo>] [--dry-run] [--force] [--no-file]`. A mechanical gate counts as having a mechanism when `gates.table.json` binds it to a command (or the testing binding names it); the filed items are recorded in the `workspace-standards:foundations-filed` block so a second run and `apply testing` never file one twice.

## Output
The gates block diff and the filed mechanism items.

## Record
The diff summary and the filed items in the change description.

Status: built (595965cc T49). The writer is `scripts/foundations.mjs`; the runner is the engine at `engine/cli.mjs` (T62), which every standard's gate set runs through.
